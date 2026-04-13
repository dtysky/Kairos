import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getAnalyzePerformanceProfilePath } from '../../src/modules/media/analyze-profile.js';
import { MlClient } from '../../src/modules/media/ml-client.js';
import {
  getAssetReportPath,
  getSlicesPath,
  initWorkspaceProject,
  writeFineScanCheckpoint,
  writePreparedAssetCheckpoint,
  writeJson,
} from '../../src/store/index.js';

const workspaces: string[] = [];

const detectShotsMock = vi.fn();
const extractKeyframesMock = vi.fn();

vi.mock('../../src/modules/media/shot-detect.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/modules/media/shot-detect.js')>(
    '../../src/modules/media/shot-detect.js',
  );
  return {
    ...actual,
    detectShots: detectShotsMock,
  };
});

vi.mock('../../src/modules/media/keyframe.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/modules/media/keyframe.js')>(
    '../../src/modules/media/keyframe.js',
  );
  return {
    ...actual,
    extractKeyframes: extractKeyframesMock,
  };
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    workspaces.splice(0).map(path => rm(path, { recursive: true, force: true })),
  );
});

beforeEach(() => {
  detectShotsMock.mockReset();
  extractKeyframesMock.mockReset();
});

async function createWorkspace(): Promise<string> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'kairos-analyze-profile-test-'));
  workspaces.push(workspaceRoot);
  return workspaceRoot;
}

describe('analyzeWorkspaceProjectMedia profiling', () => {
  it('materializes direct-path visual assets into spans without entering fine-scan', async () => {
    const workspaceRoot = await createWorkspace();
    const projectId = 'project-analyze-direct-materialization';
    const projectRoot = await initWorkspaceProject(workspaceRoot, projectId, 'Direct Materialization Project');
    const mediaRoot = join(projectRoot, '.tmp', 'fixtures');
    const mediaPath = join(mediaRoot, 'atomic-broll.mp4');

    await mkdir(mediaRoot, { recursive: true });
    await writeFile(mediaPath, 'fake-media');

    await writeJson(join(projectRoot, 'config/runtime.json'), {
      mlServerUrl: 'http://127.0.0.1:8910',
    });
    await writeJson(join(projectRoot, 'config/ingest-roots.json'), {
      roots: [{
        id: 'root-1',
        enabled: true,
        label: 'camera-a',
        path: mediaRoot,
      }],
    });
    await writeJson(join(projectRoot, 'store/assets.json'), [{
      id: 'asset-direct',
      kind: 'video',
      sourcePath: 'atomic-broll.mp4',
      displayName: 'atomic-broll.mp4',
      ingestRootId: 'root-1',
      durationMs: 9_000,
      capturedAt: '2026-03-31T08:15:30.000Z',
      metadata: {
        hasAudioStream: false,
      },
    }]);

    extractKeyframesMock.mockImplementation(async (
      _filePath: string,
      outputDir: string,
      timestampsMs: number[],
    ) => {
      await mkdir(outputDir, { recursive: true });
      return Promise.all(timestampsMs.map(async timeMs => {
        const framePath = join(outputDir, `frame-${timeMs}.jpg`);
        await writeFile(framePath, `frame-${timeMs}`);
        return { timeMs, path: framePath };
      }));
    });

    vi.spyOn(MlClient.prototype, 'health').mockResolvedValue({
      status: 'ok',
      device: 'apple',
      backend: 'mlx',
      models_loaded: [],
    });
    vi.spyOn(MlClient.prototype, 'vlmAnalyze').mockImplementation(async (imagePaths, prompt) => {
      if (prompt.includes('semantic clip type and materialization policy')) {
        return {
          description: JSON.stringify({
            visual_summary: {
              scene_type: 'landscape',
              subjects: ['pier', 'coastline'],
              mood: 'calm',
              place_hints: ['Auckland'],
              narrative_role: 'detail',
              description: `Recognized ${imagePaths.length} direct-usable frames.`,
            },
            decision: {
              clip_type: 'broll',
              keep_decision: 'keep',
              materialization_path: 'direct',
              decision_reasons: ['test-direct-materialization'],
            },
          }),
          timing: {
            backend: 'mlx',
            modelRef: 'test-qwen',
            totalMs: 48,
            processorMs: 7,
            generateMs: 34,
          },
        };
      }
      return {
        description: JSON.stringify({
          scene_type: 'landscape',
          subjects: ['pier', 'coastline'],
          mood: 'calm',
          place_hints: ['Auckland'],
          narrative_role: 'detail',
          description: `Recognized ${imagePaths.length} direct-usable frames.`,
        }),
        timing: {
          backend: 'mlx',
          modelRef: 'test-qwen',
          totalMs: 32,
          processorMs: 6,
          generateMs: 21,
        },
      };
    });

    const { analyzeWorkspaceProjectMedia } = await import('../../src/modules/media/project-analyze.js');
    const result = await analyzeWorkspaceProjectMedia({
      workspaceRoot,
      projectId,
      performanceProfile: {
        enabled: true,
        runLabel: 'direct-materialization',
      },
    });

    const report = JSON.parse(
      await readFile(getAssetReportPath(projectRoot, 'asset-direct'), 'utf-8'),
    ) as {
      keepDecision: string;
      materializationPath?: string;
      fineScanMode?: string;
    };
    const slices = JSON.parse(
      await readFile(getSlicesPath(projectRoot), 'utf-8'),
    ) as Array<{ assetId: string; materialPatterns?: Array<{ phrase: string }> }>;

    expect(report.keepDecision).toBe('keep');
    expect(report.materializationPath).toBe('direct');
    expect(report.fineScanMode).toBeUndefined();
    expect(result.fineScannedAssetIds).toEqual([]);
    expect(result.sliceCount).toBeGreaterThan(0);
    expect(slices.some(slice => slice.assetId === 'asset-direct')).toBe(true);
    expect(detectShotsMock).not.toHaveBeenCalled();
  });

  it('writes a structured performance profile for a successful analyze run', async () => {
    const workspaceRoot = await createWorkspace();
    const projectId = 'project-analyze-profiled';
    const projectRoot = await initWorkspaceProject(workspaceRoot, projectId, 'Profiled Analyze Project');
    const mediaRoot = join(projectRoot, '.tmp', 'fixtures');
    const mediaPath = join(mediaRoot, 'clip.mp4');

    await mkdir(mediaRoot, { recursive: true });
    await writeFile(mediaPath, 'fake-media');

    await writeJson(join(projectRoot, 'config/runtime.json'), {
      mlServerUrl: 'http://127.0.0.1:8910',
    });
    await writeJson(join(projectRoot, 'config/ingest-roots.json'), {
      roots: [{
        id: 'root-1',
        enabled: true,
        label: 'camera-a',
        path: mediaRoot,
      }],
    });
    await writeJson(join(projectRoot, 'store/assets.json'), [{
      id: 'asset-1',
      kind: 'video',
      sourcePath: 'clip.mp4',
      displayName: 'clip.mp4',
      ingestRootId: 'root-1',
      durationMs: 12_000,
      capturedAt: '2026-03-31T08:15:30.000Z',
      metadata: {
        hasAudioStream: true,
      },
    }]);

    extractKeyframesMock.mockImplementation(async (
      _filePath: string,
      outputDir: string,
      timestampsMs: number[],
    ) => {
      await mkdir(outputDir, { recursive: true });
      return Promise.all(timestampsMs.map(async timeMs => {
        const framePath = join(outputDir, `frame-${timeMs}.jpg`);
        await writeFile(framePath, `frame-${timeMs}`);
        return { timeMs, path: framePath };
      }));
    });

    vi.spyOn(MlClient.prototype, 'health').mockResolvedValue({
      status: 'ok',
      device: 'apple',
      backend: 'mlx',
      models_loaded: [],
    });
    const asrSpy = vi.spyOn(MlClient.prototype, 'asrDetailed').mockResolvedValue({
      segments: [
        { start: 0.2, end: 2.4, text: 'Driving through the valley now.' },
        { start: 4.1, end: 6.2, text: 'The lake opens up on the left side.' },
      ],
      timing: {
        backend: 'mlx',
        modelRef: 'test-whisper',
        totalMs: 88,
        wavExtractMs: 24,
        inferenceMs: 59,
      },
    });
    const vlmSpy = vi.spyOn(MlClient.prototype, 'vlmAnalyze').mockImplementation(async (imagePaths, prompt) => {
      if (prompt.includes('semantic clip type and materialization policy')) {
        return {
          description: JSON.stringify({
            visual_summary: {
              scene_type: 'landscape',
              subjects: ['mountains', 'road'],
              mood: 'calm',
              place_hints: ['lake'],
              narrative_role: 'establishing',
              description: `Recognized ${imagePaths.length} representative frames.`,
            },
            decision: {
              clip_type: 'broll',
              keep_decision: 'keep',
              materialization_path: 'fine-scan',
              fine_scan_mode: 'windowed',
              decision_reasons: ['test-semantic-decision'],
            },
          }),
          timing: {
            backend: 'mlx',
            modelRef: 'test-qwen',
            totalMs: 73,
            processorMs: 11,
            generateMs: 54,
          },
        };
      }
      return {
        description: JSON.stringify({
          scene_type: 'landscape',
          subjects: ['mountains', 'road'],
          mood: 'calm',
          place_hints: ['lake'],
          narrative_role: 'establishing',
          description: `Recognized ${imagePaths.length} representative frames.`,
        }),
        timing: {
          backend: 'mlx',
          modelRef: 'test-qwen',
          totalMs: 46,
          processorMs: 8,
          generateMs: 31,
        },
      };
    });

    const { analyzeWorkspaceProjectMedia } = await import('../../src/modules/media/project-analyze.js');
    const result = await analyzeWorkspaceProjectMedia({
      workspaceRoot,
      projectId,
      performanceProfile: {
        enabled: true,
        runLabel: 'baseline-mock',
        candidateModel: 'test-qwen',
      },
    });

    expect(result.reportCount).toBe(1);
    expect(result.sliceCount).toBeGreaterThan(0);
    expect(result.performanceProfilePath).toBe(getAnalyzePerformanceProfilePath(projectRoot));

    const profile = JSON.parse(
      await readFile(result.performanceProfilePath as string, 'utf-8'),
    ) as {
      status: string;
      runLabel?: string;
      candidateModel?: string;
      pipelineTotalMs: number;
      assetCount: number;
      analyzedAssetCount: number;
      fineScannedAssetCount: number;
      stageTotals: Record<string, number>;
      ml: Record<string, any>;
      ffmpeg: Record<string, number>;
      io: Record<string, number>;
      assets: Array<Record<string, any>>;
    };

    expect(profile.status).toBe('succeeded');
    expect(profile.runLabel).toBe('baseline-mock');
    expect(profile.candidateModel).toBe('test-qwen');
    expect(profile.assetCount).toBe(1);
    expect(profile.analyzedAssetCount).toBe(1);
    expect(profile.fineScannedAssetCount).toBe(1);
    expect(profile.pipelineTotalMs).toBeGreaterThan(0);
    expect(profile.stageTotals.prepareMs).toBeGreaterThanOrEqual(0);
    expect(profile.stageTotals.finalizeMs).toBeGreaterThanOrEqual(0);
    expect(profile.stageTotals.chronologyRefreshMs).toBeGreaterThanOrEqual(0);
    expect(profile.ml.finalizeVlm.requestCount).toBe(1);
    expect(profile.ml.fineScanVlm.requestCount).toBeGreaterThan(0);
    expect(profile.ml.embeddedAsr.requestCount).toBe(1);
    expect(profile.ml.embeddedAsr.wavExtractMs).toBe(24);
    expect(profile.ffmpeg.sceneDetectCallCount).toBe(0);
    expect(profile.ffmpeg.sceneDetectPhases?.prepare?.callCount).toBe(0);
    expect(profile.ffmpeg.sceneDetectPhases?.finalize?.callCount).toBe(0);
    expect(profile.ffmpeg.sceneDetectPhases?.['fine-scan']?.callCount).toBe(0);
    expect(profile.ffmpeg.keyframeExtractCallCount).toBe(2);
    expect(profile.ffmpeg.coarseKeyframeCount).toBeGreaterThan(0);
    expect(profile.ffmpeg.fineKeyframeCount).toBeGreaterThan(0);
    expect(profile.io.progressWriteCount).toBeGreaterThan(0);
    expect(profile.io.reportWriteCount).toBeGreaterThan(0);
    expect(profile.io.sliceAppendCount).toBe(1);
    expect(profile.assets).toHaveLength(1);
    expect(profile.assets[0]?.assetId).toBe('asset-1');
    expect(profile.assets[0]?.vlm?.finalizeRequestCount).toBe(1);
    expect(profile.assets[0]?.vlm?.fineRequestCount).toBeGreaterThan(0);
    expect(profile.assets[0]?.sceneDetectPhases?.finalize?.callCount).toBe(0);
    expect(profile.assets[0]?.asr?.embeddedRequestCount).toBe(1);
    expect(profile.assets[0]?.appendedSliceCount).toBe(result.sliceCount);
    expect(asrSpy.mock.calls[0]?.[2]).toEqual({ keepOtherModelsLoaded: false });
    const finalizeVlmCall = vlmSpy.mock.calls.find(call => call[1]?.includes('semantic clip type and materialization policy'));
    expect(finalizeVlmCall?.[2]).toEqual(expect.objectContaining({
      keepOtherModelsLoaded: false,
      maxTokens: 512,
    }));
    expect(detectShotsMock).not.toHaveBeenCalled();
  });

  it('uses audio-led windows and runs deferred scene detect for fragmented talking-head windows', async () => {
    const workspaceRoot = await createWorkspace();
    const projectId = 'project-analyze-audio-led';
    const projectRoot = await initWorkspaceProject(workspaceRoot, projectId, 'Audio-led Analyze Project');
    const mediaRoot = join(projectRoot, '.tmp', 'fixtures');
    const mediaPath = join(mediaRoot, 'talking-head.mp4');

    await mkdir(mediaRoot, { recursive: true });
    await writeFile(mediaPath, 'fake-media');

    await writeJson(join(projectRoot, 'config/runtime.json'), {
      mlServerUrl: 'http://127.0.0.1:8910',
    });
    await writeJson(join(projectRoot, 'config/ingest-roots.json'), {
      roots: [{
        id: 'root-1',
        enabled: true,
        label: 'camera-a',
        path: mediaRoot,
      }],
    });
    await writeJson(join(projectRoot, 'store/assets.json'), [{
      id: 'asset-talk',
      kind: 'video',
      sourcePath: 'talking-head.mp4',
      displayName: 'talking-head.mp4',
      ingestRootId: 'root-1',
      durationMs: 120_000,
      capturedAt: '2026-03-31T08:15:30.000Z',
      metadata: {
        hasAudioStream: true,
      },
    }]);

    detectShotsMock.mockResolvedValue([]);
    extractKeyframesMock.mockImplementation(async (
      _filePath: string,
      outputDir: string,
      timestampsMs: number[],
    ) => {
      await mkdir(outputDir, { recursive: true });
      return Promise.all(timestampsMs.map(async timeMs => {
        const framePath = join(outputDir, `frame-${timeMs}.jpg`);
        await writeFile(framePath, `frame-${timeMs}`);
        return { timeMs, path: framePath };
      }));
    });

    vi.spyOn(MlClient.prototype, 'health').mockResolvedValue({
      status: 'ok',
      device: 'apple',
      backend: 'mlx',
      models_loaded: [],
    });
    vi.spyOn(MlClient.prototype, 'asrDetailed').mockResolvedValue({
      segments: [
        { start: 10, end: 22, text: 'We are stopping here to explain the route.' },
        { start: 48, end: 58, text: 'This overlook is the best view on the trip.' },
      ],
      timing: {
        backend: 'mlx',
        modelRef: 'test-whisper',
        totalMs: 72,
        wavExtractMs: 18,
        inferenceMs: 48,
      },
    });
    vi.spyOn(MlClient.prototype, 'vlmAnalyze').mockImplementation(async (imagePaths, prompt) => {
      if (prompt.includes('semantic clip type and materialization policy')) {
        return {
          description: JSON.stringify({
            visual_summary: {
              scene_type: 'portrait',
              subjects: ['speaker', 'mountains'],
              mood: 'calm',
              place_hints: ['lookout'],
              narrative_role: 'detail',
              description: `Recognized ${imagePaths.length} speaking frames.`,
            },
            decision: {
              clip_type: 'talking-head',
              keep_decision: 'keep',
              materialization_path: 'fine-scan',
              fine_scan_mode: 'full',
              decision_reasons: ['test-talking-head-decision'],
            },
          }),
          timing: {
            backend: 'mlx',
            modelRef: 'test-qwen',
            totalMs: 55,
            processorMs: 8,
            generateMs: 40,
          },
        };
      }
      return {
        description: JSON.stringify({
          scene_type: 'portrait',
          subjects: ['speaker', 'mountains'],
          mood: 'calm',
          place_hints: ['lookout'],
          narrative_role: 'detail',
          description: `Recognized ${imagePaths.length} speaking frames.`,
        }),
        timing: {
          backend: 'mlx',
          modelRef: 'test-qwen',
          totalMs: 44,
          processorMs: 8,
          generateMs: 29,
        },
      };
    });

    const { analyzeWorkspaceProjectMedia } = await import('../../src/modules/media/project-analyze.js');
    const result = await analyzeWorkspaceProjectMedia({
      workspaceRoot,
      projectId,
      performanceProfile: {
        enabled: true,
        runLabel: 'audio-led-talking-head',
      },
    });

    const report = JSON.parse(
      await readFile(getAssetReportPath(projectRoot, 'asset-talk'), 'utf-8'),
    ) as {
      materializationPath?: string;
      fineScanMode: string;
      interestingWindows: Array<{ reason: string }>;
      fineScanReasons: string[];
    };
    const profile = JSON.parse(
      await readFile(result.performanceProfilePath as string, 'utf-8'),
    ) as {
      ffmpeg: Record<string, any>;
      assets: Array<Record<string, any>>;
    };

    expect(report.materializationPath).toBe('fine-scan');
    expect(['windowed', 'full']).toContain(report.fineScanMode);
    expect(report.interestingWindows.length).toBeGreaterThan(0);
    expect(report.interestingWindows.every(window => window.reason.includes('speech-window'))).toBe(true);
    expect(report.fineScanReasons).toContain('talking-head:audio-led-windows');
    expect(detectShotsMock).toHaveBeenCalledTimes(1);
    expect(profile.ffmpeg.sceneDetectPhases?.finalize?.callCount).toBe(1);
    expect(profile.assets[0]?.sceneDetectPhases?.finalize?.callCount).toBe(1);
  });

  it('fails the analyze run when unified finalize returns invalid JSON', async () => {
    const workspaceRoot = await createWorkspace();
    const projectId = 'project-analyze-finalize-failure';
    const projectRoot = await initWorkspaceProject(workspaceRoot, projectId, 'Finalize Failure Project');
    const mediaRoot = join(projectRoot, '.tmp', 'fixtures');

    await mkdir(mediaRoot, { recursive: true });
    await writeFile(join(mediaRoot, 'broken.mp4'), 'fake-media');

    await writeJson(join(projectRoot, 'config/runtime.json'), {
      mlServerUrl: 'http://127.0.0.1:8910',
    });
    await writeJson(join(projectRoot, 'config/ingest-roots.json'), {
      roots: [{
        id: 'root-1',
        enabled: true,
        label: 'camera-a',
        description: 'Main travel ingest root',
        notes: ['road trip footage'],
        path: mediaRoot,
      }],
    });
    await writeJson(join(projectRoot, 'store/assets.json'), [{
      id: 'asset-broken',
      kind: 'video',
      sourcePath: 'broken.mp4',
      displayName: 'broken.mp4',
      ingestRootId: 'root-1',
      durationMs: 12_000,
      capturedAt: '2026-03-31T08:15:30.000Z',
      metadata: {
        hasAudioStream: false,
      },
    }]);

    extractKeyframesMock.mockImplementation(async (
      _filePath: string,
      outputDir: string,
      timestampsMs: number[],
    ) => {
      await mkdir(outputDir, { recursive: true });
      return Promise.all(timestampsMs.map(async timeMs => {
        const framePath = join(outputDir, `frame-${timeMs}.jpg`);
        await writeFile(framePath, `frame-${timeMs}`);
        return { timeMs, path: framePath };
      }));
    });

    vi.spyOn(MlClient.prototype, 'health').mockResolvedValue({
      status: 'ok',
      device: 'apple',
      backend: 'mlx',
      models_loaded: [],
    });
    const vlmSpy = vi.spyOn(MlClient.prototype, 'vlmAnalyze').mockResolvedValue({
      description: 'not-json',
      timing: {
        backend: 'mlx',
        modelRef: 'test-qwen',
        totalMs: 40,
      },
    });

    const { analyzeWorkspaceProjectMedia } = await import('../../src/modules/media/project-analyze.js');
    await expect(analyzeWorkspaceProjectMedia({
      workspaceRoot,
      projectId,
      performanceProfile: {
        enabled: true,
        runLabel: 'finalize-failure',
      },
    })).rejects.toThrow(/统一完成素材分析失败/u);

    const profile = JSON.parse(
      await readFile(getAnalyzePerformanceProfilePath(projectRoot), 'utf-8'),
    ) as {
      status: string;
      fineScannedAssetCount: number;
      failureMessage?: string;
      failureItems?: Array<{ assetId: string; stage: string; reason: string }>;
    };
    const progress = JSON.parse(
      await readFile(join(projectRoot, '.tmp', 'media-analyze', 'progress.json'), 'utf-8'),
    ) as {
      status: string;
      detail?: string;
      step?: string;
      extra?: { failures?: Array<{ assetId: string }> };
    };

    expect(profile.status).toBe('failed');
    expect(profile.fineScannedAssetCount).toBe(0);
    expect(profile.failureMessage).toMatch(/统一完成素材分析失败 1 条/u);
    expect(profile.failureItems).toEqual([
      expect.objectContaining({
        assetId: 'asset-broken',
        stage: 'finalize',
      }),
    ]);
    expect(progress.status).toBe('failed');
    expect(progress.step).toBe('finalize');
    expect(progress.detail).toMatch(/统一完成素材分析失败 1 条/u);
    expect(progress.extra?.failures?.[0]?.assetId).toBe('asset-broken');
    const finalizeCalls = vlmSpy.mock.calls.filter(call => call[1]?.includes('semantic clip type and materialization policy'));
    expect(finalizeCalls).toHaveLength(3);
    expect(finalizeCalls.map(call => call[2]?.maxTokens)).toEqual([512, 768, 1152]);
    const captureRoot = join(projectRoot, '.tmp', 'media-analyze', 'finalize-attempts', 'asset-broken');
    const attemptOne = JSON.parse(await readFile(join(captureRoot, 'attempt-01.json'), 'utf-8')) as { parseOk: boolean; maxTokens: number; response: string; };
    const attemptThree = JSON.parse(await readFile(join(captureRoot, 'attempt-03.json'), 'utf-8')) as { parseOk: boolean; maxTokens: number; response: string; };
    expect(attemptOne.parseOk).toBe(false);
    expect(attemptOne.maxTokens).toBe(512);
    expect(attemptThree.parseOk).toBe(false);
    expect(attemptThree.maxTokens).toBe(1152);
    expect(attemptThree.response).toBe('not-json');
    expect(detectShotsMock).not.toHaveBeenCalled();
    await expect(access(join(projectRoot, 'media', 'chronology.json'))).rejects.toThrow();
  });

  it('retries unified finalize with larger token budgets and succeeds on a later attempt', async () => {
    const workspaceRoot = await createWorkspace();
    const projectId = 'project-analyze-finalize-retry-success';
    const projectRoot = await initWorkspaceProject(workspaceRoot, projectId, 'Finalize Retry Success Project');
    const mediaRoot = join(projectRoot, '.tmp', 'fixtures');

    await mkdir(mediaRoot, { recursive: true });
    await writeFile(join(mediaRoot, 'retry.mp4'), 'fake-media');

    await writeJson(join(projectRoot, 'config/runtime.json'), {
      mlServerUrl: 'http://127.0.0.1:8910',
    });
    await writeJson(join(projectRoot, 'config/ingest-roots.json'), {
      roots: [{
        id: 'root-1',
        enabled: true,
        label: 'camera-a',
        description: 'Main travel ingest root',
        notes: ['retry footage'],
        path: mediaRoot,
      }],
    });
    await writeJson(join(projectRoot, 'store/assets.json'), [{
      id: 'asset-retry',
      kind: 'video',
      sourcePath: 'retry.mp4',
      displayName: 'retry.mp4',
      ingestRootId: 'root-1',
      durationMs: 10_000,
      capturedAt: '2026-03-31T08:15:30.000Z',
      metadata: {
        hasAudioStream: false,
      },
    }]);

    extractKeyframesMock.mockImplementation(async (
      _filePath: string,
      outputDir: string,
      timestampsMs: number[],
    ) => {
      await mkdir(outputDir, { recursive: true });
      return Promise.all(timestampsMs.map(async timeMs => {
        const framePath = join(outputDir, `frame-${timeMs}.jpg`);
        await writeFile(framePath, `frame-${timeMs}`);
        return { timeMs, path: framePath };
      }));
    });

    vi.spyOn(MlClient.prototype, 'health').mockResolvedValue({
      status: 'ok',
      device: 'apple',
      backend: 'mlx',
      models_loaded: [],
    });
    const vlmSpy = vi.spyOn(MlClient.prototype, 'vlmAnalyze')
      .mockResolvedValueOnce({
        description: '{"visual_summary": {"scene_type": "broken"',
        timing: {
          backend: 'mlx',
          modelRef: 'test-qwen',
          totalMs: 40,
        },
      })
      .mockResolvedValueOnce({
        description: 'not-json',
        timing: {
          backend: 'mlx',
          modelRef: 'test-qwen',
          totalMs: 41,
        },
      })
      .mockResolvedValueOnce({
        description: JSON.stringify({
          visual_summary: {
            scene_type: 'landscape',
            subjects: ['road'],
            mood: 'calm',
            place_hints: ['lake'],
            narrative_role: 'detail',
            description: 'Valid finalize output after retries.',
          },
          decision: {
            clip_type: 'broll',
            keep_decision: 'keep',
            materialization_path: 'direct',
            decision_reasons: ['test-retry-success'],
          },
        }),
        timing: {
          backend: 'mlx',
          modelRef: 'test-qwen',
          totalMs: 42,
        },
      });

    const { analyzeWorkspaceProjectMedia } = await import('../../src/modules/media/project-analyze.js');
    const result = await analyzeWorkspaceProjectMedia({
      workspaceRoot,
      projectId,
    });

    expect(result.analyzedAssetIds).toEqual(['asset-retry']);
    expect(result.reportCount).toBe(1);
    const finalizeCalls = vlmSpy.mock.calls.filter(call => call[1]?.includes('semantic clip type and materialization policy'));
    expect(finalizeCalls).toHaveLength(3);
    expect(finalizeCalls.map(call => call[2]?.maxTokens)).toEqual([512, 768, 1152]);
    const captureRoot = join(projectRoot, '.tmp', 'media-analyze', 'finalize-attempts', 'asset-retry');
    const attemptOne = JSON.parse(await readFile(join(captureRoot, 'attempt-01.json'), 'utf-8')) as { parseOk: boolean; maxTokens: number; responseLikelyTruncated: boolean; };
    const attemptTwo = JSON.parse(await readFile(join(captureRoot, 'attempt-02.json'), 'utf-8')) as { parseOk: boolean; maxTokens: number; };
    const attemptThree = JSON.parse(await readFile(join(captureRoot, 'attempt-03.json'), 'utf-8')) as { parseOk: boolean; maxTokens: number; response: string; };
    expect(attemptOne.parseOk).toBe(false);
    expect(attemptOne.maxTokens).toBe(512);
    expect(attemptOne.responseLikelyTruncated).toBe(true);
    expect(attemptTwo.parseOk).toBe(false);
    expect(attemptTwo.maxTokens).toBe(768);
    expect(attemptThree.parseOk).toBe(true);
    expect(attemptThree.maxTokens).toBe(1152);
    const report = JSON.parse(await readFile(getAssetReportPath(projectRoot, 'asset-retry'), 'utf-8')) as { clipTypeGuess: string; keepDecision: string; };
    expect(report.clipTypeGuess).toBe('broll');
    expect(report.keepDecision).toBe('keep');
    await expect(access(join(projectRoot, 'media', 'chronology.json'))).resolves.toBeUndefined();
  });

  it('runs deferred scene detect for scenic drives using finalize VLM semantics', async () => {
    const workspaceRoot = await createWorkspace();
    const projectId = 'project-analyze-scenic-drive';
    const projectRoot = await initWorkspaceProject(workspaceRoot, projectId, 'Scenic Drive Project');
    const mediaRoot = join(projectRoot, '.tmp', 'fixtures');
    const mediaPath = join(mediaRoot, 'scenic-drive.mp4');

    await mkdir(mediaRoot, { recursive: true });
    await writeFile(mediaPath, 'fake-media');

    await writeJson(join(projectRoot, 'config/runtime.json'), {
      mlServerUrl: 'http://127.0.0.1:8910',
    });
    await writeJson(join(projectRoot, 'config/ingest-roots.json'), {
      roots: [{
        id: 'root-1',
        enabled: true,
        label: 'camera-a',
        path: mediaRoot,
      }],
    });
    await writeJson(join(projectRoot, 'store/assets.json'), [{
      id: 'asset-drive-scenic',
      kind: 'video',
      sourcePath: 'scenic-drive.mp4',
      displayName: 'scenic-drive.mp4',
      ingestRootId: 'root-1',
      durationMs: 95_000,
      capturedAt: '2026-03-31T08:15:30.000Z',
      metadata: {
        hasAudioStream: false,
      },
    }]);

    detectShotsMock.mockResolvedValue([
      { timeMs: 21_000, score: 0.88 },
    ]);
    extractKeyframesMock.mockImplementation(async (
      _filePath: string,
      outputDir: string,
      timestampsMs: number[],
    ) => {
      await mkdir(outputDir, { recursive: true });
      return Promise.all(timestampsMs.map(async timeMs => {
        const framePath = join(outputDir, `frame-${timeMs}.jpg`);
        await writeFile(framePath, `frame-${timeMs}`);
        return { timeMs, path: framePath };
      }));
    });

    vi.spyOn(MlClient.prototype, 'health').mockResolvedValue({
      status: 'ok',
      device: 'apple',
      backend: 'mlx',
      models_loaded: [],
    });
    vi.spyOn(MlClient.prototype, 'vlmAnalyze').mockImplementation(async (imagePaths, prompt) => {
      if (prompt.includes('semantic clip type and materialization policy')) {
        return {
          description: JSON.stringify({
            visual_summary: {
              scene_type: 'driving',
              subjects: ['winding road', 'mountains', 'lake'],
              mood: 'calm',
              place_hints: ['queenstown'],
              narrative_role: 'transition',
              description: `Recognized ${imagePaths.length} scenic frames along a winding lakeside mountain road.`,
            },
            decision: {
              clip_type: 'drive',
              keep_decision: 'keep',
              materialization_path: 'direct',
              decision_reasons: ['test-scenic-drive-skip'],
            },
          }),
          timing: {
            backend: 'mlx',
            modelRef: 'test-qwen',
            totalMs: 58,
            processorMs: 8,
            generateMs: 41,
          },
        };
      }
      return {
        description: JSON.stringify({
          scene_type: 'driving',
          subjects: ['winding road', 'mountains', 'lake'],
          mood: 'calm',
          place_hints: ['queenstown'],
          narrative_role: 'transition',
          description: `Recognized ${imagePaths.length} scenic frames along a winding lakeside mountain road.`,
        }),
        timing: {
          backend: 'mlx',
          modelRef: 'test-qwen',
          totalMs: 43,
          processorMs: 7,
          generateMs: 29,
        },
      };
    });

    const { analyzeWorkspaceProjectMedia } = await import('../../src/modules/media/project-analyze.js');
    const result = await analyzeWorkspaceProjectMedia({
      workspaceRoot,
      projectId,
      performanceProfile: {
        enabled: true,
        runLabel: 'scenic-drive-trigger',
      },
    });

    const report = JSON.parse(
      await readFile(getAssetReportPath(projectRoot, 'asset-drive-scenic'), 'utf-8'),
    ) as {
      fineScanMode: string;
      fineScanReasons: string[];
      interestingWindows: Array<{ semanticKind?: string }>;
    };
    const profile = JSON.parse(
      await readFile(result.performanceProfilePath as string, 'utf-8'),
    ) as {
      ffmpeg: Record<string, any>;
      assets: Array<Record<string, any>>;
    };

    expect(report.fineScanMode).toBe('windowed');
    expect(report.fineScanReasons).toContain('guardrail:interesting-window-promoted');
    expect(result.sliceCount).toBeGreaterThan(0);
    expect(report.interestingWindows.some(window => window.semanticKind === 'visual')).toBe(true);
    expect(detectShotsMock).toHaveBeenCalledTimes(1);
    expect(detectShotsMock.mock.calls[0]?.[3]).toMatchObject({
      clipType: 'drive',
      durationMs: 95_000,
    });
    expect(profile.ffmpeg.sceneDetectCallCount).toBe(1);
    expect(profile.ffmpeg.sceneDetectPhases?.finalize?.callCount).toBe(1);
    expect(profile.assets[0]?.sceneDetectPhases?.finalize?.callCount).toBe(1);
  });


  it('keeps drive speech and visual windows separate through slices', async () => {
    const workspaceRoot = await createWorkspace();
    const projectId = 'project-analyze-drive-semantics';
    const projectRoot = await initWorkspaceProject(workspaceRoot, projectId, 'Drive Window Semantics Project');
    const mediaRoot = join(projectRoot, '.tmp', 'fixtures');
    const mediaPath = join(mediaRoot, 'forest-drive.mp4');

    await mkdir(mediaRoot, { recursive: true });
    await writeFile(mediaPath, 'fake-media');

    await writeJson(join(projectRoot, 'config/runtime.json'), {
      mlServerUrl: 'http://127.0.0.1:8910',
    });
    await writeJson(join(projectRoot, 'config/ingest-roots.json'), {
      roots: [{
        id: 'root-1',
        enabled: true,
        label: 'camera-a',
        path: mediaRoot,
      }],
    });
    await writeJson(join(projectRoot, 'store/assets.json'), [{
      id: 'asset-drive-semantic',
      kind: 'video',
      sourcePath: 'forest-drive.mp4',
      displayName: 'forest-drive.mp4',
      ingestRootId: 'root-1',
      durationMs: 180_000,
      capturedAt: '2026-03-31T08:15:30.000Z',
      metadata: {
        hasAudioStream: true,
      },
    }]);

    detectShotsMock.mockResolvedValue([
      { timeMs: 60_000, score: 0.92 },
    ]);
    extractKeyframesMock.mockImplementation(async (
      _filePath: string,
      outputDir: string,
      timestampsMs: number[],
    ) => {
      await mkdir(outputDir, { recursive: true });
      return Promise.all(timestampsMs.map(async timeMs => {
        const framePath = join(outputDir, `frame-${timeMs}.jpg`);
        await writeFile(framePath, `frame-${timeMs}`);
        return { timeMs, path: framePath };
      }));
    });

    vi.spyOn(MlClient.prototype, 'health').mockResolvedValue({
      status: 'ok',
      device: 'apple',
      backend: 'mlx',
      models_loaded: [],
    });
    vi.spyOn(MlClient.prototype, 'asrDetailed').mockResolvedValue({
      segments: [
        { start: 14, end: 21, text: 'We are passing the old bridge now.' },
        { start: 59.2, end: 63.4, text: 'This curve opens straight into the forest.' },
      ],
      timing: {
        backend: 'mlx',
        modelRef: 'test-whisper',
        totalMs: 76,
        wavExtractMs: 19,
        inferenceMs: 51,
      },
    });
    vi.spyOn(MlClient.prototype, 'vlmAnalyze').mockImplementation(async (imagePaths, prompt) => {
      if (prompt.includes('semantic clip type and materialization policy')) {
        return {
          description: JSON.stringify({
            visual_summary: {
              scene_type: 'driving',
              subjects: ['forest road', 'bridge', 'trees'],
              mood: 'calm',
              place_hints: ['queenstown'],
              narrative_role: 'transition',
              description: `Recognized ${imagePaths.length} scenic frames while driving from the bridge into the forest.`,
            },
            decision: {
              clip_type: 'drive',
              keep_decision: 'keep',
              materialization_path: 'fine-scan',
              fine_scan_mode: 'windowed',
              decision_reasons: ['test-drive-windowed'],
            },
          }),
          timing: {
            backend: 'mlx',
            modelRef: 'test-qwen',
            totalMs: 52,
            processorMs: 8,
            generateMs: 37,
          },
        };
      }
      return {
        description: JSON.stringify({
          scene_type: 'driving',
          subjects: ['forest road', 'bridge', 'trees'],
          mood: 'calm',
          place_hints: ['queenstown'],
          narrative_role: 'transition',
          description: `Recognized ${imagePaths.length} scenic frames while driving from the bridge into the forest.`,
        }),
        timing: {
          backend: 'mlx',
          modelRef: 'test-qwen',
          totalMs: 44,
          processorMs: 7,
          generateMs: 30,
        },
      };
    });

    const { analyzeWorkspaceProjectMedia } = await import('../../src/modules/media/project-analyze.js');
    const result = await analyzeWorkspaceProjectMedia({
      workspaceRoot,
      projectId,
      performanceProfile: {
        enabled: true,
        runLabel: 'drive-window-semantics',
      },
    });

    const report = JSON.parse(
      await readFile(getAssetReportPath(projectRoot, 'asset-drive-semantic'), 'utf-8'),
    ) as {
      fineScanMode: string;
      interestingWindows: Array<{
        semanticKind?: string;
        speedCandidate?: { suggestedSpeeds: number[] };
      }>;
    };
    const slices = JSON.parse(
      await readFile(getSlicesPath(projectRoot), 'utf-8'),
    ) as Array<{
      semanticKind?: string;
      transcript?: string;
      speedCandidate?: { suggestedSpeeds: number[] };
    }>;

    const speechWindows = report.interestingWindows.filter(window => window.semanticKind === 'speech');
    const visualWindows = report.interestingWindows.filter(window => window.semanticKind === 'visual');
    const speechSlices = slices.filter(slice => slice.semanticKind === 'speech');
    const visualSlices = slices.filter(slice => slice.semanticKind === 'visual');

    expect(report.fineScanMode).toBe('windowed');
    expect(speechWindows.length).toBeGreaterThan(0);
    expect(visualWindows.length).toBeGreaterThan(0);
    expect(speechWindows.every(window => window.speedCandidate == null)).toBe(true);
    expect(visualWindows.some(window => window.speedCandidate != null)).toBe(true);
    expect(speechSlices.length).toBeGreaterThan(0);
    expect(visualSlices.length).toBeGreaterThan(0);
    expect(speechSlices.every(slice => typeof slice.transcript === 'string' && slice.transcript.length > 0)).toBe(true);
    expect(visualSlices.every(slice => slice.transcript == null)).toBe(true);
    expect(speechSlices.every(slice => slice.speedCandidate == null)).toBe(true);
    expect(visualSlices.some(slice => slice.speedCandidate != null)).toBe(true);
    expect(detectShotsMock).toHaveBeenCalledTimes(1);
    expect(detectShotsMock.mock.calls[0]?.[3]).toMatchObject({
      clipType: 'drive',
      durationMs: 180_000,
    });
    expect(result.sliceCount).toBe(slices.length);
  });

  it('keeps non-scenic drives out of deferred scene detect', async () => {
    const workspaceRoot = await createWorkspace();
    const projectId = 'project-analyze-non-scenic-drive';
    const projectRoot = await initWorkspaceProject(workspaceRoot, projectId, 'Non Scenic Drive Project');
    const mediaRoot = join(projectRoot, '.tmp', 'fixtures');
    const mediaPath = join(mediaRoot, 'commute-drive.mp4');

    await mkdir(mediaRoot, { recursive: true });
    await writeFile(mediaPath, 'fake-media');

    await writeJson(join(projectRoot, 'config/runtime.json'), {
      mlServerUrl: 'http://127.0.0.1:8910',
    });
    await writeJson(join(projectRoot, 'config/ingest-roots.json'), {
      roots: [{
        id: 'root-1',
        enabled: true,
        label: 'camera-a',
        path: mediaRoot,
      }],
    });
    await writeJson(join(projectRoot, 'store/assets.json'), [{
      id: 'asset-drive-flat',
      kind: 'video',
      sourcePath: 'commute-drive.mp4',
      displayName: 'commute-drive.mp4',
      ingestRootId: 'root-1',
      durationMs: 95_000,
      capturedAt: '2026-03-31T08:15:30.000Z',
      metadata: {
        hasAudioStream: false,
      },
    }]);

    extractKeyframesMock.mockImplementation(async (
      _filePath: string,
      outputDir: string,
      timestampsMs: number[],
    ) => {
      await mkdir(outputDir, { recursive: true });
      return Promise.all(timestampsMs.map(async timeMs => {
        const framePath = join(outputDir, `frame-${timeMs}.jpg`);
        await writeFile(framePath, `frame-${timeMs}`);
        return { timeMs, path: framePath };
      }));
    });

    vi.spyOn(MlClient.prototype, 'health').mockResolvedValue({
      status: 'ok',
      device: 'apple',
      backend: 'mlx',
      models_loaded: [],
    });
    vi.spyOn(MlClient.prototype, 'vlmAnalyze').mockImplementation(async (imagePaths, prompt) => {
      if (prompt.includes('semantic clip type and materialization policy')) {
        return {
          description: JSON.stringify({
            visual_summary: {
              scene_type: 'driving',
              subjects: ['dashboard', 'highway lane'],
              mood: 'calm',
              place_hints: [],
              narrative_role: 'filler',
              description: `Recognized ${imagePaths.length} steady highway commute frames from the dashboard.`,
            },
            decision: {
              clip_type: 'drive',
              keep_decision: 'keep',
              materialization_path: 'direct',
              decision_reasons: ['test-flat-drive-skip'],
            },
          }),
          timing: {
            backend: 'mlx',
            modelRef: 'test-qwen',
            totalMs: 57,
            processorMs: 8,
            generateMs: 40,
          },
        };
      }
      return {
        description: JSON.stringify({
          scene_type: 'driving',
          subjects: ['dashboard', 'highway lane'],
          mood: 'calm',
          place_hints: [],
          narrative_role: 'filler',
          description: `Recognized ${imagePaths.length} steady highway commute frames from the dashboard.`,
        }),
        timing: {
          backend: 'mlx',
          modelRef: 'test-qwen',
          totalMs: 40,
          processorMs: 7,
          generateMs: 26,
        },
      };
    });

    const { analyzeWorkspaceProjectMedia } = await import('../../src/modules/media/project-analyze.js');
    const result = await analyzeWorkspaceProjectMedia({
      workspaceRoot,
      projectId,
      performanceProfile: {
        enabled: true,
        runLabel: 'flat-drive-skip',
      },
    });

    const report = JSON.parse(
      await readFile(getAssetReportPath(projectRoot, 'asset-drive-flat'), 'utf-8'),
    ) as {
      materializationPath?: string;
      fineScanMode?: string;
    };
    const profile = JSON.parse(
      await readFile(result.performanceProfilePath as string, 'utf-8'),
    ) as {
      ffmpeg: Record<string, any>;
    };

    expect(report.materializationPath).toBe('direct');
    expect(report.fineScanMode).toBeUndefined();
    expect(result.sliceCount).toBeGreaterThan(0);
    expect(detectShotsMock).not.toHaveBeenCalled();
    expect(profile.ffmpeg.sceneDetectCallCount).toBe(0);
  });

  it('runs deferred scene detect only after a full-mode decision', async () => {
    const workspaceRoot = await createWorkspace();
    const projectId = 'project-analyze-deferred-scene-detect';
    const projectRoot = await initWorkspaceProject(workspaceRoot, projectId, 'Deferred Scene Detect Project');
    const mediaRoot = join(projectRoot, '.tmp', 'fixtures');
    const mediaPath = join(mediaRoot, 'full-mode.mp4');

    await mkdir(mediaRoot, { recursive: true });
    await writeFile(mediaPath, 'fake-media');

    await writeJson(join(projectRoot, 'config/runtime.json'), {
      mlServerUrl: 'http://127.0.0.1:8910',
    });
    await writeJson(join(projectRoot, 'config/ingest-roots.json'), {
      roots: [{
        id: 'root-1',
        enabled: true,
        label: 'camera-a',
        path: mediaRoot,
      }],
    });
    await writeJson(join(projectRoot, 'store/assets.json'), [{
      id: 'asset-full',
      kind: 'video',
      sourcePath: 'full-mode.mp4',
      displayName: 'full-mode.mp4',
      ingestRootId: 'root-1',
      durationMs: 12_000,
      capturedAt: '2026-03-31T08:15:30.000Z',
      metadata: {
        hasAudioStream: false,
      },
    }]);

    detectShotsMock.mockResolvedValue([
      { timeMs: 3_000, score: 0.82 },
      { timeMs: 8_000, score: 0.91 },
    ]);
    extractKeyframesMock.mockImplementation(async (
      _filePath: string,
      outputDir: string,
      timestampsMs: number[],
    ) => {
      await mkdir(outputDir, { recursive: true });
      return Promise.all(timestampsMs.map(async timeMs => {
        const framePath = join(outputDir, `frame-${timeMs}.jpg`);
        await writeFile(framePath, `frame-${timeMs}`);
        return { timeMs, path: framePath };
      }));
    });

    vi.spyOn(MlClient.prototype, 'health').mockResolvedValue({
      status: 'ok',
      device: 'apple',
      backend: 'mlx',
      models_loaded: [],
    });
    vi.spyOn(MlClient.prototype, 'vlmAnalyze').mockImplementation(async (imagePaths, prompt) => {
      if (prompt.includes('semantic clip type and materialization policy')) {
        return {
          description: JSON.stringify({
            visual_summary: {
              scene_type: 'landscape',
              subjects: ['coast'],
              mood: 'calm',
              place_hints: ['cliff'],
              narrative_role: 'detail',
              description: `Recognized ${imagePaths.length} representative frames.`,
            },
            decision: {
              clip_type: 'broll',
              keep_decision: 'keep',
              materialization_path: 'fine-scan',
              fine_scan_mode: 'full',
              decision_reasons: ['test-full-mode-decision'],
            },
          }),
          timing: {
            backend: 'mlx',
            modelRef: 'test-qwen',
            totalMs: 61,
            processorMs: 9,
            generateMs: 45,
          },
        };
      }
      return {
        description: JSON.stringify({
          scene_type: 'landscape',
          subjects: ['coast'],
          mood: 'calm',
          place_hints: ['cliff'],
          narrative_role: 'detail',
          description: `Recognized ${imagePaths.length} representative frames.`,
        }),
        timing: {
          backend: 'mlx',
          modelRef: 'test-qwen',
          totalMs: 41,
          processorMs: 7,
          generateMs: 28,
        },
      };
    });

    const { analyzeWorkspaceProjectMedia } = await import('../../src/modules/media/project-analyze.js');
    const result = await analyzeWorkspaceProjectMedia({
      workspaceRoot,
      projectId,
      performanceProfile: {
        enabled: true,
        runLabel: 'deferred-scene-detect',
      },
    });

    const report = JSON.parse(
      await readFile(getAssetReportPath(projectRoot, 'asset-full'), 'utf-8'),
    ) as {
      fineScanMode: string;
    };
    const profile = JSON.parse(
      await readFile(result.performanceProfilePath as string, 'utf-8'),
    ) as {
      ffmpeg: Record<string, any>;
      assets: Array<Record<string, any>>;
    };

    expect(report.fineScanMode).toBe('full');
    expect(result.sliceCount).toBeGreaterThan(1);
    expect(detectShotsMock).toHaveBeenCalledTimes(1);
    expect(profile.ffmpeg.sceneDetectCallCount).toBe(1);
    expect(profile.ffmpeg.sceneDetectPhases?.prepare?.callCount).toBe(0);
    expect(profile.ffmpeg.sceneDetectPhases?.finalize?.callCount).toBe(1);
    expect(profile.ffmpeg.sceneDetectPhases?.['fine-scan']?.callCount).toBe(0);
    expect(profile.assets[0]?.sceneDetectPhases?.finalize?.callCount).toBe(1);
  });

  it('resumes from a frames-ready fine-scan checkpoint without re-extracting keyframes', async () => {
    const workspaceRoot = await createWorkspace();
    const projectId = 'project-analyze-fine-scan-resume';
    const projectRoot = await initWorkspaceProject(workspaceRoot, projectId, 'Fine Scan Resume Project');
    const mediaRoot = join(projectRoot, '.tmp', 'fixtures');
    const mediaPath = join(mediaRoot, 'resume.mp4');
    const fineScanDir = join(projectRoot, '.tmp', 'media-analyze', 'asset-resume', 'fine-scan');
    const readyFrames = [
      join(fineScanDir, 'kf_0.jpg'),
      join(fineScanDir, 'kf_1500.jpg'),
      join(fineScanDir, 'kf_2999.jpg'),
    ];

    await mkdir(mediaRoot, { recursive: true });
    await mkdir(fineScanDir, { recursive: true });
    await writeFile(mediaPath, 'fake-media');
    await Promise.all(readyFrames.map((framePath, index) => writeFile(framePath, `frame-${index}`)));

    await writeJson(join(projectRoot, 'config/runtime.json'), {
      mlServerUrl: 'http://127.0.0.1:8910',
    });
    await writeJson(join(projectRoot, 'config/ingest-roots.json'), {
      roots: [{
        id: 'root-1',
        enabled: true,
        label: 'camera-a',
        path: mediaRoot,
      }],
    });
    await writeJson(join(projectRoot, 'store/assets.json'), [{
      id: 'asset-resume',
      kind: 'video',
      sourcePath: 'resume.mp4',
      displayName: 'resume.mp4',
      ingestRootId: 'root-1',
      durationMs: 12_000,
      capturedAt: '2026-03-31T08:15:30.000Z',
      metadata: {
        hasAudioStream: false,
      },
    }]);
    await writeJson(getAssetReportPath(projectRoot, 'asset-resume'), {
      assetId: 'asset-resume',
      ingestRootId: 'root-1',
      durationMs: 12_000,
      clipTypeGuess: 'broll',
      densityScore: 0.4,
      summary: 'Existing resume summary.',
      labels: ['broll'],
      placeHints: [],
      rootNotes: [],
      sampleFrames: [{
        timeMs: 0,
        path: readyFrames[0],
      }],
      interestingWindows: [{
        startMs: 0,
        endMs: 3_000,
        reason: 'resume-window',
      }],
      keepDecision: 'keep',
      materializationPath: 'fine-scan',
      fineScanMode: 'windowed',
      fineScanReasons: ['resume-test'],
      createdAt: '2026-03-31T08:15:30.000Z',
      updatedAt: '2026-03-31T08:15:30.000Z',
    });
    await writePreparedAssetCheckpoint(projectRoot, {
      schemaVersion: 2,
      assetId: 'asset-resume',
      shotBoundaries: [],
      shotBoundariesResolved: false,
      sampleFrames: [{
        timeMs: 0,
        path: readyFrames[0],
      }],
      coarseSampleTimestamps: [0],
      hasAudioTrack: false,
      sourceContext: {
        ingestRootId: 'root-1',
        rootLabel: 'camera-a',
        rootDescription: 'Resume fixture root',
        rootNotes: [],
      },
    });
    await writeFineScanCheckpoint(projectRoot, {
      assetId: 'asset-resume',
      status: 'frames-ready',
      effectiveSlices: [{
        id: 'slice-resume',
        assetId: 'asset-resume',
        type: 'broll',
        sourceInMs: 0,
        sourceOutMs: 3_000,
        labels: ['broll'],
        placeHints: [],
      }],
      keyframePlans: [{
        shotId: 'slice-resume',
        startMs: 0,
        endMs: 3_000,
        timestampsMs: [0, 1500, 2999],
      }],
      timestampsMs: [0, 1500, 2999],
      expectedFramePaths: readyFrames,
      readyFrameCount: readyFrames.length,
      readyFrameBytes: 21,
      droppedInvalidSliceCount: 0,
    });

    vi.spyOn(MlClient.prototype, 'health').mockResolvedValue({
      status: 'ok',
      device: 'apple',
      backend: 'mlx',
      models_loaded: [],
    });
    vi.spyOn(MlClient.prototype, 'vlmAnalyze').mockResolvedValue({
      description: JSON.stringify({
        scene_type: 'landscape',
        subjects: ['lake'],
        mood: 'calm',
        place_hints: ['queenstown'],
        narrative_role: 'detail',
        description: 'Recovered fine-scan recognition from prefetched frames.',
      }),
      timing: {
        backend: 'mlx',
        modelRef: 'test-qwen',
        totalMs: 41,
        processorMs: 7,
        generateMs: 28,
      },
    });

    const { analyzeWorkspaceProjectMedia } = await import('../../src/modules/media/project-analyze.js');
    const result = await analyzeWorkspaceProjectMedia({
      workspaceRoot,
      projectId,
      performanceProfile: {
        enabled: true,
        runLabel: 'fine-scan-resume',
      },
    });

    const slices = JSON.parse(
      await readFile(getSlicesPath(projectRoot), 'utf-8'),
    ) as Array<{ assetId: string }>;

    expect(extractKeyframesMock).not.toHaveBeenCalled();
    expect(result.sliceCount).toBeGreaterThan(0);
    expect(slices.some(slice => slice.assetId === 'asset-resume')).toBe(true);
  });

  it('skips fine-scan resume when a pending report has no prepared checkpoint', async () => {
    const workspaceRoot = await createWorkspace();
    const projectId = 'project-analyze-fine-scan-skip-missing-prepared';
    const projectRoot = await initWorkspaceProject(workspaceRoot, projectId, 'Fine Scan Skip Missing Prepared');
    const mediaRoot = join(projectRoot, '.tmp', 'fixtures');
    const mediaPath = join(mediaRoot, 'skip.mp4');
    const preparedCheckpointPath = join(
      projectRoot,
      'analysis',
      'prepared-assets',
      'asset-skip.json',
    );

    await mkdir(mediaRoot, { recursive: true });
    await writeFile(mediaPath, 'fake-media');

    await writeJson(join(projectRoot, 'config/runtime.json'), {
      mlServerUrl: 'http://127.0.0.1:8910',
    });
    await writeJson(join(projectRoot, 'config/ingest-roots.json'), {
      roots: [{
        id: 'root-1',
        enabled: true,
        label: 'camera-a',
        path: mediaRoot,
      }],
    });
    await writeJson(join(projectRoot, 'store/assets.json'), [{
      id: 'asset-skip',
      kind: 'video',
      sourcePath: 'skip.mp4',
      displayName: 'skip.mp4',
      ingestRootId: 'root-1',
      durationMs: 8_000,
      capturedAt: '2026-03-31T08:15:30.000Z',
      metadata: {
        hasAudioStream: false,
      },
    }]);
    await writeJson(getAssetReportPath(projectRoot, 'asset-skip'), {
      assetId: 'asset-skip',
      ingestRootId: 'root-1',
      durationMs: 8_000,
      clipTypeGuess: 'broll',
      densityScore: 0.2,
      summary: 'Existing report without prepared checkpoint.',
      labels: ['broll'],
      placeHints: [],
      rootNotes: [],
      sampleFrames: [],
      interestingWindows: [{
        startMs: 0,
        endMs: 2_000,
        reason: 'skip-window',
      }],
      keepDecision: 'keep',
      materializationPath: 'fine-scan',
      fineScanMode: 'windowed',
      fineScanReasons: ['skip-missing-prepared'],
      createdAt: '2026-03-31T08:15:30.000Z',
      updatedAt: '2026-03-31T08:15:30.000Z',
    });

    vi.spyOn(MlClient.prototype, 'health').mockResolvedValue({
      status: 'ok',
      device: 'apple',
      backend: 'mlx',
      models_loaded: [],
    });

    const { analyzeWorkspaceProjectMedia } = await import('../../src/modules/media/project-analyze.js');
    const result = await analyzeWorkspaceProjectMedia({
      workspaceRoot,
      projectId,
      performanceProfile: {
        enabled: true,
        runLabel: 'fine-scan-skip-missing-prepared',
      },
    });

    expect(result.reportCount).toBe(0);
    expect(result.sliceCount).toBe(0);
    expect(result.fineScannedAssetIds).toEqual([]);
    expect(extractKeyframesMock).not.toHaveBeenCalled();
    await expect(access(preparedCheckpointPath)).rejects.toThrow();
  });
});
