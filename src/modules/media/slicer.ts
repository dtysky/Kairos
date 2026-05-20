import type {
  IInterestingWindow,
  IKtepSlice,
  IKtepAsset,
  ESliceType,
} from '../../protocol/schema.js';
import type { IShotBoundary } from './shot-detect.js';
import { createEmptySliceSemantics } from './semantic-slice.js';
import { assignUniqueMaterialSpanIds, buildMaterialSpanId } from './material-ids.js';

/**
 * Photo → one slice per asset.
 */
export function slicePhoto(asset: IKtepAsset): IKtepSlice {
  return {
    id: buildMaterialSpanId({
      assetId: asset.id,
      assetKind: asset.kind,
      type: 'photo',
      sourceInMs: 0,
      sourceOutMs: 0,
    }),
    assetId: asset.id,
    type: 'photo',
    ...createEmptySliceSemantics(),
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
      id: buildMaterialSpanId({
        assetId: asset.id,
        assetKind: asset.kind,
        type: 'shot',
        sourceInMs: inMs,
        sourceOutMs: outMs,
      }),
      assetId: asset.id,
      type: 'shot',
      sourceInMs: inMs,
      sourceOutMs: outMs,
      editSourceInMs: inMs,
      editSourceOutMs: outMs,
      ...createEmptySliceSemantics(),
    });
  }

  return assignUniqueMaterialSpanIds(slices, new Map([[asset.id, { kind: asset.kind }]]));
}

export function sliceInterestingWindows(
  asset: IKtepAsset,
  windows: IInterestingWindow[],
  type: ESliceType = 'unknown',
): IKtepSlice[] {
  const slices = windows
    .filter(window => window.endMs > window.startMs)
    .map(window => {
      const id = buildMaterialSpanId({
        assetId: asset.id,
        assetKind: asset.kind,
        type,
        semanticKind: window.semanticKind,
        sourceInMs: window.startMs,
        sourceOutMs: window.endMs,
      });
      return {
        id,
        assetId: asset.id,
        type,
        semanticKind: window.semanticKind,
        sourceInMs: window.startMs,
        sourceOutMs: window.endMs,
        editSourceInMs: window.editStartMs ?? window.startMs,
        editSourceOutMs: window.editEndMs ?? window.endMs,
        sourceInterestingWindowIds: [window.windowId ?? id],
        sourceWindowReason: window.reason,
        ...createEmptySliceSemantics(),
        ...(window.speedCandidate && {
          speedCandidate: {
            ...window.speedCandidate,
            suggestedSpeeds: [...window.speedCandidate.suggestedSpeeds],
          },
        }),
      };
    });
  return assignUniqueMaterialSpanIds(slices, new Map([[asset.id, { kind: asset.kind }]]));
}
