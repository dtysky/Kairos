import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  IStyleArrangementStructure,
  IStyleCatalog,
  IStyleCatalogEntry,
  IStyleNarrationConstraints,
  IStyleProfile,
  IStyleSection,
} from '../../protocol/schema.js';

export interface IStyleLoadOptions {
  name?: string;
  category?: string;
  guidancePrompt?: string;
}

export async function loadStyleFromMarkdown(
  filePath: string,
  options?: string | IStyleLoadOptions,
): Promise<IStyleProfile> {
  const raw = await readFile(filePath, 'utf-8');
  const opts: IStyleLoadOptions = typeof options === 'string'
    ? { name: options }
    : options ?? {};
  return parseStyleMarkdown(raw, opts, [filePath]);
}

export async function loadStyleByCategory(
  stylesDir: string,
  category: string,
): Promise<IStyleProfile | null> {
  const catalogPath = join(stylesDir, 'catalog.json');
  try {
    const catalogRaw = await readFile(catalogPath, 'utf-8');
    const catalog: IStyleCatalog = JSON.parse(catalogRaw);
    const entry = catalog.entries.find(item => item.category === category);
    if (!entry) return null;
    return loadStyleFromMarkdown(join(stylesDir, entry.profilePath), {
      category: entry.category,
      name: entry.name,
    });
  } catch {
    const mdPath = join(stylesDir, `${category}.md`);
    try {
      return await loadStyleFromMarkdown(mdPath, { category });
    } catch {
      return null;
    }
  }
}

export async function listStyleCategories(
  stylesDir: string,
): Promise<IStyleCatalogEntry[]> {
  const catalogPath = join(stylesDir, 'catalog.json');
  try {
    const raw = await readFile(catalogPath, 'utf-8');
    const catalog: IStyleCatalog = JSON.parse(raw);
    return catalog.entries;
  } catch {
    const files = await readdir(stylesDir).catch(() => []);
    return files
      .filter(file => file.endsWith('.md'))
      .map(file => {
        const category = file.replace(/\.md$/, '');
        return {
          id: category,
          category,
          name: category,
          profilePath: file,
          sourceVideoCount: 0,
          createdAt: '',
          updatedAt: '',
        };
      });
  }
}

export function parseStyleMarkdown(
  markdown: string,
  options?: IStyleLoadOptions,
  sourceFiles: string[] = [],
): IStyleProfile {
  const { body, frontMatter } = extractFrontMatter(markdown);
  const sections = splitSections(body);
  const parameters = extractParameters(body);
  const antiPatterns = extractAntiPatterns(sections, parameters);
  const narrative = extractNarrative(parameters);
  const voice = extractVoice(parameters);
  const derived = deriveStyleProtocolV2Fields(sections, parameters, antiPatterns, voice);
  const now = new Date().toISOString();

  return {
    id: randomUUID(),
    name: options?.name ?? frontMatter.name ?? extractTitle(body) ?? '风格档案',
    category: options?.category ?? frontMatter.category,
    guidancePrompt: options?.guidancePrompt ?? frontMatter.guidancePrompt,
    sourceFiles,
    narrative,
    voice,
    rawReference: markdown,
    sections,
    antiPatterns,
    parameters,
    arrangementStructure: derived.arrangementStructure,
    narrationConstraints: derived.narrationConstraints,
    createdAt: now,
    updatedAt: now,
  };
}

export function deriveStyleProtocolV2Fields(
  sections: IStyleSection[],
  parameters: Record<string, string>,
  antiPatterns: string[] = [],
  voice?: IStyleProfile['voice'],
): {
  arrangementStructure: IStyleArrangementStructure;
  narrationConstraints: IStyleNarrationConstraints;
} {
  const arrangementStructure = buildArrangementStructure(sections, parameters);
  const narrationConstraints = buildNarrationConstraints(parameters, antiPatterns, voice);

  return {
    arrangementStructure,
    narrationConstraints,
  };
}

function extractFrontMatter(markdown: string): { body: string; frontMatter: Record<string, string> } {
  const match = markdown.match(/^---\s*\n([\s\S]*?)\n---\s*\n/u);
  if (!match) return { body: markdown, frontMatter: {} };

  const frontMatter: Record<string, string> = {};
  const lines = match[1].split('\n');
  let index = 0;
  while (index < lines.length) {
    const kv = lines[index].match(/^(\w+)\s*:\s*(.*)$/u);
    if (!kv) {
      index += 1;
      continue;
    }

    const key = kv[1].trim();
    const inlineValue = kv[2].trim();
    if (inlineValue === '|' || inlineValue === '>') {
      const collected: string[] = [];
      index += 1;
      while (index < lines.length && /^\s+/.test(lines[index])) {
        collected.push(lines[index].replace(/^\s{2}/u, ''));
        index += 1;
      }
      frontMatter[key] = inlineValue === '>'
        ? collected.join(' ').trim()
        : collected.join('\n').trim();
      continue;
    }

    frontMatter[key] = inlineValue;
    index += 1;
  }

  return {
    body: markdown.slice(match[0].length),
    frontMatter,
  };
}

export function buildFrontMatter(fields: Record<string, string | undefined>): string {
  const lines: string[] = ['---'];
  for (const [key, value] of Object.entries(fields)) {
    if (value == null) continue;
    if (value.includes('\n')) {
      lines.push(`${key}: |`);
      for (const line of value.split('\n')) {
        lines.push(`  ${line}`);
      }
    } else {
      lines.push(`${key}: ${value}`);
    }
  }
  lines.push('---', '');
  return lines.join('\n');
}

function extractTitle(markdown: string): string | null {
  const match = markdown.match(/^#\s+(.+)$/mu);
  return match ? match[1].trim() : null;
}

function splitSections(markdown: string): IStyleSection[] {
  const parts = markdown.split(/^##\s+/mu).slice(1);
  return parts.map((part, index) => {
    const lines = part.split('\n');
    const title = lines[0].trim();
    const content = lines.slice(1).join('\n').trim();
    return {
      id: `section-${index + 1}`,
      title,
      content,
      tags: inferSectionTags(title),
    };
  });
}

function inferSectionTags(title: string): string[] {
  const normalized = title.toLowerCase();
  return dedupeStrings([
    /叙事|结构|chapter|program/u.test(normalized) ? 'structure' : undefined,
    /语言|voice|旁白|narration/u.test(normalized) ? 'voice' : undefined,
    /节奏|剪辑|素材编排|material/u.test(normalized) ? 'material-grammar' : undefined,
    /情绪|tone|mood/u.test(normalized) ? 'emotion' : undefined,
    /视觉|摄影|画面/u.test(normalized) ? 'visual' : undefined,
  ]);
}

function extractParameters(markdown: string): Record<string, string> {
  const parameters: Record<string, string> = {};

  for (const line of markdown.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^[-*]?\s*([^:：]+)[:：]\s*(.+)$/u);
    if (!match) continue;
    const key = match[1].trim();
    const value = match[2].trim();
    if (!key || !value) continue;
    parameters[key] = value;
  }

  return parameters;
}

function extractAntiPatterns(
  sections: IStyleSection[],
  parameters: Record<string, string>,
): string[] {
  const fromSections = sections
    .filter(section => /禁区|反例|avoid|anti/u.test(section.title))
    .flatMap(section => extractBulletLines(section.content));

  const fromParameters = Object.entries(parameters)
    .filter(([key]) => /禁区|反例|forbid|avoid/u.test(key))
    .flatMap(([, value]) => splitInlineList(value));

  return dedupeStrings([...fromSections, ...fromParameters]);
}

function extractNarrative(parameters: Record<string, string>): IStyleProfile['narrative'] {
  return {
    introRatio: clampRatio(parseRatio(parameters['开头占比']) ?? parseRatio(parameters['introRatio']) ?? 0.12),
    outroRatio: clampRatio(parseRatio(parameters['结尾占比']) ?? parseRatio(parameters['outroRatio']) ?? 0.08),
    avgSegmentDurationSec: parsePositiveNumber(parameters['平均章节时长']) ?? parsePositiveNumber(parameters['avgSegmentDurationSec']) ?? 28,
    brollFrequency: clampRatio(parseRatio(parameters['空镜频率']) ?? parseRatio(parameters['brollFrequency']) ?? 0.35),
    pacePattern: parameters['节奏'] ?? parameters['pacePattern'] ?? '克制推进',
  };
}

function extractVoice(parameters: Record<string, string>): IStyleProfile['voice'] {
  const person = normalizePerson(parameters['人称'] ?? parameters['person']);
  const density = normalizeDensity(parameters['旁白密度'] ?? parameters['density']);
  const sampleTexts = splitInlineList(parameters['示例文案'] ?? parameters['sampleTexts']);
  return {
    person,
    tone: parameters['语气'] ?? parameters['tone'] ?? '平实克制',
    density,
    sampleTexts,
  };
}

function buildArrangementStructure(
  sections: IStyleSection[],
  parameters: Record<string, string>,
): IStyleArrangementStructure {
  const primaryAxis = firstNonEmpty(
    parameters['primaryAxis'],
    parameters['编排主轴'],
    parameters['主轴'],
    inferPrimaryAxis(sections),
  );
  const secondaryAxes = dedupeStrings([
    ...splitInlineList(parameters['secondaryAxes']),
    ...splitInlineList(parameters['副轴']),
    ...splitInlineList(parameters['辅助轴']),
  ]);
  const chapterSplitPrinciples = dedupeStrings([
    ...splitInlineList(parameters['chapterSplitPrinciples']),
    ...splitInlineList(parameters['章节切分原则']),
    ...collectSectionSignals(sections, /切分|段落/u, 3),
  ]);
  const chapterTransitionNotes = dedupeStrings([
    ...splitInlineList(parameters['chapterTransitionNotes']),
    ...splitInlineList(parameters['章节转场']),
    ...collectSectionSignals(sections, /转场|衔接|过渡/u, 3),
  ]);
  const chapterPrograms = buildChapterPrograms(sections, parameters, primaryAxis);

  return {
    primaryAxis,
    secondaryAxes,
    chapterPrograms,
    chapterSplitPrinciples,
    chapterTransitionNotes,
  };
}

function buildChapterPrograms(
  sections: IStyleSection[],
  parameters: Record<string, string>,
  primaryAxis?: string,
): IStyleArrangementStructure['chapterPrograms'] {
  const explicitPrograms = Object.entries(parameters)
    .filter(([key]) => /chapterProgram|章节程序|段落程序/u.test(key))
    .map(([, value], index) => parseChapterProgramValue(value, index))
    .filter((value): value is NonNullable<typeof value> => Boolean(value));

  if (explicitPrograms.length > 0) {
    return explicitPrograms;
  }

  const structureHints = sections
    .filter(section => /结构|叙事|编排/u.test(section.title))
    .flatMap(section => extractBulletLines(section.content))
    .slice(0, 4);

  const defaults = structureHints.length > 0
    ? structureHints.map((hint, index) => ({
      type: `chapter-${index + 1}`,
      intent: hint,
      materialRoles: inferMaterialRoles(hint),
      promotionSignals: dedupeStrings([primaryAxis, hint]),
      transitionBias: index === 0 ? 'smooth-intro' : index === structureHints.length - 1 ? 'settle-outro' : 'carry-forward',
      localNarrationNote: index === 0 ? '先建立观看坐标，再进入细节。' : undefined,
    }))
    : [
      {
        type: 'opening',
        intent: '先建立空间和观看主轴',
        materialRoles: ['establishing', 'anchor'],
        promotionSignals: dedupeStrings([primaryAxis, '建场']),
        transitionBias: 'smooth-intro',
        localNarrationNote: '旁白先收一点，不要解释过满。',
      },
      {
        type: 'body',
        intent: '沿着主轴推进，逐步打开观察层次',
        materialRoles: ['observation', 'progression'],
        promotionSignals: dedupeStrings([primaryAxis, '推进']),
        transitionBias: 'carry-forward',
      },
      {
        type: 'closing',
        intent: '把观察收回到人物或情绪结论',
        materialRoles: ['resolution'],
        promotionSignals: dedupeStrings([primaryAxis, '收束']),
        transitionBias: 'settle-outro',
      },
    ];

  return defaults.slice(0, 6);
}

function buildNarrationConstraints(
  parameters: Record<string, string>,
  antiPatterns: string[],
  voice?: IStyleProfile['voice'],
): IStyleNarrationConstraints {
  return {
    perspective: parameters['旁白视角'] ?? parameters['perspective'] ?? normalizeVoicePerspective(voice?.person),
    tone: parameters['旁白语气'] ?? parameters['tone'] ?? voice?.tone,
    informationDensity: parameters['信息密度'] ?? parameters['informationDensity'] ?? normalizeVoiceDensity(voice?.density),
    explanationBias: parameters['解释倾向'] ?? parameters['explanationBias'] ?? '克制解释，优先让材料自己成立',
    forbiddenPatterns: dedupeStrings([
      ...splitInlineList(parameters['forbiddenPatterns']),
      ...antiPatterns,
    ]),
    notes: dedupeStrings([
      ...splitInlineList(parameters['narrationNotes']),
      ...splitInlineList(parameters['旁白备注']),
    ]),
  };
}

function parseChapterProgramValue(
  value: string,
  index: number,
): IStyleArrangementStructure['chapterPrograms'][number] | null {
  if (!value.trim()) return null;
  const parts = value.split('|').map(item => item.trim());
  if (parts.length >= 5) {
    return {
      type: parts[0],
      intent: parts[1],
      materialRoles: splitInlineList(parts[2]),
      promotionSignals: splitInlineList(parts[3]),
      transitionBias: parts[4],
      localNarrationNote: parts[5] || undefined,
    };
  }

  return {
    type: `chapter-${index + 1}`,
    intent: value.trim(),
    materialRoles: inferMaterialRoles(value),
    promotionSignals: splitInlineList(value),
    transitionBias: 'carry-forward',
  };
}

function collectSectionSignals(
  sections: IStyleSection[],
  pattern: RegExp,
  limit: number,
): string[] {
  return sections
    .filter(section => pattern.test(section.title) || pattern.test(section.content))
    .flatMap(section => extractBulletLines(section.content))
    .slice(0, limit);
}

function inferPrimaryAxis(sections: IStyleSection[]): string | undefined {
  const structureSection = sections.find(section => /结构|叙事|编排/u.test(section.title));
  if (!structureSection) return undefined;
  const firstSentence = structureSection.content
    .split('\n')
    .map(line => line.trim())
    .find(Boolean);
  return firstSentence?.slice(0, 48);
}

function inferMaterialRoles(value: string): string[] {
  const normalized = value.toLowerCase();
  return dedupeStrings([
    /建场|establish/u.test(normalized) ? 'establishing' : undefined,
    /推进|journey|route/u.test(normalized) ? 'progression' : undefined,
    /人物|self|主观/u.test(normalized) ? 'subjective' : undefined,
    /收束|结尾|resolve/u.test(normalized) ? 'resolution' : undefined,
    /观察|detail/u.test(normalized) ? 'observation' : undefined,
  ]);
}

function extractBulletLines(content: string): string[] {
  return content
    .split('\n')
    .map(line => line.trim())
    .filter(line => /^[-*]\s+/u.test(line))
    .map(line => line.replace(/^[-*]\s+/u, '').trim())
    .filter(Boolean);
}

function splitInlineList(value?: string): string[] {
  if (!value?.trim()) return [];
  return value
    .split(/[、,，;；/]/u)
    .map(item => item.trim())
    .filter(Boolean);
}

function normalizePerson(value?: string): IStyleProfile['voice']['person'] {
  const normalized = value?.trim().toLowerCase();
  if (normalized === '2nd' || normalized === '第二人称') return '2nd';
  if (normalized === '3rd' || normalized === '第三人称') return '3rd';
  return '1st';
}

function normalizeDensity(value?: string): IStyleProfile['voice']['density'] {
  const normalized = value?.trim().toLowerCase();
  if (normalized === 'low' || normalized === '低') return 'low';
  if (normalized === 'high' || normalized === '高') return 'high';
  return 'moderate';
}

function normalizeVoicePerspective(value?: IStyleProfile['voice']['person']): string | undefined {
  if (value === '1st') return '第一人称贴身观察';
  if (value === '2nd') return '第二人称代入';
  if (value === '3rd') return '第三人称旁观';
  return undefined;
}

function normalizeVoiceDensity(value?: IStyleProfile['voice']['density']): string | undefined {
  if (value === 'low') return '少解释，多留白';
  if (value === 'high') return '信息密度高，但仍要克制';
  if (value === 'moderate') return '中等密度，解释只服务主轴';
  return undefined;
}

function parsePositiveNumber(value?: string): number | undefined {
  if (!value) return undefined;
  const match = value.match(/(\d+(?:\.\d+)?)/u);
  if (!match) return undefined;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function parseRatio(value?: string): number | undefined {
  if (!value) return undefined;
  if (/%/u.test(value)) {
    const parsedPercent = parsePositiveNumber(value);
    return typeof parsedPercent === 'number' ? parsedPercent / 100 : undefined;
  }
  const parsed = parsePositiveNumber(value);
  if (typeof parsed !== 'number') return undefined;
  return parsed > 1 ? parsed / 100 : parsed;
}

function clampRatio(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  return values.map(value => value?.trim()).find(Boolean);
}

function dedupeStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.map(value => value?.trim()).filter(Boolean) as string[])];
}
