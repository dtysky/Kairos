import { describe, expect, it } from 'vitest';
import {
  assertUniqueRootCodes,
  buildEncodedSourcePath,
  buildMaterialAssetId,
  buildMaterialSpanId,
  assignUniqueMaterialAssetIds,
  assignUniqueMaterialSpanIds,
} from '../../src/modules/media/material-ids.js';

describe('human source material ids', () => {
  it('validates rootCode presence, safety, and uniqueness', () => {
    expect(() => assertUniqueRootCodes([
      { id: 'root-a', rootCode: 'zve1' },
      { id: 'root-b', rootCode: 'drone' },
    ])).not.toThrow();

    expect(() => assertUniqueRootCodes([
      { id: 'root-a', rootCode: 'zve1' },
      { id: 'root-b', rootCode: 'zve1' },
    ])).toThrow('duplicated');

    expect(() => assertUniqueRootCodes([
      { id: 'root-a', rootCode: 'zve/1' },
    ])).toThrow('invalid');
  });

  it('builds stable source-locator asset ids', () => {
    expect(buildEncodedSourcePath('day8/C1439.mp4')).toBe('C1439_day8');
    expect(buildEncodedSourcePath('day8\\bad:name?.mp4')).toBe('bad_name_day8');
    expect(buildMaterialAssetId({
      rootCode: 'zve1',
      sourcePath: 'day8/C1439.mp4',
    })).toBe('C1439_zve1_day8');
  });

  it('adds stable asset fallback suffixes for path collisions', () => {
    const assigned = assignUniqueMaterialAssetIds([
      { id: 'old-a', sourcePath: 'day1/C0506.mp4' },
      { id: 'old-b', sourcePath: 'day1/C0506.mov' },
    ], () => 'zve1');

    expect(assigned.map(asset => asset.id)).toEqual([
      'C0506_zve1_day1',
      'C0506_mov_zve1_day1',
    ]);
  });

  it('builds deterministic span ids from integer-second source ranges', () => {
    expect(buildMaterialSpanId({
      assetId: 'C1439_zve1_day8',
      type: 'drive',
      semanticKind: 'speech',
      sourceInMs: 1200,
      sourceOutMs: 10_001,
    })).toBe('C1439_zve1_day8_drive_speech_s1-11');

    expect(buildMaterialSpanId({
      assetId: 'C0374_zve1_day0',
      type: 'broll',
      sourceInMs: 0,
      sourceOutMs: 10_000,
    })).toBe('C0374_zve1_day0_broll_s0-10');

    expect(buildMaterialSpanId({
      assetId: 'IMG_0001_photos_day4',
      assetKind: 'photo',
      type: 'photo',
    })).toBe('IMG_0001_photos_day4_photo');
  });

  it('adds stable fallback suffixes for integer-second collisions', () => {
    const assigned = assignUniqueMaterialSpanIds([
      {
        id: 'old-a',
        assetId: 'C1439_zve1_day8',
        type: 'drive' as const,
        semanticKind: 'visual' as const,
        sourceInMs: 100,
        sourceOutMs: 900,
      },
      {
        id: 'old-b',
        assetId: 'C1439_zve1_day8',
        type: 'drive' as const,
        semanticKind: 'visual' as const,
        sourceInMs: 120,
        sourceOutMs: 880,
      },
    ]);

    expect(assigned.map(span => span.id)).toEqual([
      'C1439_zve1_day8_drive_visual_s0-1',
      'C1439_zve1_day8_drive_visual_s0-1_ms120-880',
    ]);
  });
});
