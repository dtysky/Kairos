import { afterEach, describe, expect, it, vi } from 'vitest';

const {
  analyzeAudioHealthMock,
  resolveProtectionAudioLocalPathMock,
  transcribeMock,
} = vi.hoisted(() => ({
  analyzeAudioHealthMock: vi.fn(),
  resolveProtectionAudioLocalPathMock: vi.fn(),
  transcribeMock: vi.fn(),
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

vi.mock('../../src/modules/media/transcriber.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/modules/media/transcriber.js')>(
    '../../src/modules/media/transcriber.js',
  );
  return {
    ...actual,
    transcribe: transcribeMock,
  };
});

import { evaluateProtectedAudioFallback } from '../../src/modules/media/project-analyze.js';

afterEach(() => {
  vi.clearAllMocks();
});

describe('evaluateProtectedAudioFallback', () => {
  it('does not run a second health check for protection audio', async () => {
    analyzeAudioHealthMock.mockResolvedValue({
      meanVolumeDb: -38,
      silenceRatio: 0.7,
    });
    resolveProtectionAudioLocalPathMock.mockReturnValue('F:/project/audio/clip.wav');
    transcribeMock.mockResolvedValue({
      segments: [
        { start: 0, end: 2.2, text: 'clear backup narration' },
      ],
      fullText: 'clear backup narration',
      evidence: [],
    });

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
      runtimeConfig: {},
      embeddedTranscript: {
        transcript: '',
        segments: [],
        evidence: [],
        speechCoverage: 0.01,
        speechWindows: [],
      },
      ml: {
        available: true,
        client: {},
      } as never,
    });

    expect(analyzeAudioHealthMock).toHaveBeenCalledTimes(1);
    expect(analyzeAudioHealthMock).toHaveBeenCalledWith(
      'F:/project/video/clip.mp4',
      10_000,
      {},
    );
    expect(transcribeMock).toHaveBeenCalledTimes(1);
    expect(transcribeMock).toHaveBeenCalledWith(
      {},
      'F:/project/audio/clip.wav',
    );
    expect(result?.recommendedSource).toBe('protection');
    expect(result?.protection?.notes).toContain('保护音轨默认不做独立健康检查，仅在必要时做语音对比。');
  });
});
