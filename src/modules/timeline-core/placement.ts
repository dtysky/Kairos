import { randomUUID } from 'node:crypto';
import type {
  IKtepClip, IKtepTrack, IKtepScript, IKtepSlice, IKtepAsset, IKtepScriptSelection,
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
  const brollTrack: IKtepTrack = {
    id: randomUUID(), kind: 'video', role: 'broll', index: 1,
  };

  const clips: IKtepClip[] = [];
  let cursor = 0;

  for (const seg of script) {
    const segDur = seg.targetDurationMs ?? 10000;
    const selections = resolveSelections(seg, sliceMap);

    if (selections.length === 0) {
      cursor += segDur;
      continue;
    }

    const perSelection = Math.floor(segDur / selections.length);

    for (const selection of selections) {
      const asset = assetMap.get(selection.assetId);
      if (!asset) continue;

      const isPhoto = asset.kind === 'photo';
      const clipDur = isPhoto
        ? Math.min(perSelection, cfg.photoDefaultMs)
        : Math.min(perSelection, cfg.maxSliceDurationMs);

      const isBroll = selection.sliceType === 'broll' || selection.sliceType === 'aerial';
      const sourceInMs = selection.sourceInMs;
      const sourceOutMs = selection.sourceOutMs != null
        ? Math.min(selection.sourceOutMs, (selection.sourceInMs ?? 0) + clipDur)
        : undefined;

      clips.push({
        id: randomUUID(),
        trackId: isBroll ? brollTrack.id : primaryTrack.id,
        assetId: asset.id,
        sliceId: selection.sliceId,
        sourceInMs,
        sourceOutMs,
        timelineInMs: cursor,
        timelineOutMs: cursor + clipDur,
        linkedScriptSegmentId: seg.id,
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

  const tracks = [primaryTrack];
  if (clips.some(c => c.trackId === brollTrack.id)) {
    tracks.push(brollTrack);
  }

  return { tracks, clips };
}

interface IResolvedSelection extends IKtepScriptSelection {
  sliceType?: IKtepSlice['type'];
}

function resolveSelections(
  segment: IKtepScript,
  sliceMap: Map<string, IKtepSlice>,
): IResolvedSelection[] {
  if (segment.selections && segment.selections.length > 0) {
    return segment.selections.map(selection => {
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

  return segment.linkedSliceIds
    .map(id => sliceMap.get(id))
    .filter((slice): slice is IKtepSlice => slice != null)
    .map(slice => ({
      assetId: slice.assetId,
      sliceId: slice.id,
      sourceInMs: slice.sourceInMs,
      sourceOutMs: slice.sourceOutMs,
      sliceType: slice.type,
    }));
}
