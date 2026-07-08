import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, rename, stat, unlink } from 'node:fs/promises';
import { dirname, extname, join, posix, relative, resolve } from 'node:path';
import { scheduler } from 'node:timers/promises';
import { promisify } from 'node:util';
import type {
  IColorBatchManifest,
  IColorBatchPlan,
  IColorBatchRenderJob,
  IColorBatchValidation,
  IColorBatchSidecar,
  IColorHostPreflight,
  IColorFileMetadataSnapshot,
  IColorGroupCurrent,
  IColorGroupsSnapshotFile,
  IColorClipRepairSnapshot,
  IColorPrepareChunk,
  IColorResolveProjectMap,
  IColorResolveProjectSnapshot,
  IColorRootCurrent,
  IColorOverwritePreview,
  EColorValidationCheckResult,
  IColorCurrent,
  IMediaRoot,
} from '../../protocol/schema.js';
import {
  getProjectProgressPath,
  getColorResolveProjectsRoot,
  getColorGroupsSnapshotPath,
  loadColorBatchManifest,
  loadColorBatchPlan,
  loadColorBatchValidation,
  loadColorCurrent,
  loadColorGroupsSnapshot,
  loadColorGroupsSnapshots,
  loadColorResolveProjectMap,
  loadIngestRoots,
  loadColorTransformPresetsConfig,
  loadProjectBriefConfig,
  loadRuntimeConfig,
  resolveWorkspaceProjectRoot,
  saveColorBatchManifest,
  saveColorBatchPlan,
  saveColorBatchValidation,
  saveColorCurrent,
  saveColorGroupsSnapshot,
  saveColorResolveProjectMap,
  writeKairosProgress,
} from '../../store/index.js';
import { resolveCaptureTime } from '../media/capture-time.js';
import { probe } from '../media/probe.js';
import { classifyExt, scanDirectory } from '../media/scanner.js';
import { buildRootPathCandidates, toPortableRelativePath } from '../media/root-resolver.js';
import { toExecutableInputPath } from '../media/tool-path.js';
import {
  buildColorWorkspaceState,
  deriveColorGradingTimelineName,
  deriveColorResolveProjectName,
  deriveColorRootNamespace,
  resolveColorDrpLatestFilename,
} from './workspace-state.js';
import { readColorRenderPresetBitrateKbps } from './render-preset.js';
import { classifyMidpointLowlight } from './lowlight-classifier.js';
import { classifyColorCast } from './color-cast-classifier.js';
import { classifyExposureScene } from './exposure-scene-classifier.js';
import { classifyWindshieldHaze } from './windshield-haze-classifier.js';
import { extractColorSourceTruth } from './source-truth.js';
import {
  detectResolveDefaultLutRoot,
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
  type IColorExecutorRelinkMediaRoot,
  type IColorExecutorPrepareRootResult,
} from './resolve-executor.js';

export type TProjectColorAction =
  | 'relink_media'
  | 'prepare_root'
  | 'sync_groups'
  | 'execute_root'
  | 'sync_batch_metadata'
  | 'sync_batch_sidecars'
  | 'validate_batch'
  | 'promote_batch'
  | 'relink_all_roots'
  | 'prepare_all_roots'
  | 'export_all_roots'
  | 'save_drp_snapshot';

const CCOLOR_PREPARE_CHUNK_SIZE = 50;
const CCOLOR_PREPARE_PROBE_CONCURRENCY = 2;
const CCOLOR_METADATA_SYNC_CONCURRENCY = 2;
const CCOLOR_METADATA_TEMP_PREFIX = '.kairos-meta-';
const CCOLOR_SIDECAR_EXTENSIONS = new Set(['.srt', '.wav', '.flac', '.m4a', '.aac', '.mp3']);
const CCOLOR_REPAIR_TEMPLATE_DEFAULT_KEY = 'default';
const CCOLOR_REPAIR_TEMPLATE_PORTRAIT_90_KEY = 'portrait-90';
const CCOLOR_REPAIR_TEMPLATE_PORTRAIT_NEGATIVE_90_KEY = 'portrait--90';
const CCOLOR_REPAIR_TEMPLATE_DRIFT_DETAIL = '方向 DRT 模板已更新，需重新 seed portrait repair。';
const CCOLOR_CAST_CONTINUITY_MIN_CANDIDATE_RATIO = 0.03;
const CCOLOR_CAST_CONTINUITY_MAX_ANCHOR_GAP = 8;
const CCOLOR_CAST_CONTINUITY_MAX_FORWARD_EXTENSION = 3;

type TColorCastContinuityTarget = 'cool-cyan' | 'green-cyan' | 'green';

const CCOLOR_STEP_DEFINITIONS: Record<TProjectColorAction, Array<{ key: string; label: string }>> = {
  relink_media: [
    { key: 'relink_media', label: '重链 Resolve 素材路径' },
  ],
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
  sync_batch_metadata: [
    { key: 'sync_batch_metadata', label: '同步 batch 元信息' },
  ],
  sync_batch_sidecars: [
    { key: 'sync_batch_sidecars', label: '同步 batch sidecar' },
  ],
  validate_batch: [
    { key: 'validate_batch', label: '校验 batch manifest' },
  ],
  promote_batch: [
    { key: 'promote_batch', label: '已移除的旧 Promote' },
  ],
  relink_all_roots: [
    { key: 'select_roots', label: '确定目标 roots' },
    { key: 'relink_all_roots', label: '顺序重链所有 roots' },
  ],
  prepare_all_roots: [
    { key: 'select_roots', label: '确定目标 roots' },
    { key: 'prepare_all_roots', label: '顺序准备所有 roots' },
  ],
  export_all_roots: [
    { key: 'select_roots', label: '确定目标 roots' },
    { key: 'export_all_roots', label: '顺序导出所有 roots' },
  ],
  save_drp_snapshot: [
    { key: 'save_drp_snapshot', label: '保存 DRP 快照' },
  ],
};

export interface IProjectColorActionInput {
  workspaceRoot: string;
  projectId: string;
  rootId?: string;
  action?: TProjectColorAction;
  clipKeys?: string[];
  batchId?: string;
  overwriteConfirmed?: boolean;
  overwritePlanHash?: string;
  retention?: 'latest-only' | 'archive';
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
    total?: number;
    unit?: string;
    detail: string;
    extra: Record<string, unknown>;
  },
) => Promise<void>;

export interface IPrepareProjectColorRootInput extends IProjectColorActionInput {
  action?: 'prepare_root';
  rootId: string;
}

export interface IRelinkProjectColorRootInput extends IProjectColorActionInput {
  action?: 'relink_media';
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
  rootConfig: IMediaRoot;
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
    case 'relink_media': {
      const rootId = input.rootId?.trim();
      if (!rootId) {
        throw new ProjectColorBlockedError(['relink_media requires rootId。']);
      }
      return relinkProjectColorRootMedia({
        ...input,
        rootId,
        action: 'relink_media',
      });
    }
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
    case 'sync_batch_metadata': {
      const rootId = input.rootId?.trim();
      if (!rootId) {
        throw new ProjectColorBlockedError(['sync_batch_metadata requires rootId。']);
      }
      return syncProjectColorBatchMetadata({ ...input, rootId });
    }
    case 'sync_batch_sidecars': {
      const rootId = input.rootId?.trim();
      if (!rootId) {
        throw new ProjectColorBlockedError(['sync_batch_sidecars requires rootId。']);
      }
      return syncProjectColorBatchSidecars({ ...input, rootId });
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
    case 'relink_all_roots':
      if (input.rootId?.trim()) {
        throw new ProjectColorBlockedError(['relink_all_roots is project-scoped and does not accept rootId。']);
      }
      return relinkAllProjectColorRoots(input);
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
    case 'save_drp_snapshot':
      return snapshotProjectColorDrp({
        workspaceRoot: input.workspaceRoot,
        projectId: input.projectId,
        rootId: input.rootId,
        mode: 'manual',
        retention: input.retention,
        executor: input.executor,
        jobId: input.jobId,
        progressPath: input.progressPath,
        suppressProgress: input.suppressProgress,
      });
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

export async function previewProjectColorOverwrite(
  input: IProjectColorActionInput,
): Promise<IColorOverwritePreview> {
  const mode = input.action === 'export_all_roots' ? 'export_all_roots' : 'execute_root';
  if (mode === 'export_all_roots' && !input.rootId?.trim()) {
    const rootSummaries = await loadEnabledProjectColorRootSummaries(input.workspaceRoot, input.projectId);
    const roots = await Promise.all(rootSummaries.map(root => (
      previewProjectColorOverwrite({
        ...input,
        rootId: root.rootId,
        action: 'execute_root',
      })
    )));
    const rootHashes = Object.fromEntries(
      roots.map(root => [root.rootId ?? '', root.overwritePlanHash]).filter(([rootId]) => Boolean(rootId)),
    );
    const overwritePlanHash = hashColorOverwritePayload({
      mode,
      projectId: input.projectId,
      roots: roots.map(root => ({
        rootId: root.rootId,
        overwritePlanHash: root.overwritePlanHash,
      })),
    });
    return {
      projectId: input.projectId,
      mode,
      clipCount: roots.reduce((total, root) => total + root.clipCount, 0),
      existingCount: roots.reduce((total, root) => total + root.existingCount, 0),
      targets: roots.flatMap(root => root.targets),
      byDirectory: mergeColorOverwriteDirectories(roots.flatMap(root => root.byDirectory)),
      duplicateStemGroups: roots.flatMap(root => root.duplicateStemGroups),
      overwritePlanHash,
      rootHashes,
      roots,
    };
  }
  const rootId = input.rootId?.trim();
  if (!rootId) {
    throw new ProjectColorBlockedError(['overwrite preview requires rootId。']);
  }
  const context = await loadColorRootContext(input.workspaceRoot, input.projectId, rootId);
  return buildColorOverwritePreviewForContext(context, input.clipKeys ?? []);
}

export interface ISnapshotProjectColorDrpInput extends Omit<IProjectColorActionInput, 'action'> {
  mode?: 'manual' | 'auto';
  retention?: 'latest-only' | 'archive';
  snapshotLabel?: string;
}

export interface ISnapshotProjectColorDrpResult extends IProjectColorActionResult {
  snapshot?: IColorResolveProjectSnapshot;
}

export async function snapshotProjectColorDrp(
  input: ISnapshotProjectColorDrpInput,
): Promise<ISnapshotProjectColorDrpResult> {
  const action: TProjectColorAction = 'save_drp_snapshot';
  const retention = normalizeColorDrpSnapshotRetention(input.retention);
  const projectRoot = resolveWorkspaceProjectRoot(input.workspaceRoot, input.projectId);
  const progressPath = resolveColorProgressPath(projectRoot, input.progressPath);
  const writeProgress: TWriteColorProgress = input.suppressProgress
    ? async (..._args) => undefined
    : writeColorProgress;
  const context = input.rootId
    ? await loadColorRootContext(input.workspaceRoot, input.projectId, input.rootId)
    : null;
  const projectBrief = context ? null : await loadProjectBriefConfig(projectRoot).catch(() => null);
  const resolveProjectName = context?.rootSummary.resolveProjectName
    ?? deriveColorResolveProjectName(projectBrief?.name, input.projectId);
  const executor = context
    ? resolveColorExecutor(context, input.executor)
    : (input.executor ?? new PythonResolveColorExecutor());

  await writeProgress(progressPath, action, {
    status: 'running',
    stepIndex: 1,
    current: 0,
    detail: retention === 'archive'
      ? '正在保存 Resolve 项目并归档 DRP 快照。'
      : '正在保存 Resolve 项目并覆盖最新 DRP。',
    extra: {
      projectId: input.projectId,
      rootId: input.rootId,
      resolveProjectName,
    },
  });

  if (context) {
    await ensureActionHostPreflight({
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
  } else {
    const preflight = await runColorHostPreflight({
      projectRoot,
      projectId: input.projectId,
      resolveProjectName,
      executor,
    });
    await saveColorHostPreflight(projectRoot, preflight);
    if (preflight.status === 'blocked') {
      const blockers = preflight.blockingReasons.length > 0
        ? preflight.blockingReasons
        : ['Resolve host preflight blocked save_drp_snapshot。'];
      await writeProgress(progressPath, action, {
        status: 'failed',
        stepIndex: 1,
        current: 0,
        detail: blockers.join('；'),
        extra: {
          projectId: input.projectId,
          resolveProjectName,
        },
      });
      throw new ProjectColorBlockedError(blockers);
    }
  }

  const snapshotRoot = resolveColorDrpSnapshotRoot(projectRoot, resolveProjectName);
  const saved = await runColorHostWithRetry(
    () => executor.saveDrpSnapshot({
      projectId: input.projectId,
      resolveProjectName,
      snapshotRoot,
      snapshotLabel: input.snapshotLabel ?? 'manual',
      latestFilename: resolveColorDrpLatestFilename(resolveProjectName),
      retention,
      action: input.mode ?? 'manual',
      rootId: input.rootId,
    }),
    `save_drp_snapshot:${input.projectId}:${input.rootId ?? 'project'}`,
  );
  const savedSnapshot = {
    ...normalizeRequiredColorDrpSnapshot(saved.snapshot, resolveProjectName),
    retention,
  };
  await recordColorDrpSnapshots(projectRoot, resolveProjectName, [savedSnapshot]);
  if (input.rootId) {
    await writeRootCurrent(projectRoot, input.rootId, current => ({
      ...current,
      latestDrpSnapshot: savedSnapshot,
      detail: formatColorDrpSnapshotDetail(savedSnapshot),
      currentJobId: undefined,
      activeStage: undefined,
      blockingReasons: filterPersistentColorBlockers(current.blockingReasons ?? []),
    }));
  }

  await writeProgress(progressPath, action, {
    status: 'succeeded',
    stepIndex: 1,
    current: 1,
    detail: formatColorDrpSnapshotDetail(savedSnapshot),
    extra: {
      projectId: input.projectId,
      rootId: input.rootId,
      resolveProjectName,
      snapshotPath: savedSnapshot.snapshotPath,
      latestPath: savedSnapshot.latestPath,
    },
  });

  return {
    action,
    projectId: input.projectId,
    rootId: input.rootId,
    detail: formatColorDrpSnapshotDetail(savedSnapshot),
    blockingReasons: [],
    snapshot: savedSnapshot,
  };
}

export interface IRegisterExternalColorDrpSnapshotInput {
  workspaceRoot: string;
  projectId: string;
  drpPath: string;
  rootId?: string;
  detail?: string;
}

export interface IRegisterExternalColorDrpSnapshotResult extends IProjectColorActionResult {
  snapshot: IColorResolveProjectSnapshot;
}

export async function registerExternalColorDrpSnapshot(
  input: IRegisterExternalColorDrpSnapshotInput,
): Promise<IRegisterExternalColorDrpSnapshotResult> {
  const projectRoot = resolveWorkspaceProjectRoot(input.workspaceRoot, input.projectId);
  const projectBrief = await loadProjectBriefConfig(projectRoot).catch(() => null);
  const sourcePath = resolve(input.drpPath);
  const sourceStats = await stat(sourcePath).catch(() => null);
  const blockers = dedupeStrings([
    !input.drpPath?.trim() ? '登记外部 DRP 需要填写 .drp 路径。' : '',
    sourceStats && !sourceStats.isFile() ? `登记外部 DRP 不是文件：${sourcePath}` : '',
    !sourceStats ? `登记外部 DRP 不存在或不可读：${sourcePath}` : '',
    extname(sourcePath).toLowerCase() !== '.drp' ? `登记外部 DRP 必须是 .drp 文件：${sourcePath}` : '',
  ]);
  if (blockers.length > 0) {
    throw new ProjectColorBlockedError(blockers);
  }
  const resolveProjectName = deriveColorResolveProjectName(projectBrief?.name, input.projectId);
  const snapshotRoot = resolveColorDrpSnapshotRoot(projectRoot, resolveProjectName);
  const snapshotsRoot = join(snapshotRoot, 'snapshots');
  await mkdir(snapshotsRoot, { recursive: true });
  const createdAt = new Date().toISOString();
  const targetPath = join(
    snapshotsRoot,
    `${formatColorSnapshotTimestamp(createdAt)}-external-${hashString(sourcePath).slice(0, 8)}.drp`,
  );
  if (resolve(sourcePath) !== resolve(targetPath)) {
    await copyFile(sourcePath, targetPath);
  }
  const latestPath = join(snapshotRoot, resolveColorDrpLatestFilename(resolveProjectName));
  await mkdir(dirname(latestPath), { recursive: true });
  if (resolve(targetPath) !== resolve(latestPath)) {
    await copyFile(targetPath, latestPath);
  }
  const snapshot: IColorResolveProjectSnapshot = {
    projectName: resolveProjectName,
    snapshotPath: targetPath,
    latestPath,
    createdAt,
    mode: 'external',
    retention: 'archive',
    action: 'register_external_drp',
    rootId: input.rootId,
    detail: input.detail ?? `登记外部 DRP：${sourcePath}`,
  };
  await recordColorDrpSnapshots(projectRoot, resolveProjectName, [snapshot]);
  if (input.rootId) {
    await writeRootCurrent(projectRoot, input.rootId, current => ({
      ...current,
      latestDrpSnapshot: snapshot,
      detail: `已登记外部 DRP：${snapshot.snapshotPath}`,
      blockingReasons: filterPersistentColorBlockers(current.blockingReasons ?? []),
    }));
  }
  return {
    action: 'save_drp_snapshot',
    projectId: input.projectId,
    rootId: input.rootId,
    detail: `已登记外部 DRP：${snapshot.snapshotPath}`,
    blockingReasons: [],
    snapshot,
  };
}

export async function relinkProjectColorRootMedia(
  input: IRelinkProjectColorRootInput,
): Promise<IProjectColorActionResult> {
  const action: TProjectColorAction = 'relink_media';
  const context = await loadColorRootContext(input.workspaceRoot, input.projectId, input.rootId);
  const progressPath = resolveColorProgressPath(context.projectRoot, input.progressPath);
  const writeProgress: TWriteColorProgress = input.suppressProgress
    ? async (..._args) => undefined
    : writeColorProgress;
  const blockers = dedupeStrings([
    !context.rootSummary.rawPath ? '当前 root 未配置 rawPath，无法执行 Resolve Color 素材重链。' : '',
    !context.rootSummary.rawLocalPath ? '当前设备未配置 rawLocalPath，无法执行 Resolve Color 素材重链。' : '',
  ]);
  if (blockers.length > 0) {
    await failColorAction(context.projectRoot, context.rootId, progressPath, action, blockers, {
      projectId: input.projectId,
      rootId: context.rootId,
    }, {
      suppressProgress: input.suppressProgress,
    });
    throw new ProjectColorBlockedError(blockers);
  }

  const mapping = buildColorRelinkRootMapping(context);
  if (!mapping) {
    const mappingBlockers = ['没有可用于 Resolve Color 素材重链的 rawPath 路径候选。'];
    await failColorAction(context.projectRoot, context.rootId, progressPath, action, mappingBlockers, {
      projectId: input.projectId,
      rootId: context.rootId,
    }, {
      suppressProgress: input.suppressProgress,
    });
    throw new ProjectColorBlockedError(mappingBlockers);
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
      rootId: context.rootId,
    },
  });

  await writeRootCurrent(context.projectRoot, context.rootId, current => ({
    ...current,
    activeStage: 'relink_media',
    currentJobId: input.jobId,
    detail: `正在重链 Resolve Color 素材：${context.rootSummary.gradingTimelineName}`,
    blockingReasons: filterPersistentColorBlockers(current.blockingReasons ?? []),
  }));
  await writeProgress(progressPath, action, {
    status: 'running',
    stepIndex: 1,
    current: 0,
    detail: `正在将 Resolve Color 素材重链到 ${mapping.localPath}。`,
    extra: {
      projectId: input.projectId,
      rootId: context.rootId,
      resolveProjectName: context.rootSummary.resolveProjectName,
      rootNamespace: context.rootSummary.rootNamespace,
      gradingTimelineName: context.rootSummary.gradingTimelineName,
      candidateCount: mapping.candidates.length,
    },
  });

  let relinked: Awaited<ReturnType<IColorExecutor['relinkMedia']>>;
  try {
    relinked = await runColorHostWithRetry(
      () => executor.relinkMedia({
        projectId: input.projectId,
        rootId: context.rootId,
        resolveProjectName: context.rootSummary.resolveProjectName,
        rootNamespace: context.rootSummary.rootNamespace,
        gradingTimelineName: context.rootSummary.gradingTimelineName,
        roots: [mapping],
      }),
      `relink_media:${context.rootId}`,
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await failColorAction(context.projectRoot, context.rootId, progressPath, action, [reason], {
      projectId: input.projectId,
      rootId: context.rootId,
      resolveProjectName: context.rootSummary.resolveProjectName,
      rootNamespace: context.rootSummary.rootNamespace,
      gradingTimelineName: context.rootSummary.gradingTimelineName,
    }, {
      suppressProgress: input.suppressProgress,
    });
    throw error;
  }

  const detail = formatColorRelinkDetail(relinked.hostSummary);
  const savedCurrent = await writeRootCurrent(context.projectRoot, context.rootId, current => ({
    ...current,
    mirrorStatus: current.mirrorStatus === 'blocked' || !current.mirrorStatus ? 'synced' : current.mirrorStatus,
    timelineStatus: 'ready',
    activeStage: undefined,
    currentJobId: undefined,
    detail,
    hostSummary: {
      ...(isPlainObject(current.hostSummary) ? current.hostSummary : {}),
      latestRelink: relinked.hostSummary ?? {},
      latestRelinkAt: relinked.createdAt,
    },
    blockingReasons: filterPersistentColorBlockers(current.blockingReasons ?? []),
  }));
  await writeProgress(progressPath, action, {
    status: 'succeeded',
    stepIndex: 1,
    current: 1,
    detail,
    extra: {
      projectId: input.projectId,
      rootId: context.rootId,
      hostPreflight,
      hostSummary: relinked.hostSummary,
    },
  });

  const savedRoot = savedCurrent.roots.find(root => root.rootId === context.rootId);
  return {
    action,
    projectId: input.projectId,
    rootId: context.rootId,
    detail: savedRoot?.detail ?? detail,
    blockingReasons: savedRoot?.blockingReasons ?? [],
  };
}

export async function relinkAllProjectColorRoots(
  input: IProjectColorActionInput,
): Promise<IProjectColorActionResult> {
  const action: TProjectColorAction = 'relink_all_roots';
  const projectRoot = resolveWorkspaceProjectRoot(input.workspaceRoot, input.projectId);
  const progressPath = resolveColorProgressPath(projectRoot, input.progressPath);
  const rootSummaries = await loadEnabledProjectColorRootSummaries(input.workspaceRoot, input.projectId);
  if (rootSummaries.length === 0) {
    const blockers = ['当前项目没有可重链的 enabled color roots。'];
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
    detail: `已锁定 ${rootSummaries.length} 个 color roots，准备顺序执行 relink_media。`,
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
      detail: `正在重链 root ${index + 1}/${rootSummaries.length}：${rootSummary.rootId}`,
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
      const result = await relinkProjectColorRootMedia({
        ...input,
        rootId: rootSummary.rootId,
        action: 'relink_media',
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
    ? `Relink All Roots 完成：${succeededRoots} 个成功，${failedRoots} 个失败。`
    : `Relink All Roots 完成：${succeededRoots} 个 roots 全部完成重链。`;
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

  const overwritePreview = await previewProjectColorOverwrite({
    ...input,
    action,
    rootId: undefined,
  });
  const overwriteBlockers = validateColorOverwriteConfirmation(overwritePreview, input);
  if (overwriteBlockers.length > 0) {
    await writeColorProgress(progressPath, action, {
      status: 'failed',
      stepIndex: 1,
      current: 0,
      detail: overwriteBlockers.join('；'),
      extra: {
        projectId: input.projectId,
        currentRootId: undefined,
        currentRootIndex: 0,
        totalRoots: rootSummaries.length,
        succeededRoots: 0,
        failedRoots: 0,
        overwritePlanHash: overwritePreview.overwritePlanHash,
      },
    });
    throw new ProjectColorBlockedError(overwriteBlockers);
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
        overwriteConfirmed: overwritePreview.existingCount > 0 ? true : input.overwriteConfirmed,
        overwritePlanHash: overwritePreview.rootHashes?.[rootSummary.rootId] ?? input.overwritePlanHash,
      });
      if (executed.blockingReasons.length > 0) {
        failedRoots += 1;
        roots.push({
          rootId: rootSummary.rootId,
          status: 'failed',
          batchId: executed.batchId,
          actionSummary: executed.detail,
          error: executed.blockingReasons.join('；'),
        });
        continue;
      }
      succeededRoots += 1;
      roots.push({
        rootId: rootSummary.rootId,
        status: 'succeeded',
        batchId: executed.batchId,
        actionSummary: executed.detail,
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
    : `Export All Roots 完成：${succeededRoots} 个 roots 全部导出并校验完成。`;
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
      activeStage: undefined,
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
  const rawInventory = await scanColorRawInventory(context.rootSummary.rawLocalPath ?? '');
  const existingRootCurrent = context.colorCurrent.roots.find(root => root.rootId === context.rootId);
  const previousClipSnapshots = buildColorClipRepairSnapshotIndex(context.groupsSnapshot);
  const repairTemplateHashes = await buildColorRepairTemplateHashes(context.workspaceRoot);
  const chunks = buildColorPrepareChunks(
    rawInventory,
    context.rootSummary.gradingTimelineName,
    existingRootCurrent?.prepareChunks ?? [],
  ).map(chunk => refreshPrepareChunkForRepairTemplateDrift(chunk, previousClipSnapshots, repairTemplateHashes));
  if (chunks.length === 0) {
    const emptyBlockers = ['当前 root 没有可准备的 raw 视频。'];
    await failColorAction(context.projectRoot, context.rootId, progressPath, action, emptyBlockers, {
      projectId: input.projectId,
      rootId: input.rootId,
    }, {
      suppressProgress: input.suppressProgress,
    });
    throw new ColorPrepBlockedError(emptyBlockers);
  }
  const missingDefaultTemplateBlockers = buildMissingDefaultRepairTemplateBlockers({
    workspaceRoot: context.workspaceRoot,
    rawInventory,
    previousClipSnapshots,
    repairTemplateHashes,
  });
  if (missingDefaultTemplateBlockers.length > 0) {
    const detail = missingDefaultTemplateBlockers.join('；');
    await writeRootCurrent(context.projectRoot, context.rootId, current => ({
      ...current,
      mirrorStatus: 'blocked',
      timelineStatus: 'blocked',
      groupSyncStatus: current.groupSyncStatus,
      activeStage: undefined,
      currentJobId: undefined,
      detail,
      prepareChunks: chunks.map(chunk => ({
        ...materializePrepareChunkForCurrent(chunk, current.prepareChunks ?? []),
        status: 'failed' as const,
        completedAt: undefined,
        detail,
      })),
      blockingReasons: dedupeStrings([...(current.blockingReasons ?? []), ...missingDefaultTemplateBlockers]),
    }));
    await writeProgress(progressPath, action, {
      status: 'failed',
      stepIndex: 1,
      current: 0,
      detail,
      extra: {
        projectId: input.projectId,
        rootId: input.rootId,
        clipCount: rawInventory.length,
      },
    });
    throw new ColorPrepBlockedError(missingDefaultTemplateBlockers);
  }

  await writeRootCurrent(context.projectRoot, context.rootId, current => ({
    ...current,
    mirrorStatus: 'running',
    timelineStatus: 'idle',
    activeStage: 'sync_root_bins',
    currentJobId: input.jobId,
    detail: `正在按 ${chunks.length} 个 chunks 准备 Resolve root。`,
    prepareChunks: chunks.map(chunk => materializePrepareChunkForCurrent(chunk, current.prepareChunks ?? [])),
    blockingReasons: filterPersistentColorBlockers(current.blockingReasons ?? []),
  }));
  await writeProgress(progressPath, action, {
    status: 'running',
    stepIndex: 1,
    current: 0,
    detail: `已把 ${rawInventory.length} 个 raw clips 拆成 ${chunks.length} 个 chunks。`,
    extra: {
      projectId: input.projectId,
      rootId: context.rootId,
      resolveProjectName: context.rootSummary.resolveProjectName,
      chunkCount: chunks.length,
      clipCount: rawInventory.length,
    },
  });

  const transformWarnings: string[] = [];
  const drpSnapshots: IColorResolveProjectSnapshot[] = [];
  const preparedClipsForSync: IColorExecutorClipInput[] = [];
  let lastPreparedMirrorStatus: IColorExecutorPrepareRootResult['mirrorStatus'] | undefined;
  let lastPreparedHostSummary: Record<string, unknown> | undefined;
  let lastPreparedResolveProjectName: string | undefined;
  let completedChunkCount = 0;

  for (const chunk of chunks) {
    if (chunk.status === 'ready') {
      const executorClips = buildColorSyncExecutorClipsForInventory(
        chunk.items,
        previousClipSnapshots,
      );
      const preparedClipTransforms = await resolveExecutorClipTransforms(context, executorClips, {
        syncLuts: false,
        ignoreBlockers: true,
      });
      preparedClipsForSync.push(...preparedClipTransforms.clips);
      completedChunkCount += 1;
      continue;
    }
    await writeRootCurrent(context.projectRoot, context.rootId, current => ({
      ...current,
      mirrorStatus: 'running',
      timelineStatus: 'running',
      activeStage: 'prepare_root_timeline',
      currentJobId: input.jobId,
      detail: `正在准备 chunk ${chunk.index + 1}/${chunk.total}：${chunk.timelineName}`,
      prepareChunks: updatePrepareChunkStatus(current.prepareChunks ?? [], chunk.chunkId, {
        status: 'running',
        detail: `正在准备 ${chunk.clipCount} 个 clips。`,
      }),
      blockingReasons: filterPersistentColorBlockers(current.blockingReasons ?? []),
    }));
    await writeProgress(progressPath, action, {
      status: 'running',
      stepIndex: 2,
      current: chunk.index,
      detail: `正在准备 chunk ${chunk.index + 1}/${chunk.total}：${chunk.timelineName}`,
      extra: {
        projectId: input.projectId,
        rootId: context.rootId,
        chunkId: chunk.chunkId,
        chunkIndex: chunk.index + 1,
        chunkTotal: chunk.total,
        clipCount: chunk.clipCount,
      },
    });

    try {
      const executorClips = await buildColorExecutorClipsForInventory(
        chunk.items,
        context.runtimeConfig,
        {
          workspaceRoot: context.workspaceRoot,
          rootColorSpaceProfile: context.rootSummary.colorSpaceProfile,
          rootTransformPresetKey: context.rootSummary.transformPresetKey,
          transformPresetsConfig: context.transformPresetsConfig,
        },
      );
      const executorClipsWithPreviousRepair = applyPreviousColorRepairSnapshots(
        executorClips,
        previousClipSnapshots,
      );
      const timelineSpec = selectDominantTimelineSpec(executorClipsWithPreviousRepair);
      const orientedExecutorClips = applyColorTimelineTransforms(executorClipsWithPreviousRepair, timelineSpec);
      const preparedClipTransforms = await resolveExecutorClipTransforms(context, orientedExecutorClips, {
        syncLuts: true,
      });
      transformWarnings.push(...preparedClipTransforms.warnings);
      preparedClipsForSync.push(...applyCurrentColorRepairTemplateHashes(
        preparedClipTransforms.clips,
        repairTemplateHashes,
      ));
      const resetTimeline = shouldResetColorPrepareTimeline(chunks, chunk);
      const prepared = await runColorHostWithRetry(
        () => executor.prepareRoot({
          projectId: input.projectId,
          rootId: context.rootId,
          resolveProjectName: context.rootSummary.resolveProjectName,
          rootNamespace: context.rootSummary.rootNamespace,
          gradingTimelineName: context.rootSummary.gradingTimelineName,
          rawPath: context.rootSummary.rawPath,
          rawLocalPath: context.rootSummary.rawLocalPath ?? '',
          repairDrtPath: join(context.workspaceRoot, 'config', 'default.drt'),
          repairTemplates: buildColorRepairTemplates(context.workspaceRoot),
          timelineSpec,
          lutSyncSummary: preparedClipTransforms.lutSyncSummary,
          clips: preparedClipTransforms.clips,
          chunkId: chunk.chunkId,
          resetTimeline,
        }),
        `prepare_root:${context.rootId}:${chunk.chunkId}`,
      );
      lastPreparedMirrorStatus = prepared.mirrorStatus;
      lastPreparedHostSummary = prepared.hostSummary;
      lastPreparedResolveProjectName = prepared.resolveProjectName;
      const repairSeedNotice = describeRepairSeedNotice(prepared.hostSummary);
      completedChunkCount += 1;
      chunk.status = 'ready';
      chunk.completedAt = new Date().toISOString();
      await writeRootCurrent(context.projectRoot, context.rootId, current => ({
        ...current,
        mirrorStatus: prepared.mirrorStatus,
        timelineStatus: completedChunkCount === chunks.length ? prepared.timelineStatus : 'running',
        detail: [
          `已完成 chunk ${chunk.index + 1}/${chunk.total}：${chunk.timelineName}`,
          repairSeedNotice,
        ].filter(Boolean).join(' '),
        hostSummary: mergeColorHostSummary(current.hostSummary, prepared.hostSummary, chunks),
        prepareChunks: updatePrepareChunkStatus(current.prepareChunks ?? [], chunk.chunkId, {
          status: 'ready',
          completedAt: new Date().toISOString(),
          detail: `已准备 ${chunk.clipCount} 个 clips。`,
        }),
        latestDrpSnapshot: drpSnapshots[drpSnapshots.length - 1] ?? current.latestDrpSnapshot,
        blockingReasons: filterPersistentColorBlockers(current.blockingReasons ?? []),
      }));
    } catch (error) {
      const blockers = [error instanceof Error ? error.message : String(error)];
      await writeRootCurrent(context.projectRoot, context.rootId, current => ({
        ...current,
        mirrorStatus: 'blocked',
        timelineStatus: 'blocked',
        activeStage: undefined,
        currentJobId: undefined,
        detail: blockers.join('；'),
        prepareChunks: updatePrepareChunkStatus(current.prepareChunks ?? [], chunk.chunkId, {
          status: 'failed',
          detail: blockers.join('；'),
        }),
        blockingReasons: dedupeStrings([...(current.blockingReasons ?? []), ...blockers]),
      }));
      await failColorAction(context.projectRoot, context.rootId, progressPath, action, blockers, {
        projectId: input.projectId,
        rootId: context.rootId,
        resolveProjectName: context.rootSummary.resolveProjectName,
        gradingTimelineName: context.rootSummary.gradingTimelineName,
        chunkId: chunk.chunkId,
      }, {
        suppressProgress: input.suppressProgress,
      });
      throw error;
    }
  }

  let detail: string;
  let savedCurrent: Awaited<ReturnType<typeof writeRootCurrent>>;
  let mergedSnapshot: IColorGroupsSnapshotFile;
  let savedDrp: Awaited<ReturnType<IColorExecutor['saveDrpSnapshot']>>;
  try {
    mergedSnapshot = await runColorHostWithRetry(
      () => executor.syncGroups({
        projectId: input.projectId,
        rootId: context.rootId,
        resolveProjectName: context.rootSummary.resolveProjectName,
        gradingTimelineName: context.rootSummary.gradingTimelineName,
        rawPath: context.rootSummary.rawPath,
        rawLocalPath: context.rootSummary.rawLocalPath ?? '',
        clips: preparedClipsForSync,
      }),
      `sync_groups:${context.rootId}:prepare-complete`,
    );
    savedDrp = await runColorHostWithRetry(
      () => executor.saveDrpSnapshot({
        projectId: input.projectId,
        resolveProjectName: context.rootSummary.resolveProjectName,
        snapshotRoot: resolveColorDrpSnapshotRoot(context.projectRoot, context.rootSummary.resolveProjectName),
        snapshotLabel: `prepare-root-${context.rootId}-complete`,
        latestFilename: resolveColorDrpLatestFilename(context.rootSummary.resolveProjectName),
        retention: 'latest-only',
        action: 'prepare_root',
        rootId: context.rootId,
      }),
      `save_drp_snapshot:${context.rootId}:prepare-complete`,
    );
    const savedSnapshot = {
      ...normalizeRequiredColorDrpSnapshot(savedDrp.snapshot, context.rootSummary.resolveProjectName),
      retention: 'latest-only' as const,
    };
    await recordColorDrpSnapshots(context.projectRoot, context.rootSummary.resolveProjectName, [savedSnapshot]);
    drpSnapshots.push(savedSnapshot);
  } catch (error) {
    const blockers = [error instanceof Error ? error.message : String(error)];
    await writeRootCurrent(context.projectRoot, context.rootId, current => ({
      ...current,
      mirrorStatus: 'blocked',
      timelineStatus: 'blocked',
      activeStage: undefined,
      currentJobId: undefined,
      detail: blockers.join('；'),
      blockingReasons: dedupeStrings([...(current.blockingReasons ?? []), ...blockers]),
    }));
    await failColorAction(context.projectRoot, context.rootId, progressPath, action, blockers, {
      projectId: input.projectId,
      rootId: context.rootId,
      resolveProjectName: context.rootSummary.resolveProjectName,
      gradingTimelineName: context.rootSummary.gradingTimelineName,
      stage: 'prepare_complete_sync_or_drp',
    }, {
      suppressProgress: input.suppressProgress,
    });
    throw error;
  }
  const syncedGroups = materializeCurrentGroupsFromSnapshot(
    mergedSnapshot,
    context.colorCurrent.roots.find(root => root.rootId === context.rootId)?.groups ?? [],
    context.groupsSnapshot,
  );
  await saveColorGroupsSnapshot(context.projectRoot, mergedSnapshot);
  const finalRepairSeedNotice = describeRepairSeedNotice(lastPreparedHostSummary);
  detail = [
    `Resolve host root prep 已完成：${completedChunkCount}/${chunks.length} chunks ready。`,
    `Kairos 已写入 ${mergedSnapshot.groups.length} 个 Resolve Groups 快照。`,
    finalRepairSeedNotice,
    '如需复核 Resolve 内调整，可继续运行 Sync Groups。',
  ].filter(Boolean).join(' ');
  savedCurrent = await writeRootCurrent(context.projectRoot, context.rootId, current => ({
    ...current,
    mirrorStatus: lastPreparedMirrorStatus ?? 'synced',
    timelineStatus: 'ready',
    groupSyncStatus: 'ready',
    groupSyncAt: mergedSnapshot.syncedAt ?? current.groupSyncAt,
    activeStage: undefined,
    currentJobId: undefined,
    detail,
    hostSummary: mergeColorHostSummary(current.hostSummary, lastPreparedHostSummary, chunks),
    groups: syncedGroups,
    latestDrpSnapshot: drpSnapshots[drpSnapshots.length - 1] ?? current.latestDrpSnapshot,
    blockingReasons: filterPersistentColorBlockers(current.blockingReasons ?? []),
  }));
  await writeProgress(progressPath, action, {
    status: 'succeeded',
    stepIndex: 2,
    current: chunks.length,
    detail,
    extra: {
      projectId: input.projectId,
      rootId: context.rootId,
      hostPreflight,
      hostSummary: mergeColorHostSummary(lastPreparedHostSummary, savedDrp.hostSummary, chunks),
      transformWarnings,
      groupCount: mergedSnapshot.groups.length,
      chunkCount: chunks.length,
      drpSnapshotPath: drpSnapshots[drpSnapshots.length - 1]?.snapshotPath,
    },
  });

  const savedRoot = savedCurrent.roots.find(root => root.rootId === context.rootId);
  return {
    action,
    projectId: input.projectId,
    rootId: context.rootId,
    resolveProjectName: lastPreparedResolveProjectName ?? context.rootSummary.resolveProjectName,
    rootNamespace: context.rootSummary.rootNamespace,
    gradingTimelineName: context.rootSummary.gradingTimelineName,
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
  const hasExistingResolveGroupTruth = Boolean(
    (context.groupsSnapshot?.groups?.length ?? 0) > 0
    || (context.rootSummary.colorCurrent.groups?.length ?? 0) > 0
    || context.rootSummary.colorCurrent.groupSyncStatus === 'ready',
  );
  const blockers = dedupeStrings([
    !context.rootSummary.rawPath ? '当前 root 未配置 rawPath，无法同步 Groups。' : '',
    !context.rootSummary.rawLocalPath ? '当前设备未配置 rawLocalPath，无法同步 Groups。' : '',
    context.rootSummary.colorCurrent.timelineStatus !== 'ready' && !hasExistingResolveGroupTruth
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
  const executorClips = buildColorSyncExecutorClipsForInventory(
    await scanColorRawInventory(context.rootSummary.rawLocalPath ?? ''),
    buildColorClipRepairSnapshotIndex(context.groupsSnapshot),
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

  assertClipKeysPreparedByReadyChunks(
    syncedClipTransforms.clips.map(clip => clip.rawRelativePath),
    context.colorCurrent.roots.find(root => root.rootId === context.rootId)?.prepareChunks ?? [],
    'sync_groups',
  );
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
    mirrorStatus: current.mirrorStatus === 'blocked' || !current.mirrorStatus ? 'synced' : current.mirrorStatus,
    timelineStatus: 'ready',
    groupSyncStatus: 'ready',
    groupSyncAt: snapshot.syncedAt ?? new Date().toISOString(),
    activeStage: undefined,
    currentJobId: undefined,
    detail: `已同步 ${snapshot.groups.length} 个 Resolve Groups。`,
    blockingReasons: [],
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
    context.rootSummary.localPath && context.rootSummary.rawLocalPath
      && resolve(context.rootSummary.localPath) === resolve(context.rootSummary.rawLocalPath)
      ? 'current localPath 与 rawLocalPath 指向同一目录，直接渲染会覆盖原始素材。'
      : '',
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

  const overwritePreview = await buildColorOverwritePreviewForContext(context, requestedClipKeys);
  const overwriteBlockers = [
    ...validateColorOverwritePlanSafety(overwritePreview),
    ...validateColorOverwriteConfirmation(overwritePreview, input),
  ];
  if (overwriteBlockers.length > 0) {
    await failColorAction(context.projectRoot, context.rootId, progressPath, action, overwriteBlockers, {
      projectId: input.projectId,
      rootId,
      overwritePlanHash: overwritePreview.overwritePlanHash,
      existingCount: overwritePreview.existingCount,
    }, {
      suppressProgress: input.suppressProgress,
    });
    throw new ProjectColorBlockedError(overwriteBlockers);
  }
  const rawInventory = await scanColorRawInventory(context.rootSummary.rawLocalPath ?? '');
  const inventoryByKey = new Map(rawInventory.map(entry => [entry.rawRelativePath, entry]));
  const effectiveClipKeys = overwritePreview.targets.map(target => target.rawRelativePath);
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
  const outputRoot = overwritePreview.outputRoot ?? resolve(context.rootSummary.localPath ?? '');
  await mkdir(outputRoot, { recursive: true });
  const previewTargetByKey = new Map(overwritePreview.targets.map(target => [target.rawRelativePath, target]));
  const planEntries = await Promise.all(
    effectiveClipKeys.map(async clipKey => {
      const item = inventoryByKey.get(clipKey)!;
      const target = previewTargetByKey.get(clipKey)!;
      return {
        rawRelativePath: clipKey,
        sourceAbsolutePath: item.sourceAbsolutePath,
        sourceStem: target.sourceStem,
        outputPath: target.outputPath,
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
    outputRoot,
    renderPreset: context.rootSummary.renderPreset,
    selectionMode: requestedClipKeys.length > 0 ? 'subset' : 'all',
    clipKeys: effectiveClipKeys,
    overwritePlanHash: overwritePreview.overwritePlanHash,
    renderJobs: [],
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
      outputRoot,
      clipCount: effectiveClipKeys.length,
      selectionMode: plan.selectionMode,
    },
  });

  assertClipKeysPreparedByReadyChunks(
    planEntries.map(entry => entry.rawRelativePath),
    context.colorCurrent.roots.find(root => root.rootId === context.rootId)?.prepareChunks ?? [],
    'execute_root',
  );
  const planEntryByKey = new Map(planEntries.map(entry => [entry.rawRelativePath, entry]));
  let rendered: Awaited<ReturnType<IColorExecutor['executeRoot']>>;
  let finalRenderedEntries: Array<Awaited<ReturnType<IColorExecutor['executeRoot']>>['entries'][number] & {
    outputPath: string;
    sourceMetadataSnapshot?: IColorFileMetadataSnapshot;
  }>;
  try {
    rendered = await runColorHostWithRetry(
      () => executor.executeRoot({
        projectId: input.projectId,
        rootId,
        resolveProjectName: context.rootSummary.resolveProjectName,
        gradingTimelineName: context.rootSummary.gradingTimelineName,
        rawLocalPath: context.rootSummary.rawLocalPath ?? '',
        renderPreset: context.rootSummary.renderPreset,
        outputRoot,
        selectionMode: plan.selectionMode,
        clips: planEntries.map(entry => ({
          rawRelativePath: entry.rawRelativePath,
          sourceAbsolutePath: entry.sourceAbsolutePath,
          sourceStem: entry.sourceStem ?? deriveSourceStem(entry.rawRelativePath),
          width: entry.sourceMetadataSnapshot?.width,
          height: entry.sourceMetadataSnapshot?.height,
          fps: entry.sourceMetadataSnapshot?.fps,
        })),
      }),
      `execute_root:${context.rootId}:${batchId}`,
    );
    finalRenderedEntries = await verifyRenderedEntriesAtFinalOutputs(rendered.entries, previewTargetByKey);
    finalRenderedEntries = finalRenderedEntries.map(entry => {
      const sourceMetadataSnapshot = planEntryByKey.get(entry.rawRelativePath)?.sourceMetadataSnapshot;
      return {
        ...entry,
        outputPath: resolve(entry.outputPath),
        sourceMetadataSnapshot,
      };
    });
  } catch (error) {
    const failure = describeColorHostFailure(error);
    await failColorAction(context.projectRoot, context.rootId, progressPath, action, failure.blockers, {
      projectId: input.projectId,
      rootId,
      batchId,
      outputRoot,
      hostFailure: failure.hostSummary,
    }, {
      suppressProgress: input.suppressProgress,
    });
    await writeRootCurrent(context.projectRoot, context.rootId, current => ({
      ...current,
      latestBatchId: batchId,
      latestBatchStatus: 'failed',
      latestValidationStatus: 'pending',
      pendingPromoteBatchId: undefined,
      hostSummary: {
        ...(isPlainObject(current.hostSummary) ? current.hostSummary : {}),
        latestExecuteFailure: failure.hostSummary,
      },
    }));
    throw new ProjectColorBlockedError(failure.blockers);
  }

  const manifestEntries = await Promise.all(
    finalRenderedEntries.map(async entry => {
      const planEntry = planEntryByKey.get(entry.rawRelativePath);
      return {
        rawRelativePath: entry.rawRelativePath,
        outputPath: resolve(entry.outputPath),
        normalizedOutputFilename: entry.normalizedOutputFilename,
        sourceStem: planEntry?.sourceStem,
        renderJobId: entry.renderJobId,
        sourceMetadataSnapshot: entry.sourceMetadataSnapshot,
        outputMetadataSnapshot: await buildColorFileMetadataSnapshot(entry.outputPath, context.runtimeConfig).catch(() => undefined),
        sidecars: [],
      };
    }),
  );
  const manifest: IColorBatchManifest = {
    batchId,
    rootId,
    createdAt: rendered.renderedAt,
    renderPreset: context.rootSummary.renderPreset,
    managedOutputSet: manifestEntries.map(entry => normalizePortablePath(relative(outputRoot, entry.outputPath))),
    managedSidecarSet: [],
    renderJobs: normalizeColorBatchRenderJobs(rendered.renderJobs ?? []),
    metadataRepair: {
      status: 'pending',
      repairedCount: 0,
      skippedCount: 0,
      failedOutputs: [],
      warnings: [],
    },
    entries: manifestEntries,
  };
  await saveColorBatchManifest(context.projectRoot, manifest);

  await saveColorBatchPlan(context.projectRoot, {
    ...plan,
    renderJobs: manifest.renderJobs,
    entries: plan.entries,
  });
  const detail = `root batch 已渲染，等待手动同步元信息 / sidecar / validation：${batchId}`;
  await writeRootCurrent(context.projectRoot, context.rootId, current => ({
    ...current,
    activeStage: undefined,
    currentJobId: undefined,
    detail,
    latestBatchId: batchId,
    latestBatchStatus: 'rendered',
    latestValidationStatus: 'pending',
    pendingPromoteBatchId: undefined,
    blockingReasons: filterPersistentColorBlockers(current.blockingReasons ?? []),
  }));
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
      outputRoot,
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

export async function syncProjectColorBatchMetadata(
  input: IProjectColorActionInput,
): Promise<IProjectColorActionResult> {
  const action: TProjectColorAction = 'sync_batch_metadata';
  const rootId = input.rootId?.trim();
  if (!rootId) {
    throw new ProjectColorBlockedError(['sync_batch_metadata requires rootId。']);
  }
  const context = await loadColorRootContext(input.workspaceRoot, input.projectId, rootId);
  const progressPath = resolveColorProgressPath(context.projectRoot, input.progressPath);
  const writeProgress: TWriteColorProgress = input.suppressProgress
    ? async (..._args) => undefined
    : writeColorProgress;
  const batchId = resolveProjectColorActionBatchId(context, input.batchId);
  if (!batchId) {
    const blockers = ['sync_batch_metadata requires args.batchId or root latestBatchId。'];
    await failColorAction(context.projectRoot, context.rootId, progressPath, action, blockers, {
      projectId: input.projectId,
      rootId,
    }, {
      suppressProgress: input.suppressProgress,
    });
    throw new ProjectColorBlockedError(blockers);
  }

  let archive: Awaited<ReturnType<typeof loadColorBatchArchiveForPostprocess>>;
  try {
    archive = await loadColorBatchArchiveForPostprocess(context, batchId);
  } catch (error) {
    const ioBlockers = error instanceof ProjectColorBlockedError
      ? error.blockers
      : [error instanceof Error ? error.message : String(error)];
    await failColorAction(context.projectRoot, context.rootId, progressPath, action, ioBlockers, {
      projectId: input.projectId,
      rootId,
      batchId,
    }, {
      suppressProgress: input.suppressProgress,
    });
    throw new ProjectColorBlockedError(ioBlockers);
  }
  const { plan, manifest } = archive;
  const warnings: string[] = [];
  const preSyncTempCleanup = await cleanupColorMetadataTempFilesForManifest(manifest);
  appendColorMetadataTempCleanupWarnings(warnings, preSyncTempCleanup, 'before metadata sync');

  await writeRootCurrent(context.projectRoot, context.rootId, current => ({
    ...current,
    activeStage: 'sync_batch_metadata',
    currentJobId: input.jobId,
    latestBatchId: batchId,
    latestBatchStatus: 'rendered',
    latestValidationStatus: 'pending',
    detail: `正在同步 batch metadata：${batchId}`,
    blockingReasons: filterPersistentColorBlockers(current.blockingReasons ?? []),
  }));
  await writeProgress(progressPath, action, {
    status: 'running',
    stepIndex: 1,
    current: 0,
    total: manifest.entries.length,
    unit: 'file',
    detail: `正在同步 batch metadata：${batchId}`,
    extra: {
      projectId: input.projectId,
      rootId,
      batchId,
      repairedCount: 0,
      skippedCount: 0,
      failedCount: 0,
      concurrency: CCOLOR_METADATA_SYNC_CONCURRENCY,
    },
  });

  const planEntryByKey = new Map(plan.entries.map(entry => [entry.rawRelativePath, entry]));
  let repairedCount = 0;
  let skippedCount = 0;
  const failedOutputs: NonNullable<IColorBatchManifest['metadataRepair']>['failedOutputs'] = [];
  let completedCount = 0;
  let progressWriteChain: Promise<void> = Promise.resolve();
  const entries = await mapWithConcurrency(manifest.entries, CCOLOR_METADATA_SYNC_CONCURRENCY, async entry => {
    const planEntry = planEntryByKey.get(entry.rawRelativePath);
    const sourceMetadataSnapshot = planEntry?.sourceMetadataSnapshot
      ?? entry.sourceMetadataSnapshot
      ?? (planEntry?.sourceAbsolutePath
        ? await buildColorFileMetadataSnapshot(planEntry.sourceAbsolutePath, context.runtimeConfig).catch(() => undefined)
        : undefined);
    let outputPath = resolve(entry.outputPath);
    let outputMetadataSnapshot = await buildColorFileMetadataSnapshot(outputPath, context.runtimeConfig).catch(() => undefined);
    if (colorMetadataRepairRequired(sourceMetadataSnapshot)) {
      if (colorMetadataTargetFieldsSynced(sourceMetadataSnapshot, outputMetadataSnapshot)) {
        skippedCount += 1;
      } else {
        const outputStats = await stat(outputPath).catch(() => null);
        if (!outputStats?.isFile()) {
          failedOutputs.push({
            rawRelativePath: entry.rawRelativePath,
            outputPath,
            reason: 'output file missing',
          });
        } else {
          try {
            outputPath = await normalizeRenderedColorOutputMetadata(
              outputPath,
              sourceMetadataSnapshot,
              context.runtimeConfig,
            );
            repairedCount += 1;
            outputMetadataSnapshot = await buildColorFileMetadataSnapshot(outputPath, context.runtimeConfig).catch(() => undefined);
          } catch (error) {
            failedOutputs.push({
              rawRelativePath: entry.rawRelativePath,
              outputPath,
              reason: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }
    }
    const updatedEntry = {
      ...entry,
      outputPath,
      sourceMetadataSnapshot: sourceMetadataSnapshot ?? entry.sourceMetadataSnapshot,
      outputMetadataSnapshot,
    };
    await recordMetadataSyncProgress(updatedEntry);
    return updatedEntry;
  });

  async function recordMetadataSyncProgress(entry: IColorBatchManifest['entries'][number]): Promise<void> {
    const currentCount = completedCount + 1;
    completedCount = currentCount;
    progressWriteChain = progressWriteChain.then(() => writeProgress(progressPath, action, {
        status: 'running',
        stepIndex: 1,
        current: currentCount,
        total: manifest.entries.length,
        unit: 'file',
        detail: `正在同步 metadata：${currentCount}/${manifest.entries.length} ${entry.rawRelativePath}`,
        extra: {
          projectId: input.projectId,
          rootId,
          batchId,
          repairedCount,
          skippedCount,
          failedCount: failedOutputs.length,
          concurrency: CCOLOR_METADATA_SYNC_CONCURRENCY,
        },
      }));
    await progressWriteChain;
  }

  if (progressWriteChain) {
    await progressWriteChain;
  }
  const postSyncTempCleanup = await cleanupColorMetadataTempFilesForManifest({
    ...manifest,
    entries,
  });
  appendColorMetadataTempCleanupWarnings(warnings, postSyncTempCleanup, 'after metadata sync');

  const updatedManifest: IColorBatchManifest = {
    ...manifest,
    metadataRepair: {
      status: failedOutputs.length > 0 ? 'failed' : 'completed',
      repairedCount,
      skippedCount,
      failedOutputs,
      warnings,
    },
    entries,
  };
  await saveColorBatchManifest(context.projectRoot, updatedManifest);

  const failures = failedOutputs.map(output => `metadata sync failed: ${output.rawRelativePath ?? output.outputPath} (${output.reason})`);
  const detail = failures.length > 0
    ? `batch metadata 同步失败：${batchId}`
    : `batch metadata 已同步：${batchId}`;
  await writeRootCurrent(context.projectRoot, context.rootId, current => (
    current.latestBatchId === batchId
      ? {
        ...current,
        activeStage: undefined,
        currentJobId: undefined,
        latestBatchId: batchId,
        latestBatchStatus: 'rendered',
        latestValidationStatus: 'pending',
        detail,
        blockingReasons: failures.length > 0 ? failures : filterPersistentColorBlockers(current.blockingReasons ?? []),
      }
      : {
        ...current,
        detail: `batch ${batchId} metadata 已同步，但它已不是当前最新候选。`,
      }
  ));
  await writeProgress(progressPath, action, {
    status: failures.length > 0 ? 'failed' : 'succeeded',
    stepIndex: 1,
    current: entries.length,
    total: manifest.entries.length,
    unit: 'file',
    detail,
    extra: {
      projectId: input.projectId,
      rootId,
      batchId,
      repairedCount,
      skippedCount,
      failedCount: failures.length,
      concurrency: CCOLOR_METADATA_SYNC_CONCURRENCY,
    },
  });

  if (failures.length > 0) {
    throw new ProjectColorBlockedError(failures);
  }
  return {
    action,
    projectId: input.projectId,
    rootId,
    batchId,
    detail,
    blockingReasons: [],
  };
}

export async function syncProjectColorBatchSidecars(
  input: IProjectColorActionInput,
): Promise<IProjectColorActionResult> {
  const action: TProjectColorAction = 'sync_batch_sidecars';
  const rootId = input.rootId?.trim();
  if (!rootId) {
    throw new ProjectColorBlockedError(['sync_batch_sidecars requires rootId。']);
  }
  const context = await loadColorRootContext(input.workspaceRoot, input.projectId, rootId);
  const progressPath = resolveColorProgressPath(context.projectRoot, input.progressPath);
  const writeProgress: TWriteColorProgress = input.suppressProgress
    ? async (..._args) => undefined
    : writeColorProgress;
  const batchId = resolveProjectColorActionBatchId(context, input.batchId);
  if (!batchId) {
    const blockers = ['sync_batch_sidecars requires args.batchId or root latestBatchId。'];
    await failColorAction(context.projectRoot, context.rootId, progressPath, action, blockers, {
      projectId: input.projectId,
      rootId,
    }, {
      suppressProgress: input.suppressProgress,
    });
    throw new ProjectColorBlockedError(blockers);
  }

  let archive: Awaited<ReturnType<typeof loadColorBatchArchiveForPostprocess>>;
  try {
    archive = await loadColorBatchArchiveForPostprocess(context, batchId);
  } catch (error) {
    const ioBlockers = error instanceof ProjectColorBlockedError
      ? error.blockers
      : [error instanceof Error ? error.message : String(error)];
    await failColorAction(context.projectRoot, context.rootId, progressPath, action, ioBlockers, {
      projectId: input.projectId,
      rootId,
      batchId,
    }, {
      suppressProgress: input.suppressProgress,
    });
    throw new ProjectColorBlockedError(ioBlockers);
  }
  const { plan, manifest } = archive;

  await writeProgress(progressPath, action, {
    status: 'running',
    stepIndex: 1,
    current: 0,
    detail: `正在同步 batch sidecar：${batchId}`,
    extra: { projectId: input.projectId, rootId, batchId },
  });

  const planEntryByKey = new Map(plan.entries.map(entry => [entry.rawRelativePath, entry]));
  const failures: string[] = [];
  const entries = await Promise.all(manifest.entries.map(async entry => {
    const planEntry = planEntryByKey.get(entry.rawRelativePath);
    if (!planEntry) {
      failures.push(`sidecar sync missing plan entry: ${entry.rawRelativePath}`);
      return entry;
    }
    try {
      const outputRelativePath = normalizePortablePath(relative(
        context.rootSummary.localPath ?? plan.outputRoot,
        entry.outputPath,
      ));
      const sidecars = await mirrorColorSidecarsForEntry({
        rawLocalPath: context.rootSummary.rawLocalPath ?? '',
        sourceAbsolutePath: planEntry.sourceAbsolutePath,
          outputRelativePath,
          localRootPath: context.rootSummary.localPath ?? plan.outputRoot,
      });
      return {
        ...entry,
        sidecars,
      };
    } catch (error) {
      failures.push(`sidecar sync failed: ${entry.rawRelativePath} (${error instanceof Error ? error.message : String(error)})`);
      return entry;
    }
  }));

  const updatedManifest: IColorBatchManifest = {
    ...manifest,
    managedSidecarSet: entries.flatMap(entry => (entry.sidecars ?? []).map(sidecar => sidecar.outputRelativePath)),
    entries,
  };
  await saveColorBatchManifest(context.projectRoot, updatedManifest);

  const detail = failures.length > 0
    ? `batch sidecar 同步失败：${batchId}`
    : `batch sidecar 已同步：${batchId}`;
  await writeRootCurrent(context.projectRoot, context.rootId, current => (
    current.latestBatchId === batchId
      ? {
        ...current,
        activeStage: undefined,
        currentJobId: undefined,
        latestBatchId: batchId,
        latestBatchStatus: 'rendered',
        latestValidationStatus: 'pending',
        detail,
        blockingReasons: failures.length > 0 ? failures : filterPersistentColorBlockers(current.blockingReasons ?? []),
      }
      : {
        ...current,
        detail: `batch ${batchId} sidecar 已同步，但它已不是当前最新候选。`,
      }
  ));
  await writeProgress(progressPath, action, {
    status: failures.length > 0 ? 'failed' : 'succeeded',
    stepIndex: 1,
    current: 1,
    detail,
    extra: {
      projectId: input.projectId,
      rootId,
      batchId,
      sidecarCount: updatedManifest.managedSidecarSet.length,
      failedCount: failures.length,
    },
  });

  if (failures.length > 0) {
    throw new ProjectColorBlockedError(failures);
  }
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
  const batchId = resolveProjectColorActionBatchId(context, input.batchId);
  const blockers = dedupeStrings([
    !batchId ? 'validate_batch requires args.batchId or root latestBatchId。' : '',
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

  let archive: Awaited<ReturnType<typeof loadColorBatchArchiveForPostprocess>>;
  try {
    archive = await loadColorBatchArchiveForPostprocess(context, batchId!);
  } catch (error) {
    const ioBlockers = error instanceof ProjectColorBlockedError
      ? error.blockers
      : [error instanceof Error ? error.message : String(error)];
    await failColorAction(context.projectRoot, context.rootId, progressPath, action, ioBlockers, {
      projectId: input.projectId,
      rootId,
      batchId,
    }, {
      suppressProgress: input.suppressProgress,
    });
    throw new ProjectColorBlockedError(ioBlockers);
  }
  const { plan, manifest } = archive;

  await writeProgress(progressPath, action, {
    status: 'running',
    stepIndex: 1,
    current: 0,
    detail: `正在校验 batch：${batchId}`,
    extra: { projectId: input.projectId, rootId, batchId },
  });

  const planEntryByKey = new Map(plan.entries.map(entry => [entry.rawRelativePath, entry]));
  const validationEntries = await Promise.all(
    manifest.entries.map(async entry => {
      const planEntry = planEntryByKey.get(entry.rawRelativePath);
      const sourcePath = planEntry?.sourceAbsolutePath
        ?? resolve(join(context.rootSummary.rawLocalPath ?? '', ...entry.rawRelativePath.split('/')));
      const sourceMetadata = await buildColorFileMetadataSnapshot(sourcePath, context.runtimeConfig).catch(() => undefined);
      const outputMetadata = await buildColorFileMetadataSnapshot(entry.outputPath, context.runtimeConfig).catch(() => undefined);
      const outputRoot = context.rootSummary.localPath ?? plan.outputRoot;
      const outputRelativePath = normalizePortablePath(relative(outputRoot, entry.outputPath));
      const checks = buildColorValidationChecks({
        rawRelativePath: entry.rawRelativePath,
        outputRelativePath,
        normalizedOutputFilename: entry.normalizedOutputFilename,
        sourceMetadata,
        outputMetadata,
      });
      const expectedSidecars = planEntry
        ? await discoverColorSidecarsForEntry({
          rawLocalPath: context.rootSummary.rawLocalPath ?? '',
          sourceAbsolutePath: planEntry.sourceAbsolutePath,
          outputRelativePath,
          localRootPath: outputRoot,
        })
        : [];
      const sidecarReasons = [
        ...await validateExpectedColorSidecars(expectedSidecars, entry.sidecars ?? []),
        ...await validateColorSidecars(entry.sidecars ?? []),
      ];
      const warnings = collectValidationWarnings(checks);
      let reasons = collectValidationReasons(checks, {
        sourcePath,
        outputPath: entry.outputPath,
      });
      if (
        colorMetadataRepairRequired(sourceMetadata)
        && manifest.metadataRepair?.status !== 'completed'
      ) {
        reasons = reasons.filter(reason => !['capturedAt mismatch', 'gps mismatch'].includes(reason));
        reasons.push('metadata sync pending: run sync_batch_metadata before validate_batch');
      }
      reasons = reasons.concat(sidecarReasons);
      return {
        rawRelativePath: entry.rawRelativePath,
        outputPath: entry.outputPath,
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
      targetCount: plan.entries.length ?? manifest.entries.length ?? validationEntries.length,
      renderedCount: manifest.entries.length ?? validationEntries.length,
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
      latestBatchStatus: validationStatus === 'pass' ? 'validated' : 'rendered',
      latestValidationStatus: validationStatus,
      pendingPromoteBatchId: undefined,
      blockingReasons: validationStatus === 'pass'
        ? []
        : validationBlockingReasons,
      detail: validationStatus === 'pass'
        ? `batch 已通过 validation，并已替换最终 root 目标：${batchId}`
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
  const batchId = input.batchId?.trim();
  const blockers = dedupeStrings([
    '当前 Color Export 已改为按 raw 父目录临时时间线直接渲染到最终 root 目标；promote_batch 已移除。',
    batchId ? `batch ${batchId} 不需要 promote。` : '',
  ]);
  await failColorAction(context.projectRoot, context.rootId, progressPath, action, blockers, {
    projectId: input.projectId,
    rootId,
    batchId,
  }, {
    suppressProgress: input.suppressProgress,
  });
  throw new ProjectColorBlockedError(blockers);
}

async function loadEnabledProjectColorRootSummaries(
  workspaceRoot: string,
  projectId: string,
) {
  const projectRoot = resolveWorkspaceProjectRoot(workspaceRoot, projectId);
  const [projectBrief, projectRoots, colorCurrent, groupSnapshotsByRootId, colorResolveProjectMap] = await Promise.all([
    loadProjectBriefConfig(projectRoot).catch(() => null),
    loadIngestRoots(projectRoot),
    loadColorCurrent(projectRoot),
    loadColorGroupsSnapshots(projectRoot),
    loadColorResolveProjectMap(projectRoot),
  ]);
  const colorWorkspace = buildColorWorkspaceState({
    projectId,
    projectName: projectBrief?.name,
    projectRoots: projectRoots.roots.filter(root => root.enabled !== false),
    colorCurrent,
    resolveBackend: inspectResolveColorBackend(),
    groupSnapshotsByRootId,
    colorResolveProjectMap,
  });
  return colorWorkspace.colorRoots;
}

async function loadColorRootContext(
  workspaceRoot: string,
  projectId: string,
  rootId: string,
): Promise<IColorRootContext> {
  const projectRoot = resolveWorkspaceProjectRoot(workspaceRoot, projectId);
  const [
    projectBrief,
    projectRoots,
    colorCurrent,
    runtimeConfig,
    groupSnapshotsByRootId,
    transformPresetsConfig,
    colorResolveProjectMap,
  ] = await Promise.all([
    loadProjectBriefConfig(projectRoot).catch(() => null),
    loadIngestRoots(projectRoot),
    loadColorCurrent(projectRoot),
    loadRuntimeConfig(projectRoot),
    loadColorGroupsSnapshots(projectRoot),
    loadColorTransformPresetsConfig(workspaceRoot).catch(() => ({
      profiles: {},
      discoveredPresets: {},
    })),
    loadColorResolveProjectMap(projectRoot),
  ]);
  const colorWorkspace = buildColorWorkspaceState({
    projectId,
    projectName: projectBrief?.name,
    projectRoots: projectRoots.roots,
    colorCurrent,
    resolveBackend: inspectResolveColorBackend(),
    groupSnapshotsByRootId,
    colorResolveProjectMap,
  });
  const rootSummary = colorWorkspace.colorRoots.find(root => root.rootId === rootId);
  if (!rootSummary) {
    throw new ProjectColorBlockedError([`color root 不存在或未配置 rawPath: ${rootId}`]);
  }
  const rootConfig = projectRoots.roots.find(root => root.id === rootId);
  if (!rootConfig) {
    throw new ProjectColorBlockedError([`color root 配置不存在: ${rootId}`]);
  }
  return {
    workspaceRoot,
    projectRoot,
    projectId,
    rootId,
    rootConfig,
    rootSummary,
    colorCurrent,
    runtimeConfig,
    transformPresetsConfig,
    groupsSnapshot: await loadColorGroupsSnapshot(projectRoot, rootId),
  };
}

function resolveProjectColorActionBatchId(
  context: IColorRootContext,
  batchId?: string,
): string | undefined {
  return batchId?.trim()
    || context.colorCurrent.roots.find(root => root.rootId === context.rootId)?.latestBatchId?.trim()
    || undefined;
}

function validateColorBatchArchiveForAction(
  plan: IColorBatchPlan | null,
  manifest: IColorBatchManifest | null,
  batchId: string,
  rootId: string,
): string[] {
  return dedupeStrings([
    !plan ? `缺少 batch plan: ${batchId}` : '',
    !manifest ? `缺少 batch manifest: ${batchId}` : '',
    plan && plan.rootId !== rootId ? `batch ${batchId} 不属于 root ${rootId}` : '',
    manifest && manifest.rootId !== rootId ? `batch manifest ${batchId} 不属于 root ${rootId}` : '',
  ]);
}

async function loadColorBatchArchiveForPostprocess(
  context: IColorRootContext,
  batchId: string,
): Promise<{
  plan: IColorBatchPlan;
  manifest: IColorBatchManifest;
  recoveredManifest: boolean;
}> {
  const [plan, existingManifest] = await Promise.all([
    loadColorBatchPlan(context.projectRoot, batchId),
    loadColorBatchManifest(context.projectRoot, batchId),
  ]);
  const baseBlockers = validateColorBatchArchiveForAction(plan, existingManifest, batchId, context.rootId)
    .filter(blocker => blocker !== `缺少 batch manifest: ${batchId}`);
  if (baseBlockers.length > 0 || !plan) {
    throw new ProjectColorBlockedError(baseBlockers);
  }
  if (existingManifest) {
    return {
      plan,
      manifest: existingManifest,
      recoveredManifest: false,
    };
  }

  const recovered = await buildRecoveredRenderedColorManifest(context, plan);
  await saveColorBatchManifest(context.projectRoot, recovered);
  return {
    plan,
    manifest: recovered,
    recoveredManifest: true,
  };
}

async function buildRecoveredRenderedColorManifest(
  context: IColorRootContext,
  plan: IColorBatchPlan,
): Promise<IColorBatchManifest> {
  const outputRoot = plan.outputRoot || context.rootSummary.localPath;
  if (!outputRoot) {
    throw new ProjectColorBlockedError([
      `缺少 batch manifest: ${plan.batchId}`,
      '无法从 plan 恢复 manifest：缺少 outputRoot。',
    ]);
  }
  const blockers: string[] = [];
  const entries = await Promise.all(plan.entries.map(async entry => {
    const outputPath = entry.outputPath?.trim()
      ? resolve(entry.outputPath)
      : resolve(join(outputRoot, ...normalizePortablePath(entry.rawRelativePath).replace(/\.[^/.]+$/u, '.mp4').split('/')));
    const stats = await stat(outputPath).catch(() => null);
    if (!stats?.isFile()) {
      blockers.push(`rendered output missing for manifest recovery: ${entry.rawRelativePath}`);
    }
    return {
      rawRelativePath: entry.rawRelativePath,
      outputPath,
      normalizedOutputFilename: posix.basename(normalizePortablePath(outputPath)),
      sourceStem: entry.sourceStem,
      sourceMetadataSnapshot: entry.sourceMetadataSnapshot,
      outputMetadataSnapshot: undefined,
      sidecars: [],
    };
  }));
  if (blockers.length > 0) {
    throw new ProjectColorBlockedError([
      `缺少 batch manifest: ${plan.batchId}`,
      ...dedupeStrings(blockers),
    ]);
  }
  return {
    batchId: plan.batchId,
    rootId: plan.rootId,
    createdAt: new Date().toISOString(),
    renderPreset: plan.renderPreset,
    managedOutputSet: entries.map(entry => normalizePortablePath(relative(outputRoot, entry.outputPath))),
    managedSidecarSet: [],
    renderJobs: normalizeColorBatchRenderJobs(plan.renderJobs ?? []),
    metadataRepair: {
      status: 'pending',
      repairedCount: 0,
      skippedCount: 0,
      failedOutputs: [],
      warnings: ['manifest recovered from plan and existing rendered outputs'],
    },
    entries,
  };
}

function colorMetadataRepairRequired(
  sourceMetadataSnapshot?: IColorFileMetadataSnapshot,
): boolean {
  return Boolean(sourceMetadataSnapshot?.capturedAt || sourceMetadataSnapshot?.gps);
}

function colorMetadataTargetFieldsSynced(
  sourceMetadataSnapshot: IColorFileMetadataSnapshot | undefined,
  outputMetadataSnapshot: IColorFileMetadataSnapshot | undefined,
): boolean {
  if (!colorMetadataRepairRequired(sourceMetadataSnapshot)) return true;
  if (!outputMetadataSnapshot) return false;
  if (
    sourceMetadataSnapshot?.capturedAt
    && !sameOptionalIsoTimestamp(sourceMetadataSnapshot.capturedAt, outputMetadataSnapshot.createTime)
  ) {
    return false;
  }
  if (
    sourceMetadataSnapshot?.gps
    && compareOptionalTuple(
      sourceMetadataSnapshot.gps[0],
      sourceMetadataSnapshot.gps[1],
      outputMetadataSnapshot.gps?.[0],
      outputMetadataSnapshot.gps?.[1],
      0.000001,
    ) !== 'pass'
  ) {
    return false;
  }
  return true;
}

function sameOptionalIsoTimestamp(left: string | undefined, right: string | undefined): boolean {
  if (!left?.trim() || !right?.trim()) return false;
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  if (Number.isFinite(leftMs) && Number.isFinite(rightMs)) {
    return leftMs === rightMs;
  }
  return left.trim() === right.trim();
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
    case 'relink_media':
    case 'prepare_root':
    case 'sync_groups':
    case 'execute_root':
    case 'sync_batch_metadata':
    case 'sync_batch_sidecars':
    case 'validate_batch':
    case 'promote_batch':
    case 'relink_all_roots':
    case 'prepare_all_roots':
    case 'export_all_roots':
    case 'save_drp_snapshot':
      return normalized;
    default:
      throw new Error(`Unsupported color action: ${normalized}`);
  }
}

function buildColorRelinkRootMapping(context: IColorRootContext): IColorExecutorRelinkMediaRoot | null {
  const localPath = context.rootSummary.rawLocalPath?.trim();
  if (!localPath) return null;
  const candidates = dedupeStrings([
    localPath,
    context.rootSummary.rawPath,
    ...buildRootPathCandidates(context.rootConfig, 'rawPath').map(candidate => candidate.path),
  ]);
  return {
    rootId: context.rootId,
    ...(context.rootSummary.label ? { label: context.rootSummary.label } : {}),
    localPath,
    candidates,
  };
}

function formatColorRelinkDetail(hostSummary: Record<string, unknown> | undefined): string {
  const summary: Record<string, unknown> = isPlainObject(hostSummary) ? hostSummary : {};
  const relinked = readSummaryNumber(summary, 'relinked');
  const folderCount = readSummaryNumber(summary, 'relinkFolderCount');
  const oldRemaining = readSummaryNumber(summary, 'oldPathRemaining')
    + readSummaryNumber(summary, 'timelineOldPathRemaining');
  const missingTargets = readSummaryNumber(summary, 'missingTargetCount')
    + readSummaryNumber(summary, 'timelineMissingTargetCount');
  const unmapped = readSummaryNumber(summary, 'unmappedCount')
    + readSummaryNumber(summary, 'timelineUnmappedCount');
  const skippedNonFile = readSummaryNumber(summary, 'skippedNonFileCount')
    + readSummaryNumber(summary, 'timelineSkippedNonFileCount');
  return [
    `Resolve Color 素材重链完成：${relinked} 个 item，${folderCount} 个目标目录。`,
    oldRemaining > 0 ? `仍有旧路径 ${oldRemaining} 个。` : '',
    missingTargets > 0 ? `缺失目标 ${missingTargets} 个。` : '',
    unmapped > 0 ? `未映射 ${unmapped} 个。` : '',
    skippedNonFile > 0 ? `跳过非文件对象 ${skippedNonFile} 个。` : '',
  ].filter(Boolean).join(' ');
}

function readSummaryNumber(summary: Record<string, unknown>, key: string): number {
  const value = summary[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
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
    prepareChunks: [],
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
      orientationStatus: group.orientationStatus ?? existing?.orientationStatus,
      lowlight: group.lowlight ?? existing?.lowlight,
      colorCastClass: group.colorCastClass ?? existing?.colorCastClass,
      exposureSceneClass: group.exposureSceneClass ?? existing?.exposureSceneClass,
      postClipCreativeStatus: group.postClipCreativeStatus ?? existing?.postClipCreativeStatus,
      blockingReasons: nextStatus === 'blocked'
        ? dedupeStrings([...(clipKeysChanged ? [] : existing?.blockingReasons ?? []), '该 Group 当前没有可执行 clip。'])
        : [],
    };
  });
}

function mergeColorHostSummary(
  current: Record<string, unknown> | undefined,
  next: Record<string, unknown> | undefined,
  chunks: IColorPrepareChunkPlan[],
): Record<string, unknown> {
  const currentSummary = isPlainObject(current) ? current : {};
  const nextSummary = isPlainObject(next) ? next : {};
  const completedChunks = chunks.filter(chunk => chunk.status === 'ready').length;
  return {
    ...currentSummary,
    ...nextSummary,
    prepareChunkSize: CCOLOR_PREPARE_CHUNK_SIZE,
    prepareProbeConcurrency: CCOLOR_PREPARE_PROBE_CONCURRENCY,
    prepareChunkCount: chunks.length,
    prepareCompletedChunkCount: Math.max(
      Number(currentSummary.prepareCompletedChunkCount ?? 0),
      completedChunks,
    ),
    prepareClipCount: chunks.reduce((total, chunk) => total + chunk.clipCount, 0),
    gradingTimelineName: chunks[0]?.timelineName ?? currentSummary.gradingTimelineName ?? nextSummary.gradingTimelineName,
    prepareTimelineNames: dedupeStrings([
      ...extractStringArray(currentSummary.prepareTimelineNames),
      ...extractStringArray(nextSummary.prepareTimelineNames),
      ...chunks.map(chunk => chunk.timelineName),
    ]),
  };
}

function describeRepairSeedNotice(hostSummary: Record<string, unknown> | undefined): string | undefined {
  if (!isPlainObject(hostSummary)) return undefined;
  const status = typeof hostSummary.repairTemplateStatus === 'string'
    ? hostSummary.repairTemplateStatus.trim()
    : '';
  const missingOrientationCount = typeof hostSummary.repairOrientationTemplateMissingClipCount === 'number'
    ? hostSummary.repairOrientationTemplateMissingClipCount
    : 0;
  if (missingOrientationCount > 0) {
    return `竖屏 Gyro DRT 缺失，已跳过 ${missingOrientationCount} 个竖屏 clip 的自动 Gyro seed；素材、Group 与横屏 transform 已继续准备。`;
  }
  if (status !== 'skipped-missing-drt') return undefined;
  return 'Repair 模板缺失；默认 DRT 缺失应在 Resolve 变更前阻塞，请检查 config/default.drt。';
}

function resolveColorDrpSnapshotRoot(projectRoot: string, resolveProjectName: string): string {
  return join(getColorResolveProjectsRoot(projectRoot), safeColorProjectName(resolveProjectName));
}

async function recordColorDrpSnapshots(
  projectRoot: string,
  resolveProjectName: string,
  snapshots: IColorResolveProjectSnapshot[],
): Promise<IColorResolveProjectMap> {
  const normalizedSnapshots = snapshots
    .map(snapshot => normalizeColorDrpSnapshot({
      ...snapshot,
      projectName: snapshot.projectName || resolveProjectName,
    }))
    .filter((snapshot): snapshot is IColorResolveProjectSnapshot => Boolean(snapshot));
  if (normalizedSnapshots.length === 0) {
    return loadColorResolveProjectMap(projectRoot);
  }
  const existing = await loadColorResolveProjectMap(projectRoot);
  const safeProjectName = safeColorProjectName(resolveProjectName);
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
    ?? orderedSnapshots[orderedSnapshots.length - 1]
    ?? previous?.latestSnapshot;
  const updatedAt = new Date().toISOString();
  return saveColorResolveProjectMap(projectRoot, {
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

function normalizeColorDrpSnapshot(value: Record<string, unknown>): IColorResolveProjectSnapshot | null {
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
    database: isPlainObject(value.database) ? value.database : undefined,
    detail: typeof value.detail === 'string' && value.detail.trim() ? value.detail.trim() : undefined,
  };
}

function normalizeColorDrpSnapshotRetention(value: unknown): 'latest-only' | 'archive' {
  return value === 'archive' ? 'archive' : 'latest-only';
}

function formatColorDrpSnapshotDetail(snapshot: IColorResolveProjectSnapshot): string {
  return snapshot.retention === 'archive'
    ? `已归档 DRP 快照：${snapshot.snapshotPath}`
    : `已覆盖最新 DRP：${snapshot.latestPath || snapshot.snapshotPath}`;
}

function normalizeRequiredColorDrpSnapshot(
  value: IColorResolveProjectSnapshot | Record<string, unknown>,
  resolveProjectName: string,
): IColorResolveProjectSnapshot {
  const normalized = normalizeColorDrpSnapshot({
    ...value,
    projectName: typeof value.projectName === 'string' && value.projectName.trim()
      ? value.projectName
      : resolveProjectName,
  });
  if (!normalized) {
    throw new Error('Resolve host returned an invalid DRP snapshot payload.');
  }
  return normalized;
}

function safeColorProjectName(projectName: string): string {
  const normalized = projectName
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return normalized || `resolve-project-${hashString(projectName).slice(0, 10)}`;
}

function formatColorSnapshotTimestamp(value: string): string {
  return value
    .replace(/[:.]/g, '')
    .replace(/[^0-9TZ-]/g, '')
    .replace(/-+/g, '');
}

async function writeColorProgress(
  progressPath: string,
  action: TProjectColorAction,
  input: {
    status: 'running' | 'succeeded' | 'failed';
    stepIndex: number;
    current: number;
    total?: number;
    unit?: string;
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
    total: input.total ?? definitions.length,
    unit: input.unit ?? 'step',
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
    activeStage: undefined,
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
    && !blocker.includes('Unable to import clip repair template timeline')
    && !blocker.includes('renderPreset')
    && !blocker.includes('render preset')
    && !blocker.includes('Unable to set render settings')
    && !blocker.includes('Unable to queue render job')
    && !blocker.includes('Resolve queued a render job that is not using Source Name filenames')
    && !blocker.includes('Unable to locate rendered output')
    && !blocker.includes('Temporary render timeline')
    && !blocker.includes('Resolve Render Queue is not empty')
    && !blocker.includes('缺少 batch manifest')
    && !blocker.includes('metadata sync')
    && !blocker.includes('sidecar sync')
    && !blocker.includes('capturedAt mismatch')
    && !blocker.includes('gps mismatch')
    && !blocker.includes('默认 Clip Repair DRT')
    && !blocker.includes('config/default.drt')
    && !blocker.includes('resolveColorPythonPath')
    && !blocker.includes('resolveColorScriptApiRoot')
    && !blocker.includes('config/runtime.json')
  ));
}

interface IColorRawInventoryItem {
  rawRelativePath: string;
  sourceAbsolutePath: string;
}

interface IColorPrepareChunkPlan extends IColorPrepareChunk {
  items: IColorRawInventoryItem[];
}

interface IColorCastPreviewContext {
  workspaceRoot: string;
  rootColorSpaceProfile?: IColorRootContext['rootSummary']['colorSpaceProfile'];
  rootTransformPresetKey?: IColorRootContext['rootSummary']['transformPresetKey'];
  transformPresetsConfig: Awaited<ReturnType<typeof loadColorTransformPresetsConfig>>;
}

async function scanColorRawInventory(rawLocalPath: string): Promise<IColorRawInventoryItem[]> {
  const scanned = await scanDirectory(rawLocalPath);
  return scanned
    .filter(file => file.kind === 'video')
    .map(file => ({
      rawRelativePath: normalizePortablePath(toPortableRelativePath(rawLocalPath, file.path)),
      sourceAbsolutePath: resolve(file.path),
    }))
    .sort((left, right) => left.rawRelativePath.localeCompare(right.rawRelativePath, 'zh-Hans-CN'));
}

async function buildColorOverwritePreviewForContext(
  context: IColorRootContext,
  requestedClipKeys: string[],
): Promise<IColorOverwritePreview> {
  const outputRoot = resolve(context.rootSummary.localPath ?? '');
  const rawRoot = resolve(context.rootSummary.rawLocalPath ?? '');
  const rawInventory = await scanColorRawInventory(rawRoot);
  const inventoryByKey = new Map(rawInventory.map(entry => [entry.rawRelativePath, entry]));
  const effectiveClipKeys = dedupeStrings(requestedClipKeys.map(clipKey => normalizePortablePath(String(clipKey ?? ''))));
  const selectedKeys = effectiveClipKeys.length > 0
    ? effectiveClipKeys
    : resolveSyncedColorRootClipKeys(context);
  if (selectedKeys.length === 0) {
    throw new ProjectColorBlockedError([
      'execute_root 默认导出范围来自最近一次 sync_groups 的 Resolve 时间线 clip 集合；当前没有可用 sync_groups 结果，请先执行 sync_groups，或显式传入 clipKeys。',
    ]);
  }
  const missingClipKeys = selectedKeys.filter(clipKey => !inventoryByKey.has(clipKey));
  if (missingClipKeys.length > 0) {
    throw new ProjectColorBlockedError(missingClipKeys.map(clipKey => `overwrite preview clip 不存在于 rawLocalPath: ${clipKey}`));
  }
  const extension = resolveColorRenderExtension(context.rootSummary.renderPreset);
  const targets = await Promise.all(selectedKeys.map(async rawRelativePath => {
    const sourceStem = deriveSourceStem(rawRelativePath);
    const outputPath = resolve(join(
      outputRoot,
      ...portableParentDir(rawRelativePath).split('/').filter(Boolean),
      `${sourceStem}.${extension}`,
    ));
    const outputStats = await stat(outputPath).catch(() => null);
    return {
      rawRelativePath,
      sourceStem,
      outputPath,
      exists: Boolean(outputStats?.isFile()),
      sizeBytes: outputStats?.isFile() ? outputStats.size : undefined,
      modifiedAt: outputStats?.isFile() ? outputStats.mtime.toISOString() : undefined,
    };
  }));
  const duplicateStemGroups = buildDuplicateStemGroups(targets.map(target => ({
    rawRelativePath: target.rawRelativePath,
    sourceStem: target.sourceStem,
  })));
  const byDirectory = mergeColorOverwriteDirectories(targets.map(target => ({
    directory: portableParentDir(target.rawRelativePath),
    clipCount: 1,
    existingCount: target.exists ? 1 : 0,
  })));
  const overwritePlanHash = hashColorOverwritePayload({
    mode: 'execute_root',
    projectId: context.projectId,
    rootId: context.rootId,
    outputRoot,
    rawRoot,
    targets: targets.map(target => ({
      rawRelativePath: target.rawRelativePath,
      sourceStem: target.sourceStem,
      outputPath: target.outputPath,
      exists: target.exists,
      sizeBytes: target.sizeBytes,
      modifiedAt: target.modifiedAt,
    })),
  });
  return {
    projectId: context.projectId,
    rootId: context.rootId,
    mode: 'execute_root',
    outputRoot,
    rawRoot,
    clipCount: targets.length,
    existingCount: targets.filter(target => target.exists).length,
    targets,
    byDirectory,
    duplicateStemGroups,
    overwritePlanHash,
    rootHashes: {
      [context.rootId]: overwritePlanHash,
    },
    roots: [],
  };
}

function resolveSyncedColorRootClipKeys(context: IColorRootContext): string[] {
  return dedupeStrings([
    ...(context.groupsSnapshot?.groups ?? []).flatMap(group => group.clipKeys ?? []),
    ...(context.rootSummary.groups ?? []).flatMap(group => group.clipKeys ?? []),
  ]
    .map(clipKey => normalizePortablePath(String(clipKey ?? '')))
    .filter(clipKey => clipKey.length > 0));
}

function buildDuplicateStemGroups(items: Array<{ rawRelativePath: string; sourceStem: string }>): IColorOverwritePreview['duplicateStemGroups'] {
  const byStem = new Map<string, Array<{ rawRelativePath: string; sourceStem: string }>>();
  for (const item of items) {
    const relativeDir = portableParentDir(item.rawRelativePath);
    const key = `${relativeDir}\0${item.sourceStem.trim().toLowerCase()}`;
    const existing = byStem.get(key);
    if (existing) {
      existing.push(item);
    } else {
      byStem.set(key, [item]);
    }
  }
  return [...byStem.values()]
    .filter(group => group.length > 1)
    .map(group => ({
      sourceStem: group[0]?.sourceStem ?? '',
      rawRelativePaths: group.map(item => item.rawRelativePath).sort((left, right) => left.localeCompare(right, 'zh-Hans-CN')),
    }))
    .sort((left, right) => left.sourceStem.localeCompare(right.sourceStem, 'zh-Hans-CN'));
}

function mergeColorOverwriteDirectories(
  directories: IColorOverwritePreview['byDirectory'],
): IColorOverwritePreview['byDirectory'] {
  const byDirectory = new Map<string, { directory: string; clipCount: number; existingCount: number }>();
  for (const item of directories) {
    const key = item.directory || '';
    const existing = byDirectory.get(key);
    if (existing) {
      existing.clipCount += item.clipCount;
      existing.existingCount += item.existingCount;
    } else {
      byDirectory.set(key, {
        directory: key,
        clipCount: item.clipCount,
        existingCount: item.existingCount,
      });
    }
  }
  return [...byDirectory.values()].sort((left, right) => left.directory.localeCompare(right.directory, 'zh-Hans-CN'));
}

function hashColorOverwritePayload(payload: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(payload))
    .digest('hex');
}

function validateColorOverwriteConfirmation(
  preview: IColorOverwritePreview,
  input: IProjectColorActionInput,
): string[] {
  if (preview.existingCount <= 0) return [];
  if (input.overwriteConfirmed !== true) {
    return [
      `execute_root 将覆盖 ${preview.existingCount} 个已有输出，请先在 /color 覆盖确认窗确认。`,
      `overwritePlanHash: ${preview.overwritePlanHash}`,
    ];
  }
  if (!input.overwritePlanHash || input.overwritePlanHash !== preview.overwritePlanHash) {
    return [
      '覆盖确认已过期：目标文件状态或覆盖范围已变化，请重新打开覆盖确认窗。',
      `expected overwritePlanHash: ${preview.overwritePlanHash}`,
      input.overwritePlanHash ? `received overwritePlanHash: ${input.overwritePlanHash}` : 'received overwritePlanHash: (missing)',
    ];
  }
  return [];
}

function validateColorOverwritePlanSafety(preview: IColorOverwritePreview): string[] {
  if (!Array.isArray(preview.duplicateStemGroups) || preview.duplicateStemGroups.length === 0) {
    return [];
  }
  return [
    '同一 raw 父目录内存在重名 source stem；按 day 直接 Source Name 渲染会互相覆盖，已阻止启动 Resolve。',
    ...preview.duplicateStemGroups.slice(0, 20).map(group => (
      `${group.sourceStem}: ${group.rawRelativePaths.join(', ')}`
    )),
  ];
}

async function verifyRenderedEntriesAtFinalOutputs(
  entries: Awaited<ReturnType<IColorExecutor['executeRoot']>>['entries'],
  previewTargetByKey: Map<string, IColorOverwritePreview['targets'][number]>,
): Promise<Array<Awaited<ReturnType<IColorExecutor['executeRoot']>>['entries'][number] & { outputPath: string }>> {
  const entriesByKey = new Map(entries.map(entry => [entry.rawRelativePath, entry]));
  const missing = [...previewTargetByKey.keys()].filter(clipKey => !entriesByKey.has(clipKey));
  const extra = entries.filter(entry => !previewTargetByKey.has(entry.rawRelativePath));
  const blockers = dedupeStrings([
    ...missing.map(clipKey => `rendered output missing for ${clipKey}`),
    ...extra.map(entry => `rendered unexpected output: ${entry.rawRelativePath}`),
  ]);
  const verified = await Promise.all(entries.map(async entry => {
    const target = previewTargetByKey.get(entry.rawRelativePath);
    if (!target) return null;
    const outputPath = resolve(entry.outputPath);
    const targetPath = resolve(target.outputPath);
    if (outputPath !== targetPath) {
      blockers.push(`rendered output path mismatch for ${entry.rawRelativePath}: expected ${targetPath}, got ${outputPath}`);
      return null;
    }
    const outputStats = await stat(outputPath).catch(() => null);
    if (!outputStats?.isFile()) {
      blockers.push(`rendered output file missing: ${outputPath}`);
      return null;
    }
    return {
      ...entry,
      outputPath,
    };
  }));
  if (blockers.length > 0) {
    throw new Error(dedupeStrings(blockers).join('；'));
  }
  const finalEntries = [];
  for (const entry of verified) {
    if (!entry) continue;
    finalEntries.push(entry);
  }
  return finalEntries;
}

function normalizeColorBatchRenderJobs(jobs: NonNullable<Awaited<ReturnType<IColorExecutor['executeRoot']>>['renderJobs']>): IColorBatchRenderJob[] {
  return jobs.map(job => ({
    jobId: job.jobId,
    timelineName: job.timelineName,
    targetDir: job.targetDir,
    clipCount: job.clipCount ?? 0,
    duplicateStemGroup: job.duplicateStemGroup,
  }));
}

function resolveColorRenderExtension(renderPreset: IColorRootContext['rootSummary']['renderPreset']): string {
  const container = String(renderPreset.container || 'mp4').trim().toLowerCase();
  return container === 'mov' ? 'mov' : 'mp4';
}

function portableParentDir(rawRelativePath: string): string {
  const normalized = normalizePortablePath(rawRelativePath);
  const parent = posix.dirname(normalized);
  return parent === '.' ? '' : parent;
}

async function buildColorExecutorClips(
  rawLocalPath: string,
  runtimeConfig: Awaited<ReturnType<typeof loadRuntimeConfig>>,
  previewContext?: IColorCastPreviewContext,
): Promise<IColorExecutorClipInput[]> {
  const inventory = await scanColorRawInventory(rawLocalPath);
  return buildColorExecutorClipsForInventory(inventory, runtimeConfig, previewContext);
}

async function buildColorExecutorClipsForInventory(
  inventory: IColorRawInventoryItem[],
  runtimeConfig: Awaited<ReturnType<typeof loadRuntimeConfig>>,
  previewContext?: IColorCastPreviewContext,
): Promise<IColorExecutorClipInput[]> {
  const clips = await mapWithConcurrency(
    inventory,
    CCOLOR_PREPARE_PROBE_CONCURRENCY,
    async item => {
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
        classifyMidpointLowlight(item.sourceAbsolutePath, runtimeConfig, {
          durationMs: probed?.durationMs,
        }).catch(() => ({
          lowlight: false,
          metrics: undefined,
        })),
      ]);
      const profileResolution = resolveEffectiveColorProfile(
        sourceTruth.logProfile,
        previewContext?.rootColorSpaceProfile,
      );
      const colorCastPreview = await resolveColorCastPreviewLut(previewContext, {
        rawRelativePath: item.rawRelativePath,
        detectedProfile: profileResolution.detectedProfile,
        effectiveProfile: profileResolution.effectiveProfile,
        profileSource: profileResolution.profileSource,
        logProfile: profileResolution.logProfile,
        deviceFamilyKeys: sourceTruth.deviceFamilyKeys,
      });
      const colorCastClassification = colorCastPreview.status === 'missing-technical-lut'
        ? {
          colorCastClass: 'unknown' as const,
          colorCastConfidence: 0,
          colorCastMetrics: {
            technicalTransformStatus: colorCastPreview.status,
            technicalLutRelativePath: colorCastPreview.relativeLutPath,
          },
        }
        : await classifyColorCast(item.sourceAbsolutePath, runtimeConfig, {
          durationMs: probed?.durationMs,
          lutPath: colorCastPreview.lutPath,
        }).catch(() => ({
          colorCastClass: 'unknown' as const,
          colorCastConfidence: 0,
          colorCastMetrics: {
            technicalTransformStatus: colorCastPreview.status,
            technicalLutRelativePath: colorCastPreview.relativeLutPath,
          },
        }));
      const exposureSceneClassification = shouldClassifyExposureScene(colorCastPreview, profileResolution)
        ? await classifyExposureScene(item.sourceAbsolutePath, runtimeConfig, {
          durationMs: probed?.durationMs,
          lutPath: colorCastPreview.lutPath,
        }).catch(() => buildUnknownExposureSceneClassification({
          technicalTransformStatus: colorCastPreview.status,
          technicalLutRelativePath: colorCastPreview.relativeLutPath,
        }))
        : buildUnknownExposureSceneClassification({
          technicalTransformStatus: colorCastPreview.status,
          technicalLutRelativePath: colorCastPreview.relativeLutPath,
          exposureSceneSkippedReason: resolveExposureSceneSkippedReason(colorCastPreview, profileResolution),
        });
      const windshieldHazeClassification = shouldClassifyExposureScene(colorCastPreview, profileResolution)
        ? await classifyWindshieldHaze(item.sourceAbsolutePath, runtimeConfig, {
          durationMs: probed?.durationMs,
          lutPath: colorCastPreview.lutPath,
        }).catch(() => buildUnknownWindshieldHazeClassification({
          technicalTransformStatus: colorCastPreview.status,
          technicalLutRelativePath: colorCastPreview.relativeLutPath,
        }))
        : buildUnknownWindshieldHazeClassification({
          technicalTransformStatus: colorCastPreview.status,
          technicalLutRelativePath: colorCastPreview.relativeLutPath,
          windshieldHazeSkippedReason: resolveExposureSceneSkippedReason(colorCastPreview, profileResolution),
        });
      const orientation = resolveColorClipOrientation(probed);
      return {
        rawRelativePath: item.rawRelativePath,
        sourceAbsolutePath: item.sourceAbsolutePath,
        sourceStem: deriveSourceStem(item.rawRelativePath),
        capturedAt: captureTime?.capturedAt,
        width: probed?.width ?? undefined,
        height: probed?.height ?? undefined,
        encodedWidth: probed?.width ?? undefined,
        encodedHeight: probed?.height ?? undefined,
        displayWidth: probed?.displayWidth ?? probed?.width ?? undefined,
        displayHeight: probed?.displayHeight ?? probed?.height ?? undefined,
        rotationDegrees: probed?.rotationDegrees ?? undefined,
        orientationStatus: orientation.orientationStatus,
        repairTemplateKey: orientation.repairTemplateKey,
        fps: probed?.fps ?? undefined,
        codec: probed?.codec ?? undefined,
        rawTags: probed?.rawTags ?? {},
        detectedProfile: profileResolution.detectedProfile,
        effectiveProfile: profileResolution.effectiveProfile,
        profileSource: profileResolution.profileSource,
        logProfile: profileResolution.logProfile,
        gyroDataAvailable: sourceTruth.gyro === true,
        gyroEligible: sourceTruth.gyro,
        lowlight: lowlightClassification.lowlight,
        colorCastClass: colorCastClassification.colorCastClass,
        colorCastConfidence: colorCastClassification.colorCastConfidence,
        colorCastMetrics: {
          ...colorCastClassification.colorCastMetrics,
          technicalTransformStatus: colorCastPreview.status,
          technicalLutRelativePath: colorCastPreview.relativeLutPath,
        },
        exposureSceneClass: exposureSceneClassification.exposureSceneClass,
        exposureSceneConfidence: exposureSceneClassification.exposureSceneConfidence,
        exposureSceneMetrics: {
          ...exposureSceneClassification.exposureSceneMetrics,
          technicalTransformStatus: colorCastPreview.status,
          technicalLutRelativePath: colorCastPreview.relativeLutPath,
        },
        windshieldHaze: windshieldHazeClassification.windshieldHaze,
        windshieldHazeConfidence: windshieldHazeClassification.windshieldHazeConfidence,
        windshieldHazeMetrics: {
          ...windshieldHazeClassification.windshieldHazeMetrics,
          technicalTransformStatus: colorCastPreview.status,
          technicalLutRelativePath: colorCastPreview.relativeLutPath,
        },
        deviceFamilyKeys: sourceTruth.deviceFamilyKeys,
      } satisfies IColorExecutorClipInput;
    },
  );
  return smoothContinuousColorCastClips(clips);
}

function smoothContinuousColorCastClips(
  clips: IColorExecutorClipInput[],
): IColorExecutorClipInput[] {
  const sorted = [...clips].sort((left, right) => (
    left.rawRelativePath.localeCompare(right.rawRelativePath, 'zh-Hans-CN')
  ));
  const byKey = new Map(clips.map(clip => [clip.rawRelativePath, clip]));
  for (const sequence of buildNumericClipSequences(sorted)) {
    const runs = buildColorCastAnchorRuns(sequence);
    for (const run of runs) {
      if (run.anchorIndexes.length < 2) continue;
      const target = resolveColorCastContinuityTarget(run.anchorClasses);
      if (!target) continue;
      const firstAnchor = run.anchorIndexes[0] ?? run.start;
      const lastAnchor = run.anchorIndexes[run.anchorIndexes.length - 1] ?? run.end;
      const start = firstAnchor;
      let end = lastAnchor;
      while (
        end < sequence.length - 1
        && end - lastAnchor < CCOLOR_CAST_CONTINUITY_MAX_FORWARD_EXTENSION
        && canPromoteByColorCastContinuity(sequence[end + 1], target)
      ) {
        end += 1;
      }
      for (let index = start; index <= end; index += 1) {
        const clip = sequence[index];
        if (!clip || !canPromoteByColorCastContinuity(clip, target)) continue;
        byKey.set(clip.rawRelativePath, promoteClipToContinuityColorCast(clip, target, run.anchorClipKeys));
      }
    }
  }
  return clips.map(clip => byKey.get(clip.rawRelativePath) ?? clip);
}

function buildNumericClipSequences(
  clips: IColorExecutorClipInput[],
): IColorExecutorClipInput[][] {
  const sequences: IColorExecutorClipInput[][] = [];
  let current: IColorExecutorClipInput[] = [];
  let previous: ReturnType<typeof parseNumericClipKey> | null = null;
  let previousLogProfile = '';
  for (const clip of clips) {
    const parsed = parseNumericClipKey(clip.rawRelativePath);
    const logProfile = normalizeClipSequenceLogProfile(clip);
    if (
      !parsed
      || !previous
      || parsed.parent !== previous.parent
      || parsed.prefix !== previous.prefix
      || logProfile !== previousLogProfile
      || parsed.number < previous.number
      || parsed.number - previous.number > 3
    ) {
      if (current.length > 0) sequences.push(current);
      current = [clip];
    } else {
      current.push(clip);
    }
    previous = parsed;
    previousLogProfile = parsed ? logProfile : '';
  }
  if (current.length > 0) sequences.push(current);
  return sequences;
}

function normalizeClipSequenceLogProfile(clip: IColorExecutorClipInput): string {
  return String(clip.logProfile ?? '').trim().toLowerCase();
}

function parseNumericClipKey(rawRelativePath: string): {
  parent: string;
  prefix: string;
  number: number;
} | null {
  const normalized = normalizePortablePath(rawRelativePath);
  const slashIndex = normalized.lastIndexOf('/');
  const parent = slashIndex >= 0 ? normalized.slice(0, slashIndex) : '';
  const filename = slashIndex >= 0 ? normalized.slice(slashIndex + 1) : normalized;
  const stem = filename.replace(/\.[^.]+$/, '');
  const match = /^([A-Za-z_-]*?)(\d+)$/.exec(stem);
  if (!match) return null;
  return {
    parent,
    prefix: match[1] ?? '',
    number: Number(match[2]),
  };
}

function buildColorCastAnchorRuns(sequence: IColorExecutorClipInput[]): Array<{
  start: number;
  end: number;
  anchorIndexes: number[];
  anchorClipKeys: string[];
  anchorClasses: TColorCastContinuityTarget[];
}> {
  const runs: Array<{
    start: number;
    end: number;
    anchorIndexes: number[];
    anchorClipKeys: string[];
    anchorClasses: TColorCastContinuityTarget[];
  }> = [];
  let current: {
    start: number;
    end: number;
    anchorIndexes: number[];
    anchorClipKeys: string[];
    anchorClasses: TColorCastContinuityTarget[];
  } | null = null;
  for (let index = 0; index < sequence.length; index += 1) {
    const clip = sequence[index];
    const anchorClass = getColorCastContinuityAnchorClass(clip);
    if (!clip || !anchorClass) continue;
    if (!current || index - current.end > CCOLOR_CAST_CONTINUITY_MAX_ANCHOR_GAP) {
      if (current) runs.push(current);
      current = {
        start: index,
        end: index,
        anchorIndexes: [index],
        anchorClipKeys: [clip.rawRelativePath],
        anchorClasses: [anchorClass],
      };
    } else {
      current.end = index;
      current.anchorIndexes.push(index);
      current.anchorClipKeys.push(clip.rawRelativePath);
      current.anchorClasses.push(anchorClass);
    }
  }
  if (current) runs.push(current);
  return runs;
}

function getColorCastContinuityAnchorClass(
  clip: IColorExecutorClipInput | undefined,
): TColorCastContinuityTarget | null {
  if (
    !clip
    || clip.lowlight === true
    || clip.windshieldHaze === true
    || hasWhiteReferenceUnderexposedExposureScene(clip)
    || (clip.colorCastConfidence ?? 0) < 0.65
  ) return null;
  if (clip.colorCastClass === 'cool-cyan' || clip.colorCastClass === 'green' || clip.colorCastClass === 'green-cyan') {
    return clip.colorCastClass;
  }
  return null;
}

function resolveColorCastContinuityTarget(
  anchorClasses: TColorCastContinuityTarget[],
): TColorCastContinuityTarget | null {
  const classSet = new Set(anchorClasses);
  if (classSet.has('green-cyan') || (classSet.has('green') && classSet.has('cool-cyan'))) {
    return 'green-cyan';
  }
  if (classSet.has('cool-cyan')) return 'cool-cyan';
  if (classSet.has('green')) return 'green';
  return null;
}

function canPromoteByColorCastContinuity(
  clip: IColorExecutorClipInput | undefined,
  target: TColorCastContinuityTarget,
): clip is IColorExecutorClipInput {
  if (!clip || clip.lowlight === true || clip.windshieldHaze === true || hasWhiteReferenceUnderexposedExposureScene(clip)) return false;
  if (clip.colorCastClass === 'warm' && (clip.colorCastConfidence ?? 0) >= 0.55) return false;
  const medianA = readColorCastMetricNumber(clip, 'medianA');
  const medianB = readColorCastMetricNumber(clip, 'medianB');
  const candidatePixelRatio = readColorCastMetricNumber(clip, 'candidatePixelRatio');
  if (medianA == null || medianB == null || candidatePixelRatio == null) return false;
  if (candidatePixelRatio < CCOLOR_CAST_CONTINUITY_MIN_CANDIDATE_RATIO) return false;
  if (target === 'cool-cyan') {
    return medianA <= 1.5 && medianB <= 1.2;
  }
  if (target === 'green') {
    return medianA <= -2.5 && medianB > -2.0 && medianB < 8;
  }
  return medianA <= -2.5 && medianB >= -6.5 && medianB <= 5.5;
}

function hasWhiteReferenceUnderexposedExposureScene(
  clip: IColorExecutorClipInput | undefined,
): boolean {
  if (!clip || clip.exposureSceneClass !== 'underexposed') return false;
  const metrics = clip.exposureSceneMetrics;
  const reasons = Array.isArray(metrics?.exposureSceneReasons) ? metrics.exposureSceneReasons : [];
  if (reasons.some(isWhiteReferenceUnderexposedReason)) return true;
  const frames = Array.isArray(metrics?.frames) ? metrics.frames : [];
  return frames.some(frame => (
    isUnknownRecord(frame) && isWhiteReferenceUnderexposedReason(frame.exposureSceneReason)
  ));
}

function isWhiteReferenceUnderexposedReason(value: unknown): boolean {
  return typeof value === 'string' && value.trim() === 'white-reference-underexposed';
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function promoteClipToContinuityColorCast(
  clip: IColorExecutorClipInput,
  target: TColorCastContinuityTarget,
  anchorClipKeys: string[],
): IColorExecutorClipInput {
  if (clip.colorCastClass === target && (clip.colorCastConfidence ?? 0) >= 0.65) {
    return clip;
  }
  return {
    ...clip,
    colorCastClass: target,
    colorCastConfidence: Math.max(clip.colorCastConfidence ?? 0, 0.66),
    colorCastMetrics: {
      ...(clip.colorCastMetrics ?? {}),
      continuityAdjustedFromClass: clip.colorCastClass,
      continuityAdjustedFromConfidence: clip.colorCastConfidence,
      continuityAdjustment: `${target}-sequence`,
      continuityAnchorClipKeys: anchorClipKeys,
    },
  };
}

function readColorCastMetricNumber(
  clip: IColorExecutorClipInput,
  key: string,
): number | null {
  const value = clip.colorCastMetrics?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

async function resolveColorCastPreviewLut(
  previewContext: IColorCastPreviewContext | undefined,
  clip: {
    rawRelativePath: string;
    detectedProfile?: IColorExecutorClipInput['detectedProfile'];
    effectiveProfile?: IColorExecutorClipInput['effectiveProfile'];
    profileSource: NonNullable<IColorExecutorClipInput['profileSource']>;
    logProfile?: IColorExecutorClipInput['logProfile'];
    deviceFamilyKeys?: string[];
  },
): Promise<{
  status: 'source-rgb' | 'technical-lut' | 'missing-technical-lut';
  lutPath?: string;
  relativeLutPath?: string;
}> {
  if (!previewContext) {
    return { status: 'source-rgb' };
  }
  const workspaceLutRoot = resolve(join(previewContext.workspaceRoot, 'config', 'luts'));
  const resolved = resolveClipTransformSeeds(
    [clip],
    previewContext.transformPresetsConfig,
    previewContext.rootTransformPresetKey,
    workspaceLutRoot,
  );
  const relativeLutPath = resolved.clips[0]?.resolvedLutRelativePath;
  if (!relativeLutPath || resolved.blockers.length > 0) {
    return { status: 'source-rgb' };
  }

  const workspaceLutPath = resolve(join(workspaceLutRoot, relativeLutPath));
  if (await isReadableFile(workspaceLutPath)) {
    return {
      status: 'technical-lut',
      lutPath: workspaceLutPath,
      relativeLutPath,
    };
  }

  const resolveLutPath = resolve(join(detectResolveDefaultLutRoot(), relativeLutPath));
  if (await isReadableFile(resolveLutPath)) {
    return {
      status: 'technical-lut',
      lutPath: resolveLutPath,
      relativeLutPath,
    };
  }

  return {
    status: 'missing-technical-lut',
    relativeLutPath,
  };
}

function shouldClassifyExposureScene(
  preview: {
    status: 'source-rgb' | 'technical-lut' | 'missing-technical-lut';
  },
  profile: ReturnType<typeof resolveEffectiveColorProfile>,
): boolean {
  if (preview.status === 'technical-lut') return true;
  if (preview.status === 'missing-technical-lut') return false;
  return normalizeExposureProfile(profile.effectiveProfile) === 'rec709';
}

function resolveExposureSceneSkippedReason(
  preview: {
    status: 'source-rgb' | 'technical-lut' | 'missing-technical-lut';
  },
  profile: ReturnType<typeof resolveEffectiveColorProfile>,
): string | undefined {
  if (preview.status === 'missing-technical-lut') return 'missing-technical-lut';
  if (preview.status === 'source-rgb' && normalizeExposureProfile(profile.effectiveProfile) !== 'rec709') {
    return profile.effectiveProfile ? 'requires-technical-transform' : 'unknown-input-profile';
  }
  return undefined;
}

function normalizeExposureProfile(value: unknown): string {
  return String(value ?? '').trim().toLowerCase();
}

function buildUnknownExposureSceneClassification(extraMetrics: Record<string, unknown> = {}): {
  exposureSceneClass: 'unknown';
  exposureSceneConfidence: number;
  exposureSceneMetrics: Record<string, unknown>;
} {
  return {
    exposureSceneClass: 'unknown',
    exposureSceneConfidence: 0,
    exposureSceneMetrics: {
      frameCount: 0,
      classifiedFrameCount: 0,
      ...extraMetrics,
    },
  };
}

function buildUnknownWindshieldHazeClassification(extraMetrics: Record<string, unknown> = {}): {
  windshieldHaze: false;
  windshieldHazeConfidence: number;
  windshieldHazeMetrics: Record<string, unknown>;
} {
  return {
    windshieldHaze: false,
    windshieldHazeConfidence: 0,
    windshieldHazeMetrics: {
      frameCount: 0,
      classifiedFrameCount: 0,
      positiveFrameCount: 0,
      positiveFrameRatio: 0,
      ...extraMetrics,
    },
  };
}

async function isReadableFile(filePath: string): Promise<boolean> {
  return stat(filePath)
    .then(fileStat => fileStat.isFile())
    .catch(() => false);
}

function buildColorSyncExecutorClipsForInventory(
  inventory: IColorRawInventoryItem[],
  previousClipSnapshots: Map<string, IColorClipRepairSnapshot>,
): IColorExecutorClipInput[] {
  return inventory.map(item => {
    const previous = previousClipSnapshots.get(item.rawRelativePath);
    const repairTemplateKey = resolveColorRepairTemplateKeyFromSnapshot(previous);
    return {
      rawRelativePath: item.rawRelativePath,
      sourceAbsolutePath: item.sourceAbsolutePath,
      sourceStem: deriveSourceStem(item.rawRelativePath),
      encodedWidth: previous?.encodedWidth,
      encodedHeight: previous?.encodedHeight,
      displayWidth: previous?.displayWidth,
      displayHeight: previous?.displayHeight,
      rotationDegrees: previous?.rotationDegrees,
      orientationStatus: previous?.orientationStatus,
      repairTemplateKey,
      previousRepairTemplateHash: previous?.repairTemplateKey === repairTemplateKey
        ? previous?.repairTemplateHash
        : undefined,
      timelineTransform: previous?.timelineTransform,
      logProfile: previous?.logProfile as IColorExecutorClipInput['logProfile'],
      gyroDataAvailable: previous?.gyroDataAvailable,
      gyroEligible: previous?.gyroEligible,
      lowlight: previous?.lowlight,
      windshieldHaze: previous?.windshieldHaze,
      windshieldHazeConfidence: previous?.windshieldHazeConfidence,
      windshieldHazeMetrics: previous?.windshieldHazeMetrics,
      colorCastClass: previous?.colorCastClass,
      colorCastConfidence: previous?.colorCastConfidence,
      colorCastMetrics: previous?.colorCastMetrics,
      exposureSceneClass: previous?.exposureSceneClass,
      exposureSceneConfidence: previous?.exposureSceneConfidence,
      exposureSceneMetrics: previous?.exposureSceneMetrics,
    };
  });
}

function buildColorClipRepairSnapshotIndex(
  snapshot?: IColorGroupsSnapshotFile | null,
): Map<string, IColorClipRepairSnapshot> {
  const indexed = new Map<string, IColorClipRepairSnapshot>();
  for (const group of snapshot?.groups ?? []) {
    for (const clip of group.clips ?? []) {
      if (!clip.clipKey || indexed.has(clip.clipKey)) continue;
      indexed.set(clip.clipKey, clip);
    }
  }
  return indexed;
}

function applyPreviousColorRepairSnapshots(
  clips: IColorExecutorClipInput[],
  previousClipSnapshots: Map<string, IColorClipRepairSnapshot>,
): IColorExecutorClipInput[] {
  return clips.map(clip => {
    const previous = previousClipSnapshots.get(clip.rawRelativePath);
    if (!previous?.repairTemplateHash || previous.repairTemplateKey !== clip.repairTemplateKey) return clip;
    return {
      ...clip,
      previousRepairTemplateHash: previous.repairTemplateHash,
    };
  });
}

function applyCurrentColorRepairTemplateHashes(
  clips: IColorExecutorClipInput[],
  repairTemplateHashes: Record<string, string | undefined>,
): IColorExecutorClipInput[] {
  return clips.map(clip => {
    const currentHash = repairTemplateHashes[clip.repairTemplateKey ?? CCOLOR_REPAIR_TEMPLATE_DEFAULT_KEY];
    if (!currentHash) return clip;
    return {
      ...clip,
      previousRepairTemplateHash: currentHash,
    };
  });
}

function resolveColorRepairTemplateKeyFromSnapshot(
  previous?: IColorClipRepairSnapshot,
): string | undefined {
  if (!previous) return undefined;
  if (previous.orientationStatus !== 'portrait') return previous.repairTemplateKey;
  return resolveColorClipOrientation({
    rotationDegrees: previous.rotationDegrees,
    displayWidth: previous.displayWidth,
    displayHeight: previous.displayHeight,
    width: previous.encodedWidth,
    height: previous.encodedHeight,
  } as Awaited<ReturnType<typeof probe>>).repairTemplateKey;
}

function resolveColorClipOrientation(
  probed: Awaited<ReturnType<typeof probe>> | null,
): {
  orientationStatus: IColorExecutorClipInput['orientationStatus'];
  repairTemplateKey: string;
} {
  const rotation = normalizeColorRotationDegrees(probed?.rotationDegrees ?? undefined);
  const displayWidth = finitePositiveNumber(probed?.displayWidth) ?? finitePositiveNumber(probed?.width);
  const displayHeight = finitePositiveNumber(probed?.displayHeight) ?? finitePositiveNumber(probed?.height);
  const rotatedPortrait = rotation === 90 || rotation === -90;
  const displayPortrait = displayWidth != null && displayHeight != null && displayHeight > displayWidth;
  const orientationStatus: IColorExecutorClipInput['orientationStatus'] = rotatedPortrait || displayPortrait
    ? 'portrait'
    : displayWidth != null && displayHeight != null
      ? 'horizontal'
      : 'unknown';
  return {
    orientationStatus,
    repairTemplateKey: orientationStatus === 'portrait'
      ? resolveColorPortraitRepairTemplateKey(rotation)
      : CCOLOR_REPAIR_TEMPLATE_DEFAULT_KEY,
  };
}

function resolveColorPortraitRepairTemplateKey(
  ffprobeRotationDegrees: number | undefined,
): string {
  if (ffprobeRotationDegrees === -90) return CCOLOR_REPAIR_TEMPLATE_PORTRAIT_90_KEY;
  return CCOLOR_REPAIR_TEMPLATE_PORTRAIT_NEGATIVE_90_KEY;
}

function applyColorTimelineTransforms(
  clips: IColorExecutorClipInput[],
  timelineSpec: { width: number; height: number; fps: number } | undefined,
): IColorExecutorClipInput[] {
  return clips.map(clip => ({
    ...clip,
    timelineTransform: resolveColorTimelineTransform(clip, timelineSpec),
  }));
}

function resolveColorTimelineTransform(
  clip: IColorExecutorClipInput,
  timelineSpec: { width: number; height: number; fps: number } | undefined,
): IColorExecutorClipInput['timelineTransform'] {
  if (clip.orientationStatus !== 'portrait') return undefined;
  const timelineWidth = finitePositiveNumber(timelineSpec?.width);
  const timelineHeight = finitePositiveNumber(timelineSpec?.height);
  const displayWidth = finitePositiveNumber(clip.displayWidth) ?? finitePositiveNumber(clip.width);
  const displayHeight = finitePositiveNumber(clip.displayHeight) ?? finitePositiveNumber(clip.height);
  if (timelineWidth == null || timelineHeight == null || displayWidth == null || displayHeight == null) {
    return undefined;
  }
  const rotation = normalizeColorRotationDegrees(clip.rotationDegrees);
  const rotationAngle = rotation === 90
    ? -90
    : rotation === -90
      ? 90
      : 90;
  const fillDimensions = resolveColorPortraitFillDimensions(clip, {
    timelineWidth,
    timelineHeight,
    displayWidth,
    displayHeight,
    rotation,
  });
  const fillScale = roundColorTransformNumber(Math.max(
    timelineWidth / fillDimensions.width,
    timelineHeight / fillDimensions.height,
  ));
  return {
    rotationAngle,
    zoomGang: true,
    zoomX: fillScale,
    zoomY: fillScale,
    pan: 0,
    tilt: 0,
  };
}

function resolveColorPortraitFillDimensions(
  clip: IColorExecutorClipInput,
  input: {
    timelineWidth: number;
    timelineHeight: number;
    displayWidth: number;
    displayHeight: number;
    rotation: number | undefined;
  },
): { width: number; height: number } {
  const encodedWidth = finitePositiveNumber(clip.encodedWidth) ?? finitePositiveNumber(clip.width);
  const encodedHeight = finitePositiveNumber(clip.encodedHeight) ?? finitePositiveNumber(clip.height);
  const isDisplayMatrixPortrait = (
    (input.rotation === 90 || input.rotation === -90)
    && encodedWidth != null
    && encodedHeight != null
    && encodedWidth > encodedHeight
    && input.displayHeight > input.displayWidth
  );
  if (isDisplayMatrixPortrait) {
    const shortEdge = Math.min(encodedWidth, encodedHeight);
    const timelineAspect = input.timelineWidth / input.timelineHeight;
    return {
      width: shortEdge,
      height: shortEdge / timelineAspect,
    };
  }
  return {
    width: Math.max(input.displayWidth, input.displayHeight),
    height: Math.min(input.displayWidth, input.displayHeight),
  };
}

function buildColorRepairTemplates(workspaceRoot: string): Record<string, string> {
  return {
    [CCOLOR_REPAIR_TEMPLATE_DEFAULT_KEY]: join(workspaceRoot, 'config', 'default.drt'),
    [CCOLOR_REPAIR_TEMPLATE_PORTRAIT_90_KEY]: join(workspaceRoot, 'config', 'gyroflow-portrait-90.drt'),
    [CCOLOR_REPAIR_TEMPLATE_PORTRAIT_NEGATIVE_90_KEY]: join(workspaceRoot, 'config', 'gyroflow-portrait--90.drt'),
  };
}

async function buildColorRepairTemplateHashes(workspaceRoot: string): Promise<Record<string, string | undefined>> {
  const templates = buildColorRepairTemplates(workspaceRoot);
  const entries = await Promise.all(Object.entries(templates).map(async ([key, path]) => {
    const buffer = await readFile(path).catch(() => null);
    return [key, buffer ? createHash('sha256').update(buffer).digest('hex') : undefined] as const;
  }));
  return Object.fromEntries(entries);
}

function buildMissingDefaultRepairTemplateBlockers(input: {
  workspaceRoot: string;
  rawInventory: IColorRawInventoryItem[];
  previousClipSnapshots: Map<string, IColorClipRepairSnapshot>;
  repairTemplateHashes: Record<string, string | undefined>;
}): string[] {
  if (input.repairTemplateHashes[CCOLOR_REPAIR_TEMPLATE_DEFAULT_KEY]) return [];
  const defaultOrUnknownClipCount = input.rawInventory.filter(item => {
    const previousTemplateKey = resolveColorRepairTemplateKeyFromSnapshot(
      input.previousClipSnapshots.get(item.rawRelativePath),
    );
    return !previousTemplateKey || previousTemplateKey === CCOLOR_REPAIR_TEMPLATE_DEFAULT_KEY;
  }).length;
  if (defaultOrUnknownClipCount === 0) return [];
  const defaultTemplatePath = buildColorRepairTemplates(input.workspaceRoot)[CCOLOR_REPAIR_TEMPLATE_DEFAULT_KEY];
  const displayDefaultTemplatePath = defaultTemplatePath.replace(/\\/g, '/');
  return [
    `缺少默认 Clip Repair DRT：${displayDefaultTemplatePath}。当前 root 有 ${defaultOrUnknownClipCount} 个默认或未知方向 clips 需要用它建立 Gyro -> Dehaze -> User1 -> User2 -> NR 五节点；prepare_root 已阻塞，避免写出缺 repair 节点的 ready 状态。请先导出正式五节点 DRT 到该路径后重跑 Prepare Root。`,
  ];
}

function refreshPrepareChunkForRepairTemplateDrift(
  chunk: IColorPrepareChunkPlan,
  previousClipSnapshots: Map<string, IColorClipRepairSnapshot>,
  repairTemplateHashes: Record<string, string | undefined>,
): IColorPrepareChunkPlan {
  if (chunk.status !== 'ready') return chunk;
  const stalePortraitClip = chunk.rawRelativePaths.some(clipKey => {
    const previous = previousClipSnapshots.get(clipKey);
    if (previous?.orientationStatus !== 'portrait') return false;
    const templateKey = resolveColorRepairTemplateKeyFromSnapshot(previous);
    if (
      templateKey !== CCOLOR_REPAIR_TEMPLATE_PORTRAIT_90_KEY
      && templateKey !== CCOLOR_REPAIR_TEMPLATE_PORTRAIT_NEGATIVE_90_KEY
    ) {
      return false;
    }
    const currentHash = repairTemplateHashes[templateKey];
    return Boolean(currentHash && previous.repairTemplateHash !== currentHash);
  });
  if (!stalePortraitClip) return chunk;
  return {
    ...chunk,
    status: 'pending',
    completedAt: undefined,
    detail: CCOLOR_REPAIR_TEMPLATE_DRIFT_DETAIL,
  };
}

function shouldResetColorPrepareTimeline(chunks: IColorPrepareChunkPlan[], chunk: IColorPrepareChunkPlan): boolean {
  if (chunk.detail === CCOLOR_REPAIR_TEMPLATE_DRIFT_DETAIL) return false;
  return !chunks.some(candidate => candidate.index < chunk.index && candidate.status === 'ready');
}

function buildColorPrepareChunks(
  inventory: IColorRawInventoryItem[],
  baseTimelineName: string,
  existingChunks: IColorPrepareChunk[],
): IColorPrepareChunkPlan[] {
  const chunks: IColorRawInventoryItem[][] = [];
  for (const [, items] of groupInventoryByTopDirectory(inventory)) {
    for (let index = 0; index < items.length; index += CCOLOR_PREPARE_CHUNK_SIZE) {
      chunks.push(items.slice(index, index + CCOLOR_PREPARE_CHUNK_SIZE));
    }
  }
  const total = Math.max(chunks.length, 1);
  const existingByFingerprint = new Map(
    existingChunks
      .filter(chunk => chunk.status === 'ready' && chunk.fingerprint && chunk.timelineName === baseTimelineName)
      .map(chunk => [chunk.fingerprint!, chunk]),
  );
  return chunks.map((items, index) => {
    const rawRelativePaths = items.map(item => item.rawRelativePath);
    const fingerprint = hashString(rawRelativePaths.join('\n'));
    const chunkId = `chunk-${String(index + 1).padStart(3, '0')}`;
    const previous = existingByFingerprint.get(fingerprint);
    return {
      chunkId,
      index,
      total,
      status: previous?.status === 'ready' ? 'ready' : 'pending',
      timelineName: baseTimelineName,
      clipCount: items.length,
      rawRelativePaths,
      fingerprint,
      completedAt: previous?.completedAt,
      detail: previous?.detail,
      items,
    };
  });
}

function assertClipKeysPreparedByReadyChunks(
  clipKeys: string[],
  prepareChunks: IColorPrepareChunk[],
  action: 'sync_groups' | 'execute_root',
): void {
  const readyChunks = prepareChunks.filter(chunk => chunk.status === 'ready');
  if (readyChunks.length === 0) {
    return;
  }
  const preparedClipKeys = new Set<string>();
  for (const chunk of readyChunks) {
    for (const clipKey of chunk.rawRelativePaths ?? []) {
      preparedClipKeys.add(clipKey);
    }
  }
  const missingPreparedClipKeys = dedupeStrings(clipKeys.filter(clipKey => !preparedClipKeys.has(clipKey)));
  if (missingPreparedClipKeys.length > 0) {
    throw new ProjectColorBlockedError([
      `${action} 有 ${missingPreparedClipKeys.length} 个 clips 尚未在 ready prepare chunk 中出现，请先重新 Prepare Root。`,
      ...missingPreparedClipKeys.slice(0, 10).map(clipKey => `missing prepared chunk: ${clipKey}`),
    ]);
  }
}

function groupInventoryByTopDirectory(inventory: IColorRawInventoryItem[]): Map<string, IColorRawInventoryItem[]> {
  const groups = new Map<string, IColorRawInventoryItem[]>();
  for (const item of inventory) {
    const [top] = item.rawRelativePath.split('/');
    const key = item.rawRelativePath.includes('/') ? top ?? '' : '';
    const existing = groups.get(key);
    if (existing) {
      existing.push(item);
    } else {
      groups.set(key, [item]);
    }
  }
  return new Map([...groups.entries()].sort(([left], [right]) => left.localeCompare(right, 'zh-Hans-CN')));
}

function materializePrepareChunkForCurrent(
  chunk: IColorPrepareChunkPlan,
  existingChunks: IColorPrepareChunk[],
): IColorPrepareChunk {
  const existing = chunk.status === 'ready'
    ? existingChunks.find(item => item.fingerprint === chunk.fingerprint && item.status === 'ready')
    : undefined;
  return {
    chunkId: chunk.chunkId,
    index: chunk.index,
    total: chunk.total,
    status: existing?.status ?? chunk.status,
    timelineName: chunk.timelineName,
    clipCount: chunk.clipCount,
    rawRelativePaths: chunk.rawRelativePaths,
    fingerprint: chunk.fingerprint,
    completedAt: existing?.completedAt ?? chunk.completedAt,
    detail: existing?.detail ?? chunk.detail,
  };
}

function updatePrepareChunkStatus(
  chunks: IColorPrepareChunk[],
  chunkId: string,
  patch: Partial<IColorPrepareChunk>,
): IColorPrepareChunk[] {
  return chunks.map(chunk => chunk.chunkId === chunkId ? { ...chunk, ...patch } : chunk);
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(values.length);
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(concurrency, values.length || 1));
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(values[index]!, index);
    }
  }));
  return results;
}

function hashString(value: string): string {
  return createHash('sha1').update(value).digest('hex');
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
    displayWidth: probed.displayWidth ?? probed.width ?? undefined,
    displayHeight: probed.displayHeight ?? probed.height ?? undefined,
    rotationDegrees: probed.rotationDegrees ?? undefined,
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

function finitePositiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

function normalizeColorRotationDegrees(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  let normalized = ((Math.round(value) % 360) + 360) % 360;
  if (normalized > 180) normalized -= 360;
  return Object.is(normalized, -0) ? 0 : normalized;
}

function roundColorTransformNumber(value: number): number {
  return Math.round(value * 10000) / 10000;
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
    await rename(tempPath, resolvedOutputPath);
    return resolvedOutputPath;
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw new Error(
      `无法归一 color 输出 metadata：${resolvedOutputPath} (${String(error instanceof Error ? error.message : error)})`,
    );
  }
}

async function cleanupColorMetadataTempFilesForManifest(
  manifest: Pick<IColorBatchManifest, 'entries'>,
): Promise<{ deletedCount: number; failedPaths: string[] }> {
  const outputDirs = Array.from(new Set(
    manifest.entries
      .map(entry => entry.outputPath?.trim() ? dirname(resolve(entry.outputPath)) : '')
      .filter(Boolean),
  ));
  let deletedCount = 0;
  const failedPaths: string[] = [];
  for (const outputDir of outputDirs) {
    const dirEntries = await readdir(outputDir, { withFileTypes: true }).catch(() => []);
    for (const dirEntry of dirEntries) {
      if (!dirEntry.isFile() || !isColorMetadataTempFilename(dirEntry.name)) continue;
      const tempPath = join(outputDir, dirEntry.name);
      try {
        await unlink(tempPath);
        deletedCount += 1;
      } catch {
        failedPaths.push(tempPath);
      }
    }
  }
  return {
    deletedCount,
    failedPaths,
  };
}

function appendColorMetadataTempCleanupWarnings(
  warnings: string[],
  cleanup: { deletedCount: number; failedPaths: string[] },
  label: string,
): void {
  if (cleanup.deletedCount > 0) {
    warnings.push(`cleaned ${cleanup.deletedCount} stale metadata temp files ${label}`);
  }
  if (cleanup.failedPaths.length > 0) {
    warnings.push(`failed to clean ${cleanup.failedPaths.length} metadata temp files ${label}`);
  }
}

function isColorMetadataTempFilename(filename: string): boolean {
  return filename.startsWith(CCOLOR_METADATA_TEMP_PREFIX)
    && /^\.kairos-meta-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]+$/iu.test(filename);
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
      await scheduler.wait(retryDelaysMs[attempt]!);
    }
  }
  throw lastError ?? new Error(`Unreachable color host retry state: ${label}`);
}

function isRetryableColorHostError(error: unknown): boolean {
  if (!(error instanceof ResolveColorHostError)) return false;
  return new Set([
    'resolve_app_unavailable',
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

function describeColorHostFailure(error: unknown): {
  blockers: string[];
  hostSummary: Record<string, unknown>;
} {
  const message = error instanceof Error ? error.message : String(error);
  if (!(error instanceof ResolveColorHostError)) {
    return {
      blockers: [message],
      hostSummary: {
        at: new Date().toISOString(),
        message,
      },
    };
  }

  const payload = isPlainObject(error.details) ? error.details : {};
  const hostDetails = isPlainObject(payload.details) ? payload.details : {};
  const outputFilename = readStringField(hostDetails, 'outputFilename');
  const firstOutputFilename = readStringField(hostDetails, 'firstOutputFilename');
  const expectedFilenames = readStringArrayField(hostDetails, 'expectedSourceNameFilenames');
  const expectedStems = readStringArrayField(hostDetails, 'expectedSourceNameStems');
  const expectedFilenameSamples = expectedFilenames.slice(0, 8);
  const expectedStemSamples = expectedStems.slice(0, 8);
  const diagnosticParts = [
    outputFilename ? `queue OutputFilename=${outputFilename}` : '',
    firstOutputFilename && firstOutputFilename !== outputFilename ? `first=${firstOutputFilename}` : '',
    expectedFilenameSamples.length > 0
      ? `expected=${expectedFilenameSamples.join(', ')}${expectedFilenames.length > expectedFilenameSamples.length ? ` (+${expectedFilenames.length - expectedFilenameSamples.length})` : ''}`
      : '',
    expectedFilenameSamples.length === 0 && expectedStemSamples.length > 0
      ? `expected stems=${expectedStemSamples.join(', ')}${expectedStems.length > expectedStemSamples.length ? ` (+${expectedStems.length - expectedStemSamples.length})` : ''}`
      : '',
  ].filter(Boolean);
  const blocker = diagnosticParts.length > 0
    ? `${error.message} (${diagnosticParts.join('; ')})`
    : error.message;

  return {
    blockers: [blocker],
    hostSummary: {
      at: new Date().toISOString(),
      code: error.code,
      message: error.message,
      outputFilename,
      firstOutputFilename,
      expectedSourceNameFilenameCount: expectedFilenames.length,
      expectedSourceNameFilenameSamples: expectedFilenameSamples,
      expectedSourceNameStemCount: expectedStems.length,
      expectedSourceNameStemSamples: expectedStemSamples,
    },
  };
}

function readStringField(object: Record<string, unknown>, key: string): string | undefined {
  const value = object[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function readStringArrayField(object: Record<string, unknown>, key: string): string[] {
  const value = object[key];
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string' && Boolean(item.trim()));
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
  outputRelativePath: string;
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
  const actualRelativeDir = posix.dirname(input.outputRelativePath);
  return {
    pathMirror: expectedRelativeDir === actualRelativeDir ? 'pass' : 'fail',
    filenameNormalized: posix.basename(input.outputRelativePath) === input.normalizedOutputFilename ? 'pass' : 'fail',
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

async function mirrorColorSidecarsForEntry(input: {
  rawLocalPath: string;
  sourceAbsolutePath: string;
  outputRelativePath: string;
  localRootPath: string;
}): Promise<IColorBatchSidecar[]> {
  const sidecars = await discoverColorSidecarsForEntry(input);
  for (const sidecar of sidecars) {
    await mkdir(dirname(sidecar.outputPath), { recursive: true });
    await copyFile(sidecar.sourceAbsolutePath, sidecar.outputPath);
  }
  return sidecars;
}

async function discoverColorSidecarsForEntry(input: {
  rawLocalPath: string;
  sourceAbsolutePath: string;
  outputRelativePath: string;
  localRootPath: string;
}): Promise<IColorBatchSidecar[]> {
  const sourceDir = dirname(input.sourceAbsolutePath);
  const sourceExt = extname(input.sourceAbsolutePath);
  const sourceFilename = input.sourceAbsolutePath.split(/[\\/]/u).pop() ?? '';
  const sourceStem = sourceExt ? sourceFilename.slice(0, -sourceExt.length) : sourceFilename;
  if (!sourceStem) return [];
  const outputExt = posix.extname(input.outputRelativePath);
  const outputDir = posix.dirname(input.outputRelativePath);
  const outputStem = posix.basename(input.outputRelativePath, outputExt);
  const entries = await readdir(sourceDir, { withFileTypes: true }).catch(() => []);
  const claimedExtensions = new Set<string>();
  const sidecars: IColorBatchSidecar[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, 'zh-Hans-CN'))) {
    if (!entry.isFile()) continue;
    const extension = extname(entry.name);
    const extensionKey = extension.toLowerCase();
    if (!CCOLOR_SIDECAR_EXTENSIONS.has(extensionKey)) continue;
    if (claimedExtensions.has(extensionKey)) continue;
    const candidateStem = extension ? entry.name.slice(0, -extension.length) : entry.name;
    if (candidateStem.toLowerCase() !== sourceStem.toLowerCase()) continue;
    claimedExtensions.add(extensionKey);

    const sourceAbsolutePath = resolve(join(sourceDir, entry.name));
    const outputFilename = `${outputStem}${extension}`;
    const outputRelativePath = normalizePortablePath(
      outputDir === '.'
        ? outputFilename
        : posix.join(outputDir, outputFilename),
    );
    const targetPath = resolve(join(input.localRootPath, ...outputRelativePath.split('/')));
    const sourceStats = await stat(sourceAbsolutePath).catch(() => null);
    sidecars.push({
      sourceRelativePath: normalizePortablePath(toPortableRelativePath(input.rawLocalPath, sourceAbsolutePath)),
      sourceAbsolutePath,
      outputRelativePath,
      outputPath: targetPath,
      extension,
      sizeBytes: sourceStats?.size,
    });
  }
  return sidecars;
}

async function validateExpectedColorSidecars(
  expectedSidecars: IColorBatchSidecar[],
  manifestSidecars: IColorBatchSidecar[],
): Promise<string[]> {
  const reasons: string[] = [];
  const manifestByOutput = new Map(
    manifestSidecars.map(sidecar => [normalizePortablePath(sidecar.outputRelativePath).toLowerCase(), sidecar]),
  );
  for (const expected of expectedSidecars) {
    const actual = manifestByOutput.get(normalizePortablePath(expected.outputRelativePath).toLowerCase());
    const outputStats = await stat(expected.outputPath).catch(() => null);
    if (!actual || !outputStats?.isFile()) {
      reasons.push(`sidecar sync pending: run sync_batch_sidecars for ${expected.outputRelativePath}`);
      continue;
    }
    if (typeof expected.sizeBytes === 'number' && outputStats.size !== expected.sizeBytes) {
      reasons.push(`sidecar size mismatch: ${expected.sourceRelativePath}`);
    }
  }
  return dedupeStrings(reasons);
}

async function validateColorSidecars(sidecars: IColorBatchSidecar[]): Promise<string[]> {
  const reasons: string[] = [];
  for (const sidecar of sidecars) {
    const extensionKey = (sidecar.extension || extname(sidecar.outputPath)).toLowerCase();
    if (!CCOLOR_SIDECAR_EXTENSIONS.has(extensionKey)) continue;
    const sourceStats = await stat(sidecar.sourceAbsolutePath).catch(() => null);
    const outputStats = await stat(sidecar.outputPath).catch(() => null);
    if (!sourceStats?.isFile()) {
      reasons.push(`sidecar source missing: ${sidecar.sourceRelativePath}`);
      continue;
    }
    if (!outputStats?.isFile()) {
      reasons.push(`sidecar output missing: ${sidecar.outputRelativePath}`);
      continue;
    }
    if (sourceStats.size !== outputStats.size) {
      reasons.push(`sidecar size mismatch: ${sidecar.sourceRelativePath}`);
    }
  }
  return dedupeStrings(reasons);
}

function normalizePortablePath(value: string): string {
  return value.replace(/\\/g, '/');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function extractStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim()));
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
    const dimensions = resolveColorTimelineSpecDimensions(clip);
    if (!dimensions || typeof clip.fps !== 'number') {
      continue;
    }
    const key = `${dimensions.width}x${dimensions.height}@${clip.fps.toFixed(3)}`;
    const current = counts.get(key);
    if (current) {
      current.count += 1;
      continue;
    }
    counts.set(key, {
      width: dimensions.width,
      height: dimensions.height,
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

function resolveColorTimelineSpecDimensions(
  clip: IColorExecutorClipInput,
): { width: number; height: number } | undefined {
  const width = finitePositiveNumber(clip.displayWidth) ?? finitePositiveNumber(clip.width);
  const height = finitePositiveNumber(clip.displayHeight) ?? finitePositiveNumber(clip.height);
  if (width == null || height == null) return undefined;
  if (clip.orientationStatus === 'portrait' || height > width) {
    return {
      width: Math.max(width, height),
      height: Math.min(width, height),
    };
  }
  return { width, height };
}

function deriveSourceStem(rawRelativePath: string): string {
  return posix.basename(rawRelativePath, posix.extname(rawRelativePath));
}
