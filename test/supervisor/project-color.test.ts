import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ColorPrepBlockedError, prepareProjectColorRoot } from '../../src/modules/color/project-color.js';
import {
  getProjectProgressPath,
  initWorkspaceProject,
  loadColorCurrent,
  loadIngestRoots,
  saveIngestRoots,
  saveProjectDeviceMap,
} from '../../src/store/index.js';

const workspaces: string[] = [];

afterEach(async () => {
  await Promise.all(
    workspaces.splice(0).map(path => rm(path, { recursive: true, force: true })),
  );
});

async function createWorkspace(): Promise<string> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'kairos-project-color-test-'));
  workspaces.push(workspaceRoot);
  return workspaceRoot;
}

describe('prepareProjectColorRoot', () => {
  it('persists deterministic prep status and keeps root renderPreset on project roots', async () => {
    const workspaceRoot = await createWorkspace();
    const projectId = 'project-color-prep';
    const projectRoot = await initWorkspaceProject(workspaceRoot, projectId, 'Project Color Prep');

    await saveIngestRoots(projectRoot, {
      roots: [{
        id: 'root-camera',
        path: '/media/current/camera',
        rawPath: '/media/raw/camera',
        label: '主机位',
        description: 'Sony 主机位',
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
        localPath: 'F:\\current\\camera',
        rawLocalPath: 'F:\\raw\\camera',
      }],
    });

    const result = await prepareProjectColorRoot({
      workspaceRoot,
      projectId,
      rootId: 'root-camera',
      jobId: 'job-color-root-camera',
    });

    expect(result.mirrorStatus).toBe('ready');
    expect(result.timelineStatus).toBe('ready');
    expect(result.resolveProjectName).toBe('kairos__project-color-prep');
    expect(result.gradingTimelineName).toBe('root__root-camera__grading');

    const savedRoots = await loadIngestRoots(projectRoot);
    expect(savedRoots.roots[0]?.id).toBe('root-camera');
    expect(savedRoots.roots[0]?.color?.renderPreset?.bitrateMbps).toBe(120);

    const savedCurrent = await loadColorCurrent(projectRoot);
    expect(savedCurrent.selectedRootId).toBe('root-camera');
    expect(savedCurrent.roots[0]?.mirrorStatus).toBe('ready');
    expect(savedCurrent.roots[0]?.timelineStatus).toBe('ready');
    expect(savedCurrent.roots[0]?.detail).toContain('deterministic prep');
    expect(savedCurrent.roots[0]?.currentJobId).toBeUndefined();

    const progress = JSON.parse(
      await readFile(getProjectProgressPath(projectRoot, 'color'), 'utf-8'),
    ) as { status: string; step: string; detail: string; extra?: { rootId?: string } };
    expect(progress.status).toBe('succeeded');
    expect(progress.step).toBe('prepare_root_timeline');
    expect(progress.extra?.rootId).toBe('root-camera');
  });

  it('writes blocked current/progress when rawLocalPath is missing', async () => {
    const workspaceRoot = await createWorkspace();
    const projectId = 'project-color-blocked';
    const projectRoot = await initWorkspaceProject(workspaceRoot, projectId, 'Project Color Blocked');

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
    })).rejects.toBeInstanceOf(ColorPrepBlockedError);

    const savedCurrent = await loadColorCurrent(projectRoot);
    expect(savedCurrent.roots[0]?.mirrorStatus).toBe('blocked');
    expect(savedCurrent.roots[0]?.timelineStatus).toBe('blocked');
    expect(savedCurrent.roots[0]?.detail).toContain('rawLocalPath');

    const progress = JSON.parse(
      await readFile(getProjectProgressPath(projectRoot, 'color'), 'utf-8'),
    ) as { status: string; step: string; detail: string };
    expect(progress.status).toBe('failed');
    expect(progress.step).toBe('sync_root_bins');
    expect(progress.detail).toContain('rawLocalPath');
  });
});
