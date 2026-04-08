import { posix, win32 } from 'node:path';

export interface IProjectBriefTemplateInput {
  name: string;
  description?: string;
  createdAt?: string;
}

export interface IProjectBriefPathMapping {
  path: string;
  description: string;
  flightRecordPath?: string;
}

export interface IProjectBriefPharosConfig {
  includedTripIds: string[];
}

export interface IProjectBriefVocabularyConfig {
  materialPatternPhrases: string[];
  localEditingIntentPhrases: string[];
}

export interface IParsedProjectBrief {
  name?: string;
  description?: string;
  createdAt?: string;
  mappings: IProjectBriefPathMapping[];
  pharos?: IProjectBriefPharosConfig;
  vocabulary: IProjectBriefVocabularyConfig;
  warnings: string[];
}

export function buildProjectBriefTemplate(
  input: IProjectBriefTemplateInput,
): string {
  const createdAt = input.createdAt ?? new Date().toISOString();
  const description = input.description?.trim() || '（待填写）';

  return [
    `# ${input.name}`,
    '',
    `- 项目说明：${description}`,
    `- 创建日期：${createdAt}`,
    '- 当前状态：已初始化，待登记素材源与设备路径映射',
    '',
    '## 路径映射',
    '',
    '路径：',
    '说明：',
    '',
    '路径：',
    '说明：',
    '',
    '## Pharos',
    '',
    '包含 Trip：',
    '',
    '## 材料模式短语',
    '',
    '- ',
    '',
    '## 局部剪辑作用短语',
    '',
    '- ',
    '',
  ].join('\n');
}

export function parseProjectBrief(content: string): IParsedProjectBrief {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const warnings: string[] = [];

  let name: string | undefined;
  let description: string | undefined;
  let createdAt: string | undefined;

  const mappings: IProjectBriefPathMapping[] = [];
  const includedTripIds: string[] = [];
  const materialPatternPhrases: string[] = [];
  const localEditingIntentPhrases: string[] = [];
  let inMappings = false;
  let inPharos = false;
  let inMaterialPatterns = false;
  let inLocalEditingIntents = false;
  let pendingPath: string | null = null;
  let pendingDescription: string | null = null;
  let pendingFlightRecordPath: string | null = null;
  let expectPathValue = false;
  let expectDescriptionValue = false;
  let expectFlightRecordPathValue = false;
  let expectIncludedTripValue = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith('# ')) {
      name = line.slice(2).trim() || name;
      continue;
    }

    if (line.startsWith('- 项目说明：')) {
      description = line.slice('- 项目说明：'.length).trim() || description;
      continue;
    }

    if (line.startsWith('- 创建日期：')) {
      createdAt = line.slice('- 创建日期：'.length).trim() || createdAt;
      continue;
    }

    if (line === '## 路径映射') {
      inMappings = true;
      inPharos = false;
      inMaterialPatterns = false;
      inLocalEditingIntents = false;
      expectIncludedTripValue = false;
      continue;
    }

    if (line === '## Pharos') {
      pushPendingMapping(
        mappings,
        warnings,
        pendingPath,
        pendingDescription,
        pendingFlightRecordPath,
      );
      pendingPath = null;
      pendingDescription = null;
      pendingFlightRecordPath = null;
      inMappings = false;
      inPharos = true;
      inMaterialPatterns = false;
      inLocalEditingIntents = false;
      expectPathValue = false;
      expectDescriptionValue = false;
      expectFlightRecordPathValue = false;
      continue;
    }

    if (line === '## 材料模式短语') {
      pushPendingMapping(
        mappings,
        warnings,
        pendingPath,
        pendingDescription,
        pendingFlightRecordPath,
      );
      pendingPath = null;
      pendingDescription = null;
      pendingFlightRecordPath = null;
      inMappings = false;
      inPharos = false;
      inMaterialPatterns = true;
      inLocalEditingIntents = false;
      expectPathValue = false;
      expectDescriptionValue = false;
      expectFlightRecordPathValue = false;
      expectIncludedTripValue = false;
      continue;
    }

    if (line === '## 局部剪辑作用短语') {
      pushPendingMapping(
        mappings,
        warnings,
        pendingPath,
        pendingDescription,
        pendingFlightRecordPath,
      );
      pendingPath = null;
      pendingDescription = null;
      pendingFlightRecordPath = null;
      inMappings = false;
      inPharos = false;
      inMaterialPatterns = false;
      inLocalEditingIntents = true;
      expectPathValue = false;
      expectDescriptionValue = false;
      expectFlightRecordPathValue = false;
      expectIncludedTripValue = false;
      continue;
    }

    if (line.startsWith('## ')) {
      pushPendingMapping(
        mappings,
        warnings,
        pendingPath,
        pendingDescription,
        pendingFlightRecordPath,
      );
      pendingPath = null;
      pendingDescription = null;
      pendingFlightRecordPath = null;
      inMappings = false;
      inPharos = false;
      inMaterialPatterns = false;
      inLocalEditingIntents = false;
      expectPathValue = false;
      expectDescriptionValue = false;
      expectFlightRecordPathValue = false;
      expectIncludedTripValue = false;
      continue;
    }

    if (inPharos) {
      if (line.startsWith('包含 Trip：')) {
        const value = line.slice('包含 Trip：'.length).trim();
        if (value) {
          pushIncludedTripId(includedTripIds, value);
          expectIncludedTripValue = false;
        } else {
          expectIncludedTripValue = true;
        }
        continue;
      }

      if (expectIncludedTripValue) {
        pushIncludedTripId(includedTripIds, line);
        expectIncludedTripValue = false;
      }
      continue;
    }

    if (inMaterialPatterns || inLocalEditingIntents) {
      const phrase = normalizePhraseLine(line);
      if (!phrase) continue;
      if (inMaterialPatterns) {
        materialPatternPhrases.push(phrase);
      } else {
        localEditingIntentPhrases.push(phrase);
      }
      continue;
    }

    if (!inMappings) continue;

    if (line.startsWith('路径：')) {
      pushPendingMapping(
        mappings,
        warnings,
        pendingPath,
        pendingDescription,
        pendingFlightRecordPath,
      );
      pendingPath = null;
      pendingDescription = null;
      pendingFlightRecordPath = null;

      const value = line.slice('路径：'.length).trim();
      if (value) {
        pendingPath = value;
        expectPathValue = false;
      } else {
        expectPathValue = true;
      }
      expectDescriptionValue = false;
      expectFlightRecordPathValue = false;
      continue;
    }

    if (line.startsWith('说明：')) {
      const value = line.slice('说明：'.length).trim();
      if (value) {
        pendingDescription = value;
        expectDescriptionValue = false;
      } else {
        expectDescriptionValue = true;
      }
      continue;
    }

    if (line.startsWith('飞行记录路径：')) {
      const value = line.slice('飞行记录路径：'.length).trim();
      if (value) {
        pendingFlightRecordPath = value;
        expectFlightRecordPathValue = false;
      } else {
        expectFlightRecordPathValue = true;
      }
      continue;
    }

    if (expectPathValue) {
      pendingPath = line;
      expectPathValue = false;
      continue;
    }

    if (expectDescriptionValue) {
      pendingDescription = line;
      expectDescriptionValue = false;
      continue;
    }

    if (expectFlightRecordPathValue) {
      pendingFlightRecordPath = line;
      expectFlightRecordPathValue = false;
      continue;
    }
  }

  pushPendingMapping(
    mappings,
    warnings,
    pendingPath,
    pendingDescription,
    pendingFlightRecordPath,
  );

  const duplicatePaths = findDuplicatePaths(mappings);
  for (const path of duplicatePaths) {
    warnings.push(`路径映射中存在重复路径：${path}`);
  }
  const duplicateTripIds = findDuplicateItems(includedTripIds);
  for (const tripId of duplicateTripIds) {
    warnings.push(`Pharos Trip 筛选中存在重复 Trip：${tripId}`);
  }

  return {
    name,
    description,
    createdAt,
    mappings,
    pharos: includedTripIds.length > 0
      ? {
        includedTripIds,
      }
      : undefined,
    vocabulary: {
      materialPatternPhrases: dedupeTrimmedStrings(materialPatternPhrases),
      localEditingIntentPhrases: dedupeTrimmedStrings(localEditingIntentPhrases),
    },
    warnings,
  };
}

export function normalizeProjectBriefLocalPath(path: string, basePath?: string): string {
  const trimmed = resolveProjectBriefPath(path, basePath);
  if (process.platform === 'win32') return trimmed;

  const winMatch = trimmed.match(/^([a-zA-Z]):[\\/](.*)$/);
  if (!winMatch) return trimmed.replace(/\\/g, '/');

  const drive = winMatch[1].toLowerCase();
  const rest = winMatch[2].replace(/[\\/]+/g, '/');
  return `/mnt/${drive}/${rest}`;
}

function normalizePhraseLine(line: string): string | null {
  const normalized = line.replace(/^[-*]\s*/, '').trim();
  return normalized.length > 0 ? normalized : null;
}

function dedupeTrimmedStrings(values: string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))];
}

function pushPendingMapping(
  out: IProjectBriefPathMapping[],
  warnings: string[],
  path: string | null,
  description: string | null,
  flightRecordPath: string | null,
): void {
  if (!path && !description) return;
  if (!path) {
    warnings.push('存在缺少路径的路径映射条目。');
    return;
  }
  if (!description) {
    warnings.push(`路径映射缺少说明：${path}`);
    out.push({
      path,
      description: '（待补充说明）',
      flightRecordPath: flightRecordPath ?? undefined,
    });
    return;
  }
  out.push({
    path,
    description,
    flightRecordPath: flightRecordPath ?? undefined,
  });
}

function findDuplicatePaths(
  mappings: IProjectBriefPathMapping[],
): string[] {
  const counts = new Map<string, number>();
  for (const mapping of mappings) {
    const key = mapping.path.trim().toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return mappings
    .map(mapping => mapping.path)
    .filter((path, index, all) => {
      const key = path.trim().toLowerCase();
      return (counts.get(key) ?? 0) > 1 && all.findIndex(item => item.trim().toLowerCase() === key) === index;
    });
}

function pushIncludedTripId(out: string[], value: string): void {
  const trimmed = value.trim();
  if (!trimmed) return;
  out.push(trimmed);
}

function findDuplicateItems(items: string[]): string[] {
  const counts = new Map<string, number>();
  for (const item of items) {
    const key = item.trim().toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return items.filter((item, index, all) => {
    const key = item.trim().toLowerCase();
    return (counts.get(key) ?? 0) > 1 && all.findIndex(value => value.trim().toLowerCase() === key) === index;
  });
}

function resolveProjectBriefPath(path: string, basePath?: string): string {
  const trimmed = path.trim();
  if (!basePath || !isRelativeProjectBriefPath(trimmed)) {
    return trimmed;
  }

  const base = basePath.trim();
  const pathImpl = /^[a-zA-Z]:[\\/]/u.test(base) ? win32 : posix;
  return pathImpl.normalize(pathImpl.resolve(base, trimmed));
}

function isRelativeProjectBriefPath(path: string): boolean {
  return path.startsWith('./')
    || path.startsWith('.\\')
    || path.startsWith('../')
    || path.startsWith('..\\');
}
