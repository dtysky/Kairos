import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import type { IInferredGps, IKtepAsset } from '../../protocol/schema.js';
import { loadProjectGpsMergedByPath } from '../../store/gps.js';

const CDEFAULT_GPX_MATCH_TOLERANCE_MS = 5 * 60 * 1000;
const CGPX_POINT_PATTERN = /<(trkpt|rtept|wpt)\b([^>]*)>([\s\S]*?)<\/\1>/giu;

export interface IGpxSpatialContext {
  gpsSummary: string;
  inferredGps: IInferredGps;
  placeHints: string[];
  decisionReasons: string[];
}

export interface IResolveGpxSpatialContextInput {
  asset: Pick<IKtepAsset, 'capturedAt'>;
  gpxPaths: string[];
  matchToleranceMs?: number;
}

export interface IGpxPoint {
  lat: number;
  lng: number;
  time: string;
  path: string;
}

export async function resolveGpxSpatialContext(
  input: IResolveGpxSpatialContextInput,
): Promise<IGpxSpatialContext | null> {
  if (!input.asset.capturedAt || input.gpxPaths.length === 0) return null;

  const assetTimestamp = Date.parse(input.asset.capturedAt);
  if (Number.isNaN(assetTimestamp)) return null;

  const points = await loadGpxPointsFromPaths(input.gpxPaths);
  const matched = pickNearestPoint(
    points,
    assetTimestamp,
    input.matchToleranceMs ?? CDEFAULT_GPX_MATCH_TOLERANCE_MS,
  );
  if (!matched) return null;

  const gpsSummary = buildGpxSummary(matched, assetTimestamp);
  return {
    gpsSummary,
    inferredGps: {
      source: 'gpx',
      confidence: 0.95,
      lat: matched.lat,
      lng: matched.lng,
      summary: gpsSummary,
    },
    placeHints: [],
    decisionReasons: [
      'gpx-match',
      `gpx-match-delta-ms:${Math.abs(Date.parse(matched.time) - assetTimestamp)}`,
    ],
  };
}

export async function loadGpxPointsFromPaths(paths: string[]): Promise<IGpxPoint[]> {
  return (await Promise.all(paths.map(path => loadGpxPoints(path)))).flat();
}

export async function loadGpxPoints(filePath: string): Promise<IGpxPoint[]> {
  if (extname(filePath).toLowerCase() === '.json') {
    const merged = await loadProjectGpsMergedByPath(filePath);
    return merged?.points
      .filter(point => !Number.isNaN(Date.parse(point.time)))
      .map(point => ({
        lat: point.lat,
        lng: point.lng,
        time: point.time,
        path: point.sourcePath,
      })) ?? [];
  }

  const content = await readFile(filePath, 'utf-8').catch(() => '');
  if (!content) return [];

  const points: IGpxPoint[] = [];
  for (const match of content.matchAll(CGPX_POINT_PATTERN)) {
    const attrs = match[2] ?? '';
    const body = match[3] ?? '';
    const lat = parseCoordinate(readAttr(attrs, 'lat'));
    const lng = parseCoordinate(readAttr(attrs, 'lon') ?? readAttr(attrs, 'lng'));
    const time = readTime(body);
    if (lat == null || lng == null || !time) continue;
    if (Number.isNaN(Date.parse(time))) continue;
    points.push({
      lat,
      lng,
      time,
      path: filePath,
    });
  }
  return points;
}

function pickNearestPoint(
  points: IGpxPoint[],
  assetTimestamp: number,
  toleranceMs: number,
): IGpxPoint | null {
  let best: IGpxPoint | null = null;
  let bestDelta = Number.POSITIVE_INFINITY;

  for (const point of points) {
    const delta = Math.abs(Date.parse(point.time) - assetTimestamp);
    if (!Number.isFinite(delta) || delta > toleranceMs) continue;
    if (delta < bestDelta) {
      best = point;
      bestDelta = delta;
    }
  }

  return best;
}

function buildGpxSummary(point: IGpxPoint, assetTimestamp: number): string {
  const deltaSeconds = Math.round(Math.abs(Date.parse(point.time) - assetTimestamp) / 1000);
  return `gpx ${point.time} ${point.lat.toFixed(6)},${point.lng.toFixed(6)} Δ${deltaSeconds}s`;
}

function readAttr(attrs: string, name: string): string | undefined {
  const match = attrs.match(new RegExp(`${name}\\s*=\\s*"([^"]+)"`, 'iu'));
  return match?.[1]?.trim();
}

function readTime(body: string): string | undefined {
  const match = body.match(/<time>([^<]+)<\/time>/iu);
  return match?.[1]?.trim();
}

function parseCoordinate(value?: string): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
