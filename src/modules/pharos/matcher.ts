import type {
  IAssetCoarseReport,
  IPharosMatch,
  IProjectPharosContext,
  IProjectPharosShot,
  ISpatialEvidence,
  IKtepAsset,
} from '../../protocol/schema.js';
import type { IManualSpatialContext } from '../media/manual-spatial.js';

const CTIME_NEAR_TOLERANCE_MS = 30 * 60_000;
const CTIME_WITHIN_TOLERANCE_MS = 5 * 60_000;
const CGPS_NEAR_KM = 1.5;

export interface IMatchAssetToPharosInput {
  asset: Pick<IKtepAsset, 'sourcePath' | 'capturedAt' | 'metadata' | 'embeddedGps'>;
  context: IProjectPharosContext | null;
  report?: Pick<IAssetCoarseReport, 'clipTypeGuess' | 'summary' | 'placeHints' | 'labels' | 'inferredGps'> & {
    spatialEvidence?: Array<Pick<ISpatialEvidence, 'lat' | 'lng' | 'confidence' | 'tier' | 'locationText'>>;
  };
  limit?: number;
}

export function matchAssetToPharos(
  input: IMatchAssetToPharosInput,
): IPharosMatch[] {
  if (!input.context || input.context.status === 'empty' || input.context.shots.length === 0) {
    return [];
  }

  const matches = input.context.shots.map(shot => scoreShotMatch(shot, input))
    .filter((item): item is IScoredMatch => item != null && item.score > 0);

  return matches
    .sort((left, right) =>
      right.score - left.score
      || left.match.ref.tripId.localeCompare(right.match.ref.tripId)
      || left.match.ref.shotId.localeCompare(right.match.ref.shotId))
    .slice(0, input.limit ?? 3)
    .map(item => item.match);
}

export function resolvePharosSpatialContext(
  input: IMatchAssetToPharosInput,
): IManualSpatialContext | null {
  const matches = matchAssetToPharos({ ...input, limit: 3 });
  for (const match of matches) {
    const shot = input.context?.shots.find(item =>
      item.ref.tripId === match.ref.tripId
      && item.ref.shotId === match.ref.shotId,
    );
    if (!shot) continue;

    const coordinates = resolveShotCoordinates(shot);
    if (!coordinates) continue;

    const placeHints = dedupeStrings([
      shot.location,
      shot.dayTitle,
      shot.tripTitle,
      ...tokenize(shot.description).slice(0, 4),
    ]);
    const gpsSummary = buildPharosGpsSummary(shot, match);
    return {
      gpsSummary,
      inferredGps: {
        source: 'pharos',
        confidence: Math.max(0.35, Math.min(0.85, match.confidence)),
        lat: coordinates.lat,
        lng: coordinates.lng,
        locationText: shot.location,
        summary: gpsSummary,
        timezone: input.context?.trips.find(item => item.tripId === shot.ref.tripId)?.timezone,
      },
      placeHints,
      transport: shot.type === 'continuous' ? 'drive' : undefined,
      decisionReasons: dedupeStrings([
        'pharos-match',
        ...match.matchReasons,
      ]),
    };
  }

  return null;
}

interface IScoredMatch {
  score: number;
  match: IPharosMatch;
}

function scoreShotMatch(
  shot: IProjectPharosShot,
  input: IMatchAssetToPharosInput,
): IScoredMatch | null {
  const reasons: string[] = [];
  let score = 0;

  const timeScore = scoreTimeMatch(input.asset.capturedAt, shot, reasons);
  score += timeScore;

  const gpsScore = scoreGpsMatch(resolveBestGpsCandidate(input.report), shot, reasons);
  score += gpsScore;

  const deviceScore = scoreDeviceMatch(input.asset, shot, reasons);
  score += deviceScore;

  const typeScore = scoreClipTypeMatch(input.report?.clipTypeGuess, shot, reasons);
  score += typeScore;

  const textScore = scoreTextMatch(input.report, shot, reasons);
  score += textScore;

  if (shot.status === 'abandoned') {
    score -= 0.5;
  } else if (shot.status === 'expected') {
    score += 0.4;
  }

  if (score <= 0) return null;
  return {
    score,
    match: {
      ref: shot.ref,
      confidence: normalizeScore(score),
      status: shot.status,
      tripTitle: shot.tripTitle,
      dayTitle: shot.dayTitle,
      matchReasons: dedupeStrings(reasons),
    },
  };
}

function scoreTimeMatch(
  capturedAt: string | undefined,
  shot: IProjectPharosShot,
  reasons: string[],
): number {
  if (!capturedAt) return 0;
  const capturedMs = Date.parse(capturedAt);
  if (!Number.isFinite(capturedMs)) return 0;

  const startMs = parseTime(shot.actualTimeStart ?? shot.timeWindowStart);
  const endMs = parseTime(shot.actualTimeEnd ?? shot.timeWindowEnd);

  if (startMs != null && endMs != null) {
    if (capturedMs >= startMs - CTIME_WITHIN_TOLERANCE_MS && capturedMs <= endMs + CTIME_WITHIN_TOLERANCE_MS) {
      reasons.push('time:within-window');
      return shot.type === 'continuous' ? 6.5 : 7;
    }
    const delta = Math.min(Math.abs(capturedMs - startMs), Math.abs(capturedMs - endMs));
    if (delta <= CTIME_NEAR_TOLERANCE_MS) {
      reasons.push(`time:near-window-${Math.round(delta / 60_000)}m`);
      return Math.max(1, 4 - delta / CTIME_NEAR_TOLERANCE_MS * 2.5);
    }
    return 0;
  }

  const pointMs = startMs ?? endMs;
  if (pointMs == null) return 0;
  const delta = Math.abs(capturedMs - pointMs);
  if (delta <= CTIME_WITHIN_TOLERANCE_MS) {
    reasons.push(`time:near-point-${Math.round(delta / 60_000)}m`);
    return 5;
  }
  if (delta <= CTIME_NEAR_TOLERANCE_MS) {
    reasons.push(`time:soft-point-${Math.round(delta / 60_000)}m`);
    return 2;
  }
  return 0;
}

function scoreGpsMatch(
  inferredGps: { lat: number; lng: number; confidence?: number } | undefined,
  shot: IProjectPharosShot,
  reasons: string[],
): number {
  if (!inferredGps) return 0;
  const shotCoordinates = resolveShotCoordinates(shot);
  if (!shotCoordinates) return 0;

  const distanceKm = haversineKm(
    inferredGps.lat,
    inferredGps.lng,
    shotCoordinates.lat,
    shotCoordinates.lng,
  );
  if (!Number.isFinite(distanceKm)) return 0;
  if (distanceKm <= CGPS_NEAR_KM) {
    reasons.push(`gps:${distanceKm.toFixed(1)}km`);
    return Math.max(0.8, 3 - distanceKm);
  }
  return 0;
}

function scoreDeviceMatch(
  asset: IMatchAssetToPharosInput['asset'],
  shot: IProjectPharosShot,
  reasons: string[],
): number {
  const assetTokens = collectAssetDeviceTokens(asset);
  if (assetTokens.length === 0) return 0;
  const shotTokens = dedupeStrings([
    shot.device,
    ...shot.devices,
  ].flatMap(token => tokenizeDeviceToken(token ?? '')));
  const overlap = assetTokens.filter(token => shotTokens.includes(token));
  if (overlap.length === 0) return 0;
  reasons.push(`device:${overlap[0]}`);
  return shot.type === 'continuous' ? 2.2 : 1.6;
}

function scoreClipTypeMatch(
  clipTypeGuess: IAssetCoarseReport['clipTypeGuess'] | undefined,
  shot: IProjectPharosShot,
  reasons: string[],
): number {
  if (!clipTypeGuess) return 0;
  const mapped = mapPharosShotTypeToClipType(shot.type);
  if (mapped !== clipTypeGuess) return 0;
  reasons.push(`clip-type:${clipTypeGuess}`);
  return clipTypeGuess === 'drive' || clipTypeGuess === 'aerial' ? 1.6 : 1.2;
}

function scoreTextMatch(
  report: IMatchAssetToPharosInput['report'] | undefined,
  shot: IProjectPharosShot,
  reasons: string[],
): number {
  if (!report) return 0;
  const targetTokens = dedupeStrings([
    ...tokenize(shot.location),
    ...tokenize(shot.description),
    shot.dayTitle,
    shot.tripTitle,
  ]);
  if (targetTokens.length === 0) return 0;

  const sourceTokens = dedupeStrings([
    ...(report.placeHints ?? []),
    ...(report.labels ?? []),
    ...tokenize(report.summary ?? ''),
  ]);
  const overlap = sourceTokens.filter(token => targetTokens.includes(token));
  if (overlap.length === 0) return 0;
  reasons.push(`context:${overlap.length}`);
  return Math.min(2.5, overlap.length * 0.6);
}

function collectAssetDeviceTokens(
  asset: IMatchAssetToPharosInput['asset'],
): string[] {
  const tokens = new Set<string>();
  const metadata = asset.metadata && typeof asset.metadata === 'object'
    ? asset.metadata
    : {};
  for (const [key, value] of Object.entries(metadata)) {
    if (!/device|camera|model|make/i.test(key)) continue;
    if (typeof value === 'string') {
      for (const token of tokenizeDeviceToken(value)) tokens.add(token);
    }
  }
  for (const token of tokenizeDeviceToken(asset.sourcePath)) {
    tokens.add(token);
  }
  return [...tokens];
}

function resolveBestGpsCandidate(
  report: IMatchAssetToPharosInput['report'] | undefined,
): { lat: number; lng: number; confidence?: number } | undefined {
  const spatialCandidate = (report?.spatialEvidence ?? [])
    .filter(item => typeof item.lat === 'number' && typeof item.lng === 'number')
    .sort((left, right) => (right.confidence ?? 0) - (left.confidence ?? 0))[0];
  if (spatialCandidate) {
    return {
      lat: spatialCandidate.lat as number,
      lng: spatialCandidate.lng as number,
      confidence: spatialCandidate.confidence,
    };
  }
  if (report?.inferredGps) {
    return {
      lat: report.inferredGps.lat,
      lng: report.inferredGps.lng,
      confidence: report.inferredGps.confidence,
    };
  }
  return undefined;
}

function tokenizeDeviceToken(input: string): string[] {
  return input
    .split(/[^a-zA-Z0-9]+/u)
    .map(token => token.trim().toLowerCase())
    .filter(token => token.length >= 2);
}

function tokenize(input: string): string[] {
  return input
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fa5]+/u)
    .map(token => token.trim())
    .filter(token => token.length >= 2);
}

function dedupeStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.map(value => value?.trim()).filter(Boolean) as string[])];
}

function resolveShotCoordinates(shot: IProjectPharosShot): { lat: number; lng: number } | null {
  const actualPoint = shot.actualGpsStart ?? shot.actualGpsEnd;
  if (actualPoint) {
    return { lng: actualPoint[0], lat: actualPoint[1] };
  }
  if (shot.gps) {
    return { lng: shot.gps[0], lat: shot.gps[1] };
  }
  if (shot.gpsStart && shot.gpsEnd) {
    return {
      lng: (shot.gpsStart[0] + shot.gpsEnd[0]) / 2,
      lat: (shot.gpsStart[1] + shot.gpsEnd[1]) / 2,
    };
  }
  const fallback = shot.gpsStart ?? shot.gpsEnd;
  return fallback ? { lng: fallback[0], lat: fallback[1] } : null;
}

function buildPharosGpsSummary(shot: IProjectPharosShot, match: IPharosMatch): string {
  return [
    'pharos',
    shot.tripTitle,
    shot.dayTitle,
    shot.location,
    shot.type,
    match.status ? `status:${match.status}` : '',
  ].filter(Boolean).join(' ');
}

function parseTime(value: string | undefined): number | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function mapPharosShotTypeToClipType(type: string): IAssetCoarseReport['clipTypeGuess'] {
  switch (type) {
    case 'continuous':
      return 'drive';
    case 'timelapse':
      return 'timelapse';
    case 'aerial':
      return 'aerial';
    default:
      return 'unknown';
  }
}

function normalizeScore(score: number): number {
  return Math.max(0.05, Math.min(0.99, score / 10));
}

function haversineKm(latA: number, lngA: number, latB: number, lngB: number): number {
  const toRadians = (value: number) => value * Math.PI / 180;
  const earthRadiusKm = 6371;
  const deltaLat = toRadians(latB - latA);
  const deltaLng = toRadians(lngB - lngA);
  const a = Math.sin(deltaLat / 2) ** 2
    + Math.cos(toRadians(latA)) * Math.cos(toRadians(latB)) * Math.sin(deltaLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return earthRadiusKm * c;
}
