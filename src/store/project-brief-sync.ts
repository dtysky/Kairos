import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type { IDeviceMediaMapFile, IMediaRoot } from '../protocol/schema.js';
import { loadProjectDeviceMediaMaps, saveProjectDeviceMap } from './device-media-maps.js';
import { loadIngestRoots } from './project.js';
import { buildProjectBriefTemplate, normalizeProjectBriefLocalPath, parseProjectBrief } from './project-brief.js';
import { writeJson } from './writer.js';

export interface ISyncProjectBriefInput {
  projectId: string;
  projectRoot: string;
  deviceMapPath?: string;
}

export interface ISyncProjectBriefResult {
  ingestRoots: IMediaRoot[];
  deviceMaps: IDeviceMediaMapFile;
  warnings: string[];
}

export async function syncProjectBriefMappings(
  input: ISyncProjectBriefInput,
): Promise<ISyncProjectBriefResult> {
  const content = await readFile(
    `${input.projectRoot}/config/project-brief.md`,
    'utf-8',
  );
  const parsed = parseProjectBrief(content);
  const existingRoots = await loadIngestRoots(input.projectRoot);
  const existingDeviceMaps = await loadProjectDeviceMediaMaps(input.projectRoot, input.deviceMapPath);

  if (parsed.mappings.length === 0) {
    return {
      ingestRoots: existingRoots.roots,
      deviceMaps: existingDeviceMaps,
      warnings: parsed.warnings,
    };
  }

  const pathOccurrences = new Map<string, number>();
  const roots = parsed.mappings.map((mapping, index) => {
    const rootId = buildRootId(mapping.path, pathOccurrences);
    const existing = existingRoots.roots.find(root => root.id === rootId);
    const label = existing?.label ?? deriveRootLabel(mapping.path, index);

    return {
      id: rootId,
      label,
      enabled: true,
      description: mapping.description,
      notes: [mapping.description],
      tags: existing?.tags ?? [],
      category: existing?.category,
      priority: existing?.priority ?? (index + 1),
    } satisfies IMediaRoot;
  });

  await writeJson(`${input.projectRoot}/config/ingest-roots.json`, { roots });
  const deviceMaps = await saveProjectDeviceMap(
    input.projectRoot,
    input.projectId,
    {
      roots: parsed.mappings.map((mapping, index) => ({
        rootId: roots[index].id,
        localPath: normalizeProjectBriefLocalPath(mapping.path),
        flightRecordPath: mapping.flightRecordPath
          ? normalizeProjectBriefLocalPath(mapping.flightRecordPath, mapping.path)
          : undefined,
      })),
    },
    input.deviceMapPath,
  );

  return {
    ingestRoots: roots,
    deviceMaps,
    warnings: parsed.warnings,
  };
}

export function buildProjectBriefWithMappings(input: {
  name: string;
  description?: string;
  createdAt?: string;
  mappings: Array<{ path: string; description: string; flightRecordPath?: string }>;
  pharos?: { includedTripIds?: string[] };
  materialPatternPhrases?: string[];
  localEditingIntentPhrases?: string[];
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
    ? input.mappings.flatMap(mapping => [
    `路径：${mapping.path}`,
    `说明：${mapping.description}`,
    ...(mapping.flightRecordPath ? [`飞行记录路径：${mapping.flightRecordPath}`] : []),
    '',
  ])
    : [
      '路径：',
      '说明：',
      '',
      '路径：',
      '说明：',
      '',
    ];

  const includedTripIds = input.pharos?.includedTripIds ?? [];
  const pharosLines = includedTripIds.length > 0
    ? includedTripIds.flatMap(tripId => [`包含 Trip：${tripId}`, ''])
    : ['包含 Trip：', ''];
  const materialPatternLines = (input.materialPatternPhrases ?? []).length > 0
    ? input.materialPatternPhrases!.flatMap(phrase => [`- ${phrase}`, ''])
    : ['- ', ''];
  const localIntentLines = (input.localEditingIntentPhrases ?? []).length > 0
    ? input.localEditingIntentPhrases!.flatMap(phrase => [`- ${phrase}`, ''])
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
    '## 局部剪辑作用短语',
    '',
    ...localIntentLines,
  ].join('\n').trimEnd() + '\n';
}

function buildRootId(path: string, pathOccurrences: Map<string, number>): string {
  const normalized = buildRootIdBase(path);
  if (!normalized) {
    const next = (pathOccurrences.get('__fallback__') ?? 0) + 1;
    pathOccurrences.set('__fallback__', next);
    return `root-${String(next).padStart(2, '0')}`;
  }

  const count = (pathOccurrences.get(normalized) ?? 0) + 1;
  pathOccurrences.set(normalized, count);
  return count === 1 ? `root-${normalized}` : `root-${normalized}-${count}`;
}

function buildRootIdBase(path: string): string {
  const normalized = path
    .toLowerCase()
    .replace(/^[a-z]:/, '')
    .replace(/[\\/]+/g, '-')
    .replace(/[^a-z0-9\u4e00-\u9fa5-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(-48);
  return normalized;
}

function deriveRootLabel(path: string, index: number): string {
  const segments = path.split(/[\\/]+/).filter(Boolean);
  const tail = segments.slice(-2).join('/');
  return tail || basename(path) || `素材目录 ${index + 1}`;
}
