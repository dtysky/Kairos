import { access, copyFile } from 'node:fs/promises';
import { basename, extname, join, parse, relative, resolve } from 'node:path';
import type { IProjectGpsMerged } from '../../store/gps.js';
import {
  ensureProjectGpsDirs,
  getProjectGpsMergedPath,
  getProjectGpsTracksRoot,
  listProjectGpsTrackPaths,
  loadProjectGpsMerged,
  writeProjectGpsMerged,
} from '../../store/gps.js';
import { loadGpxPoints } from './gpx-spatial.js';

export interface IImportProjectGpxTracksInput {
  projectRoot: string;
  sourcePaths: string[];
}

export interface IImportProjectGpxTracksResult {
  trackPaths: string[];
  merged: IProjectGpsMerged;
}

export interface IResolveProjectGpxPathsInput {
  projectRoot: string;
  gpxPaths?: string[];
}

export async function importProjectGpxTracks(
  input: IImportProjectGpxTracksInput,
): Promise<IImportProjectGpxTracksResult> {
  await ensureProjectGpsDirs(input.projectRoot);

  const trackPaths: string[] = [];
  for (const sourcePath of dedupePaths(input.sourcePaths)) {
    const targetPath = await copyTrackIntoProject(input.projectRoot, sourcePath);
    trackPaths.push(targetPath);
  }

  const merged = await refreshProjectGpsCache(input.projectRoot);
  return {
    trackPaths,
    merged,
  };
}

export async function refreshProjectGpsCache(projectRoot: string): Promise<IProjectGpsMerged> {
  await ensureProjectGpsDirs(projectRoot);
  const trackPaths = await listProjectGpsTrackPaths(projectRoot);
  const tracks: IProjectGpsMerged['tracks'] = [];
  const points: IProjectGpsMerged['points'] = [];

  for (const trackPath of trackPaths) {
    const relativePath = toProjectRelativePath(projectRoot, trackPath);
    const trackPoints = await loadGpxPoints(trackPath);
    tracks.push({
      relativePath,
      pointCount: trackPoints.length,
    });
    for (const point of trackPoints) {
      points.push({
        lat: point.lat,
        lng: point.lng,
        time: point.time,
        sourcePath: relativePath,
      });
    }
  }

  points.sort((a, b) => {
    const delta = Date.parse(a.time) - Date.parse(b.time);
    return delta === 0 ? a.sourcePath.localeCompare(b.sourcePath) : delta;
  });

  const merged: IProjectGpsMerged = {
    schemaVersion: '1.0',
    updatedAt: new Date().toISOString(),
    trackCount: tracks.length,
    pointCount: points.length,
    tracks,
    points,
  };
  await writeProjectGpsMerged(projectRoot, merged);
  return merged;
}

export async function getDefaultProjectGpxPaths(projectRoot: string): Promise<string[]> {
  const merged = await loadProjectGpsMerged(projectRoot);
  if (merged && merged.pointCount > 0) {
    return [getProjectGpsMergedPath(projectRoot)];
  }
  return listProjectGpsTrackPaths(projectRoot);
}

export async function resolveProjectGpxPaths(
  input: IResolveProjectGpxPathsInput,
): Promise<string[]> {
  const explicitPaths = dedupePaths(input.gpxPaths ?? []);
  if (explicitPaths.length > 0) return explicitPaths;
  return getDefaultProjectGpxPaths(input.projectRoot);
}

async function copyTrackIntoProject(projectRoot: string, sourcePath: string): Promise<string> {
  const tracksRoot = getProjectGpsTracksRoot(projectRoot);
  const parsed = parse(basename(sourcePath));
  const baseName = sanitizeTrackBaseName(parsed.name) || 'track';
  const extension = extname(sourcePath) || '.gpx';
  let index = 0;

  while (true) {
    const suffix = index === 0 ? '' : `-${index + 1}`;
    const candidate = join(tracksRoot, `${baseName}${suffix}${extension}`);
    if (resolve(candidate) === resolve(sourcePath)) {
      return candidate;
    }
    if (!(await pathExists(candidate))) {
      await copyFile(sourcePath, candidate);
      return candidate;
    }
    index += 1;
  }
}

function sanitizeTrackBaseName(name: string): string {
  return name
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
}

function dedupePaths(paths: string[]): string[] {
  return Array.from(new Set(paths.filter(path => path.trim())));
}

function toProjectRelativePath(projectRoot: string, targetPath: string): string {
  return relative(projectRoot, targetPath).replace(/\\/gu, '/');
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
