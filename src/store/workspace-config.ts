import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
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
  getScriptBriefPath,
  loadOptionalMarkdown,
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

export function getStyleSourcesConfigPath(projectRoot: string): string {
  return join(projectRoot, 'config', 'style-sources.json');
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
  if (stored) return IManualItineraryConfig.parse(stored);

  const raw = await readFile(getManualItineraryPath(projectRoot), 'utf-8').catch(() => '');
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
  const stored = await readJsonOrNull(getScriptBriefConfigPath(projectRoot), IScriptBriefConfig);
  if (stored) return IScriptBriefConfig.parse(stored);

  const markdown = await loadOptionalMarkdown(getScriptBriefPath(projectRoot));
  if (!markdown) {
    return IScriptBriefConfig.parse({
      projectName: basename(projectRoot),
      goalDraft: [],
      constraintDraft: [],
      planReviewDraft: [],
      segments: [],
    });
  }

  return parseScriptBriefMarkdown(markdown, basename(projectRoot));
}

export async function saveScriptBriefConfig(
  projectRoot: string,
  config: TScriptBriefConfig,
): Promise<TScriptBriefConfig> {
  const input = IScriptBriefConfig.parse(config);
  const normalized = IScriptBriefConfig.parse({
    ...input,
    goalDraft: normalizeDraftLines(input.goalDraft),
    constraintDraft: normalizeDraftLines(input.constraintDraft),
    planReviewDraft: normalizeDraftLines(input.planReviewDraft),
    segments: input.segments.map(segment => ({
      ...segment,
      segmentId: segment.segmentId.trim(),
      title: segment.title?.trim() || undefined,
      role: segment.role?.trim() || undefined,
      intent: segment.intent?.trim() || undefined,
      preferredClipTypes: segment.preferredClipTypes.filter(Boolean),
      preferredPlaceHints: segment.preferredPlaceHints.filter(Boolean),
      notes: segment.notes.filter(Boolean),
    })),
  });
  await writeJson(getScriptBriefConfigPath(projectRoot), normalized);
  await writeFile(
    getScriptBriefPath(projectRoot),
    buildScriptBriefTemplate({
      projectName: normalized.projectName,
      createdAt: normalized.createdAt,
      styleCategory: normalized.styleCategory,
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
  projectRoot: string,
): Promise<TStyleSourcesConfig> {
  const stored = await readJsonOrNull(getStyleSourcesConfigPath(projectRoot), IStyleSourcesConfig);
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
  projectRoot: string,
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

  await writeJson(getStyleSourcesConfigPath(projectRoot), normalized);
  await syncStyleCatalog(workspaceRoot, normalized);
  await syncStyleProfileFrontMatter(workspaceRoot, normalized);
  return normalized;
}

function normalizeDraftLines(lines: string[]): string[] {
  return lines
    .map(line => line.trim())
    .filter(Boolean);
}

function parseScriptBriefMarkdown(
  markdown: string,
  fallbackProjectName: string,
): TScriptBriefConfig {
  const normalized = markdown.replace(/\r\n/gu, '\n');
  const headerMatch = normalized.match(/^#\s+(.+?)(?:\s+—\s+Script Brief)?$/m);
  const projectName = headerMatch?.[1]?.trim() || fallbackProjectName;
  const createdAt = extractMetaLine(normalized, '创建日期');
  const styleCategory = extractMetaLine(normalized, '风格参考');
  const statusText = extractMetaLine(normalized, '当前状态');

  return IScriptBriefConfig.parse({
    projectName,
    createdAt,
    styleCategory: emptyToUndefined(styleCategory),
    statusText: emptyToUndefined(statusText),
    goalDraft: extractBulletSection(normalized, '全片目标'),
    constraintDraft: extractBulletSection(normalized, '叙事约束'),
    planReviewDraft: extractBulletSection(normalized, '段落方案审查'),
    segments: extractScriptBriefSegments(normalized),
  });
}

function extractMetaLine(markdown: string, key: string): string | undefined {
  const escapedKey = escapeRegExp(key);
  const match = markdown.match(new RegExp(`^-\\s*${escapedKey}：(.+)$`, 'm'));
  return match?.[1]?.trim();
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

function emptyToUndefined(value?: string | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
