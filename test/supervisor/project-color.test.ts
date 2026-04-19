import { afterEach, describe, expect, it, vi } from 'vitest';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as mediaProbe from '../../src/modules/media/probe.js';
import * as captureTime from '../../src/modules/media/capture-time.js';
import {
  ColorPrepBlockedError,
  ProjectColorBlockedError,
  executeProjectColorGroup,
  prepareProjectColorRoot,
  promoteProjectColorBatch,
  syncProjectColorGroups,
  validateProjectColorBatch,
} from '../../src/modules/color/project-color.js';
import type { IColorExecutor } from '../../src/modules/color/resolve-executor.js';
import {
  getProjectProgressPath,
  initWorkspaceProject,
  loadColorBatchManifest,
  loadColorBatchPlan,
  loadColorBatchPromote,
  loadColorBatchValidation,
  loadColorCurrent,
  loadColorGroupsSnapshot,
  saveIngestRoots,
  saveProjectDeviceMap,
} from '../../src/store/index.js';

const workspaces: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    workspaces.splice(0).map(path => rm(path, { recursive: true, force: true })),
  );
});

async function createWorkspace(): Promise<string> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'kairos-project-color-test-'));
  workspaces.push(workspaceRoot);
  return workspaceRoot;
}

function createFakeExecutor(): IColorExecutor {
  return {
    async prepareRoot(input) {
      return {
        resolveProjectName: input.resolveProjectName,
        gradingTimelineName: input.gradingTimelineName,
        mirrorStatus: 'synced',
        timelineStatus: 'ready',
        hostSummary: {
          rootNamespace: input.rootNamespace,
        },
      };
    },
    async syncGroups(input) {
      return {
        rootId: input.rootId,
        syncedAt: '2026-04-19T10:00:00.000Z',
        timelineName: input.gradingTimelineName,
        groups: [{
          groupKey: 'group-day',
          displayName: 'Day Group',
          clipKeys: ['day/clip001.mov'],
          hostSummary: {
            source: 'fake-resolve',
          },
        }],
      };
    },
    async executeGroup(input) {
      const outputPath = join(input.stagingRoot, 'clip001.mp4');
      await writeFile(outputPath, 'rendered', 'utf-8');
      return {
        renderedAt: '2026-04-19T10:05:00.000Z',
        entries: [{
          rawRelativePath: 'day/clip001.mov',
          outputPath,
          normalizedOutputFilename: 'clip001.mp4',
        }],
      };
    },
  };
}

function mockColorMetadata() {
  vi.spyOn(mediaProbe, 'probe').mockImplementation(async filePath => ({
    durationMs: 1000,
    width: 3840,
    height: 2160,
    fps: 30,
    codec: filePath.endsWith('.mp4') ? 'h265' : 'prores',
    hasAudioStream: true,
    audioStreamCount: 1,
    audioCodec: 'aac',
    audioSampleRate: 48000,
    audioChannels: 2,
    audioBitRate: 192000,
    creationTime: '2026-02-01T10:00:00.000Z',
    rawTags: {
      createdate: '2026:02:01 10:00:00',
      gpslatitude: '40.1',
      gpslongitude: '120.2',
    },
  }));
  vi.spyOn(captureTime, 'resolveCaptureTime').mockResolvedValue({
    capturedAt: '2026-02-01T10:00:00.000Z',
    source: 'exif',
    confidence: 1,
  });
}

describe('project color actions', () => {
  it('runs prepare -> sync -> execute -> validate -> promote and persists runtime/archive truth', async () => {
    const workspaceRoot = await createWorkspace();
    const projectId = 'project-color-closure';
    const projectRoot = await initWorkspaceProject(workspaceRoot, projectId, 'Project Color Closure');
    const rawLocalPath = join(projectRoot, '.fixtures', 'raw-camera');
    const currentLocalPath = join(projectRoot, '.fixtures', 'current-camera');
    const rawClipPath = join(rawLocalPath, 'day', 'clip001.mov');
    await writeFile(join(projectRoot, 'config', 'runtime.json'), JSON.stringify({
      resolveColorPythonPath: '/usr/bin/python3',
    }, null, 2));
    await mkdir(join(rawLocalPath, 'day'), { recursive: true });
    await writeFile(rawClipPath, 'raw', 'utf-8');

    await saveIngestRoots(projectRoot, {
      roots: [{
        id: 'root-camera',
        path: '/media/current/camera',
        rawPath: '/media/raw/camera',
        enabled: true,
        color: {
          renderPreset: {
            container: 'mp4',
            videoCodec: 'h265',
            audioCodec: 'aac',
            bitrateMbps: 120,
          },
        },
      }],
    });
    await saveProjectDeviceMap(projectRoot, projectId, {
      roots: [{
        rootId: 'root-camera',
        localPath: currentLocalPath,
        rawLocalPath,
      }],
    });

    mockColorMetadata();
    const executor = createFakeExecutor();

    await prepareProjectColorRoot({
      workspaceRoot,
      projectId,
      rootId: 'root-camera',
      jobId: 'job-color-prepare',
      executor,
    });
    await syncProjectColorGroups({
      workspaceRoot,
      projectId,
      rootId: 'root-camera',
      action: 'sync_groups',
      jobId: 'job-color-sync',
      executor,
    });
    const executeResult = await executeProjectColorGroup({
      workspaceRoot,
      projectId,
      rootId: 'root-camera',
      action: 'execute_group',
      groupKey: 'group-day',
      jobId: 'job-color-execute',
      executor,
    });
    expect(executeResult.batchId).toBeTruthy();

    await validateProjectColorBatch({
      workspaceRoot,
      projectId,
      rootId: 'root-camera',
      action: 'validate_batch',
      batchId: executeResult.batchId,
      jobId: 'job-color-validate',
    });
    await promoteProjectColorBatch({
      workspaceRoot,
      projectId,
      rootId: 'root-camera',
      action: 'promote_batch',
      batchId: executeResult.batchId,
      jobId: 'job-color-promote',
    });

    const [groupsSnapshot, plan, manifest, validation, promote, current] = await Promise.all([
      loadColorGroupsSnapshot(projectRoot, 'root-camera'),
      loadColorBatchPlan(projectRoot, executeResult.batchId!),
      loadColorBatchManifest(projectRoot, executeResult.batchId!),
      loadColorBatchValidation(projectRoot, executeResult.batchId!),
      loadColorBatchPromote(projectRoot, executeResult.batchId!),
      loadColorCurrent(projectRoot),
    ]);

    expect(groupsSnapshot?.groups[0]?.groupKey).toBe('group-day');
    expect(plan?.entries[0]?.rawRelativePath).toBe('day/clip001.mov');
    expect(manifest?.managedOutputSet).toEqual(['day/clip001.mp4']);
    expect(validation?.status).toBe('pass');
    expect(promote?.status).toBe('completed');
    expect(current.roots[0]?.groups[0]?.status).toBe('promoted');
    expect(current.roots[0]?.groups[0]?.lastPromotedBatchId).toBe(executeResult.batchId);
    await expect(access(join(currentLocalPath, 'day', 'clip001.mp4'))).resolves.toBeUndefined();

    const promotedContent = await readFile(join(currentLocalPath, 'day', 'clip001.mp4'), 'utf-8');
    expect(promotedContent).toBe('rendered');

    const progress = JSON.parse(
      await readFile(getProjectProgressPath(projectRoot, 'color'), 'utf-8'),
    ) as { status: string; detail: string };
    expect(progress.status).toBe('succeeded');
    expect(progress.detail).toContain('promote');
  });

  it('blocks prepare_root when rawLocalPath is missing', async () => {
    const workspaceRoot = await createWorkspace();
    const projectId = 'project-color-blocked';
    const projectRoot = await initWorkspaceProject(workspaceRoot, projectId, 'Project Color Blocked');

    await writeFile(join(projectRoot, 'config', 'runtime.json'), JSON.stringify({
      resolveColorPythonPath: '/usr/bin/python3',
    }, null, 2));
    await saveIngestRoots(projectRoot, {
      roots: [{
        id: 'root-camera',
        path: '/media/current/camera',
        rawPath: '/media/raw/camera',
        enabled: true,
      }],
    });
    await saveProjectDeviceMap(projectRoot, projectId, {
      roots: [{
        rootId: 'root-camera',
        localPath: 'F:\\current\\camera',
      }],
    });

    await expect(prepareProjectColorRoot({
      workspaceRoot,
      projectId,
      rootId: 'root-camera',
      jobId: 'job-color-blocked',
      executor: createFakeExecutor(),
    })).rejects.toBeInstanceOf(ColorPrepBlockedError);

    const savedCurrent = await loadColorCurrent(projectRoot);
    expect(savedCurrent.roots[0]?.mirrorStatus).toBe('blocked');
    expect(savedCurrent.roots[0]?.detail).toContain('rawLocalPath');
  });

  it('rejects promote when the batch has been superseded by a newer latest batch', async () => {
    const workspaceRoot = await createWorkspace();
    const projectId = 'project-color-superseded';
    const projectRoot = await initWorkspaceProject(workspaceRoot, projectId, 'Project Color Superseded');
    const rawLocalPath = join(projectRoot, '.fixtures', 'raw-camera');
    const currentLocalPath = join(projectRoot, '.fixtures', 'current-camera');
    const rawClipPath = join(rawLocalPath, 'day', 'clip001.mov');
    await writeFile(join(projectRoot, 'config', 'runtime.json'), JSON.stringify({
      resolveColorPythonPath: '/usr/bin/python3',
    }, null, 2));
    await mkdir(join(rawLocalPath, 'day'), { recursive: true });
    await writeFile(rawClipPath, 'raw', 'utf-8');

    await saveIngestRoots(projectRoot, {
      roots: [{
        id: 'root-camera',
        path: '/media/current/camera',
        rawPath: '/media/raw/camera',
        enabled: true,
        color: {
          renderPreset: {
            container: 'mp4',
            videoCodec: 'h265',
            audioCodec: 'aac',
            bitrateMbps: 120,
          },
        },
      }],
    });
    await saveProjectDeviceMap(projectRoot, projectId, {
      roots: [{
        rootId: 'root-camera',
        localPath: currentLocalPath,
        rawLocalPath,
      }],
    });

    mockColorMetadata();
    const executor = createFakeExecutor();

    await prepareProjectColorRoot({ workspaceRoot, projectId, rootId: 'root-camera', executor });
    await syncProjectColorGroups({ workspaceRoot, projectId, rootId: 'root-camera', action: 'sync_groups', executor });
    const batch1 = await executeProjectColorGroup({
      workspaceRoot,
      projectId,
      rootId: 'root-camera',
      action: 'execute_group',
      groupKey: 'group-day',
      executor,
    });
    await validateProjectColorBatch({
      workspaceRoot,
      projectId,
      rootId: 'root-camera',
      action: 'validate_batch',
      batchId: batch1.batchId,
    });
    const batch2 = await executeProjectColorGroup({
      workspaceRoot,
      projectId,
      rootId: 'root-camera',
      action: 'execute_group',
      groupKey: 'group-day',
      executor,
    });
    expect(batch2.batchId).not.toBe(batch1.batchId);

    await expect(promoteProjectColorBatch({
      workspaceRoot,
      projectId,
      rootId: 'root-camera',
      action: 'promote_batch',
      batchId: batch1.batchId,
    })).rejects.toBeInstanceOf(ProjectColorBlockedError);
  });
});
