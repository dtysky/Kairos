import { basename } from 'node:path';
import type { IKtepAsset, IMediaRoot } from '../../protocol/schema.js';
import {
  findManualItineraryGeoCacheEntry,
  loadManualItinerary,
  loadManualItineraryGeoCache,
  type ILoadedManualItinerary,
  type IManualItineraryGeoCache,
} from '../../store/index.js';
import {
  syncManualCaptureTimeBlockers,
  type IManualCaptureTimeBlocker,
} from './manual-capture-time.js';
import { extractFilenameCaptureTimeHint } from './capture-time.js';
import { formatDateInTimeZone } from './timezone-utils.js';

const COUT_OF_RANGE_TOLERANCE_DAYS = 2;

export interface IProjectTimelineBlocker extends IManualCaptureTimeBlocker {
  reasons: string[];
}

export class TimelineConsistencyError extends Error {
  blockers: IProjectTimelineBlocker[];

  constructor(blockers: IProjectTimelineBlocker[]) {
    super([
      `检测到 ${blockers.length} 条素材的拍摄时间与项目时间线明显不一致。`,
      '已把待校正素材追加到 config/manual-itinerary.md 的“素材时间校正”表格。',
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
  const [itinerary, geoCache] = await Promise.all([
    loadManualItinerary(input.projectRoot),
    loadManualItineraryGeoCache(input.projectRoot),
  ]);
  const blockers = detectProjectTimelineBlockers({
    assets: input.assets,
    roots: input.roots,
    itinerary,
    geoCache,
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
}): IProjectTimelineBlocker[] {
  const range = getItineraryDateRange(input.itinerary);
  const defaultTimezone = inferDefaultTimezone(input.geoCache);
  const knownRootIds = new Set(input.roots.map(root => root.id));
  const blockers: IProjectTimelineBlocker[] = [];

  for (const asset of input.assets) {
    if (asset.kind === 'audio') continue;

    const reasons: string[] = [];
    const source = asset.captureTimeSource ?? '';
    const filenameHint = extractFilenameCaptureTimeHint(
      basename(asset.sourcePath || asset.displayName || ''),
    );
    const effectiveTimezone = suggestTimezone(
      asset,
      input.itinerary,
      input.geoCache,
      filenameHint?.date ?? normalizeIsoDate(asset.capturedAt) ?? undefined,
    ) ?? defaultTimezone;
    const capturedDate = normalizeTimelineDate(asset.capturedAt, effectiveTimezone);

    if (
      range
      && capturedDate
      && isWeakCaptureTimeSource(source)
      && (
        isDateBeforeTolerance(capturedDate, range.startDate, COUT_OF_RANGE_TOLERANCE_DAYS)
        || isDateAfterTolerance(capturedDate, range.endDate, COUT_OF_RANGE_TOLERANCE_DAYS)
      )
    ) {
      reasons.push(
        `当前时间 ${capturedDate} 超出项目行程日期范围 ${range.startDate} ~ ${range.endDate}`,
      );
    }

    if (
      filenameHint?.date
      && capturedDate
      && source !== 'manual'
      && daysBetween(filenameHint.date, capturedDate) > COUT_OF_RANGE_TOLERANCE_DAYS
    ) {
      reasons.push(
        `文件名日期 ${filenameHint.date} 与当前时间 ${capturedDate} 相差 ${daysBetween(filenameHint.date, capturedDate)} 天`,
      );
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

function inferDefaultTimezone(geoCache: IManualItineraryGeoCache | null): string | undefined {
  if (!geoCache?.entries.length) return undefined;
  const counts = new Map<string, number>();
  for (const entry of geoCache.entries) {
    const timezone = entry.timezone?.trim();
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
  suggestedDate?: string,
): string | undefined {
  if (!suggestedDate || !geoCache?.entries.length) return undefined;

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

  if (matchingSegments.length !== 1) {
    return undefined;
  }

  for (const segment of matchingSegments) {
    const query = segment.location?.trim() || segment.to?.trim() || segment.from?.trim();
    if (!query) continue;
    const cached = findManualItineraryGeoCacheEntry(geoCache, query);
    if (cached?.timezone) {
      return cached.timezone;
    }
  }

  return undefined;
}
