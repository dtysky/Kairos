import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import {
  IManualCaptureTimeOverrideConfig,
  IManualItineraryConfig,
  IProjectBriefConfig,
  IScriptBriefSegmentConfig,
  IScriptBriefConfig,
  IStyleCatalog,
  IStyleSourcesConfig,
  type IManualCaptureTimeOverrideConfig as TManualCaptureTimeOverrideConfig,
  type IManualItineraryConfig as TManualItineraryConfig,
  type IManualItinerarySegmentConfig as TManualItinerarySegmentConfig,
  type IProjectBriefConfig as TProjectBriefConfig,
  type IScriptBriefConfig as TScriptBriefConfig,
  type IScriptBriefSegmentConfig as TScriptBriefSegmentConfig,
  type IStyleCatalog as TStyleCatalog,
  type IStyleCatalogEntry as TStyleCatalogEntry,
  type IStyleSourcesConfig as TStyleSourcesConfig,
} from '../protocol/schema.js';
import { buildFrontMatter, loadStyleByCategory } from '../modules/script/style-loader.js';
import { parseProjectBrief } from './project-brief.js';
import { buildProjectBriefWithMappings } from './project-brief-sync.js';
import {
  buildScriptBriefTemplate,
  computeScriptBriefFingerprint,
  describeScriptBriefWorkflowState,
  getScriptBriefPath,
  inferScriptBriefWorkflowState,
  loadOptionalMarkdown,
  parseScriptBriefWorkflowMetadata,
} from './script-brief.js';
import { getManualItineraryPath, loadManualItinerary } from './spatial-context.js';
import { readJsonOrNull, writeJson } from './writer.js';

const CMANUAL_CAPTURE_TIME_HEADING = '## 素材时间校正';
const CSTRUCTURED_ITINERARY_HEADING = '## 结构化行程';
const CCOMMENT_GENERATED_START = '<!-- kairos:generated-structured-itinerary:start -->';
const CCOMMENT_GENERATED_END = '<!-- kairos:generated-structured-itinerary:end -->';

export function getProjectBriefConfigPath(projectRoot: string): string {
  return join(projectRoot, 'config', 'project-brief.json');
}

export function getManualItineraryConfigPath(projectRoot: string): string {
  return join(projectRoot, 'config', 'manual-itinerary.json');
}

export function getScriptBriefConfigPath(projectRoot: string): string {
  return join(projectRoot, 'script', 'script-brief.json');
}

export function getWorkspaceStyleSourcesConfigPath(workspaceRoot: string): string {
  return join(workspaceRoot, 'config', 'style-sources.json');
}

export async function loadProjectBriefConfig(projectRoot: string): Promise<TProjectBriefConfig> {
  const stored = await readJsonOrNull(getProjectBriefConfigPath(projectRoot), IProjectBriefConfig);
  if (stored) return IProjectBriefConfig.parse(stored);

  const raw = await readFile(join(projectRoot, 'config', 'project-brief.md'), 'utf-8').catch(() => '');
  const parsed = parseProjectBrief(raw);
  return IProjectBriefConfig.parse({
    name: parsed.name || basename(projectRoot),
    description: parsed.description,
    createdAt: parsed.createdAt,
    mappings: parsed.mappings,
    pharos: parsed.pharos,
    materialPatternPhrases: parsed.vocabulary.materialPatternPhrases,
    localEditingIntentPhrases: parsed.vocabulary.localEditingIntentPhrases,
  });
}

export async function saveProjectBriefConfig(
  projectRoot: string,
  config: TProjectBriefConfig,
): Promise<TProjectBriefConfig> {
  const normalized = IProjectBriefConfig.parse({
    ...config,
    mappings: config.mappings.map(mapping => ({
      path: mapping.path.trim(),
      description: mapping.description.trim(),
      flightRecordPath: mapping.flightRecordPath?.trim() || undefined,
    })),
    pharos: config.pharos
      ? {
        includedTripIds: (config.pharos.includedTripIds ?? [])
          .map(tripId => tripId.trim())
          .filter(Boolean),
      }
      : undefined,
    materialPatternPhrases: (config.materialPatternPhrases ?? [])
      .map(phrase => phrase.trim())
      .filter(Boolean),
    localEditingIntentPhrases: (config.localEditingIntentPhrases ?? [])
      .map(phrase => phrase.trim())
      .filter(Boolean),
  });
  await writeJson(getProjectBriefConfigPath(projectRoot), normalized);
  await writeFile(
    join(projectRoot, 'config', 'project-brief.md'),
    buildProjectBriefWithMappings(normalized),
    'utf-8',
  );
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
    captureTimeOverrides: input.captureTimeOverrides.map(override => ({
      ...override,
      rootRef: override.rootRef?.trim() || undefined,
      sourcePath: override.sourcePath.trim(),
      currentCapturedAt: override.currentCapturedAt?.trim() || undefined,
      currentSource: override.currentSource?.trim() || undefined,
      suggestedDate: override.suggestedDate?.trim() || undefined,
      suggestedTime: override.suggestedTime?.trim() || undefined,
      correctedDate: override.correctedDate?.trim() || undefined,
      correctedTime: override.correctedTime?.trim() || undefined,
      timezone: override.timezone?.trim() || undefined,
      note: override.note?.trim() || undefined,
    })),
  });

  await writeJson(getManualItineraryConfigPath(projectRoot), normalized);
  await writeFile(
    getManualItineraryPath(projectRoot),
    renderManualItineraryMarkdown(normalized),
    'utf-8',
  );
  return normalized;
}

export async function loadScriptBriefConfig(projectRoot: string): Promise<TScriptBriefConfig> {
  const stored = await readRawScriptBriefConfig(projectRoot);
  if (stored) {
    return normalizeScriptBriefConfigData(stored, basename(projectRoot));
  }

  const markdown = await loadOptionalMarkdown(getScriptBriefPath(projectRoot));
  if (!markdown) {
    return buildDefaultScriptBriefConfig(basename(projectRoot));
  }

  return parseScriptBriefMarkdown(markdown, basename(projectRoot));
}

export async function saveScriptBriefConfig(
  projectRoot: string,
  config: TScriptBriefConfig,
): Promise<TScriptBriefConfig> {
  const previous = await loadScriptBriefConfig(projectRoot).catch(
    () => buildDefaultScriptBriefConfig(basename(projectRoot)),
  );
  const input = normalizeScriptBriefConfigData(config, basename(projectRoot));
  const normalized = applyScriptBriefPersistenceRules(input, previous);
  const styleReferenceLabel = await resolveScriptStyleReferenceLabel(
    projectRoot,
    normalized.styleCategory,
  );
  await writeJson(getScriptBriefConfigPath(projectRoot), normalized);
  await writeFile(
    getScriptBriefPath(projectRoot),
    buildScriptBriefTemplate({
      projectName: normalized.projectName,
      createdAt: normalized.createdAt,
      styleCategory: normalized.styleCategory,
      workflowState: normalized.workflowState,
      lastAgentDraftAt: normalized.lastAgentDraftAt,
      lastUserReviewAt: normalized.lastUserReviewAt,
      lastAgentDraftFingerprint: normalized.lastAgentDraftFingerprint,
      briefOverwriteApprovedAt: normalized.briefOverwriteApprovedAt,
      styleReferenceLabel,
      statusText: normalized.statusText,
      goalDraft: normalized.goalDraft,
      constraintDraft: normalized.constraintDraft,
      planReviewDraft: normalized.planReviewDraft,
      segments: normalized.segments,
    }),
    'utf-8',
  );
  return normalized;
}

export async function loadStyleSourcesConfig(
  workspaceRoot: string,
): Promise<TStyleSourcesConfig> {
  const stored = await readJsonOrNull(getWorkspaceStyleSourcesConfigPath(workspaceRoot), IStyleSourcesConfig);
  if (stored) return IStyleSourcesConfig.parse(stored);

  const stylesDir = join(workspaceRoot, 'config', 'styles');
  const catalog = await readJsonOrNull(join(stylesDir, 'catalog.json'), IStyleCatalog) ?? {
    defaultCategory: undefined,
    entries: [],
  };
  const categories = [];

  for (const entry of catalog.entries) {
    const profile = await loadStyleByCategory(stylesDir, entry.category).catch(() => null);
    categories.push({
      categoryId: entry.category,
      displayName: entry.name,
      guidancePrompt: profile?.guidancePrompt,
      inclusionNotes: undefined,
      exclusionNotes: undefined,
      overwriteExisting: false,
      profilePath: entry.profilePath,
      sources: [],
    });
  }

  return IStyleSourcesConfig.parse({
    defaultCategory: catalog.defaultCategory,
    categories,
  });
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
      profilePath: category.profilePath?.trim() || undefined,
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
  await syncStyleCatalog(workspaceRoot, normalized);
  await syncStyleProfileFrontMatter(workspaceRoot, normalized);
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
    role: stringValue(segment.role),
    targetDurationMs: typeof segment.targetDurationMs === 'number' && segment.targetDurationMs > 0
      ? segment.targetDurationMs
      : undefined,
    intent: stringValue(segment.intent),
    preferredClipTypes: normalizeDraftLines(segment.preferredClipTypes ?? []),
    preferredPlaceHints: normalizeDraftLines(segment.preferredPlaceHints ?? []),
    notes: normalizeDraftLines(segment.notes ?? []),
  }));
}

function buildDefaultScriptBriefConfig(projectName: string): TScriptBriefConfig {
  return IScriptBriefConfig.parse({
    projectName,
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
  const styleCategory = stringValue(input.styleCategory);
  const lastAgentDraftAt = stringValue(input.lastAgentDraftAt);
  const lastUserReviewAt = stringValue(input.lastUserReviewAt);
  const lastAgentDraftFingerprint = stringValue(input.lastAgentDraftFingerprint);
  const briefOverwriteApprovedAt = stringValue(input.briefOverwriteApprovedAt);
  const workflowState = inferScriptBriefWorkflowState({
    workflowState: stringValue(input.workflowState),
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
    styleCategory,
    workflowState: styleCategory ? workflowState : 'choose_style',
    lastAgentDraftAt,
    lastUserReviewAt,
    lastAgentDraftFingerprint,
    briefOverwriteApprovedAt,
    statusText: describeScriptBriefWorkflowState(styleCategory ? workflowState : 'choose_style'),
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
  const styleChanged = input.styleCategory !== previous.styleCategory;
  const currentFingerprint = computeScriptBriefFingerprint(input);
  let workflowState = input.workflowState;
  let lastAgentDraftAt = input.lastAgentDraftAt ?? previous.lastAgentDraftAt;
  let lastUserReviewAt = input.lastUserReviewAt ?? previous.lastUserReviewAt;
  let lastAgentDraftFingerprint = input.lastAgentDraftFingerprint ?? previous.lastAgentDraftFingerprint;
  let briefOverwriteApprovedAt = input.briefOverwriteApprovedAt;

  if (!input.styleCategory) {
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

  if (styleChanged) {
    workflowState = 'await_brief_draft';
    lastAgentDraftAt = undefined;
    lastUserReviewAt = undefined;
    lastAgentDraftFingerprint = undefined;
    briefOverwriteApprovedAt = undefined;
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
    if (!input.briefOverwriteApprovedAt && !styleChanged) {
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
): TScriptBriefConfig {
  const normalized = markdown.replace(/\r\n/gu, '\n');
  const headerMatch = normalized.match(/^#\s+(.+?)(?:\s+—\s+Script Brief)?$/m);
  const projectName = headerMatch?.[1]?.trim() || fallbackProjectName;
  const createdAt = extractMetaLine(normalized, '创建日期');
  const styleCategory = parseStyleReference(extractMetaLine(normalized, '风格参考'));
  const statusText = extractMetaLine(normalized, '当前状态');
  const workflowMetadata = parseScriptBriefWorkflowMetadata(normalized);

  return normalizeScriptBriefConfigData({
    projectName,
    createdAt,
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
  if (trimmed === '（待指定）' || trimmed === '(待指定)' || trimmed === '待指定') {
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
    const role = extractSegmentLine(block, '角色');
    const duration = extractSegmentLine(block, '目标时长');
    const intent = extractSegmentLine(block, '简单说明');
    const visual = extractSegmentLine(block, '画面/声音偏好') ?? '';
    const constraints = extractSegmentLine(block, '文案约束') ?? '';

    return IScriptBriefSegmentConfig.parse({
      segmentId,
      title,
      role: emptyToUndefined(role),
      targetDurationMs: parseTargetDurationMs(duration),
      intent: emptyToUndefined(intent),
      preferredClipTypes: extractVisualPreferencePart(visual, '优先'),
      preferredPlaceHints: extractVisualPreferencePart(visual, '地点线索'),
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

function extractVisualPreferencePart(value: string, prefix: string): string[] {
  const parts = value
    .split('；')
    .map(part => part.trim())
    .find(part => part.startsWith(prefix));
  if (!parts) return [];
  return parts
    .slice(prefix.length)
    .trim()
    .split('/')
    .map(item => item.trim())
    .filter(Boolean);
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

  return IManualCaptureTimeOverrideConfig.parse({
    rootRef: emptyToUndefined(cells[1]),
    sourcePath: cells[2],
    currentCapturedAt: emptyToUndefined(cells[3]),
    currentSource: emptyToUndefined(cells[4]),
    suggestedDate: emptyToUndefined(cells[5]),
    suggestedTime: emptyToUndefined(cells[6]),
    correctedDate: emptyToUndefined(cells[7]),
    correctedTime: emptyToUndefined(cells[8]),
    timezone: emptyToUndefined(cells[9]),
    note: emptyToUndefined(cells[10]),
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
    '正确日期',
    '正确时间',
    '时区',
    '备注',
  ];
  return [
    CMANUAL_CAPTURE_TIME_HEADING,
    '',
    '以下素材的拍摄时间和项目时间线明显不一致。请填写“正确日期 / 正确时间 / 时区”后重新运行 ingest；未填写的行会阻塞后续 Analyze。',
    '',
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...rows.map(row => {
      const status = row.correctedDate && row.correctedTime ? '已填写' : '待填写';
      const cells = [
        status,
        row.rootRef ?? '',
        row.sourcePath,
        row.currentCapturedAt ?? '',
        row.currentSource ?? '',
        row.suggestedDate ?? '',
        row.suggestedTime ?? '',
        row.correctedDate ?? '',
        row.correctedTime ?? '',
        row.timezone ?? '',
        row.note ?? '',
      ];
      return `| ${cells.map(escapeMarkdownCell).join(' | ')} |`;
    }),
  ].join('\n');
}

async function syncStyleCatalog(
  workspaceRoot: string,
  config: TStyleSourcesConfig,
): Promise<void> {
  const catalogPath = join(workspaceRoot, 'config', 'styles', 'catalog.json');
  const existing = await readJsonOrNull(catalogPath, IStyleCatalog) ?? {
    defaultCategory: undefined,
    entries: [],
  };
  const byCategory = new Map(existing.entries.map(entry => [entry.category, entry]));
  const now = new Date().toISOString();
  const nextEntries: TStyleCatalogEntry[] = [];

  for (const category of config.categories) {
    const current = byCategory.get(category.categoryId);
    nextEntries.push({
      id: current?.id ?? randomUUID(),
      category: category.categoryId,
      name: category.displayName,
      description: category.inclusionNotes ?? current?.description,
      profilePath: category.profilePath || current?.profilePath || `${category.categoryId}.md`,
      sourceVideoCount: category.sources.length,
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
    });
    byCategory.delete(category.categoryId);
  }

  nextEntries.push(...byCategory.values());
  await writeJson(catalogPath, {
    defaultCategory: config.defaultCategory ?? existing.defaultCategory,
    entries: nextEntries.sort((left, right) => left.category.localeCompare(right.category)),
  });
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
): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readFile(getScriptBriefConfigPath(projectRoot), 'utf-8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object'
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function emptyToUndefined(value?: string | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
