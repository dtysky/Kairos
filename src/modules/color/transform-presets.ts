import { constants as fsConstants } from 'node:fs';
import { access, copyFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type {
  EColorSourceProfile,
  IColorTransformPresetsConfig,
} from '../../protocol/schema.js';
import { getWorkspaceResolveLutsRoot } from '../../store/workspace-config.js';

export type TColorProfileSource = 'detected' | 'root-fallback' | 'unknown';

export interface IColorClipTransformSeed {
  rawRelativePath: string;
  detectedProfile?: EColorSourceProfile;
  effectiveProfile?: string;
  profileSource: TColorProfileSource;
  logProfile?: EColorSourceProfile;
  deviceFamilyKeys?: string[];
  resolvedTransformPresetKey?: string;
  resolvedLutRelativePath?: string;
  resolvedLutAbsolutePath?: string;
}

export interface IColorClipTransformResolution extends IColorClipTransformSeed {
  warnings: string[];
}

export interface IResolveLutSyncSummary {
  status: 'not-needed' | 'ready' | 'copied';
  targetRoot: string;
  copiedCount: number;
  reusedCount: number;
  copiedLuts: string[];
  reusedLuts: string[];
}

export function normalizeColorSpaceProfileKey(value: unknown): string | undefined {
  const normalized = normalizeConfigKey(value);
  if (!normalized) return undefined;
  if (/^s-?log3$/u.test(normalized)) return 'slog3';
  if (/^d-?log$/u.test(normalized)) return 'dlog';
  if (/^d-?log-?m$/u.test(normalized)) return 'dlog-m';
  if (/^hlg$/u.test(normalized)) return 'hlg';
  if (/^rec-?709$/u.test(normalized)) return 'rec709';
  return normalized;
}

export function canonicalizeKnownColorSourceProfile(value: unknown): EColorSourceProfile | undefined {
  const normalized = normalizeColorSpaceProfileKey(value);
  if (normalized === 'slog3' || normalized === 'dlog' || normalized === 'dlog-m' || normalized === 'hlg' || normalized === 'rec709') {
    return normalized;
  }
  return undefined;
}

export function resolveEffectiveColorProfile(
  detectedProfile: EColorSourceProfile | undefined,
  rootColorSpaceProfile: string | undefined,
): {
  detectedProfile?: EColorSourceProfile;
  effectiveProfile?: string;
  profileSource: TColorProfileSource;
  logProfile?: EColorSourceProfile;
} {
  if (detectedProfile) {
    return {
      detectedProfile,
      effectiveProfile: detectedProfile,
      profileSource: 'detected',
      logProfile: detectedProfile,
    };
  }
  const fallback = normalizeColorSpaceProfileKey(rootColorSpaceProfile);
  const fallbackKnown = canonicalizeKnownColorSourceProfile(fallback);
  if (fallback) {
    return {
      effectiveProfile: fallback,
      profileSource: 'root-fallback',
      logProfile: fallbackKnown,
    };
  }
  return {
    profileSource: 'unknown',
  };
}

export function resolveClipTransformSeeds(
  clips: Array<{
    rawRelativePath: string;
    detectedProfile?: EColorSourceProfile;
    effectiveProfile?: string;
    profileSource: TColorProfileSource;
    logProfile?: EColorSourceProfile;
    deviceFamilyKeys?: string[];
  }>,
  config: IColorTransformPresetsConfig,
  rootTransformPresetKey?: string,
  resolveLutRoot = detectResolveDefaultLutRoot(),
): {
  clips: IColorClipTransformResolution[];
  blockers: string[];
  warnings: string[];
  referencedRelativeLutPaths: string[];
  resolveLutRoot: string;
} {
  const normalizedOverride = normalizeResolveLutPath(rootTransformPresetKey);
  const overrideInvalid = typeof rootTransformPresetKey === 'string'
    && rootTransformPresetKey.trim()
    && !normalizedOverride;
  const clipsWithResolution = clips.map(clip => resolveClipTransformSeed(
    clip,
    config,
    normalizedOverride,
    overrideInvalid ? rootTransformPresetKey.trim() : undefined,
    resolveLutRoot,
  ));
  const blockers = dedupeStrings(clipsWithResolution.flatMap(item => item.warnings.filter(message => message.startsWith('BLOCKER:')).map(message => message.slice(8).trim())));
  const warnings = dedupeStrings(clipsWithResolution.flatMap(item => item.warnings.filter(message => !message.startsWith('BLOCKER:'))));
  return {
    clips: clipsWithResolution.map(item => ({
      ...item,
      warnings: item.warnings.filter(message => !message.startsWith('BLOCKER:')),
    })),
    blockers,
    warnings,
    referencedRelativeLutPaths: dedupeStrings(
      clipsWithResolution
        .map(item => item.resolvedLutRelativePath)
        .filter((value): value is string => Boolean(value)),
    ),
    resolveLutRoot,
  };
}

function resolveClipTransformSeed(
  clip: {
    rawRelativePath: string;
    detectedProfile?: EColorSourceProfile;
    effectiveProfile?: string;
    profileSource: TColorProfileSource;
    logProfile?: EColorSourceProfile;
    deviceFamilyKeys?: string[];
  },
  config: IColorTransformPresetsConfig,
  normalizedOverride: string | undefined,
  invalidOverrideValue: string | undefined,
  resolveLutRoot: string,
): IColorClipTransformResolution {
  const warnings: string[] = [];
  const base: IColorClipTransformResolution = {
    rawRelativePath: clip.rawRelativePath,
    detectedProfile: clip.detectedProfile,
    effectiveProfile: normalizeColorSpaceProfileKey(clip.effectiveProfile),
    profileSource: clip.profileSource,
    logProfile: clip.logProfile,
    deviceFamilyKeys: dedupeStrings(clip.deviceFamilyKeys ?? []),
    warnings,
  };
  if (invalidOverrideValue) {
    warnings.push(`BLOCKER: 当前 root 显式配置的 transformPresetKey 非法：${invalidOverrideValue}`);
    return base;
  }
  if (normalizedOverride) {
    return applyResolvedLutPath(base, normalizedOverride, resolveLutRoot);
  }
  const effectiveProfile = normalizeColorSpaceProfileKey(clip.effectiveProfile);
  if (!effectiveProfile) {
    return base;
  }
  const mappedLutPath = resolveMappedLutPath(
    config.profiles?.[effectiveProfile],
    base.deviceFamilyKeys ?? [],
  );
  if (!mappedLutPath) {
    return base;
  }
  return applyResolvedLutPath(base, mappedLutPath, resolveLutRoot);
}

function resolveMappedLutPath(
  routes: Record<string, string> | undefined,
  deviceFamilyKeys: string[],
): string | undefined {
  if (!routes || typeof routes !== 'object') return undefined;
  const normalizedRouteEntries = Object.entries(routes)
    .map(([deviceKey, lutPath]) => {
      const normalizedDeviceKey = normalizeDeviceLookupKey(deviceKey);
      const normalizedLutPath = normalizeResolveLutPath(lutPath, { allowEmpty: true });
      if (!normalizedDeviceKey || typeof normalizedLutPath === 'undefined') return null;
      return {
        normalizedDeviceKey,
        lutPath: normalizedLutPath,
      };
    })
    .filter((entry): entry is {
      normalizedDeviceKey: string;
      lutPath: string;
    } => Boolean(entry));
  if (normalizedRouteEntries.length === 0) return undefined;

  const deviceLookupKeys = dedupeStrings(
    deviceFamilyKeys
      .map(item => normalizeDeviceLookupKey(item))
      .filter((item): item is string => Boolean(item)),
  );
  for (const deviceLookupKey of deviceLookupKeys) {
    const matched = normalizedRouteEntries.find(entry => entry.normalizedDeviceKey === deviceLookupKey);
    if (!matched) continue;
    return matched.lutPath || undefined;
  }
  const defaultRoute = normalizedRouteEntries.find(entry => entry.normalizedDeviceKey === 'default');
  return defaultRoute?.lutPath || undefined;
}

function applyResolvedLutPath(
  clip: IColorClipTransformResolution,
  relativeLutPath: string,
  resolveLutRoot: string,
): IColorClipTransformResolution {
  const normalizedLutPath = normalizeResolveLutPath(relativeLutPath);
  if (!normalizedLutPath) {
    return {
      ...clip,
      resolvedTransformPresetKey: relativeLutPath,
      warnings: dedupeStrings([
        ...clip.warnings,
        `BLOCKER: Resolve LUT 路径非法或超出允许范围：${relativeLutPath}`,
      ]),
    };
  }
  return {
    ...clip,
    resolvedTransformPresetKey: normalizedLutPath,
    resolvedLutRelativePath: normalizedLutPath,
    resolvedLutAbsolutePath: resolve(join(resolveLutRoot, normalizedLutPath)),
  };
}

export async function syncReferencedResolveLuts(input: {
  workspaceRoot: string;
  relativeLutPaths: string[];
  resolveLutRoot?: string;
}): Promise<IResolveLutSyncSummary> {
  const resolveLutRoot = input.resolveLutRoot ?? detectResolveDefaultLutRoot();
  const uniqueRelativePaths = dedupeStrings(
    input.relativeLutPaths
      .map(item => normalizeRelativeLutPath(item))
      .filter((item): item is string => Boolean(item)),
  );
  if (uniqueRelativePaths.length === 0) {
    return {
      status: 'not-needed',
      targetRoot: resolveLutRoot,
      copiedCount: 0,
      reusedCount: 0,
      copiedLuts: [],
      reusedLuts: [],
    };
  }

  const workspaceLutRoot = getWorkspaceResolveLutsRoot(input.workspaceRoot);
  const copiedLuts: string[] = [];
  const reusedLuts: string[] = [];
  for (const relativeLutPath of uniqueRelativePaths) {
    const sourceAbsolutePath = resolve(join(workspaceLutRoot, relativeLutPath));
    const sourceReadable = await access(sourceAbsolutePath, fsConstants.R_OK)
      .then(() => true)
      .catch(() => false);
    if (!sourceReadable) {
      continue;
    }
    const targetAbsolutePath = resolve(join(resolveLutRoot, relativeLutPath));
    const exists = await access(targetAbsolutePath, fsConstants.F_OK)
      .then(() => true)
      .catch(() => false);
    if (exists) {
      reusedLuts.push(relativeLutPath);
      continue;
    }
    await mkdir(dirname(targetAbsolutePath), { recursive: true });
    await copyFile(sourceAbsolutePath, targetAbsolutePath);
    copiedLuts.push(relativeLutPath);
  }
  return {
    status: copiedLuts.length > 0 ? 'copied' : 'ready',
    targetRoot: resolveLutRoot,
    copiedCount: copiedLuts.length,
    reusedCount: reusedLuts.length,
    copiedLuts,
    reusedLuts,
  };
}

export function detectResolveDefaultLutRoot(): string {
  if (process.platform === 'win32') {
    const programData = process.env.PROGRAMDATA?.trim() || 'C:\\ProgramData';
    return resolve(join(programData, 'Blackmagic Design', 'DaVinci Resolve', 'Support', 'LUT'));
  }
  if (process.platform === 'darwin') {
    return '/Library/Application Support/Blackmagic Design/DaVinci Resolve/LUT';
  }
  return '/opt/resolve/LUT';
}

function normalizeConfigKey(value: unknown): string | undefined {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) return undefined;
  const normalized = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return normalized || undefined;
}

function normalizeRelativeLutPath(value: unknown): string | undefined {
  const trimmed = typeof value === 'string' ? value.trim() : '';
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

function normalizeResolveLutPath(value: unknown, options: { allowEmpty?: boolean } = {}): string | undefined {
  const normalized = normalizeRelativeLutPath(value);
  if (!normalized) {
    return options.allowEmpty && typeof value === 'string' && value.trim() === ''
      ? ''
      : undefined;
  }
  return normalized.toLowerCase().endsWith('.cube')
    ? normalized
    : `${normalized}.cube`;
}

function normalizeDeviceLookupKey(value: unknown): string | undefined {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) return undefined;
  if (trimmed.toLowerCase() === 'default') return 'default';
  return trimmed
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value?.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}
