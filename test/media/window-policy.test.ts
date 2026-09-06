import { describe, expect, it } from 'vitest';
import {
  applyTypeAwareWindowExpansion,
  trimSpeechOverlappingVisualWindows,
} from '../../src/modules/media/window-policy.js';

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
        semanticKind: 'visual',
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

  it('pads aligned speech by 250ms without shot-boundary snapping or minimum-duration expansion', () => {
    const windows = applyTypeAwareWindowExpansion({
      clipType: 'drive',
      durationMs: 12_032,
      shotBoundaries: [
        { timeMs: 0, score: 1 },
        { timeMs: 5_000, score: 0.9 },
      ],
      windows: [{
        startMs: 1_760,
        endMs: 4_480,
        semanticKind: 'speech',
        reason: 'speech-window',
      }],
    });

    expect(windows).toEqual([expect.objectContaining({
      startMs: 1_760,
      endMs: 4_480,
      editStartMs: 1_510,
      editEndMs: 4_730,
    })]);
  });


  it('keeps overlapping drive speech and visual windows separate', () => {
    const windows = applyTypeAwareWindowExpansion({
      clipType: 'drive',
      durationMs: 180_000,
      shotBoundaries: [
        { timeMs: 60_000, score: 0.9 },
      ],
      windows: [
        {
          startMs: 59_500,
          endMs: 61_000,
          semanticKind: 'visual',
          reason: 'high-scene-score',
        },
        {
          startMs: 60_200,
          endMs: 60_900,
          semanticKind: 'speech',
          reason: 'speech-window',
        },
      ],
    });

    expect(windows).toHaveLength(2);
    const speechWindow = windows.find(window => window.semanticKind === 'speech');
    const visualWindow = windows.find(window => window.semanticKind === 'visual');

    expect(speechWindow).toBeDefined();
    expect(speechWindow?.speedCandidate).toBeUndefined();
    expect(visualWindow?.speedCandidate).toBeDefined();
    expect((speechWindow?.editEndMs ?? 0) - (speechWindow?.editStartMs ?? 0)).toBeLessThan(
      (visualWindow?.editEndMs ?? 0) - (visualWindow?.editStartMs ?? 0),
    );
  });

});

describe('speech-overlapping visual window trimming', () => {
  it('drops a visual window when IoU reaches 50% and every remainder is shorter than 15 seconds', () => {
    const windows = trimSpeechOverlappingVisualWindows({
      clipType: 'drive',
      assetDurationMs: 12_032,
      windows: [
        {
          startMs: 1_260,
          endMs: 5_380,
          editStartMs: 0,
          editEndMs: 6_130,
          semanticKind: 'speech',
          reason: 'speech-window',
        },
        {
          startMs: 3_016,
          endMs: 9_016,
          editStartMs: 0,
          editEndMs: 12_032,
          semanticKind: 'visual',
          reason: 'coarse-sample-window',
        },
      ],
    });

    expect(windows).toHaveLength(1);
    expect(windows[0]?.semanticKind).toBe('speech');
  });

  it('keeps a visual window unchanged when its IoU with speech is below 50%', () => {
    const visualWindow = {
      windowId: 'visual-long',
      startMs: 0,
      endMs: 90_000,
      editStartMs: 0,
      editEndMs: 90_000,
      semanticKind: 'visual' as const,
      reason: 'coarse-sample-window',
    };
    const windows = trimSpeechOverlappingVisualWindows({
      clipType: 'drive',
      assetDurationMs: 90_000,
      windows: [
        {
          startMs: 20_000,
          endMs: 21_000,
          editStartMs: 20_000,
          editEndMs: 21_000,
          semanticKind: 'speech',
          reason: 'speech-window',
        },
        visualWindow,
      ],
    });

    expect(windows).toHaveLength(2);
    expect(windows.find(window => window.semanticKind === 'visual')).toEqual(visualWindow);
  });

  it('emits only continuous remainders of at least 15 seconds after a qualifying overlap', () => {
    const windows = trimSpeechOverlappingVisualWindows({
      clipType: 'drive',
      assetDurationMs: 70_000,
      windows: [
        {
          startMs: 14_999,
          endMs: 50_000,
          editStartMs: 14_999,
          editEndMs: 50_000,
          semanticKind: 'speech',
          reason: 'speech-window',
        },
        {
          windowId: 'visual-original',
          startMs: 0,
          endMs: 70_000,
          editStartMs: 0,
          editEndMs: 70_000,
          semanticKind: 'visual',
          reason: 'coarse-sample-window',
        },
      ],
    });

    const visualWindows = windows.filter(window => window.semanticKind === 'visual');
    expect(visualWindows).toHaveLength(1);
    expect(visualWindows[0]).toMatchObject({
      windowId: undefined,
      startMs: 50_000,
      endMs: 70_000,
      editStartMs: 50_000,
      editEndMs: 70_000,
      reason: 'coarse-sample-window+speech-overlap-trimmed',
    });
    expect(visualWindows[0]?.speedCandidate?.rationale).toContain('speech-overlap-trimmed');
  });

  it('keeps a remainder exactly 15 seconds long', () => {
    const windows = trimSpeechOverlappingVisualWindows({
      clipType: 'drive',
      assetDurationMs: 70_000,
      windows: [
        {
          startMs: 15_000,
          endMs: 55_000,
          semanticKind: 'speech',
          reason: 'speech-window',
        },
        {
          startMs: 0,
          endMs: 70_000,
          semanticKind: 'visual',
          reason: 'coarse-sample-window',
        },
      ],
    });

    expect(windows.filter(window => window.semanticKind === 'visual')).toEqual([
      expect.objectContaining({ startMs: 0, endMs: 15_000 }),
      expect.objectContaining({ startMs: 55_000, endMs: 70_000 }),
    ]);
  });
});
