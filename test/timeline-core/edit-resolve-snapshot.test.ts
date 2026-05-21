import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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
      executor,
    });

    expect(basename(saved.snapshot.latestPath || '')).toBe('Edit DRP Fixture [Edit].drp');
    expect(saved.snapshot.latestPath).not.toMatch(/latest\.drp$/u);
    expect(savedSecondEdit.snapshot.latestPath).toBe(saved.snapshot.latestPath);
    const map = await loadEditResolveProjectMap(projectRoot);
    const entry = map.projects[saved.resolveProjectName];
    expect(entry?.latestSnapshot?.snapshotPath).toBe(savedSecondEdit.snapshot.snapshotPath);
    expect(entry?.snapshots).toHaveLength(2);
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
      const snapshotPath = join(input.snapshotRoot, 'snapshots', `${input.snapshotLabel || 'manual'}.drp`);
      const latestPath = join(input.snapshotRoot, input.latestFilename || 'latest.drp');
      await mkdir(join(input.snapshotRoot, 'snapshots'), { recursive: true });
      await writeFile(snapshotPath, 'drp', 'utf-8');
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
          action: input.action,
        },
      };
    },
  };
}
