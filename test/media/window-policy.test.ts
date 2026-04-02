import { describe, expect, it } from 'vitest';
import { applyTypeAwareWindowExpansion } from '../../src/modules/media/window-policy.js';

describe('type-aware edit window expansion', () => {
  it('widens broll focus windows into edit-friendly bounds', () => {
    const windows = applyTypeAwareWindowExpansion({
      clipType: 'broll',
      durationMs: 15_000,
      shotBoundaries: [
        { timeMs: 3_000, score: 0.8 },
        { timeMs: 9_000, score: 0.8 },
      ],
      windows: [{
        startMs: 4_800,
        endMs: 5_600,
        reason: 'high-scene-score',
      }],
    });

    expect(windows).toHaveLength(1);
    expect(windows[0]).toMatchObject({
      startMs: 4_800,
      endMs: 5_600,
      editStartMs: 2_800,
      editEndMs: 9_000,
    });
  });

  it('attaches drive speed candidates to widened drive windows', () => {
    const windows = applyTypeAwareWindowExpansion({
      clipType: 'drive',
      durationMs: 12 * 60_000,
      shotBoundaries: [
        { timeMs: 25_000, score: 0.6 },
        { timeMs: 52_000, score: 0.6 },
      ],
      windows: [{
        startMs: 30_000,
        endMs: 34_000,
        reason: 'coarse-sample-window',
      }],
    });

    expect(windows).toHaveLength(1);
    expect(windows[0]?.editStartMs).toBeLessThan(30_000);
    expect(windows[0]?.editEndMs).toBeGreaterThan(34_000);
    expect((windows[0]?.editEndMs ?? 0) - (windows[0]?.editStartMs ?? 0)).toBeGreaterThanOrEqual(18_000);
    expect(windows[0]?.speedCandidate).toMatchObject({
      suggestedSpeeds: [2, 5, 10],
    });
    expect(windows[0]?.speedCandidate?.rationale).toMatch(/drive:coarse-sample-window/u);
  });
});
