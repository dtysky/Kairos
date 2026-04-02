import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyzeWorkspaceProjectMedia } from '../../src/modules/media/project-analyze.js';
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
    })).rejects.toThrow(/ML server 不可用/u);

    const progress = JSON.parse(await readFile(progressPath, 'utf-8')) as {
      status: string;
      detail?: string;
    };
    expect(progress.status).toBe('failed');
    expect(progress.detail).toMatch(/ML server 不可用/u);
  });
});
