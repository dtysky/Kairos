import { afterEach, describe, expect, it } from 'vitest';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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

  it('rebuilds stale pharos context when source fingerprint changes', async () => {
    const workspaceRoot = await createWorkspace();
    const projectRoot = await initWorkspaceProject(workspaceRoot, 'project-pharos-stale', 'Project Stale');
    const tripRoot = join(projectRoot, 'pharos', 'trip-a');
    await mkdir(tripRoot, { recursive: true });
    await writeFile(join(tripRoot, 'plan.json'), JSON.stringify({
      $schema: 'pharos/plan/v3.0',
      trip_id: 'trip-a',
      title: 'Trip A',
      revision: 1,
      timezone: 'Asia/Shanghai',
      dates: {
        start: '2026-05-01',
        end: '2026-05-01',
      },
      days: [],
    }), 'utf-8');

    const first = await loadOrBuildProjectPharosContext({ projectRoot });
    expect(first.status).toBe('success');
    expect(first.trips[0]?.title).toBe('Trip A');
    expect(first.sourceFingerprint).toBeTruthy();

    await writeFile(join(tripRoot, 'plan.json'), JSON.stringify({
      $schema: 'pharos/plan/v3.0',
      trip_id: 'trip-a',
      title: 'Trip A Updated',
      revision: 2,
      timezone: 'Asia/Shanghai',
      dates: {
        start: '2026-05-01',
        end: '2026-05-02',
      },
      days: [],
    }), 'utf-8');

    const second = await loadOrBuildProjectPharosContext({ projectRoot });
    expect(second.trips[0]?.title).toBe('Trip A Updated');
    expect(second.sourceFingerprint).not.toBe(first.sourceFingerprint);
  });
});
