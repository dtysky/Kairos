import { randomUUID } from 'node:crypto';
import type { IKtepSlice, IKtepAsset } from '../../protocol/schema.js';
import type { IShotBoundary } from './shot-detect.js';

/**
 * Photo → one slice per asset.
 */
export function slicePhoto(asset: IKtepAsset): IKtepSlice {
  return {
    id: randomUUID(),
    assetId: asset.id,
    type: 'photo',
    labels: [],
    evidence: [],
  };
}

/**
 * Video → slices from shot boundaries.
 * Each gap between boundaries becomes a slice.
 */
export function sliceVideo(
  asset: IKtepAsset,
  boundaries: IShotBoundary[],
): IKtepSlice[] {
  const durationMs = asset.durationMs ?? 0;
  if (durationMs <= 0) return [];

  const cuts = [0, ...boundaries.map(b => b.timeMs), durationMs];
  const slices: IKtepSlice[] = [];

  for (let i = 0; i < cuts.length - 1; i++) {
    const inMs = cuts[i];
    const outMs = cuts[i + 1];
    if (outMs <= inMs) continue;

    slices.push({
      id: randomUUID(),
      assetId: asset.id,
      type: 'shot',
      sourceInMs: inMs,
      sourceOutMs: outMs,
      labels: [],
      evidence: [],
    });
  }

  return slices;
}
