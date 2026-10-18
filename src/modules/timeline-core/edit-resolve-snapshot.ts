import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, stat } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import type {
  IColorResolveProjectMap,
  IColorResolveProjectSnapshot,
  IResolveProjectSnapshotAttempt,
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
  retention?: 'latest-only' | 'archive';
  mode?: 'manual' | 'auto';
  action?: string;
  executor?: Pick<IColorExecutor, 'saveDrpSnapshot'>;
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
  const retention = normalizeEditDrpSnapshotRetention(input.retention);
  const executor = input.executor ?? new PythonResolveColorExecutor();
  const snapshot = await runEditDrpAttempt(context, {
    mode: input.mode ?? 'manual', retention, action: input.action ?? input.mode ?? 'manual',
  }, async () => {
    const saved = await executor.saveDrpSnapshot({
      projectId: context.projectId ?? context.project.id,
      resolveProjectName: context.resolveProjectName,
      snapshotRoot: context.snapshotRoot,
      snapshotLabel: input.snapshotLabel ?? 'manual',
      latestFilename: resolveEditDrpLatestFilename(context.resolveProjectName),
      retention,
      action: input.action ?? input.mode ?? 'manual',
    });
    return {
      ...normalizeRequiredEditDrpSnapshot(saved.snapshot, context.resolveProjectName),
      retention,
      mode: input.mode ?? 'manual',
      ...(input.action ? { action: input.action } : {}),
    };
  });
  return {
    projectId: context.projectId,
    editId: input.editId,
    resolveProjectName: context.resolveProjectName,
    snapshot,
    detail: formatEditDrpSnapshotDetail(snapshot),
    blockingReasons: [],
  };
}

export async function registerExternalEditDrpSnapshot(
  input: IRegisterExternalEditDrpSnapshotInput,
): Promise<IRegisterExternalEditDrpSnapshotResult> {
  const context = await resolveEditSnapshotContext(input);
  const snapshot = await runEditDrpAttempt(context, {
    mode: 'external', retention: 'archive', action: 'register_external_drp',
  }, async () => {
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
    return {
      projectName: context.resolveProjectName,
      snapshotPath: targetPath,
      latestPath,
      createdAt,
      mode: 'external' as const,
      retention: 'archive' as const,
      action: 'register_external_drp',
      detail: `登记外部剪辑 DRP：${sourcePath}`,
    };
  });
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

const activeSnapshotProjects = new Set<string>();

async function runEditDrpAttempt(
  context: Awaited<ReturnType<typeof resolveEditSnapshotContext>>,
  options: Pick<IResolveProjectSnapshotAttempt, 'mode' | 'retention' | 'action'>,
  operation: () => Promise<IColorResolveProjectSnapshot>,
): Promise<IColorResolveProjectSnapshot> {
  const key = resolve(context.projectRoot);
  if (activeSnapshotProjects.has(key)) {
    throw new ProjectEditDrpBlockedError(['该工程已有 DRP 备份请求正在执行，请等待完成。']);
  }
  activeSnapshotProjects.add(key);
  const attempt: IResolveProjectSnapshotAttempt = {
    ...options, attemptId: randomUUID(), status: 'running', startedAt: new Date().toISOString(),
  };
  try {
    await recordEditDrpAttempt(context.projectRoot, context.resolveProjectName, attempt);
    const snapshot = await operation();
    await recordEditDrpAttempt(context.projectRoot, context.resolveProjectName, {
      ...attempt, status: 'succeeded', finishedAt: new Date().toISOString(),
    }, snapshot);
    return snapshot;
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
      ? error.code : undefined;
    const message = error instanceof Error ? error.message : String(error);
    try {
      await recordEditDrpAttempt(context.projectRoot, context.resolveProjectName, {
        ...attempt, status: 'failed', finishedAt: new Date().toISOString(), error: { code, message },
      });
    } catch (recordError) {
      throw new Error(`${message}；备份失败记录也无法保存：${recordError instanceof Error ? recordError.message : String(recordError)}`, { cause: error });
    }
    throw error;
  } finally {
    activeSnapshotProjects.delete(key);
  }
}

async function recordEditDrpAttempt(
  projectRoot: string,
  resolveProjectName: string,
  attempt: IResolveProjectSnapshotAttempt,
  snapshot?: IColorResolveProjectSnapshot,
): Promise<IColorResolveProjectMap> {
  const normalizedSnapshots = (snapshot ? [snapshot] : [])
    .map(snapshot => normalizeEditDrpSnapshot({
      ...snapshot,
      projectName: snapshot.projectName || resolveProjectName,
    }))
    .filter((snapshot): snapshot is IColorResolveProjectSnapshot => Boolean(snapshot));
  const existing = await loadEditResolveProjectMap(projectRoot);
  const safeProjectName = safeEditProjectKey(resolveProjectName);
  const previous = existing.projects[resolveProjectName];
  const snapshotsByPath = new Map<string, IColorResolveProjectSnapshot>();
  for (const snapshot of previous?.snapshots ?? []) {
    if (snapshot.retention === 'latest-only') continue;
    snapshotsByPath.set(snapshot.snapshotPath, snapshot);
  }
  for (const snapshot of normalizedSnapshots) {
    if (snapshot.retention === 'latest-only') continue;
    snapshotsByPath.set(snapshot.snapshotPath, snapshot);
  }
  const orderedSnapshots = [...snapshotsByPath.values()]
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const latestSnapshot = normalizedSnapshots[normalizedSnapshots.length - 1]
    ?? previous?.latestSnapshot
    ?? orderedSnapshots[orderedSnapshots.length - 1];
  const updatedAt = new Date().toISOString();
  return saveEditResolveProjectMap(projectRoot, {
    ...existing,
    updatedAt,
    projects: {
      ...existing.projects,
      [resolveProjectName]: {
        ...previous,
        projectName: resolveProjectName,
        safeProjectName,
        latestSnapshot,
        latestSnapshotAttempt: attempt,
        snapshotAttempts: [...(previous?.snapshotAttempts ?? []).filter(row => row.attemptId !== attempt.attemptId), attempt].slice(-50),
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
    retention: value.retention === 'latest-only' ? 'latest-only' : 'archive',
    action: typeof value.action === 'string' && value.action.trim() ? value.action.trim() : undefined,
    rootId: typeof value.rootId === 'string' && value.rootId.trim() ? value.rootId.trim() : undefined,
    chunkId: typeof value.chunkId === 'string' && value.chunkId.trim() ? value.chunkId.trim() : undefined,
    database: typeof value.database === 'object' && value.database !== null ? value.database as Record<string, unknown> : undefined,
    detail: typeof value.detail === 'string' && value.detail.trim() ? value.detail.trim() : undefined,
  };
}

function normalizeEditDrpSnapshotRetention(value: unknown): 'latest-only' | 'archive' {
  return value === 'archive' ? 'archive' : 'latest-only';
}

function formatEditDrpSnapshotDetail(snapshot: IColorResolveProjectSnapshot): string {
  return snapshot.retention === 'archive'
    ? `已归档剪辑 DRP 快照：${snapshot.snapshotPath}`
    : `已覆盖最新剪辑 DRP：${snapshot.latestPath || snapshot.snapshotPath}`;
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
