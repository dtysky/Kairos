import { randomUUID } from 'node:crypto';
import type {
  IKtepClip, IKtepTrack, IKtepScript, IKtepSlice, IKtepAsset, IKtepScriptSelection, IKtepScriptBeat,
} from '../../protocol/schema.js';

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
): { tracks: IKtepTrack[]; clips: IKtepClip[] } {
  const cfg = { ...CDEFAULTS, ...config };
  const sliceMap = new Map(slices.map(s => [s.id, s]));
  const assetMap = new Map(assets.map(a => [a.id, a]));

  const primaryTrack: IKtepTrack = {
    id: randomUUID(), kind: 'video', role: 'primary', index: 0,
  };

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

      if (selections.length === 0) {
        cursor += beatDur;
        continue;
      }

      const perSelection = Math.max(1, Math.floor(beatDur / selections.length));

      for (const selection of selections) {
        const asset = assetMap.get(selection.assetId);
        if (!asset) continue;

        const isPhoto = asset.kind === 'photo';
        const sourceRangeDur = resolveSourceDuration(selection.sourceInMs, selection.sourceOutMs);
        const clipDur = sourceRangeDur != null
          ? sourceRangeDur
          : isPhoto
            ? Math.min(perSelection, cfg.photoDefaultMs)
            : Math.min(perSelection, cfg.maxSliceDurationMs);

        const sourceInMs = selection.sourceInMs;
        const sourceOutMs = sourceInMs != null && clipDur > 0
          ? sourceInMs + clipDur
          : selection.sourceOutMs;

        clips.push({
          id: randomUUID(),
          // Jianying does not handle serial clips split across multiple video tracks well.
          // Until we support true overlap-aware placement, keep all serial video clips on one track.
          trackId: primaryTrack.id,
          assetId: asset.id,
          sliceId: selection.sliceId,
          sourceInMs,
          sourceOutMs,
          timelineInMs: cursor,
          timelineOutMs: cursor + clipDur,
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

        cursor += clipDur;
      }
    }
  }

  return { tracks: [primaryTrack], clips };
}

interface IResolvedSelection extends IKtepScriptSelection {
  sliceType?: IKtepSlice['type'];
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
    return {
      ...selection,
      assetId: selection.assetId ?? slice?.assetId ?? '',
      sourceInMs: selection.sourceInMs ?? slice?.sourceInMs,
      sourceOutMs: selection.sourceOutMs ?? slice?.sourceOutMs,
      sliceType: slice?.type,
    };
  }).filter(selection => selection.assetId.length > 0);
}

function resolveSourceDuration(sourceInMs?: number, sourceOutMs?: number): number | undefined {
  if (sourceInMs == null || sourceOutMs == null) return undefined;
  if (sourceOutMs <= sourceInMs) return undefined;
  return sourceOutMs - sourceInMs;
}
