import { basename } from 'node:path';
import {
  EMediaRootCategory,
  type IColorRenderPreset,
  type IMediaRoot,
  type IProjectBriefConfig,
  type IProjectBriefMappingConfig,
} from '../protocol/schema.js';
import { normalizeColorRenderPreset } from '../modules/color/render-preset.js';

export type TProjectBriefMappingInput = {
  rootId?: string;
  path?: string;
  rawPath?: string;
  description?: string;
  flightRecordPath?: string;
  enabled?: boolean;
  label?: string;
  clockOffsetMs?: number;
  priority?: number;
  category?: string;
  notes?: string[];
  tags?: string[];
  color?: {
    renderPreset?: Partial<IColorRenderPreset>;
    colorSpaceProfile?: string;
    transformPresetKey?: string;
  };
};

type TProjectBriefConfigInput = {
  name?: string;
  description?: string;
  createdAt?: string;
  mappings?: TProjectBriefMappingInput[];
  pharos?: {
    includedTripIds?: string[];
  };
  materialPatternPhrases?: string[];
};

function trimString(value: unknown): string | undefined {
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed || undefined;
}

function trimStringList(values: unknown): string[] | undefined {
  if (!Array.isArray(values)) return undefined;
  const normalized = values
    .map(value => trimString(value))
    .filter((value): value is string => Boolean(value));
  return normalized.length > 0 ? [...new Set(normalized)] : undefined;
}

function normalizeCategory(value: unknown): IMediaRoot['category'] {
  const trimmed = trimString(value);
  if (!trimmed) return undefined;
  const parsed = EMediaRootCategory.safeParse(trimmed);
  return parsed.success ? parsed.data : undefined;
}

function normalizeClockOffset(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value)
    ? value
    : undefined;
}

function normalizePriority(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : fallback;
}

function normalizeRenderPreset(renderPreset?: Partial<IColorRenderPreset>) {
  return normalizeColorRenderPreset(renderPreset);
}

function normalizeConfigKey(value: unknown): string | undefined {
  const trimmed = trimString(value);
  if (!trimmed) return undefined;
  const compact = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return compact || undefined;
}

function normalizeColorSpaceProfile(value: unknown): string | undefined {
  const normalized = normalizeConfigKey(value);
  if (!normalized) return undefined;
  if (/^s-?log3$/u.test(normalized)) return 'slog3';
  if (/^d-?log$/u.test(normalized)) return 'dlog';
  if (/^d-?log-?m$/u.test(normalized)) return 'dlog-m';
  if (/^hlg$/u.test(normalized)) return 'hlg';
  if (/^rec-?709$/u.test(normalized)) return 'rec709';
  return normalized;
}

function normalizeTransformPresetKey(value: unknown): string | undefined {
  const normalized = normalizeRelativeLutPath(value);
  if (!normalized) return undefined;
  return normalized.toLowerCase().endsWith('.cube')
    ? normalized
    : `${normalized}.cube`;
}

function normalizeRelativeLutPath(value: unknown): string | undefined {
  const trimmed = trimString(value);
  if (!trimmed) return undefined;
  const normalized = trimmed
    .replace(/\s*[\\/]+\s*/g, '/')
    .replace(/^\/+/g, '')
    .replace(/\/+/g, '/');
  if (
    !normalized
    || normalized.startsWith('..')
    || normalized.includes('/../')
    || /^[a-z]:/iu.test(normalized)
    || normalized.includes('://')
  ) {
    return undefined;
  }
  return normalized;
}

export function buildProjectBriefRootId(path: string, pathOccurrences: Map<string, number>): string {
  const normalized = path
    .toLowerCase()
    .replace(/^[a-z]:/, '')
    .replace(/[\\/]+/g, '-')
    .replace(/[^a-z0-9\u4e00-\u9fa5-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(-48);
  if (!normalized) {
    const next = (pathOccurrences.get('__fallback__') ?? 0) + 1;
    pathOccurrences.set('__fallback__', next);
    return `root-${String(next).padStart(2, '0')}`;
  }

  const count = (pathOccurrences.get(normalized) ?? 0) + 1;
  pathOccurrences.set(normalized, count);
  return count === 1 ? `root-${normalized}` : `root-${normalized}-${count}`;
}

export function deriveProjectBriefRootLabel(path: string, index: number): string {
  const segments = path.split(/[\\/]+/).filter(Boolean);
  const tail = segments.slice(-2).join('/');
  return tail || basename(path) || `素材目录 ${index + 1}`;
}

function normalizeComparablePath(path: string): string {
  return path.trim().replace(/\\/g, '/').toLowerCase();
}

function buildMappingFromInput(
  mapping: TProjectBriefMappingInput,
  index: number,
  pathOccurrences: Map<string, number>,
  legacyRoots: IMediaRoot[],
  consumedLegacyRootIds: Set<string>,
): IProjectBriefMappingConfig | null {
  const path = trimString(mapping.path);
  const rawPath = trimString(mapping.rawPath);
  const description = trimString(mapping.description);
  const flightRecordPath = trimString(mapping.flightRecordPath);
  if (!path) {
    if (!rawPath && !description && !flightRecordPath) {
      return null;
    }
    return null;
  }

  const derivedRootId = buildProjectBriefRootId(path, pathOccurrences);
  const explicitRootId = trimString(mapping.rootId);
  let legacyRoot = explicitRootId
    ? legacyRoots.find(root => root.id === explicitRootId)
    : undefined;
  if (!legacyRoot) {
    const comparablePath = normalizeComparablePath(path);
    legacyRoot = legacyRoots.find(root =>
      !consumedLegacyRootIds.has(root.id)
      && normalizeComparablePath(root.path ?? '') === comparablePath,
    );
  }
  if (legacyRoot) {
    consumedLegacyRootIds.add(legacyRoot.id);
  }

  const renderPreset = normalizeRenderPreset(mapping.color?.renderPreset ?? legacyRoot?.color?.renderPreset);
  const colorSpaceProfile = normalizeColorSpaceProfile(mapping.color?.colorSpaceProfile ?? legacyRoot?.color?.colorSpaceProfile);
  const transformPresetKey = normalizeTransformPresetKey(mapping.color?.transformPresetKey ?? legacyRoot?.color?.transformPresetKey);
  const notes = trimStringList(mapping.notes) ?? trimStringList(legacyRoot?.notes) ?? (description ? [description] : undefined);
  const tags = trimStringList(mapping.tags) ?? trimStringList(legacyRoot?.tags);
  const priority = normalizePriority(mapping.priority, legacyRoot?.priority ?? (index + 1));
  const label = trimString(mapping.label) ?? trimString(legacyRoot?.label) ?? deriveProjectBriefRootLabel(path, index);

  return {
    rootId: explicitRootId ?? legacyRoot?.id ?? derivedRootId,
    path,
    rawPath: rawPath ?? trimString(legacyRoot?.rawPath),
    description: description ?? trimString(legacyRoot?.description) ?? '（待补充说明）',
    flightRecordPath,
    enabled: typeof mapping.enabled === 'boolean' ? mapping.enabled : legacyRoot?.enabled ?? true,
    label,
    clockOffsetMs: normalizeClockOffset(mapping.clockOffsetMs) ?? legacyRoot?.clockOffsetMs,
    priority,
    category: normalizeCategory(mapping.category) ?? legacyRoot?.category,
    notes,
    tags,
    color: renderPreset || colorSpaceProfile || transformPresetKey
      ? {
        ...(renderPreset ? { renderPreset } : {}),
        ...(colorSpaceProfile ? { colorSpaceProfile } : {}),
        ...(transformPresetKey ? { transformPresetKey } : {}),
      }
      : undefined,
  };
}

export function materializeProjectBriefConfig(
  input: TProjectBriefConfigInput,
  legacyRoots: IMediaRoot[] = [],
  defaultName = 'Untitled Project',
): IProjectBriefConfig {
  const pathOccurrences = new Map<string, number>();
  const consumedLegacyRootIds = new Set<string>();
  const mappings = (Array.isArray(input.mappings) ? input.mappings : [])
    .map((mapping, index) => buildMappingFromInput(
      mapping,
      index,
      pathOccurrences,
      legacyRoots,
      consumedLegacyRootIds,
    ))
    .filter((mapping): mapping is IProjectBriefMappingConfig => Boolean(mapping));

  const includedTripIds = trimStringList(input.pharos?.includedTripIds);
  return {
    name: trimString(input.name) ?? defaultName,
    description: trimString(input.description),
    createdAt: trimString(input.createdAt),
    mappings,
    pharos: includedTripIds?.length ? { includedTripIds } : undefined,
    materialPatternPhrases: trimStringList(input.materialPatternPhrases) ?? [],
  };
}

export function projectBriefToMediaRoots(config: Pick<IProjectBriefConfig, 'mappings'>): IMediaRoot[] {
  return (config.mappings ?? []).map((mapping, index) => ({
    id: mapping.rootId,
    path: trimString(mapping.path),
    rawPath: trimString(mapping.rawPath),
    label: trimString(mapping.label) ?? deriveProjectBriefRootLabel(mapping.path, index),
    enabled: typeof mapping.enabled === 'boolean' ? mapping.enabled : true,
    clockOffsetMs: normalizeClockOffset(mapping.clockOffsetMs),
    category: normalizeCategory(mapping.category),
    priority: normalizePriority(mapping.priority, index + 1),
    description: trimString(mapping.description),
    notes: trimStringList(mapping.notes) ?? (trimString(mapping.description) ? [trimString(mapping.description)!] : undefined),
    tags: trimStringList(mapping.tags),
    color: (() => {
      const renderPreset = normalizeRenderPreset(mapping.color?.renderPreset);
      const colorSpaceProfile = normalizeColorSpaceProfile(mapping.color?.colorSpaceProfile);
      const transformPresetKey = normalizeTransformPresetKey(mapping.color?.transformPresetKey);
      if (!renderPreset && !colorSpaceProfile && !transformPresetKey) return undefined;
      return {
        ...(renderPreset ? { renderPreset } : {}),
        ...(colorSpaceProfile ? { colorSpaceProfile } : {}),
        ...(transformPresetKey ? { transformPresetKey } : {}),
      };
    })(),
  }));
}

export function mediaRootsToProjectBriefMappings(
  roots: IMediaRoot[],
  existingMappings: IProjectBriefConfig['mappings'] = [],
): IProjectBriefConfig['mappings'] {
  const existingByRootId = new Map(existingMappings.map(mapping => [mapping.rootId, mapping]));
  const pathOccurrences = new Map<string, number>();
  return roots.reduce<IProjectBriefConfig['mappings']>((result, root, index) => {
    const existing = existingByRootId.get(root.id);
    const path = trimString(root.path) ?? trimString(existing?.path);
    if (!path) {
      if (existing) {
        result.push(existing);
      }
      return result;
    }
    const derivedRootId = buildProjectBriefRootId(path, pathOccurrences);
    const renderPreset = normalizeRenderPreset(root.color?.renderPreset ?? existing?.color?.renderPreset);
    const colorSpaceProfile = normalizeColorSpaceProfile(root.color?.colorSpaceProfile ?? existing?.color?.colorSpaceProfile);
    const transformPresetKey = normalizeTransformPresetKey(root.color?.transformPresetKey ?? existing?.color?.transformPresetKey);
    result.push({
      rootId: trimString(root.id) ?? existing?.rootId ?? derivedRootId,
      path,
      rawPath: trimString(root.rawPath) ?? trimString(existing?.rawPath),
      description: trimString(root.description) ?? trimString(existing?.description) ?? '（待补充说明）',
      flightRecordPath: trimString(existing?.flightRecordPath),
      enabled: root.enabled ?? existing?.enabled ?? true,
      label: trimString(root.label) ?? trimString(existing?.label) ?? deriveProjectBriefRootLabel(path, index),
      clockOffsetMs: normalizeClockOffset(root.clockOffsetMs) ?? existing?.clockOffsetMs,
      priority: normalizePriority(root.priority, existing?.priority ?? (index + 1)),
      category: normalizeCategory(root.category) ?? existing?.category,
      notes: trimStringList(root.notes) ?? trimStringList(existing?.notes) ?? (trimString(root.description) ? [trimString(root.description)!] : undefined),
      tags: trimStringList(root.tags) ?? trimStringList(existing?.tags),
      color: renderPreset || colorSpaceProfile || transformPresetKey
        ? {
          ...(renderPreset ? { renderPreset } : {}),
          ...(colorSpaceProfile ? { colorSpaceProfile } : {}),
          ...(transformPresetKey ? { transformPresetKey } : {}),
        }
        : undefined,
    });
    return result;
  }, []);
}
