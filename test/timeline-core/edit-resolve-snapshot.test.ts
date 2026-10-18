import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IColorExecutor } from '../../src/modules/color/resolve-executor.js';
import {
  attachEditDrpSnapshotToResolveTimeline,
} from '../../src/modules/timeline-core/project-timeline.js';
import {
  registerExternalEditDrpSnapshot,
  snapshotProjectEditDrp,
} from '../../src/modules/timeline-core/edit-resolve-snapshot.js';
import { resolveEditDrpLatestFilename } from '../../src/modules/timeline-core/resolve-edit-naming.js';
import {
  initProject,
  loadEditResolveProjectMap,
} from '../../src/store/index.js';

const cTempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(cTempRoots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('edit Resolve DRP snapshots', () => {
  it('saves manual snapshots with project-name latest filename in the project-level edits map', async () => {
    const { workspaceRoot, projectRoot, projectId } = await createWorkspaceProject('project-edit-drp');
    const executor = createFakeSnapshotExecutor();

    const saved = await snapshotProjectEditDrp({
      workspaceRoot,
      projectId,
      editId: 'main',
      executor,
    });
    const savedSecondEdit = await snapshotProjectEditDrp({
      workspaceRoot,
      projectId,
      editId: 'alt-cut',
      snapshotLabel: 'manual-alt',
      retention: 'archive',
      executor,
    });

    expect(basename(saved.snapshot.latestPath || '')).toBe('Edit DRP Fixture [Edit].drp');
    expect(saved.snapshot.retention).toBe('latest-only');
    expect(saved.snapshot.snapshotPath).toBe(saved.snapshot.latestPath);
    expect(savedSecondEdit.snapshot.retention).toBe('archive');
    expect(saved.snapshot.latestPath).not.toMatch(/latest\.drp$/u);
    expect(savedSecondEdit.snapshot.latestPath).toBe(saved.snapshot.latestPath);
    const map = await loadEditResolveProjectMap(projectRoot);
    const entry = map.projects[saved.resolveProjectName];
    expect(entry?.latestSnapshot?.snapshotPath).toBe(savedSecondEdit.snapshot.snapshotPath);
    expect(entry?.snapshots).toHaveLength(1);
  });

  it('registers external DRP files and refreshes the project-name latest copy', async () => {
    const { workspaceRoot, projectRoot, projectId } = await createWorkspaceProject('project-edit-dpr-register');
    const externalPath = join(projectRoot, '.fixtures', 'manual-export.drp');
    await mkdir(join(projectRoot, '.fixtures'), { recursive: true });
    await writeFile(externalPath, 'external drp', 'utf-8');

    const registered = await registerExternalEditDrpSnapshot({
      workspaceRoot,
      projectId,
      editId: 'main',
      drpPath: externalPath,
    });

    expect(registered.snapshot.mode).toBe('external');
    expect(registered.snapshot.retention).toBe('archive');
    expect(basename(registered.snapshot.latestPath || '')).toBe('Edit DRP Fixture [Edit].drp');
    await expect(readFile(registered.snapshot.latestPath || '', 'utf-8')).resolves.toBe('external drp');
    const map = await loadEditResolveProjectMap(projectRoot);
    expect(map.projects[registered.resolveProjectName]?.latestSnapshot?.snapshotPath)
      .toBe(registered.snapshot.snapshotPath);
  });

  it('records timeline.generate snapshots as auto even though the host operation is save_drp_snapshot', async () => {
    const { workspaceRoot, projectId } = await createWorkspaceProject('project-edit-drp-auto');
    const executor = createFakeSnapshotExecutor();

    const saved = await snapshotProjectEditDrp({
      workspaceRoot,
      projectId,
      editId: 'main',
      snapshotLabel: 'timeline-generate-main-complete',
      mode: 'auto',
      action: 'timeline.generate',
      executor,
    });

    expect(saved.snapshot.mode).toBe('auto');
    expect(saved.snapshot.retention).toBe('latest-only');
    expect(saved.snapshot.action).toBe('timeline.generate');
  });

  it('records automatic timeline snapshot failures as warnings', async () => {
    const result = await attachEditDrpSnapshotToResolveTimeline({
      workspaceRoot: '/workspace',
      projectRoot: '/workspace/projects/project-edit',
      projectId: 'project-edit',
      editId: 'main',
      resolveTimeline: {
        resolveProjectName: 'Edit DRP Fixture [Edit]',
        timelineName: 'Main [main]',
        createdAt: '2026-05-21T10:00:00.000Z',
        clipCount: 1,
      },
      snapshotter: async () => {
        throw new Error('Resolve export failed');
      },
    });

    expect(result.clipCount).toBe(1);
    expect(result.drpSnapshotWarning).toBe('Resolve export failed');
  });

  it('sanitizes only invalid filename characters for edit latest DRP names', () => {
    expect(resolveEditDrpLatestFilename('丙察察:格涅/南线 [Edit]'))
      .toBe('丙察察-格涅-南线 [Edit].drp');
  });

  it('persists failure without replacing the successful latest, then records a successful retry', async () => {
    const { projectRoot } = await createWorkspaceProject('failed-edit-drp');
    const executor = createFakeSnapshotExecutor();
    const preflight = vi.spyOn(executor, 'preflight').mockRejectedValue(new Error('must not probe or create projects'));
    await snapshotProjectEditDrp({ projectRoot, executor, retention: 'archive' });
    const saved = await snapshotProjectEditDrp({ projectRoot, executor });
    const before = await readFile(saved.snapshot.latestPath!);
    const error = Object.assign(new Error('script server unavailable'), { code: 'resolve_app_unavailable' });
    await expect(snapshotProjectEditDrp({ projectRoot, mode: 'auto', action: 'timeline.generate',
      executor: { saveDrpSnapshot: async () => { throw error; } },
    })).rejects.toBe(error);
    let entry = (await loadEditResolveProjectMap(projectRoot)).projects[saved.resolveProjectName]!;
    expect(entry.latestSnapshot).toEqual(saved.snapshot);
    expect(await readFile(saved.snapshot.latestPath!)).toEqual(before);
    expect(entry.latestSnapshotAttempt).toMatchObject({ status: 'failed', mode: 'auto', action: 'timeline.generate',
      error: { code: 'resolve_app_unavailable', message: 'script server unavailable' } });
    expect(entry.latestSnapshotAttempt?.finishedAt).toBeTruthy();
    expect(entry.snapshotAttempts?.map(row => row.status)).toEqual(['succeeded', 'succeeded', 'failed']);
    await snapshotProjectEditDrp({ projectRoot, executor });
    entry = (await loadEditResolveProjectMap(projectRoot)).projects[saved.resolveProjectName]!;
    expect(entry.latestSnapshotAttempt?.status).toBe('succeeded');
    expect(entry.latestSnapshotAttempt?.error).toBeUndefined();
    expect(entry.snapshotAttempts?.filter(row => row.status === 'failed')).toHaveLength(1);
    expect(preflight).not.toHaveBeenCalled();
  });

  it('persists the first failure even without any successful snapshot and records failed external registration', async () => {
    const { projectRoot } = await createWorkspaceProject('first-failure-drp');
    await expect(snapshotProjectEditDrp({ projectRoot,
      executor: { saveDrpSnapshot: async () => { throw new Error('save failed'); } },
    })).rejects.toThrow('save failed');
    let entry = Object.values((await loadEditResolveProjectMap(projectRoot)).projects)[0]!;
    expect(entry.latestSnapshot).toBeUndefined();
    expect(entry.latestSnapshotAttempt?.status).toBe('failed');
    await expect(registerExternalEditDrpSnapshot({ projectRoot, drpPath: join(projectRoot, 'missing.drp') })).rejects.toThrow('不存在');
    entry = Object.values((await loadEditResolveProjectMap(projectRoot)).projects)[0]!;
    expect(entry.latestSnapshotAttempt).toMatchObject({ status: 'failed', mode: 'external', retention: 'archive' });
    expect(entry.snapshotAttempts).toHaveLength(2);
  });

  it('records running before invoking Resolve and rejects a second same-project request', async () => {
    const { projectRoot } = await createWorkspaceProject('concurrent-drp');
    const fake = createFakeSnapshotExecutor();
    const executor = { saveDrpSnapshot: async (input: Parameters<IColorExecutor['saveDrpSnapshot']>[0]) => {
      const entry = Object.values((await loadEditResolveProjectMap(projectRoot)).projects)[0]!;
      expect(entry.latestSnapshotAttempt?.status).toBe('running');
      await expect(snapshotProjectEditDrp({ projectRoot, executor: fake })).rejects.toThrow('正在执行');
      return fake.saveDrpSnapshot(input);
    } };
    await snapshotProjectEditDrp({ projectRoot, executor });
    const entry = Object.values((await loadEditResolveProjectMap(projectRoot)).projects)[0]!;
    expect(entry.snapshotAttempts).toHaveLength(1);
    expect(entry.latestSnapshotAttempt?.status).toBe('succeeded');
  });
});

async function createWorkspaceProject(projectId: string) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'kairos-edit-drp-workspace-'));
  cTempRoots.push(workspaceRoot);
  const projectRoot = join(workspaceRoot, 'projects', projectId);
  await initProject(projectRoot, 'Edit DRP Fixture');
  return { workspaceRoot, projectRoot, projectId };
}

function createFakeSnapshotExecutor(): Pick<IColorExecutor, 'preflight' | 'saveDrpSnapshot'> {
  return {
    async preflight() {
      return {
        status: 'ready',
        checkedAt: '2026-05-21T10:00:00.000Z',
        productName: 'DaVinci Resolve Studio',
        versionString: '21.0',
        isStudio: true,
        warnings: [],
        blockingReasons: [],
      };
    },
    async saveDrpSnapshot(input) {
      const latestPath = join(input.snapshotRoot, input.latestFilename || 'latest.drp');
      const retention = input.retention === 'archive' ? 'archive' : 'latest-only';
      const snapshotPath = retention === 'archive'
        ? join(input.snapshotRoot, 'snapshots', `${input.snapshotLabel || 'manual'}.drp`)
        : latestPath;
      if (retention === 'archive') {
        await mkdir(join(input.snapshotRoot, 'snapshots'), { recursive: true });
        await writeFile(snapshotPath, 'drp', 'utf-8');
      }
      await mkdir(input.snapshotRoot, { recursive: true });
      await writeFile(latestPath, 'drp', 'utf-8');
      return {
        snapshot: {
          projectName: input.resolveProjectName,
          snapshotPath,
          latestPath,
          createdAt: input.snapshotLabel === 'manual-alt'
            ? '2026-05-21T10:01:00.000Z'
            : '2026-05-21T10:00:00.000Z',
          mode: 'manual',
          retention,
          action: input.action,
        },
      };
    },
  };
}
