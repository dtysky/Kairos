import { randomUUID } from 'node:crypto';
import type {
  IAssetCoarseReport,
  IKtepClip,
  IKtepTrack,
  IKtepScript,
  IKtepSlice,
  IKtepAsset,
  IKtepScriptSelection,
  IKtepScriptBeat,
} from '../../protocol/schema.js';
import { hasExplicitEditRange, resolveSlicePreferredRange } from '../media/window-policy.js';
import { buildSourceSpeechContext, shouldPreferSourceSpeech } from './pacing.js';

export interface IPlacementConfig {
  maxSliceDurationMs: number;
  defaultTransitionMs: number;
  photoDefaultMs: number;
}

const CDEFAULTS: IPlacementConfig = {
  maxSliceDurationMs: 15000,
  defaultTransitionMs: 500,
  photoDefaultMs: 5000,
};

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
  const reportMap = new Map(assetReports.map(report => [report.assetId, report]));

  const primaryTrack: IKtepTrack = {
    id: randomUUID(), kind: 'video', role: 'primary', index: 0,
  };
  let natTrack: IKtepTrack | null = null;

  const clips: IKtepClip[] = [];
  let cursor = 0;

  for (const seg of script) {
    const segDur = seg.targetDurationMs ?? 10000;
    const beats = resolveBeats(seg, sliceMap);
    if (beats.length === 0) {
      cursor += segDur;
      continue;
    }

    const perBeat = Math.max(1, Math.floor(segDur / beats.length));

    for (const beat of beats) {
      const selections = beat.selections;
      const beatDur = beat.targetDurationMs ?? perBeat;
      const preferSourceSpeech = shouldPreferSourceSpeech(
        seg,
        beat,
        buildSourceSpeechContext(selections, sliceMap),
      );
      const explicitSpeed = preferSourceSpeech
        ? undefined
        : resolveRequestedSpeed(beat.actions?.speed ?? seg.actions?.speed);

      if (selections.length === 0) {
        cursor += beatDur;
        continue;
      }

      const perSelection = Math.max(1, Math.floor(beatDur / selections.length));

      for (const selection of selections) {
        const asset = assetMap.get(selection.assetId);
        if (!asset) continue;
        const report = reportMap.get(asset.id);

        const isPhoto = asset.kind === 'photo';
        const sourceRangeDur = resolveSourceDuration(selection.sourceInMs, selection.sourceOutMs);
        const baseClipDur = sourceRangeDur != null
          ? sourceRangeDur
          : isPhoto
            ? Math.min(perSelection, cfg.photoDefaultMs)
            : Math.min(perSelection, cfg.maxSliceDurationMs);
        const shouldStretchSelections = !preferSourceSpeech
          && explicitSpeed == null
          && !selection.hasExplicitEditRange;
        const explicitSpeedClipDur = explicitSpeed != null && sourceRangeDur != null
          ? Math.max(1, Math.round(sourceRangeDur / explicitSpeed))
          : undefined;
        const clipDur = explicitSpeedClipDur
          ?? (shouldStretchSelections ? Math.max(baseClipDur, perSelection) : baseClipDur);

        const sourceInMs = selection.sourceInMs;
        const sourceOutMs = selection.sourceOutMs != null
          ? selection.sourceOutMs
          : sourceInMs != null && clipDur > 0
          ? sourceInMs + clipDur
          : selection.sourceOutMs;
        const timelineInMs = cursor;
        const timelineOutMs = cursor + clipDur;
        const useProtectionAudio = preferSourceSpeech
          && shouldUseProtectionAudioFallback(asset, report);

        clips.push({
          id: randomUUID(),
          // Jianying does not handle serial clips split across multiple video tracks well.
          // Until we support true overlap-aware placement, keep all serial video clips on one track.
          trackId: primaryTrack.id,
          assetId: asset.id,
          sliceId: selection.sliceId,
          sourceInMs,
          sourceOutMs,
          ...(explicitSpeed != null && { speed: explicitSpeed }),
          timelineInMs,
          timelineOutMs,
          ...((useProtectionAudio || shouldMuteClipAudio(asset, preferSourceSpeech)) && { muteAudio: true }),
          linkedScriptSegmentId: seg.id,
          linkedScriptBeatId: beat.id,
          transform: isPhoto ? {
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
            assetId: asset.id,
            sliceId: selection.sliceId,
            sourceInMs,
            sourceOutMs,
            timelineInMs,
            timelineOutMs,
            linkedScriptSegmentId: seg.id,
            linkedScriptBeatId: beat.id,
          });
        }

        cursor += clipDur;
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
}

interface IResolvedBeat extends Omit<IKtepScriptBeat, 'selections'> {
  selections: IResolvedSelection[];
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
    linkedSliceIds: typeof selection.sliceId === 'string' ? [selection.sliceId] : [],
    notes: segment.notes,
  }));
}

function resolveSelections(
  selections: IKtepScriptSelection[],
  sliceMap: Map<string, IKtepSlice>,
): IResolvedSelection[] {
  return selections.map(selection => {
    const slice = selection.sliceId ? sliceMap.get(selection.sliceId) : undefined;
    const preferredRange = slice ? resolveSlicePreferredRange(slice) : null;
    return {
      ...selection,
      assetId: selection.assetId ?? slice?.assetId ?? '',
      sourceInMs: selection.sourceInMs ?? preferredRange?.startMs ?? slice?.sourceInMs,
      sourceOutMs: selection.sourceOutMs ?? preferredRange?.endMs ?? slice?.sourceOutMs,
      sliceType: slice?.type,
      hasExplicitEditRange: slice ? hasExplicitEditRange(slice) : false,
      speedCandidate: slice?.speedCandidate,
    };
  }).filter(selection => selection.assetId.length > 0);
}

function shouldMuteClipAudio(asset: IKtepAsset, preferSourceSpeech: boolean): boolean {
  if (preferSourceSpeech || asset.kind !== 'video') return false;

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

function shouldUseProtectionAudioFallback(
  asset: IKtepAsset,
  report?: IAssetCoarseReport,
): boolean {
  if (asset.kind !== 'video') return false;
  if (!asset.protectionAudio || asset.protectionAudio.alignment === 'mismatch') return false;
  return report?.protectedAudio?.recommendedSource === 'protection';
}
