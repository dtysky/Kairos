import { afterEach, describe, expect, it, vi } from 'vitest';

const {
  analyzeAudioHealthMock,
  resolveProtectionAudioLocalPathMock,
} = vi.hoisted(() => ({
  analyzeAudioHealthMock: vi.fn(),
  resolveProtectionAudioLocalPathMock: vi.fn(),
}));

vi.mock('../../src/modules/media/audio-health.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/modules/media/audio-health.js')>(
    '../../src/modules/media/audio-health.js',
  );
  return {
    ...actual,
    analyzeAudioHealth: analyzeAudioHealthMock,
  };
});

vi.mock('../../src/modules/media/protection-audio.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/modules/media/protection-audio.js')>(
    '../../src/modules/media/protection-audio.js',
  );
  return {
    ...actual,
    resolveProtectionAudioLocalPath: resolveProtectionAudioLocalPathMock,
  };
});

import { evaluateProtectedAudioFallback } from '../../src/modules/media/project-analyze.js';

afterEach(() => {
  vi.clearAllMocks();
});

describe('evaluateProtectedAudioFallback', () => {
  it('routes to protection when its health score is clearly better', async () => {
    analyzeAudioHealthMock
      .mockResolvedValueOnce({
        meanVolumeDb: -38,
        silenceRatio: 0.7,
      })
      .mockResolvedValueOnce({
        meanVolumeDb: -18,
        silenceRatio: 0.12,
      });
    resolveProtectionAudioLocalPathMock.mockReturnValue('F:/project/audio/clip.wav');

    const result = await evaluateProtectedAudioFallback({
      projectId: 'project-1',
      asset: {
        id: 'asset-1',
        kind: 'video',
        sourcePath: 'clip.mp4',
        displayName: 'clip.mp4',
        durationMs: 10_000,
        protectionAudio: {
          sourcePath: 'clip.wav',
          displayName: 'clip.wav',
          alignment: 'exact',
        },
      },
      localVideoPath: 'F:/project/video/clip.mp4',
      roots: [],
      deviceMaps: { projects: {} },
      hasAudioTrack: true,
      runtimeConfig: {},
      protectionAudioLocalPath: 'F:/project/audio/clip.wav',
    });

    expect(analyzeAudioHealthMock).toHaveBeenCalledTimes(2);
    expect(analyzeAudioHealthMock).toHaveBeenCalledWith(
      'F:/project/video/clip.mp4',
      10_000,
      {},
    );
    expect(analyzeAudioHealthMock).toHaveBeenCalledWith(
      'F:/project/audio/clip.wav',
      10_000,
      {},
    );
    expect(result?.selectedTranscriptSource).toBe('protection');
    expect(result?.embeddedHealth?.issues).toContain('low-level');
    expect(result?.protectionHealth?.score).toBeGreaterThan((result?.embeddedHealth?.score ?? 0));
  });

  it('keeps embedded when protection alignment mismatches even if protection sounds cleaner', async () => {
    analyzeAudioHealthMock
      .mockResolvedValueOnce({
        meanVolumeDb: -34,
        silenceRatio: 0.55,
      })
      .mockResolvedValueOnce({
        meanVolumeDb: -16,
        silenceRatio: 0.08,
      });
    resolveProtectionAudioLocalPathMock.mockReturnValue('F:/project/audio/clip.wav');

    const result = await evaluateProtectedAudioFallback({
      projectId: 'project-1',
      asset: {
        id: 'asset-1',
        kind: 'video',
        sourcePath: 'clip.mp4',
        displayName: 'clip.mp4',
        durationMs: 10_000,
        protectionAudio: {
          sourcePath: 'clip.wav',
          displayName: 'clip.wav',
          alignment: 'mismatch',
        },
      },
      localVideoPath: 'F:/project/video/clip.mp4',
      roots: [],
      deviceMaps: { projects: {} },
      hasAudioTrack: true,
      runtimeConfig: {},
      protectionAudioLocalPath: 'F:/project/audio/clip.wav',
    });

    expect(result?.selectedTranscriptSource).toBe('embedded');
  });
});
