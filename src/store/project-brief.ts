import { posix, win32 } from 'node:path';

export interface IProjectBriefTemplateInput {
  name: string;
  description?: string;
  createdAt?: string;
}

export interface IProjectBriefPathMapping {
  path: string;
  rawPath?: string;
  alternatePaths?: Array<{ path?: string; rawPath?: string }>;
  description: string;
  flightRecordPath?: string;
  captureTimePolicy?: {
    mode: 'auto' | 'manual-required';
    requiredKinds?: Array<'video' | 'photo'>;
    reason?: string;
  };
}

export interface IProjectBriefPharosConfig {
  includedTripIds: string[];
}

export interface IProjectBriefVocabularyConfig {
  materialPatternPhrases: string[];
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
    '- 当前状态：已初始化，待登记素材 Root 与路径候选',
    '',
    '## 路径映射',
    '',
    '路径：',
    '原始路径：',
    '说明：',
    '',
    '路径：',
    '原始路径：',
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
  ].join('\n');
}

export function buildProjectBriefWithMappings(input: {
  name: string;
  description?: string;
  createdAt?: string;
  mappings: Array<{
    path: string;
    rawPath?: string;
    alternatePaths?: Array<{ path?: string; rawPath?: string }>;
    description: string;
    flightRecordPath?: string;
    captureTimePolicy?: IProjectBriefPathMapping['captureTimePolicy'];
  }>;
  pharos?: { includedTripIds?: string[] };
  materialPatternPhrases?: string[];
}): string {
  const templateLines = buildProjectBriefTemplate(input)
    .replace(/\r\n/g, '\n')
    .split('\n');
  const mappingHeadingIndex = templateLines.findIndex(line => line.trim() === '## 路径映射');
  const header = (
    mappingHeadingIndex >= 0
      ? templateLines.slice(0, mappingHeadingIndex)
      : templateLines
  ).join('\n').trimEnd();

  const mappingLines = input.mappings.length > 0
    ? input.mappings.flatMap(mapping => {
      const alternateLines = (mapping.alternatePaths ?? []).flatMap((alternate, index) => [
        ...(alternate.path ? [`备选路径${index + 1}：${alternate.path}`] : []),
        ...(alternate.rawPath ? [`原始路径${index + 1}：${alternate.rawPath}`] : []),
      ]);
      return [
        `路径：${mapping.path}`,
        ...(mapping.rawPath ? [`原始路径：${mapping.rawPath}`] : []),
        ...alternateLines,
        `说明：${mapping.description}`,
        ...(mapping.flightRecordPath ? [`飞行记录路径：${mapping.flightRecordPath}`] : []),
        ...(renderCaptureTimePolicyLine(mapping.captureTimePolicy) ? [renderCaptureTimePolicyLine(mapping.captureTimePolicy)!] : []),
        '',
      ];
    })
    : [
      '路径：',
      '原始路径：',
      '说明：',
      '',
      '路径：',
      '原始路径：',
      '说明：',
      '',
    ];

  const includedTripIds = input.pharos?.includedTripIds ?? [];
  const pharosLines = includedTripIds.length > 0
    ? includedTripIds.flatMap(tripId => [`包含 Trip：${tripId}`, ''])
    : ['包含 Trip：', ''];
  const materialPatternPhrases = input.materialPatternPhrases ?? [];
  const materialPatternLines = materialPatternPhrases.length > 0
    ? materialPatternPhrases.flatMap(phrase => [`- ${phrase}`, ''])
    : ['- ', ''];

  return [
    header,
    '## 路径映射',
    '',
    ...mappingLines,
    '## Pharos',
    '',
    ...pharosLines,
    '## 材料模式短语',
    '',
    ...materialPatternLines,
  ].join('\n').trimEnd() + '\n';
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

  let inMappings = false;
  let inPharos = false;
  let inMaterialPatterns = false;
  let pendingPath: string | null = null;
  let pendingRawPath: string | null = null;
  let pendingAlternatePaths = new Map<number, { path?: string; rawPath?: string }>();
  let pendingDescription: string | null = null;
  let pendingFlightRecordPath: string | null = null;
  let pendingCaptureTimePolicy: IProjectBriefPathMapping['captureTimePolicy'] | null = null;
  let expectPathValue = false;
  let expectRawPathValue = false;
  let expectAlternatePathIndex: number | null = null;
  let expectAlternateRawPathIndex: number | null = null;
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
      expectIncludedTripValue = false;
      continue;
    }

    if (line === '## Pharos') {
      pushPendingMapping(
        mappings,
        warnings,
        pendingPath,
        pendingRawPath,
        pendingAlternatePaths,
        pendingDescription,
        pendingFlightRecordPath,
        pendingCaptureTimePolicy,
      );
      pendingPath = null;
      pendingRawPath = null;
      pendingAlternatePaths = new Map();
      pendingDescription = null;
      pendingFlightRecordPath = null;
      pendingCaptureTimePolicy = null;
      inMappings = false;
      inPharos = true;
      inMaterialPatterns = false;
      expectPathValue = false;
      expectRawPathValue = false;
      expectAlternatePathIndex = null;
      expectAlternateRawPathIndex = null;
      expectDescriptionValue = false;
      expectFlightRecordPathValue = false;
      continue;
    }

    if (line === '## 材料模式短语') {
      pushPendingMapping(
        mappings,
        warnings,
        pendingPath,
        pendingRawPath,
        pendingAlternatePaths,
        pendingDescription,
        pendingFlightRecordPath,
        pendingCaptureTimePolicy,
      );
      pendingPath = null;
      pendingRawPath = null;
      pendingAlternatePaths = new Map();
      pendingDescription = null;
      pendingFlightRecordPath = null;
      pendingCaptureTimePolicy = null;
      inMappings = false;
      inPharos = false;
      inMaterialPatterns = true;
      expectPathValue = false;
      expectRawPathValue = false;
      expectAlternatePathIndex = null;
      expectAlternateRawPathIndex = null;
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
        pendingRawPath,
        pendingAlternatePaths,
        pendingDescription,
        pendingFlightRecordPath,
        pendingCaptureTimePolicy,
      );
      pendingPath = null;
      pendingRawPath = null;
      pendingAlternatePaths = new Map();
      pendingDescription = null;
      pendingFlightRecordPath = null;
      pendingCaptureTimePolicy = null;
      inMappings = false;
      inPharos = false;
      inMaterialPatterns = false;
      expectPathValue = false;
      expectRawPathValue = false;
      expectAlternatePathIndex = null;
      expectAlternateRawPathIndex = null;
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

    if (inMaterialPatterns) {
      const phrase = normalizePhraseLine(line);
      if (phrase) {
        materialPatternPhrases.push(phrase);
      }
      continue;
    }

    if (!inMappings) continue;

    if (line.startsWith('路径：')) {
      pushPendingMapping(
        mappings,
        warnings,
        pendingPath,
        pendingRawPath,
        pendingAlternatePaths,
        pendingDescription,
        pendingFlightRecordPath,
        pendingCaptureTimePolicy,
      );
      pendingPath = null;
      pendingRawPath = null;
      pendingAlternatePaths = new Map();
      pendingDescription = null;
      pendingFlightRecordPath = null;
      pendingCaptureTimePolicy = null;

      const value = line.slice('路径：'.length).trim();
      if (value) {
        pendingPath = value;
        expectPathValue = false;
      } else {
        expectPathValue = true;
      }
      expectRawPathValue = false;
      expectAlternatePathIndex = null;
      expectAlternateRawPathIndex = null;
      expectDescriptionValue = false;
      expectFlightRecordPathValue = false;
      continue;
    }

    const alternatePathMatch = line.match(/^备选路径\s*(\d+)：(.+)?$/u);
    if (alternatePathMatch) {
      const index = Number(alternatePathMatch[1]);
      const value = (alternatePathMatch[2] ?? '').trim();
      if (value) {
        setPendingAlternatePath(pendingAlternatePaths, index, 'path', value);
        expectAlternatePathIndex = null;
      } else {
        expectAlternatePathIndex = index;
      }
      expectPathValue = false;
      expectRawPathValue = false;
      expectAlternateRawPathIndex = null;
      expectDescriptionValue = false;
      expectFlightRecordPathValue = false;
      continue;
    }

    const alternateRawPathMatch = line.match(/^原始路径\s*(\d+)：(.+)?$/u);
    if (alternateRawPathMatch) {
      const index = Number(alternateRawPathMatch[1]);
      const value = (alternateRawPathMatch[2] ?? '').trim();
      if (value) {
        setPendingAlternatePath(pendingAlternatePaths, index, 'rawPath', value);
        expectAlternateRawPathIndex = null;
      } else {
        expectAlternateRawPathIndex = index;
      }
      expectPathValue = false;
      expectRawPathValue = false;
      expectAlternatePathIndex = null;
      expectDescriptionValue = false;
      expectFlightRecordPathValue = false;
      continue;
    }

    if (line.startsWith('原始路径：')) {
      const value = line.slice('原始路径：'.length).trim();
      if (value) {
        pendingRawPath = value;
        expectRawPathValue = false;
      } else {
        pendingRawPath = null;
        expectRawPathValue = true;
      }
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

    if (line.startsWith('拍摄时间规则：') || line.startsWith('时间规则：')) {
      const value = line.slice(line.indexOf('：') + 1).trim();
      pendingCaptureTimePolicy = parseCaptureTimePolicyLine(value);
      continue;
    }

    if (expectPathValue) {
      pendingPath = line;
      expectPathValue = false;
      continue;
    }

    if (expectRawPathValue) {
      pendingRawPath = line;
      expectRawPathValue = false;
      continue;
    }

    if (expectAlternatePathIndex !== null) {
      setPendingAlternatePath(pendingAlternatePaths, expectAlternatePathIndex, 'path', line);
      expectAlternatePathIndex = null;
      continue;
    }

    if (expectAlternateRawPathIndex !== null) {
      setPendingAlternatePath(pendingAlternatePaths, expectAlternateRawPathIndex, 'rawPath', line);
      expectAlternateRawPathIndex = null;
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
    }
  }

  pushPendingMapping(
    mappings,
    warnings,
    pendingPath,
    pendingRawPath,
    pendingAlternatePaths,
    pendingDescription,
    pendingFlightRecordPath,
    pendingCaptureTimePolicy,
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
      ? { includedTripIds }
      : undefined,
    vocabulary: {
      materialPatternPhrases: dedupeTrimmedStrings(materialPatternPhrases),
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

function renderCaptureTimePolicyLine(
  policy?: IProjectBriefPathMapping['captureTimePolicy'],
): string | null {
  if (!policy || policy.mode !== 'manual-required') return null;
  const kinds = (policy.requiredKinds?.length ? policy.requiredKinds : ['video', 'photo'])
    .filter(kind => kind === 'video' || kind === 'photo')
    .join(',');
  const reason = policy.reason?.trim();
  return `拍摄时间规则：manual-required(${kinds})${reason ? `；${reason}` : ''}`;
}

function parseCaptureTimePolicyLine(value: string): IProjectBriefPathMapping['captureTimePolicy'] | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const normalized = trimmed.toLowerCase();
  const isManualRequired = normalized.includes('manual-required')
    || normalized.includes('必须')
    || normalized.includes('手动')
    || normalized.includes('人工');
  if (!isManualRequired) {
    return { mode: 'auto' };
  }

  const requiredKinds: Array<'video' | 'photo'> = [];
  if (/video|视频|延时/u.test(normalized)) requiredKinds.push('video');
  if (/photo|照片|图片/u.test(normalized)) requiredKinds.push('photo');
  const [, reasonPart] = trimmed.split(/[；;]/u);
  const reason = reasonPart?.trim();
  return {
    mode: 'manual-required',
    ...(requiredKinds.length ? { requiredKinds: [...new Set(requiredKinds)] } : {}),
    ...(reason ? { reason } : {}),
  };
}

function pushPendingMapping(
  out: IProjectBriefPathMapping[],
  warnings: string[],
  path: string | null,
  rawPath: string | null,
  alternatePaths: Map<number, { path?: string; rawPath?: string }>,
  description: string | null,
  flightRecordPath: string | null,
  captureTimePolicy: IProjectBriefPathMapping['captureTimePolicy'] | null,
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
      rawPath: rawPath ?? undefined,
      alternatePaths: normalizeAlternatePaths(alternatePaths),
      description: '（待补充说明）',
      flightRecordPath: flightRecordPath ?? undefined,
      captureTimePolicy: captureTimePolicy ?? undefined,
    });
    return;
  }
  out.push({
    path,
    rawPath: rawPath ?? undefined,
    alternatePaths: normalizeAlternatePaths(alternatePaths),
    description,
    flightRecordPath: flightRecordPath ?? undefined,
    captureTimePolicy: captureTimePolicy ?? undefined,
  });
}

function setPendingAlternatePath(
  alternatePaths: Map<number, { path?: string; rawPath?: string }>,
  index: number,
  key: 'path' | 'rawPath',
  value: string,
): void {
  if (!Number.isInteger(index) || index < 1) return;
  const trimmed = value.trim();
  if (!trimmed) return;
  const existing = alternatePaths.get(index) ?? {};
  alternatePaths.set(index, {
    ...existing,
    [key]: trimmed,
  });
}

function normalizeAlternatePaths(
  alternatePaths: Map<number, { path?: string; rawPath?: string }>,
): Array<{ path?: string; rawPath?: string }> | undefined {
  const normalized = [...alternatePaths.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([, value]) => ({
      path: value.path?.trim() || undefined,
      rawPath: value.rawPath?.trim() || undefined,
    }))
    .filter(value => Boolean(value.path || value.rawPath));
  return normalized.length > 0 ? normalized : undefined;
}

function findDuplicatePaths(mappings: IProjectBriefPathMapping[]): string[] {
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
