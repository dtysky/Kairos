import type { EDerivedTrackOriginType, IKtepAsset } from '../../protocol/schema.js';
import {
  loadAssets,
  loadManualItinerary,
  writeProjectDerivedTrack,
  type IProjectDerivedTrack,
  type IProjectDerivedTrackEntry,
} from '../../store/index.js';
import { resolveEmbeddedGpsContext } from './gps-embedded.js';
import { convertLocalDateTimeToIso } from './timezone-utils.js';

const CEMBEDDED_DERIVED_CONFIDENCE = 0.78;
const CMANUAL_DERIVED_CONFIDENCE = 0.45;

export interface IRefreshProjectDerivedTrackCacheInput {
  projectRoot: string;
  resolveTimezoneFromLocation?: (location: string) => Promise<string | null>;
  geocodeLocation?: (location: string) => Promise<{ lat: number; lng: number } | null>;
}

export async function refreshProjectDerivedTrackCache(
  input: IRefreshProjectDerivedTrackCacheInput,
): Promise<IProjectDerivedTrack> {
  const [assets, itinerary] = await Promise.all([
    loadAssets(input.projectRoot),
    loadManualItinerary(input.projectRoot),
  ]);

  const entries = [
    ...buildEmbeddedDerivedEntries(assets),
    ...await buildManualDerivedEntries(itinerary.segments, input),
  ].sort(compareDerivedTrackEntries);

  const derivedTrack: IProjectDerivedTrack = {
    schemaVersion: '1.0',
    updatedAt: new Date().toISOString(),
    entryCount: entries.length,
    entries,
  };
  await writeProjectDerivedTrack(input.projectRoot, derivedTrack);
  return derivedTrack;
}

function buildEmbeddedDerivedEntries(
  assets: IKtepAsset[],
): IProjectDerivedTrackEntry[] {
  const entries: IProjectDerivedTrackEntry[] = [];

  for (const asset of assets) {
    if (!asset.capturedAt || Number.isNaN(Date.parse(asset.capturedAt))) continue;
    const embedded = resolveEmbeddedGpsContext(asset);
    if (!embedded?.inferredGps) continue;

    entries.push({
      id: `embedded-derived:${asset.id}`,
      originType: 'embedded-derived',
      matchKind: 'point',
      lat: embedded.inferredGps.lat,
      lng: embedded.inferredGps.lng,
      confidence: CEMBEDDED_DERIVED_CONFIDENCE,
      time: asset.capturedAt,
      sourceAssetId: asset.id,
      sourcePath: asset.sourcePath,
      summary: buildDerivedTrackSummary(
        'embedded-derived',
        `${asset.capturedAt} ${embedded.inferredGps.lat.toFixed(6)},${embedded.inferredGps.lng.toFixed(6)} ${asset.displayName}`,
      ),
    });
  }

  return entries;
}

async function buildManualDerivedEntries(
  segments: Array<{
    id: string;
    date: string;
    startLocalTime?: string;
    endLocalTime?: string;
    rootRef?: string;
    pathPrefix?: string;
    location?: string;
    from?: string;
    to?: string;
    via?: string[];
    transport?: 'drive' | 'walk' | 'train' | 'flight' | 'boat' | 'mixed';
    notes?: string;
  }>,
  input: IRefreshProjectDerivedTrackCacheInput,
): Promise<IProjectDerivedTrackEntry[]> {
  if (!input.resolveTimezoneFromLocation || !input.geocodeLocation) return [];

  const entries: IProjectDerivedTrackEntry[] = [];
  for (const segment of segments) {
    const locationText = buildManualLocationText(segment);
    if (!locationText) continue;

    const timezone = (await input.resolveTimezoneFromLocation(locationText))?.trim();
    if (!timezone) continue;

    const coordinates = await input.geocodeLocation(locationText);
    if (!coordinates) continue;

    const bounds = buildManualUtcBounds(segment.date, segment.startLocalTime, segment.endLocalTime, timezone);
    if (!bounds) continue;

    entries.push({
      id: `manual-itinerary-derived:${segment.id}`,
      originType: 'manual-itinerary-derived',
      matchKind: 'window',
      lat: coordinates.lat,
      lng: coordinates.lng,
      confidence: CMANUAL_DERIVED_CONFIDENCE,
      time: bounds.time,
      startTime: bounds.startTime,
      endTime: bounds.endTime,
      timezone,
      matchedItinerarySegmentId: segment.id,
      locationText,
      transport: segment.transport,
      rootRef: segment.rootRef,
      pathPrefix: segment.pathPrefix,
      summary: buildDerivedTrackSummary(
        'manual-itinerary-derived',
        `${bounds.startTime}-${bounds.endTime} ${locationText}`,
      ),
    });
  }

  return entries;
}

function buildManualLocationText(
  segment: {
    location?: string;
    from?: string;
    to?: string;
    via?: string[];
  },
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

function buildManualUtcBounds(
  date: string,
  startLocalTime: string | undefined,
  endLocalTime: string | undefined,
  timeZone: string,
): { time: string; startTime: string; endTime: string } | null {
  const startTimeLocal = startLocalTime ?? '00:00';
  const endTimeLocal = endLocalTime ?? '23:59';
  const startTime = convertLocalDateTimeToIso(date, startTimeLocal, timeZone);
  if (!startTime) return null;

  const endDate = endLocalTime && startLocalTime && endLocalTime < startLocalTime
    ? shiftDate(date, 1)
    : date;
  const endTime = convertLocalDateTimeToIso(endDate, endTimeLocal, timeZone);
  if (!endTime) return null;

  const midpointMs = Math.round((Date.parse(startTime) + Date.parse(endTime)) / 2);
  if (!Number.isFinite(midpointMs)) return null;

  return {
    time: new Date(midpointMs).toISOString(),
    startTime,
    endTime,
  };
}

function shiftDate(date: string, days: number): string {
  const base = new Date(`${date}T00:00:00.000Z`);
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

function compareDerivedTrackEntries(
  left: IProjectDerivedTrackEntry,
  right: IProjectDerivedTrackEntry,
): number {
  const leftTime = left.startTime ?? left.time ?? '';
  const rightTime = right.startTime ?? right.time ?? '';
  if (leftTime !== rightTime) return leftTime.localeCompare(rightTime);
  return left.id.localeCompare(right.id);
}

function buildDerivedTrackSummary(
  originType: EDerivedTrackOriginType,
  body: string,
): string {
  return `derived-track ${originType} ${body}`.trim();
}
