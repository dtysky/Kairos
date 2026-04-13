import { afterEach, describe, expect, it } from 'vitest';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initWorkspaceProject } from '../../src/store/index.js';
import { loadOrBuildProjectPharosContext } from '../../src/modules/pharos/context.js';

const workspaces: string[] = [];

afterEach(async () => {
  await Promise.all(
    workspaces.splice(0).map(path => rm(path, { recursive: true, force: true })),
  );
});

async function createWorkspace(): Promise<string> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'kairos-pharos-test-'));
  workspaces.push(workspaceRoot);
  return workspaceRoot;
}

describe('project pharos root', () => {
  it('creates pharos root during project init', async () => {
    const workspaceRoot = await createWorkspace();
    const projectRoot = await initWorkspaceProject(workspaceRoot, 'project-pharos-init', 'Project Init');

    await expect(access(join(projectRoot, 'pharos'))).resolves.toBeUndefined();
  });

  it('recreates pharos root when loading project pharos context', async () => {
    const workspaceRoot = await createWorkspace();
    const projectRoot = await initWorkspaceProject(workspaceRoot, 'project-pharos-repair', 'Project Repair');
    const pharosRoot = join(projectRoot, 'pharos');

    await rm(pharosRoot, { recursive: true, force: true });
    await expect(access(pharosRoot)).rejects.toBeTruthy();

    const context = await loadOrBuildProjectPharosContext({ projectRoot, forceRefresh: true });

    await expect(access(pharosRoot)).resolves.toBeUndefined();
    expect(context.status).toBe('empty');
    expect(context.rootPath).toBe(pharosRoot);
  });
});
