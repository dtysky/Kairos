import { createHash } from 'node:crypto';
import { copyFile, mkdir, stat } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import type {
  IColorResolveProjectMap,
  IColorResolveProjectSnapshot,
} from '../../protocol/schema.js';
import {
  getProjectEditResolveProjectsRoot,
  loadEditResolveProjectMap,
  loadProject,
  resolveWorkspaceProjectRoot,
  saveEditResolveProjectMap,
} from '../../store/index.js';
import {
  PythonResolveColorExecutor,
  type IColorExecutor,
} from '../color/resolve-executor.js';
import {
  deriveResolveRoughCutProjectName,
  resolveEditDrpLatestFilename,
} from './resolve-edit-naming.js';

export interface ISnapshotProjectEditDrpInput {
  workspaceRoot?: string;
  projectRoot?: string;
  projectId?: string;
  editId?: string;
  snapshotLabel?: string;
  mode?: 'manual' | 'auto';
  action?: string;
  executor?: Pick<IColorExecutor, 'preflight' | 'saveDrpSnapshot'>;
}

export interface ISnapshotProjectEditDrpResult {
  projectId?: string;
  editId?: string;
  resolveProjectName: string;
  snapshot: IColorResolveProjectSnapshot;
  detail: string;
  blockingReasons: string[];
}

export interface IRegisterExternalEditDrpSnapshotInput {
  workspaceRoot?: string;
  projectRoot?: string;
  projectId?: string;
  editId?: string;
  drpPath: string;
}

export interface IRegisterExternalEditDrpSnapshotResult {
  projectId?: string;
  editId?: string;
  resolveProjectName: string;
  snapshot: IColorResolveProjectSnapshot;
  detail: string;
  blockingReasons: string[];
}

export class ProjectEditDrpBlockedError extends Error {
  constructor(readonly blockers: string[]) {
    super(blockers.join('；'));
    this.name = 'ProjectEditDrpBlockedError';
  }
}

export async function snapshotProjectEditDrp(
  input: ISnapshotProjectEditDrpInput,
): Promise<ISnapshotProjectEditDrpResult> {
  const context = await resolveEditSnapshotContext(input);
  const executor = input.executor ?? new PythonResolveColorExecutor({ timeoutMs: 0 });
  const preflight = await executor.preflight({
    projectId: context.projectId ?? context.project.id,
    resolveProjectName: context.resolveProjectName,
  });
  if (preflight.status === 'blocked') {
    throw new ProjectEditDrpBlockedError(
      preflight.blockingReasons.length > 0
        ? preflight.blockingReasons
        : ['Resolve host preflight blocked edit DRP snapshot。'],
    );
  }

  const saved = await executor.saveDrpSnapshot({
    projectId: context.projectId ?? context.project.id,
    resolveProjectName: context.resolveProjectName,
    snapshotRoot: context.snapshotRoot,
    snapshotLabel: input.snapshotLabel ?? 'manual',
    latestFilename: resolveEditDrpLatestFilename(context.resolveProjectName),
    action: input.action ?? input.mode ?? 'manual',
  });
  const snapshot = {
    ...normalizeRequiredEditDrpSnapshot(saved.snapshot, context.resolveProjectName),
    ...(input.mode ? { mode: input.mode } : {}),
    ...(input.action ? { action: input.action } : {}),
  };
  await recordEditDrpSnapshots(context.projectRoot, context.resolveProjectName, [snapshot]);
  return {
    projectId: context.projectId,
    editId: input.editId,
    resolveProjectName: context.resolveProjectName,
    snapshot,
    detail: `已保存剪辑 DRP 快照：${snapshot.snapshotPath}`,
    blockingReasons: [],
  };
}

export async function registerExternalEditDrpSnapshot(
  input: IRegisterExternalEditDrpSnapshotInput,
): Promise<IRegisterExternalEditDrpSnapshotResult> {
  const context = await resolveEditSnapshotContext(input);
  const trimmedDrpPath = input.drpPath?.trim() ?? '';
  if (!trimmedDrpPath) {
    throw new ProjectEditDrpBlockedError(['登记外部剪辑 DRP 需要填写 .drp 路径。']);
  }
  const sourcePath = resolve(trimmedDrpPath);
  const sourceStats = await stat(sourcePath).catch(() => null);
  const blockers = [
    sourceStats && !sourceStats.isFile() ? `登记外部剪辑 DRP 不是文件：${sourcePath}` : '',
    !sourceStats ? `登记外部剪辑 DRP 不存在或不可读：${sourcePath}` : '',
    extname(sourcePath).toLowerCase() !== '.drp' ? `登记外部剪辑 DRP 必须是 .drp 文件：${sourcePath}` : '',
  ].filter(Boolean);
  if (blockers.length > 0) {
    throw new ProjectEditDrpBlockedError(blockers);
  }

  const createdAt = new Date().toISOString();
  const snapshotsRoot = join(context.snapshotRoot, 'snapshots');
  await mkdir(snapshotsRoot, { recursive: true });
  const targetPath = join(
    snapshotsRoot,
    `${formatEditSnapshotTimestamp(createdAt)}-external-${hashString(sourcePath).slice(0, 8)}.drp`,
  );
  await copyFile(sourcePath, targetPath);
  const latestPath = join(context.snapshotRoot, resolveEditDrpLatestFilename(context.resolveProjectName));
  await mkdir(dirname(latestPath), { recursive: true });
  if (resolve(targetPath) !== resolve(latestPath)) {
    await copyFile(targetPath, latestPath);
  }
  const snapshot: IColorResolveProjectSnapshot = {
    projectName: context.resolveProjectName,
    snapshotPath: targetPath,
    latestPath,
    createdAt,
    mode: 'external',
    action: 'register_external_drp',
    detail: `登记外部剪辑 DRP：${sourcePath}`,
  };
  await recordEditDrpSnapshots(context.projectRoot, context.resolveProjectName, [snapshot]);
  return {
    projectId: context.projectId,
    editId: input.editId,
    resolveProjectName: context.resolveProjectName,
    snapshot,
    detail: `已登记外部剪辑 DRP：${snapshot.snapshotPath}`,
    blockingReasons: [],
  };
}

export function resolveLatestEditDrpSnapshot(
  map: IColorResolveProjectMap | undefined,
  resolveProjectName: string,
): IColorResolveProjectSnapshot | undefined {
  return map?.projects?.[resolveProjectName]?.latestSnapshot;
}

async function resolveEditSnapshotContext(input: {
  workspaceRoot?: string;
  projectRoot?: string;
  projectId?: string;
}) {
  const projectRoot = input.projectRoot
    ?? (input.workspaceRoot && input.projectId
      ? resolveWorkspaceProjectRoot(input.workspaceRoot, input.projectId)
      : '');
  if (!projectRoot) {
    throw new ProjectEditDrpBlockedError(['snapshotProjectEditDrp requires projectRoot or workspaceRoot + projectId。']);
  }
  const project = await loadProject(projectRoot);
  const resolveProjectName = deriveResolveRoughCutProjectName(project.name, project.id);
  const snapshotRoot = join(getProjectEditResolveProjectsRoot(projectRoot), safeEditProjectKey(resolveProjectName));
  return {
    projectRoot,
    project,
    projectId: input.projectId,
    resolveProjectName,
    snapshotRoot,
  };
}

async function recordEditDrpSnapshots(
  projectRoot: string,
  resolveProjectName: string,
  snapshots: IColorResolveProjectSnapshot[],
): Promise<IColorResolveProjectMap> {
  const normalizedSnapshots = snapshots
    .map(snapshot => normalizeEditDrpSnapshot({
      ...snapshot,
      projectName: snapshot.projectName || resolveProjectName,
    }))
    .filter((snapshot): snapshot is IColorResolveProjectSnapshot => Boolean(snapshot));
  if (normalizedSnapshots.length === 0) {
    return loadEditResolveProjectMap(projectRoot);
  }
  const existing = await loadEditResolveProjectMap(projectRoot);
  const safeProjectName = safeEditProjectKey(resolveProjectName);
  const previous = existing.projects[resolveProjectName];
  const snapshotsByPath = new Map<string, IColorResolveProjectSnapshot>();
  for (const snapshot of previous?.snapshots ?? []) {
    snapshotsByPath.set(snapshot.snapshotPath, snapshot);
  }
  for (const snapshot of normalizedSnapshots) {
    snapshotsByPath.set(snapshot.snapshotPath, snapshot);
  }
  const orderedSnapshots = [...snapshotsByPath.values()]
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const latestSnapshot = normalizedSnapshots[normalizedSnapshots.length - 1]
    ?? orderedSnapshots[orderedSnapshots.length - 1]
    ?? previous?.latestSnapshot;
  const updatedAt = new Date().toISOString();
  return saveEditResolveProjectMap(projectRoot, {
    ...existing,
    updatedAt,
    projects: {
      ...existing.projects,
      [resolveProjectName]: {
        projectName: resolveProjectName,
        safeProjectName,
        latestSnapshot,
        snapshots: orderedSnapshots.slice(-200),
        updatedAt,
      },
    },
  });
}

function normalizeEditDrpSnapshot(value: Record<string, unknown>): IColorResolveProjectSnapshot | null {
  const projectName = typeof value.projectName === 'string' && value.projectName.trim()
    ? value.projectName.trim()
    : '';
  const snapshotPath = typeof value.snapshotPath === 'string' && value.snapshotPath.trim()
    ? value.snapshotPath.trim()
    : '';
  const createdAt = typeof value.createdAt === 'string' && value.createdAt.trim()
    ? value.createdAt.trim()
    : '';
  if (!projectName || !snapshotPath || !createdAt) return null;
  const mode = value.mode === 'manual' || value.mode === 'external' ? value.mode : 'auto';
  return {
    projectName,
    snapshotPath,
    latestPath: typeof value.latestPath === 'string' && value.latestPath.trim() ? value.latestPath.trim() : undefined,
    createdAt,
    mode,
    action: typeof value.action === 'string' && value.action.trim() ? value.action.trim() : undefined,
    rootId: typeof value.rootId === 'string' && value.rootId.trim() ? value.rootId.trim() : undefined,
    chunkId: typeof value.chunkId === 'string' && value.chunkId.trim() ? value.chunkId.trim() : undefined,
    database: typeof value.database === 'object' && value.database !== null ? value.database as Record<string, unknown> : undefined,
    detail: typeof value.detail === 'string' && value.detail.trim() ? value.detail.trim() : undefined,
  };
}

function normalizeRequiredEditDrpSnapshot(
  value: IColorResolveProjectSnapshot | Record<string, unknown>,
  resolveProjectName: string,
): IColorResolveProjectSnapshot {
  const normalized = normalizeEditDrpSnapshot({
    ...value,
    projectName: typeof value.projectName === 'string' && value.projectName.trim()
      ? value.projectName
      : resolveProjectName,
  });
  if (!normalized) {
    throw new Error('Resolve host returned an invalid edit DRP snapshot payload.');
  }
  return normalized;
}

function safeEditProjectKey(projectName: string): string {
  const normalized = projectName
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return normalized || `resolve-project-${hashString(projectName).slice(0, 10)}`;
}

function formatEditSnapshotTimestamp(iso: string): string {
  return iso.replace(/[-:]/g, '').replace(/\.\d{3}Z$/u, 'Z');
}

function hashString(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
