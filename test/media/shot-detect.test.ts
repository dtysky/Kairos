import { describe, expect, it } from 'vitest';
import { resolveEffectiveSceneDetectFps } from '../../src/modules/media/shot-detect.js';

describe('scene detect fps policy', () => {
  it('keeps explicit runtime overrides above clip-specific defaults', () => {
    expect(resolveEffectiveSceneDetectFps({
      tools: { sceneDetectFps: 3.5 },
      context: { clipType: 'drive', durationMs: 240_000 },
    })).toBe(3.5);
  });

  it('defaults non-drive videos to 2fps', () => {
    expect(resolveEffectiveSceneDetectFps({
      context: { clipType: 'talking-head', durationMs: 240_000 },
    })).toBe(2);
  });

  it('uses duration-aware fps for drive videos', () => {
    expect(resolveEffectiveSceneDetectFps({
      context: { clipType: 'drive', durationMs: 30_000 },
    })).toBe(2);
    expect(resolveEffectiveSceneDetectFps({
      context: { clipType: 'drive', durationMs: 120_000 },
    })).toBe(0.5);
  });
});
