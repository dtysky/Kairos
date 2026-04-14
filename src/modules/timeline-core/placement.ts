import { randomUUID } from 'node:crypto';
import type {
  IAssetCoarseReport,
  IKtepClip,
  IKtepTrack,
  IKtepScript,
  IKtepSlice,
  IKtepAsset,
  IMediaChronology,
  IKtepScriptSelection,
  IKtepScriptBeat,
} from '../../protocol/schema.js';
import {
  hasExplicitEditRange,
  resolveSlicePreferredRange,
} from '../media/window-policy.js';
import {
  buildSourceSpeechContext,
  normalizeSourceSpeechSelections,
  shouldPreserveNaturalSound,
  shouldPreferSourceSpeech,
} from './pacing.js';
import type { IResolvedArrangementSignals } from '../script/arrangement-signals.js';

export interface IPlacementConfig {
  maxSliceDurationMs: number;
  defaultTransitionMs: number;
  photoDefaultMs: number;
  chronology?: IMediaChronology[];
  arrangementSignals?: IResolvedArrangementSignals;
}

const CDEFAULTS: IPlacementConfig = {
  maxSliceDurationMs: 15000,
  defaultTransitionMs: 500,
  photoDefaultMs: 1000,
};
const CSILENT_REMAINDER_MIN_TIMELINE_MS = 1000;

/**
 * 根据脚本段落和切片生成 clip 摆放。
 * 返回 clips 和需要的 tracks。
 */
export function placeClips(
  script: IKtepScript[],
  slices: IKtepSlice[],
  assets: IKtepAsset[],
  config: Partial<IPlacementConfig> = {},
  assetReports: IAssetCoarseReport[] = [],
): { tracks: IKtepTrack[]; clips: IKtepClip[] } {
  const cfg = { ...CDEFAULTS, ...config };
  const sliceMap = new Map(slices.map(s => [s.id, s]));
  const assetMap = new Map(assets.map(a => [a.id, a]));
  const chronologyMap = new Map((cfg.chronology ?? []).map(entry => [entry.assetId, entry]));
  const reportMap = new Map(assetReports.map(report => [report.assetId, report]));
  const chronologyGuardEnabled = cfg.arrangementSignals?.enforceChronology === true;

  const primaryTrack: IKtepTrack = {
    id: randomUUID(), kind: 'video', role: 'primary', index: 0,
  };
  let natTrack: IKtepTrack | null = null;

  const clips: IKtepClip[] = [];
  let cursor = 0;
  let previousBeatChronologyKey: string | null = null;

  const preparedSegments = script.map(seg => prepareSegmentPlacement(
    seg,
    sliceMap,
    assetMap,
    chronologyMap,
    chronologyGuardEnabled,
  ));
  const sourceSpeechOwnership = buildSourceSpeechOwnership(preparedSegments);
  const consumedSilentOwnership = new Map<string, Array<{ startMs: number; endMs: number }>>();

  for (const preparedSegment of preparedSegments) {
    if (preparedSegment.beats.length === 0) {
      continue;
    }

    for (const preparedBeat of preparedSegment.beats) {
      const beat = preparedBeat.beat;
      const explicitSpeed = preparedBeat.preferSourceSpeech
        ? undefined
        : resolveRequestedSpeed(beat.actions?.speed ?? preparedSegment.segment.actions?.speed);
      const provisionalSpeed = explicitSpeed
        ?? resolveAutoMontageSpeed(preparedBeat.selections, preparedBeat.preferSourceSpeech);
      const overlapTrimmedSelections = preparedBeat.preferSourceSpeech
        ? preparedBeat.selections
        : trimSelectionsAgainstSourceSpeech(
          preparedBeat.selections,
          sourceSpeechOwnership,
          provisionalSpeed,
        );
      const dedupedSelections = preparedBeat.preferSourceSpeech
        ? overlapTrimmedSelections
        : trimSelectionsAgainstConsumedSilentRanges(
          overlapTrimmedSelections,
          consumedSilentOwnership,
          provisionalSpeed,
        );
      const orderedSelections = chronologyGuardEnabled
        ? sortSelectionsByChronology(dedupedSelections, assetMap, chronologyMap)
        : dedupedSelections;
      const requestedSpeed = explicitSpeed
        ?? resolveAutoMontageSpeed(orderedSelections, preparedBeat.preferSourceSpeech);
      const requestedHoldMs = resolveRequestedHoldMs(
        beat.actions?.holdMs ?? preparedSegment.segment.actions?.holdMs,
      );
      const beatChronologyKey = chronologyGuardEnabled
        ? resolveBeatChronologyKey(orderedSelections, assetMap, chronologyMap)
        : null;

      if (
        chronologyGuardEnabled
        && beatChronologyKey
        && previousBeatChronologyKey
        && beatChronologyKey.localeCompare(previousBeatChronologyKey) < 0
      ) {
        throw new Error(
          `Chronology guard failed for beat ${beat.id}: ${beatChronologyKey} < ${previousBeatChronologyKey}`,
        );
      }
      if (chronologyGuardEnabled && beatChronologyKey) {
        previousBeatChronologyKey = beatChronologyKey;
      }

      if (orderedSelections.length === 0) {
        continue;
      }

      const placement = buildBeatPlacement(
        orderedSelections,
        requestedSpeed,
        requestedHoldMs,
        preparedBeat.preferSourceSpeech,
        assetMap,
        reportMap,
        cfg,
      );

      if (placement.entries.length === 0) {
        continue;
      }

      for (const entry of placement.entries) {
        const timelineInMs = cursor;
        const timelineOutMs = cursor + entry.timelineDurationMs;
        const useProtectionAudio = preparedBeat.keepNaturalSound
          && shouldUseProtectionAudioFallback(entry.asset, entry.report);

        clips.push({
          id: randomUUID(),
          // Jianying does not handle serial clips split across multiple video tracks well.
          // Until we support true overlap-aware placement, keep all serial video clips on one track.
          trackId: primaryTrack.id,
          assetId: entry.asset.id,
          spanId: entry.selection.spanId ?? entry.selection.sliceId,
          sliceId: entry.selection.sliceId,
          sourceInMs: entry.sourceInMs,
          sourceOutMs: entry.sourceOutMs,
          ...(entry.appliedSpeed != null && { speed: entry.appliedSpeed }),
          timelineInMs,
          timelineOutMs,
          ...((useProtectionAudio || shouldMuteClipAudio(entry.asset, preparedBeat.keepNaturalSound)) && { muteAudio: true }),
          linkedScriptSegmentId: preparedSegment.segment.id,
          linkedScriptBeatId: beat.id,
          pharosRefs: entry.selection.pharosRefs,
          transform: entry.isPhoto ? {
            kenBurns: {
              startScale: 1.0, endScale: 1.15,
              startX: 0.5, startY: 0.5,
              endX: 0.5, endY: 0.4,
            },
          } : undefined,
        });

        if (useProtectionAudio) {
          natTrack ??= {
            id: randomUUID(),
            kind: 'audio',
            role: 'nat',
            index: 0,
          };
          clips.push({
            id: randomUUID(),
            trackId: natTrack.id,
            assetId: entry.asset.id,
            spanId: entry.selection.spanId ?? entry.selection.sliceId,
            sliceId: entry.selection.sliceId,
            sourceInMs: entry.sourceInMs,
            sourceOutMs: entry.sourceOutMs,
            timelineInMs,
            timelineOutMs,
            linkedScriptSegmentId: preparedSegment.segment.id,
            linkedScriptBeatId: beat.id,
            pharosRefs: entry.selection.pharosRefs,
          });
        }

        cursor += entry.timelineDurationMs;
      }

      if (!preparedBeat.preferSourceSpeech) {
        appendConsumedSilentOwnership(consumedSilentOwnership, placement.entries);
      }
    }
  }

  return {
    tracks: natTrack ? [primaryTrack, natTrack] : [primaryTrack],
    clips,
  };
}

interface IResolvedSelection extends IKtepScriptSelection {
  sliceType?: IKtepSlice['type'];
  hasExplicitEditRange?: boolean;
  speedCandidate?: IKtepSlice['speedCandidate'];
  preferredSourceInMs?: number;
  preferredSourceOutMs?: number;
}

interface IResolvedBeat extends Omit<IKtepScriptBeat, 'selections'> {
  selections: IResolvedSelection[];
}

interface IPreparedBeatPlacement {
  beat: IResolvedBeat;
  preferSourceSpeech: boolean;
  keepNaturalSound: boolean;
  selections: IResolvedSelection[];
}

interface IPreparedSegmentPlacement {
  segment: IKtepScript;
  beats: IPreparedBeatPlacement[];
}

interface IPlacementEntry {
  selection: IResolvedSelection;
  asset: IKtepAsset;
  report?: IAssetCoarseReport;
  sourceInMs?: number;
  sourceOutMs?: number;
  preferredSourceInMs?: number;
  preferredSourceOutMs?: number;
  sourceDurationMs?: number;
  timelineDurationMs: number;
  appliedSpeed?: number;
  canStretch: boolean;
  isPhoto: boolean;
}

function resolveBeats(
  segment: IKtepScript,
  sliceMap: Map<string, IKtepSlice>,
): IResolvedBeat[] {
  if (segment.beats && segment.beats.length > 0) {
    return segment.beats.map(beat => ({
      ...beat,
      selections: resolveSelections(beat.selections, sliceMap),
    })).filter(beat => beat.selections.length > 0 || beat.text.trim().length > 0);
  }

  const fallbackSelections = resolveSelections(segment.selections ?? [], sliceMap);
  if (fallbackSelections.length === 0) return [];

    return fallbackSelections.map(selection => ({
      id: randomUUID(),
      text: segment.narration ?? '',
      targetDurationMs: segment.targetDurationMs,
      actions: segment.actions,
      selections: [selection],
      linkedSpanIds: typeof (selection.spanId ?? selection.sliceId) === 'string'
        ? [selection.spanId ?? selection.sliceId as string]
        : [],
      linkedSliceIds: typeof selection.sliceId === 'string' ? [selection.sliceId] : [],
      pharosRefs: selection.pharosRefs ?? segment.pharosRefs,
      notes: segment.notes,
    }));
}

function resolveSelections(
  selections: IKtepScriptSelection[],
  sliceMap: Map<string, IKtepSlice>,
): IResolvedSelection[] {
  return selections.map(selection => {
    const spanRef = selection.spanId ?? selection.sliceId;
    const slice = spanRef ? sliceMap.get(spanRef) : undefined;
    const preferredRange = slice ? resolveSlicePreferredRange(slice) : null;
    return {
      ...selection,
      spanId: selection.spanId ?? selection.sliceId ?? slice?.id,
      assetId: selection.assetId ?? slice?.assetId ?? '',
      sourceInMs: selection.sourceInMs ?? preferredRange?.startMs ?? slice?.sourceInMs,
      sourceOutMs: selection.sourceOutMs ?? preferredRange?.endMs ?? slice?.sourceOutMs,
      preferredSourceInMs: preferredRange?.startMs ?? selection.sourceInMs ?? slice?.sourceInMs,
      preferredSourceOutMs: preferredRange?.endMs ?? selection.sourceOutMs ?? slice?.sourceOutMs,
      sliceType: slice?.type,
      hasExplicitEditRange: slice ? hasExplicitEditRange(slice) : false,
      speedCandidate: slice?.speedCandidate,
    };
  }).filter(selection => selection.assetId.length > 0);
}

function shouldMuteClipAudio(asset: IKtepAsset, keepNaturalSound: boolean): boolean {
  if (keepNaturalSound || asset.kind !== 'video') return false;

  const explicitFlag = readMetadataBoolean(asset.metadata, 'hasAudioStream');
  if (explicitFlag != null) return explicitFlag;

  const audioStreamCount = readMetadataNumber(asset.metadata, 'audioStreamCount');
  if (audioStreamCount != null) return audioStreamCount > 0;

  return true;
}

function readMetadataBoolean(metadata: IKtepAsset['metadata'], key: string): boolean | undefined {
  if (!metadata || typeof metadata !== 'object') return undefined;
  const value = metadata[key];
  return typeof value === 'boolean' ? value : undefined;
}

function readMetadataNumber(metadata: IKtepAsset['metadata'], key: string): number | undefined {
  if (!metadata || typeof metadata !== 'object') return undefined;
  const value = metadata[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function resolveSourceDuration(sourceInMs?: number, sourceOutMs?: number): number | undefined {
  if (sourceInMs == null || sourceOutMs == null) return undefined;
  if (sourceOutMs <= sourceInMs) return undefined;
  return sourceOutMs - sourceInMs;
}

function resolveRequestedSpeed(speed?: number): number | undefined {
  if (typeof speed !== 'number' || !Number.isFinite(speed) || speed <= 0) return undefined;
  return speed;
}

function resolveAutoMontageSpeed(
  selections: IResolvedSelection[],
  preferSourceSpeech: boolean,
): number | undefined {
  if (preferSourceSpeech || selections.length === 0) return undefined;
  if (!selections.every(selection =>
    isSpeedEligibleSliceType(selection.sliceType)
    && (selection.speedCandidate?.suggestedSpeeds?.length ?? 0) > 0,
  )) {
    return undefined;
  }
  return 2;
}

function resolveRequestedHoldMs(holdMs?: number): number | undefined {
  if (typeof holdMs !== 'number' || !Number.isFinite(holdMs) || holdMs <= 0) return undefined;
  return Math.round(holdMs);
}

function prepareSegmentPlacement(
  segment: IKtepScript,
  sliceMap: Map<string, IKtepSlice>,
  assetMap: Map<string, IKtepAsset>,
  chronologyMap: Map<string, IMediaChronology>,
  chronologyGuardEnabled: boolean,
): IPreparedSegmentPlacement {
  const beats = chronologyGuardEnabled
    ? applyChronologyAwareBeatOrdering(resolveBeats(segment, sliceMap), assetMap, chronologyMap)
    : resolveBeats(segment, sliceMap);

  return {
    segment,
    beats: beats.map(beat => {
      const initialSelections = beat.selections;
      const speechContext = buildSourceSpeechContext(initialSelections, sliceMap);
      const preferSourceSpeech = shouldPreferSourceSpeech(segment, beat, speechContext);
      const normalizedSelections = preferSourceSpeech
        ? normalizeSourceSpeechSelections(initialSelections, sliceMap)
        : initialSelections;
      const orderedSelections = chronologyGuardEnabled
        ? sortSelectionsByChronology(normalizedSelections, assetMap, chronologyMap)
        : normalizedSelections;

      return {
        beat,
        preferSourceSpeech,
        keepNaturalSound: preferSourceSpeech || shouldPreserveNaturalSound(segment, beat),
        selections: orderedSelections,
      };
    }).filter(beat => beat.selections.length > 0 || beat.beat.text.trim().length > 0),
  };
}

function buildSourceSpeechOwnership(
  segments: IPreparedSegmentPlacement[],
): Map<string, Array<{ startMs: number; endMs: number }>> {
  const ownership = new Map<string, Array<{ startMs: number; endMs: number }>>();

  for (const segment of segments) {
    for (const beat of segment.beats) {
      if (!beat.preferSourceSpeech) continue;
      for (const selection of beat.selections) {
        if (typeof selection.sourceInMs !== 'number' || typeof selection.sourceOutMs !== 'number') {
          continue;
        }
        if (selection.sourceOutMs <= selection.sourceInMs) continue;
        const current = ownership.get(selection.assetId) ?? [];
        current.push({
          startMs: selection.sourceInMs,
          endMs: selection.sourceOutMs,
        });
        ownership.set(selection.assetId, current);
      }
    }
  }

  for (const [assetId, ranges] of ownership.entries()) {
    ownership.set(assetId, mergeSourceRanges(ranges));
  }

  return ownership;
}

function trimSelectionsAgainstSourceSpeech(
  selections: IResolvedSelection[],
  ownership: Map<string, Array<{ startMs: number; endMs: number }>>,
  requestedSpeed: number | undefined,
): IResolvedSelection[] {
  return selections.flatMap(selection => {
    if (!isSpeedEligibleSliceType(selection.sliceType)) {
      return [selection];
    }
    if (typeof selection.sourceInMs !== 'number' || typeof selection.sourceOutMs !== 'number') {
      return [selection];
    }
    if (selection.sourceOutMs <= selection.sourceInMs) {
      return [];
    }

    const ownedRanges = ownership.get(selection.assetId) ?? [];
    if (ownedRanges.length === 0) {
      return [selection];
    }

    const remainders = subtractSourceRanges(
      {
        startMs: selection.sourceInMs,
        endMs: selection.sourceOutMs,
      },
      ownedRanges,
    );

    return remainders
      .filter(range =>
        resolveTimelineDurationFromSource(range.endMs - range.startMs, requestedSpeed)
        >= CSILENT_REMAINDER_MIN_TIMELINE_MS,
      )
      .map(range => ({
        ...selection,
        sourceInMs: range.startMs,
        sourceOutMs: range.endMs,
      }));
  });
}

function trimSelectionsAgainstConsumedSilentRanges(
  selections: IResolvedSelection[],
  ownership: Map<string, Array<{ startMs: number; endMs: number }>>,
  requestedSpeed: number | undefined,
): IResolvedSelection[] {
  return selections.flatMap(selection => {
    if (!isSpeedEligibleSliceType(selection.sliceType)) {
      return [selection];
    }
    if (typeof selection.sourceInMs !== 'number' || typeof selection.sourceOutMs !== 'number') {
      return [selection];
    }
    if (selection.sourceOutMs <= selection.sourceInMs) {
      return [];
    }

    const consumedRanges = ownership.get(selection.assetId) ?? [];
    if (consumedRanges.length === 0) {
      return [selection];
    }

    const remainders = subtractSourceRanges(
      {
        startMs: selection.sourceInMs,
        endMs: selection.sourceOutMs,
      },
      consumedRanges,
    );

    return remainders
      .filter(range =>
        resolveTimelineDurationFromSource(range.endMs - range.startMs, requestedSpeed)
        >= CSILENT_REMAINDER_MIN_TIMELINE_MS,
      )
      .map(range => ({
        ...selection,
        sourceInMs: range.startMs,
        sourceOutMs: range.endMs,
      }));
  });
}

function appendConsumedSilentOwnership(
  ownership: Map<string, Array<{ startMs: number; endMs: number }>>,
  entries: IPlacementEntry[],
): void {
  for (const entry of entries) {
    if (!isSpeedEligibleSliceType(entry.selection.sliceType)) {
      continue;
    }
    if (typeof entry.sourceInMs !== 'number' || typeof entry.sourceOutMs !== 'number') {
      continue;
    }
    if (entry.sourceOutMs <= entry.sourceInMs) {
      continue;
    }

    const current = ownership.get(entry.asset.id) ?? [];
    current.push({
      startMs: entry.sourceInMs,
      endMs: entry.sourceOutMs,
    });
    ownership.set(entry.asset.id, mergeSourceRanges(current));
  }
}

function mergeSourceRanges(
  ranges: Array<{ startMs: number; endMs: number }>,
): Array<{ startMs: number; endMs: number }> {
  if (ranges.length === 0) return [];

  const sorted = [...ranges]
    .filter(range => range.endMs > range.startMs)
    .sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs);
  if (sorted.length === 0) return [];

  const merged: Array<{ startMs: number; endMs: number }> = [sorted[0]!];
  for (let index = 1; index < sorted.length; index += 1) {
    const current = sorted[index]!;
    const previous = merged[merged.length - 1]!;
    if (current.startMs <= previous.endMs) {
      previous.endMs = Math.max(previous.endMs, current.endMs);
      continue;
    }
    merged.push({ ...current });
  }

  return merged;
}

function subtractSourceRanges(
  range: { startMs: number; endMs: number },
  blockers: Array<{ startMs: number; endMs: number }>,
): Array<{ startMs: number; endMs: number }> {
  let remainders = [range];
  for (const blocker of blockers) {
    remainders = remainders.flatMap(current => subtractSingleSourceRange(current, blocker));
    if (remainders.length === 0) break;
  }
  return remainders.filter(current => current.endMs > current.startMs);
}

function subtractSingleSourceRange(
  range: { startMs: number; endMs: number },
  blocker: { startMs: number; endMs: number },
): Array<{ startMs: number; endMs: number }> {
  const overlapStart = Math.max(range.startMs, blocker.startMs);
  const overlapEnd = Math.min(range.endMs, blocker.endMs);
  if (overlapEnd <= overlapStart) {
    return [range];
  }

  const result: Array<{ startMs: number; endMs: number }> = [];
  if (range.startMs < overlapStart) {
    result.push({
      startMs: range.startMs,
      endMs: overlapStart,
    });
  }
  if (overlapEnd < range.endMs) {
    result.push({
      startMs: overlapEnd,
      endMs: range.endMs,
    });
  }
  return result;
}

function buildBeatPlacement(
  selections: IResolvedSelection[],
  requestedSpeed: number | undefined,
  requestedHoldMs: number | undefined,
  preferSourceSpeech: boolean,
  assetMap: Map<string, IKtepAsset>,
  reportMap: Map<string, IAssetCoarseReport>,
  config: IPlacementConfig,
): { entries: IPlacementEntry[]; totalDurationMs: number } {
  const entries = selections
    .map(selection => buildPlacementEntry(
      selection,
      requestedSpeed,
      requestedHoldMs,
      preferSourceSpeech,
      assetMap,
      reportMap,
      config,
    ))
    .filter((entry): entry is IPlacementEntry => entry != null);

  if (entries.length === 0) {
    return { entries: [], totalDurationMs: 0 };
  }

  return {
    entries,
    totalDurationMs: sumPlacementDurations(entries),
  };
}

function buildPlacementEntry(
  selection: IResolvedSelection,
  requestedSpeed: number | undefined,
  requestedHoldMs: number | undefined,
  preferSourceSpeech: boolean,
  assetMap: Map<string, IKtepAsset>,
  reportMap: Map<string, IAssetCoarseReport>,
  config: IPlacementConfig,
): IPlacementEntry | null {
  const asset = assetMap.get(selection.assetId);
  if (!asset) return null;

  const sourceInMs = selection.sourceInMs;
  const sourceOutMs = selection.sourceOutMs;
  const sourceDurationMs = resolveSourceDuration(sourceInMs, sourceOutMs);
  const isPhoto = asset.kind === 'photo';
  const appliedSpeed = requestedSpeed != null && isSpeedEligibleSliceType(selection.sliceType)
    ? requestedSpeed
    : undefined;
  const naturalDurationMs = sourceDurationMs != null
    ? resolveTimelineDurationFromSource(sourceDurationMs, appliedSpeed)
    : isPhoto
      ? requestedHoldMs ?? config.photoDefaultMs
      : requestedHoldMs ?? config.maxSliceDurationMs;

  return {
    selection,
    asset,
    report: reportMap.get(asset.id),
    sourceInMs,
    sourceOutMs,
    preferredSourceInMs: selection.preferredSourceInMs,
    preferredSourceOutMs: selection.preferredSourceOutMs,
    sourceDurationMs,
      timelineDurationMs: naturalDurationMs,
      appliedSpeed,
    canStretch: !preferSourceSpeech && appliedSpeed == null && !isPhoto,
    isPhoto,
  };
}

function applyChronologyAwareBeatOrdering(
  beats: IResolvedBeat[],
  assetMap: Map<string, IKtepAsset>,
  chronologyMap: Map<string, IMediaChronology>,
): IResolvedBeat[] {
  return beats
    .map((beat, index) => {
      const orderedSelections = sortSelectionsByChronology(beat.selections, assetMap, chronologyMap);
      return {
        beat: {
          ...beat,
          selections: orderedSelections,
        },
        index,
        chronologyKey: resolveBeatChronologyKey(orderedSelections, assetMap, chronologyMap),
      };
    })
    .sort((left, right) => {
      if (!left.chronologyKey && !right.chronologyKey) return left.index - right.index;
      if (!left.chronologyKey) return 1;
      if (!right.chronologyKey) return -1;
      return left.chronologyKey.localeCompare(right.chronologyKey) || left.index - right.index;
    })
    .map(item => item.beat);
}

function sortSelectionsByChronology(
  selections: IResolvedSelection[],
  assetMap: Map<string, IKtepAsset>,
  chronologyMap: Map<string, IMediaChronology>,
): IResolvedSelection[] {
  return [...selections].sort((left, right) => {
    const leftKey = resolveSelectionChronologyKey(left, assetMap, chronologyMap);
    const rightKey = resolveSelectionChronologyKey(right, assetMap, chronologyMap);
    if (!leftKey && !rightKey) return 0;
    if (!leftKey) return 1;
    if (!rightKey) return -1;
    return leftKey.localeCompare(rightKey);
  });
}

function resolveBeatChronologyKey(
  selections: IResolvedSelection[],
  assetMap: Map<string, IKtepAsset>,
  chronologyMap: Map<string, IMediaChronology>,
): string | null {
  for (const selection of selections) {
    const key = resolveSelectionChronologyKey(selection, assetMap, chronologyMap);
    if (key) return key;
  }
  return null;
}

function resolveSelectionChronologyKey(
  selection: Pick<IResolvedSelection, 'assetId' | 'sourceInMs'>,
  assetMap: Map<string, IKtepAsset>,
  chronologyMap: Map<string, IMediaChronology>,
): string | null {
  const chronology = chronologyMap.get(selection.assetId);
  const capturedAt = chronology?.sortCapturedAt?.trim()
    || chronology?.capturedAt?.trim()
    || assetMap.get(selection.assetId)?.capturedAt?.trim();
  if (!capturedAt) return null;
  return `${capturedAt}|${String(Math.max(0, Math.round(selection.sourceInMs ?? 0))).padStart(9, '0')}`;
}

function fitEntriesToBudget(entries: IPlacementEntry[], targetTotalMs: number): void {
  const currentDurations = entries.map(entry => entry.timelineDurationMs);
  const targetDurations = allocateScaledDurations(currentDurations, targetTotalMs);

  entries.forEach((entry, index) => {
    trimEntryToTimelineDuration(entry, targetDurations[index] ?? entry.timelineDurationMs);
  });

  absorbResidual(entries, targetTotalMs, false);
}

function expandEntriesTowardBudget(
  entries: IPlacementEntry[],
  targetTotalMs: number,
  preferSourceSpeech: boolean,
): void {
  let remainingMs = targetTotalMs - sumPlacementDurations(entries);
  if (remainingMs <= 0) return;

  const expansionCaps = entries.map(entry => resolveExpansionCapacityMs(entry));
  const expansionPlan = allocateUpToCapacities(remainingMs, expansionCaps);
  entries.forEach((entry, index) => {
    const additionalMs = expansionPlan[index] ?? 0;
    if (additionalMs <= 0) return;
    expandEntryWithinBounds(entry, entry.timelineDurationMs + additionalMs);
  });

  remainingMs = targetTotalMs - sumPlacementDurations(entries);
  if (remainingMs <= 0 || preferSourceSpeech) {
    absorbResidual(entries, targetTotalMs, false);
    return;
  }

  const stretchableIndexes = entries
    .map((entry, index) => (entry.canStretch ? index : -1))
    .filter(index => index >= 0);
  if (stretchableIndexes.length === 0) {
    absorbResidual(entries, targetTotalMs, false);
    return;
  }

  const stretchWeights = stretchableIndexes.map(index => entries[index]!.timelineDurationMs);
  const stretchPlan = allocateScaledDurations(stretchWeights, remainingMs, false);
  stretchableIndexes.forEach((index, order) => {
    entries[index]!.timelineDurationMs += stretchPlan[order] ?? 0;
  });

  absorbResidual(entries, targetTotalMs, true);
}

function resolveExpansionCapacityMs(entry: IPlacementEntry): number {
  if (
    entry.sourceDurationMs == null
    || entry.sourceInMs == null
    || entry.sourceOutMs == null
    || entry.preferredSourceInMs == null
    || entry.preferredSourceOutMs == null
  ) {
    return 0;
  }

  const boundStartMs = Math.min(entry.preferredSourceInMs, entry.sourceInMs);
  const boundEndMs = Math.max(entry.preferredSourceOutMs, entry.sourceOutMs);
  if (boundEndMs <= boundStartMs) return 0;

  const capacitySourceMs = (boundEndMs - boundStartMs) - entry.sourceDurationMs;
  if (capacitySourceMs <= 0) return 0;

  return resolveTimelineDurationFromSource(
    entry.sourceDurationMs + capacitySourceMs,
    entry.appliedSpeed,
  ) - entry.timelineDurationMs;
}

function trimEntryToTimelineDuration(entry: IPlacementEntry, targetDurationMs: number): void {
  const safeTargetDurationMs = Math.max(1, targetDurationMs);
  if (
    entry.sourceDurationMs == null
    || entry.sourceInMs == null
    || entry.sourceOutMs == null
  ) {
    entry.timelineDurationMs = safeTargetDurationMs;
    return;
  }

  const desiredSourceDurationMs = resolveSourceDurationForTimeline(safeTargetDurationMs, entry.appliedSpeed);
  const trimmedSourceDurationMs = Math.max(1, Math.min(entry.sourceDurationMs, desiredSourceDurationMs));
  entry.sourceOutMs = entry.sourceInMs + trimmedSourceDurationMs;
  entry.sourceDurationMs = trimmedSourceDurationMs;
  entry.timelineDurationMs = resolveTimelineDurationFromSource(trimmedSourceDurationMs, entry.appliedSpeed);
}

function expandEntryWithinBounds(entry: IPlacementEntry, targetDurationMs: number): void {
  if (
    entry.sourceDurationMs == null
    || entry.sourceInMs == null
    || entry.sourceOutMs == null
    || entry.preferredSourceInMs == null
    || entry.preferredSourceOutMs == null
  ) {
    return;
  }

  const boundStartMs = Math.min(entry.preferredSourceInMs, entry.sourceInMs);
  const boundEndMs = Math.max(entry.preferredSourceOutMs, entry.sourceOutMs);
  if (boundEndMs <= boundStartMs) return;

  const desiredSourceDurationMs = Math.max(
    entry.sourceDurationMs,
    resolveSourceDurationForTimeline(targetDurationMs, entry.appliedSpeed),
  );
  const expandedRange = expandSourceRangeWithinBounds(
    entry.sourceInMs,
    entry.sourceOutMs,
    desiredSourceDurationMs,
    boundStartMs,
    boundEndMs,
  );

  entry.sourceInMs = expandedRange.startMs;
  entry.sourceOutMs = expandedRange.endMs;
  entry.sourceDurationMs = expandedRange.endMs - expandedRange.startMs;
  entry.timelineDurationMs = resolveTimelineDurationFromSource(entry.sourceDurationMs, entry.appliedSpeed);
}

function expandSourceRangeWithinBounds(
  currentStartMs: number,
  currentEndMs: number,
  desiredDurationMs: number,
  boundStartMs: number,
  boundEndMs: number,
): { startMs: number; endMs: number } {
  const boundedStartMs = Math.max(0, Math.min(boundStartMs, currentStartMs));
  const boundedEndMs = Math.max(currentEndMs, boundEndMs);
  const maxDurationMs = boundedEndMs - boundedStartMs;
  const targetDurationMs = Math.max(
    currentEndMs - currentStartMs,
    Math.min(desiredDurationMs, maxDurationMs),
  );
  const centerMs = (currentStartMs + currentEndMs) / 2;
  let startMs = Math.round(centerMs - targetDurationMs / 2);
  let endMs = startMs + targetDurationMs;

  if (startMs < boundedStartMs) {
    startMs = boundedStartMs;
    endMs = startMs + targetDurationMs;
  }
  if (endMs > boundedEndMs) {
    endMs = boundedEndMs;
    startMs = endMs - targetDurationMs;
  }

  return {
    startMs,
    endMs,
  };
}

function absorbResidual(
  entries: IPlacementEntry[],
  targetTotalMs: number,
  allowStretch: boolean,
): void {
  let currentTotalMs = sumPlacementDurations(entries);
  if (currentTotalMs === targetTotalMs) return;

  const adjustOrder = allowStretch
    ? [...entries.keys()].reverse()
    : [...entries.keys()]
      .filter(index => entries[index]!.sourceDurationMs != null)
      .reverse();
  if (adjustOrder.length === 0) return;

  for (const index of adjustOrder) {
    const entry = entries[index]!;
    if (currentTotalMs === targetTotalMs) break;

    const deltaMs = targetTotalMs - currentTotalMs;
    if (deltaMs > 0) {
      if (allowStretch && entry.canStretch) {
        entry.timelineDurationMs += deltaMs;
      } else {
        expandEntryWithinBounds(entry, entry.timelineDurationMs + deltaMs);
      }
    } else {
      const reductionMs = Math.min(entry.timelineDurationMs - 1, Math.abs(deltaMs));
      if (reductionMs <= 0) continue;
      trimEntryToTimelineDuration(entry, entry.timelineDurationMs - reductionMs);
    }

    currentTotalMs = sumPlacementDurations(entries);
  }
}

function sumPlacementDurations(entries: IPlacementEntry[]): number {
  return entries.reduce((sum, entry) => sum + entry.timelineDurationMs, 0);
}

function allocateScaledDurations(
  weights: number[],
  targetTotalMs: number,
  requireMinimumOne = true,
): number[] {
  if (weights.length === 0) return [];
  if (targetTotalMs <= 0) {
    return Array.from({ length: weights.length }, () => 0);
  }

  const safeWeights = weights.map(weight => Math.max(0, Math.round(weight)));
  const weightSum = safeWeights.reduce((sum, weight) => sum + weight, 0);
  const minimum = requireMinimumOne && targetTotalMs >= weights.length ? 1 : 0;
  const allocations: number[] = Array.from({ length: weights.length }, () => minimum);
  let remainingMs = targetTotalMs - allocations.reduce((sum, value) => sum + value, 0);
  if (remainingMs < 0) remainingMs = 0;

  if (weightSum <= 0) {
    for (let index = 0; index < allocations.length && remainingMs > 0; index += 1) {
      allocations[index] += 1;
      remainingMs -= 1;
    }
    return allocations;
  }

  const shares = safeWeights.map(weight => remainingMs * (weight / weightSum));
  shares.forEach((share, index) => {
    const whole = Math.floor(share);
    allocations[index] += whole;
    remainingMs -= whole;
  });

  const remainders = shares
    .map((share, index) => ({ index, remainder: share - Math.floor(share) }))
    .sort((left, right) => right.remainder - left.remainder || left.index - right.index);

  for (const item of remainders) {
    if (remainingMs <= 0) break;
    allocations[item.index] += 1;
    remainingMs -= 1;
  }

  return allocations;
}

function allocateUpToCapacities(totalMs: number, capacities: number[]): number[] {
  const roundedCaps = capacities.map(capacity => Math.max(0, Math.floor(capacity)));
  const allocations = Array.from({ length: roundedCaps.length }, () => 0);
  let remainingMs = Math.max(0, totalMs);

  while (remainingMs > 0) {
    const expandable = roundedCaps
      .map((capacity, index) => ({ index, remaining: capacity - allocations[index]! }))
      .filter(item => item.remaining > 0);
    if (expandable.length === 0) break;

    const remainingCapacityMs = expandable.reduce((sum, item) => sum + item.remaining, 0);
    let distributedThisRound = 0;

    for (const item of expandable) {
      if (remainingMs <= 0) break;
      const share = Math.max(1, Math.floor((remainingMs * item.remaining) / remainingCapacityMs));
      const applied = Math.min(item.remaining, share, remainingMs);
      allocations[item.index] += applied;
      remainingMs -= applied;
      distributedThisRound += applied;
    }

    if (distributedThisRound === 0) {
      allocations[expandable[0]!.index] += 1;
      remainingMs -= 1;
    }
  }

  return allocations;
}

function isSpeedEligibleSliceType(sliceType?: IKtepSlice['type']): boolean {
  return sliceType === 'drive' || sliceType === 'aerial';
}

function resolveTimelineDurationFromSource(
  sourceDurationMs: number,
  speed?: number,
): number {
  if (speed == null) return sourceDurationMs;
  return Math.max(1, Math.round(sourceDurationMs / speed));
}

function resolveSourceDurationForTimeline(
  timelineDurationMs: number,
  speed?: number,
): number {
  if (speed == null) return Math.max(1, timelineDurationMs);
  return Math.max(1, Math.round(timelineDurationMs * speed));
}

function shouldUseProtectionAudioFallback(
  asset: IKtepAsset,
  report?: IAssetCoarseReport,
): boolean {
  if (asset.kind !== 'video') return false;
  if (!asset.protectionAudio || asset.protectionAudio.alignment === 'mismatch') return false;
  return report?.protectedAudio?.recommendedSource === 'protection';
}
