import type {
  IColorGroupsSnapshotFile,
  IColorCurrent,
  IColorGroupCurrent,
  IColorRootCurrent,
  IColorRenderPreset,
  IDeviceMediaProjectMap,
  IMediaRoot,
} from '../../protocol/schema.js';

export interface IColorRootCurrentView extends IColorRootCurrent {
  label?: string;
  description?: string;
  path?: string;
  localPath?: string;
  rawPath?: string;
  rawLocalPath?: string;
}

export interface IColorRootWorkspaceSummary {
  rootId: string;
  label?: string;
  description?: string;
  path?: string;
  localPath?: string;
  rawPath: string;
  rawLocalPath?: string;
  resolveProjectName: string;
  rootNamespace: string;
  gradingTimelineName: string;
  renderPreset: IColorRenderPreset;
  blockingReasons: string[];
  groupsSnapshot?: IColorGroupsSnapshotFile;
  groups: IColorGroupWorkspaceSummary[];
  colorCurrent: IColorRootCurrentView;
}

export interface IColorGroupWorkspaceSummary {
  groupKey: string;
  displayName: string;
  clipCount: number;
  clipKeys: string[];
  hostSummary: Record<string, unknown>;
  current: IColorGroupCurrent;
}

export interface IColorWorkspaceState {
  colorCurrent: IColorCurrent & { roots: IColorRootCurrentView[] };
  colorRoots: IColorRootWorkspaceSummary[];
}

interface IBuildColorWorkspaceStateInput {
  projectId: string;
  projectRoots: IMediaRoot[];
  deviceProjectMap?: IDeviceMediaProjectMap;
  colorCurrent: IColorCurrent;
  runtimeConfig?: {
    resolveColorPythonPath?: string;
  };
  groupSnapshotsByRootId?: Record<string, IColorGroupsSnapshotFile>;
}

const CDEFAULT_RENDER_PRESET = {
  container: 'mp4',
  videoCodec: 'h265',
  audioCodec: 'aac',
} as const;

export function buildColorWorkspaceState(
  input: IBuildColorWorkspaceStateInput,
): IColorWorkspaceState {
  const deviceRootById = new Map((input.deviceProjectMap?.roots ?? []).map(root => [root.rootId, root]));
  const colorCurrentByRootId = new Map(input.colorCurrent.roots.map(root => [root.rootId, root]));

  const materializedRoots = input.projectRoots
    .filter(root => Boolean(trimmed(root.rawPath)))
    .map(root => {
      const storedCurrent = colorCurrentByRootId.get(root.id);
      const deviceRoot = deviceRootByRootId(deviceRootById, root.id);
      const groupsSnapshot = input.groupSnapshotsByRootId?.[root.id];
      const renderPreset = materializeRenderPreset(root.color?.renderPreset);
      const derivedBlockers = dedupeStrings([
        !trimmed(deviceRoot?.localPath) ? '当前设备未配置 current localPath，无法在本机覆盖当前素材目录。' : '',
        !trimmed(deviceRoot?.rawLocalPath) ? '当前设备未配置 rawLocalPath，无法在本机访问原始素材。' : '',
        !trimmed(root.path) ? '当前 root 未配置 current path，无法确定正式覆盖目录。' : '',
        typeof renderPreset.bitrateMbps !== 'number'
          ? '未配置 root 级 renderPreset.bitrateMbps，后续 execute_group 无法启动。'
          : '',
        !trimmed(input.runtimeConfig?.resolveColorPythonPath)
          ? '未配置 config/runtime.json resolveColorPythonPath，无法调用 official Python Resolve host。'
          : '',
      ]);
      const groups = materializeGroupWorkspaceSummaries(
        groupsSnapshot,
        storedCurrent?.groups ?? [],
      );

      const currentView: IColorRootCurrentView = {
        rootId: root.id,
        mirrorStatus: storedCurrent?.mirrorStatus ?? (trimmed(deviceRoot?.rawLocalPath) ? 'idle' : 'blocked'),
        timelineStatus: storedCurrent?.timelineStatus ?? (trimmed(deviceRoot?.rawLocalPath) ? 'missing' : 'blocked'),
        groupSyncStatus: storedCurrent?.groupSyncStatus ?? (
          trimmed(deviceRoot?.rawLocalPath)
            ? (groupsSnapshot?.groups?.length ? 'ready' : 'missing')
            : 'blocked'
        ),
        groupSyncAt: storedCurrent?.groupSyncAt ?? groupsSnapshot?.syncedAt,
        activeStage: trimmed(storedCurrent?.activeStage),
        currentJobId: trimmed(storedCurrent?.currentJobId),
        detail: trimmed(storedCurrent?.detail),
        pendingPromoteGroupKey: storedCurrent?.pendingPromoteGroupKey,
        pendingPromoteBatchId: storedCurrent?.pendingPromoteBatchId,
        latestBatchId: storedCurrent?.latestBatchId,
        groups: groups.map(group => group.current),
        blockingReasons: dedupeStrings([...(storedCurrent?.blockingReasons ?? []), ...derivedBlockers]),
        label: trimmed(root.label),
        description: trimmed(root.description),
        path: trimmed(root.path),
        localPath: trimmed(deviceRoot?.localPath),
        rawPath: trimmed(root.rawPath),
        rawLocalPath: trimmed(deviceRoot?.rawLocalPath),
      };

      return {
        rootId: root.id,
        label: currentView.label,
        description: currentView.description,
        path: currentView.path,
        localPath: currentView.localPath,
        rawPath: currentView.rawPath ?? '',
        rawLocalPath: currentView.rawLocalPath,
        resolveProjectName: deriveColorResolveProjectName(input.projectId),
        rootNamespace: deriveColorRootNamespace(root.id),
        gradingTimelineName: deriveColorGradingTimelineName(root.id),
        renderPreset,
        blockingReasons: currentView.blockingReasons,
        groupsSnapshot,
        groups,
        colorCurrent: currentView,
      } satisfies IColorRootWorkspaceSummary;
    });

  const validRootIds = new Set(materializedRoots.map(root => root.rootId));
  const selectedRootId = validRootIds.has(input.colorCurrent.selectedRootId ?? '')
    ? input.colorCurrent.selectedRootId
    : materializedRoots[0]?.rootId;

  return {
    colorCurrent: {
      ...input.colorCurrent,
      selectedRootId,
      roots: materializedRoots.map(root => root.colorCurrent),
      updatedAt: input.colorCurrent.updatedAt,
    },
    colorRoots: materializedRoots,
  };
}

function deviceRootByRootId(
  deviceRootById: Map<string, NonNullable<IDeviceMediaProjectMap['roots']>[number]>,
  rootId: string,
) {
  return deviceRootById.get(rootId);
}

function normalizeGroupCurrent(
  currentGroups: NonNullable<IColorRootCurrent['groups']>,
): IColorGroupCurrent[] {
  return currentGroups.map(current => ({
      groupKey: current.groupKey,
      status: current.status,
      displayName: trimmed(current.displayName),
      clipCount: current.clipCount,
      latestBatchId: current.latestBatchId,
      latestBatchStatus: current.latestBatchStatus,
      latestValidationStatus: current.latestValidationStatus,
      pendingPromoteBatchId: trimmed(current.pendingPromoteBatchId),
      lastPromotedBatchId: trimmed(current.lastPromotedBatchId),
      blockingReasons: dedupeStrings(current.blockingReasons ?? []),
    }));
}

function materializeGroupWorkspaceSummaries(
  snapshot: IColorGroupsSnapshotFile | undefined,
  currentGroups: NonNullable<IColorRootCurrent['groups']>,
): IColorGroupWorkspaceSummary[] {
  const normalizedCurrent = normalizeGroupCurrent(currentGroups);
  const currentByKey = new Map(normalizedCurrent.map(group => [group.groupKey, group]));
  const snapshotGroups = snapshot?.groups ?? [];
  const materialized = snapshotGroups.map(group => {
    const current = currentByKey.get(group.groupKey) ?? {
      groupKey: group.groupKey,
      status: group.clipKeys.length > 0 ? 'ready' : 'blocked',
      displayName: trimmed(group.displayName),
      clipCount: group.clipKeys.length,
      blockingReasons: group.clipKeys.length > 0 ? [] : ['该 Group 当前没有可执行 clip。'],
    };
    return {
      groupKey: group.groupKey,
      displayName: trimmed(group.displayName) ?? group.groupKey,
      clipCount: group.clipKeys.length,
      clipKeys: dedupeStrings(group.clipKeys ?? []),
      hostSummary: isPlainObject(group.hostSummary) ? group.hostSummary : {},
      current: {
        ...current,
        displayName: trimmed(current.displayName) ?? trimmed(group.displayName) ?? group.groupKey,
        clipCount: current.clipCount ?? group.clipKeys.length,
      },
    } satisfies IColorGroupWorkspaceSummary;
  });

  for (const current of normalizedCurrent) {
    if (materialized.some(group => group.groupKey === current.groupKey)) continue;
    materialized.push({
      groupKey: current.groupKey,
      displayName: trimmed(current.displayName) ?? current.groupKey,
      clipCount: current.clipCount ?? 0,
      clipKeys: [],
      hostSummary: {},
      current: {
        ...current,
        displayName: trimmed(current.displayName) ?? current.groupKey,
        clipCount: current.clipCount ?? 0,
      },
    });
  }

  return materialized;
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = trimmed(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function trimmed(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function materializeRenderPreset(renderPreset?: {
  container?: string;
  videoCodec?: string;
  audioCodec?: string;
  bitrateMbps?: number;
}): IColorRenderPreset {
  return {
    container: trimmed(renderPreset?.container) ?? CDEFAULT_RENDER_PRESET.container,
    videoCodec: trimmed(renderPreset?.videoCodec) ?? CDEFAULT_RENDER_PRESET.videoCodec,
    audioCodec: trimmed(renderPreset?.audioCodec) ?? CDEFAULT_RENDER_PRESET.audioCodec,
    bitrateMbps: renderPreset?.bitrateMbps,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value != null && !Array.isArray(value);
}

export function deriveColorResolveProjectName(projectId: string): string {
  return `kairos__${projectId}`;
}

export function deriveColorRootNamespace(rootId: string): string {
  return `root__${rootId}`;
}

export function deriveColorGradingTimelineName(rootId: string): string {
  return `root__${rootId}__grading`;
}
