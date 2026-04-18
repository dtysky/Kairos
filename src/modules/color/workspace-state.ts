import type {
  IColorConfig,
  IColorCurrent,
  IColorGroupCurrent,
  IColorRootConfig,
  IColorRootCurrent,
  IDeviceMediaProjectMap,
  IMediaRoot,
} from '../../protocol/schema.js';

export interface IColorRootAnchorSummary {
  assetId: string;
  displayName: string;
  capturedAt?: string;
  sortCapturedAt?: string;
}

export interface IColorRootInventorySummary {
  rootId: string;
  assetCount: number;
  firstAnchor?: IColorRootAnchorSummary;
  lastAnchor?: IColorRootAnchorSummary;
}

export interface IColorRootConfigView extends IColorRootConfig {
  label?: string;
  description?: string;
  path?: string;
  localPath?: string;
  rawPath?: string;
  rawLocalPath?: string;
  assetCount: number;
  firstAnchor?: IColorRootAnchorSummary;
  lastAnchor?: IColorRootAnchorSummary;
  blockingReasons: string[];
}

export interface IColorRootCurrentView extends IColorRootCurrent {
  label?: string;
  description?: string;
  path?: string;
  localPath?: string;
  rawPath?: string;
  rawLocalPath?: string;
  assetCount: number;
  firstAnchor?: IColorRootAnchorSummary;
  lastAnchor?: IColorRootAnchorSummary;
}

export interface IColorRootWorkspaceSummary {
  rootId: string;
  label?: string;
  description?: string;
  path?: string;
  localPath?: string;
  rawPath: string;
  rawLocalPath?: string;
  assetCount: number;
  firstAnchor?: IColorRootAnchorSummary;
  lastAnchor?: IColorRootAnchorSummary;
  blockingReasons: string[];
  colorConfig: IColorRootConfigView;
  colorCurrent: IColorRootCurrentView;
}

export interface IColorWorkspaceState {
  colorConfig: IColorConfig & { roots: IColorRootConfigView[] };
  colorCurrent: IColorCurrent & { roots: IColorRootCurrentView[] };
  colorRoots: IColorRootWorkspaceSummary[];
}

interface IBuildColorWorkspaceStateInput {
  projectId: string;
  ingestRoots: IMediaRoot[];
  deviceProjectMap?: IDeviceMediaProjectMap;
  ingestRootSummaries?: IColorRootInventorySummary[];
  colorConfig: IColorConfig;
  colorCurrent: IColorCurrent;
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
  const colorConfigByRootId = new Map(input.colorConfig.roots.map(root => [root.rootId, root]));
  const colorCurrentByRootId = new Map(input.colorCurrent.roots.map(root => [root.rootId, root]));
  const ingestSummaryByRootId = new Map((input.ingestRootSummaries ?? []).map(root => [root.rootId, root]));

  const materializedRoots = input.ingestRoots
    .filter(root => Boolean(trimmed(root.rawPath)))
    .map(root => {
      const storedConfig = colorConfigByRootId.get(root.id);
      const storedCurrent = colorCurrentByRootId.get(root.id);
      const deviceRoot = deviceRootByRootId(deviceRootById, root.id);
      const ingestSummary = ingestSummaryByRootId.get(root.id);
      const groups = mergeGroupCurrent(storedConfig?.groups ?? [], storedCurrent?.groups ?? []);
      const derivedBlockers = dedupeStrings([
        !trimmed(deviceRoot?.localPath) ? '当前设备未配置 current localPath，无法在本机覆盖当前素材目录。' : '',
        !trimmed(deviceRoot?.rawLocalPath) ? '当前设备未配置 rawLocalPath，无法在本机访问原始素材。' : '',
        typeof storedConfig?.renderPreset?.bitrateMbps !== 'number'
          ? '未配置 root 级目标码率，当前只能查看配置与状态。'
          : '',
        storedConfig?.groups?.length
          ? ''
          : '当前还没有已确认的 Resolve Group。后续接入执行器前，需要先形成正式 Group 配置。',
      ]);

      const configView: IColorRootConfigView = {
        rootId: root.id,
        resolveProjectName: trimmed(storedConfig?.resolveProjectName) ?? `kairos__${input.projectId}`,
        rootNamespace: trimmed(storedConfig?.rootNamespace) ?? `root__${root.id}`,
        gradingTimelineName: trimmed(storedConfig?.gradingTimelineName) ?? `root__${root.id}__grading`,
        renderPreset: {
          container: trimmed(storedConfig?.renderPreset?.container) ?? CDEFAULT_RENDER_PRESET.container,
          videoCodec: trimmed(storedConfig?.renderPreset?.videoCodec) ?? CDEFAULT_RENDER_PRESET.videoCodec,
          audioCodec: trimmed(storedConfig?.renderPreset?.audioCodec) ?? CDEFAULT_RENDER_PRESET.audioCodec,
          bitrateMbps: storedConfig?.renderPreset?.bitrateMbps,
        },
        groups: storedConfig?.groups ?? [],
        updatedAt: storedConfig?.updatedAt,
        label: trimmed(root.label),
        description: trimmed(root.description),
        path: trimmed(root.path),
        localPath: trimmed(deviceRoot?.localPath),
        rawPath: trimmed(root.rawPath),
        rawLocalPath: trimmed(deviceRoot?.rawLocalPath),
        assetCount: ingestSummary?.assetCount ?? 0,
        firstAnchor: ingestSummary?.firstAnchor,
        lastAnchor: ingestSummary?.lastAnchor,
        blockingReasons: derivedBlockers,
      };

      const currentView: IColorRootCurrentView = {
        rootId: root.id,
        mirrorStatus: storedCurrent?.mirrorStatus ?? (trimmed(deviceRoot?.rawLocalPath) ? 'idle' : 'blocked'),
        timelineStatus: storedCurrent?.timelineStatus ?? (trimmed(deviceRoot?.rawLocalPath) ? 'missing' : 'blocked'),
        pendingPromoteGroupKey: storedCurrent?.pendingPromoteGroupKey,
        latestBatchId: storedCurrent?.latestBatchId,
        groups,
        blockingReasons: dedupeStrings([...(storedCurrent?.blockingReasons ?? []), ...derivedBlockers]),
        label: configView.label,
        description: configView.description,
        path: configView.path,
        localPath: configView.localPath,
        rawPath: configView.rawPath,
        rawLocalPath: configView.rawLocalPath,
        assetCount: configView.assetCount,
        firstAnchor: configView.firstAnchor,
        lastAnchor: configView.lastAnchor,
      };

      return {
        rootId: root.id,
        label: configView.label,
        description: configView.description,
        path: configView.path,
        localPath: configView.localPath,
        rawPath: configView.rawPath ?? '',
        rawLocalPath: configView.rawLocalPath,
        assetCount: configView.assetCount,
        firstAnchor: configView.firstAnchor,
        lastAnchor: configView.lastAnchor,
        blockingReasons: currentView.blockingReasons,
        colorConfig: configView,
        colorCurrent: currentView,
      } satisfies IColorRootWorkspaceSummary;
    });

  const validRootIds = new Set(materializedRoots.map(root => root.rootId));
  const selectedRootId = validRootIds.has(input.colorCurrent.selectedRootId ?? '')
    ? input.colorCurrent.selectedRootId
    : materializedRoots[0]?.rootId;

  return {
    colorConfig: {
      ...input.colorConfig,
      roots: materializedRoots.map(root => root.colorConfig),
      updatedAt: input.colorConfig.updatedAt,
    },
    colorCurrent: {
      ...input.colorCurrent,
      selectedRootId,
      roots: materializedRoots.map(root => root.colorCurrent),
      updatedAt: input.colorCurrent.updatedAt ?? input.colorConfig.updatedAt,
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

function mergeGroupCurrent(
  configuredGroups: NonNullable<IColorRootConfig['groups']>,
  currentGroups: NonNullable<IColorRootCurrent['groups']>,
): IColorGroupCurrent[] {
  const currentByKey = new Map(currentGroups.map(group => [group.groupKey, group]));
  const merged: IColorGroupCurrent[] = [];

  for (const group of configuredGroups) {
    const current = currentByKey.get(group.groupKey);
    if (current) {
      currentByKey.delete(group.groupKey);
      merged.push({
        groupKey: group.groupKey,
        status: current.status,
        latestBatchId: current.latestBatchId,
        blockingReasons: dedupeStrings(current.blockingReasons ?? []),
      });
      continue;
    }

    merged.push({
      groupKey: group.groupKey,
      status: 'ready',
      blockingReasons: [],
    });
  }

  for (const current of currentByKey.values()) {
    merged.push({
      groupKey: current.groupKey,
      status: current.status,
      latestBatchId: current.latestBatchId,
      blockingReasons: dedupeStrings(current.blockingReasons ?? []),
    });
  }

  return merged;
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
