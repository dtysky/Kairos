import { describe, expect, it } from 'vitest';
import type { IKtepSlice } from '../../src/protocol/schema.js';
import { buildOutline } from '../../src/modules/script/outline-builder.js';

describe('buildOutline edit-window policy', () => {
  it('prefers analyze-provided edit bounds over center trimming', () => {
    const slices: IKtepSlice[] = [{
      id: 'slice-drive',
      assetId: 'asset-drive',
      type: 'drive',
      sourceInMs: 2_000,
      sourceOutMs: 3_000,
      editSourceInMs: 0,
      editSourceOutMs: 9_000,
      labels: ['drive'],
      placeHints: [],
    }];

    const outline = buildOutline(slices, 8_000);

    expect(outline).toHaveLength(1);
    expect(outline[0]?.beats[0]?.selection).toMatchObject({
      sourceInMs: 0,
      sourceOutMs: 9_000,
    });
    expect(outline[0]?.beats[0]?.sourceInMs).toBe(0);
    expect(outline[0]?.beats[0]?.sourceOutMs).toBe(9_000);
  });

  it('keeps legacy center trimming for slices without edit bounds', () => {
    const slices: IKtepSlice[] = [{
      id: 'slice-legacy',
      assetId: 'asset-legacy',
      type: 'broll',
      sourceInMs: 0,
      sourceOutMs: 12_000,
      labels: [],
      placeHints: [],
    }];

    const outline = buildOutline(slices, 4_000);

    expect(outline).toHaveLength(1);
    expect(outline[0]?.beats[0]?.selection).toMatchObject({
      sourceInMs: 4_000,
      sourceOutMs: 8_000,
    });
  });
});
