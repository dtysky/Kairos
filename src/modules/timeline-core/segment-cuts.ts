import { randomUUID } from 'node:crypto';
import type {
  IKtepBeatUtterance,
  IKtepScript,
  IKtepScriptBeat,
  IKtepScriptSelection,
  IKtepSlice,
  IMediaChronology,
  ISegmentRoughCutBeatPlan,
  ISegmentRoughCutPlan,
  ITimelineRoughCutBase,
} from '../../protocol/schema.js';
import { estimateTranscriptTextUnits } from '../media/refined-transcript.js';
import { resolveSelectionRange, resolveSlicePreferredRange } from '../media/window-policy.js';
import {
  buildSourceSpeechContext,
  estimateCueDurations,
  filterSourceSpeechTranscriptSegments,
  normalizeScriptTiming,
  normalizeSourceSpeechSelections,
  resolveSpeechPacingConfig,
  sanitizeSubtitleCueText,
  shouldPreferSourceSpeech,
  shouldPreserveNaturalSound,
  splitCueChunks,
  type ISpeechPacingConfig,
} from './pacing.js';

export function buildDeterministicRoughCutBase(input: {
  projectId: string;
  script: IKtepScript[];
  slices: IKtepSlice[];
  chronology?: IMediaChronology[];
  subtitleConfig?: Partial<ISpeechPacingConfig>;
}): ITimelineRoughCutBase {
  const sliceMap = new Map(input.slices.map(slice => [slice.id, slice] as const));
  const chronologyMap = new Map(
    (input.chronology ?? []).map((entry, index) => [entry.assetId, { entry, index }] as const),
  );
  const normalizedScript = normalizeScriptTiming(input.script, input.slices, input.subtitleConfig);
  const cfg = resolveSpeechPacingConfig(input.subtitleConfig);

  return {
    id: randomUUID(),
    projectId: input.projectId,
    generatedAt: new Date().toISOString(),
    segments: normalizedScript.map((segment, segmentIndex) => {
      const lockedSpanIds = dedupeStrings([
        ...segment.linkedSpanIds,
        ...segment.beats.flatMap(beat => beat.linkedSpanIds),
      ]);
      const beatPlans = segment.beats.map(beat =>
        buildSegmentRoughCutBeatPlan(segment, beat, sliceMap, cfg),
      );
      const positions = lockedSpanIds
        .map(spanId => {
          const slice = sliceMap.get(spanId);
          if (!slice) return null;
          const chronology = chronologyMap.get(slice.assetId);
          return chronology
            ? {
              position: chronology.index,
              sortKey: chronology.entry.sortCapturedAt ?? chronology.entry.capturedAt ?? '',
            }
            : null;
        })
        .filter((value): value is { position: number; sortKey: string } => value != null);

      const startPosition = positions.reduce((min, value) => Math.min(min, value.position), segmentIndex);
      const endPosition = positions.reduce((max, value) => Math.max(max, value.position), segmentIndex);

      return {
        segmentId: segment.id,
        segmentTitle: segment.title,
        timeBandGuard: {
          startPosition,
          endPosition,
          startSortKey: positions
            .map(value => value.sortKey)
            .filter(Boolean)
            .sort()[0],
          endSortKey: positions
            .map(value => value.sortKey)
            .filter(Boolean)
            .sort()
            .at(-1),
        },
        lockedSpanIds,
        beats: beatPlans,
      };
    }),
  };
}

export function buildTimelineScriptFromSegmentCuts(
  script: IKtepScript[],
  segmentCuts: ISegmentRoughCutPlan[],
): IKtepScript[] {
  const cutsBySegmentId = new Map(segmentCuts.map(segment => [segment.segmentId, segment] as const));

  return script.map(segment => {
    const cut = cutsBySegmentId.get(segment.id);
    if (!cut) return segment;

    const beats = cut.beats.map(beat => buildBeatFromSegmentCut(beat));
    return {
      ...segment,
      narration: mergeNarration(beats) ?? segment.narration,
      linkedSpanIds: cut.lockedSpanIds.length > 0 ? cut.lockedSpanIds : segment.linkedSpanIds,
      linkedSliceIds: dedupeStrings(beats.flatMap(beat => beat.linkedSliceIds)),
      beats,
    };
  });
}

export function findSegmentCutBeat(
  segmentCuts: ISegmentRoughCutPlan[] | undefined,
  segmentId: string,
  beatId: string,
): ISegmentRoughCutBeatPlan | null {
  if (!segmentCuts?.length) return null;
  const segment = segmentCuts.find(item => item.segmentId === segmentId);
  return segment?.beats.find(beat => beat.beatId === beatId) ?? null;
}

export function buildSegmentRoughCutBeatPlan(
  segment: IKtepScript,
  beat: IKtepScriptBeat,
  sliceMap: Map<string, IKtepSlice>,
  config: ISpeechPacingConfig,
): ISegmentRoughCutBeatPlan {
  const speechContext = buildSourceSpeechContext(beat.audioSelections, sliceMap);
  const preferSourceSpeech = shouldPreferSourceSpeech(segment, beat, speechContext);
  const normalizedAudioSelections = preferSourceSpeech
    ? normalizeSourceSpeechSelections(beat.audioSelections, sliceMap)
    : beat.audioSelections;

  return {
    beatId: beat.id,
    text: beat.text,
    utterances: beat.utterances,
    notes: beat.notes,
    muteSource: beat.actions?.muteSource,
    preserveNatSound: beat.actions?.preserveNatSound ?? shouldPreserveNaturalSound(segment, beat),
    speedSuggestion: resolveBeatSpeedSuggestion(beat, sliceMap),
    linkedSpanIds: beat.linkedSpanIds,
    linkedSliceIds: beat.linkedSliceIds,
    audioSelections: normalizedAudioSelections,
    visualSelections: beat.visualSelections,
    candidateWindows: dedupeCandidateWindows([
      ...normalizedAudioSelections,
      ...beat.visualSelections,
    ].map(selection => buildSelectionWindow(selection, sliceMap.get(selection.sliceId ?? selection.spanId ?? '')))),
    sourceSpeechUnits: normalizedAudioSelections
      .map(selection => buildSourceSpeechUnit(selection, sliceMap.get(selection.sliceId ?? selection.spanId ?? '')))
      .filter((value): value is NonNullable<typeof value> => value != null),
    subtitleCueDrafts: buildSubtitleCueDrafts(
      segment,
      beat,
      normalizedAudioSelections,
      sliceMap,
      preferSourceSpeech,
      config,
    ),
  };
}

function buildSelectionWindow(
  selection: IKtepScriptSelection,
  slice?: IKtepSlice,
) {
  const resolvedRange = resolveSelectionRange(selection, slice);
  const preferredRange = slice ? resolveSlicePreferredRange(slice) : null;
  return {
    assetId: selection.assetId,
    spanId: selection.spanId,
    sliceId: selection.sliceId,
    defaultSourceInMs: resolvedRange?.startMs,
    defaultSourceOutMs: resolvedRange?.endMs,
    minSourceInMs: preferredRange?.startMs ?? resolvedRange?.startMs,
    maxSourceOutMs: preferredRange?.endMs ?? resolvedRange?.endMs,
  };
}

function buildSourceSpeechUnit(
  selection: IKtepScriptSelection,
  slice?: IKtepSlice,
) {
  const resolvedRange = resolveSelectionRange(selection, slice);
  if (!resolvedRange || resolvedRange.endMs <= resolvedRange.startMs) {
    return null;
  }

  const transcriptText = filterSourceSpeechTranscriptSegments(
    slice?.transcriptSegments ?? [],
    resolvedRange,
  ).map(segment => sanitizeSubtitleCueText(segment.text)).filter(Boolean).join(' ');

  return {
    assetId: selection.assetId,
    spanId: selection.spanId,
    sliceId: selection.sliceId,
    sourceInMs: resolvedRange.startMs,
    sourceOutMs: resolvedRange.endMs,
    transcriptText: transcriptText || undefined,
  };
}

function buildSubtitleCueDrafts(
  segment: IKtepScript,
  beat: IKtepScriptBeat,
  audioSelections: IKtepScriptSelection[],
  sliceMap: Map<string, IKtepSlice>,
  preferSourceSpeech: boolean,
  config: ISpeechPacingConfig,
) {
  if (preferSourceSpeech) {
    const drafts: Array<{ id: string; text: string; sourceInMs?: number; sourceOutMs?: number }> = [];
    for (const selection of audioSelections) {
      const slice = selection.sliceId ? sliceMap.get(selection.sliceId) : undefined;
      const range = resolveSelectionRange(selection, slice);
      if (!range) continue;
      const transcriptSegments = filterSourceSpeechTranscriptSegments(slice?.transcriptSegments ?? [], range);
      for (const transcriptSegment of transcriptSegments) {
        const overlapStart = Math.max(range.startMs, transcriptSegment.startMs);
        const overlapEnd = Math.min(range.endMs, transcriptSegment.endMs);
        if (overlapEnd <= overlapStart) continue;

        const rawText = sanitizeSubtitleCueText(transcriptSegment.text);
        if (!rawText) continue;
        const chunks = estimateTranscriptTextUnits(rawText) > config.maxCharsPerCue
          ? splitCueChunks(rawText, config.maxCharsPerCue)
          : [rawText];
        const timings = resolveCueDraftTimings(overlapEnd - overlapStart, chunks, config);
        chunks.forEach((chunk, index) => {
          const timing = timings[index];
          if (!timing) return;
          drafts.push({
            id: randomUUID(),
            text: chunk,
            sourceInMs: overlapStart + timing.startOffsetMs,
            sourceOutMs: overlapStart + timing.endOffsetMs,
          });
        });
      }
    }
    return drafts;
  }

  const narrationText = beat.text.trim();
  if (!narrationText) return [];
  return [{
    id: randomUUID(),
    text: narrationText,
  }];
}

function resolveCueDraftTimings(
  totalDurationMs: number,
  cueTexts: string[],
  config: ISpeechPacingConfig,
): Array<{ startOffsetMs: number; endOffsetMs: number }> {
  if (cueTexts.length === 0 || totalDurationMs <= 0) return [];
  if (cueTexts.length === 1) {
    return [{ startOffsetMs: 0, endOffsetMs: totalDurationMs }];
  }

  const weights = estimateCueDurations(cueTexts, config);
  const totalWeight = weights.reduce((sum, value) => sum + value, 0);
  if (totalWeight <= 0) {
    return cueTexts.map((_, index) => {
      const startOffsetMs = Math.round(totalDurationMs * (index / cueTexts.length));
      const endOffsetMs = index === cueTexts.length - 1
        ? totalDurationMs
        : Math.round(totalDurationMs * ((index + 1) / cueTexts.length));
      return {
        startOffsetMs,
        endOffsetMs: Math.max(endOffsetMs, startOffsetMs + 1),
      };
    });
  }

  let cumulativeWeight = 0;
  return cueTexts.map((_, index) => {
    const startOffsetMs = Math.round(totalDurationMs * (cumulativeWeight / totalWeight));
    cumulativeWeight += weights[index] ?? 0;
    const endOffsetMs = index === cueTexts.length - 1
      ? totalDurationMs
      : Math.round(totalDurationMs * (cumulativeWeight / totalWeight));

    return {
      startOffsetMs,
      endOffsetMs: Math.max(endOffsetMs, startOffsetMs + 1),
    };
  });
}

function buildBeatFromSegmentCut(beat: ISegmentRoughCutBeatPlan): IKtepScriptBeat {
  return {
    id: beat.beatId,
    text: beat.text,
    utterances: beat.utterances as IKtepBeatUtterance[] | undefined,
    actions: {
      ...(typeof beat.speedSuggestion === 'number' ? { speed: beat.speedSuggestion } : {}),
      ...(typeof beat.preserveNatSound === 'boolean' ? { preserveNatSound: beat.preserveNatSound } : {}),
      ...(typeof beat.muteSource === 'boolean' ? { muteSource: beat.muteSource } : {}),
    },
    audioSelections: beat.audioSelections,
    visualSelections: beat.visualSelections,
    linkedSpanIds: beat.linkedSpanIds,
    linkedSliceIds: beat.linkedSliceIds,
    pharosRefs: dedupePharosRefs([
      ...beat.audioSelections.flatMap(selection => selection.pharosRefs ?? []),
      ...beat.visualSelections.flatMap(selection => selection.pharosRefs ?? []),
    ]),
    notes: beat.notes,
  };
}

function resolveBeatSpeedSuggestion(
  beat: IKtepScriptBeat,
  sliceMap: Map<string, IKtepSlice>,
): number | undefined {
  if (typeof beat.actions?.speed === 'number' && beat.actions.speed > 0) {
    return beat.actions.speed;
  }
  const silentMontageSelections = beat.visualSelections.length > 0 ? beat.visualSelections : beat.audioSelections;
  for (const selection of silentMontageSelections) {
    const slice = selection.sliceId ? sliceMap.get(selection.sliceId) : undefined;
    const speedCandidate = slice?.speedCandidate;
    if (speedCandidate?.suggestedSpeeds?.includes(2)) {
      return 2;
    }
  }
  return undefined;
}

function dedupeCandidateWindows(
  windows: Array<{
    assetId: string;
    spanId?: string;
    sliceId?: string;
    defaultSourceInMs?: number;
    defaultSourceOutMs?: number;
    minSourceInMs?: number;
    maxSourceOutMs?: number;
  }>,
) {
  const seen = new Set<string>();
  return windows.filter(window => {
    const key = [
      window.assetId,
      window.spanId ?? '',
      window.sliceId ?? '',
      window.defaultSourceInMs ?? '',
      window.defaultSourceOutMs ?? '',
      window.minSourceInMs ?? '',
      window.maxSourceOutMs ?? '',
    ].join('|');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dedupeStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === 'string' && value.trim().length > 0))];
}

function dedupePharosRefs(
  refs: Array<{ tripId: string; shotId: string }>,
): Array<{ tripId: string; shotId: string }> {
  const seen = new Set<string>();
  const result: Array<{ tripId: string; shotId: string }> = [];
  for (const ref of refs) {
    const key = `${ref.tripId}:${ref.shotId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(ref);
  }
  return result;
}

function mergeNarration(beats: IKtepScriptBeat[]): string | undefined {
  const text = beats.map(beat => beat.text.trim()).filter(Boolean).join(' ');
  return text || undefined;
}
