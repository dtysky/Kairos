import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  initWorkspaceProject,
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
      groupKey: 'group-day',
      createdAt: '2026-04-19T10:05:00.000Z',
      stagingRoot: '/tmp/render',
      renderPreset: {
        container: 'mp4',
        videoCodec: 'h265',
        audioCodec: 'aac',
        bitrateMbps: 120,
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
      groupKey: 'group-day',
      createdAt: '2026-04-19T10:06:00.000Z',
      renderPreset: {
        container: 'mp4',
        videoCodec: 'h265',
        audioCodec: 'aac',
        bitrateMbps: 120,
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
      groupKey: 'group-day',
      validatedAt: '2026-04-19T10:07:00.000Z',
      status: 'pass',
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
      groupKey: 'group-day',
      promotedAt: '2026-04-19T10:08:00.000Z',
      status: 'completed',
      outputs: ['day/clip001.mp4'],
      deletedOutputs: [],
    });

    expect((await loadColorGroupsSnapshot(projectRoot, 'root-camera'))?.groups[0]?.groupKey).toBe('group-day');
    expect((await loadColorBatchPlan(projectRoot, 'batch-1'))?.entries[0]?.rawRelativePath).toBe('day/clip001.mov');
    expect((await loadColorBatchManifest(projectRoot, 'batch-1'))?.managedOutputSet).toEqual(['day/clip001.mp4']);
    expect((await loadColorBatchValidation(projectRoot, 'batch-1'))?.status).toBe('pass');
    expect((await loadColorBatchPromote(projectRoot, 'batch-1'))?.status).toBe('completed');
  });
});
