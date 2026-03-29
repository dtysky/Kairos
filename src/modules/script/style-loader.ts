import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { IStyleProfile, IStyleSection, IStyleCatalog, IStyleCatalogEntry } from '../../protocol/schema.js';

export interface IStyleLoadOptions {
  name?: string;
  category?: string;
  guidancePrompt?: string;
}

/**
 * 从 markdown 文件加载风格档案。
 * 将 h2 章节拆为 sections，提取结构化参数。
 * 支持 front-matter 中的 category 和 guidancePrompt。
 */
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

/**
 * 从分类目录加载指定类别的风格档案。
 */
export async function loadStyleByCategory(
  stylesDir: string,
  category: string,
): Promise<IStyleProfile | null> {
  const catalogPath = join(stylesDir, 'catalog.json');
  try {
    const catalogRaw = await readFile(catalogPath, 'utf-8');
    const catalog: IStyleCatalog = JSON.parse(catalogRaw);
    const entry = catalog.entries.find(e => e.category === category);
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

/**
 * 列出所有可用的风格分类。
 */
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
      .filter(f => f.endsWith('.md'))
      .map(f => {
        const category = f.replace(/\.md$/, '');
        return {
          id: category,
          category,
          name: category,
          profilePath: f,
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
  const params = extractParameters(body);
  const antiPatterns = extractAntiPatterns(sections);
  const narrative = extractNarrative(params);
  const voice = extractVoice(params);
  const now = new Date().toISOString();

  return {
    id: randomUUID(),
    name: options?.name ?? frontMatter['name'] ?? extractTitle(body) ?? '风格档案',
    category: options?.category ?? frontMatter['category'],
    guidancePrompt: options?.guidancePrompt ?? frontMatter['guidancePrompt'],
    sourceFiles,
    narrative,
    voice,
    rawReference: markdown,
    sections,
    antiPatterns,
    parameters: params,
    createdAt: now,
    updatedAt: now,
  };
}

function extractFrontMatter(md: string): { body: string; frontMatter: Record<string, string> } {
  const match = md.match(/^---\s*\n([\s\S]*?)\n---\s*\n/);
  if (!match) return { body: md, frontMatter: {} };

  const fm: Record<string, string> = {};
  const lines = match[1].split('\n');
  let i = 0;
  while (i < lines.length) {
    const kv = lines[i].match(/^(\w+)\s*:\s*(.*)$/);
    if (!kv) { i++; continue; }

    const key = kv[1].trim();
    const inlineVal = kv[2].trim();

    if (inlineVal === '|' || inlineVal === '>') {
      const collected: string[] = [];
      i++;
      while (i < lines.length && /^\s+/.test(lines[i])) {
        collected.push(lines[i].replace(/^\s{2}/, ''));
        i++;
      }
      fm[key] = inlineVal === '>'
        ? collected.join(' ').trim()
        : collected.join('\n').trim();
    } else {
      fm[key] = inlineVal;
      i++;
    }
  }
  return { body: md.slice(match[0].length), frontMatter: fm };
}

/**
 * Serialize key-value pairs into YAML-like front-matter.
 * Multi-line values use block literal (|) syntax.
 */
export function buildFrontMatter(fields: Record<string, string | undefined>): string {
  const lines: string[] = ['---'];
  for (const [key, val] of Object.entries(fields)) {
    if (val == null) continue;
    if (val.includes('\n')) {
      lines.push(`${key}: |`);
      for (const line of val.split('\n')) {
        lines.push(`  ${line}`);
      }
    } else {
      lines.push(`${key}: ${val}`);
    }
  }
  lines.push('---', '');
  return lines.join('\n');
}

function extractTitle(md: string): string | null {
  const m = md.match(/^#\s+(.+)/m);
  return m ? m[1].trim() : null;
}

function splitSections(md: string): IStyleSection[] {
  const parts = md.split(/^##\s+/m).slice(1);
  return parts.map((part, i) => {
    const lines = part.split('\n');
    const title = lines[0].trim();
    const content = lines.slice(1).join('\n').trim();
    const tags = extractSectionTags(title);
    return {
      id: `section-${i + 1}`,
      title,
      content,
      tags,
    };
  });
}

function extractSectionTags(title: string): string[] {
  const tagMap: Record<string, string[]> = {
    '叙事': ['narrative', 'structure'],
    '语言': ['language', 'voice'],
    '情绪': ['emotion', 'mood'],
    '摄影': ['photography', 'visual'],
    '画面': ['photography', 'visual'],
    '主题': ['theme', 'values'],
    '价值': ['theme', 'values'],
    '结构': ['structure', 'template'],
    '模板': ['structure', 'template'],
    '禁区': ['anti-pattern', 'constraints'],
    '参数': ['parameters'],
    '风格': ['style'],
  };

  const tags: string[] = [];
  for (const [keyword, t] of Object.entries(tagMap)) {
    if (title.includes(keyword)) tags.push(...t);
  }
  return [...new Set(tags)];
}

function extractAntiPatterns(sections: IStyleSection[]): string[] {
  const antiSection = sections.find(s =>
    s.tags?.includes('anti-pattern') || s.title.includes('禁区') || s.title.includes('避免'),
  );
  if (!antiSection) return [];

  return antiSection.content
    .split('\n')
    .filter(line => /^\d+\.\s+\*\*/.test(line))
    .map(line => line.replace(/^\d+\.\s+/, '').replace(/\*\*/g, '').trim());
}

function extractParameters(md: string): Record<string, string> {
  const params: Record<string, string> = {};
  const lines = md.split('\n');
  const headerIndex = lines.findIndex(line => /^\|\s*参数\s*\|\s*值\s*\|$/.test(line.trim()));
  if (headerIndex < 0) return params;

  for (let i = headerIndex + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.startsWith('|')) break;
    const m = line.match(/^\|\s*(.+?)\s*\|\s*(.+?)\s*\|$/);
    if (m && !m[1].includes('---') && m[1].trim() !== '参数') {
      params[m[1].trim()] = m[2].trim();
    }
  }
  return params;
}

function extractNarrative(params: Record<string, string>): IStyleProfile['narrative'] {
  return {
    introRatio: parseNumberParam(params['开场占比']) ?? 0.08,
    outroRatio: parseNumberParam(params['结尾占比']) ?? 0.05,
    avgSegmentDurationSec: parseNumberParam(params['平均段落时长（秒）'] ?? params['平均段落时长']) ?? 25,
    brollFrequency: parseNumberParam(params['B-roll 频率'] ?? params['Broll 频率']) ?? 0.3,
    pacePattern: params['节奏模式'] ?? params['叙事结构'] ?? '线性叙事',
  };
}

function extractVoice(params: Record<string, string>): IStyleProfile['voice'] {
  const perspective = params['叙述视角'] ?? params['叙事视角'] ?? '';
  const density = parseDensity(params['语言密度']);
  return {
    person: (perspective.includes('2nd') || perspective.includes('第二') ? '2nd'
      : perspective.includes('3rd') || perspective.includes('第三') ? '3rd'
      : '1st') as '1st' | '2nd' | '3rd',
    tone: params['主语气'] ?? params['语言风调'] ?? params['语言风格'] ?? '平实',
    density,
    sampleTexts: [],
  };
}

function parseNumberParam(value?: string): number | undefined {
  if (!value) return undefined;
  const match = value.match(/-?\d+(?:\.\d+)?/);
  if (!match) return undefined;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseDensity(value?: string): 'low' | 'moderate' | 'high' {
  if (!value) return 'moderate';
  const normalized = value.trim().toLowerCase();
  if (normalized.includes('high') || normalized.includes('高')) return 'high';
  if (normalized.includes('low') || normalized.includes('低')) return 'low';
  return 'moderate';
}
