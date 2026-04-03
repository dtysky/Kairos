import type { IStyleProfile, IStyleSection } from '../../protocol/schema.js';

export const CRHYTHM_MATERIAL_PARAMETER_KEYS = [
  '照片使用策略',
  '照片编排方式',
  '延时使用关系',
  '航拍插入时机',
  '空镜/B-roll 关系',
  '节奏抬升触发点',
] as const;

const CRHYTHM_SECTION_KEYWORDS = [
  '节奏',
  '剪辑',
  '素材编排',
  '照片',
  '航拍',
  '延时',
  '空镜',
  'b-roll',
  'broll',
  '蒙太奇',
] as const;

const CRHYTHM_SECTION_TAGS = new Set([
  'rhythm',
  'editing',
  'material-grammar',
  'photo',
  'timelapse',
  'aerial',
  'broll',
]);

const CRHYTHM_ANTI_PATTERN_KEYWORDS = [
  '照片',
  '航拍',
  '延时',
  '空镜',
  'b-roll',
  'broll',
  '镜头',
  '节奏',
  '蒙太奇',
  '插入',
  '铺陈',
] as const;

export function collectRhythmMaterialSections(
  style: Pick<IStyleProfile, 'sections'>,
): IStyleSection[] {
  return (style.sections ?? []).filter(isRhythmMaterialSection);
}

export function collectRhythmMaterialParameters(
  style: Pick<IStyleProfile, 'parameters'>,
): Array<[string, string]> {
  const parameters = style.parameters ?? {};
  const seen = new Set<string>();
  const ordered: Array<[string, string]> = [];

  for (const key of CRHYTHM_MATERIAL_PARAMETER_KEYS) {
    const value = parameters[key];
    if (typeof value !== 'string' || !value.trim()) continue;
    ordered.push([key, value.trim()]);
    seen.add(key);
  }

  for (const [key, value] of Object.entries(parameters)) {
    if (seen.has(key)) continue;
    if (!isRhythmMaterialParameterKey(key)) continue;
    const normalizedValue = value.trim();
    if (!normalizedValue) continue;
    ordered.push([key, normalizedValue]);
  }

  return ordered;
}

export function collectRhythmMaterialAntiPatterns(
  style: Pick<IStyleProfile, 'antiPatterns'>,
): string[] {
  return (style.antiPatterns ?? []).filter(isRhythmMaterialAntiPattern);
}

export function buildRhythmMaterialPromptLines(
  style: Pick<IStyleProfile, 'sections' | 'parameters' | 'antiPatterns'>,
  options: {
    sectionHeading?: string;
    parameterHeading?: string;
    antiPatternHeading?: string;
    maxSectionLength?: number;
  } = {},
): string[] {
  const sectionHeading = options.sectionHeading ?? '节奏与素材编排要点：';
  const parameterHeading = options.parameterHeading ?? '节奏与素材参数：';
  const antiPatternHeading = options.antiPatternHeading ?? '节奏相关禁区：';
  const maxSectionLength = options.maxSectionLength ?? 240;

  const lines: string[] = [];
  const sections = collectRhythmMaterialSections(style);
  const parameters = collectRhythmMaterialParameters(style);
  const antiPatterns = collectRhythmMaterialAntiPatterns(style);

  if (sections.length > 0) {
    lines.push(sectionHeading);
    for (const section of sections) {
      lines.push(`- ${section.title}: ${summarizeSectionContent(section.content, maxSectionLength)}`);
    }
  }

  if (parameters.length > 0) {
    lines.push(parameterHeading);
    for (const [key, value] of parameters) {
      lines.push(`- ${key}: ${value}`);
    }
  }

  if (antiPatterns.length > 0) {
    lines.push(antiPatternHeading);
    for (const item of antiPatterns.slice(0, 5)) {
      lines.push(`- ${item}`);
    }
  }

  return lines;
}

export function ensureRhythmMaterialParameterKeys(
  parameters: Record<string, string>,
  fallbackValue = '未明确',
): Record<string, string> {
  const normalized: Record<string, string> = { ...parameters };
  for (const key of CRHYTHM_MATERIAL_PARAMETER_KEYS) {
    const value = normalized[key];
    if (typeof value === 'string' && value.trim()) continue;
    normalized[key] = fallbackValue;
  }
  return normalized;
}

export function isRhythmMaterialSection(section: IStyleSection): boolean {
  const title = section.title.trim().toLowerCase();
  if (section.tags?.some(tag => CRHYTHM_SECTION_TAGS.has(tag))) {
    return true;
  }
  return CRHYTHM_SECTION_KEYWORDS.some(keyword => title.includes(keyword.toLowerCase()));
}

function isRhythmMaterialParameterKey(key: string): boolean {
  const normalized = key.trim().toLowerCase();
  return CRHYTHM_SECTION_KEYWORDS.some(keyword => normalized.includes(keyword.toLowerCase()));
}

function isRhythmMaterialAntiPattern(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return false;
  return CRHYTHM_ANTI_PATTERN_KEYWORDS.some(keyword => normalized.includes(keyword.toLowerCase()));
}

function summarizeSectionContent(content: string, maxLength: number): string {
  const normalized = content
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .join(' / ');
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 3)).trim()}...`;
}
