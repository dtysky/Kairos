import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildAnalyzeMonitorModel } from '../../src/supervisor/monitor-model.js';
import { initWorkspaceProject, writeJson } from '../../src/store/index.js';

const workspaces: string[] = [];

afterEach(async () => {
  await Promise.all(
    workspaces.splice(0).map(path => rm(path, { recursive: true, force: true })),
  );
});

async function createWorkspace(): Promise<string> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'kairos-monitor-model-test-'));
  workspaces.push(workspaceRoot);
  return workspaceRoot;
}

describe('buildAnalyzeMonitorModel', () => {
  it('returns structured coarse/audio/fine-scan pipeline summaries', async () => {
    const workspaceRoot = await createWorkspace();
    const projectId = 'project-monitor-model';
    const projectRoot = await initWorkspaceProject(workspaceRoot, projectId, 'Monitor Model Project');
    const progressRoot = join(projectRoot, '.tmp', 'media-analyze');
    await mkdir(progressRoot, { recursive: true });
    await writeJson(join(progressRoot, 'progress.json'), {
      status: 'running',
      step: 'audio-analysis',
      stepLabel: '分析视频内音轨',
      current: 2,
      total: 4,
      detail: '正在执行并发音频分析',
      extra: {
        projectName: 'Monitor Model Project',
        activeAssetNames: ['clip-a.mp4', 'clip-b.mp4'],
        coarseTotal: 4,
        coarseCompletedCount: 3,
        coarsePendingCount: 1,
        coarseActiveCount: 1,
        coarseTargetConcurrency: 2,
        coarseCheckpointedCount: 3,
        audioTotal: 3,
        audioCompletedCount: 1,
        audioPendingCount: 2,
        audioActiveLocalCount: 1,
        audioTargetLocalConcurrency: 2,
        audioQueuedAsrCount: 1,
        audioActiveAsrCount: 1,
        audioTargetAsrConcurrency: 3,
        audioCheckpointedCount: 1,
        fineScanAssetTotal: 2,
        prefetchedAssetCount: 1,
        recognizedAssetCount: 1,
        readyAssetCount: 1,
        activePrefetchCount: 1,
        activeRecognitionCount: 1,
      },
    });

    const model = await buildAnalyzeMonitorModel(workspaceRoot, projectId);
    const pipelineKinds = (model.pipelines || []).map(item => item.kind);

    expect(pipelineKinds).toEqual(['coarse-scan', 'audio-analysis', 'fine-scan']);
    expect(model.pipelines?.find(item => item.kind === 'coarse-scan')).toMatchObject({
      total: 4,
      completed: 3,
      active: 1,
      targetConcurrency: 2,
    });
    expect(model.pipelines?.find(item => item.kind === 'audio-analysis')).toMatchObject({
      total: 3,
      completed: 1,
      activeLocal: 1,
      activeAsr: 1,
      targetAsrConcurrency: 3,
      activeAssetNames: ['clip-a.mp4', 'clip-b.mp4'],
    });
    expect(model.pipelines?.find(item => item.kind === 'fine-scan')).toMatchObject({
      total: 2,
      prefetched: 1,
      recognized: 1,
      activePrefetch: 1,
      activeRecognition: 1,
    });
  });
});
