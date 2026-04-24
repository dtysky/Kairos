import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, rename, stat, unlink } from 'node:fs/promises';
import { dirname, extname, join, posix, relative, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import type {
  IColorBatchManifest,
  IColorBatchPlan,
  IColorBatchPromote,
  IColorBatchValidation,
  IColorHostPreflight,
  IColorFileMetadataSnapshot,
  IColorGroupCurrent,
  IColorGroupsSnapshotFile,
  IColorRootCurrent,
  EColorValidationCheckResult,
  IColorCurrent,
} from '../../protocol/schema.js';
import {
  getProjectProgressPath,
  getColorGroupsSnapshotPath,
  loadColorBatchManifest,
  loadColorBatchPlan,
  loadColorBatchPromote,
  loadColorBatchValidation,
  loadColorCurrent,
  loadColorGroupsSnapshot,
  loadColorGroupsSnapshots,
  loadIngestRoots,
  loadColorTransformPresetsConfig,
  loadProjectBriefConfig,
  loadProjectDeviceMediaMaps,
  loadRuntimeConfig,
  resolveWorkspaceProjectRoot,
  saveColorBatchManifest,
  saveColorBatchPlan,
  saveColorBatchPromote,
  saveColorBatchValidation,
  saveColorCurrent,
  saveColorGroupsSnapshot,
  writeKairosProgress,
} from '../../store/index.js';
import { resolveCaptureTime } from '../media/capture-time.js';
import { probe } from '../media/probe.js';
import { classifyExt, scanDirectory } from '../media/scanner.js';
import { toPortableRelativePath } from '../media/root-resolver.js';
import { toExecutableInputPath } from '../media/tool-path.js';
import {
  buildColorWorkspaceState,
  deriveColorGradingTimelineName,
  deriveColorResolveProjectName,
  deriveColorRootNamespace,
} from './workspace-state.js';
import { readColorRenderPresetBitrateKbps } from './render-preset.js';
import { classifyFirstFrameLowlight } from './lowlight-classifier.js';
import { extractColorSourceTruth } from './source-truth.js';
import {
  resolveClipTransformSeeds,
  resolveEffectiveColorProfile,
  syncReferencedResolveLuts,
  type IResolveLutSyncSummary,
} from './transform-presets.js';
import {
  PythonResolveColorExecutor,
  ResolveColorHostError,
  ResolveColorExecutorUnavailableError,
  inspectResolveColorBackend,
  type IColorExecutorClipInput,
  type IColorExecutor,
} from './resolve-executor.js';

export type TProjectColorAction =
  | 'prepare_root'
  | 'sync_groups'
  | 'execute_root'
  | 'validate_batch'
  | 'promote_batch'
  | 'prepare_all_roots'
  | 'export_all_roots';

const CCOLOR_STEP_DEFINITIONS: Record<TProjectColorAction, Array<{ key: string; label: string }>> = {
  prepare_root: [
    { key: 'sync_root_bins', label: '同步 root 镜像预备态' },
    { key: 'prepare_root_timeline', label: '准备 root timeline' },
  ],
  sync_groups: [
    { key: 'sync_groups', label: '同步 Resolve Groups' },
  ],
  execute_root: [
    { key: 'scan_root_clips', label: '扫描 root clip inventory' },
    { key: 'render_root', label: '执行 root 渲染' },
  ],
  validate_batch: [
    { key: 'validate_batch', label: '校验 batch manifest' },
  ],
  promote_batch: [
    { key: 'promote_batch', label: '覆盖当前素材目录' },
  ],
  prepare_all_roots: [
    { key: 'select_roots', label: '确定目标 roots' },
    { key: 'prepare_all_roots', label: '顺序准备所有 roots' },
  ],
  export_all_roots: [
    { key: 'select_roots', label: '确定目标 roots' },
    { key: 'export_all_roots', label: '顺序导出所有 roots' },
  ],
};

export interface IProjectColorActionInput {
  workspaceRoot: string;
  projectId: string;
  rootId?: string;
  action?: TProjectColorAction;
  clipKeys?: string[];
  batchId?: string;
  jobId?: string;
  progressPath?: string;
  executor?: IColorExecutor;
  suppressProgress?: boolean;
}

export interface IProjectColorActionRootResult {
  rootId: string;
  status: 'succeeded' | 'failed';
  actionSummary: string;
  batchId?: string;
  error?: string;
}

export interface IProjectColorActionResult {
  action: TProjectColorAction;
  projectId: string;
  rootId?: string;
  batchId?: string;
  detail: string;
  blockingReasons: string[];
  roots?: IProjectColorActionRootResult[];
}

type TWriteColorProgress = (
  progressPath: string,
  action: TProjectColorAction,
  input: {
    status: 'running' | 'succeeded' | 'failed';
    stepIndex: number;
    current: number;
    detail: string;
    extra: Record<string, unknown>;
  },
) => Promise<void>;

export interface IPrepareProjectColorRootInput extends IProjectColorActionInput {
  action?: 'prepare_root';
  rootId: string;
}

export interface IPrepareProjectColorRootResult extends IProjectColorActionResult {
  resolveProjectName?: string;
  rootNamespace?: string;
  gradingTimelineName?: string;
  mirrorStatus?: string;
  timelineStatus?: string;
}

export interface IProjectColorPreflightInput {
  workspaceRoot: string;
  projectId: string;
  rootId?: string;
  executor?: IColorExecutor;
}

export class ProjectColorBlockedError extends Error {
  constructor(public blockers: string[]) {
    super(blockers.join('; '));
    this.name = 'ProjectColorBlockedError';
  }
}

export class ColorPrepBlockedError extends ProjectColorBlockedError {
  constructor(blockers: string[]) {
    super(blockers);
    this.name = 'ColorPrepBlockedError';
  }
}

const exec = promisify(execFile);

interface IColorRootContext {
  workspaceRoot: string;
  projectRoot: string;
  projectId: string;
  rootId: string;
  rootSummary: ReturnType<typeof buildColorWorkspaceState>['colorRoots'][number];
  colorCurrent: IColorCurrent;
  runtimeConfig: Awaited<ReturnType<typeof loadRuntimeConfig>>;
  transformPresetsConfig: Awaited<ReturnType<typeof loadColorTransformPresetsConfig>>;
  groupsSnapshot: IColorGroupsSnapshotFile | null;
}

export async function runProjectColorAction(
  input: IProjectColorActionInput,
): Promise<IProjectColorActionResult> {
  const action = normalizeColorAction(input.action);
  switch (action) {
    case 'prepare_root': {
      const rootId = input.rootId?.trim();
      if (!rootId) {
        throw new ProjectColorBlockedError(['prepare_root requires rootId。']);
      }
      return prepareProjectColorRoot({
        ...input,
        rootId,
        action: 'prepare_root',
      });
    }
    case 'sync_groups': {
      const rootId = input.rootId?.trim();
      if (!rootId) {
        throw new ProjectColorBlockedError(['sync_groups requires rootId。']);
      }
      return syncProjectColorGroups({ ...input, rootId });
    }
    case 'execute_root': {
      const rootId = input.rootId?.trim();
      if (!rootId) {
        throw new ProjectColorBlockedError(['execute_root requires rootId。']);
      }
      return executeProjectColorRoot({ ...input, rootId });
    }
    case 'validate_batch': {
      const rootId = input.rootId?.trim();
      if (!rootId) {
        throw new ProjectColorBlockedError(['validate_batch requires rootId。']);
      }
      return validateProjectColorBatch({ ...input, rootId });
    }
    case 'promote_batch': {
      const rootId = input.rootId?.trim();
      if (!rootId) {
        throw new ProjectColorBlockedError(['promote_batch requires rootId。']);
      }
      return promoteProjectColorBatch({ ...input, rootId });
    }
    case 'prepare_all_roots':
      if (input.rootId?.trim()) {
        throw new ProjectColorBlockedError(['prepare_all_roots is project-scoped and does not accept rootId。']);
      }
      return prepareAllProjectColorRoots(input);
    case 'export_all_roots':
      if (input.rootId?.trim()) {
        throw new ProjectColorBlockedError(['export_all_roots is project-scoped and does not accept rootId。']);
      }
      return exportAllProjectColorRoots(input);
    default:
      throw new Error(`Unsupported color action: ${action satisfies never}`);
  }
}

export async function preflightProjectColorHost(
  input: IProjectColorPreflightInput,
): Promise<IColorHostPreflight> {
  const projectRoot = resolveWorkspaceProjectRoot(input.workspaceRoot, input.projectId);
  const projectBrief = await loadProjectBriefConfig(projectRoot).catch(() => null);
  const preflight = await runColorHostPreflight({
    projectRoot,
    projectId: input.projectId,
    rootId: input.rootId,
    resolveProjectName: deriveColorResolveProjectName(projectBrief?.name, input.projectId),
    executor: input.executor,
  });
  await saveColorHostPreflight(projectRoot, preflight);
  return preflight;
}

export async function prepareAllProjectColorRoots(
  input: IProjectColorActionInput,
): Promise<IProjectColorActionResult> {
  const action: TProjectColorAction = 'prepare_all_roots';
  const projectRoot = resolveWorkspaceProjectRoot(input.workspaceRoot, input.projectId);
  const progressPath = resolveColorProgressPath(projectRoot, input.progressPath);
  const rootSummaries = await loadEnabledProjectColorRootSummaries(input.workspaceRoot, input.projectId);
  if (rootSummaries.length === 0) {
    const blockers = ['当前项目没有可执行的 enabled color roots。'];
    await writeColorProgress(progressPath, action, {
      status: 'failed',
      stepIndex: 1,
      current: 0,
      detail: blockers[0]!,
      extra: {
        projectId: input.projectId,
        currentRootId: undefined,
        currentRootIndex: 0,
        totalRoots: 0,
        succeededRoots: 0,
        failedRoots: 0,
      },
    });
    throw new ProjectColorBlockedError(blockers);
  }

  await writeColorProgress(progressPath, action, {
    status: 'running',
    stepIndex: 1,
    current: 0,
    detail: `已锁定 ${rootSummaries.length} 个 color roots，准备顺序执行 prepare_root。`,
    extra: {
      projectId: input.projectId,
      currentRootId: rootSummaries[0]?.rootId,
      currentRootIndex: 0,
      totalRoots: rootSummaries.length,
      succeededRoots: 0,
      failedRoots: 0,
    },
  });

  const roots: IProjectColorActionRootResult[] = [];
  let succeededRoots = 0;
  let failedRoots = 0;
  for (const [index, rootSummary] of rootSummaries.entries()) {
    await writeColorProgress(progressPath, action, {
      status: 'running',
      stepIndex: 2,
      current: index,
      detail: `正在准备 root ${index + 1}/${rootSummaries.length}：${rootSummary.rootId}`,
      extra: {
        projectId: input.projectId,
        currentRootId: rootSummary.rootId,
        currentRootIndex: index + 1,
        totalRoots: rootSummaries.length,
        succeededRoots,
        failedRoots,
      },
    });
    try {
      const result = await prepareProjectColorRoot({
        ...input,
        rootId: rootSummary.rootId,
        action: 'prepare_root',
        suppressProgress: true,
      });
      succeededRoots += 1;
      roots.push({
        rootId: rootSummary.rootId,
        status: 'succeeded',
        actionSummary: result.detail,
      });
    } catch (error) {
      failedRoots += 1;
      roots.push({
        rootId: rootSummary.rootId,
        status: 'failed',
        actionSummary: error instanceof Error ? error.message : String(error),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const detail = failedRoots > 0
    ? `Prepare All Roots 完成：${succeededRoots} 个成功，${failedRoots} 个失败。`
    : `Prepare All Roots 完成：${succeededRoots} 个 roots 全部 ready。`;
  await writeColorProgress(progressPath, action, {
    status: failedRoots > 0 ? 'failed' : 'succeeded',
    stepIndex: 2,
    current: rootSummaries.length,
    detail,
    extra: {
      projectId: input.projectId,
      currentRootId: rootSummaries[rootSummaries.length - 1]?.rootId,
      currentRootIndex: rootSummaries.length,
      totalRoots: rootSummaries.length,
      succeededRoots,
      failedRoots,
    },
  });

  return {
    action,
    projectId: input.projectId,
    detail,
    blockingReasons: roots
      .filter(root => root.status === 'failed')
      .map(root => `${root.rootId}: ${root.error || root.actionSummary}`),
    roots,
  };
}

export async function exportAllProjectColorRoots(
  input: IProjectColorActionInput,
): Promise<IProjectColorActionResult> {
  const action: TProjectColorAction = 'export_all_roots';
  const projectRoot = resolveWorkspaceProjectRoot(input.workspaceRoot, input.projectId);
  const progressPath = resolveColorProgressPath(projectRoot, input.progressPath);
  const rootSummaries = await loadEnabledProjectColorRootSummaries(input.workspaceRoot, input.projectId);
  if (rootSummaries.length === 0) {
    const blockers = ['当前项目没有可执行的 enabled color roots。'];
    await writeColorProgress(progressPath, action, {
      status: 'failed',
      stepIndex: 1,
      current: 0,
      detail: blockers[0]!,
      extra: {
        projectId: input.projectId,
        currentRootId: undefined,
        currentRootIndex: 0,
        totalRoots: 0,
        succeededRoots: 0,
        failedRoots: 0,
      },
    });
    throw new ProjectColorBlockedError(blockers);
  }

  await writeColorProgress(progressPath, action, {
    status: 'running',
    stepIndex: 1,
    current: 0,
    detail: `已锁定 ${rootSummaries.length} 个 color roots，准备顺序执行 export pipeline。`,
    extra: {
      projectId: input.projectId,
      currentRootId: rootSummaries[0]?.rootId,
      currentRootIndex: 0,
      totalRoots: rootSummaries.length,
      succeededRoots: 0,
      failedRoots: 0,
    },
  });

  const roots: IProjectColorActionRootResult[] = [];
  let succeededRoots = 0;
  let failedRoots = 0;
  for (const [index, rootSummary] of rootSummaries.entries()) {
    await writeColorProgress(progressPath, action, {
      status: 'running',
      stepIndex: 2,
      current: index,
      detail: `正在导出 root ${index + 1}/${rootSummaries.length}：${rootSummary.rootId}`,
      extra: {
        projectId: input.projectId,
        currentRootId: rootSummary.rootId,
        currentRootIndex: index + 1,
        totalRoots: rootSummaries.length,
        succeededRoots,
        failedRoots,
      },
    });
    try {
      const executed = await executeProjectColorRoot({
        ...input,
        rootId: rootSummary.rootId,
        action: 'execute_root',
        suppressProgress: true,
      });
      const validated = await validateProjectColorBatch({
        ...input,
        rootId: rootSummary.rootId,
        action: 'validate_batch',
        batchId: executed.batchId,
        suppressProgress: true,
      });
      if (validated.blockingReasons.length > 0) {
        failedRoots += 1;
        roots.push({
          rootId: rootSummary.rootId,
          status: 'failed',
          batchId: executed.batchId,
          actionSummary: validated.detail,
          error: validated.blockingReasons.join('；'),
        });
        continue;
      }
      const promoted = await promoteProjectColorBatch({
        ...input,
        rootId: rootSummary.rootId,
        action: 'promote_batch',
        batchId: executed.batchId,
        suppressProgress: true,
      });
      succeededRoots += 1;
      roots.push({
        rootId: rootSummary.rootId,
        status: 'succeeded',
        batchId: executed.batchId,
        actionSummary: promoted.detail,
      });
    } catch (error) {
      failedRoots += 1;
      roots.push({
        rootId: rootSummary.rootId,
        status: 'failed',
        actionSummary: error instanceof Error ? error.message : String(error),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const detail = failedRoots > 0
    ? `Export All Roots 完成：${succeededRoots} 个成功，${failedRoots} 个失败。`
    : `Export All Roots 完成：${succeededRoots} 个 roots 全部导出并 promote。`;
  await writeColorProgress(progressPath, action, {
    status: failedRoots > 0 ? 'failed' : 'succeeded',
    stepIndex: 2,
    current: rootSummaries.length,
    detail,
    extra: {
      projectId: input.projectId,
      currentRootId: rootSummaries[rootSummaries.length - 1]?.rootId,
      currentRootIndex: rootSummaries.length,
      totalRoots: rootSummaries.length,
      succeededRoots,
      failedRoots,
    },
  });

  return {
    action,
    projectId: input.projectId,
    detail,
    blockingReasons: roots
      .filter(root => root.status === 'failed')
      .map(root => `${root.rootId}: ${root.error || root.actionSummary}`),
    roots,
  };
}

export async function prepareProjectColorRoot(
  input: IPrepareProjectColorRootInput,
): Promise<IPrepareProjectColorRootResult> {
  const action: TProjectColorAction = 'prepare_root';
  const context = await loadColorRootContext(input.workspaceRoot, input.projectId, input.rootId);
  const progressPath = resolveColorProgressPath(context.projectRoot, input.progressPath);
  const writeProgress: TWriteColorProgress = input.suppressProgress
    ? async (..._args) => undefined
    : writeColorProgress;
  const prepBlockers = dedupeStrings([
    !context.rootSummary.rawPath ? '当前 root 未配置 rawPath，无法进入 color prep。' : '',
    !context.rootSummary.rawLocalPath ? '当前设备未配置 rawLocalPath，无法在本机读取原始素材。' : '',
  ]);
  if (prepBlockers.length > 0) {
    await writeRootCurrent(context.projectRoot, context.rootId, current => ({
      ...current,
      mirrorStatus: 'blocked',
      timelineStatus: 'blocked',
      groupSyncStatus: current.groupSyncStatus,
      activeStage: 'sync_root_bins',
      currentJobId: undefined,
      detail: prepBlockers.join('；'),
      blockingReasons: dedupeStrings([...(current.blockingReasons ?? []), ...prepBlockers]),
    }));
    await writeProgress(progressPath, action, {
      status: 'failed',
      stepIndex: 1,
      current: 0,
      detail: prepBlockers.join('；'),
      extra: { projectId: input.projectId, rootId: input.rootId },
    });
    throw new ColorPrepBlockedError(prepBlockers);
  }
  const executor = resolveColorExecutor(context, input.executor);
  const hostPreflight = await ensureActionHostPreflight({
    context,
    action,
    executor,
    progressPath,
    suppressProgress: input.suppressProgress,
    extra: {
      projectId: input.projectId,
      rootId: input.rootId,
    },
  });
  const executorClips = await buildColorExecutorClips(
    context.rootSummary.rawLocalPath ?? '',
    context.runtimeConfig,
    context.rootSummary.colorSpaceProfile,
  );
  const syncedClipTransforms = await resolveExecutorClipTransforms(context, executorClips, {
    syncLuts: false,
    ignoreBlockers: true,
  });
  let preparedClipTransforms: Awaited<ReturnType<typeof resolveExecutorClipTransforms>>;
  try {
    preparedClipTransforms = await resolveExecutorClipTransforms(context, executorClips, {
      syncLuts: true,
    });
  } catch (error) {
    if (error instanceof ProjectColorBlockedError) {
      await failColorAction(context.projectRoot, context.rootId, progressPath, action, error.blockers, {
        projectId: input.projectId,
        rootId: input.rootId,
      }, {
        persistRootBlockers: false,
        suppressProgress: input.suppressProgress,
      });
    }
    throw error;
  }
  const timelineSpec = selectDominantTimelineSpec(executorClips);

  await writeRootCurrent(context.projectRoot, context.rootId, current => ({
    ...current,
    mirrorStatus: 'running',
    timelineStatus: 'idle',
    activeStage: 'sync_root_bins',
    currentJobId: input.jobId,
    detail: '正在调用 vendored Resolve backend 准备项目 / root bin / grading timeline。',
    blockingReasons: filterPersistentColorBlockers(current.blockingReasons ?? []),
  }));
  await writeProgress(progressPath, action, {
    status: 'running',
    stepIndex: 1,
    current: 0,
    detail: `正在为 ${context.rootId} 准备 Resolve root。`,
    extra: {
      projectId: input.projectId,
      rootId: context.rootId,
      resolveProjectName: context.rootSummary.resolveProjectName,
      gradingTimelineName: context.rootSummary.gradingTimelineName,
    },
  });

  let prepared: Awaited<ReturnType<IColorExecutor['prepareRoot']>>;
  try {
    prepared = await runColorHostWithRetry(
      () => executor.prepareRoot({
        projectId: input.projectId,
        rootId: context.rootId,
        resolveProjectName: context.rootSummary.resolveProjectName,
        rootNamespace: context.rootSummary.rootNamespace,
        gradingTimelineName: context.rootSummary.gradingTimelineName,
        rawPath: context.rootSummary.rawPath,
        rawLocalPath: context.rootSummary.rawLocalPath ?? '',
        repairDrxPath: join(context.workspaceRoot, 'config', 'default.drx'),
        timelineSpec,
        lutSyncSummary: preparedClipTransforms.lutSyncSummary,
        clips: preparedClipTransforms.clips,
      }),
      `prepare_root:${context.rootId}`,
    );
  } catch (error) {
    const blockers = [error instanceof Error ? error.message : String(error)];
    await failColorAction(context.projectRoot, context.rootId, progressPath, action, blockers, {
      projectId: input.projectId,
      rootId: context.rootId,
      resolveProjectName: context.rootSummary.resolveProjectName,
      gradingTimelineName: context.rootSummary.gradingTimelineName,
    }, {
      suppressProgress: input.suppressProgress,
    });
    throw error;
  }

  await writeRootCurrent(context.projectRoot, context.rootId, current => ({
    ...current,
    mirrorStatus: prepared.mirrorStatus,
    timelineStatus: 'running',
    activeStage: 'prepare_root_timeline',
    currentJobId: input.jobId,
    detail: 'Resolve host 已确认 root bin，正在对账 grading timeline。',
    blockingReasons: filterPersistentColorBlockers(current.blockingReasons ?? []),
  }));
  await writeProgress(progressPath, action, {
    status: 'running',
    stepIndex: 2,
    current: 1,
    detail: `正在准备 ${context.rootSummary.gradingTimelineName}。`,
    extra: {
      projectId: input.projectId,
      rootId: context.rootId,
      resolveProjectName: prepared.resolveProjectName,
      gradingTimelineName: prepared.gradingTimelineName,
    },
  });

  let syncedGroups: ReturnType<typeof materializeCurrentGroupsFromSnapshot> | undefined;
  let detail: string;
  let savedCurrent: Awaited<ReturnType<typeof writeRootCurrent>>;
  try {
    if (prepared.groupsSnapshot) {
      await saveColorGroupsSnapshot(context.projectRoot, prepared.groupsSnapshot);
    }
    syncedGroups = prepared.groupsSnapshot
      ? materializeCurrentGroupsFromSnapshot(
        prepared.groupsSnapshot,
        context.colorCurrent.roots.find(root => root.rootId === context.rootId)?.groups ?? [],
        context.groupsSnapshot,
      )
      : undefined;
    detail = [
      'Resolve host root prep 已完成。',
      prepared.groupsSnapshot
        ? `Kairos 已写入 ${prepared.groupsSnapshot.groups.length} 个 Resolve Groups 快照。`
        : 'Kairos 已持久化 root mirror / timeline current truth。',
      '如需复核 Resolve 内调整，可继续运行 Sync Groups。'
    ].join(' ');
    savedCurrent = await writeRootCurrent(context.projectRoot, context.rootId, current => ({
      ...current,
      mirrorStatus: prepared.mirrorStatus,
      timelineStatus: prepared.timelineStatus,
      groupSyncStatus: prepared.groupsSnapshot ? 'ready' : current.groupSyncStatus,
      groupSyncAt: prepared.groupsSnapshot?.syncedAt ?? current.groupSyncAt,
      activeStage: undefined,
      currentJobId: undefined,
      detail,
      hostSummary: prepared.hostSummary ?? current.hostSummary ?? {},
      groups: syncedGroups ?? current.groups,
      blockingReasons: filterPersistentColorBlockers(current.blockingReasons ?? []),
    }));
  } catch (error) {
    const blockers = [error instanceof Error ? error.message : String(error)];
    await failColorAction(context.projectRoot, context.rootId, progressPath, action, blockers, {
      projectId: input.projectId,
      rootId: context.rootId,
      resolveProjectName: prepared.resolveProjectName,
      gradingTimelineName: prepared.gradingTimelineName,
    }, {
      suppressProgress: input.suppressProgress,
    });
    throw error;
  }
  await writeProgress(progressPath, action, {
    status: 'succeeded',
    stepIndex: 2,
    current: CCOLOR_STEP_DEFINITIONS[action].length,
    detail,
    extra: {
      projectId: input.projectId,
      rootId: context.rootId,
      hostPreflight,
      hostSummary: prepared.hostSummary ?? {},
      transformWarnings: preparedClipTransforms.warnings,
      groupCount: prepared.groupsSnapshot?.groups.length,
    },
  });

  const savedRoot = savedCurrent.roots.find(root => root.rootId === context.rootId);
  return {
    action,
    projectId: input.projectId,
    rootId: context.rootId,
    resolveProjectName: prepared.resolveProjectName,
    rootNamespace: context.rootSummary.rootNamespace,
    gradingTimelineName: prepared.gradingTimelineName,
    mirrorStatus: savedRoot?.mirrorStatus,
    timelineStatus: savedRoot?.timelineStatus,
    blockingReasons: savedRoot?.blockingReasons ?? [],
    detail: savedRoot?.detail ?? detail,
  };
}

export async function syncProjectColorGroups(
  input: IProjectColorActionInput,
): Promise<IProjectColorActionResult> {
  const action: TProjectColorAction = 'sync_groups';
  const rootId = input.rootId?.trim();
  if (!rootId) {
    throw new ProjectColorBlockedError(['sync_groups requires rootId。']);
  }
  const context = await loadColorRootContext(input.workspaceRoot, input.projectId, rootId);
  const progressPath = resolveColorProgressPath(context.projectRoot, input.progressPath);
  const writeProgress: TWriteColorProgress = input.suppressProgress
    ? async (..._args) => undefined
    : writeColorProgress;
  const blockers = dedupeStrings([
    !context.rootSummary.rawPath ? '当前 root 未配置 rawPath，无法同步 Groups。' : '',
    !context.rootSummary.rawLocalPath ? '当前设备未配置 rawLocalPath，无法同步 Groups。' : '',
    context.rootSummary.colorCurrent.timelineStatus !== 'ready'
      ? '请先完成 prepare_root，再同步 Resolve Groups。'
      : '',
  ]);
  if (blockers.length > 0) {
    await failColorAction(context.projectRoot, context.rootId, progressPath, action, blockers, {
      projectId: input.projectId,
      rootId,
    }, {
      suppressProgress: input.suppressProgress,
    });
    throw new ProjectColorBlockedError(blockers);
  }
  const executor = resolveColorExecutor(context, input.executor);
  await ensureActionHostPreflight({
    context,
    action,
    executor,
    progressPath,
    suppressProgress: input.suppressProgress,
    extra: {
      projectId: input.projectId,
      rootId,
    },
  });
  const executorClips = await buildColorExecutorClips(
    context.rootSummary.rawLocalPath ?? '',
    context.runtimeConfig,
    context.rootSummary.colorSpaceProfile,
  );
  const syncedClipTransforms = await resolveExecutorClipTransforms(context, executorClips, {
    syncLuts: false,
    ignoreBlockers: true,
  });

  await writeRootCurrent(context.projectRoot, context.rootId, current => ({
    ...current,
    groupSyncStatus: 'running',
    activeStage: 'sync_groups',
    currentJobId: input.jobId,
    detail: '正在从 Resolve root timeline 同步正式 Groups。',
  }));
  await writeProgress(progressPath, action, {
    status: 'running',
    stepIndex: 1,
    current: 0,
    detail: `正在同步 ${context.rootSummary.gradingTimelineName} 的 Groups。`,
    extra: { projectId: input.projectId, rootId },
  });

  const snapshot = await runColorHostWithRetry(
    () => executor.syncGroups({
      projectId: input.projectId,
      rootId,
      resolveProjectName: context.rootSummary.resolveProjectName,
      gradingTimelineName: context.rootSummary.gradingTimelineName,
      rawPath: context.rootSummary.rawPath,
      rawLocalPath: context.rootSummary.rawLocalPath ?? '',
      clips: syncedClipTransforms.clips,
    }),
    `sync_groups:${context.rootId}`,
  );
  await saveColorGroupsSnapshot(context.projectRoot, snapshot);

  const savedCurrent = await writeRootCurrent(context.projectRoot, context.rootId, current => ({
    ...current,
    groupSyncStatus: 'ready',
    groupSyncAt: snapshot.syncedAt ?? new Date().toISOString(),
    activeStage: undefined,
    currentJobId: undefined,
    detail: `已同步 ${snapshot.groups.length} 个 Resolve Groups。`,
    groups: materializeCurrentGroupsFromSnapshot(snapshot, current.groups ?? [], context.groupsSnapshot),
  }));
  const detail = savedCurrent.roots.find(root => root.rootId === rootId)?.detail
    ?? `已同步 ${snapshot.groups.length} 个 Resolve Groups。`;
  await writeProgress(progressPath, action, {
    status: 'succeeded',
    stepIndex: 1,
    current: 1,
    detail,
    extra: {
      projectId: input.projectId,
      rootId,
      groupsPath: getColorGroupsSnapshotPath(context.projectRoot, rootId),
      groupCount: snapshot.groups.length,
    },
  });

  return {
    action,
    projectId: input.projectId,
    rootId,
    detail,
    blockingReasons: [],
  };
}

export async function executeProjectColorRoot(
  input: IProjectColorActionInput,
): Promise<IProjectColorActionResult> {
  const action: TProjectColorAction = 'execute_root';
  const rootId = input.rootId?.trim();
  if (!rootId) {
    throw new ProjectColorBlockedError(['execute_root requires rootId。']);
  }
  const context = await loadColorRootContext(input.workspaceRoot, input.projectId, rootId);
  const progressPath = resolveColorProgressPath(context.projectRoot, input.progressPath);
  const writeProgress: TWriteColorProgress = input.suppressProgress
    ? async (..._args) => undefined
    : writeColorProgress;
  const requestedClipKeys = dedupeStrings((input.clipKeys ?? []).map(clipKey => normalizePortablePath(String(clipKey ?? ''))));
  const blockers = dedupeStrings([
    !context.rootSummary.localPath ? '当前设备未配置 current localPath，无法在本机覆盖当前素材目录。' : '',
    !context.rootSummary.rawLocalPath ? '当前设备未配置 rawLocalPath，无法扫描原始素材。' : '',
    typeof context.rootSummary.renderPreset.bitrateKbps !== 'number'
      ? '未配置 root 级 renderPreset.bitrateKbps（kb/s），无法启动 execute_root。'
      : '',
  ]);
  if (blockers.length > 0) {
    await failColorAction(context.projectRoot, context.rootId, progressPath, action, blockers, {
      projectId: input.projectId,
      rootId,
    }, {
      suppressProgress: input.suppressProgress,
    });
    throw new ProjectColorBlockedError(blockers);
  }
  const executor = resolveColorExecutor(context, input.executor);
  const hostPreflight = await ensureActionHostPreflight({
    context,
    action,
    executor,
    progressPath,
    suppressProgress: input.suppressProgress,
    extra: {
      projectId: input.projectId,
      rootId,
    },
  });
  const renderPresetBlockers = validateRenderPresetSupport(context.rootSummary.renderPreset, hostPreflight);
  if (renderPresetBlockers.length > 0) {
    await failColorAction(context.projectRoot, context.rootId, progressPath, action, renderPresetBlockers, {
      projectId: input.projectId,
      rootId,
    }, {
      persistRootBlockers: false,
      suppressProgress: input.suppressProgress,
    });
    throw new ProjectColorBlockedError(renderPresetBlockers);
  }

  const rawInventory = await scanColorRawInventory(context.rootSummary.rawLocalPath ?? '');
  const inventoryByKey = new Map(rawInventory.map(entry => [entry.rawRelativePath, entry]));
  const effectiveClipKeys = requestedClipKeys.length > 0
    ? requestedClipKeys
    : rawInventory.map(entry => entry.rawRelativePath);
  const missingClipKeys = effectiveClipKeys.filter(clipKey => !inventoryByKey.has(clipKey));
  if (missingClipKeys.length > 0) {
    const missingBlockers = missingClipKeys.map(clipKey => `batch clip 不存在于 rawLocalPath: ${clipKey}`);
    await failColorAction(context.projectRoot, context.rootId, progressPath, action, missingBlockers, {
      projectId: input.projectId,
      rootId,
    }, {
      suppressProgress: input.suppressProgress,
    });
    throw new ProjectColorBlockedError(missingBlockers);
  }
  if (effectiveClipKeys.length === 0) {
    const emptyBlockers = ['当前 root 没有可执行 clip。'];
    await failColorAction(context.projectRoot, context.rootId, progressPath, action, emptyBlockers, {
      projectId: input.projectId,
      rootId,
    }, {
      suppressProgress: input.suppressProgress,
    });
    throw new ProjectColorBlockedError(emptyBlockers);
  }

  const batchId = randomUUID();
  const stagingRoot = join(context.projectRoot, '.tmp', 'color', batchId, 'render');
  await mkdir(stagingRoot, { recursive: true });
  const planEntries = await Promise.all(
    effectiveClipKeys.map(async clipKey => {
      const item = inventoryByKey.get(clipKey)!;
      return {
        rawRelativePath: clipKey,
        sourceAbsolutePath: item.sourceAbsolutePath,
        sourceMetadataSnapshot: await buildColorFileMetadataSnapshot(
          item.sourceAbsolutePath,
          context.runtimeConfig,
        ),
      };
    }),
  );

  const plan: IColorBatchPlan = {
    batchId,
    rootId,
    createdAt: new Date().toISOString(),
    stagingRoot,
    renderPreset: context.rootSummary.renderPreset,
    selectionMode: requestedClipKeys.length > 0 ? 'subset' : 'all',
    clipKeys: effectiveClipKeys,
    entries: planEntries,
  };
  await saveColorBatchPlan(context.projectRoot, plan);

  await writeRootCurrent(context.projectRoot, context.rootId, current => ({
    ...current,
    activeStage: 'render_root',
    currentJobId: input.jobId,
    detail: requestedClipKeys.length > 0
      ? `正在执行 root batch（${effectiveClipKeys.length} 个 clip 子集）。`
      : '正在执行 root timeline 渲染。',
    latestBatchId: batchId,
    latestBatchStatus: 'rendering',
    latestValidationStatus: 'pending',
    pendingPromoteBatchId: undefined,
    blockingReasons: filterPersistentColorBlockers(current.blockingReasons ?? []),
  }));
  await writeProgress(progressPath, action, {
    status: 'running',
    stepIndex: 1,
    current: 0,
    detail: `正在扫描 ${effectiveClipKeys.length} 个 raw clips。`,
    extra: {
      projectId: input.projectId,
      rootId,
      batchId,
      clipCount: effectiveClipKeys.length,
      selectionMode: plan.selectionMode,
    },
  });
  await writeProgress(progressPath, action, {
    status: 'running',
    stepIndex: 2,
    current: 1,
    detail: `正在执行 root batch：${batchId}`,
    extra: {
      projectId: input.projectId,
      rootId,
      batchId,
      stagingRoot,
      clipCount: effectiveClipKeys.length,
      selectionMode: plan.selectionMode,
    },
  });

  const rendered = await runColorHostWithRetry(
    () => executor.executeRoot({
      projectId: input.projectId,
      rootId,
      resolveProjectName: context.rootSummary.resolveProjectName,
      gradingTimelineName: context.rootSummary.gradingTimelineName,
      rawLocalPath: context.rootSummary.rawLocalPath ?? '',
      renderPreset: context.rootSummary.renderPreset,
      stagingRoot,
      selectionMode: plan.selectionMode,
      clips: planEntries.map(entry => ({
        rawRelativePath: entry.rawRelativePath,
        sourceAbsolutePath: entry.sourceAbsolutePath,
        sourceStem: deriveSourceStem(entry.rawRelativePath),
        width: entry.sourceMetadataSnapshot?.width,
        height: entry.sourceMetadataSnapshot?.height,
        fps: entry.sourceMetadataSnapshot?.fps,
      })),
    }),
    `execute_root:${context.rootId}:${batchId}`,
  );
  const planEntryByKey = new Map(planEntries.map(entry => [entry.rawRelativePath, entry]));
  const normalizedRenderedEntries = await Promise.all(
    rendered.entries.map(async entry => {
      const sourceMetadataSnapshot = planEntryByKey.get(entry.rawRelativePath)?.sourceMetadataSnapshot;
      const normalizedOutputPath = await normalizeRenderedColorOutputMetadata(
        entry.outputPath,
        sourceMetadataSnapshot,
        context.runtimeConfig,
      );
      return {
        ...entry,
        outputPath: normalizedOutputPath,
        sourceMetadataSnapshot,
      };
    }),
  );

  const manifestEntries = await Promise.all(
    normalizedRenderedEntries.map(async entry => {
      const relativeDir = posix.dirname(entry.rawRelativePath);
      const promoteRelativePath = normalizePortablePath(
        relativeDir === '.'
          ? entry.normalizedOutputFilename
          : posix.join(relativeDir, entry.normalizedOutputFilename),
      );
      return {
        rawRelativePath: entry.rawRelativePath,
        stagingRelativePath: normalizePortablePath(relative(stagingRoot, entry.outputPath)),
        stagingAbsolutePath: resolve(entry.outputPath),
        promoteRelativePath,
        promoteTargetPath: resolve(join(context.rootSummary.localPath ?? '', ...promoteRelativePath.split('/'))),
        normalizedOutputFilename: entry.normalizedOutputFilename,
        sourceMetadataSnapshot: entry.sourceMetadataSnapshot,
        outputMetadataSnapshot: await buildColorFileMetadataSnapshot(entry.outputPath, context.runtimeConfig).catch(() => undefined),
      };
    }),
  );
  const manifest: IColorBatchManifest = {
    batchId,
    rootId,
    createdAt: rendered.renderedAt,
    renderPreset: context.rootSummary.renderPreset,
    managedOutputSet: manifestEntries.map(entry => entry.promoteRelativePath),
    entries: manifestEntries,
  };
  await saveColorBatchManifest(context.projectRoot, manifest);

  const savedCurrent = await writeRootCurrent(context.projectRoot, context.rootId, current => ({
    ...current,
    activeStage: undefined,
    currentJobId: undefined,
    detail: `root batch 已完成，待 validation：${batchId}`,
    latestBatchId: batchId,
    latestBatchStatus: 'staged',
    latestValidationStatus: 'pending',
    pendingPromoteBatchId: undefined,
    blockingReasons: [],
  }));
  const detail = savedCurrent.roots.find(root => root.rootId === rootId)?.detail
    ?? `root batch 已完成，待 validation：${batchId}`;
  await writeProgress(progressPath, action, {
    status: 'succeeded',
    stepIndex: 2,
    current: 2,
    detail,
    extra: {
      projectId: input.projectId,
      rootId,
      batchId,
      clipCount: effectiveClipKeys.length,
      selectionMode: plan.selectionMode,
    },
  });

  return {
    action,
    projectId: input.projectId,
    rootId,
    batchId,
    detail,
    blockingReasons: [],
  };
}

export async function validateProjectColorBatch(
  input: IProjectColorActionInput,
): Promise<IProjectColorActionResult> {
  const action: TProjectColorAction = 'validate_batch';
  const rootId = input.rootId?.trim();
  if (!rootId) {
    throw new ProjectColorBlockedError(['validate_batch requires rootId。']);
  }
  const context = await loadColorRootContext(input.workspaceRoot, input.projectId, rootId);
  const progressPath = resolveColorProgressPath(context.projectRoot, input.progressPath);
  const writeProgress: TWriteColorProgress = input.suppressProgress
    ? async (..._args) => undefined
    : writeColorProgress;
  const batchId = input.batchId?.trim();
  const blockers = dedupeStrings([
    !batchId ? 'validate_batch requires args.batchId。' : '',
  ]);
  if (blockers.length > 0) {
    await failColorAction(context.projectRoot, context.rootId, progressPath, action, blockers, {
      projectId: input.projectId,
      rootId,
      batchId,
    }, {
      suppressProgress: input.suppressProgress,
    });
    throw new ProjectColorBlockedError(blockers);
  }

  const [plan, manifest] = await Promise.all([
    loadColorBatchPlan(context.projectRoot, batchId!),
    loadColorBatchManifest(context.projectRoot, batchId!),
  ]);
  const ioBlockers = dedupeStrings([
    !plan ? `缺少 batch plan: ${batchId}` : '',
    !manifest ? `缺少 batch manifest: ${batchId}` : '',
    plan && plan.rootId !== rootId ? `batch ${batchId} 不属于 root ${rootId}` : '',
  ]);
  if (ioBlockers.length > 0) {
    await failColorAction(context.projectRoot, context.rootId, progressPath, action, ioBlockers, {
      projectId: input.projectId,
      rootId,
      batchId,
    }, {
      suppressProgress: input.suppressProgress,
    });
    throw new ProjectColorBlockedError(ioBlockers);
  }

  await writeProgress(progressPath, action, {
    status: 'running',
    stepIndex: 1,
    current: 0,
    detail: `正在校验 batch：${batchId}`,
    extra: { projectId: input.projectId, rootId, batchId },
  });

  const validationEntries = await Promise.all(
    (manifest?.entries ?? []).map(async entry => {
      const sourcePath = plan?.entries.find(item => item.rawRelativePath === entry.rawRelativePath)?.sourceAbsolutePath
        ?? resolve(join(context.rootSummary.rawLocalPath ?? '', ...entry.rawRelativePath.split('/')));
      const sourceMetadata = await buildColorFileMetadataSnapshot(sourcePath, context.runtimeConfig).catch(() => undefined);
      const outputMetadata = await buildColorFileMetadataSnapshot(entry.stagingAbsolutePath, context.runtimeConfig).catch(() => undefined);
      const checks = buildColorValidationChecks({
        rawRelativePath: entry.rawRelativePath,
        promoteRelativePath: entry.promoteRelativePath,
        normalizedOutputFilename: entry.normalizedOutputFilename,
        sourceMetadata,
        outputMetadata,
      });
      const warnings = collectValidationWarnings(checks);
      const reasons = collectValidationReasons(checks, {
        sourcePath,
        outputPath: entry.stagingAbsolutePath,
      });
      return {
        rawRelativePath: entry.rawRelativePath,
        stagingRelativePath: entry.stagingRelativePath,
        promoteTargetPath: entry.promoteTargetPath,
        status: (reasons.length > 0 ? 'fail' : 'pass') as 'pass' | 'fail',
        reasons,
        warnings,
        checks,
      };
    }),
  );

  const validationStatus = validationEntries.some(entry => entry.status === 'fail')
    ? 'fail'
    : 'pass';
  const validationBlockingReasons = dedupeStrings(validationEntries.flatMap(entry => entry.reasons));
  const validation: IColorBatchValidation = {
    batchId: batchId!,
    rootId,
    validatedAt: new Date().toISOString(),
    status: validationStatus,
    summary: {
      targetCount: plan?.entries.length ?? manifest?.entries.length ?? validationEntries.length,
      renderedCount: manifest?.entries.length ?? validationEntries.length,
      passedCount: validationEntries.filter(entry => entry.status === 'pass').length,
      failedCount: validationEntries.filter(entry => entry.status === 'fail').length,
    },
    blockingReasons: validationBlockingReasons,
    warnings: dedupeStrings(validationEntries.flatMap(entry => entry.warnings ?? [])),
    entries: validationEntries,
  };
  await saveColorBatchValidation(context.projectRoot, validation);

  const currentRoot = context.colorCurrent.roots.find(root => root.rootId === rootId);
  const latestBatchMatches = currentRoot?.latestBatchId === batchId;
  const savedCurrent = await writeRootCurrent(context.projectRoot, context.rootId, current => latestBatchMatches
    ? {
      ...current,
      latestBatchId: batchId,
      latestBatchStatus: validationStatus === 'pass' ? 'validated' : 'failed',
      latestValidationStatus: validationStatus,
      pendingPromoteBatchId: validationStatus === 'pass' ? batchId : undefined,
      blockingReasons: validationStatus === 'pass'
        ? []
        : validationBlockingReasons,
      detail: validationStatus === 'pass'
        ? `batch 已通过 validation，可 promote：${batchId}`
        : `batch validation 失败：${batchId}`,
    }
    : {
      ...current,
      detail: `batch ${batchId} 已完成 validation，但它已不是当前最新候选。`,
    });
  const detail = savedCurrent.roots.find(root => root.rootId === rootId)?.detail
    ?? `batch ${batchId} validation 已完成。`;
  await writeProgress(progressPath, action, {
    status: validationStatus === 'pass' ? 'succeeded' : 'failed',
    stepIndex: 1,
    current: 1,
    detail,
    extra: {
      projectId: input.projectId,
      rootId,
      batchId,
      validationStatus,
    },
  });

  return {
    action,
    projectId: input.projectId,
    rootId,
    batchId,
    detail,
    blockingReasons: validationStatus === 'pass'
      ? []
      : validationBlockingReasons,
  };
}

export async function promoteProjectColorBatch(
  input: IProjectColorActionInput,
): Promise<IProjectColorActionResult> {
  const action: TProjectColorAction = 'promote_batch';
  const rootId = input.rootId?.trim();
  if (!rootId) {
    throw new ProjectColorBlockedError(['promote_batch requires rootId。']);
  }
  const context = await loadColorRootContext(input.workspaceRoot, input.projectId, rootId);
  const progressPath = resolveColorProgressPath(context.projectRoot, input.progressPath);
  const writeProgress: TWriteColorProgress = input.suppressProgress
    ? async (..._args) => undefined
    : writeColorProgress;
  const batchId = input.batchId?.trim();
  const [manifest, validation] = await Promise.all([
    batchId ? loadColorBatchManifest(context.projectRoot, batchId) : Promise.resolve(null),
    batchId ? loadColorBatchValidation(context.projectRoot, batchId) : Promise.resolve(null),
  ]);
  const currentRoot = context.colorCurrent.roots.find(root => root.rootId === rootId) ?? null;
  const blockers = dedupeStrings([
    !batchId ? 'promote_batch requires args.batchId。' : '',
    !manifest ? `缺少 batch manifest: ${batchId ?? '(missing)'}` : '',
    !validation ? `缺少 batch validation: ${batchId ?? '(missing)'}` : '',
    validation && validation.status !== 'pass' ? `batch ${batchId} 尚未通过 validation。` : '',
    !context.rootSummary.localPath ? '当前设备未配置 current localPath，无法覆盖当前素材目录。' : '',
    !currentRoot ? `当前 root 未记录 color current。` : '',
    currentRoot && currentRoot.latestBatchId !== batchId
      ? `batch ${batchId} 已被更新的候选取代，不能再 promote。`
      : '',
  ]);
  if (blockers.length > 0) {
    await failColorAction(context.projectRoot, context.rootId, progressPath, action, blockers, {
      projectId: input.projectId,
      rootId,
      batchId,
    }, {
      suppressProgress: input.suppressProgress,
    });
    throw new ProjectColorBlockedError(blockers);
  }

  await writeProgress(progressPath, action, {
    status: 'running',
    stepIndex: 1,
    current: 0,
    detail: `正在 promote batch：${batchId}`,
    extra: { projectId: input.projectId, rootId, batchId },
  });

  const previousPromote = currentRoot?.lastPromotedBatchId
    ? await loadColorBatchManifest(context.projectRoot, currentRoot.lastPromotedBatchId)
    : null;
  const deletedOutputs = await deleteManagedOutputs(
    context.rootSummary.localPath ?? '',
    previousPromote?.managedOutputSet ?? [],
    manifest?.managedOutputSet ?? [],
  );
  const copiedOutputs = await copyManagedOutputs(context.rootSummary.localPath ?? '', manifest!);
  const promote: IColorBatchPromote = {
    batchId: batchId!,
    rootId,
    promotedAt: new Date().toISOString(),
    status: 'completed',
    outputs: copiedOutputs,
    deletedOutputs,
    detail: `已 promote ${copiedOutputs.length} 个输出到当前素材目录。`,
  };
  await saveColorBatchPromote(context.projectRoot, promote);

  const savedCurrent = await writeRootCurrent(context.projectRoot, context.rootId, current => ({
    ...current,
    latestBatchId: batchId,
    latestBatchStatus: 'promoted',
    latestValidationStatus: 'pass',
    pendingPromoteBatchId: undefined,
    lastPromotedBatchId: batchId,
    blockingReasons: [],
    detail: promote.detail,
  }));
  const detail = savedCurrent.roots.find(root => root.rootId === rootId)?.detail ?? promote.detail ?? 'promote 完成。';
  await writeProgress(progressPath, action, {
    status: 'succeeded',
    stepIndex: 1,
    current: 1,
    detail,
    extra: {
      projectId: input.projectId,
      rootId,
      batchId,
      outputCount: copiedOutputs.length,
    },
  });

  return {
    action,
    projectId: input.projectId,
    rootId,
    batchId,
    detail,
    blockingReasons: [],
  };
}

async function loadEnabledProjectColorRootSummaries(
  workspaceRoot: string,
  projectId: string,
) {
  const projectRoot = resolveWorkspaceProjectRoot(workspaceRoot, projectId);
  const [projectBrief, projectRoots, deviceMaps, colorCurrent, groupSnapshotsByRootId] = await Promise.all([
    loadProjectBriefConfig(projectRoot).catch(() => null),
    loadIngestRoots(projectRoot),
    loadProjectDeviceMediaMaps(projectRoot),
    loadColorCurrent(projectRoot),
    loadColorGroupsSnapshots(projectRoot),
  ]);
  const colorWorkspace = buildColorWorkspaceState({
    projectId,
    projectName: projectBrief?.name,
    projectRoots: projectRoots.roots.filter(root => root.enabled !== false),
    deviceProjectMap: deviceMaps.projects[projectId],
    colorCurrent,
    resolveBackend: inspectResolveColorBackend(),
    groupSnapshotsByRootId,
  });
  return colorWorkspace.colorRoots;
}

async function loadColorRootContext(
  workspaceRoot: string,
  projectId: string,
  rootId: string,
): Promise<IColorRootContext> {
  const projectRoot = resolveWorkspaceProjectRoot(workspaceRoot, projectId);
  const [projectBrief, projectRoots, deviceMaps, colorCurrent, runtimeConfig, groupSnapshotsByRootId, transformPresetsConfig] = await Promise.all([
    loadProjectBriefConfig(projectRoot).catch(() => null),
    loadIngestRoots(projectRoot),
    loadProjectDeviceMediaMaps(projectRoot),
    loadColorCurrent(projectRoot),
    loadRuntimeConfig(projectRoot),
    loadColorGroupsSnapshots(projectRoot),
    loadColorTransformPresetsConfig(workspaceRoot).catch(() => ({
      profiles: {},
      discoveredPresets: {},
    })),
  ]);
  const colorWorkspace = buildColorWorkspaceState({
    projectId,
    projectName: projectBrief?.name,
    projectRoots: projectRoots.roots,
    deviceProjectMap: deviceMaps.projects[projectId],
    colorCurrent,
    resolveBackend: inspectResolveColorBackend(),
    groupSnapshotsByRootId,
  });
  const rootSummary = colorWorkspace.colorRoots.find(root => root.rootId === rootId);
  if (!rootSummary) {
    throw new ProjectColorBlockedError([`color root 不存在或未配置 rawPath: ${rootId}`]);
  }
  return {
    workspaceRoot,
    projectRoot,
    projectId,
    rootId,
    rootSummary,
    colorCurrent,
    runtimeConfig,
    transformPresetsConfig,
    groupsSnapshot: await loadColorGroupsSnapshot(projectRoot, rootId),
  };
}

function resolveColorExecutor(
  context: IColorRootContext,
  executor?: IColorExecutor,
): IColorExecutor {
  if (executor) return executor;
  try {
    return new PythonResolveColorExecutor();
  } catch (error) {
    if (error instanceof ResolveColorExecutorUnavailableError) {
      throw new ProjectColorBlockedError([error.message]);
    }
    throw error;
  }
}

function resolveColorProgressPath(projectRoot: string, progressPath?: string): string {
  return progressPath ?? getProjectProgressPath(projectRoot, 'color');
}

function normalizeColorAction(action?: string): TProjectColorAction {
  const normalized = action?.trim() || 'prepare_root';
  switch (normalized) {
    case 'prepare_root':
    case 'sync_groups':
    case 'execute_root':
    case 'validate_batch':
    case 'promote_batch':
    case 'prepare_all_roots':
    case 'export_all_roots':
      return normalized;
    default:
      throw new Error(`Unsupported color action: ${normalized}`);
  }
}

async function writeRootCurrent(
  projectRoot: string,
  rootId: string,
  updater: (current: IColorRootCurrent) => IColorRootCurrent,
): Promise<IColorCurrent> {
  const existing = await loadColorCurrent(projectRoot);
  const currentRoot = existing.roots.find(root => root.rootId === rootId) ?? {
    rootId,
    hostSummary: {},
    groups: [],
    blockingReasons: [],
  };
  const nextRoot = updater(currentRoot);
  const nextRoots = existing.roots.some(root => root.rootId === rootId)
    ? existing.roots.map(root => (root.rootId === rootId ? nextRoot : root))
    : [...existing.roots, nextRoot];
  return saveColorCurrent(projectRoot, {
    ...existing,
    selectedRootId: rootId,
    roots: nextRoots,
    updatedAt: new Date().toISOString(),
  });
}

function materializeCurrentGroupsFromSnapshot(
  snapshot: IColorGroupsSnapshotFile,
  existingGroups: IColorRootCurrent['groups'],
  previousSnapshot?: IColorGroupsSnapshotFile | null,
): IColorGroupCurrent[] {
  const existingByKey = new Map((existingGroups ?? []).map(group => [group.groupKey, group]));
  const previousByKey = new Map((previousSnapshot?.groups ?? []).map(group => [group.groupKey, group]));
  return snapshot.groups.map(group => {
    const existing = existingByKey.get(group.groupKey);
    const previousGroup = previousByKey.get(group.groupKey);
    const clipKeysChanged = !sameStringSet(previousGroup?.clipKeys ?? [], group.clipKeys ?? []);
    const nextStatus = group.clipKeys.length > 0 ? 'ready' : 'blocked';
    return {
      groupKey: group.groupKey,
      status: nextStatus,
      displayName: existing?.displayName ?? group.displayName,
      clipCount: group.clipKeys.length,
      logProfile: group.logProfile ?? existing?.logProfile,
      lowlight: group.lowlight ?? existing?.lowlight,
      postClipCreativeStatus: group.postClipCreativeStatus ?? existing?.postClipCreativeStatus,
      blockingReasons: nextStatus === 'blocked'
        ? dedupeStrings([...(clipKeysChanged ? [] : existing?.blockingReasons ?? []), '该 Group 当前没有可执行 clip。'])
        : [],
    };
  });
}

async function writeColorProgress(
  progressPath: string,
  action: TProjectColorAction,
  input: {
    status: 'running' | 'succeeded' | 'failed';
    stepIndex: number;
    current: number;
    detail: string;
    extra: Record<string, unknown>;
  },
) {
  const definitions = CCOLOR_STEP_DEFINITIONS[action];
  await writeKairosProgress(progressPath, {
    status: input.status,
    pipelineKey: 'color',
    pipelineLabel: '达芬奇调色流程',
    phaseKey: action,
    phaseLabel: `Color ${action}`,
    step: definitions[input.stepIndex - 1]?.key,
    stepLabel: definitions[input.stepIndex - 1]?.label,
    stepIndex: input.stepIndex,
    stepTotal: definitions.length,
    stepDefinitions: definitions.map(step => ({ key: step.key, label: step.label })),
    current: input.current,
    total: definitions.length,
    unit: 'step',
    detail: input.detail,
    extra: input.extra,
  });
}

async function failColorAction(
  projectRoot: string,
  rootId: string,
  progressPath: string,
  action: TProjectColorAction,
  blockers: string[],
  extra: Record<string, unknown>,
  options: {
    persistRootBlockers?: boolean;
    suppressProgress?: boolean;
  } = {},
) {
  await writeRootCurrent(projectRoot, rootId, current => ({
    ...current,
    ...(action === 'prepare_root'
      ? {
          mirrorStatus: 'blocked' as const,
          timelineStatus: 'blocked' as const,
          groupSyncStatus: current.groupSyncStatus,
        }
      : {}),
    activeStage: CCOLOR_STEP_DEFINITIONS[action][0]?.key,
    currentJobId: undefined,
    detail: blockers.join('；'),
    blockingReasons: options.persistRootBlockers === false
      ? current.blockingReasons ?? []
      : dedupeStrings([...(current.blockingReasons ?? []), ...blockers]),
    ...(action === 'sync_groups' ? { groupSyncStatus: 'blocked' as const } : {}),
  }));
  if (!options.suppressProgress) {
    await writeColorProgress(progressPath, action, {
      status: 'failed',
      stepIndex: 1,
      current: 0,
      detail: blockers.join('；'),
      extra,
    });
  }
}

function filterPersistentColorBlockers(blockers: string[]): string[] {
  return blockers.filter(blocker => (
    !blocker.includes('vendored Resolve backend')
    && !blocker.includes('Resolve Studio')
    && !blocker.includes('Resolve 版本')
    && !blocker.includes('renderPreset')
    && !blocker.includes('render preset')
    && !blocker.includes('resolveColorPythonPath')
    && !blocker.includes('resolveColorScriptApiRoot')
    && !blocker.includes('config/runtime.json')
  ));
}

async function scanColorRawInventory(rawLocalPath: string): Promise<Array<{
  rawRelativePath: string;
  sourceAbsolutePath: string;
}>> {
  const scanned = await scanDirectory(rawLocalPath);
  return scanned
    .filter(file => file.kind === 'video')
    .map(file => ({
      rawRelativePath: normalizePortablePath(toPortableRelativePath(rawLocalPath, file.path)),
      sourceAbsolutePath: resolve(file.path),
    }));
}

async function buildColorExecutorClips(
  rawLocalPath: string,
  runtimeConfig: Awaited<ReturnType<typeof loadRuntimeConfig>>,
  rootColorSpaceProfile?: IColorRootContext['rootSummary']['colorSpaceProfile'],
): Promise<IColorExecutorClipInput[]> {
  const inventory = await scanColorRawInventory(rawLocalPath);
  return Promise.all(
    inventory.map(async item => {
      const probed = await probe(item.sourceAbsolutePath, runtimeConfig).catch(() => null);
      const captureTime = probed
        ? await resolveCaptureTime(item.sourceAbsolutePath, probed).catch(() => null)
        : null;
      const [sourceTruth, lowlightClassification] = await Promise.all([
        extractColorSourceTruth(item.sourceAbsolutePath, runtimeConfig).catch(() => ({
          logProfile: undefined,
          gyro: undefined,
          deviceFamilyKeys: [],
          sourceKinds: [],
        })),
        classifyFirstFrameLowlight(item.sourceAbsolutePath, runtimeConfig).catch(() => ({
          lowlight: false,
          metrics: undefined,
        })),
      ]);
      const profileResolution = resolveEffectiveColorProfile(
        sourceTruth.logProfile,
        rootColorSpaceProfile,
      );
      return {
        rawRelativePath: item.rawRelativePath,
        sourceAbsolutePath: item.sourceAbsolutePath,
        sourceStem: deriveSourceStem(item.rawRelativePath),
        capturedAt: captureTime?.capturedAt,
        width: probed?.width ?? undefined,
        height: probed?.height ?? undefined,
        fps: probed?.fps ?? undefined,
        codec: probed?.codec ?? undefined,
        rawTags: probed?.rawTags ?? {},
        detectedProfile: profileResolution.detectedProfile,
        effectiveProfile: profileResolution.effectiveProfile,
        profileSource: profileResolution.profileSource,
        logProfile: profileResolution.logProfile,
        gyroEligible: sourceTruth.gyro,
        lowlight: lowlightClassification.lowlight,
        deviceFamilyKeys: sourceTruth.deviceFamilyKeys,
      } satisfies IColorExecutorClipInput;
    }),
  );
}

async function resolveExecutorClipTransforms(
  context: IColorRootContext,
  clips: IColorExecutorClipInput[],
  options: {
    syncLuts: boolean;
    ignoreBlockers?: boolean;
  },
): Promise<{
  clips: IColorExecutorClipInput[];
  warnings: string[];
  lutSyncSummary: IResolveLutSyncSummary;
}> {
  const resolved = resolveClipTransformSeeds(
    clips.map(clip => ({
      rawRelativePath: clip.rawRelativePath,
      detectedProfile: clip.detectedProfile,
      effectiveProfile: clip.effectiveProfile,
      profileSource: clip.profileSource ?? 'unknown',
      logProfile: clip.logProfile,
      deviceFamilyKeys: clip.deviceFamilyKeys,
    })),
    context.transformPresetsConfig,
    context.rootSummary.transformPresetKey,
  );
  if (resolved.blockers.length > 0 && !options.ignoreBlockers) {
    throw new ProjectColorBlockedError(resolved.blockers);
  }

  const lutSyncSummary = options.syncLuts
    ? await syncReferencedResolveLuts({
      workspaceRoot: context.workspaceRoot,
      relativeLutPaths: resolved.blockers.length > 0 ? [] : resolved.referencedRelativeLutPaths,
      resolveLutRoot: resolved.resolveLutRoot,
    }).catch(error => {
      throw new ProjectColorBlockedError([String(error instanceof Error ? error.message : error)]);
    })
    : {
      status: resolved.blockers.length > 0
        ? 'not-needed'
        : resolved.referencedRelativeLutPaths.length > 0
          ? 'ready'
          : 'not-needed',
      targetRoot: resolved.resolveLutRoot,
      copiedCount: 0,
      reusedCount: resolved.blockers.length > 0 ? 0 : resolved.referencedRelativeLutPaths.length,
      copiedLuts: [],
      reusedLuts: resolved.blockers.length > 0 ? [] : resolved.referencedRelativeLutPaths,
    } satisfies IResolveLutSyncSummary;

  const clipByKey = new Map(clips.map(clip => [clip.rawRelativePath, clip]));
  return {
    clips: resolved.clips.map(resolvedClip => ({
      ...clipByKey.get(resolvedClip.rawRelativePath),
      detectedProfile: resolvedClip.detectedProfile,
      effectiveProfile: resolvedClip.effectiveProfile,
      profileSource: resolvedClip.profileSource,
      logProfile: resolvedClip.logProfile,
      resolvedTransformPresetKey: resolvedClip.resolvedTransformPresetKey,
      resolvedLutRelativePath: resolvedClip.resolvedLutRelativePath,
      resolvedLutAbsolutePath: resolvedClip.resolvedLutAbsolutePath,
    }) as IColorExecutorClipInput),
    warnings: resolved.blockers.length > 0
      ? [...resolved.warnings, ...resolved.blockers]
      : resolved.warnings,
    lutSyncSummary,
  };
}

function sameStringSet(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const leftSorted = [...left].sort();
  const rightSorted = [...right].sort();
  return leftSorted.every((value, index) => value === rightSorted[index]);
}

async function buildColorFileMetadataSnapshot(
  filePath: string,
  runtimeConfig: Awaited<ReturnType<typeof loadRuntimeConfig>>,
): Promise<IColorFileMetadataSnapshot> {
  const probed = await probe(filePath, runtimeConfig);
  const captureTime = await resolveCaptureTime(filePath, probed).catch(() => null);
  const stats = await stat(filePath).catch(() => null);
  const lowerExt = filePath.includes('.')
    ? filePath.slice(filePath.lastIndexOf('.'))
    : '';
  const mediaKind = classifyExt(lowerExt.toLowerCase()) ?? undefined;
  return {
    mediaKind,
    width: probed.width ?? undefined,
    height: probed.height ?? undefined,
    fps: probed.fps ?? undefined,
    durationMs: probed.durationMs ?? undefined,
    capturedAt: captureTime?.capturedAt,
    createTime: probed.rawTags['createdate'] || probed.creationTime || probed.rawTags['gpsdatetime'] || undefined,
    gps: extractGpsTuple(probed.rawTags),
    filesystemCreateTime: stats?.birthtime ? stats.birthtime.toISOString() : undefined,
  };
}

function extractGpsTuple(rawTags: Record<string, string>): [number, number] | undefined {
  const iso6709 = firstTrimmedString(
    rawTags['location'],
    rawTags['location-eng'],
    rawTags['location_eng'],
    rawTags['com.apple.quicktime.location.iso6709'],
    rawTags['com.apple.quicktime.location_iso6709'],
  );
  const parsedIso6709 = parseIso6709(iso6709);
  if (parsedIso6709) {
    return [parsedIso6709.lat, parsedIso6709.lng];
  }
  const lat = parseMaybeNumber(rawTags['gpslatitude']);
  const lng = parseMaybeNumber(rawTags['gpslongitude']);
  if (lat == null || lng == null) return undefined;
  return [lat, lng];
}

function parseMaybeNumber(value: string | undefined): number | undefined {
  if (!value?.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function firstTrimmedString(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (!value?.trim()) continue;
    return value.trim();
  }
  return undefined;
}

function parseIso6709(value?: string): { lat: number; lng: number } | undefined {
  if (!value) return undefined;
  const match = value.trim().match(/^([+-]\d{1,2}(?:\.\d+)?)([+-]\d{1,3}(?:\.\d+)?)(?:[+-]\d+(?:\.\d+)?)?\/?$/u);
  if (!match?.[1] || !match[2]) return undefined;
  const lat = Number(match[1]);
  const lng = Number(match[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return undefined;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return undefined;
  return { lat, lng };
}

async function normalizeRenderedColorOutputMetadata(
  outputPath: string,
  sourceMetadataSnapshot: IColorFileMetadataSnapshot | undefined,
  runtimeConfig: Awaited<ReturnType<typeof loadRuntimeConfig>>,
): Promise<string> {
  if (!sourceMetadataSnapshot?.capturedAt && !sourceMetadataSnapshot?.gps) {
    return resolve(outputPath);
  }

  const ffmpeg = runtimeConfig.ffmpegPath?.trim() || 'ffmpeg';
  const resolvedOutputPath = resolve(outputPath);
  const tempPath = join(
    dirname(resolvedOutputPath),
    `.kairos-meta-${randomUUID()}${extname(resolvedOutputPath) || '.mp4'}`,
  );
  const args = [
    '-y',
    '-i',
    toExecutableInputPath(resolvedOutputPath, ffmpeg),
    '-map',
    '0',
    '-dn',
    '-c',
    'copy',
    '-movflags',
    'use_metadata_tags',
  ];
  if (sourceMetadataSnapshot.capturedAt) {
    args.push('-metadata', `creation_time=${sourceMetadataSnapshot.capturedAt}`);
  }
  if (sourceMetadataSnapshot.gps) {
    args.push('-metadata', `location=${formatIso6709(sourceMetadataSnapshot.gps)}`);
  }
  args.push(toExecutableInputPath(tempPath, ffmpeg));

  try {
    await exec(ffmpeg, args, {
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
      env: buildStableToolExecEnv(),
      windowsHide: true,
    });
    await unlink(resolvedOutputPath).catch(() => undefined);
    await rename(tempPath, resolvedOutputPath);
    return resolvedOutputPath;
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw new Error(
      `无法归一 color 输出 metadata：${resolvedOutputPath} (${String(error instanceof Error ? error.message : error)})`,
    );
  }
}

function formatIso6709(gps: [number, number]): string {
  return `${formatSignedCoordinate(gps[0])}${formatSignedCoordinate(gps[1])}/`;
}

function formatSignedCoordinate(value: number): string {
  const sign = value >= 0 ? '+' : '-';
  const normalized = Math.abs(value).toFixed(8).replace(/\.?0+$/u, '');
  return `${sign}${normalized}`;
}

function buildStableToolExecEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    LC_ALL: 'C',
    LANG: 'C',
    LC_CTYPE: 'C',
  };
}

async function ensureActionHostPreflight(input: {
  context: IColorRootContext;
  action: TProjectColorAction;
  executor: IColorExecutor;
  progressPath: string;
  suppressProgress?: boolean;
  extra: Record<string, unknown>;
}): Promise<IColorHostPreflight> {
  const preflight = await runColorHostPreflight({
    projectRoot: input.context.projectRoot,
    projectId: input.context.projectId,
    rootId: input.context.rootId,
    resolveProjectName: input.context.rootSummary.resolveProjectName,
    executor: input.executor,
  });
  await saveColorHostPreflight(input.context.projectRoot, preflight);
  if (preflight.status === 'blocked') {
    const blockers = preflight.blockingReasons.length > 0
      ? preflight.blockingReasons
      : ['Resolve host preflight blocked this action.'];
    await failColorAction(
      input.context.projectRoot,
      input.context.rootId,
      input.progressPath,
      input.action,
      blockers,
      input.extra,
      { persistRootBlockers: false, suppressProgress: input.suppressProgress },
    );
    throw new ProjectColorBlockedError(blockers);
  }
  await writeRootCurrent(input.context.projectRoot, input.context.rootId, current => ({
    ...current,
    blockingReasons: filterPersistentColorBlockers(current.blockingReasons ?? []),
  }));
  return preflight;
}

async function runColorHostPreflight(input: {
  projectRoot: string;
  projectId: string;
  rootId?: string;
  resolveProjectName: string;
  executor?: IColorExecutor;
}): Promise<IColorHostPreflight> {
  if (!input.executor) {
    const resolveBackend = inspectResolveColorBackend();
    if (!resolveBackend.available) {
      return normalizeHostPreflight({
        status: 'blocked',
        checkedAt: new Date().toISOString(),
        warnings: [],
        blockingReasons: resolveBackend.blockingReason ? [resolveBackend.blockingReason] : [],
        renderSupport: {
          containers: [],
          supportsAudioCodec: false,
          supportsVideoQuality: false,
        },
      });
    }
  }

  const executor = input.executor ?? new PythonResolveColorExecutor();
  try {
    return normalizeHostPreflight(
      await runColorHostWithRetry(
        () => executor.preflight({
          projectId: input.projectId,
          rootId: input.rootId,
          resolveProjectName: input.resolveProjectName,
        }),
        `preflight:${input.projectId}:${input.rootId ?? 'all'}`,
      ),
    );
  } catch (error) {
    if (error instanceof ResolveColorHostError) {
      return normalizeHostPreflight(mapHostErrorToPreflight(error));
    }
    throw error;
  }
}

async function saveColorHostPreflight(projectRoot: string, hostPreflight: IColorHostPreflight): Promise<void> {
  await saveColorCurrent(projectRoot, {
    roots: [],
    hostPreflight: normalizeHostPreflight(hostPreflight),
    updatedAt: new Date().toISOString(),
  });
}

async function runColorHostWithRetry<T>(
  operation: () => Promise<T>,
  label: string,
): Promise<T> {
  const retryDelaysMs = [1000, 2000, 4000];
  let lastError: unknown;
  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isRetryableColorHostError(error) || attempt >= retryDelaysMs.length) {
        throw error;
      }
      await delay(retryDelaysMs[attempt]!);
    }
  }
  throw lastError ?? new Error(`Unreachable color host retry state: ${label}`);
}

function isRetryableColorHostError(error: unknown): boolean {
  if (!(error instanceof ResolveColorHostError)) return false;
  return new Set([
    'resolve_app_unavailable',
    'resolve_render_timeout',
    'resolve_color_host_timeout',
    'resolve_color_host_connection_failed',
  ]).has(error.code);
}

function mapHostErrorToPreflight(error: ResolveColorHostError): IColorHostPreflight {
  return {
    status: 'blocked',
    checkedAt: new Date().toISOString(),
    warnings: [],
    blockingReasons: dedupeStrings([
      error.message,
      ...(extractHostErrorStrings(error.details, 'blockingReasons')),
    ]),
    renderSupport: {
      containers: [],
      supportsAudioCodec: false,
      supportsVideoQuality: false,
    },
  };
}

function extractHostErrorStrings(details: unknown, key: string): string[] {
  if (!details || typeof details !== 'object') return [];
  const value = (details as Record<string, unknown>)[key];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim()));
}

function normalizeHostPreflight(preflight: IColorHostPreflight): IColorHostPreflight {
  return {
    status: preflight.status ?? 'unknown',
    checkedAt: preflight.checkedAt ?? new Date().toISOString(),
    productName: preflight.productName?.trim() || undefined,
    versionString: preflight.versionString?.trim() || undefined,
    isStudio: preflight.isStudio,
    warnings: dedupeStrings(preflight.warnings ?? []),
    blockingReasons: dedupeStrings(preflight.blockingReasons ?? []),
    renderSupport: {
      containers: dedupeRenderSupportContainers(preflight.renderSupport?.containers ?? []),
      supportsAudioCodec: preflight.renderSupport?.supportsAudioCodec ?? false,
      supportsVideoQuality: preflight.renderSupport?.supportsVideoQuality ?? false,
    },
  };
}

function dedupeRenderSupportContainers(
  containers: NonNullable<IColorHostPreflight['renderSupport']>['containers'],
): NonNullable<IColorHostPreflight['renderSupport']>['containers'] {
  const byContainer = new Map<string, { container: string; extension?: string; videoCodecs: string[] }>();
  for (const container of containers ?? []) {
    const key = container.container?.trim().toLowerCase();
    if (!key) continue;
    const videoCodecs = dedupeStrings(container.videoCodecs ?? []);
    const existing = byContainer.get(key);
    if (existing) {
      existing.videoCodecs = dedupeStrings([...existing.videoCodecs, ...videoCodecs]);
      existing.extension = existing.extension ?? container.extension;
      continue;
    }
    byContainer.set(key, {
      container: container.container,
      extension: container.extension,
      videoCodecs,
    });
  }
  return Array.from(byContainer.values()).sort((left, right) => left.container.localeCompare(right.container));
}

function validateRenderPresetSupport(
  renderPreset: IColorRootContext['rootSummary']['renderPreset'],
  preflight: IColorHostPreflight,
): string[] {
  const support = preflight.renderSupport;
  if (!support) {
    return ['Resolve host preflight 未返回 renderSupport，无法校验当前 renderPreset。'];
  }
  const containerValue = renderPreset.container?.trim();
  const codecValue = renderPreset.videoCodec?.trim();
  if (!containerValue || !codecValue) {
    return ['当前 root 的 renderPreset 缺少 container 或 videoCodec，无法启动 execute_root。'];
  }
  const containerKey = containerValue.toLowerCase();
  const matchedContainer = support.containers.find(container => container.container.trim().toLowerCase() === containerKey);
  if (!matchedContainer) {
    return [`当前 Resolve host 不支持 render container: ${containerValue}`];
  }
  const codecKey = codecValue.toLowerCase();
  const matchedCodec = matchedContainer.videoCodecs.some(codec => codec.trim().toLowerCase() === codecKey);
  if (!matchedCodec) {
    return [`当前 Resolve host 不支持 ${containerValue} / ${codecValue} 这组 render preset。`];
  }
  const blockers: string[] = [];
  if (renderPreset.audioCodec?.trim() && support.supportsAudioCodec === false) {
    blockers.push(`当前 Resolve host 不支持 AudioCodec 设置：${renderPreset.audioCodec}`);
  }
  const bitrateKbps = readColorRenderPresetBitrateKbps(renderPreset);
  if (typeof bitrateKbps === 'number' && support.supportsVideoQuality === false) {
    blockers.push(`当前 Resolve host 不支持 VideoQuality 设置：${bitrateKbps} kb/s`);
  }
  return blockers;
}

function buildColorValidationChecks(input: {
  rawRelativePath: string;
  promoteRelativePath: string;
  normalizedOutputFilename: string;
  sourceMetadata?: IColorFileMetadataSnapshot;
  outputMetadata?: IColorFileMetadataSnapshot;
}): {
  pathMirror: EColorValidationCheckResult;
  filenameNormalized: EColorValidationCheckResult;
  mediaKind: EColorValidationCheckResult;
  resolution: EColorValidationCheckResult;
  fps: EColorValidationCheckResult;
  duration: EColorValidationCheckResult;
  capturedAt: EColorValidationCheckResult;
  createTime: EColorValidationCheckResult;
  gps: EColorValidationCheckResult;
  filesystemCreateTime: EColorValidationCheckResult;
} {
  const expectedRelativeDir = posix.dirname(input.rawRelativePath);
  const actualRelativeDir = posix.dirname(input.promoteRelativePath);
  return {
    pathMirror: expectedRelativeDir === actualRelativeDir ? 'pass' : 'fail',
    filenameNormalized: posix.basename(input.promoteRelativePath) === input.normalizedOutputFilename ? 'pass' : 'fail',
    mediaKind: compareOptionalValue(input.sourceMetadata?.mediaKind, input.outputMetadata?.mediaKind),
    resolution: compareOptionalTuple(
      input.sourceMetadata?.width,
      input.sourceMetadata?.height,
      input.outputMetadata?.width,
      input.outputMetadata?.height,
    ),
    fps: compareOptionalNumber(input.sourceMetadata?.fps, input.outputMetadata?.fps, 0.05),
    duration: compareOptionalNumber(
      input.sourceMetadata?.durationMs,
      input.outputMetadata?.durationMs,
      input.sourceMetadata?.fps ? Math.max(100, Math.ceil(2000 / input.sourceMetadata.fps)) : 250,
    ),
    capturedAt: compareOptionalValue(input.sourceMetadata?.capturedAt, input.outputMetadata?.capturedAt),
    createTime: compareOptionalValue(input.sourceMetadata?.createTime, input.outputMetadata?.createTime),
    gps: compareOptionalTuple(
      input.sourceMetadata?.gps?.[0],
      input.sourceMetadata?.gps?.[1],
      input.outputMetadata?.gps?.[0],
      input.outputMetadata?.gps?.[1],
      0.000001,
    ),
    filesystemCreateTime: input.sourceMetadata?.filesystemCreateTime ? 'pass' : 'not_present_in_source',
  };
}

function compareOptionalValue<T>(source: T | undefined, output: T | undefined): EColorValidationCheckResult {
  if (source == null || (typeof source === 'string' && source.length === 0)) return 'not_present_in_source';
  return source === output ? 'pass' : 'fail';
}

function compareOptionalNumber(
  source: number | undefined,
  output: number | undefined,
  tolerance: number,
): EColorValidationCheckResult {
  if (typeof source !== 'number') return 'not_present_in_source';
  if (typeof output !== 'number') return 'fail';
  return Math.abs(source - output) <= tolerance ? 'pass' : 'fail';
}

function compareOptionalTuple(
  sourceLeft: number | undefined,
  sourceRight: number | undefined,
  outputLeft: number | undefined,
  outputRight: number | undefined,
  tolerance = 0,
): EColorValidationCheckResult {
  if (typeof sourceLeft !== 'number' || typeof sourceRight !== 'number') return 'not_present_in_source';
  if (typeof outputLeft !== 'number' || typeof outputRight !== 'number') return 'fail';
  return Math.abs(sourceLeft - outputLeft) <= tolerance && Math.abs(sourceRight - outputRight) <= tolerance
    ? 'pass'
    : 'fail';
}

function collectValidationReasons(
  checks: ReturnType<typeof buildColorValidationChecks>,
  context: {
    sourcePath: string;
    outputPath: string;
  },
): string[] {
  const reasons: string[] = [];
  if (checks.pathMirror === 'fail') reasons.push('pathMirror mismatch');
  if (checks.filenameNormalized === 'fail') reasons.push('normalized filename mismatch');
  if (checks.mediaKind === 'fail') reasons.push('mediaKind mismatch');
  if (checks.resolution === 'fail') reasons.push('resolution mismatch');
  if (checks.fps === 'fail') reasons.push('fps mismatch');
  if (checks.duration === 'fail') reasons.push('duration mismatch');
  if (checks.capturedAt === 'fail') reasons.push('capturedAt mismatch');
  if (checks.gps === 'fail') reasons.push('gps mismatch');
  if (checks.mediaKind === 'fail' || checks.duration === 'fail' || checks.resolution === 'fail') {
    reasons.push(`source=${context.sourcePath}`);
    reasons.push(`output=${context.outputPath}`);
  }
  return dedupeStrings(reasons);
}

function collectValidationWarnings(
  checks: ReturnType<typeof buildColorValidationChecks>,
): string[] {
  const warnings: string[] = [];
  if (checks.createTime === 'fail') warnings.push('create_time mismatch');
  return dedupeStrings(warnings);
}

async function deleteManagedOutputs(
  localRootPath: string,
  previousManagedOutputs: string[],
  nextManagedOutputs: string[],
): Promise<string[]> {
  const nextSet = new Set(nextManagedOutputs);
  const deleted: string[] = [];
  await Promise.all(
    previousManagedOutputs
      .filter(relativePath => !nextSet.has(relativePath))
      .map(async relativePath => {
        const target = resolve(join(localRootPath, ...relativePath.split('/')));
        await unlink(target).catch(() => undefined);
        deleted.push(relativePath);
      }),
  );
  return deleted.sort();
}

async function copyManagedOutputs(localRootPath: string, manifest: IColorBatchManifest): Promise<string[]> {
  const copied: string[] = [];
  for (const entry of manifest.entries) {
    const targetPath = resolve(join(localRootPath, ...entry.promoteRelativePath.split('/')));
    await mkdir(dirname(targetPath), { recursive: true });
    await copyFile(entry.stagingAbsolutePath, targetPath);
    copied.push(entry.promoteRelativePath);
  }
  return copied.sort();
}

function normalizePortablePath(value: string): string {
  return value.replace(/\\/g, '/');
}

function dedupeStrings(values: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value?.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function selectDominantTimelineSpec(
  clips: IColorExecutorClipInput[],
): { width: number; height: number; fps: number } | undefined {
  const counts = new Map<string, { width: number; height: number; fps: number; count: number }>();
  for (const clip of clips) {
    if (typeof clip.width !== 'number' || typeof clip.height !== 'number' || typeof clip.fps !== 'number') {
      continue;
    }
    const key = `${clip.width}x${clip.height}@${clip.fps.toFixed(3)}`;
    const current = counts.get(key);
    if (current) {
      current.count += 1;
      continue;
    }
    counts.set(key, {
      width: clip.width,
      height: clip.height,
      fps: clip.fps,
      count: 1,
    });
  }
  const selected = [...counts.values()]
    .sort((left, right) => (
      right.count - left.count
      || right.width * right.height - left.width * left.height
      || right.fps - left.fps
    ))[0];
  if (!selected) return undefined;
  return {
    width: selected.width,
    height: selected.height,
    fps: selected.fps,
  };
}

function deriveSourceStem(rawRelativePath: string): string {
  return posix.basename(rawRelativePath, posix.extname(rawRelativePath));
}
