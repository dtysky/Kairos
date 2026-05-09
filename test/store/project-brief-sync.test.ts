import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  initWorkspaceProject,
  loadIngestRoots,
  syncWorkspaceProjectBrief,
  writeJson,
  writeWorkspaceProjectBrief,
} from '../../src/store/index.js';

const workspaces: string[] = [];

afterEach(async () => {
  await Promise.all(
    workspaces.splice(0).map(path => rm(path, { recursive: true, force: true })),
  );
});

async function createWorkspace(): Promise<string> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'kairos-project-brief-test-'));
  workspaces.push(workspaceRoot);
  return workspaceRoot;
}

describe('syncWorkspaceProjectBrief', () => {
  it('writes ingest roots from project brief mappings and removes legacy device maps', async () => {
    const workspaceRoot = await createWorkspace();
    const projectId = 'project-a';
    const projectRoot = await initWorkspaceProject(workspaceRoot, projectId, 'Test Project');

    const cameraRoot = join(workspaceRoot, 'media', 'camera');
    const cameraRawRoot = join(cameraRoot, 'raw');
    const droneRoot = join(workspaceRoot, 'media', 'drone');
    await writeJson(join(projectRoot, 'config/device-media-maps.local.json'), {
      projects: {
        [projectId]: {
          projectId,
          roots: [{ rootId: 'old-root', localPath: '/old/path' }],
        },
      },
    });
    await writeWorkspaceProjectBrief(workspaceRoot, projectId, [
      {
        path: cameraRoot,
        rawPath: cameraRawRoot,
        alternatePaths: [{
          path: join(workspaceRoot, 'media-alt', 'camera'),
          rawPath: join(workspaceRoot, 'media-alt', 'camera-raw'),
        }],
        description: '主机位',
      },
      { path: droneRoot, description: '无人机', flightRecordPath: './FlightRecord' },
    ]);
    const briefContent = await readFile(join(projectRoot, 'config/project-brief.md'), 'utf-8');

    const result = await syncWorkspaceProjectBrief(workspaceRoot, projectId);

    expect(result.warnings).toEqual([]);
    expect(briefContent).not.toContain('路径：\n说明：\n\n路径：\n说明：');
    expect(briefContent.match(/^路径：/gm)).toHaveLength(2);
    expect(result.ingestRoots).toHaveLength(2);
    expect(result.ingestRoots[0]).toMatchObject({
      enabled: true,
      description: '主机位',
      priority: 1,
      rawPath: cameraRawRoot,
      alternatePaths: [{
        path: join(workspaceRoot, 'media-alt', 'camera'),
        rawPath: join(workspaceRoot, 'media-alt', 'camera-raw'),
      }],
    });

    const ingestRoots = await loadIngestRoots(projectRoot);
    expect(ingestRoots.roots).toHaveLength(2);

    await expect(readFile(join(projectRoot, 'config/device-media-maps.local.json'), 'utf-8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps existing mappings when project brief has no configured paths', async () => {
    const workspaceRoot = await createWorkspace();
    const projectId = 'project-b';
    const projectRoot = await initWorkspaceProject(workspaceRoot, projectId, 'Test Project');

    await writeJson(join(projectRoot, 'config/ingest-roots.json'), {
      roots: [{
        id: 'root-1',
        enabled: true,
        label: 'camera',
        description: '已有素材目录',
        priority: 9,
      }],
    });
    await writeJson(join(projectRoot, 'config/device-media-maps.local.json'), {
      projects: {
        [projectId]: {
          projectId,
          roots: [{
            rootId: 'root-1',
            localPath: join(workspaceRoot, 'media-root'),
          }],
        },
      },
    });

    const result = await syncWorkspaceProjectBrief(workspaceRoot, projectId);

    expect(result.ingestRoots).toEqual([
      {
        id: 'root-1',
        enabled: true,
        label: 'camera',
        description: '已有素材目录',
        priority: 9,
      },
    ]);

    await expect(readFile(join(projectRoot, 'config/device-media-maps.local.json'), 'utf-8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves root-level clock offsets when syncing mapped roots from project brief', async () => {
    const workspaceRoot = await createWorkspace();
    const projectId = 'project-c';
    const projectRoot = await initWorkspaceProject(workspaceRoot, projectId, 'Test Project');
    const cameraRoot = 'C:\\media\\camera';

    await writeJson(join(projectRoot, 'config/ingest-roots.json'), {
      roots: [{
        id: 'root-media-camera',
        enabled: true,
        label: 'camera',
        description: '已有目录',
        priority: 1,
        clockOffsetMs: -611_000,
      }],
    });
    await writeWorkspaceProjectBrief(workspaceRoot, projectId, [
      { path: cameraRoot, description: '主机位' },
    ]);

    const result = await syncWorkspaceProjectBrief(workspaceRoot, projectId);

    expect(result.ingestRoots).toEqual([
      expect.objectContaining({
        id: 'root-media-camera',
        clockOffsetMs: -611_000,
        description: '主机位',
      }),
    ]);

    const ingestRoots = await loadIngestRoots(projectRoot);
    expect(ingestRoots.roots[0]).toEqual(expect.objectContaining({
      id: 'root-media-camera',
      clockOffsetMs: -611_000,
    }));
  });
});
