import { basename } from 'node:path';
import type { IKtepAsset, IMediaRoot, IProjectPharosContext } from '../../protocol/schema.js';
import {
  findManualItineraryGeoCacheEntry,
  loadManualItinerary,
  loadManualItineraryGeoCache,
  loadProjectBriefConfig,
  type ILoadedManualItinerary,
  type IManualItineraryGeoCache,
} from '../../store/index.js';
import {
  syncManualCaptureTimeBlockers,
  type IManualCaptureTimeBlocker,
} from './manual-capture-time.js';
import { extractFilenameCaptureTimeHint } from './capture-time.js';
import { loadOrBuildProjectPharosContext } from '../pharos/context.js';
import { convertLocalDateTimeToIso, formatDateInTimeZone } from './timezone-utils.js';

const COUT_OF_RANGE_TOLERANCE_DAYS = 2;
const CBASE_DRIFT_THRESHOLD_MS = 5 * 60_000;
const CVIDEO_DRIFT_PADDING_MS = 2 * 60_000;
const CHOUR_MS = 60 * 60_000;

export interface IProjectTimelineBlocker extends IManualCaptureTimeBlocker {
  reasons: string[];
}

export class TimelineConsistencyError extends Error {
  blockers: IProjectTimelineBlocker[];

  constructor(blockers: IProjectTimelineBlocker[]) {
    super([
      `检测到 ${blockers.length} 条素材的拍摄时间与项目时间线明显不一致。`,
      '已把待校正素材同步到 Console 与 config/manual-itinerary.md 的“素材时间校正”区。',
      '请填写具体时间后重新运行 ingest，再继续后续流程。',
    ].join(' '));
    this.name = 'TimelineConsistencyError';
    this.blockers = blockers;
  }
}

export async function enforceProjectTimelineConsistency(input: {
  projectRoot: string;
  assets: IKtepAsset[];
  roots: IMediaRoot[];
}): Promise<IProjectTimelineBlocker[]> {
  const [itinerary, geoCache, projectBrief] = await Promise.all([
    loadManualItinerary(input.projectRoot),
    loadManualItineraryGeoCache(input.projectRoot),
    loadProjectBriefConfig(input.projectRoot).catch(() => null),
  ]);
  const pharosContext = projectBrief
    ? await loadOrBuildProjectPharosContext({
      projectRoot: input.projectRoot,
      includedTripIds: projectBrief.pharos?.includedTripIds ?? [],
    }).catch(() => null)
    : null;
  const blockers = detectProjectTimelineBlockers({
    assets: input.assets,
    roots: input.roots,
    itinerary,
    geoCache,
    pharosContext,
  });
  await syncManualCaptureTimeBlockers(input.projectRoot, blockers);
  if (blockers.length > 0) {
    throw new TimelineConsistencyError(blockers);
  }
  return blockers;
}

export function detectProjectTimelineBlockers(input: {
  assets: IKtepAsset[];
  roots: IMediaRoot[];
  itinerary: ILoadedManualItinerary;
  geoCache: IManualItineraryGeoCache | null;
  pharosContext?: IProjectPharosContext | null;
}): IProjectTimelineBlocker[] {
  const range = getItineraryDateRange(input.itinerary);
  const defaultTimezone = inferDefaultTimezone(input.geoCache, input.pharosContext ?? null);
  const knownRootIds = new Set(input.roots.map(root => root.id));
  const blockers: IProjectTimelineBlocker[] = [];

  for (const asset of input.assets) {
    if (asset.kind === 'audio') continue;

    const reasons: string[] = [];
    const source = asset.captureTimeSource ?? '';
    const weakSource = isWeakCaptureTimeSource(source);
    const filenameHint = extractFilenameCaptureTimeHint(
      basename(asset.sourcePath || asset.displayName || ''),
    );
    const effectiveTimezone = suggestTimezone(
      asset,
      input.itinerary,
      input.geoCache,
      input.pharosContext ?? null,
      filenameHint?.date ?? normalizeIsoDate(asset.capturedAt) ?? undefined,
    ) ?? defaultTimezone;
    const capturedDate = normalizeTimelineDate(asset.capturedAt, effectiveTimezone);

    if (
      weakSource
      && range
      && capturedDate
      && (
        isDateBeforeTolerance(capturedDate, range.startDate, COUT_OF_RANGE_TOLERANCE_DAYS)
        || isDateAfterTolerance(capturedDate, range.endDate, COUT_OF_RANGE_TOLERANCE_DAYS)
      )
    ) {
      reasons.push(
        `当前时间 ${capturedDate} 超出项目行程日期范围 ${range.startDate} ~ ${range.endDate}`,
      );
    }

    if (weakSource) {
      const driftReason = buildFilenameDriftReason(asset, filenameHint, effectiveTimezone);
      if (driftReason) reasons.push(driftReason);

      const pharosReason = buildPharosBoundaryReason(asset, input.pharosContext ?? null, effectiveTimezone);
      if (pharosReason) reasons.push(pharosReason);
    }

    if (reasons.length === 0) continue;

    blockers.push({
      rootRef: asset.ingestRootId && knownRootIds.has(asset.ingestRootId)
        ? asset.ingestRootId
        : undefined,
      sourcePath: asset.sourcePath,
      currentCapturedAt: asset.capturedAt,
      currentSource: asset.captureTimeSource,
      suggestedDate: filenameHint?.date,
      suggestedTime: filenameHint?.time,
      timezone: effectiveTimezone,
      note: reasons.join('；'),
      reasons,
    });
  }

  return blockers;
}

function getItineraryDateRange(itinerary: ILoadedManualItinerary): {
  startDate: string;
  endDate: string;
} | null {
  const dates = itinerary.segments
    .map(segment => segment.date)
    .filter(Boolean)
    .sort();
  if (dates.length === 0) return null;
  return {
    startDate: dates[0]!,
    endDate: dates[dates.length - 1]!,
  };
}

function buildFilenameDriftReason(
  asset: IKtepAsset,
  filenameHint: ReturnType<typeof extractFilenameCaptureTimeHint> | null,
  timezone?: string,
): string | null {
  if (!asset.capturedAt || !filenameHint?.date || !filenameHint.time) {
    return null;
  }

  const filenameIso = convertLocalDateTimeToIso(filenameHint.date, filenameHint.time, timezone);
  if (!filenameIso) return null;

  const capturedMs = Date.parse(asset.capturedAt);
  const filenameMs = Date.parse(filenameIso);
  if (!Number.isFinite(capturedMs) || !Number.isFinite(filenameMs)) {
    return null;
  }

  const residualMs = normalizeWholeHourResidual(Math.abs(capturedMs - filenameMs));
  const thresholdMs = asset.kind === 'video'
    ? Math.max(CBASE_DRIFT_THRESHOLD_MS, (asset.durationMs ?? 0) + CVIDEO_DRIFT_PADDING_MS)
    : CBASE_DRIFT_THRESHOLD_MS;
  if (residualMs <= thresholdMs) {
    return null;
  }

  return [
    `文件名时间 ${filenameHint.date} ${filenameHint.time}`,
    `与当前时间存在过大残余漂移 ${formatDurationForHumans(residualMs)}`,
    `（阈值 ${formatDurationForHumans(thresholdMs)}）`,
  ].join('');
}

function buildPharosBoundaryReason(
  asset: IKtepAsset,
  pharosContext: IProjectPharosContext | null,
  fallbackTimezone?: string,
): string | null {
  const capturedAt = asset.capturedAt;
  if (!capturedAt || !pharosContext?.trips.length) return null;

  const evaluations = pharosContext.trips
    .map(trip => evaluateTripBoundary(capturedAt, trip, fallbackTimezone))
    .filter((item): item is NonNullable<typeof item> => item != null);

  if (evaluations.length === 0) return null;
  if (evaluations.some(item => !item.outOfRange)) return null;

  const nearest = [...evaluations]
    .sort((left, right) => left.distanceDays - right.distanceDays)[0];
  if (!nearest) return null;

  return `当前时间 ${nearest.capturedDate} 超出 Pharos trip ${nearest.tripTitle} 的时间边界 ${nearest.rangeLabel}`;
}

function evaluateTripBoundary(
  capturedAt: string,
  trip: NonNullable<IProjectPharosContext>['trips'][number],
  fallbackTimezone?: string,
): {
  outOfRange: boolean;
  distanceDays: number;
  capturedDate: string;
  tripTitle: string;
  rangeLabel: string;
} | null {
  const timezone = trip.timezone?.trim() || fallbackTimezone;
  const capturedDate = normalizeTimelineDate(capturedAt, timezone);
  if (!capturedDate) return null;

  const rangeStart = trip.dateStart ?? trip.dateEnd;
  const rangeEnd = trip.dateEnd ?? trip.dateStart;
  if (!rangeStart || !rangeEnd) return null;

  const before = isDateBeforeTolerance(capturedDate, rangeStart, COUT_OF_RANGE_TOLERANCE_DAYS);
  const after = isDateAfterTolerance(capturedDate, rangeEnd, COUT_OF_RANGE_TOLERANCE_DAYS);
  const distanceDays = before
    ? daysBetween(capturedDate, rangeStart)
    : after
      ? daysBetween(capturedDate, rangeEnd)
      : 0;
  return {
    outOfRange: before || after,
    distanceDays,
    capturedDate,
    tripTitle: trip.title || trip.tripId,
    rangeLabel: `${rangeStart} ~ ${rangeEnd}`,
  };
}

function normalizeWholeHourResidual(diffMs: number): number {
  if (diffMs <= 0) return 0;
  const residual = diffMs % CHOUR_MS;
  return Math.min(residual, CHOUR_MS - residual);
}

function formatDurationForHumans(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m${String(seconds).padStart(2, '0')}s`;
}

function normalizeIsoDate(value?: string): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

function normalizeTimelineDate(value?: string, timezone?: string): string | null {
  if (!value) return null;
  if (timezone) {
    const zoned = formatDateInTimeZone(value, timezone);
    if (zoned?.date) {
      return zoned.date;
    }
  }
  return normalizeIsoDate(value);
}

function daysBetween(left: string, right: string): number {
  const leftMs = Date.parse(`${left}T00:00:00.000Z`);
  const rightMs = Date.parse(`${right}T00:00:00.000Z`);
  if (!Number.isFinite(leftMs) || !Number.isFinite(rightMs)) return Number.POSITIVE_INFINITY;
  return Math.abs(Math.round((leftMs - rightMs) / 86_400_000));
}

function isDateBeforeTolerance(date: string, lowerBound: string, toleranceDays: number): boolean {
  return date < lowerBound && daysBetween(date, lowerBound) > toleranceDays;
}

function isDateAfterTolerance(date: string, upperBound: string, toleranceDays: number): boolean {
  return date > upperBound && daysBetween(date, upperBound) > toleranceDays;
}

function isWeakCaptureTimeSource(source?: string): boolean {
  return source === 'filesystem'
    || source === 'filename'
    || source === 'container'
    || source === 'ffprobe-tag'
    || source === 'quicktime'
    || !source;
}

function inferDefaultTimezone(
  geoCache: IManualItineraryGeoCache | null,
  pharosContext: IProjectPharosContext | null,
): string | undefined {
  const counts = new Map<string, number>();
  for (const entry of geoCache?.entries ?? []) {
    const timezone = entry.timezone?.trim();
    if (!timezone) continue;
    counts.set(timezone, (counts.get(timezone) ?? 0) + 1);
  }
  for (const trip of pharosContext?.trips ?? []) {
    const timezone = trip.timezone?.trim();
    if (!timezone) continue;
    counts.set(timezone, (counts.get(timezone) ?? 0) + 1);
  }

  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1])[0]?.[0];
}

function suggestTimezone(
  asset: IKtepAsset,
  itinerary: ILoadedManualItinerary,
  geoCache: IManualItineraryGeoCache | null,
  pharosContext: IProjectPharosContext | null,
  suggestedDate?: string,
): string | undefined {
  if (!suggestedDate) return undefined;

  if (geoCache?.entries.length) {
    const matchingSegments = itinerary.segments.filter(segment => {
      if (segment.date !== suggestedDate) return false;
      if (segment.rootRef && asset.ingestRootId && segment.rootRef !== asset.ingestRootId) {
        return false;
      }
      if (segment.pathPrefix) {
        const normalizedPath = asset.sourcePath.replace(/\\/gu, '/').toLowerCase();
        if (!normalizedPath.startsWith(segment.pathPrefix.toLowerCase())) {
          return false;
        }
      }
      return true;
    });

    if (matchingSegments.length === 1) {
      const query = matchingSegments[0]?.location?.trim()
        || matchingSegments[0]?.to?.trim()
        || matchingSegments[0]?.from?.trim();
      if (query) {
        const cached = findManualItineraryGeoCacheEntry(geoCache, query);
        if (cached?.timezone) {
          return cached.timezone;
        }
      }
    }
  }

  const matchingTrips = (pharosContext?.trips ?? []).filter(trip => {
    const startDate = trip.dateStart ?? trip.dateEnd;
    const endDate = trip.dateEnd ?? trip.dateStart;
    if (!startDate || !endDate) return false;
    return suggestedDate >= startDate && suggestedDate <= endDate;
  });
  const uniqueTripTimezones = [...new Set(matchingTrips.map(trip => trip.timezone?.trim()).filter(Boolean))];
  if (uniqueTripTimezones.length === 1) {
    return uniqueTripTimezones[0];
  }

  return undefined;
}
