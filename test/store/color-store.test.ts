import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  initWorkspaceProject,
  loadColorArchiveViews,
  loadColorBatchArchiveItem,
  loadColorBatchManifest,
  loadColorBatchPlan,
  loadColorBatchPromote,
  loadColorBatchValidation,
  loadColorGroupsSnapshot,
  saveColorBatchManifest,
  saveColorBatchPlan,
  saveColorBatchPromote,
  saveColorBatchValidation,
  saveColorGroupsSnapshot,
} from '../../src/store/index.js';

const workspaces: string[] = [];

afterEach(async () => {
  await Promise.all(
    workspaces.splice(0).map(path => rm(path, { recursive: true, force: true })),
  );
});

async function createProjectRoot() {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'kairos-color-store-'));
  workspaces.push(workspaceRoot);
  return initWorkspaceProject(workspaceRoot, 'project-color-store', 'Project Color Store');
}

describe('color store', () => {
  it('roundtrips group snapshot and batch archive files', async () => {
    const projectRoot = await createProjectRoot();

    await saveColorGroupsSnapshot(projectRoot, {
      rootId: 'root-camera',
      syncedAt: '2026-04-19T10:00:00.000Z',
      timelineName: 'root__root-camera__grading',
      groups: [{
        groupKey: 'group-day',
        displayName: 'Day Group',
        clipKeys: ['day/clip001.mov'],
        hostSummary: {
          source: 'test',
        },
      }],
    });
    await saveColorBatchPlan(projectRoot, {
      batchId: 'batch-1',
      rootId: 'root-camera',
      createdAt: '2026-04-19T10:05:00.000Z',
      stagingRoot: '/tmp/render',
      renderPreset: {
        container: 'mp4',
        videoCodec: 'h265',
        audioCodec: 'aac',
        bitrateKbps: 120,
      },
      clipKeys: ['day/clip001.mov'],
      entries: [{
        rawRelativePath: 'day/clip001.mov',
        sourceAbsolutePath: '/tmp/raw/day/clip001.mov',
      }],
    });
    await saveColorBatchManifest(projectRoot, {
      batchId: 'batch-1',
      rootId: 'root-camera',
      createdAt: '2026-04-19T10:06:00.000Z',
      renderPreset: {
        container: 'mp4',
        videoCodec: 'h265',
        audioCodec: 'aac',
        bitrateKbps: 120,
      },
      managedOutputSet: ['day/clip001.mp4'],
      entries: [{
        rawRelativePath: 'day/clip001.mov',
        stagingRelativePath: 'clip001.mp4',
        stagingAbsolutePath: '/tmp/render/clip001.mp4',
        promoteRelativePath: 'day/clip001.mp4',
        promoteTargetPath: '/tmp/current/day/clip001.mp4',
        normalizedOutputFilename: 'clip001.mp4',
      }],
    });
    await saveColorBatchValidation(projectRoot, {
      batchId: 'batch-1',
      rootId: 'root-camera',
      validatedAt: '2026-04-19T10:07:00.000Z',
      status: 'pass',
      summary: {
        targetCount: 1,
        renderedCount: 1,
        passedCount: 1,
        failedCount: 0,
      },
      blockingReasons: [],
      entries: [{
        rawRelativePath: 'day/clip001.mov',
        status: 'pass',
        reasons: [],
        checks: {
          pathMirror: 'pass',
          filenameNormalized: 'pass',
          mediaKind: 'pass',
          resolution: 'pass',
          fps: 'pass',
          duration: 'pass',
          capturedAt: 'pass',
          createTime: 'pass',
          gps: 'pass',
          filesystemCreateTime: 'pass',
        },
      }],
    });
    await saveColorBatchPromote(projectRoot, {
      batchId: 'batch-1',
      rootId: 'root-camera',
      promotedAt: '2026-04-19T10:08:00.000Z',
      status: 'completed',
      outputs: ['day/clip001.mp4'],
      deletedOutputs: [],
    });

    expect((await loadColorGroupsSnapshot(projectRoot, 'root-camera'))?.groups[0]?.groupKey).toBe('group-day');
    expect((await loadColorBatchPlan(projectRoot, 'batch-1'))?.entries[0]?.rawRelativePath).toBe('day/clip001.mov');
    expect((await loadColorBatchManifest(projectRoot, 'batch-1'))?.managedOutputSet).toEqual(['day/clip001.mp4']);
    expect((await loadColorBatchValidation(projectRoot, 'batch-1'))?.status).toBe('pass');
    expect((await loadColorBatchValidation(projectRoot, 'batch-1'))?.summary.passedCount).toBe(1);
    expect((await loadColorBatchPromote(projectRoot, 'batch-1'))?.status).toBe('completed');
    expect((await loadColorBatchArchiveItem(projectRoot, 'batch-1'))?.plan?.rootId).toBe('root-camera');
  });

  it('aggregates archive views by root with stable sorting', async () => {
    const projectRoot = await createProjectRoot();

    await saveColorBatchPlan(projectRoot, {
      batchId: 'batch-new',
      rootId: 'root-camera',
      createdAt: '2026-04-19T10:05:00.000Z',
      stagingRoot: '/tmp/render-new',
      renderPreset: {
        container: 'mp4',
        videoCodec: 'h265',
        audioCodec: 'aac',
        bitrateKbps: 120,
      },
      clipKeys: ['day/clip002.mov'],
      entries: [{
        rawRelativePath: 'day/clip002.mov',
        sourceAbsolutePath: '/tmp/raw/day/clip002.mov',
      }],
    });
    await saveColorBatchValidation(projectRoot, {
      batchId: 'batch-new',
      rootId: 'root-camera',
      validatedAt: '2026-04-19T10:07:00.000Z',
      status: 'fail',
      summary: {
        targetCount: 1,
        renderedCount: 1,
        passedCount: 0,
        failedCount: 1,
      },
      blockingReasons: ['duration mismatch'],
      entries: [{
        rawRelativePath: 'day/clip002.mov',
        status: 'fail',
        reasons: ['duration mismatch'],
        checks: {
          pathMirror: 'pass',
          filenameNormalized: 'pass',
          mediaKind: 'pass',
          resolution: 'pass',
          fps: 'pass',
          duration: 'fail',
          capturedAt: 'pass',
          createTime: 'pass',
          gps: 'pass',
          filesystemCreateTime: 'pass',
        },
      }],
    });
    await saveColorBatchPlan(projectRoot, {
      batchId: 'batch-old',
      rootId: 'root-camera',
      createdAt: '2026-04-18T10:05:00.000Z',
      stagingRoot: '/tmp/render-old',
      renderPreset: {
        container: 'mov',
        videoCodec: 'prores',
        audioCodec: 'pcm',
        bitrateKbps: 240,
      },
      clipKeys: ['night/clip001.mov'],
      entries: [{
        rawRelativePath: 'night/clip001.mov',
        sourceAbsolutePath: '/tmp/raw/night/clip001.mov',
      }],
    });
    await saveColorBatchPromote(projectRoot, {
      batchId: 'batch-old',
      rootId: 'root-camera',
      promotedAt: '2026-04-19T11:00:00.000Z',
      status: 'completed',
      outputs: ['night/clip001.mov'],
      deletedOutputs: ['night/clip000.mov'],
    });

    const archiveViews = await loadColorArchiveViews(projectRoot);
    expect(archiveViews['root-camera']?.recentBatches.map(item => item.batchId)).toEqual(['batch-new', 'batch-old']);
    expect(archiveViews['root-camera']?.validationFailures.map(item => item.batchId)).toEqual(['batch-new']);
    expect(archiveViews['root-camera']?.promoteHistory.map(item => item.batchId)).toEqual(['batch-old']);
  });
});
