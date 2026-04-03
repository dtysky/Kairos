import { describe, expect, it } from 'vitest';
import {
  recommendProtectedAudioFallback,
  summarizeAudioHealth,
} from '../../src/modules/media/audio-health.js';

describe('protected audio health recommendation', () => {
  it('recommends protection when embedded wireless audio looks weak', () => {
    const embedded = summarizeAudioHealth({
      telemetry: {
        meanVolumeDb: -35,
        maxVolumeDb: -5,
        silenceRatio: 0.62,
      },
      speechCoverage: 0.02,
      transcript: '',
    });
    const protection = summarizeAudioHealth({
      telemetry: {
        meanVolumeDb: -20,
        maxVolumeDb: -3,
        silenceRatio: 0.08,
      },
      speechCoverage: 0.42,
      transcript: '这是更稳定的保护音轨转写内容',
    });

    const assessment = recommendProtectedAudioFallback({
      binding: {
        sourcePath: 'A001.wav',
        alignment: 'exact',
      },
      embedded,
      protection,
      comparedProtectionTranscript: true,
    });

    expect(assessment?.recommendedSource).toBe('protection');
    expect(assessment?.reason).toMatch(/保护音轨/u);
  });

  it('keeps embedded audio when the main wireless track is still healthy', () => {
    const embedded = summarizeAudioHealth({
      telemetry: {
        meanVolumeDb: -19,
        maxVolumeDb: -2,
        silenceRatio: 0.12,
      },
      speechCoverage: 0.35,
      transcript: '主音轨足够清晰',
    });
    const protection = summarizeAudioHealth({
      telemetry: {
        meanVolumeDb: -22,
        maxVolumeDb: -3,
        silenceRatio: 0.2,
      },
      speechCoverage: 0.28,
      transcript: '保护音轨可用，但并没有明显更好',
    });

    const assessment = recommendProtectedAudioFallback({
      binding: {
        sourcePath: 'A001.wav',
        alignment: 'exact',
      },
      embedded,
      protection,
      comparedProtectionTranscript: true,
    });

    expect(assessment?.recommendedSource).toBe('embedded');
  });
});
