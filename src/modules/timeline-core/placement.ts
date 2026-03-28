import { randomUUID } from 'node:crypto';
import type {
  IKtepClip, IKtepTrack, IKtepScript, IKtepSlice, IKtepAsset,
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
    const linkedSlices = seg.linkedSliceIds
      .map(id => sliceMap.get(id))
      .filter((s): s is IKtepSlice => s != null);

    if (linkedSlices.length === 0) {
      cursor += segDur;
      continue;
    }

    const perSlice = Math.floor(segDur / linkedSlices.length);

    for (const slice of linkedSlices) {
      const asset = assetMap.get(slice.assetId);
      if (!asset) continue;

      const isPhoto = asset.kind === 'photo';
      const clipDur = isPhoto
        ? Math.min(perSlice, cfg.photoDefaultMs)
        : Math.min(perSlice, cfg.maxSliceDurationMs);

      const isBroll = slice.type === 'broll' || slice.type === 'aerial';

      clips.push({
        id: randomUUID(),
        trackId: isBroll ? brollTrack.id : primaryTrack.id,
        assetId: asset.id,
        sliceId: slice.id,
        sourceInMs: slice.sourceInMs,
        sourceOutMs: slice.sourceOutMs != null
          ? Math.min(slice.sourceOutMs, (slice.sourceInMs ?? 0) + clipDur)
          : undefined,
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
