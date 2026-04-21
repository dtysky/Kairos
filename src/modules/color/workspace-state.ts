import type {
  IColorGroupsSnapshotFile,
  IColorCurrent,
  IColorGroupCurrent,
  IColorHostPreflight,
  IColorRootCurrent,
  IColorRenderPreset,
  IDeviceMediaProjectMap,
  IMediaRoot,
} from '../../protocol/schema.js';
import type { IResolveColorBackendStatus } from './resolve-executor.js';
import { materializeColorRenderPreset } from './render-preset.js';

export interface IColorRootCurrentView extends IColorRootCurrent {
  label?: string;
  description?: string;
  path?: string;
  localPath?: string;
  currentPath?: string;
  rawPath?: string;
  rawLocalPath?: string;
  displayRawPath?: string;
  hostPreflight?: IColorHostPreflight;
}

export interface IColorRootWorkspaceSummary {
  rootId: string;
  label?: string;
  description?: string;
  path?: string;
  localPath?: string;
  currentPath?: string;
  rawPath: string;
  rawLocalPath?: string;
  displayRawPath?: string;
  resolveProjectName: string;
  rootNamespace: string;
  gradingTimelineName: string;
  renderPreset: IColorRenderPreset;
  colorSpaceProfile?: string;
  transformPresetKey?: string;
  blockingReasons: string[];
  hostPreflight?: IColorHostPreflight;
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
  projectName?: string;
  projectRoots: IMediaRoot[];
  deviceProjectMap?: IDeviceMediaProjectMap;
  colorCurrent: IColorCurrent;
  resolveBackend?: IResolveColorBackendStatus;
  groupSnapshotsByRootId?: Record<string, IColorGroupsSnapshotFile>;
}

export function buildColorWorkspaceState(
  input: IBuildColorWorkspaceStateInput,
): IColorWorkspaceState {
  const deviceRootById = new Map((input.deviceProjectMap?.roots ?? []).map(root => [root.rootId, root]));
  const colorCurrentByRootId = new Map(input.colorCurrent.roots.map(root => [root.rootId, root]));
  const hostPreflight = materializeHostPreflight(input.colorCurrent.hostPreflight, input.resolveBackend);

  const materializedRoots = input.projectRoots
    .filter(root => Boolean(trimmed(root.rawPath)))
    .map(root => {
      const storedCurrent = colorCurrentByRootId.get(root.id);
      const deviceRoot = deviceRootByRootId(deviceRootById, root.id);
      const groupsSnapshot = input.groupSnapshotsByRootId?.[root.id];
      const renderPreset = materializeRenderPreset(root.color?.renderPreset);
      const colorSpaceProfile = trimmed(root.color?.colorSpaceProfile);
      const transformPresetKey = trimmed(root.color?.transformPresetKey);
      const derivedBlockers = dedupeStrings([
        !trimmed(deviceRoot?.localPath) ? '当前设备未配置 current localPath，无法在本机覆盖当前素材目录。' : '',
        !trimmed(deviceRoot?.rawLocalPath) ? '当前设备未配置 rawLocalPath，无法在本机访问原始素材。' : '',
        typeof renderPreset.bitrateKbps !== 'number'
          ? '未配置 root 级 renderPreset.bitrateKbps（kb/s），后续 execute_root 无法启动。'
          : '',
        ...(hostPreflight?.status === 'blocked' ? hostPreflight.blockingReasons : []),
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
        pendingPromoteBatchId: storedCurrent?.pendingPromoteBatchId,
        latestBatchId: storedCurrent?.latestBatchId,
        latestBatchStatus: storedCurrent?.latestBatchStatus,
        latestValidationStatus: storedCurrent?.latestValidationStatus,
        lastPromotedBatchId: storedCurrent?.lastPromotedBatchId,
        hostSummary: isPlainObject(storedCurrent?.hostSummary) ? storedCurrent.hostSummary : {},
        groups: groups.map(group => group.current),
        blockingReasons: dedupeStrings([
          ...filterLegacyResolveRuntimeBlockers(storedCurrent?.blockingReasons ?? []),
          ...derivedBlockers,
        ]),
        label: trimmed(root.label),
        description: trimmed(root.description),
        path: trimmed(root.path),
        localPath: trimmed(deviceRoot?.localPath),
        currentPath: trimmed(deviceRoot?.localPath) ?? trimmed(root.path),
        rawPath: trimmed(root.rawPath),
        rawLocalPath: trimmed(deviceRoot?.rawLocalPath),
        displayRawPath: trimmed(deviceRoot?.rawLocalPath) ?? trimmed(root.rawPath),
        hostPreflight,
      };

      return {
        rootId: root.id,
        label: currentView.label,
        description: currentView.description,
        path: currentView.path,
        localPath: currentView.localPath,
        currentPath: currentView.currentPath,
        rawPath: currentView.rawPath ?? '',
        rawLocalPath: currentView.rawLocalPath,
        displayRawPath: currentView.displayRawPath,
        resolveProjectName: deriveColorResolveProjectName(input.projectName, input.projectId),
        rootNamespace: deriveColorRootNamespace(currentView.label, root.id),
        gradingTimelineName: deriveColorGradingTimelineName(currentView.label, root.id),
        renderPreset,
        colorSpaceProfile,
        transformPresetKey,
        blockingReasons: currentView.blockingReasons,
        hostPreflight,
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
      hostPreflight,
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
  bitrateKbps?: number;
}): IColorRenderPreset {
  return materializeColorRenderPreset({
    ...renderPreset,
    container: trimmed(renderPreset?.container),
    videoCodec: trimmed(renderPreset?.videoCodec),
    audioCodec: trimmed(renderPreset?.audioCodec),
  });
}

function materializeHostPreflight(
  hostPreflight: IColorCurrent['hostPreflight'],
  resolveBackend?: IResolveColorBackendStatus,
): IColorHostPreflight | undefined {
  const normalized = hostPreflight
    ? {
      status: hostPreflight.status ?? 'unknown',
      checkedAt: trimmed(hostPreflight.checkedAt),
      productName: trimmed(hostPreflight.productName),
      versionString: trimmed(hostPreflight.versionString),
      isStudio: hostPreflight.isStudio,
      warnings: dedupeStrings(filterLegacyResolveRuntimeBlockers(hostPreflight.warnings ?? [])),
      blockingReasons: dedupeStrings(filterLegacyResolveRuntimeBlockers(hostPreflight.blockingReasons ?? [])),
      renderSupport: hostPreflight.renderSupport,
    } satisfies IColorHostPreflight
    : undefined;
  if (normalized) return normalized;
  if (resolveBackend && !resolveBackend.available) {
    return {
      status: 'blocked',
      warnings: [],
      blockingReasons: resolveBackend.blockingReason ? [resolveBackend.blockingReason] : [],
    };
  }
  return {
    status: 'unknown',
    warnings: [],
    blockingReasons: [],
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value != null && !Array.isArray(value);
}

export function deriveColorResolveProjectName(projectName?: string, projectId?: string): string {
  const base = trimmed(projectName) ?? trimmed(projectId);
  return normalizeResolveDisplayName(
    `${base || 'Kairos Project'} [Color]`,
    'Kairos Project [Color]',
  );
}

export function deriveColorRootNamespace(rootLabel?: string, rootId?: string): string {
  const base = trimmed(rootLabel) ?? trimmed(rootId);
  return normalizeResolveDisplayName(
    `${base || 'Root'} [Color Root]`,
    'Root [Color Root]',
  );
}

export function deriveColorGradingTimelineName(rootLabel?: string, rootId?: string): string {
  const base = trimmed(rootLabel) ?? trimmed(rootId);
  return normalizeResolveDisplayName(
    `${base || 'Root'} [Color]`,
    'Root [Color]',
  );
}

function normalizeResolveDisplayName(value: string, fallback: string): string {
  const sanitized = value
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return (sanitized || fallback).slice(0, 120);
}

function filterLegacyResolveRuntimeBlockers(values: string[]): string[] {
  return values.filter(value => {
    const normalized = value.trim();
    if (!normalized) return false;
    return !(
      normalized.includes('resolveColorPythonPath')
      || normalized.includes('resolveColorScriptApiRoot')
      || normalized.includes('config/runtime.json')
    );
  });
}
