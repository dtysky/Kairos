import type { IInferredGps, IKtepAsset, IMediaRoot } from '../../protocol/schema.js';
import type { ILoadedManualItinerary } from '../../store/spatial-context.js';
import { formatDateInTimeZone } from './timezone-utils.js';

export interface IManualSpatialContext {
  gpsSummary?: string;
  inferredGps?: IInferredGps;
  placeHints: string[];
  transport?: 'drive' | 'walk' | 'train' | 'flight' | 'boat' | 'mixed';
  decisionReasons: string[];
}

export interface IInferManualItineraryGpsInput {
  asset: Pick<IKtepAsset, 'capturedAt' | 'sourcePath'>;
  root?: Pick<IMediaRoot, 'id' | 'label'>;
  itinerary: ILoadedManualItinerary;
  resolveTimezoneFromLocation: (location: string) => Promise<string | null>;
  geocodeLocation: (location: string) => Promise<{ lat: number; lng: number } | null>;
}

interface IResolvedManualSegment {
  segment: ILoadedManualItinerary['segments'][number];
  timezone: string;
  locationText: string;
  coordinates: { lat: number; lng: number };
}

export async function inferManualItineraryGps(
  input: IInferManualItineraryGpsInput,
): Promise<IManualSpatialContext | null> {
  const matched = await pickManualItinerarySegment(input);
  if (!matched) return null;

  const placeHints = dedupeStrings([
    matched.segment.location,
    ...splitManualPlaceHints(matched.segment.location),
    matched.segment.from,
    matched.segment.to,
    ...(matched.segment.via ?? []),
  ]);

  const gpsSummary = buildManualSpatialSummary(matched.segment, matched.timezone);
  return {
    gpsSummary,
    inferredGps: {
      source: 'derived-track',
      derivedOriginType: 'manual-itinerary-derived',
      confidence: 0.45,
      lat: matched.coordinates.lat,
      lng: matched.coordinates.lng,
      timezone: matched.timezone,
      matchedItinerarySegmentId: matched.segment.id,
      locationText: matched.locationText,
      summary: gpsSummary,
    },
    placeHints,
    transport: matched.segment.transport,
    decisionReasons: dedupeStrings([
      'manual-itinerary-match',
      'manual-itinerary-gps',
      matched.segment.transport ? `manual-transport:${matched.segment.transport}` : undefined,
      placeHints.length > 0 ? `manual-spatial-hints:${placeHints.length}` : undefined,
    ]),
  };
}

async function pickManualItinerarySegment(
  input: IInferManualItineraryGpsInput,
): Promise<IResolvedManualSegment | null> {
  if (!input.asset.capturedAt || input.itinerary.segments.length === 0) return null;

  let best: IResolvedManualSegment | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;

  for (const segment of input.itinerary.segments) {
    if (!matchesManualItineraryRoot(segment.rootRef, input.root)) continue;
    if (!matchesManualItineraryPath(segment.pathPrefix, input.asset.sourcePath, input.root)) continue;

    const locationText = buildManualLocationText(segment);
    if (!locationText) continue;

    const timezone = (await input.resolveTimezoneFromLocation(locationText))?.trim();
    if (!timezone) continue;

    const localCapture = formatDateInTimeZone(input.asset.capturedAt, timezone);
    if (!localCapture) continue;
    if (localCapture.date !== segment.date) continue;
    if (!matchesManualItineraryTimeWindow(localCapture.hourMinute, segment.startLocalTime, segment.endLocalTime)) {
      continue;
    }

    const coordinates = await input.geocodeLocation(locationText);
    if (!coordinates) continue;

    const score = (segment.pathPrefix ? 10000 + segment.pathPrefix.length : 0)
      + (segment.rootRef ? 1000 : 0)
      + (segment.startLocalTime || segment.endLocalTime ? 10 : 0)
      + (segment.location ? 5 : 0)
      + (segment.transport ? 2 : 0);

    if (score > bestScore) {
      best = {
        segment,
        timezone,
        locationText,
        coordinates,
      };
      bestScore = score;
    }
  }

  return best;
}

function buildManualLocationText(
  segment: ILoadedManualItinerary['segments'][number],
): string | null {
  const parts = [
    segment.location,
    segment.from,
    ...(segment.via ?? []),
    segment.to,
  ]
    .map(item => item?.trim())
    .filter(Boolean) as string[];

  return parts.length > 0 ? parts.join(' / ') : null;
}

function matchesManualItineraryRoot(
  rootRef: string | undefined,
  root?: Pick<IMediaRoot, 'id' | 'label'>,
): boolean {
  if (!rootRef) return true;
  const normalized = rootRef.trim().toLowerCase();
  return normalized === (root?.id ?? '').trim().toLowerCase()
    || normalized === (root?.label ?? '').trim().toLowerCase();
}

function matchesManualItineraryPath(
  pathPrefix: string | undefined,
  sourcePath: string,
  root?: Pick<IMediaRoot, 'id' | 'label'>,
): boolean {
  if (!pathPrefix) return true;
  const pathCandidates = buildPortablePathCandidates(sourcePath, root);
  return pathCandidates.some(candidate => candidate === pathPrefix || candidate.startsWith(`${pathPrefix}/`));
}

function matchesManualItineraryTimeWindow(
  localTime: string,
  startLocalTime?: string,
  endLocalTime?: string,
): boolean {
  if (!startLocalTime && !endLocalTime) return true;

  const time = parseHourMinute(localTime);
  const start = parseHourMinute(startLocalTime ?? '00:00');
  const end = parseHourMinute(endLocalTime ?? '23:59');
  if (time == null || start == null || end == null) return false;

  if (end >= start) {
    return time >= start && time <= end;
  }
  return time >= start || time <= end;
}

function buildManualSpatialSummary(
  segment: ILoadedManualItinerary['segments'][number],
  timezone: string,
): string {
  const route = segment.location
    ?? ([segment.from, segment.to].filter(Boolean).join(' -> ')
      || (segment.via ?? []).join(' -> '));
  const timeWindow = segment.startLocalTime && segment.endLocalTime
    ? `${segment.startLocalTime}-${segment.endLocalTime}`
    : 'all-day';
  const transport = segment.transport ? ` ${segment.transport}` : '';
  const notes = segment.notes ? `; ${segment.notes}` : '';
  return `derived-track manual-itinerary-derived ${segment.date} ${timeWindow} ${route}${transport} @${timezone}${notes}`.trim();
}

function splitManualPlaceHints(value?: string): string[] {
  if (!value) return [];
  return value
    .split(/[、,/，>|→-]+/u)
    .map(item => item.trim())
    .filter(Boolean);
}

function dedupeStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.map(value => value?.trim()).filter(Boolean) as string[])];
}

function normalizePortablePath(value: string): string {
  return value
    .trim()
    .replace(/\\/gu, '/')
    .replace(/^\.?\//u, '')
    .replace(/\/+/gu, '/')
    .replace(/\/$/u, '')
    .toLowerCase();
}

function buildPortablePathCandidates(
  sourcePath: string,
  root?: Pick<IMediaRoot, 'id' | 'label'>,
): string[] {
  const normalizedSource = normalizePortablePath(sourcePath);
  const candidates = new Set<string>([normalizedSource]);
  const normalizedRootLabel = root?.label ? normalizePortablePath(root.label) : undefined;
  const normalizedRootId = root?.id ? normalizePortablePath(root.id) : undefined;

  if (normalizedRootLabel) {
    candidates.add(`${normalizedRootLabel}/${normalizedSource}`);
  }
  if (normalizedRootId) {
    candidates.add(`${normalizedRootId}/${normalizedSource}`);
  }

  return [...candidates];
}

function parseHourMinute(value?: string): number | null {
  if (!value) return null;
  const match = value.match(/^(\d{2}):(\d{2})$/u);
  if (!match?.[1] || !match[2]) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  return hour * 60 + minute;
}
