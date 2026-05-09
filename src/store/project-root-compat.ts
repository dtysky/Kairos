import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import {
  IMediaRoot,
} from '../protocol/schema.js';
import { normalizeColorRenderPreset } from '../modules/color/render-preset.js';
import { readJsonOrNull } from './writer.js';

const IProjectRootsFile = z.object({
  roots: z.array(IMediaRoot),
});

export function getProjectRootsPath(projectRoot: string): string {
  return join(projectRoot, 'config', 'project-roots.json');
}

export function getLegacyIngestRootsPath(projectRoot: string): string {
  return join(projectRoot, 'config', 'ingest-roots.json');
}

function normalizeProjectRoot(root: IMediaRoot): IMediaRoot {
  const renderPreset = root.color?.renderPreset;
  const normalizedRenderPreset = normalizeColorRenderPreset(renderPreset);
  const colorSpaceProfile = typeof root.color?.colorSpaceProfile === 'string'
    ? normalizeColorSpaceProfile(root.color.colorSpaceProfile)
    : undefined;
  const transformPresetKey = typeof root.color?.transformPresetKey === 'string'
    ? normalizeResolveLutPath(root.color.transformPresetKey)
    : undefined;

  return {
    ...root,
    path: root.path?.trim() || undefined,
    rawPath: root.rawPath?.trim() || undefined,
    flightRecordPath: root.flightRecordPath?.trim() || undefined,
    alternatePaths: root.alternatePaths
      ?.map(alternate => ({
        path: alternate.path?.trim() || undefined,
        rawPath: alternate.rawPath?.trim() || undefined,
      }))
      .filter(alternate => alternate.path || alternate.rawPath),
    label: root.label?.trim() || undefined,
    description: root.description?.trim() || undefined,
    notes: root.notes?.map(note => note.trim()).filter(Boolean),
    tags: root.tags?.map(tag => tag.trim()).filter(Boolean),
    color: normalizedRenderPreset || colorSpaceProfile || transformPresetKey
      ? {
        ...(normalizedRenderPreset ? { renderPreset: normalizedRenderPreset } : {}),
        ...(colorSpaceProfile ? { colorSpaceProfile } : {}),
        ...(transformPresetKey ? { transformPresetKey } : {}),
      }
      : undefined,
  };
}

function normalizeConfigKey(value: string): string | undefined {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return normalized || undefined;
}

function normalizeColorSpaceProfile(value: string): string | undefined {
  const normalized = normalizeConfigKey(value);
  if (!normalized) return undefined;
  if (/^s-?log3$/u.test(normalized)) return 'slog3';
  if (/^d-?log$/u.test(normalized)) return 'dlog';
  if (/^d-?log-?m$/u.test(normalized)) return 'dlog-m';
  if (/^hlg$/u.test(normalized)) return 'hlg';
  if (/^rec-?709$/u.test(normalized)) return 'rec709';
  return normalized;
}

function normalizeResolveLutPath(value: string): string | undefined {
  const normalized = value
    .trim()
    .replace(/\s*[\\/]+\s*/g, '/')
    .replace(/^\/+/g, '')
    .replace(/\/+/g, '/');
  if (
    !normalized
    || normalized.startsWith('..')
    || normalized.includes('/../')
    || /^[a-z]:/iu.test(normalized)
    || normalized.includes('://')
  ) {
    return undefined;
  }
  return normalized.toLowerCase().endsWith('.cube')
    ? normalized
    : `${normalized}.cube`;
}

function normalizeProjectRoots(projectRoots: { roots: IMediaRoot[] }): { roots: IMediaRoot[] } {
  return IProjectRootsFile.parse({
    roots: projectRoots.roots.map(root => normalizeProjectRoot(root)),
  });
}

export async function loadPersistedLegacyProjectRoots(projectRoot: string): Promise<{ roots: IMediaRoot[] }> {
  const [projectRoots, legacyIngestRoots] = await Promise.all([
    readJsonOrNull(getProjectRootsPath(projectRoot), IProjectRootsFile),
    readJsonOrNull(getLegacyIngestRootsPath(projectRoot), IProjectRootsFile),
  ]);
  const storedRoots = normalizeProjectRoots(projectRoots ?? { roots: [] });
  const legacyRoots = normalizeProjectRoots(legacyIngestRoots ?? { roots: [] });
  const normalized = normalizeProjectRoots({
    roots: [
      ...storedRoots.roots,
      ...legacyRoots.roots.filter(legacyRoot => !storedRoots.roots.some(rootItem => rootItem.id === legacyRoot.id)),
    ],
  });
  return normalized;
}

export async function removeLegacyProjectRootFiles(projectRoot: string): Promise<void> {
  await Promise.all([
    rm(getProjectRootsPath(projectRoot), { force: true }),
    rm(getLegacyIngestRootsPath(projectRoot), { force: true }),
  ]);
}
