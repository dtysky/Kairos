import {
  getProjectProgressPath,
  loadColorCurrent,
  loadIngestRoots,
  loadProjectDeviceMediaMaps,
  resolveWorkspaceProjectRoot,
  saveColorCurrent,
  writeKairosProgress,
} from '../../store/index.js';
import type { IColorCurrent, IColorRootCurrent } from '../../protocol/schema.js';
import {
  buildColorWorkspaceState,
  deriveColorGradingTimelineName,
  deriveColorResolveProjectName,
  deriveColorRootNamespace,
} from './workspace-state.js';

const CCOLOR_STEP_DEFINITIONS = [
  { key: 'sync_root_bins', label: '同步 root 镜像预备态' },
  { key: 'prepare_root_timeline', label: '准备 root timeline 预备态' },
] as const;

export interface IPrepareProjectColorRootInput {
  workspaceRoot: string;
  projectId: string;
  rootId: string;
  jobId?: string;
  progressPath?: string;
}

export interface IPrepareProjectColorRootResult {
  projectId: string;
  rootId: string;
  resolveProjectName?: string;
  rootNamespace?: string;
  gradingTimelineName?: string;
  mirrorStatus?: string;
  timelineStatus?: string;
  blockingReasons: string[];
  detail?: string;
}

export class ColorPrepBlockedError extends Error {
  constructor(public blockers: string[]) {
    super(blockers.join('; '));
    this.name = 'ColorPrepBlockedError';
  }
}

export async function prepareProjectColorRoot(
  input: IPrepareProjectColorRootInput,
): Promise<IPrepareProjectColorRootResult> {
  const projectRoot = resolveWorkspaceProjectRoot(input.workspaceRoot, input.projectId);
  const progressPath = input.progressPath ?? getProjectProgressPath(projectRoot, 'color');
  const progressBase = {
    pipelineKey: 'color',
    pipelineLabel: '达芬奇调色流程',
    phaseKey: 'root-prep',
    phaseLabel: 'Color Root Deterministic Prep',
    total: CCOLOR_STEP_DEFINITIONS.length,
    unit: 'step',
  } as const;

  const rootSummary = await loadColorRootSummary(projectRoot, input.projectId, input.rootId);
  if (!rootSummary) {
    const blockers = [`color root 不存在或未配置 rawPath: ${input.rootId}`];
    await writeColorProgress(progressPath, {
      ...progressBase,
      status: 'failed',
      step: 'sync_root_bins',
      stepIndex: 1,
      current: 0,
      detail: blockers.join('；'),
      extra: {
        projectId: input.projectId,
        rootId: input.rootId,
      },
    });
    throw new ColorPrepBlockedError(blockers);
  }

  const prepBlockers = [
    !rootSummary.rawPath ? '当前 root 未配置 rawPath，无法进入 color prep。' : '',
    !rootSummary.rawLocalPath ? '当前设备未配置 rawLocalPath，无法在本机读取原始素材。' : '',
  ].filter(Boolean);
  const persistentBlockers = rootSummary.blockingReasons.filter(
    reason => !reason.includes('rawLocalPath') && !reason.includes('rawPath'),
  );

  await writeRootCurrent(projectRoot, rootSummary.rootId, current => ({
    ...current,
    mirrorStatus: prepBlockers.length > 0 ? 'blocked' : 'running',
    timelineStatus: prepBlockers.length > 0 ? 'blocked' : 'idle',
    activeStage: 'sync_root_bins',
    currentJobId: prepBlockers.length > 0 ? undefined : input.jobId,
    detail: prepBlockers.length > 0
      ? prepBlockers.join('；')
      : 'Kairos 正在同步 root 镜像预备态；Resolve 宿主侧真同步仍待接入。',
    blockingReasons: dedupeStrings([...(current.blockingReasons ?? []), ...prepBlockers]),
  }));
  await writeColorProgress(progressPath, {
    ...progressBase,
    status: prepBlockers.length > 0 ? 'failed' : 'running',
    step: 'sync_root_bins',
    stepIndex: 1,
    current: 0,
    detail: prepBlockers.length > 0
      ? prepBlockers.join('；')
      : `正在为 ${rootSummary.rootId} 准备 root 镜像状态。`,
    extra: {
      projectId: input.projectId,
      rootId: rootSummary.rootId,
      rootLabel: rootSummary.label,
      currentPath: rootSummary.path,
      rawPath: rootSummary.rawPath,
    },
  });
  if (prepBlockers.length > 0) {
    throw new ColorPrepBlockedError(prepBlockers);
  }

  await writeRootCurrent(projectRoot, rootSummary.rootId, current => ({
    ...current,
    mirrorStatus: 'ready',
    timelineStatus: 'running',
    activeStage: 'prepare_root_timeline',
    currentJobId: input.jobId,
    detail: 'Kairos 已完成 root 镜像预备态，正在准备 timeline 预备态；Resolve 宿主侧仍未写入。',
    blockingReasons: dedupeStrings(persistentBlockers),
  }));
  await writeColorProgress(progressPath, {
    ...progressBase,
    status: 'running',
    step: 'prepare_root_timeline',
    stepIndex: 2,
    current: 1,
    detail: `正在为 ${rootSummary.rootId} 写入 timeline 预备态。`,
    extra: {
      projectId: input.projectId,
      rootId: rootSummary.rootId,
      resolveProjectName: rootSummary.resolveProjectName,
      gradingTimelineName: rootSummary.gradingTimelineName,
    },
  });

  const finalDetail = [
    'Kairos root deterministic prep 已完成。',
    '当前已持久化 mirror/timeline 状态与 live progress。',
    'root 级长期配置现在来自项目 root 注册表上的 renderPreset，而不是 color/config.json。',
    'Resolve 宿主侧 Bin / Timeline 真同步、执行、validation 和 promote 仍待接入。',
  ].join(' ');
  const savedCurrent = await writeRootCurrent(projectRoot, rootSummary.rootId, current => ({
    ...current,
    mirrorStatus: 'ready',
    timelineStatus: 'ready',
    activeStage: undefined,
    currentJobId: undefined,
    detail: finalDetail,
    blockingReasons: dedupeStrings(persistentBlockers),
  }));
  await writeColorProgress(progressPath, {
    ...progressBase,
    status: 'succeeded',
    step: 'prepare_root_timeline',
    stepIndex: 2,
    current: CCOLOR_STEP_DEFINITIONS.length,
    detail: finalDetail,
    extra: {
      projectId: input.projectId,
      rootId: rootSummary.rootId,
      blockingReasons: persistentBlockers,
    },
  });

  const savedRoot = savedCurrent.roots.find(root => root.rootId === rootSummary.rootId);
  return {
    projectId: input.projectId,
    rootId: rootSummary.rootId,
    resolveProjectName: rootSummary.resolveProjectName,
    rootNamespace: rootSummary.rootNamespace,
    gradingTimelineName: rootSummary.gradingTimelineName,
    mirrorStatus: savedRoot?.mirrorStatus,
    timelineStatus: savedRoot?.timelineStatus,
    blockingReasons: savedRoot?.blockingReasons ?? [],
    detail: savedRoot?.detail ?? finalDetail,
  };
}

async function loadColorRootSummary(projectRoot: string, projectId: string, rootId: string) {
  const [projectRoots, deviceMaps, colorCurrent] = await Promise.all([
    loadIngestRoots(projectRoot),
    loadProjectDeviceMediaMaps(projectRoot),
    loadColorCurrent(projectRoot),
  ]);
  const colorWorkspace = buildColorWorkspaceState({
    projectId,
    projectRoots: projectRoots.roots,
    deviceProjectMap: deviceMaps.projects[projectId],
    colorCurrent,
  });
  return colorWorkspace.colorRoots.find(root => root.rootId === rootId) ?? null;
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

async function writeColorProgress(
  progressPath: string,
  input: {
    pipelineKey: string;
    pipelineLabel: string;
    phaseKey: string;
    phaseLabel: string;
    status: 'running' | 'succeeded' | 'failed';
    step: string;
    stepIndex: number;
    current: number;
    detail: string;
    extra: Record<string, unknown>;
    total: number;
    unit: string;
  },
) {
  return writeKairosProgress(progressPath, {
    status: input.status,
    pipelineKey: input.pipelineKey,
    pipelineLabel: input.pipelineLabel,
    phaseKey: input.phaseKey,
    phaseLabel: input.phaseLabel,
    step: input.step,
    stepLabel: CCOLOR_STEP_DEFINITIONS[input.stepIndex - 1]?.label,
    stepIndex: input.stepIndex,
    stepTotal: CCOLOR_STEP_DEFINITIONS.length,
    stepDefinitions: CCOLOR_STEP_DEFINITIONS.map(step => ({ key: step.key, label: step.label })),
    current: input.current,
    total: input.total,
    unit: input.unit,
    detail: input.detail,
    extra: input.extra,
  });
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}
