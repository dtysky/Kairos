import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type { IDeviceMediaMapFile, IMediaRoot } from '../protocol/schema.js';
import { saveDeviceProjectMap } from './device-media-maps.js';
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
  const deviceMaps = await saveDeviceProjectMap(
    input.projectId,
    {
      roots: parsed.mappings.map((mapping, index) => ({
        rootId: roots[index].id,
        localPath: normalizeProjectBriefLocalPath(mapping.path),
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
  mappings: Array<{ path: string; description: string }>;
}): string {
  const base = buildProjectBriefTemplate(input).trimEnd();
  const body = input.mappings.flatMap(mapping => [
    `路径：${mapping.path}`,
    `说明：${mapping.description}`,
    '',
  ]);
  return `${base}\n${body.join('\n')}`.trimEnd() + '\n';
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
