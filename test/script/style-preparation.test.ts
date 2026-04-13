import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getWorkspaceStyleAnalysisProgressPath,
  getWorkspaceStyleAnalysisSummaryPath,
  loadStyleSourcesConfig,
  saveStyleSourcesConfig,
} from '../../src/store/index.js';

const {
  probeMock,
  detectShotsMock,
  extractKeyframesMock,
  transcribeMock,
  recognizeShotGroupsMock,
} = vi.hoisted(() => ({
  probeMock: vi.fn(),
  detectShotsMock: vi.fn(),
  extractKeyframesMock: vi.fn(),
  transcribeMock: vi.fn(),
  recognizeShotGroupsMock: vi.fn(),
}));

vi.mock('../../src/modules/media/probe.js', () => ({
  probe: probeMock,
}));

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

vi.mock('../../src/modules/media/transcriber.js', () => ({
  transcribe: transcribeMock,
}));

vi.mock('../../src/modules/media/recognizer.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/modules/media/recognizer.js')>(
    '../../src/modules/media/recognizer.js',
  );
  return {
    ...actual,
    recognizeShotGroups: recognizeShotGroupsMock,
  };
});

vi.mock('../../src/modules/media/ml-client.js', () => ({
  MlClient: class FakeMlClient {
    async health() {
      return {
        status: 'ok',
        device: 'mps',
        backend: 'mlx',
        models_loaded: [],
      };
    }
  },
}));

import { prepareWorkspaceStyleAnalysisForAgent } from '../../src/modules/script/style-preparation.js';

const workspaces: string[] = [];

afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(workspaces.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function createWorkspace(): Promise<string> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'kairos-style-prep-test-'));
  workspaces.push(workspaceRoot);
  return workspaceRoot;
}

describe('prepareWorkspaceStyleAnalysisForAgent', () => {
  it('writes deterministic prep outputs and ends in awaiting_agent', async () => {
    const workspaceRoot = await createWorkspace();
    const sourcePath = join(workspaceRoot, 'reference.mp4');
    await writeFile(sourcePath, '', 'utf-8');

    await saveStyleSourcesConfig(workspaceRoot, {
      defaultCategory: 'road-vlog',
      categories: [{
        categoryId: 'road-vlog',
        displayName: 'Road Vlog',
        guidancePrompt: '重点关注开车 VLOG 的镜头节奏与叙述口吻。',
        overwriteExisting: false,
        profilePath: 'road-vlog.md',
        sources: [{
          id: 'source-1',
          type: 'file',
          path: sourcePath,
          note: '主参考视频',
        }],
      }],
    });

    probeMock.mockResolvedValue({
      durationMs: 12_000,
      width: 1920,
      height: 1080,
      fps: 30,
      codec: 'h264',
      hasAudioStream: true,
      audioStreamCount: 1,
      audioCodec: 'aac',
      audioSampleRate: 48_000,
      audioChannels: 2,
      audioBitRate: 192_000,
      creationTime: '2026-04-10T10:00:00.000Z',
      rawTags: {},
    });
    detectShotsMock.mockResolvedValue([
      { timeMs: 4_000, score: 0.9 },
      { timeMs: 8_000, score: 0.8 },
    ]);
    extractKeyframesMock.mockImplementation(async (_filePath, _outputDir, timestampsMs, _tools, options) => {
      const results = [];
      for (let index = 0; index < timestampsMs.length; index += 1) {
        results.push({
          timeMs: timestampsMs[index],
          path: `/tmp/kf_${timestampsMs[index]}.jpg`,
        });
        await options?.onProgress?.({
          plannedCount: timestampsMs.length,
          extractedCount: results.length,
          activeWorkers: Math.max(0, timestampsMs.length - results.length),
        });
      }
      return results;
    });
    transcribeMock.mockResolvedValue({
      segments: [
        { start: 0, end: 1.5, text: '今天从城里开到山顶。' },
        { start: 1.5, end: 3.0, text: '这段路很安静。' },
      ],
      fullText: '今天从城里开到山顶。 这段路很安静。',
      evidence: [],
    });
    recognizeShotGroupsMock.mockImplementation(async (_ml, groups, options) => {
      const results = [];
      for (const group of groups) {
        await options?.onProgress?.({
          totalGroups: groups.length,
          completedGroups: results.length,
          currentShotId: group.shotId,
          currentFrameCount: group.frames.length,
        });
        results.push({
          shotId: group.shotId,
          startMs: group.startMs,
          endMs: group.endMs,
          framePaths: group.frames.map(frame => frame.path),
          recognition: {
            sceneType: 'driving',
            subjects: ['road', 'dashboard'],
            mood: 'calm',
            placeHints: ['mountain road'],
            narrativeRole: 'establishing',
            description: '驾驶镜头建立路线和空间关系。',
            evidence: [],
            roundTripMs: 240,
            imageCount: group.frames.length,
          },
        });
        await options?.onProgress?.({
          totalGroups: groups.length,
          completedGroups: results.length,
          currentShotId: group.shotId,
          currentFrameCount: group.frames.length,
          lastRoundTripMs: 240,
        });
      }
      return results;
    });

    const result = await prepareWorkspaceStyleAnalysisForAgent({
      workspaceRoot,
      categoryId: 'road-vlog',
    });

    expect(result.status).toBe('awaiting_agent');
    expect(result.videoCount).toBe(1);
    expect(result.reportPaths).toHaveLength(1);
    expect(result.transcriptPaths).toHaveLength(1);

    const progress = JSON.parse(
      await readFile(getWorkspaceStyleAnalysisProgressPath(workspaceRoot, 'road-vlog'), 'utf-8'),
    ) as {
      status: string;
      stage: string;
      total: number;
      detail?: { summaryPath?: string };
      extra?: {
        stageMetrics?: {
          keyframes?: { plannedCount?: number; extractedCount?: number; outputDir?: string };
          vlm?: { totalGroups?: number; completedGroups?: number; lastRoundTripMs?: number };
        };
        queue?: {
          completedCount?: number;
          pendingCount?: number;
        };
      };
    };
    expect(progress.status).toBe('awaiting_agent');
    expect(progress.stage).toBe('complete');
    expect(progress.total).toBe(1);
    expect(progress.detail?.summaryPath).toBe(getWorkspaceStyleAnalysisSummaryPath(workspaceRoot, 'road-vlog'));
    expect(progress.extra?.stageMetrics?.keyframes?.plannedCount).toBeGreaterThan(0);
    expect(progress.extra?.stageMetrics?.keyframes?.extractedCount).toBeGreaterThan(0);
    expect(progress.extra?.stageMetrics?.vlm?.completedGroups).toBe(3);
    expect(progress.extra?.stageMetrics?.vlm?.lastRoundTripMs).toBe(240);
    expect(progress.extra?.queue?.completedCount).toBe(1);
    expect(progress.extra?.queue?.pendingCount).toBe(0);

    const summary = JSON.parse(
      await readFile(getWorkspaceStyleAnalysisSummaryPath(workspaceRoot, 'road-vlog'), 'utf-8'),
    ) as {
      categoryId: string;
      videoCount: number;
      agentInputReports: Array<{ transcript?: string }>;
    };
    expect(summary.categoryId).toBe('road-vlog');
    expect(summary.videoCount).toBe(1);
    expect(summary.agentInputReports[0]?.transcript).toContain('今天从城里开到山顶');

    const report = JSON.parse(await readFile(result.reportPaths[0]!, 'utf-8')) as {
      source: { path: string };
      clip: { rangeApplied: boolean };
      transcript: { fullText: string };
    };
    expect(report.source.path).toBe(sourcePath);
    expect(report.clip.rangeApplied).toBe(false);
    expect(report.transcript.fullText).toContain('这段路很安静');

    const styleSources = await loadStyleSourcesConfig(workspaceRoot);
    expect(styleSources.categories[0]?.profilePath).toBe('road-vlog.md');
  });
});
