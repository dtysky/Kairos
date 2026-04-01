import { mkdir, readdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { z } from 'zod';
import { EDerivedTrackOriginType } from '../protocol/schema.js';
import { readJsonOrNull, writeJson } from './writer.js';

export const IProjectGpsPoint = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  time: z.string(),
  sourcePath: z.string(),
});
export type IProjectGpsPoint = z.infer<typeof IProjectGpsPoint>;

export const IProjectGpsTrackSummary = z.object({
  relativePath: z.string(),
  pointCount: z.number().int().nonnegative(),
});
export type IProjectGpsTrackSummary = z.infer<typeof IProjectGpsTrackSummary>;

export const IProjectGpsMerged = z.object({
  schemaVersion: z.literal('1.0'),
  updatedAt: z.string(),
  trackCount: z.number().int().nonnegative(),
  pointCount: z.number().int().nonnegative(),
  tracks: z.array(IProjectGpsTrackSummary),
  points: z.array(IProjectGpsPoint),
});
export type IProjectGpsMerged = z.infer<typeof IProjectGpsMerged>;

export const EProjectSameSourceGpsOriginType = z.enum(['sidecar-srt', 'flight-record']);
export type EProjectSameSourceGpsOriginType = z.infer<typeof EProjectSameSourceGpsOriginType>;

export const IProjectSameSourceGpsTrackSummary = z.object({
  id: z.string(),
  originType: EProjectSameSourceGpsOriginType,
  relativePath: z.string(),
  sourcePath: z.string(),
  pointCount: z.number().int().nonnegative(),
  startTime: z.string().optional(),
  endTime: z.string().optional(),
});
export type IProjectSameSourceGpsTrackSummary = z.infer<typeof IProjectSameSourceGpsTrackSummary>;

export const IProjectSameSourceGpsIndex = z.object({
  schemaVersion: z.literal('1.0'),
  updatedAt: z.string(),
  trackCount: z.number().int().nonnegative(),
  tracks: z.array(IProjectSameSourceGpsTrackSummary),
});
export type IProjectSameSourceGpsIndex = z.infer<typeof IProjectSameSourceGpsIndex>;

export const EProjectDerivedTrackMatchKind = z.enum(['point', 'window']);
export type EProjectDerivedTrackMatchKind = z.infer<typeof EProjectDerivedTrackMatchKind>;

export const IProjectDerivedTrackEntry = z.object({
  id: z.string(),
  originType: EDerivedTrackOriginType,
  matchKind: EProjectDerivedTrackMatchKind,
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  confidence: z.number().min(0).max(1),
  time: z.string().optional(),
  startTime: z.string().optional(),
  endTime: z.string().optional(),
  timezone: z.string().optional(),
  sourceAssetId: z.string().optional(),
  sourcePath: z.string().optional(),
  matchedItinerarySegmentId: z.string().optional(),
  locationText: z.string().optional(),
  transport: z.enum(['drive', 'walk', 'train', 'flight', 'boat', 'mixed']).optional(),
  rootRef: z.string().optional(),
  pathPrefix: z.string().optional(),
  summary: z.string().optional(),
});
export type IProjectDerivedTrackEntry = z.infer<typeof IProjectDerivedTrackEntry>;

export const IProjectDerivedTrack = z.object({
  schemaVersion: z.literal('1.0'),
  updatedAt: z.string(),
  entryCount: z.number().int().nonnegative(),
  entries: z.array(IProjectDerivedTrackEntry),
});
export type IProjectDerivedTrack = z.infer<typeof IProjectDerivedTrack>;

export function getProjectGpsRoot(projectRoot: string): string {
  return join(projectRoot, 'gps');
}

export function getProjectGpsTracksRoot(projectRoot: string): string {
  return join(projectRoot, 'gps/tracks');
}

export function getProjectSameSourceGpsRoot(projectRoot: string): string {
  return join(projectRoot, 'gps/same-source');
}

export function getProjectSameSourceGpsTracksRoot(projectRoot: string): string {
  return join(projectRoot, 'gps/same-source/tracks');
}

export function getProjectGpsMergedPath(projectRoot: string): string {
  return join(projectRoot, 'gps/merged.json');
}

export function getProjectSameSourceGpsIndexPath(projectRoot: string): string {
  return join(projectRoot, 'gps/same-source/index.json');
}

export function getProjectSameSourceGpsTrackPath(projectRoot: string, trackId: string): string {
  return join(getProjectSameSourceGpsTracksRoot(projectRoot), `${trackId}.gpx`);
}

export function getProjectDerivedTrackPath(projectRoot: string): string {
  return join(projectRoot, 'gps/derived.json');
}

export async function ensureProjectGpsDirs(projectRoot: string): Promise<void> {
  await mkdir(getProjectGpsTracksRoot(projectRoot), { recursive: true });
  await mkdir(getProjectSameSourceGpsTracksRoot(projectRoot), { recursive: true });
}

export async function listProjectGpsTrackPaths(projectRoot: string): Promise<string[]> {
  const tracksRoot = getProjectGpsTracksRoot(projectRoot);
  const entries = await readdir(tracksRoot, { withFileTypes: true }).catch(() => []);
  return entries
    .filter(entry => entry.isFile() && isGpxTrackName(entry.name))
    .map(entry => join(tracksRoot, entry.name))
    .sort((a, b) => a.localeCompare(b));
}

export async function loadProjectGpsMerged(projectRoot: string): Promise<IProjectGpsMerged | null> {
  return readJsonOrNull(getProjectGpsMergedPath(projectRoot), IProjectGpsMerged);
}

export async function loadProjectGpsMergedByPath(path: string): Promise<IProjectGpsMerged | null> {
  return readJsonOrNull(path, IProjectGpsMerged);
}

export async function loadProjectDerivedTrack(projectRoot: string): Promise<IProjectDerivedTrack | null> {
  return readJsonOrNull(getProjectDerivedTrackPath(projectRoot), IProjectDerivedTrack);
}

export async function loadProjectSameSourceGpsIndex(projectRoot: string): Promise<IProjectSameSourceGpsIndex | null> {
  return readJsonOrNull(getProjectSameSourceGpsIndexPath(projectRoot), IProjectSameSourceGpsIndex);
}

export async function loadProjectDerivedTrackByPath(path: string): Promise<IProjectDerivedTrack | null> {
  return readJsonOrNull(path, IProjectDerivedTrack);
}

export async function loadProjectSameSourceGpsIndexByPath(path: string): Promise<IProjectSameSourceGpsIndex | null> {
  return readJsonOrNull(path, IProjectSameSourceGpsIndex);
}

export async function writeProjectGpsMerged(
  projectRoot: string,
  merged: IProjectGpsMerged,
): Promise<void> {
  await writeJson(getProjectGpsMergedPath(projectRoot), merged);
}

export async function writeProjectDerivedTrack(
  projectRoot: string,
  derivedTrack: IProjectDerivedTrack,
): Promise<void> {
  await writeJson(getProjectDerivedTrackPath(projectRoot), derivedTrack);
}

export async function writeProjectSameSourceGpsIndex(
  projectRoot: string,
  index: IProjectSameSourceGpsIndex,
): Promise<void> {
  await writeJson(getProjectSameSourceGpsIndexPath(projectRoot), index);
}

function isGpxTrackName(name: string): boolean {
  return extname(name).toLowerCase() === '.gpx';
}
