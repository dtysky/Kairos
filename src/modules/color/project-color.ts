import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, stat, unlink } from 'node:fs/promises';
import { dirname, join, posix, relative, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
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
import {
  buildColorWorkspaceState,
  deriveColorGradingTimelineName,
  deriveColorResolveProjectName,
  deriveColorRootNamespace,
} from './workspace-state.js';
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
  | 'execute_group'
  | 'validate_batch'
  | 'promote_batch';

const CCOLOR_STEP_DEFINITIONS: Record<TProjectColorAction, Array<{ key: string; label: string }>> = {
  prepare_root: [
    { key: 'sync_root_bins', label: '同步 root 镜像预备态' },
    { key: 'prepare_root_timeline', label: '准备 root timeline' },
  ],
  sync_groups: [
    { key: 'sync_groups', label: '同步 Resolve Groups' },
  ],
  execute_group: [
    { key: 'scan_root_clips', label: '扫描 raw clip inventory' },
    { key: 'render_group', label: '执行 Group 渲染' },
  ],
  validate_batch: [
    { key: 'validate_batch', label: '校验 batch manifest' },
  ],
  promote_batch: [
    { key: 'promote_batch', label: '覆盖当前素材目录' },
  ],
};

export interface IProjectColorActionInput {
  workspaceRoot: string;
  projectId: string;
  rootId: string;
  action?: TProjectColorAction;
  groupKey?: string;
  batchId?: string;
  jobId?: string;
  progressPath?: string;
  executor?: IColorExecutor;
}

export interface IProjectColorActionResult {
  action: TProjectColorAction;
  projectId: string;
  rootId: string;
  groupKey?: string;
  batchId?: string;
  detail: string;
  blockingReasons: string[];
}

export interface IPrepareProjectColorRootInput extends IProjectColorActionInput {
  action?: 'prepare_root';
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
    case 'prepare_root':
      return prepareProjectColorRoot({
        ...input,
        action: 'prepare_root',
      });
    case 'sync_groups':
      return syncProjectColorGroups(input);
    case 'execute_group':
      return executeProjectColorGroup(input);
    case 'validate_batch':
      return validateProjectColorBatch(input);
    case 'promote_batch':
      return promoteProjectColorBatch(input);
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

export async function prepareProjectColorRoot(
  input: IPrepareProjectColorRootInput,
): Promise<IPrepareProjectColorRootResult> {
  const action: TProjectColorAction = 'prepare_root';
  const context = await loadColorRootContext(input.workspaceRoot, input.projectId, input.rootId);
  const progressPath = resolveColorProgressPath(context.projectRoot, input.progressPath);
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
    await writeColorProgress(progressPath, action, {
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
  await writeColorProgress(progressPath, action, {
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

  const prepared = await runColorHostWithRetry(
    () => executor.prepareRoot({
      projectId: input.projectId,
      rootId: context.rootId,
      resolveProjectName: context.rootSummary.resolveProjectName,
      rootNamespace: context.rootSummary.rootNamespace,
      gradingTimelineName: context.rootSummary.gradingTimelineName,
      rawPath: context.rootSummary.rawPath,
      rawLocalPath: context.rootSummary.rawLocalPath ?? '',
      timelineSpec,
      lutSyncSummary: preparedClipTransforms.lutSyncSummary,
      clips: preparedClipTransforms.clips,
    }),
    `prepare_root:${context.rootId}`,
  );

  await writeRootCurrent(context.projectRoot, context.rootId, current => ({
    ...current,
    mirrorStatus: prepared.mirrorStatus,
    timelineStatus: 'running',
    activeStage: 'prepare_root_timeline',
    currentJobId: input.jobId,
    detail: 'Resolve host 已确认 root bin，正在对账 grading timeline。',
    blockingReasons: filterPersistentColorBlockers(current.blockingReasons ?? []),
  }));
  await writeColorProgress(progressPath, action, {
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

  if (prepared.groupsSnapshot) {
    await saveColorGroupsSnapshot(context.projectRoot, prepared.groupsSnapshot);
  }
  const syncedGroups = prepared.groupsSnapshot
    ? materializeCurrentGroupsFromSnapshot(
      prepared.groupsSnapshot,
      context.colorCurrent.roots.find(root => root.rootId === context.rootId)?.groups ?? [],
      context.groupsSnapshot,
    )
    : undefined;
  const detail = [
    'Resolve host root prep 已完成。',
    prepared.groupsSnapshot
      ? `Kairos 已写入 ${prepared.groupsSnapshot.groups.length} 个 Resolve Groups 快照。`
      : 'Kairos 已持久化 root mirror / timeline current truth。',
    '如需复核 Resolve 内调整，可继续运行 Sync Groups。'
  ].join(' ');
  const savedCurrent = await writeRootCurrent(context.projectRoot, context.rootId, current => ({
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
  await writeColorProgress(progressPath, action, {
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
  const context = await loadColorRootContext(input.workspaceRoot, input.projectId, input.rootId);
  const progressPath = resolveColorProgressPath(context.projectRoot, input.progressPath);
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
      rootId: input.rootId,
    });
    throw new ProjectColorBlockedError(blockers);
  }
  const executor = resolveColorExecutor(context, input.executor);
  await ensureActionHostPreflight({
    context,
    action,
    executor,
    progressPath,
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

  await writeRootCurrent(context.projectRoot, context.rootId, current => ({
    ...current,
    groupSyncStatus: 'running',
    activeStage: 'sync_groups',
    currentJobId: input.jobId,
    detail: '正在从 Resolve root timeline 同步正式 Groups。',
  }));
  await writeColorProgress(progressPath, action, {
    status: 'running',
    stepIndex: 1,
    current: 0,
    detail: `正在同步 ${context.rootSummary.gradingTimelineName} 的 Groups。`,
    extra: { projectId: input.projectId, rootId: input.rootId },
  });

  const snapshot = await runColorHostWithRetry(
    () => executor.syncGroups({
      projectId: input.projectId,
      rootId: input.rootId,
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
  const detail = savedCurrent.roots.find(root => root.rootId === input.rootId)?.detail
    ?? `已同步 ${snapshot.groups.length} 个 Resolve Groups。`;
  await writeColorProgress(progressPath, action, {
    status: 'succeeded',
    stepIndex: 1,
    current: 1,
    detail,
    extra: {
      projectId: input.projectId,
      rootId: input.rootId,
      groupsPath: getColorGroupsSnapshotPath(context.projectRoot, input.rootId),
      groupCount: snapshot.groups.length,
    },
  });

  return {
    action,
    projectId: input.projectId,
    rootId: input.rootId,
    detail,
    blockingReasons: [],
  };
}

export async function executeProjectColorGroup(
  input: IProjectColorActionInput,
): Promise<IProjectColorActionResult> {
  const action: TProjectColorAction = 'execute_group';
  const context = await loadColorRootContext(input.workspaceRoot, input.projectId, input.rootId);
  const progressPath = resolveColorProgressPath(context.projectRoot, input.progressPath);
  const groupKey = input.groupKey?.trim();
  const group = groupKey
    ? context.rootSummary.groups.find(item => item.groupKey === groupKey)
    : null;
  const blockers = dedupeStrings([
    !groupKey ? 'execute_group requires args.groupKey。' : '',
    !group ? `当前 root 尚未同步正式 Group：${groupKey ?? '(missing)'}` : '',
    !context.rootSummary.localPath ? '当前设备未配置 current localPath，无法在本机覆盖当前素材目录。' : '',
    !context.rootSummary.rawLocalPath ? '当前设备未配置 rawLocalPath，无法扫描原始素材。' : '',
    typeof context.rootSummary.renderPreset.bitrateMbps !== 'number'
      ? '未配置 root 级 renderPreset.bitrateMbps，无法启动 execute_group。'
      : '',
  ]);
  if (blockers.length > 0) {
    await failColorAction(context.projectRoot, context.rootId, progressPath, action, blockers, {
      projectId: input.projectId,
      rootId: input.rootId,
      groupKey,
    });
    throw new ProjectColorBlockedError(blockers);
  }
  const executor = resolveColorExecutor(context, input.executor);
  const hostPreflight = await ensureActionHostPreflight({
    context,
    action,
    executor,
    progressPath,
    extra: {
      projectId: input.projectId,
      rootId: input.rootId,
      groupKey,
    },
  });
  const renderPresetBlockers = validateRenderPresetSupport(context.rootSummary.renderPreset, hostPreflight);
  if (renderPresetBlockers.length > 0) {
    await failColorAction(context.projectRoot, context.rootId, progressPath, action, renderPresetBlockers, {
      projectId: input.projectId,
      rootId: input.rootId,
      groupKey,
    }, {
      persistRootBlockers: false,
    });
    throw new ProjectColorBlockedError(renderPresetBlockers);
  }

  const rawInventory = await scanColorRawInventory(context.rootSummary.rawLocalPath ?? '');
  const inventoryByKey = new Map(rawInventory.map(entry => [entry.rawRelativePath, entry]));
  const missingClipKeys = (group?.clipKeys ?? []).filter(clipKey => !inventoryByKey.has(clipKey));
  if (missingClipKeys.length > 0) {
    const missingBlockers = missingClipKeys.map(clipKey => `Group clip 不存在于 rawLocalPath: ${clipKey}`);
    await failColorAction(context.projectRoot, context.rootId, progressPath, action, missingBlockers, {
      projectId: input.projectId,
      rootId: input.rootId,
      groupKey,
    });
    throw new ProjectColorBlockedError(missingBlockers);
  }

  const batchId = randomUUID();
  const stagingRoot = join(context.projectRoot, '.tmp', 'color', batchId, 'render');
  await mkdir(stagingRoot, { recursive: true });
  const planEntries = await Promise.all(
    (group?.clipKeys ?? []).map(async clipKey => {
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
    rootId: input.rootId,
    groupKey: groupKey!,
    createdAt: new Date().toISOString(),
    stagingRoot,
    renderPreset: context.rootSummary.renderPreset,
    clipKeys: group?.clipKeys ?? [],
    entries: planEntries,
  };
  await saveColorBatchPlan(context.projectRoot, plan);

  await writeRootCurrent(context.projectRoot, context.rootId, current => updateGroupCurrentState(current, groupKey!, groupCurrent => ({
    ...groupCurrent,
    status: 'running',
    displayName: group?.displayName,
    clipCount: group?.clipCount,
    latestBatchId: batchId,
    latestBatchStatus: 'rendering',
    latestValidationStatus: 'pending',
    pendingPromoteBatchId: undefined,
    blockingReasons: [],
  }), {
    activeStage: 'render_group',
    currentJobId: input.jobId,
    detail: `正在执行 Group 渲染：${groupKey}`,
    latestBatchId: batchId,
  }));
  await writeColorProgress(progressPath, action, {
    status: 'running',
    stepIndex: 1,
    current: 0,
    detail: `正在扫描 ${group?.clipCount ?? 0} 个 raw clips。`,
    extra: { projectId: input.projectId, rootId: input.rootId, groupKey, batchId },
  });
  await writeColorProgress(progressPath, action, {
    status: 'running',
    stepIndex: 2,
    current: 1,
    detail: `正在执行 Group 渲染：${groupKey}`,
    extra: { projectId: input.projectId, rootId: input.rootId, groupKey, batchId, stagingRoot },
  });

  const rendered = await runColorHostWithRetry(
    () => executor.executeGroup({
      projectId: input.projectId,
      rootId: input.rootId,
      groupKey: groupKey!,
      resolveProjectName: context.rootSummary.resolveProjectName,
      gradingTimelineName: context.rootSummary.gradingTimelineName,
      rawLocalPath: context.rootSummary.rawLocalPath ?? '',
      renderPreset: context.rootSummary.renderPreset,
      stagingRoot,
      clips: planEntries.map(entry => ({
        rawRelativePath: entry.rawRelativePath,
        sourceAbsolutePath: entry.sourceAbsolutePath,
        sourceStem: deriveSourceStem(entry.rawRelativePath),
        width: entry.sourceMetadataSnapshot?.width,
        height: entry.sourceMetadataSnapshot?.height,
        fps: entry.sourceMetadataSnapshot?.fps,
      })),
    }),
    `execute_group:${context.rootId}:${groupKey}`,
  );

  const manifestEntries = await Promise.all(
    rendered.entries.map(async entry => {
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
        sourceMetadataSnapshot: planEntries.find(item => item.rawRelativePath === entry.rawRelativePath)?.sourceMetadataSnapshot,
        outputMetadataSnapshot: await buildColorFileMetadataSnapshot(entry.outputPath, context.runtimeConfig).catch(() => undefined),
      };
    }),
  );
  const manifest: IColorBatchManifest = {
    batchId,
    rootId: input.rootId,
    groupKey: groupKey!,
    createdAt: rendered.renderedAt,
    renderPreset: context.rootSummary.renderPreset,
    managedOutputSet: manifestEntries.map(entry => entry.promoteRelativePath),
    entries: manifestEntries,
  };
  await saveColorBatchManifest(context.projectRoot, manifest);

  const savedCurrent = await writeRootCurrent(context.projectRoot, context.rootId, current => updateGroupCurrentState(current, groupKey!, groupCurrent => ({
    ...groupCurrent,
    status: 'staged',
    displayName: group?.displayName,
    clipCount: group?.clipCount,
    latestBatchId: batchId,
    latestBatchStatus: 'staged',
    latestValidationStatus: 'pending',
    pendingPromoteBatchId: undefined,
    blockingReasons: [],
  }), {
    activeStage: undefined,
    currentJobId: undefined,
    detail: `Group 渲染已完成，待 validation：${groupKey}`,
    latestBatchId: batchId,
  }));
  const detail = savedCurrent.roots.find(root => root.rootId === input.rootId)?.detail
    ?? `Group 渲染已完成，待 validation：${groupKey}`;
  await writeColorProgress(progressPath, action, {
    status: 'succeeded',
    stepIndex: 2,
    current: 2,
    detail,
    extra: {
      projectId: input.projectId,
      rootId: input.rootId,
      groupKey,
      batchId,
    },
  });

  return {
    action,
    projectId: input.projectId,
    rootId: input.rootId,
    groupKey,
    batchId,
    detail,
    blockingReasons: [],
  };
}

export async function validateProjectColorBatch(
  input: IProjectColorActionInput,
): Promise<IProjectColorActionResult> {
  const action: TProjectColorAction = 'validate_batch';
  const context = await loadColorRootContext(input.workspaceRoot, input.projectId, input.rootId);
  const progressPath = resolveColorProgressPath(context.projectRoot, input.progressPath);
  const batchId = input.batchId?.trim();
  const blockers = dedupeStrings([
    !batchId ? 'validate_batch requires args.batchId。' : '',
  ]);
  if (blockers.length > 0) {
    await failColorAction(context.projectRoot, context.rootId, progressPath, action, blockers, {
      projectId: input.projectId,
      rootId: input.rootId,
      batchId,
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
    plan && plan.rootId !== input.rootId ? `batch ${batchId} 不属于 root ${input.rootId}` : '',
  ]);
  if (ioBlockers.length > 0) {
    await failColorAction(context.projectRoot, context.rootId, progressPath, action, ioBlockers, {
      projectId: input.projectId,
      rootId: input.rootId,
      batchId,
    });
    throw new ProjectColorBlockedError(ioBlockers);
  }

  await writeColorProgress(progressPath, action, {
    status: 'running',
    stepIndex: 1,
    current: 0,
    detail: `正在校验 batch：${batchId}`,
    extra: { projectId: input.projectId, rootId: input.rootId, batchId },
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
    rootId: input.rootId,
    groupKey: manifest!.groupKey,
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

  const currentRoot = context.colorCurrent.roots.find(root => root.rootId === input.rootId);
  const latestBatchMatches = currentRoot?.groups.find(group => group.groupKey === manifest!.groupKey)?.latestBatchId === batchId;
  const savedCurrent = await writeRootCurrent(context.projectRoot, context.rootId, current => latestBatchMatches
    ? updateGroupCurrentState(current, manifest!.groupKey, groupCurrent => ({
      ...groupCurrent,
      status: validationStatus === 'pass' ? 'ready' : 'blocked',
      latestBatchId: batchId,
      latestBatchStatus: validationStatus === 'pass' ? 'validated' : 'failed',
      latestValidationStatus: validationStatus,
      pendingPromoteBatchId: validationStatus === 'pass' ? batchId : undefined,
      blockingReasons: validationStatus === 'pass'
        ? []
        : validationBlockingReasons,
    }), {
      pendingPromoteGroupKey: validationStatus === 'pass' ? manifest!.groupKey : undefined,
      pendingPromoteBatchId: validationStatus === 'pass' ? batchId : undefined,
      detail: validationStatus === 'pass'
        ? `batch 已通过 validation，可 promote：${batchId}`
        : `batch validation 失败：${batchId}`,
    })
    : {
      ...current,
      detail: `batch ${batchId} 已完成 validation，但它已不是当前最新候选。`,
    });
  const detail = savedCurrent.roots.find(root => root.rootId === input.rootId)?.detail
    ?? `batch ${batchId} validation 已完成。`;
  await writeColorProgress(progressPath, action, {
    status: validationStatus === 'pass' ? 'succeeded' : 'failed',
    stepIndex: 1,
    current: 1,
    detail,
    extra: {
      projectId: input.projectId,
      rootId: input.rootId,
      batchId,
      validationStatus,
    },
  });

  return {
    action,
    projectId: input.projectId,
    rootId: input.rootId,
    groupKey: manifest!.groupKey,
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
  const context = await loadColorRootContext(input.workspaceRoot, input.projectId, input.rootId);
  const progressPath = resolveColorProgressPath(context.projectRoot, input.progressPath);
  const batchId = input.batchId?.trim();
  const [manifest, validation] = await Promise.all([
    batchId ? loadColorBatchManifest(context.projectRoot, batchId) : Promise.resolve(null),
    batchId ? loadColorBatchValidation(context.projectRoot, batchId) : Promise.resolve(null),
  ]);
  const currentGroup = manifest
    ? context.colorCurrent.roots.find(root => root.rootId === input.rootId)?.groups.find(group => group.groupKey === manifest.groupKey)
    : null;
  const blockers = dedupeStrings([
    !batchId ? 'promote_batch requires args.batchId。' : '',
    !manifest ? `缺少 batch manifest: ${batchId ?? '(missing)'}` : '',
    !validation ? `缺少 batch validation: ${batchId ?? '(missing)'}` : '',
    validation && validation.status !== 'pass' ? `batch ${batchId} 尚未通过 validation。` : '',
    !context.rootSummary.localPath ? '当前设备未配置 current localPath，无法覆盖当前素材目录。' : '',
    !currentGroup ? `当前 root 未记录该 batch 对应的 Group。` : '',
    currentGroup && currentGroup.latestBatchId !== batchId
      ? `batch ${batchId} 已被更新的候选取代，不能再 promote。`
      : '',
  ]);
  if (blockers.length > 0) {
    await failColorAction(context.projectRoot, context.rootId, progressPath, action, blockers, {
      projectId: input.projectId,
      rootId: input.rootId,
      batchId,
    });
    throw new ProjectColorBlockedError(blockers);
  }

  await writeColorProgress(progressPath, action, {
    status: 'running',
    stepIndex: 1,
    current: 0,
    detail: `正在 promote batch：${batchId}`,
    extra: { projectId: input.projectId, rootId: input.rootId, batchId },
  });

  const previousPromote = currentGroup?.lastPromotedBatchId
    ? await loadColorBatchManifest(context.projectRoot, currentGroup.lastPromotedBatchId)
    : null;
  const deletedOutputs = await deleteManagedOutputs(
    context.rootSummary.localPath ?? '',
    previousPromote?.managedOutputSet ?? [],
    manifest?.managedOutputSet ?? [],
  );
  const copiedOutputs = await copyManagedOutputs(context.rootSummary.localPath ?? '', manifest!);
  const promote: IColorBatchPromote = {
    batchId: batchId!,
    rootId: input.rootId,
    groupKey: manifest!.groupKey,
    promotedAt: new Date().toISOString(),
    status: 'completed',
    outputs: copiedOutputs,
    deletedOutputs,
    detail: `已 promote ${copiedOutputs.length} 个输出到当前素材目录。`,
  };
  await saveColorBatchPromote(context.projectRoot, promote);

  const savedCurrent = await writeRootCurrent(context.projectRoot, context.rootId, current => updateGroupCurrentState(current, manifest!.groupKey, groupState => ({
    ...groupState,
    status: 'promoted',
    latestBatchId: batchId,
    latestBatchStatus: 'promoted',
    latestValidationStatus: 'pass',
    pendingPromoteBatchId: undefined,
    lastPromotedBatchId: batchId,
    blockingReasons: [],
  }), {
    pendingPromoteGroupKey: current.pendingPromoteGroupKey === manifest!.groupKey ? undefined : current.pendingPromoteGroupKey,
    pendingPromoteBatchId: current.pendingPromoteBatchId === batchId ? undefined : current.pendingPromoteBatchId,
    detail: promote.detail,
  }));
  const detail = savedCurrent.roots.find(root => root.rootId === input.rootId)?.detail ?? promote.detail ?? 'promote 完成。';
  await writeColorProgress(progressPath, action, {
    status: 'succeeded',
    stepIndex: 1,
    current: 1,
    detail,
    extra: {
      projectId: input.projectId,
      rootId: input.rootId,
      batchId,
      outputCount: copiedOutputs.length,
    },
  });

  return {
    action,
    projectId: input.projectId,
    rootId: input.rootId,
    groupKey: manifest!.groupKey,
    batchId,
    detail,
    blockingReasons: [],
  };
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
    case 'execute_group':
    case 'validate_batch':
    case 'promote_batch':
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
  return saveColorCurrent(projectRoot, {
    ...existing,
    selectedRootId: rootId,
    roots: [nextRoot],
    updatedAt: new Date().toISOString(),
  });
}

function updateGroupCurrentState(
  current: IColorRootCurrent,
  groupKey: string,
  groupUpdater: (group: IColorGroupCurrent) => IColorGroupCurrent,
  rootPatch: Partial<IColorRootCurrent> = {},
): IColorRootCurrent {
  const groups = [...(current.groups ?? [])];
  const index = groups.findIndex(group => group.groupKey === groupKey);
  const baseGroup: IColorGroupCurrent = index >= 0
    ? groups[index]!
    : {
      groupKey,
      status: 'idle',
      blockingReasons: [],
    };
  const nextGroup = groupUpdater(baseGroup);
  if (index >= 0) {
    groups[index] = nextGroup;
  } else {
    groups.push(nextGroup);
  }
  return {
    ...current,
    ...rootPatch,
    groups,
  };
}

function materializeCurrentGroupsFromSnapshot(
  snapshot: IColorGroupsSnapshotFile,
  existingGroups: IColorRootCurrent['groups'],
  previousSnapshot?: IColorGroupsSnapshotFile | null,
): IColorGroupCurrent[] {
  const existingByKey = new Map((existingGroups ?? []).map(group => [group.groupKey, group]));
  const previousByKey = new Map((previousSnapshot?.groups ?? []).map(group => [group.groupKey, group]));
  const preservedStatuses = new Set<IColorGroupCurrent['status']>(['running', 'staged', 'promoted']);
  return snapshot.groups.map(group => {
    const existing = existingByKey.get(group.groupKey);
    const previousGroup = previousByKey.get(group.groupKey);
    const clipKeysChanged = !sameStringSet(previousGroup?.clipKeys ?? [], group.clipKeys ?? []);
    const nextStatus = preservedStatuses.has(existing?.status ?? 'idle')
      ? existing!.status
      : group.clipKeys.length > 0
        ? 'ready'
        : 'blocked';
    const preserveBatchState = Boolean(existing) && (
      !clipKeysChanged
      || preservedStatuses.has(existing?.status ?? 'idle')
    );
    return {
      groupKey: group.groupKey,
      status: nextStatus,
      displayName: existing?.displayName ?? group.displayName,
      clipCount: group.clipKeys.length,
      latestBatchId: preserveBatchState ? existing?.latestBatchId : undefined,
      latestBatchStatus: preserveBatchState ? existing?.latestBatchStatus : undefined,
      latestValidationStatus: preserveBatchState ? existing?.latestValidationStatus : undefined,
      pendingPromoteBatchId: preserveBatchState ? existing?.pendingPromoteBatchId : undefined,
      lastPromotedBatchId: preserveBatchState ? existing?.lastPromotedBatchId : undefined,
      blockingReasons: nextStatus === 'blocked'
        ? dedupeStrings([...(preserveBatchState ? existing?.blockingReasons ?? [] : []), '该 Group 当前没有可执行 clip。'])
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
  return writeKairosProgress(progressPath, {
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
  } = {},
) {
  await writeRootCurrent(projectRoot, rootId, current => ({
    ...current,
    activeStage: CCOLOR_STEP_DEFINITIONS[action][0]?.key,
    currentJobId: undefined,
    detail: blockers.join('；'),
    blockingReasons: options.persistRootBlockers === false
      ? current.blockingReasons ?? []
      : dedupeStrings([...(current.blockingReasons ?? []), ...blockers]),
    ...(action === 'sync_groups' ? { groupSyncStatus: 'blocked' as const } : {}),
  }));
  await writeColorProgress(progressPath, action, {
    status: 'failed',
    stepIndex: 1,
    current: 0,
    detail: blockers.join('；'),
    extra,
  });
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
      const sourceTruth = await extractColorSourceTruth(item.sourceAbsolutePath, runtimeConfig).catch(() => ({
        logProfile: undefined,
        gyro: undefined,
        lowlight: undefined,
        deviceFamilyKeys: [],
        sourceKinds: [],
      }));
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
        gyro: sourceTruth.gyro,
        lowlight: sourceTruth.lowlight,
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

async function ensureActionHostPreflight(input: {
  context: IColorRootContext;
  action: TProjectColorAction;
  executor: IColorExecutor;
  progressPath: string;
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
      { persistRootBlockers: false },
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
    return ['当前 root 的 renderPreset 缺少 container 或 videoCodec，无法启动 execute_group。'];
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
  if (typeof renderPreset.bitrateMbps === 'number' && support.supportsVideoQuality === false) {
    blockers.push(`当前 Resolve host 不支持 VideoQuality 设置：${renderPreset.bitrateMbps} Mbps`);
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
