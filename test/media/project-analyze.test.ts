import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getAnalyzePerformanceProfilePath } from '../../src/modules/media/analyze-profile.js';
import {
  analyzeWorkspaceProjectMedia,
  resolveDynamicStageTargetConcurrency,
  resolveFineScanPrefetchTargetConcurrency,
} from '../../src/modules/media/project-analyze.js';
import {
  getProjectProgressPath,
  initWorkspaceProject,
  writeJson,
} from '../../src/store/index.js';

const workspaces: string[] = [];

afterEach(async () => {
  await Promise.all(
    workspaces.splice(0).map(path => rm(path, { recursive: true, force: true })),
  );
});

async function createWorkspace(): Promise<string> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'kairos-analyze-test-'));
  workspaces.push(workspaceRoot);
  return workspaceRoot;
}

describe('analyzeWorkspaceProjectMedia', () => {
  it('pauses fine-scan prefetch when ready caches exceed configured limits', () => {
    expect(resolveFineScanPrefetchTargetConcurrency({
      limits: {
        baseConcurrency: 1,
        maxConcurrency: 3,
        minFreeMemoryMb: 2048,
        maxReadyAssets: 2,
        maxReadyFrameMb: 128,
      },
      freeMemoryMb: 8192,
      readyAssetCount: 2,
      readyFrameBytes: 32 * 1024 * 1024,
      hasFramesReady: true,
      hasActivePrefetch: false,
      hasPendingPrefetch: true,
    })).toBe(0);

    expect(resolveFineScanPrefetchTargetConcurrency({
      limits: {
        baseConcurrency: 1,
        maxConcurrency: 3,
        minFreeMemoryMb: 2048,
        maxReadyAssets: 4,
        maxReadyFrameMb: 128,
      },
      freeMemoryMb: 8192,
      readyAssetCount: 1,
      readyFrameBytes: 256 * 1024 * 1024,
      hasFramesReady: true,
      hasActivePrefetch: false,
      hasPendingPrefetch: true,
    })).toBe(0);
  });

  it('keeps at least one dynamic worker alive when memory is low and work is pending', () => {
    expect(resolveDynamicStageTargetConcurrency({
      limits: {
        baseConcurrency: 1,
        maxConcurrency: 3,
        minFreeMemoryMb: 4096,
      },
      freeMemoryMb: 1024,
      hasActiveWorkers: false,
      hasPendingWork: true,
    })).toBe(1);

    expect(resolveDynamicStageTargetConcurrency({
      limits: {
        baseConcurrency: 1,
        maxConcurrency: 3,
        minFreeMemoryMb: 4096,
      },
      freeMemoryMb: 1024,
      hasActiveWorkers: true,
      hasPendingWork: true,
    })).toBe(0);

    expect(resolveDynamicStageTargetConcurrency({
      limits: {
        baseConcurrency: 1,
        maxConcurrency: 3,
        minFreeMemoryMb: 4096,
      },
      freeMemoryMb: 9000,
      hasActiveWorkers: false,
      hasPendingWork: true,
    })).toBe(3);
  });

  it('fails immediately when ML server is unavailable', async () => {
    const workspaceRoot = await createWorkspace();
    const projectId = 'project-analyze-ml-unavailable';
    const projectRoot = await initWorkspaceProject(workspaceRoot, projectId, 'Test Project');
    const progressPath = getProjectProgressPath(projectRoot, 'media-analyze');

    await writeJson(join(projectRoot, 'config/runtime.json'), {
      mlServerUrl: 'http://127.0.0.1:1',
    });
    await writeJson(join(projectRoot, 'config/ingest-roots.json'), {
      roots: [{
        id: 'root-1',
        enabled: true,
        label: 'camera-a',
      }],
    });
    await writeJson(join(projectRoot, 'store/assets.json'), [{
      id: 'asset-1',
      kind: 'video',
      sourcePath: 'clip.mp4',
      displayName: 'clip.mp4',
      ingestRootId: 'root-1',
      durationMs: 1_000,
      capturedAt: '2026-03-31T08:15:30.000Z',
    }]);

    await expect(analyzeWorkspaceProjectMedia({
      workspaceRoot,
      projectId,
      progressPath,
      performanceProfile: {
        enabled: true,
        runLabel: 'ml-unavailable',
      },
    })).rejects.toThrow(/ML server 不可用/u);

    const progress = JSON.parse(await readFile(progressPath, 'utf-8')) as {
      status: string;
      detail?: string;
    };
    expect(progress.status).toBe('failed');
    expect(progress.detail).toMatch(/ML server 不可用/u);

    const profile = JSON.parse(
      await readFile(getAnalyzePerformanceProfilePath(projectRoot), 'utf-8'),
    ) as {
      status: string;
      failureMessage?: string;
      analyzedAssetCount: number;
    };
    expect(profile.status).toBe('failed');
    expect(profile.failureMessage).toMatch(/ML server 不可用/u);
    expect(profile.analyzedAssetCount).toBe(0);
  });

  it('blocks analyze when project timeline still has unresolved capture-time conflicts', async () => {
    const workspaceRoot = await createWorkspace();
    const projectId = 'project-analyze-timeline-block';
    const projectRoot = await initWorkspaceProject(workspaceRoot, projectId, 'Test Project');
    const progressPath = getProjectProgressPath(projectRoot, 'media-analyze');

    await writeJson(join(projectRoot, 'config/runtime.json'), {
      mlServerUrl: 'http://127.0.0.1:1',
    });
    await writeFile(
      join(projectRoot, 'config/manual-itinerary.md'),
      '2026.02.17，上午10点，在新西兰皇后镇拍摄\n',
      'utf-8',
    );
    await writeJson(join(projectRoot, 'config/ingest-roots.json'), {
      roots: [{
        id: 'root-1',
        enabled: true,
        label: 'camera-a',
      }],
    });
    await writeJson(join(projectRoot, 'store/assets.json'), [{
      id: 'asset-1',
      kind: 'video',
      sourcePath: '20260331_081530.mp4',
      displayName: '20260331_081530.mp4',
      ingestRootId: 'root-1',
      durationMs: 1_000,
      capturedAt: '2026-03-31T08:15:30.000Z',
      captureTimeSource: 'filename',
    }]);

    await expect(analyzeWorkspaceProjectMedia({
      workspaceRoot,
      projectId,
      progressPath,
    })).rejects.toThrow(/拍摄时间与项目时间线明显不一致/u);

    const progress = JSON.parse(await readFile(progressPath, 'utf-8')) as {
      status: string;
      detail?: string;
    };
    expect(progress.status).toBe('failed');
    expect(progress.detail).toMatch(/拍摄时间与项目时间线明显不一致/u);

    const manualItinerary = await readFile(
      join(projectRoot, 'config/manual-itinerary.md'),
      'utf-8',
    );
    expect(manualItinerary).toContain('## 素材时间校正');
    expect(manualItinerary).toContain('20260331_081530.mp4');
  });
});
