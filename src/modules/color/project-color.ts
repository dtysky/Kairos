import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, stat, unlink } from 'node:fs/promises';
import { dirname, join, posix, relative, resolve } from 'node:path';
import type {
  IColorBatchManifest,
  IColorBatchPlan,
  IColorBatchPromote,
  IColorBatchValidation,
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
import {
  PythonResolveColorExecutor,
  ResolveColorExecutorUnavailableError,
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
  projectRoot: string;
  projectId: string;
  rootId: string;
  rootSummary: ReturnType<typeof buildColorWorkspaceState>['colorRoots'][number];
  colorCurrent: IColorCurrent;
  runtimeConfig: Awaited<ReturnType<typeof loadRuntimeConfig>>;
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

export async function prepareProjectColorRoot(
  input: IPrepareProjectColorRootInput,
): Promise<IPrepareProjectColorRootResult> {
  const action: TProjectColorAction = 'prepare_root';
  const context = await loadColorRootContext(input.workspaceRoot, input.projectId, input.rootId);
  const progressPath = resolveColorProgressPath(context.projectRoot, input.progressPath);
  const prepBlockers = dedupeStrings([
    !context.rootSummary.rawPath ? '当前 root 未配置 rawPath，无法进入 color prep。' : '',
    !context.rootSummary.rawLocalPath ? '当前设备未配置 rawLocalPath，无法在本机读取原始素材。' : '',
    !context.runtimeConfig.resolveColorPythonPath?.trim()
      ? '未配置 config/runtime.json resolveColorPythonPath，无法调用 official Python Resolve host。'
      : '',
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

  await writeRootCurrent(context.projectRoot, context.rootId, current => ({
    ...current,
    mirrorStatus: 'running',
    timelineStatus: 'idle',
    activeStage: 'sync_root_bins',
    currentJobId: input.jobId,
    detail: '正在调用 official Python Resolve host 准备项目 / root bin / grading timeline。',
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

  const prepared = await executor.prepareRoot({
    projectId: input.projectId,
    rootId: context.rootId,
    resolveProjectName: context.rootSummary.resolveProjectName,
    rootNamespace: context.rootSummary.rootNamespace,
    gradingTimelineName: context.rootSummary.gradingTimelineName,
    rawPath: context.rootSummary.rawPath,
    rawLocalPath: context.rootSummary.rawLocalPath ?? '',
  });

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

  const detail = [
    'Resolve host root prep 已完成。',
    'Kairos 已持久化 root mirror / timeline current truth。',
    '下一步可同步正式 Group，或继续执行 batch。'
  ].join(' ');
  const savedCurrent = await writeRootCurrent(context.projectRoot, context.rootId, current => ({
    ...current,
    mirrorStatus: prepared.mirrorStatus,
    timelineStatus: prepared.timelineStatus,
    activeStage: undefined,
    currentJobId: undefined,
    detail,
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
      hostSummary: prepared.hostSummary ?? {},
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
    !context.runtimeConfig.resolveColorPythonPath?.trim()
      ? '未配置 config/runtime.json resolveColorPythonPath，无法调用 official Python Resolve host。'
      : '',
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

  const snapshot = await executor.syncGroups({
    projectId: input.projectId,
    rootId: input.rootId,
    resolveProjectName: context.rootSummary.resolveProjectName,
    gradingTimelineName: context.rootSummary.gradingTimelineName,
    rawPath: context.rootSummary.rawPath,
    rawLocalPath: context.rootSummary.rawLocalPath ?? '',
  });
  await saveColorGroupsSnapshot(context.projectRoot, snapshot);

  const savedCurrent = await writeRootCurrent(context.projectRoot, context.rootId, current => ({
    ...current,
    groupSyncStatus: 'ready',
    groupSyncAt: snapshot.syncedAt ?? new Date().toISOString(),
    activeStage: undefined,
    currentJobId: undefined,
    detail: `已同步 ${snapshot.groups.length} 个 Resolve Groups。`,
    groups: materializeCurrentGroupsFromSnapshot(snapshot, current.groups ?? []),
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
    !context.rootSummary.path ? '当前 root 未配置 current path，无法生成 promote 目标。' : '',
    !context.rootSummary.localPath ? '当前设备未配置 current localPath，无法在本机覆盖当前素材目录。' : '',
    !context.rootSummary.rawLocalPath ? '当前设备未配置 rawLocalPath，无法扫描原始素材。' : '',
    typeof context.rootSummary.renderPreset.bitrateMbps !== 'number'
      ? '未配置 root 级 renderPreset.bitrateMbps，无法启动 execute_group。'
      : '',
    !context.runtimeConfig.resolveColorPythonPath?.trim()
      ? '未配置 config/runtime.json resolveColorPythonPath，无法调用 official Python Resolve host。'
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

  const rendered = await executor.executeGroup({
    projectId: input.projectId,
    rootId: input.rootId,
    groupKey: groupKey!,
    resolveProjectName: context.rootSummary.resolveProjectName,
    gradingTimelineName: context.rootSummary.gradingTimelineName,
    renderPreset: context.rootSummary.renderPreset,
    stagingRoot,
    clips: planEntries.map(entry => ({
      rawRelativePath: entry.rawRelativePath,
      sourceAbsolutePath: entry.sourceAbsolutePath,
    })),
  });

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
        checks,
      };
    }),
  );

  const validationStatus = validationEntries.some(entry => entry.status === 'fail')
    ? 'fail'
    : 'pass';
  const validation: IColorBatchValidation = {
    batchId: batchId!,
    rootId: input.rootId,
    groupKey: manifest!.groupKey,
    validatedAt: new Date().toISOString(),
    status: validationStatus,
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
        : dedupeStrings(validationEntries.flatMap(entry => entry.reasons)),
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
      : dedupeStrings(validationEntries.flatMap(entry => entry.reasons)),
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
  const [projectRoots, deviceMaps, colorCurrent, runtimeConfig, groupSnapshotsByRootId] = await Promise.all([
    loadIngestRoots(projectRoot),
    loadProjectDeviceMediaMaps(projectRoot),
    loadColorCurrent(projectRoot),
    loadRuntimeConfig(projectRoot),
    loadColorGroupsSnapshots(projectRoot),
  ]);
  const colorWorkspace = buildColorWorkspaceState({
    projectId,
    projectRoots: projectRoots.roots,
    deviceProjectMap: deviceMaps.projects[projectId],
    colorCurrent,
    runtimeConfig,
    groupSnapshotsByRootId,
  });
  const rootSummary = colorWorkspace.colorRoots.find(root => root.rootId === rootId);
  if (!rootSummary) {
    throw new ProjectColorBlockedError([`color root 不存在或未配置 rawPath: ${rootId}`]);
  }
  return {
    projectRoot,
    projectId,
    rootId,
    rootSummary,
    colorCurrent,
    runtimeConfig,
    groupsSnapshot: await loadColorGroupsSnapshot(projectRoot, rootId),
  };
}

function resolveColorExecutor(
  context: IColorRootContext,
  executor?: IColorExecutor,
): IColorExecutor {
  if (executor) return executor;
  try {
    return new PythonResolveColorExecutor({
      pythonPath: context.runtimeConfig.resolveColorPythonPath,
      scriptApiRoot: context.runtimeConfig.resolveColorScriptApiRoot,
    });
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
): IColorGroupCurrent[] {
  const existingByKey = new Map((existingGroups ?? []).map(group => [group.groupKey, group]));
  return snapshot.groups.map(group => {
    const existing = existingByKey.get(group.groupKey);
    return {
      groupKey: group.groupKey,
      status: existing?.status ?? (group.clipKeys.length > 0 ? 'ready' : 'blocked'),
      displayName: existing?.displayName ?? group.displayName,
      clipCount: group.clipKeys.length,
      latestBatchId: existing?.latestBatchId,
      latestBatchStatus: existing?.latestBatchStatus,
      latestValidationStatus: existing?.latestValidationStatus,
      pendingPromoteBatchId: existing?.pendingPromoteBatchId,
      lastPromotedBatchId: existing?.lastPromotedBatchId,
      blockingReasons: dedupeStrings(existing?.blockingReasons ?? []),
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
) {
  await writeRootCurrent(projectRoot, rootId, current => ({
    ...current,
    activeStage: CCOLOR_STEP_DEFINITIONS[action][0]?.key,
    currentJobId: undefined,
    detail: blockers.join('；'),
    blockingReasons: dedupeStrings([...(current.blockingReasons ?? []), ...blockers]),
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
  return blockers.filter(blocker => !blocker.includes('resolveColorPythonPath'));
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
  if (checks.createTime === 'fail') reasons.push('create_time mismatch');
  if (checks.gps === 'fail') reasons.push('gps mismatch');
  if (checks.mediaKind === 'fail' || checks.duration === 'fail' || checks.resolution === 'fail') {
    reasons.push(`source=${context.sourcePath}`);
    reasons.push(`output=${context.outputPath}`);
  }
  return dedupeStrings(reasons);
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
