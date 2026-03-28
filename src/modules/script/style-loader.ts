import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { IStyleProfile, IStyleSection } from '../../protocol/schema.js';

/**
 * 从 markdown 文件加载风格档案。
 * 将 h2 章节拆为 sections，提取结构化参数。
 */
export async function loadStyleFromMarkdown(
  filePath: string,
  name?: string,
): Promise<IStyleProfile> {
  const raw = await readFile(filePath, 'utf-8');
  return parseStyleMarkdown(raw, name, [filePath]);
}

export function parseStyleMarkdown(
  markdown: string,
  name?: string,
  sourceFiles: string[] = [],
): IStyleProfile {
  const sections = splitSections(markdown);
  const params = extractParameters(markdown);
  const antiPatterns = extractAntiPatterns(sections);
  const narrative = extractNarrative(params);
  const voice = extractVoice(params);
  const now = new Date().toISOString();

  return {
    id: randomUUID(),
    name: name ?? extractTitle(markdown) ?? '风格档案',
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
  const tableMatch = md.match(/\|\s*参数\s*\|\s*值\s*\|[\s\S]*?(?=\n\n|---|\n#|$)/);
  if (!tableMatch) return params;

  for (const line of tableMatch[0].split('\n')) {
    const m = line.match(/^\|\s*(.+?)\s*\|\s*(.+?)\s*\|$/);
    if (m && !m[1].includes('---') && m[1].trim() !== '参数') {
      params[m[1].trim()] = m[2].trim();
    }
  }
  return params;
}

function extractNarrative(params: Record<string, string>): IStyleProfile['narrative'] {
  return {
    introRatio: 0.08,
    outroRatio: 0.05,
    avgSegmentDurationSec: 25,
    brollFrequency: 0.3,
    pacePattern: params['叙事结构'] ?? '线性叙事',
  };
}

function extractVoice(params: Record<string, string>): IStyleProfile['voice'] {
  return {
    person: (params['叙事视角']?.includes('第一') ? '1st'
      : params['叙事视角']?.includes('第二') ? '2nd' : '1st') as '1st' | '2nd' | '3rd',
    tone: params['语言风调'] ?? '平实',
    density: 'moderate',
    sampleTexts: [],
  };
}
