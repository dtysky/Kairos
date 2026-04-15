import type {
  EClipType,
  IInferredGps,
  IPharosMatch,
  IProjectPharosContext,
  IProjectPharosShot,
  IKtepAsset,
} from '../../protocol/schema.js';
import { loadGpxPoints, pickNearestTimedPoint, type IGpxPoint } from '../media/gpx-spatial.js';

const CDEFAULT_PHAROS_GPX_MATCH_TOLERANCE_MS = 5 * 60_000;

const gpxPointCache = new Map<string, Promise<IGpxPoint[]>>();

export interface IPharosTimedLocationCandidate {
  role: 'point' | 'start' | 'end';
  lat: number;
  lng: number;
  time: string;
  deltaMs: number;
  sourcePath: string;
}

export interface IPharosTimedSpatialContext {
  match: IPharosMatch;
  shot: IProjectPharosShot;
  timezone?: string;
  gpsSummary: string;
  decisionReasons: string[];
  locationCandidates: IPharosTimedLocationCandidate[];
  inferredGps?: IInferredGps;
}

export interface IResolvePharosTimedSpatialInput {
  asset: Pick<IKtepAsset, 'capturedAt' | 'durationMs'>;
  clipType: EClipType;
  pharosContext?: IProjectPharosContext | null;
  pharosMatches?: IPharosMatch[];
  sourceInMs?: number;
  sourceOutMs?: number;
  matchToleranceMs?: number;
}

export async function resolvePharosTimedSpatialContext(
  input: IResolvePharosTimedSpatialInput,
): Promise<IPharosTimedSpatialContext | null> {
  const topMatch = input.pharosMatches?.[0];
  if (!topMatch || !input.pharosContext || !input.asset.capturedAt) return null;

  const shot = input.pharosContext.shots.find(item =>
    item.ref.tripId === topMatch.ref.tripId
    && item.ref.shotId === topMatch.ref.shotId,
  );
  if (!shot) return null;

  const capturedAtMs = Date.parse(input.asset.capturedAt);
  if (!Number.isFinite(capturedAtMs)) return null;

  const trip = input.pharosContext.trips.find(item => item.tripId === shot.ref.tripId);
  const gpxPaths = input.pharosContext.gpxFiles
    .filter(file => file.tripId === shot.ref.tripId)
    .map(file => file.path);
  if (gpxPaths.length === 0) return null;

  const points = await loadCachedTripGpxPoints(gpxPaths);
  if (points.length === 0) return null;

  const toleranceMs = input.matchToleranceMs ?? CDEFAULT_PHAROS_GPX_MATCH_TOLERANCE_MS;
  const locationCandidates = isDriveClip(input.clipType)
    ? resolveDriveCandidates(points, capturedAtMs, input, toleranceMs)
    : resolvePointCandidates(points, capturedAtMs, input, toleranceMs);
  if (locationCandidates.length === 0) return null;

  const representative = isDriveClip(input.clipType)
    ? resolveDriveRepresentativePoint(points, capturedAtMs, input, toleranceMs, locationCandidates)
    : locationCandidates[0];
  const gpsSummary = buildPharosGpsSummary({
    shot,
    match: topMatch,
    locationCandidates,
    representative,
  });

  return {
    match: topMatch,
    shot,
    timezone: trip?.timezone,
    gpsSummary,
    decisionReasons: dedupeStrings([
      'pharos-match',
      `pharos-gpx-trip:${shot.ref.tripId}`,
      ...locationCandidates.map(candidate => `pharos-gpx-${candidate.role}:Δ${Math.round(candidate.deltaMs / 1000)}s`),
    ]),
    locationCandidates,
    inferredGps: representative
      ? {
        source: 'pharos',
        confidence: Math.max(0.35, Math.min(0.9, topMatch.confidence)),
        lat: representative.lat,
        lng: representative.lng,
        timezone: trip?.timezone,
        summary: gpsSummary,
      }
      : undefined,
  };
}

async function loadCachedTripGpxPoints(paths: string[]): Promise<IGpxPoint[]> {
  const results = await Promise.all(paths.map(async path => {
    const existing = gpxPointCache.get(path);
    if (existing) return existing;
    const loading = loadGpxPoints(path).catch(() => []);
    gpxPointCache.set(path, loading);
    return loading;
  }));
  return results.flat();
}

function resolveDriveCandidates(
  points: IGpxPoint[],
  capturedAtMs: number,
  input: IResolvePharosTimedSpatialInput,
  toleranceMs: number,
): IPharosTimedLocationCandidate[] {
  const startOffsetMs = resolveDriveStartOffsetMs(input);
  const endOffsetMs = resolveDriveEndOffsetMs(input, startOffsetMs);
  const candidates: IPharosTimedLocationCandidate[] = [];

  const startPoint = pickNearestTimedPoint(points, capturedAtMs + startOffsetMs, toleranceMs);
  if (startPoint) {
    candidates.push(buildTimedCandidate('start', startPoint, capturedAtMs + startOffsetMs));
  }

  const endPoint = pickNearestTimedPoint(points, capturedAtMs + endOffsetMs, toleranceMs);
  if (endPoint) {
    candidates.push(buildTimedCandidate('end', endPoint, capturedAtMs + endOffsetMs));
  }

  return dedupeTimedCandidates(candidates);
}

function resolvePointCandidates(
  points: IGpxPoint[],
  capturedAtMs: number,
  input: IResolvePharosTimedSpatialInput,
  toleranceMs: number,
): IPharosTimedLocationCandidate[] {
  const targetMs = capturedAtMs + resolvePointOffsetMs(input);
  const point = pickNearestTimedPoint(points, targetMs, toleranceMs);
  return point ? [buildTimedCandidate('point', point, targetMs)] : [];
}

function resolveDriveRepresentativePoint(
  points: IGpxPoint[],
  capturedAtMs: number,
  input: IResolvePharosTimedSpatialInput,
  toleranceMs: number,
  candidates: IPharosTimedLocationCandidate[],
): IPharosTimedLocationCandidate | undefined {
  const midpointOffsetMs = resolvePointOffsetMs(input);
  const midpoint = pickNearestTimedPoint(points, capturedAtMs + midpointOffsetMs, toleranceMs);
  if (midpoint) {
    return buildTimedCandidate('point', midpoint, capturedAtMs + midpointOffsetMs);
  }
  return candidates[0];
}

function resolveDriveStartOffsetMs(
  input: Pick<IResolvePharosTimedSpatialInput, 'sourceInMs'>,
): number {
  return typeof input.sourceInMs === 'number' ? Math.max(0, input.sourceInMs) : 0;
}

function resolveDriveEndOffsetMs(
  input: Pick<IResolvePharosTimedSpatialInput, 'asset' | 'sourceInMs' | 'sourceOutMs'>,
  startOffsetMs: number,
): number {
  const sourceOutMs = typeof input.sourceOutMs === 'number'
    ? Math.max(0, input.sourceOutMs)
    : undefined;
  const durationMs = typeof input.asset.durationMs === 'number'
    ? Math.max(0, input.asset.durationMs)
    : undefined;
  const candidate = sourceOutMs ?? durationMs ?? startOffsetMs;
  return Math.max(startOffsetMs, candidate);
}

function resolvePointOffsetMs(
  input: Pick<IResolvePharosTimedSpatialInput, 'asset' | 'sourceInMs' | 'sourceOutMs'>,
): number {
  const sourceInMs = typeof input.sourceInMs === 'number'
    ? Math.max(0, input.sourceInMs)
    : undefined;
  const sourceOutMs = typeof input.sourceOutMs === 'number'
    ? Math.max(0, input.sourceOutMs)
    : undefined;
  if (sourceInMs != null && sourceOutMs != null && sourceOutMs >= sourceInMs) {
    return Math.round((sourceInMs + sourceOutMs) / 2);
  }
  if (sourceInMs != null) return sourceInMs;
  if (sourceOutMs != null) return sourceOutMs;
  const durationMs = typeof input.asset.durationMs === 'number'
    ? Math.max(0, input.asset.durationMs)
    : undefined;
  return durationMs ? Math.round(durationMs / 2) : 0;
}

function buildTimedCandidate(
  role: IPharosTimedLocationCandidate['role'],
  point: IGpxPoint,
  targetMs: number,
): IPharosTimedLocationCandidate {
  return {
    role,
    lat: point.lat,
    lng: point.lng,
    time: point.time,
    deltaMs: Math.abs(Date.parse(point.time) - targetMs),
    sourcePath: point.path,
  };
}

function buildPharosGpsSummary(input: {
  shot: IProjectPharosShot;
  match: IPharosMatch;
  locationCandidates: IPharosTimedLocationCandidate[];
  representative?: IPharosTimedLocationCandidate;
}): string {
  const locationSummary = input.locationCandidates
    .map(candidate => (
      `${candidate.role}:${candidate.time}@${candidate.lat.toFixed(6)},${candidate.lng.toFixed(6)}`
    ))
    .join(' ');
  return dedupeStrings([
    'pharos-gpx',
    input.match.tripTitle,
    input.match.dayTitle,
    input.shot.location,
    input.shot.type,
    locationSummary,
    input.representative ? `point:${input.representative.lat.toFixed(6)},${input.representative.lng.toFixed(6)}` : undefined,
  ]).join(' ');
}

function dedupeTimedCandidates(
  candidates: IPharosTimedLocationCandidate[],
): IPharosTimedLocationCandidate[] {
  const seen = new Set<string>();
  const deduped: IPharosTimedLocationCandidate[] = [];
  for (const candidate of candidates) {
    const key = `${candidate.role}:${candidate.time}:${candidate.lat.toFixed(6)}:${candidate.lng.toFixed(6)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(candidate);
  }
  return deduped;
}

function isDriveClip(clipType: EClipType): boolean {
  return clipType === 'drive';
}

function dedupeStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.map(value => value?.trim()).filter(Boolean) as string[])];
}
