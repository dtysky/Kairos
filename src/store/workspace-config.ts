import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import {
  IColorCurrent,
  IColorTransformPresetsConfig,
  IEditRuleCategoryConfig,
  IEditRulesConfig,
  IManualCaptureTimeOverrideConfig,
  IManualItineraryConfig,
  IProjectBriefConfig,
  IScriptBriefSegmentConfig,
  IScriptBriefConfig,
  IStyleSourcesConfig,
  type IColorCurrent as TColorCurrent,
  type IColorTransformPresetsConfig as TColorTransformPresetsConfig,
  type IEditRulesConfig as TEditRulesConfig,
  type IManualCaptureTimeOverrideConfig as TManualCaptureTimeOverrideConfig,
  type IManualItineraryConfig as TManualItineraryConfig,
  type IManualItinerarySegmentConfig as TManualItinerarySegmentConfig,
  type IProjectBriefConfig as TProjectBriefConfig,
  type IScriptBriefConfig as TScriptBriefConfig,
  type IScriptBriefSegmentConfig as TScriptBriefSegmentConfig,
  type IStyleUsage as TStyleUsage,
  type IStyleSourcesConfig as TStyleSourcesConfig,
} from '../protocol/schema.js';
import { buildFrontMatter } from '../modules/script/style-loader.js';
import {
  isManualCaptureTimeResolved,
  materializeManualCaptureTimeRow,
} from '../modules/media/manual-capture-time-shared.js';
import { buildProjectBriefWithMappings, parseProjectBrief } from './project-brief.js';
import {
  loadPersistedLegacyProjectRoots,
  removeLegacyProjectRootFiles,
} from './project-root-compat.js';
import { materializeProjectBriefConfig } from './project-root-truth.js';
import {
  buildScriptBriefTemplate,
  computeScriptBriefFingerprint,
  describeScriptBriefWorkflowState,
  getScriptBriefPath,
  getLegacyScriptBriefPath,
  inferScriptBriefWorkflowState,
  loadOptionalMarkdown,
  parseScriptBriefWorkflowMetadata,
} from './script-brief.js';
import {
  clearScriptArtifactsForStyleChange,
  clearScriptExpressionArtifactsForStyleChange,
} from './script-store.js';
import { loadEditFlowPlan } from './edit-planning-store.js';
import {
  getProjectEditScriptRoot,
  shouldReadLegacyEditPath,
  normalizeEditId,
} from './edit-store.js';
import { getManualItineraryPath, loadManualItinerary } from './spatial-context.js';
import { readJsonOrNull, writeJson } from './writer.js';

const CMANUAL_CAPTURE_TIME_HEADING = '## 素材时间校正';
const CSTRUCTURED_ITINERARY_HEADING = '## 结构化行程';
const CCOMMENT_GENERATED_START = '<!-- kairos:generated-structured-itinerary:start -->';
const CCOMMENT_GENERATED_END = '<!-- kairos:generated-structured-itinerary:end -->';
const ILegacyProjectBriefMappingConfig = z.object({
  rootId: z.string().optional(),
  rootCode: z.string().optional(),
  path: z.string().optional(),
  rawPath: z.string().optional(),
  alternatePaths: z.array(z.object({
    path: z.string().optional(),
    rawPath: z.string().optional(),
  })).optional(),
  description: z.string().optional(),
  flightRecordPath: z.string().optional(),
  enabled: z.boolean().optional(),
  label: z.string().optional(),
  clockOffsetMs: z.number().int().optional(),
  priority: z.number().optional(),
  category: z.string().optional(),
  notes: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  captureTimePolicy: z.object({
    mode: z.enum(['auto', 'manual-required']).optional(),
    requiredKinds: z.array(z.enum(['video', 'photo'])).optional(),
    reason: z.string().optional(),
  }).optional(),
  color: z.object({
    renderPreset: z.object({
      container: z.string().optional(),
      videoCodec: z.string().optional(),
      audioCodec: z.string().optional(),
      bitrateKbps: z.number().positive().optional(),
    }).optional(),
    colorSpaceProfile: z.string().optional(),
    transformPresetKey: z.string().optional(),
  }).optional(),
});
const ILegacyProjectBriefConfig = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  createdAt: z.string().optional(),
  mappings: z.array(ILegacyProjectBriefMappingConfig).optional(),
  voiceoverMedia: z.object({
    rootId: z.string().optional(),
    path: z.string().optional(),
    alternatePaths: z.array(z.object({
      path: z.string().optional(),
      rawPath: z.string().optional(),
    })).optional(),
    resolveProjectAliases: z.array(z.string()).optional(),
    description: z.string().optional(),
  }).optional(),
  pharos: z.object({
    includedTripIds: z.array(z.string()).optional(),
  }).optional(),
  materialPatternPhrases: z.array(z.string()).optional(),
});

export function getProjectBriefConfigPath(projectRoot: string): string {
  return join(projectRoot, 'config', 'project-brief.json');
}

export function getManualItineraryConfigPath(projectRoot: string): string {
  return join(projectRoot, 'config', 'manual-itinerary.json');
}

export function getScriptBriefConfigPath(projectRoot: string, editId?: string | null): string {
  return join(getProjectEditScriptRoot(projectRoot, editId), 'script-brief.json');
}

export function getLegacyScriptBriefConfigPath(projectRoot: string): string {
  return join(projectRoot, 'script', 'script-brief.json');
}

export function getWorkspaceStyleSourcesConfigPath(workspaceRoot: string): string {
  return join(workspaceRoot, 'config', 'style-sources.json');
}

export function getWorkspaceEditRulesConfigPath(workspaceRoot: string): string {
  return join(workspaceRoot, 'config', 'edit-rules.json');
}

export function getWorkspaceEditRulesRoot(workspaceRoot: string): string {
  return join(workspaceRoot, 'config', 'edit-rules');
}

export function getWorkspaceColorTransformPresetsConfigPath(workspaceRoot: string): string {
  return join(workspaceRoot, 'config', 'color-transform-presets.json');
}

export function getWorkspaceResolveLutsRoot(workspaceRoot: string): string {
  return join(workspaceRoot, 'config', 'luts');
}

export function getColorCurrentPath(projectRoot: string): string {
  return join(projectRoot, 'color', 'current.json');
}

export async function loadProjectBriefConfig(projectRoot: string): Promise<TProjectBriefConfig> {
  const [stored, legacyRoots] = await Promise.all([
    readJsonOrNull(getProjectBriefConfigPath(projectRoot), ILegacyProjectBriefConfig),
    loadPersistedLegacyProjectRoots(projectRoot),
  ]);
  if (stored) {
    return IProjectBriefConfig.parse(materializeProjectBriefConfig(
      stored,
      legacyRoots.roots,
      basename(projectRoot),
    ));
  }
  const raw = await readFile(join(projectRoot, 'config', 'project-brief.md'), 'utf-8').catch(() => '');
  const parsed = parseProjectBrief(raw);
  return IProjectBriefConfig.parse(materializeProjectBriefConfig({
    name: parsed.name || basename(projectRoot),
    description: parsed.description,
    createdAt: parsed.createdAt,
    mappings: parsed.mappings,
    pharos: parsed.pharos,
    voiceoverMedia: undefined,
    materialPatternPhrases: parsed.vocabulary.materialPatternPhrases,
  }, legacyRoots.roots, basename(projectRoot)));
}

export async function saveProjectBriefConfig(
  projectRoot: string,
  config: TProjectBriefConfig,
): Promise<TProjectBriefConfig> {
  const legacyRoots = await loadPersistedLegacyProjectRoots(projectRoot);
  const normalized = IProjectBriefConfig.parse(materializeProjectBriefConfig(
    config,
    legacyRoots.roots,
    basename(projectRoot),
  ));
  await writeJson(getProjectBriefConfigPath(projectRoot), normalized);
  await writeFile(
    join(projectRoot, 'config', 'project-brief.md'),
    buildProjectBriefWithMappings(normalized),
    'utf-8',
  );
  await removeLegacyProjectRootFiles(projectRoot);
  await rm(join(projectRoot, 'config', 'device-media-maps.local.json'), { force: true });
  return normalized;
}

export async function loadManualItineraryConfig(projectRoot: string): Promise<TManualItineraryConfig> {
  const stored = await readJsonOrNull(getManualItineraryConfigPath(projectRoot), IManualItineraryConfig);
  const raw = await readFile(getManualItineraryPath(projectRoot), 'utf-8').catch(() => '');
  if (!raw) {
    if (stored) return IManualItineraryConfig.parse(stored);
    return IManualItineraryConfig.parse({
      prose: '',
      segments: [],
      captureTimeOverrides: [],
    });
  }

  const parsed = await loadManualItinerary(projectRoot);
  return IManualItineraryConfig.parse({
    prose: stripManualCaptureTimeSection(raw).trim(),
    segments: parsed.segments,
    captureTimeOverrides: parseManualCaptureOverrides(raw),
  });
}

export async function saveManualItineraryConfig(
  projectRoot: string,
  config: TManualItineraryConfig,
): Promise<TManualItineraryConfig> {
  const input = IManualItineraryConfig.parse(config);
  const normalized = IManualItineraryConfig.parse({
    prose: input.prose,
    segments: input.segments.map(segment => ({
      ...segment,
      id: segment.id || randomUUID(),
      via: segment.via?.filter(Boolean),
    })),
    captureTimeOverrides: input.captureTimeOverrides.map(override => (
      materializeManualCaptureTimeRow(override)
    )),
  });

  await writeJson(getManualItineraryConfigPath(projectRoot), normalized);
  await writeFile(
    getManualItineraryPath(projectRoot),
    renderManualItineraryMarkdown(normalized),
    'utf-8',
  );
  return normalized;
}

export async function loadScriptBriefConfig(
  projectRoot: string,
  editId?: string | null,
): Promise<TScriptBriefConfig> {
  const normalizedEditId = normalizeEditId(editId);
  const stored = await readRawScriptBriefConfig(projectRoot, normalizedEditId);
  if (stored) {
    return normalizeScriptBriefConfigData({ ...stored, editId: stored.editId ?? normalizedEditId }, basename(projectRoot));
  }

  const markdown = await loadOptionalMarkdown(getScriptBriefPath(projectRoot, normalizedEditId))
    || (shouldReadLegacyEditPath(normalizedEditId)
      ? await loadOptionalMarkdown(getLegacyScriptBriefPath(projectRoot))
      : undefined);
  if (!markdown) {
    return buildDefaultScriptBriefConfig(basename(projectRoot), normalizedEditId);
  }

  return parseScriptBriefMarkdown(markdown, basename(projectRoot), normalizedEditId);
}

export async function saveScriptBriefConfig(
  projectRoot: string,
  config: TScriptBriefConfig,
  editId?: string | null,
): Promise<TScriptBriefConfig> {
  const normalizedEditId = normalizeEditId(editId ?? config.editId);
  const previous = await loadScriptBriefConfig(projectRoot, normalizedEditId).catch(
    () => buildDefaultScriptBriefConfig(basename(projectRoot), normalizedEditId),
  );
  const input = normalizeScriptBriefConfigData({
    ...config,
    editId: normalizedEditId,
  }, basename(projectRoot));
  const normalized = applyScriptBriefPersistenceRules(input, previous);
  const editRuleReferenceLabel = await resolveScriptEditRuleReferenceLabel(
    projectRoot,
    normalized.editRuleCategory,
  );
  const styleReferenceLabel = await resolveScriptStyleReferenceLabel(
    projectRoot,
    normalized.styleCategory,
  );
  await writeJson(getScriptBriefConfigPath(projectRoot, normalizedEditId), normalized);
  await writeFile(
    getScriptBriefPath(projectRoot, normalizedEditId),
    buildScriptBriefTemplate({
      projectName: normalized.projectName,
      createdAt: normalized.createdAt,
      editId: normalized.editId,
      editLabel: normalized.editLabel,
      editRuleCategory: normalized.editRuleCategory,
      styleCategory: normalized.styleCategory,
      workflowState: normalized.workflowState,
      lastAgentDraftAt: normalized.lastAgentDraftAt,
      lastUserReviewAt: normalized.lastUserReviewAt,
      lastAgentDraftFingerprint: normalized.lastAgentDraftFingerprint,
      briefOverwriteApprovedAt: normalized.briefOverwriteApprovedAt,
      editRuleReferenceLabel,
      styleReferenceLabel,
      statusText: normalized.statusText,
      goalDraft: normalized.goalDraft,
      constraintDraft: normalized.constraintDraft,
      planReviewDraft: normalized.planReviewDraft,
      segments: normalized.segments,
    }),
    'utf-8',
  );
  if (normalized.editRuleCategory !== previous.editRuleCategory) {
    await clearScriptArtifactsForStyleChange(projectRoot, normalizedEditId);
  } else if (normalized.styleCategory !== previous.styleCategory) {
    const flowPlan = await loadEditFlowPlan(projectRoot, normalizedEditId).catch(() => null);
    if (flowPlan?.styleUsage && styleUsageAffectsPlanning(flowPlan.styleUsage)) {
      await clearScriptArtifactsForStyleChange(projectRoot, normalizedEditId);
    } else {
      await clearScriptExpressionArtifactsForStyleChange(projectRoot, normalizedEditId);
    }
  }
  return normalized;
}

export async function loadStyleSourcesConfig(
  workspaceRoot: string,
): Promise<TStyleSourcesConfig> {
  const configPath = getWorkspaceStyleSourcesConfigPath(workspaceRoot);
  const stored = await readJsonOrNull(configPath, IStyleSourcesConfig);
  if (stored) {
    return IStyleSourcesConfig.parse(stored);
  }
  throw new Error(`workspace style-sources.json is required: ${configPath}`);
}

export async function loadEditRulesConfig(
  workspaceRoot: string,
): Promise<TEditRulesConfig> {
  const categories = await discoverWorkspaceEditRuleCategories(workspaceRoot);
  return IEditRulesConfig.parse({
    defaultCategory: categories[0]?.categoryId,
    categories,
  });
}

export async function saveEditRulesConfig(
  workspaceRoot: string,
  config: TEditRulesConfig,
): Promise<TEditRulesConfig> {
  await mkdir(getWorkspaceEditRulesRoot(workspaceRoot), { recursive: true });
  const input = IEditRulesConfig.parse(config);
  const discovered = await loadEditRulesConfig(workspaceRoot);
  const defaultCategory = input.defaultCategory?.trim();
  if (!defaultCategory || discovered.categories.some(category => category.categoryId === defaultCategory)) {
    return IEditRulesConfig.parse({
      ...discovered,
      defaultCategory: defaultCategory || discovered.defaultCategory,
    });
  }
  return discovered;
}

async function discoverWorkspaceEditRuleCategories(
  workspaceRoot: string,
): Promise<TEditRulesConfig['categories']> {
  const root = getWorkspaceEditRulesRoot(workspaceRoot);
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const categories = await Promise.all(entries
    .filter(entry => entry.isFile())
    .map(entry => entry.name)
    .filter(fileName => fileName.endsWith('.md') && !fileName.endsWith('.bak.md') && !fileName.startsWith('.'))
    .sort((left, right) => left.localeCompare(right))
    .map(async fileName => {
      const profilePath = fileName;
      const absolutePath = join(root, fileName);
      const markdown = await readFile(absolutePath, 'utf-8').catch(() => '');
      const { frontMatter } = splitFrontMatter(markdown);
      const categoryId = normalizeEditRuleCategoryId(
        frontMatter.category || frontMatter.categoryId || fileName.slice(0, -extname(fileName).length),
      );
      const displayName = (frontMatter.name || frontMatter.title || categoryId).trim();
      const contentHash = createHash('sha256').update(markdown).digest('hex');
      return IEditRuleCategoryConfig.parse({
        categoryId,
        displayName,
        description: frontMatter.description?.trim() || undefined,
        profilePath,
        rulePath: profilePath,
        contentHash,
        notes: [],
      });
    }));
  return categories.filter(category => Boolean(category.categoryId));
}

function normalizeEditRuleCategoryId(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gu, '-')
    .replace(/-+/gu, '-')
    .replace(/^-|-$/gu, '');
  return normalized || 'edit-rule';
}

export async function loadColorTransformPresetsConfig(
  workspaceRoot: string,
): Promise<TColorTransformPresetsConfig> {
  const configPath = getWorkspaceColorTransformPresetsConfigPath(workspaceRoot);
  const stored = await readJsonOrNull(configPath, IColorTransformPresetsConfig);
  const discoveredPresets = await discoverWorkspaceColorTransformPresets(workspaceRoot);
  return IColorTransformPresetsConfig.parse({
    profiles: Object.fromEntries(
      Object.entries(stored?.profiles ?? {})
        .map(([profile, routes]) => {
          const normalizedProfile = normalizeColorSpaceProfileKey(profile);
          const normalizedRoutes = normalizeTransformProfileRoutes(routes);
          if (!normalizedProfile || !normalizedRoutes || Object.keys(normalizedRoutes).length === 0) {
            return null;
          }
          return [normalizedProfile, normalizedRoutes] as const;
        })
        .filter((entry): entry is readonly [string, Record<string, string>] => Boolean(entry)),
    ),
    discoveredPresets,
  });
}

export async function saveColorTransformPresetsConfig(
  workspaceRoot: string,
  config: TColorTransformPresetsConfig,
): Promise<TColorTransformPresetsConfig> {
  const normalized = await loadColorTransformPresetsConfigFromInput(config);
  await mkdir(dirname(getWorkspaceColorTransformPresetsConfigPath(workspaceRoot)), { recursive: true });
  await mkdir(getWorkspaceResolveLutsRoot(workspaceRoot), { recursive: true });
  await writeJson(getWorkspaceColorTransformPresetsConfigPath(workspaceRoot), {
    profiles: normalized.profiles,
  });
  return loadColorTransformPresetsConfig(workspaceRoot);
}

function styleUsageAffectsPlanning(styleUsage: TStyleUsage): boolean {
  return styleUsage.layers.artistic.mode !== 'off'
    || styleUsage.layers.editingTechnical.mode !== 'off';
}

export async function saveStyleSourcesConfig(
  workspaceRoot: string,
  config: TStyleSourcesConfig,
): Promise<TStyleSourcesConfig> {
  const input = IStyleSourcesConfig.parse(config);
  const normalized = IStyleSourcesConfig.parse({
    defaultCategory: input.defaultCategory?.trim() || undefined,
    categories: input.categories.map(category => ({
      ...category,
      categoryId: category.categoryId.trim(),
      displayName: category.displayName.trim(),
      guidancePrompt: category.guidancePrompt?.trim() || undefined,
      inclusionNotes: category.inclusionNotes?.trim() || undefined,
      exclusionNotes: category.exclusionNotes?.trim() || undefined,
      profilePath: category.profilePath?.trim() || `${category.categoryId.trim()}.md`,
      sources: category.sources.map(source => ({
        ...source,
        id: source.id || randomUUID(),
        path: source.path.trim(),
        rangeStart: source.rangeStart?.trim() || undefined,
        rangeEnd: source.rangeEnd?.trim() || undefined,
        note: source.note?.trim() || undefined,
        includeNotes: source.includeNotes?.trim() || undefined,
        excludeNotes: source.excludeNotes?.trim() || undefined,
      })),
    })),
  });

  await writeJson(getWorkspaceStyleSourcesConfigPath(workspaceRoot), normalized);
  await syncStyleProfileFrontMatter(workspaceRoot, normalized);
  await removeStaleStyleCatalog(workspaceRoot);
  return normalized;
}

async function loadColorTransformPresetsConfigFromInput(
  config: TColorTransformPresetsConfig,
): Promise<TColorTransformPresetsConfig> {
  return IColorTransformPresetsConfig.parse({
    profiles: Object.fromEntries(
      Object.entries(config?.profiles ?? {})
        .map(([profile, routes]) => {
          const normalizedProfile = normalizeColorSpaceProfileKey(profile);
          const normalizedRoutes = normalizeTransformProfileRoutes(routes);
          if (!normalizedProfile || !normalizedRoutes || Object.keys(normalizedRoutes).length === 0) {
            return null;
          }
          return [normalizedProfile, normalizedRoutes] as const;
        })
        .filter((entry): entry is readonly [string, Record<string, string>] => Boolean(entry)),
    ),
    discoveredPresets: {},
  });
}

async function discoverWorkspaceColorTransformPresets(
  workspaceRoot: string,
): Promise<Record<string, { kind: 'lut'; displayName: string; lutPath: string }>> {
  const lutRoot = getWorkspaceResolveLutsRoot(workspaceRoot);
  const relativeLutPaths = await listWorkspaceRelativeLutPaths(lutRoot, lutRoot);
  const catalog: Record<string, { kind: 'lut'; displayName: string; lutPath: string }> = {};
  for (const relativeLutPath of relativeLutPaths) {
    const normalizedLutPath = normalizeResolveLutPath(relativeLutPath);
    if (!normalizedLutPath || catalog[normalizedLutPath]) continue;
    catalog[normalizedLutPath] = {
      kind: 'lut',
      displayName: buildDiscoveredTransformPresetLabel(normalizedLutPath),
      lutPath: normalizedLutPath,
    };
  }
  return catalog;
}

async function listWorkspaceRelativeLutPaths(
  lutRoot: string,
  currentDir: string,
): Promise<string[]> {
  const entries = await readdir(currentDir, { withFileTypes: true }).catch(error => {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
    throw error;
  });
  const relativePaths = await Promise.all(entries.map(async entry => {
    const absolutePath = join(currentDir, entry.name);
    if (entry.isDirectory()) {
      return listWorkspaceRelativeLutPaths(lutRoot, absolutePath);
    }
    if (!entry.isFile() || extname(entry.name).toLowerCase() !== '.cube') {
      return [];
    }
    const relativePath = normalizeRelativeLutPath(relative(lutRoot, absolutePath))
      ?? normalizeRelativeLutPath(entry.name);
    return relativePath ? [relativePath] : [];
  }));
  return relativePaths.flat().sort((left, right) => left.localeCompare(right, 'en'));
}

function buildDiscoveredTransformPresetLabel(relativeLutPath: string): string {
  return relativeLutPath;
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

function normalizeColorSpaceProfileKey(value: unknown): string | undefined {
  const normalized = normalizeConfigKey(value);
  if (!normalized) return undefined;
  if (/^s-?log3$/u.test(normalized)) return 'slog3';
  if (/^d-?log$/u.test(normalized)) return 'dlog';
  if (/^d-?log-?m$/u.test(normalized)) return 'dlog-m';
  if (/^hlg$/u.test(normalized)) return 'hlg';
  if (/^rec-?709$/u.test(normalized)) return 'rec709';
  return normalized;
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

function normalizeTransformProfileRoutes(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const normalized = Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .map(([deviceKey, lutPath]) => {
        const normalizedDeviceKey = normalizeTransformDeviceKey(deviceKey);
        const normalizedLutPath = normalizeResolveLutPath(lutPath, { allowEmpty: true });
        if (!normalizedDeviceKey || typeof normalizedLutPath === 'undefined') return null;
        return [normalizedDeviceKey, normalizedLutPath] as const;
      })
      .filter((entry): entry is readonly [string, string] => Boolean(entry)),
  );
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function normalizeTransformDeviceKey(value: unknown): string | undefined {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) return undefined;
  return trimmed.toLowerCase() === 'default'
    ? 'default'
    : trimmed;
}

export async function loadColorCurrent(projectRoot: string): Promise<TColorCurrent> {
  const stored = await readJsonOrNull(getColorCurrentPath(projectRoot), IColorCurrent);
  return IColorCurrent.parse(stored ?? { roots: [] });
}

export async function saveColorCurrent(
  projectRoot: string,
  current: TColorCurrent,
): Promise<TColorCurrent> {
  const input = IColorCurrent.parse(current);
  const existing = IColorCurrent.parse(
    await readJsonOrNull(getColorCurrentPath(projectRoot), IColorCurrent) ?? { roots: [] },
  );
  const incomingRootIds = new Set(input.roots.map(root => root.rootId));
  const preservedRoots = existing.roots.filter(root => !incomingRootIds.has(root.rootId));
  const normalized = IColorCurrent.parse({
    ...existing,
    ...input,
    roots: [...input.roots, ...preservedRoots],
    updatedAt: input.updatedAt ?? new Date().toISOString(),
  });
  await writeJson(getColorCurrentPath(projectRoot), normalized);
  return normalized;
}

function normalizeDraftLines(lines: string[]): string[] {
  return lines
    .map(line => line.trim())
    .filter(Boolean);
}

function normalizeScriptBriefSegments(
  segments: Array<Partial<TScriptBriefSegmentConfig>> | undefined,
): TScriptBriefSegmentConfig[] {
  return (segments ?? []).map(segment => IScriptBriefSegmentConfig.parse({
    segmentId: stringValue(segment.segmentId) ?? `segment-${randomUUID()}`,
    title: stringValue(segment.title),
    roleHint: stringValue(segment.roleHint),
    targetDurationMs: typeof segment.targetDurationMs === 'number' && segment.targetDurationMs > 0
      ? segment.targetDurationMs
      : undefined,
    intent: stringValue(segment.intent),
    notes: normalizeDraftLines(segment.notes ?? []),
  }));
}

function buildDefaultScriptBriefConfig(projectName: string, editId = 'main'): TScriptBriefConfig {
  return IScriptBriefConfig.parse({
    projectName,
    editId: normalizeEditId(editId),
    editLabel: normalizeEditId(editId) === 'main' ? 'Main' : normalizeEditId(editId),
    workflowState: 'choose_style',
    statusText: describeScriptBriefWorkflowState('choose_style'),
    goalDraft: [],
    constraintDraft: [],
    planReviewDraft: [],
    segments: [],
  });
}

function normalizeScriptBriefConfigData(
  input: Partial<TScriptBriefConfig> | Record<string, unknown>,
  fallbackProjectName: string,
): TScriptBriefConfig {
  const projectName = stringValue(input.projectName) ?? fallbackProjectName;
  const createdAt = stringValue(input.createdAt);
  const editId = normalizeEditId(stringValue(input.editId));
  const editLabel = stringValue(input.editLabel) ?? (editId === 'main' ? 'Main' : editId);
  const editRuleCategory = stringValue(input.editRuleCategory);
  const styleCategory = stringValue(input.styleCategory);
  const lastAgentDraftAt = stringValue(input.lastAgentDraftAt);
  const lastUserReviewAt = stringValue(input.lastUserReviewAt);
  const lastAgentDraftFingerprint = stringValue(input.lastAgentDraftFingerprint);
  const briefOverwriteApprovedAt = stringValue(input.briefOverwriteApprovedAt);
  const workflowState = inferScriptBriefWorkflowState({
    workflowState: stringValue(input.workflowState),
    editRuleCategory,
    styleCategory,
    statusText: stringValue(input.statusText),
    lastAgentDraftAt,
    lastUserReviewAt,
    lastAgentDraftFingerprint,
    briefOverwriteApprovedAt,
  });

  return IScriptBriefConfig.parse({
    projectName,
    createdAt,
    editId,
    editLabel,
    editRuleCategory,
    styleCategory,
    workflowState: editRuleCategory ? workflowState : 'choose_style',
    lastAgentDraftAt,
    lastUserReviewAt,
    lastAgentDraftFingerprint,
    briefOverwriteApprovedAt,
    statusText: describeScriptBriefWorkflowState(editRuleCategory ? workflowState : 'choose_style'),
    goalDraft: normalizeDraftLines(Array.isArray(input.goalDraft) ? input.goalDraft as string[] : []),
    constraintDraft: normalizeDraftLines(Array.isArray(input.constraintDraft) ? input.constraintDraft as string[] : []),
    planReviewDraft: normalizeDraftLines(Array.isArray(input.planReviewDraft) ? input.planReviewDraft as string[] : []),
    segments: normalizeScriptBriefSegments(Array.isArray(input.segments)
      ? input.segments as Array<Partial<TScriptBriefSegmentConfig>>
      : []),
  });
}

function applyScriptBriefPersistenceRules(
  input: TScriptBriefConfig,
  previous: TScriptBriefConfig,
): TScriptBriefConfig {
  const editRuleChanged = input.editRuleCategory !== previous.editRuleCategory;
  const currentFingerprint = computeScriptBriefFingerprint(input);
  let workflowState = input.workflowState;
  let lastAgentDraftAt = input.lastAgentDraftAt ?? previous.lastAgentDraftAt;
  let lastUserReviewAt = input.lastUserReviewAt ?? previous.lastUserReviewAt;
  let lastAgentDraftFingerprint = input.lastAgentDraftFingerprint ?? previous.lastAgentDraftFingerprint;
  let briefOverwriteApprovedAt = input.briefOverwriteApprovedAt;
  let goalDraft = input.goalDraft;
  let constraintDraft = input.constraintDraft;
  let planReviewDraft = input.planReviewDraft;
  let segments = input.segments;

  if (!input.editRuleCategory) {
    return IScriptBriefConfig.parse({
      ...input,
      workflowState: 'choose_style',
      lastAgentDraftAt: undefined,
      lastUserReviewAt: undefined,
      lastAgentDraftFingerprint: undefined,
      briefOverwriteApprovedAt: undefined,
      statusText: describeScriptBriefWorkflowState('choose_style'),
    });
  }

  if (editRuleChanged) {
    workflowState = 'await_brief_draft';
    lastAgentDraftAt = undefined;
    lastUserReviewAt = undefined;
    lastAgentDraftFingerprint = undefined;
    briefOverwriteApprovedAt = undefined;
    goalDraft = [];
    constraintDraft = [];
    planReviewDraft = [];
    segments = [];
  }

  const hasAgentDraft = Boolean(lastAgentDraftAt || lastAgentDraftFingerprint);

  if (workflowState === 'review_brief') {
    lastAgentDraftAt = input.lastAgentDraftAt ?? new Date().toISOString();
    lastUserReviewAt = undefined;
    lastAgentDraftFingerprint = currentFingerprint;
    briefOverwriteApprovedAt = undefined;
  } else if (workflowState === 'ready_to_prepare') {
    if (!hasAgentDraft) {
      workflowState = 'await_brief_draft';
      lastUserReviewAt = undefined;
    } else {
      lastUserReviewAt = input.lastUserReviewAt ?? new Date().toISOString();
    }
    briefOverwriteApprovedAt = undefined;
  } else if (workflowState === 'ready_for_agent' || workflowState === 'script_generated') {
    briefOverwriteApprovedAt = undefined;
  } else if (workflowState === 'await_brief_draft') {
    if (!input.briefOverwriteApprovedAt && !editRuleChanged) {
      briefOverwriteApprovedAt = undefined;
    }
  }

  const effectiveAgentFingerprint = lastAgentDraftFingerprint;
  const userModifiedAgainstAgent = Boolean(
    effectiveAgentFingerprint && currentFingerprint !== effectiveAgentFingerprint,
  );
  if (userModifiedAgainstAgent && workflowState !== 'await_brief_draft') {
    briefOverwriteApprovedAt = undefined;
  }

  return IScriptBriefConfig.parse({
    ...input,
    goalDraft,
    constraintDraft,
    planReviewDraft,
    segments,
    workflowState,
    lastAgentDraftAt,
    lastUserReviewAt,
    lastAgentDraftFingerprint,
    briefOverwriteApprovedAt,
    statusText: describeScriptBriefWorkflowState(workflowState),
  });
}

function parseScriptBriefMarkdown(
  markdown: string,
  fallbackProjectName: string,
  fallbackEditId = 'main',
): TScriptBriefConfig {
  const normalized = markdown.replace(/\r\n/gu, '\n');
  const headerMatch = normalized.match(/^#\s+(.+?)(?:\s+—\s+Script Brief)?$/m);
  const projectName = headerMatch?.[1]?.trim() || fallbackProjectName;
  const createdAt = extractMetaLine(normalized, '创建日期');
  const editId = parseStyleReference(extractMetaLine(normalized, 'Edit ID')) ?? fallbackEditId;
  const editRuleCategory = parseStyleReference(extractMetaLine(normalized, '剪辑规则'));
  const styleCategory = parseStyleReference(
    extractMetaLine(normalized, '风格档案')
      ?? extractMetaLine(normalized, '文案风格参考')
      ?? extractMetaLine(normalized, '风格参考'),
  );
  const statusText = extractMetaLine(normalized, '当前状态');
  const workflowMetadata = parseScriptBriefWorkflowMetadata(normalized);

  return normalizeScriptBriefConfigData({
    projectName,
    createdAt,
    editId,
    editRuleCategory: emptyToUndefined(editRuleCategory),
    styleCategory: emptyToUndefined(styleCategory),
    workflowState: workflowMetadata.workflowState,
    lastAgentDraftAt: workflowMetadata.lastAgentDraftAt,
    lastUserReviewAt: workflowMetadata.lastUserReviewAt,
    lastAgentDraftFingerprint: workflowMetadata.lastAgentDraftFingerprint,
    briefOverwriteApprovedAt: workflowMetadata.briefOverwriteApprovedAt,
    statusText: emptyToUndefined(statusText),
    goalDraft: extractBulletSection(normalized, '全片目标'),
    constraintDraft: extractBulletSection(normalized, '叙事约束'),
    planReviewDraft: extractBulletSection(normalized, '段落方案审查'),
    segments: extractScriptBriefSegments(normalized),
  }, fallbackProjectName);
}

function extractMetaLine(markdown: string, key: string): string | undefined {
  const escapedKey = escapeRegExp(key);
  const match = markdown.match(new RegExp(`^-\\s*${escapedKey}：(.+)$`, 'm'));
  return match?.[1]?.trim();
}

function parseStyleReference(value?: string): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (
    trimmed === '（待指定）'
    || trimmed === '(待指定)'
    || trimmed === '待指定'
    || trimmed === '（可选）'
    || trimmed === '(可选)'
    || trimmed === '可选'
  ) {
    return undefined;
  }
  const explicitCategory = trimmed.match(/[（(]([A-Za-z0-9][A-Za-z0-9_-]*)[）)]\s*$/u);
  return explicitCategory?.[1] ?? trimmed;
}

function extractBulletSection(markdown: string, title: string): string[] {
  const block = extractHeadingBody(markdown, title);
  return block
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.startsWith('- '))
    .map(line => line.slice(2).trim());
}

function extractScriptBriefSegments(markdown: string): TScriptBriefSegmentConfig[] {
  const section = extractHeadingBody(markdown, '章节备注');
  const matches = [...section.matchAll(/^###\s+\[(.+?)\]\s*(.+)?$/gm)];
  if (matches.length === 0) return [];

  return matches.map((match, index) => {
    const segmentId = match[1]?.trim() ?? `segment-${index + 1}`;
    const title = match[2]?.trim() || undefined;
    const startIndex = match.index ?? 0;
    const nextStart = matches[index + 1]?.index ?? section.length;
    const block = section.slice(startIndex, nextStart);
    const roleHint = extractSegmentLine(block, '角色提示') ?? extractSegmentLine(block, '角色');
    const duration = extractSegmentLine(block, '目标时长');
    const intent = extractSegmentLine(block, '简单说明');
    const constraints = extractSegmentLine(block, '文案约束') ?? '';

    return IScriptBriefSegmentConfig.parse({
      segmentId,
      title,
      roleHint: emptyToUndefined(roleHint),
      targetDurationMs: parseTargetDurationMs(duration),
      intent: emptyToUndefined(intent),
      notes: splitInlineNotes(constraints),
    });
  });
}

function extractSegmentLine(block: string, key: string): string | undefined {
  const escapedKey = escapeRegExp(key);
  const match = block.match(new RegExp(`^-\\s*${escapedKey}：(.+)$`, 'm'));
  return match?.[1]?.trim();
}

function extractHeadingBody(markdown: string, headingPrefix: string): string {
  const escaped = escapeRegExp(headingPrefix);
  const match = markdown.match(new RegExp(`^##\\s+${escaped}[^\\n]*\\n([\\s\\S]*?)(?=^##\\s+|\\Z)`, 'm'));
  return match?.[1]?.trim() ?? '';
}

function parseTargetDurationMs(value?: string): number | undefined {
  if (!value) return undefined;
  const seconds = value.match(/(\d+)\s*s$/i)?.[1];
  if (seconds) return Number(seconds) * 1000;
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : undefined;
}

function splitInlineNotes(value: string): string[] {
  return value
    .split('；')
    .map(item => item.trim())
    .filter(Boolean);
}

function stripManualCaptureTimeSection(markdown: string): string {
  const withoutCapture = markdown.replace(new RegExp(`(?:^|\\n)${escapeRegExp(CMANUAL_CAPTURE_TIME_HEADING)}[\\s\\S]*$`, 'u'), '\n');
  return withoutCapture
    .replace(new RegExp(`${escapeRegExp(CCOMMENT_GENERATED_START)}[\\s\\S]*${escapeRegExp(CCOMMENT_GENERATED_END)}\\n?`, 'u'), '')
    .trim();
}

function parseManualCaptureOverrides(markdown: string): TManualCaptureTimeOverrideConfig[] {
  const sectionIndex = markdown.indexOf(CMANUAL_CAPTURE_TIME_HEADING);
  if (sectionIndex < 0) return [];

  const section = markdown.slice(sectionIndex);
  const lines = section
    .split(/\r?\n/gu)
    .map(line => line.trim())
    .filter(line => line.startsWith('|'));
  if (lines.length < 3) return [];

  return lines.slice(2).map(parseManualCaptureRow).filter((item): item is TManualCaptureTimeOverrideConfig => item != null);
}

function parseManualCaptureRow(line: string): TManualCaptureTimeOverrideConfig | null {
  const cells = line
    .split('|')
    .slice(1, -1)
    .map(value => value.trim().replace(/\\\|/gu, '|'));
  if (cells.length < 11) return null;
  if (!cells[2]) return null;
  const hasExplicitDateColumn = cells.length >= 12;

  return IManualCaptureTimeOverrideConfig.parse({
    rootRef: emptyToUndefined(cells[1]),
    sourcePath: cells[2],
    currentCapturedAt: emptyToUndefined(cells[3]),
    currentSource: emptyToUndefined(cells[4]),
    suggestedDate: emptyToUndefined(cells[5]),
    suggestedTime: emptyToUndefined(cells[6]),
    requiresExplicitDate: hasExplicitDateColumn
      ? parseBooleanCell(cells[7])
      : undefined,
    correctedDate: emptyToUndefined(cells[hasExplicitDateColumn ? 8 : 7]),
    correctedTime: emptyToUndefined(cells[hasExplicitDateColumn ? 9 : 8]),
    timezone: emptyToUndefined(cells[hasExplicitDateColumn ? 10 : 9]),
    note: emptyToUndefined(cells[hasExplicitDateColumn ? 11 : 10]),
  });
}

function renderManualItineraryMarkdown(config: TManualItineraryConfig): string {
  const sections: string[] = [];
  const prose = config.prose.trim();
  if (prose) {
    sections.push(prose);
  }

  if (config.segments.length > 0) {
    sections.push([
      CCOMMENT_GENERATED_START,
      CSTRUCTURED_ITINERARY_HEADING,
      '',
      ...config.segments.flatMap(renderManualItinerarySegmentBlock),
      CCOMMENT_GENERATED_END,
    ].join('\n'));
  }

  if (config.captureTimeOverrides.length > 0) {
    sections.push(renderManualCaptureSection(config.captureTimeOverrides));
  }

  const document = sections
    .map(section => section.trim())
    .filter(Boolean)
    .join('\n\n');
  return document ? `${document}\n` : '';
}

function renderManualItinerarySegmentBlock(segment: TManualItinerarySegmentConfig): string[] {
  const timeValue = segment.startLocalTime && segment.endLocalTime
    ? `${segment.startLocalTime} - ${segment.endLocalTime}`
    : segment.startLocalTime || segment.endLocalTime;
  return [
    `日期：${segment.date}`,
    ...(timeValue ? [`时间：${timeValue}`] : []),
    ...(segment.rootRef ? [`素材源：${segment.rootRef}`] : []),
    ...(segment.pathPrefix ? [`路径：${segment.pathPrefix}`] : []),
    ...(segment.location ? [`地点：${segment.location}`] : []),
    ...(segment.from ? [`从：${segment.from}`] : []),
    ...(segment.to ? [`到：${segment.to}`] : []),
    ...(segment.via?.length ? [`途经：${segment.via.join(' / ')}`] : []),
    ...(segment.transport ? [`交通方式：${segment.transport}`] : []),
    ...(segment.notes ? [`备注：${segment.notes}`] : []),
    '',
  ];
}

function renderManualCaptureSection(rows: TManualCaptureTimeOverrideConfig[]): string {
  const header = [
    '状态',
    '素材源',
    '路径',
    '当前时间UTC',
    '当前来源',
    '建议日期',
    '建议时间',
    '必须填日期',
    '正确日期',
    '正确时间',
    '时区',
    '备注',
  ];
  return [
    CMANUAL_CAPTURE_TIME_HEADING,
    '',
    '以下素材的拍摄时间和项目时间线明显不一致。普通行请优先填写“正确时间 / 时区”；如可推导，系统会自动补齐正确日期。标记“必须填日期”的行需要显式填写正确日期。未解决的行会阻塞后续 Analyze。',
    '',
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...rows.map(row => {
      const status = isManualCaptureTimeResolved(row) ? '已填写' : '待填写';
      const cells = [
        status,
        row.rootRef ?? '',
        row.sourcePath,
        row.currentCapturedAt ?? '',
        row.currentSource ?? '',
        row.suggestedDate ?? '',
        row.suggestedTime ?? '',
        row.requiresExplicitDate ? '是' : '',
        row.correctedDate ?? '',
        row.correctedTime ?? '',
        row.timezone ?? '',
        row.note ?? '',
      ];
      return `| ${cells.map(escapeMarkdownCell).join(' | ')} |`;
    }),
  ].join('\n');
}

async function syncStyleProfileFrontMatter(
  workspaceRoot: string,
  config: TStyleSourcesConfig,
): Promise<void> {
  const stylesDir = join(workspaceRoot, 'config', 'styles');
  await mkdir(stylesDir, { recursive: true });
  for (const category of config.categories) {
    const profilePath = join(stylesDir, category.profilePath || `${category.categoryId}.md`);
    const existing = await readFile(profilePath, 'utf-8').catch(() => null);
    if (!existing) {
      await writeFile(profilePath, [
        buildFrontMatter({
          name: category.displayName,
          category: category.categoryId,
          guidancePrompt: category.guidancePrompt,
        }),
        `# ${category.displayName}`,
        '',
        '（待运行风格分析）',
        '',
      ].join('\n'), 'utf-8');
      continue;
    }

    const { frontMatter, body } = splitFrontMatter(existing);
    const next = `${buildFrontMatter({
      ...frontMatter,
      name: category.displayName,
      category: category.categoryId,
      guidancePrompt: category.guidancePrompt,
    })}${body.trimStart()}`;
    await writeFile(profilePath, next, 'utf-8');
  }
}

async function removeStaleStyleCatalog(workspaceRoot: string): Promise<void> {
  await rm(join(workspaceRoot, 'config', 'styles', 'catalog.json'), { force: true });
}

function splitFrontMatter(markdown: string): {
  frontMatter: Record<string, string>;
  body: string;
} {
  const match = markdown.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/u);
  if (!match?.[1]) {
    return { frontMatter: {}, body: markdown };
  }

  const frontMatter: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const parts = line.match(/^(\w+)\s*:\s*(.*)$/u);
    if (!parts?.[1]) continue;
    frontMatter[parts[1]] = parts[2]?.trim() || '';
  }
  return {
    frontMatter,
    body: markdown.slice(match[0].length),
  };
}

function escapeMarkdownCell(value: string): string {
  return value.replace(/\|/gu, '\\|').trim();
}

async function readRawScriptBriefConfig(
  projectRoot: string,
  editId?: string | null,
): Promise<Record<string, unknown> | null> {
  const paths = [
    getScriptBriefConfigPath(projectRoot, editId),
    ...(shouldReadLegacyEditPath(editId) ? [getLegacyScriptBriefConfigPath(projectRoot)] : []),
  ];
  for (const configPath of paths) {
    try {
      const raw = await readFile(configPath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Try the next compatible location.
    }
  }
  return null;
}

function emptyToUndefined(value?: string | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function parseBooleanCell(value?: string | null): boolean | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  return ['1', 'true', 'yes', 'y', '是', '必填', 'required'].includes(normalized)
    ? true
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? emptyToUndefined(value) : undefined;
}

function resolveWorkspaceRootFromProjectRoot(projectRoot: string): string | undefined {
  const normalizedRoot = resolve(projectRoot);
  const parent = dirname(normalizedRoot);
  if (basename(parent) !== 'projects') {
    return undefined;
  }
  return dirname(parent);
}

async function resolveScriptStyleReferenceLabel(
  projectRoot: string,
  styleCategory?: string,
): Promise<string | undefined> {
  if (!styleCategory) {
    return undefined;
  }

  const workspaceRoot = resolveWorkspaceRootFromProjectRoot(projectRoot);
  if (!workspaceRoot) {
    return styleCategory;
  }

  const styleSources = await loadStyleSourcesConfig(workspaceRoot).catch(() => null);
  const matchedCategory = styleSources?.categories.find(
    category => category.categoryId === styleCategory,
  );
  const displayName = matchedCategory?.displayName?.trim();

  if (!displayName || displayName === styleCategory) {
    return styleCategory;
  }
  return `${displayName}（${styleCategory}）`;
}

async function resolveScriptEditRuleReferenceLabel(
  projectRoot: string,
  editRuleCategory?: string,
): Promise<string | undefined> {
  if (!editRuleCategory) {
    return undefined;
  }

  const workspaceRoot = resolveWorkspaceRootFromProjectRoot(projectRoot);
  if (!workspaceRoot) {
    return editRuleCategory;
  }

  const editRules = await loadEditRulesConfig(workspaceRoot).catch(() => null);
  const matchedCategory = editRules?.categories.find(
    category => category.categoryId === editRuleCategory,
  );
  const displayName = matchedCategory?.displayName?.trim();

  if (!displayName || displayName === editRuleCategory) {
    return editRuleCategory;
  }
  return `${displayName}（${editRuleCategory}）`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
