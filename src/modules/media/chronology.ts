import { createHash } from 'node:crypto';
import type {
  IAssetCoarseReport,
  IChronologyAssetIndex,
  IChronologyEvent,
  IInferredGps,
  IKtepAsset,
  IKtepSlice,
  IMediaRoot,
  IProjectChronology,
  IProjectPharosContext,
  IProjectPharosShot,
} from '../../protocol/schema.js';
import {
  formatReverseGeocodeLocationKey,
  type IReverseGeocodeCacheEntry,
} from '../../store/reverse-geocode-cache.js';
import type { IReverseGeocodeService } from './reverse-geocode.js';

const CCHRONOLOGY_GPS_MATCH_TOLERANCE_MS = 5 * 60_000;
const CDERIVED_TRACK_MATCH_TOLERANCE_MS = 15 * 60_000;
const CSTATIONARY_SPAN_DISTANCE_M = 200;
const CSTATIONARY_NEIGHBOR_DISTANCE_M = 400;
const CEVENT_CONTINUITY_GAP_MS = 5 * 60_000;
const CMOVING_EVENT_CONTINUITY_MAX_SPEED_MPS = 55;
const CROUTE_COMPANION_GAP_MS = 30_000;
const CPHOTO_ATTACH_GAP_MS = 5 * 60_000;
const CCHRONOLOGY_PROGRESS_BATCH_SIZE = 100;
const CPHAROS_POINT_MIN_OVERLAP_MS = 3_000;

export interface IChronologyTimedPoint {
  lat: number;
  lng: number;
  time: string;
  path?: string;
  tripId?: string;
  locationText?: string;
}

export interface IChronologyDerivedTrackEntry {
  id?: string;
  originType?: string;
  matchKind: 'point' | 'window';
  lat: number;
  lng: number;
  confidence?: number;
  time?: string;
  startTime?: string;
  endTime?: string;
  timezone?: string;
  sourceAssetId?: string;
  sourcePath?: string;
  matchedItinerarySegmentId?: string;
  locationText?: string;
  transport?: 'drive' | 'walk' | 'train' | 'flight' | 'boat' | 'mixed';
  rootRef?: string;
  pathPrefix?: string;
  summary?: string;
}

export interface IBuildMediaChronologyOptions {
  spans?: IKtepSlice[];
  pharosContext?: IProjectPharosContext | null;
  pharosGpsPoints?: IChronologyTimedPoint[];
  projectGpsPoints?: IChronologyTimedPoint[];
  derivedTrack?: { entries: IChronologyDerivedTrackEntry[] } | null;
  now?: string;
}

export interface IChronologyBuildProgress {
  step: string;
  stepLabel: string;
  stepIndex: number;
  current: number;
  total: number;
  unit?: string;
  detail: string;
  extra?: Record<string, unknown>;
}

export interface IBuildMediaChronologyWithProgressOptions extends IBuildMediaChronologyOptions {
  onProgress?: (progress: IChronologyBuildProgress) => Promise<void> | void;
  progressBatchSize?: number;
  reverseGeocodeService?: IReverseGeocodeService | null;
  requireReverseGeocode?: boolean;
}

interface IChronologyBuildContext {
  assetSortMap: Map<string, { item: IChronologyAssetIndex; index: number }>;
  assetMap: Map<string, IKtepAsset>;
  reportMap: Map<string, IAssetCoarseReport>;
  rootMap: Map<string, IMediaRoot>;
  pharosContext: IProjectPharosContext | null;
  pharosGpsPoints: IChronologyTimedPoint[];
  projectGpsPoints: IChronologyTimedPoint[];
  derivedTrackEntries: IChronologyDerivedTrackEntry[];
}

interface IChronologyPoint {
  lat: number;
  lng: number;
  source: TChronologySpatialSource;
  time?: string;
  locationText?: string;
}

type TChronologySpatialSource =
  | 'pharos-gpx'
  | 'project-gpx'
  | 'derived-track'
  | 'report-pharos'
  | 'report-gpx'
  | 'report-derived-track'
  | 'embedded';

type TChronologyMotion = 'stationary' | 'moving' | 'unknown';

interface IChronologySpatialResolution {
  representative?: IChronologyPoint;
  startPoint?: IChronologyPoint;
  endPoint?: IChronologyPoint;
  location?: string;
  motion: TChronologyMotion;
}

interface IChronologySpanRow {
  span: IKtepSlice;
  asset?: IKtepAsset;
  report?: IAssetCoarseReport;
  root?: IMediaRoot;
  startAt?: string;
  endAt?: string;
  startMs?: number;
  endMs?: number;
  durationMs: number;
  location?: string;
  routeRole?: string;
  directPharosShot?: IProjectPharosShot;
  continuousPharosShot?: IProjectPharosShot;
  spatial?: IChronologyPoint;
  startPoint?: IChronologyPoint;
  endPoint?: IChronologyPoint;
  motion: TChronologyMotion;
}

interface IChronologyEventCluster {
  kind: 'event' | 'route';
  rows: IChronologySpanRow[];
  directPharosShot?: IProjectPharosShot;
}

interface IChronologyEventDraft {
  event: IChronologyEvent;
  kind: 'event' | 'route';
  rows: IChronologySpanRow[];
  primaryRows: IChronologySpanRow[];
  directPharosShot?: IProjectPharosShot;
}

interface IChronologyGeocodeFingerprintRow {
  locationKey: string;
  provider?: string;
  status: string;
  locationText?: string;
}

export function buildMediaChronology(
  assets: IKtepAsset[],
  reports: IAssetCoarseReport[] = [],
  existing: IProjectChronology | null = null,
  roots: IMediaRoot[] = [],
  options: IBuildMediaChronologyOptions = {},
): IProjectChronology {
  const now = options.now ?? new Date().toISOString();
  const rootMap = new Map(roots.map(root => [root.id, root]));
  const assetIndex = buildChronologyAssetIndex(assets);
  const context: IChronologyBuildContext = {
    assetSortMap: new Map(assetIndex.map((item, index) => [item.assetId, { item, index }] as const)),
    assetMap: new Map(assets.map(asset => [asset.id, asset] as const)),
    reportMap: new Map(reports.map(report => [report.assetId, report] as const)),
    rootMap,
    pharosContext: options.pharosContext ?? null,
    pharosGpsPoints: options.pharosGpsPoints ?? [],
    projectGpsPoints: options.projectGpsPoints ?? [],
    derivedTrackEntries: options.derivedTrack?.entries ?? [],
  };
  const eventDrafts = buildSpanEventDrafts(options.spans ?? [], context);
  const spanEvents = eventDrafts.map(draft => draft.event);
  const geocodeFingerprint = hashChronologyGeocodeFingerprint([]);
  const inputsHash = buildChronologyInputsHash({
    assets,
    reports,
    roots,
    spans: options.spans ?? [],
    pharosContext: options.pharosContext ?? null,
    pharosGpsPoints: options.pharosGpsPoints ?? [],
    projectGpsPoints: options.projectGpsPoints ?? [],
    derivedTrackEntries: options.derivedTrack?.entries ?? [],
    geocodeFingerprint,
  });
  const baseEvents = [
    ...spanEvents,
    ...buildPharosGapEvents(options.pharosContext ?? null, spanEvents),
  ].sort(compareChronologyEvents);
  const events = applyExistingEventReview(baseEvents, existing);
  const status = existing?.inputsHash === inputsHash
    ? existing.status
    : 'draft';

  return {
    schemaVersion: '2.0',
    status,
    generatedAt: existing?.inputsHash === inputsHash ? existing.generatedAt : now,
    updatedAt: now,
    ...(status === 'confirmed' && existing?.confirmedAt ? { confirmedAt: existing.confirmedAt } : {}),
    inputsHash,
    assetIndex,
    events,
  };
}

export async function buildMediaChronologyWithProgress(
  assets: IKtepAsset[],
  reports: IAssetCoarseReport[] = [],
  existing: IProjectChronology | null = null,
  roots: IMediaRoot[] = [],
  options: IBuildMediaChronologyWithProgressOptions = {},
): Promise<IProjectChronology> {
  const spans = options.spans ?? [];
  const now = options.now ?? new Date().toISOString();
  await reportChronologyProgress(options.onProgress, {
    step: 'asset-index',
    stepLabel: '建立素材时间索引',
    stepIndex: 3,
    current: 0,
    total: Math.max(1, assets.length),
    unit: 'asset',
    detail: `准备 ${assets.length} 个 assets 的 chronology 排序时间`,
    extra: { assetCount: assets.length, spanCount: spans.length, reportCount: reports.length },
  });

  const rootMap = new Map(roots.map(root => [root.id, root]));
  const assetIndex = buildChronologyAssetIndex(assets);

  await reportChronologyProgress(options.onProgress, {
    step: 'input-hash',
    stepLabel: '计算输入指纹',
    stepIndex: 4,
    current: spans.length,
    total: Math.max(1, spans.length),
    unit: 'span',
    detail: '计算 assets / reports / spans / GPS / Pharos 的 chronology inputs hash',
    extra: { assetCount: assets.length, spanCount: spans.length, reportCount: reports.length },
  });

  const baseInputsHash = buildChronologyInputsHash({
    assets,
    reports,
    roots,
    spans,
    pharosContext: options.pharosContext ?? null,
    pharosGpsPoints: options.pharosGpsPoints ?? [],
    projectGpsPoints: options.projectGpsPoints ?? [],
    derivedTrackEntries: options.derivedTrack?.entries ?? [],
    geocodeFingerprint: hashChronologyGeocodeFingerprint([]),
  });
  const context: IChronologyBuildContext = {
    assetSortMap: new Map(assetIndex.map((item, index) => [item.assetId, { item, index }] as const)),
    assetMap: new Map(assets.map(asset => [asset.id, asset] as const)),
    reportMap: new Map(reports.map(report => [report.assetId, report] as const)),
    rootMap,
    pharosContext: options.pharosContext ?? null,
    pharosGpsPoints: options.pharosGpsPoints ?? [],
    projectGpsPoints: options.projectGpsPoints ?? [],
    derivedTrackEntries: options.derivedTrack?.entries ?? [],
  };

  const eventDrafts = await buildSpanEventDraftsWithProgress(
    spans,
    context,
    options.onProgress,
    options.progressBatchSize ?? CCHRONOLOGY_PROGRESS_BATCH_SIZE,
  );
  const resolvedLocations = await resolveChronologyEventDraftLocationsWithProgress(
    eventDrafts,
    context,
    options.reverseGeocodeService ?? null,
    options.requireReverseGeocode ?? false,
    options.onProgress,
    options.progressBatchSize ?? CCHRONOLOGY_PROGRESS_BATCH_SIZE,
  );
  const spanEvents = resolvedLocations.events;
  const inputsHash = buildChronologyInputsHash({
    assets,
    reports,
    roots,
    spans,
    pharosContext: options.pharosContext ?? null,
    pharosGpsPoints: options.pharosGpsPoints ?? [],
    projectGpsPoints: options.projectGpsPoints ?? [],
    derivedTrackEntries: options.derivedTrack?.entries ?? [],
    geocodeFingerprint: resolvedLocations.geocodeFingerprint,
  });

  await reportChronologyProgress(options.onProgress, {
    step: 'gap-events',
    stepLabel: '生成 Pharos 缺口',
    stepIndex: 9,
    current: spanEvents.length,
    total: Math.max(1, spanEvents.length),
    unit: 'event',
    detail: '为无素材命中的 Pharos point events 生成 gap events',
    extra: { spanEventCount: spanEvents.length, inputsHash, baseInputsHash },
  });

  const gapEvents = buildPharosGapEvents(options.pharosContext ?? null, spanEvents);
  const baseEvents = [...spanEvents, ...gapEvents].sort(compareChronologyEvents);

  await reportChronologyProgress(options.onProgress, {
    step: 'review-state',
    stepLabel: '合并审查状态',
    stepIndex: 10,
    current: baseEvents.length,
    total: Math.max(1, baseEvents.length),
    unit: 'event',
    detail: `合并 ${baseEvents.length} 个 events 与既有 review 状态`,
    extra: {
      spanEventCount: spanEvents.length,
      gapEventCount: gapEvents.length,
      eventCount: baseEvents.length,
      inputsHash,
      geocodeFingerprint: resolvedLocations.geocodeFingerprint,
    },
  });

  const events = applyExistingEventReview(baseEvents, existing);
  const status = existing?.inputsHash === inputsHash
    ? existing.status
    : 'draft';

  return {
    schemaVersion: '2.0',
    status,
    generatedAt: existing?.inputsHash === inputsHash ? existing.generatedAt : now,
    updatedAt: now,
    ...(status === 'confirmed' && existing?.confirmedAt ? { confirmedAt: existing.confirmedAt } : {}),
    inputsHash,
    assetIndex,
    events,
  };
}

function buildChronologyAssetIndex(
  assets: IKtepAsset[],
): IChronologyAssetIndex[] {
  return assets
    .map(asset => ({
      assetId: asset.id,
      sortCapturedAt: asset.capturedAt,
    }))
    .sort(compareChronologyAssetIndex);
}

function buildSpanEventDrafts(
  spans: IKtepSlice[],
  context: IChronologyBuildContext,
): IChronologyEventDraft[] {
  const rows = spans
    .map(span => buildSpanRow(span, context))
    .sort(compareSpanRows);
  return buildEventDraftsFromSortedRows(rows, context);
}

function buildEventDraftsFromSortedRows(
  rows: IChronologySpanRow[],
  context: IChronologyBuildContext,
): IChronologyEventDraft[] {
  const pharosDrafts = buildGroupedPharosEventDrafts(rows);
  const ordinaryRows = rows.filter(row => !row.directPharosShot);
  const ordinaryPhotoRows = ordinaryRows.filter(isPhotoAccessoryRow);
  const ordinaryPrimaryRows = ordinaryRows.filter(row => !isPhotoAccessoryRow(row));
  const primaryDrafts = buildPrimaryEventDraftsFromSortedRows(ordinaryPrimaryRows, context);
  attachPhotoRowsToEventDrafts(primaryDrafts, ordinaryPhotoRows, context);

  return [...primaryDrafts, ...pharosDrafts];
}

function buildPrimaryEventDraftsFromSortedRows(
  rows: IChronologySpanRow[],
  context: IChronologyBuildContext,
): IChronologyEventDraft[] {
  const events: IChronologyEventDraft[] = [];
  let current: IChronologyEventCluster | null = null;

  const flush = () => {
    if (!current || current.rows.length === 0) return;
    events.push(buildClusterEventDraft(current));
    current = null;
  };

  for (const row of rows) {
    if (current?.kind === 'event' && canAppendToStationaryEvent(current, row, context)) {
      current.rows.push(row);
      continue;
    }

    if (current?.kind === 'route' && canAppendToRoute(current, row, context)) {
      current.rows.push(row);
      continue;
    }

    flush();
    current = {
      kind: isMovingRouteCandidate(row) ? 'route' : 'event',
      rows: [row],
    };
  }
  flush();

  return events;
}

function attachPhotoRowsToEventDrafts(
  drafts: IChronologyEventDraft[],
  photoRows: IChronologySpanRow[],
  context: IChronologyBuildContext,
): void {
  for (const row of photoRows) {
    const draft = pickPhotoAttachmentDraft(drafts, row, context);
    if (!draft) continue;
    attachPhotoRowToDraft(draft, row);
  }
}

function pickPhotoAttachmentDraft(
  drafts: IChronologyEventDraft[],
  row: IChronologySpanRow,
  context: IChronologyBuildContext,
): IChronologyEventDraft | null {
  const routeDraft = pickPhotoAttachmentDraftByKind(drafts, row, context, 'route');
  if (routeDraft) return routeDraft;
  return pickPhotoAttachmentDraftByKind(drafts, row, context, 'event');
}

function pickPhotoAttachmentDraftByKind(
  drafts: IChronologyEventDraft[],
  row: IChronologySpanRow,
  context: IChronologyBuildContext,
  kind: 'event' | 'route',
): IChronologyEventDraft | null {
  let best: { draft: IChronologyEventDraft; score: number } | null = null;
  for (const draft of drafts.filter(item => item.kind === kind)) {
    const score = scorePhotoAttachment(draft, row, context);
    if (score == null) continue;
    if (best && score >= best.score) continue;
    best = { draft, score };
  }
  return best?.draft ?? null;
}

function scorePhotoAttachment(
  draft: IChronologyEventDraft,
  row: IChronologySpanRow,
  context: IChronologyBuildContext,
): number | null {
  const primaryRows = getDraftPrimaryRows(draft);
  if (primaryRows.length === 0) return null;
  const gapMs = getPhotoAttachmentGapMs(primaryRows, row);
  if (gapMs == null) return null;
  if (draft.kind === 'route' && gapMs > CPHOTO_ATTACH_GAP_MS) return null;
  const nearest = findNearestRowsByTime(primaryRows, row);
  if (!nearest || hasPharosPointBoundaryBetween(nearest, row, context)) return null;
  return gapMs * 10 + Math.abs((nearest.startMs ?? 0) - (row.startMs ?? 0));
}

function attachPhotoRowToDraft(
  draft: IChronologyEventDraft,
  row: IChronologySpanRow,
): void {
  draft.rows = [...draft.rows, row].sort(compareSpanRows);
  draft.event = {
    ...draft.event,
    summary: summarizeRows(draft.rows),
    startAt: minIso(draft.rows.map(item => item.startAt)),
    endAt: maxIso(draft.rows.map(item => item.endAt ?? item.startAt)),
    spanIds: draft.rows.map(item => item.span.id),
  };
}

function getPhotoAttachmentGapMs(
  rows: IChronologySpanRow[],
  row: IChronologySpanRow,
): number | undefined {
  const rowStartMs = row.startMs;
  const rowEndMs = row.endMs ?? row.startMs;
  const draftStartMs = minNumber(rows.map(item => item.startMs));
  const draftEndMs = maxNumber(rows.map(item => item.endMs ?? item.startMs));
  if (rowStartMs == null || rowEndMs == null || draftStartMs == null || draftEndMs == null) return undefined;
  if (rowEndMs < draftStartMs) return draftStartMs - rowEndMs;
  if (rowStartMs > draftEndMs) return rowStartMs - draftEndMs;
  return 0;
}

function findNearestRowsByTime(
  rows: IChronologySpanRow[],
  row: IChronologySpanRow,
): IChronologySpanRow | undefined {
  const rowMidpointMs = getRowMidpointMs(row);
  return [...rows]
    .sort((left, right) =>
      Math.abs(getRowMidpointMs(left) - rowMidpointMs) - Math.abs(getRowMidpointMs(right) - rowMidpointMs)
      || compareSpanRows(left, right))[0];
}

function buildGroupedPharosEventDrafts(rows: IChronologySpanRow[]): IChronologyEventDraft[] {
  const byShot = new Map<string, IChronologyEventCluster>();
  for (const row of rows) {
    if (!row.directPharosShot) continue;
    const key = formatPharosShotKey(row.directPharosShot);
    const current = byShot.get(key);
    if (current) {
      current.rows.push(row);
    } else {
      byShot.set(key, {
        kind: 'event',
        rows: [row],
        directPharosShot: row.directPharosShot,
      });
    }
  }
  return [...byShot.values()].map(cluster => buildClusterEventDraft({
    ...cluster,
    rows: [...cluster.rows].sort(compareSpanRows),
  }));
}

function formatPharosShotKey(shot: IProjectPharosShot): string {
  return `${shot.ref.tripId}:${shot.ref.shotId}`;
}

async function buildSpanEventDraftsWithProgress(
  spans: IKtepSlice[],
  context: IChronologyBuildContext,
  onProgress: IBuildMediaChronologyWithProgressOptions['onProgress'],
  batchSize: number,
): Promise<IChronologyEventDraft[]> {
  const rows: IChronologySpanRow[] = [];
  let directPharosCount = 0;
  let continuousPharosCount = 0;
  let spatialCount = 0;
  const total = Math.max(1, spans.length);

  for (let index = 0; index < spans.length; index += 1) {
    const row = buildSpanRow(spans[index]!, context);
    rows.push(row);
    if (row.directPharosShot) directPharosCount += 1;
    if (row.continuousPharosShot) continuousPharosCount += 1;
    if (row.spatial) spatialCount += 1;

    if (shouldReportChronologyProgress(index + 1, spans.length, batchSize)) {
      await reportChronologyProgress(onProgress, {
        step: 'span-rows',
        stepLabel: '解析 span 时空归属',
        stepIndex: 5,
        current: index + 1,
        total,
        unit: 'span',
        detail: `解析 ${index + 1}/${spans.length} 个 spans 的时间、GPS、Pharos actual window 与素材类型`,
        extra: {
          spanCount: spans.length,
          rowCount: rows.length,
          directPharosCount,
          continuousPharosCount,
          spatialCount,
        },
      });
    }
  }

  await reportChronologyProgress(onProgress, {
    step: 'sort-rows',
    stepLabel: '排序 chronology rows',
    stepIndex: 6,
    current: rows.length,
    total,
    unit: 'span',
    detail: `按 sortCapturedAt / asset / sourceInMs 排序 ${rows.length} 个 rows`,
    extra: {
      spanCount: spans.length,
      rowCount: rows.length,
      directPharosCount,
      continuousPharosCount,
      spatialCount,
    },
  });
  rows.sort(compareSpanRows);

  await reportChronologyProgress(onProgress, {
    step: 'aggregate-events',
    stepLabel: '聚合事件与路线',
    stepIndex: 7,
    current: 0,
    total: Math.max(1, rows.length),
    unit: 'row',
    detail: `准备聚合 ${rows.length} 个 rows：先按 Pharos point shot 全局归并，再聚合普通非照片 route/event，最后按时间把照片优先挂到 route、再挂最近 event`,
    extra: {
      spanCount: spans.length,
      rowCount: rows.length,
      directPharosCount,
      continuousPharosCount,
      spatialCount,
    },
  });

  const events = buildEventDraftsFromSortedRows(rows, context);
  const routeEventCount = events.filter(event => event.kind === 'route').length;
  const pharosEventCount = events.filter(event => event.directPharosShot).length;
  const ordinaryEventCount = events.length - routeEventCount - pharosEventCount;

  await reportChronologyProgress(onProgress, {
    step: 'aggregate-events',
    stepLabel: '聚合事件与路线',
    stepIndex: 7,
    current: rows.length,
    total: Math.max(1, rows.length),
    unit: 'row',
    detail: `聚合完成：${events.length} 个 span-derived events`,
    extra: {
      spanCount: spans.length,
      rowCount: rows.length,
      eventCount: events.length,
      routeEventCount,
      ordinaryEventCount,
      pharosEventCount,
    },
  });

  return events;
}

async function resolveChronologyEventDraftLocationsWithProgress(
  drafts: IChronologyEventDraft[],
  context: IChronologyBuildContext,
  reverseGeocodeService: IReverseGeocodeService | null,
  requireReverseGeocode: boolean,
  onProgress: IBuildMediaChronologyWithProgressOptions['onProgress'],
  batchSize: number,
): Promise<{ events: IChronologyEvent[]; geocodeFingerprint: string }> {
  const anchors = drafts.flatMap((draft, draftIndex) => buildChronologyLocationAnchors(draft, draftIndex, context));
  const uniquePoints = dedupeChronologyLocationAnchors(anchors);
  const total = Math.max(1, uniquePoints.length);
  const resolvedByKey = new Map<string, string | undefined>();
  const fingerprintRows: IChronologyGeocodeFingerprintRow[] = [];
  let resolvedCount = 0;
  let geocodedCount = 0;
  let localFallbackCount = 0;

  if (requireReverseGeocode && uniquePoints.length > 0 && !reverseGeocodeService) {
    throw new Error(`chronology-build requires GPS reverse-geocode service; ${uniquePoints.length} route/event GPS anchors need location resolution`);
  }

  await reportChronologyProgress(onProgress, {
    step: 'resolve-locations',
    stepLabel: '反查 route/event 地名',
    stepIndex: 8,
    current: 0,
    total,
    unit: 'point',
    detail: `按 route 起止时间与 event midpoint 收集 ${uniquePoints.length} 个 GPS 点，准备 cache-first 反查地名`,
    extra: {
      eventCount: drafts.length,
      anchorCount: anchors.length,
      uniquePointCount: uniquePoints.length,
      reverseGeocodeEnabled: Boolean(reverseGeocodeService),
    },
  });

  for (let index = 0; index < uniquePoints.length; index += 1) {
    const { locationKey, point } = uniquePoints[index]!;
    const entry = reverseGeocodeService
      ? await reverseGeocodeService.reverseGeocode(point.lat, point.lng)
      : null;
    const localText = sanitizeChronologyLocationText(point.locationText);
    const locationText = sanitizeChronologyLocationText(entry?.locationText) ?? localText;
    if (requireReverseGeocode && !sanitizeChronologyLocationText(entry?.locationText)) {
      throw new Error(`chronology-build reverse-geocode failed for ${locationKey}; refusing to write chronology with fallback place text`);
    }
    resolvedByKey.set(locationKey, locationText);
    if (locationText) resolvedCount += 1;
    if (sanitizeChronologyLocationText(entry?.locationText)) {
      geocodedCount += 1;
    } else if (localText) {
      localFallbackCount += 1;
    }
    fingerprintRows.push(buildGeocodeFingerprintRow(locationKey, entry, localText));

    if (shouldReportChronologyProgress(index + 1, uniquePoints.length, Math.min(batchSize, 25))) {
      await reportChronologyProgress(onProgress, {
        step: 'resolve-locations',
        stepLabel: '反查 route/event 地名',
        stepIndex: 8,
        current: index + 1,
        total,
        unit: 'point',
        detail: `反查 ${index + 1}/${uniquePoints.length} 个 route/event GPS 点，已解析 ${resolvedCount} 个地名`,
        extra: {
          eventCount: drafts.length,
          anchorCount: anchors.length,
          uniquePointCount: uniquePoints.length,
          resolvedCount,
          geocodedCount,
          localFallbackCount,
          reverseGeocodeEnabled: Boolean(reverseGeocodeService),
        },
      });
    }
  }

  const anchorTextByDraftAndRole = new Map<string, string>();
  for (const anchor of anchors) {
    if (!anchor.point) continue;
    const text = resolvedByKey.get(formatChronologyPointLocationKey(anchor.point));
    if (text) {
      anchorTextByDraftAndRole.set(getChronologyAnchorMapKey(anchor.draftIndex, anchor.role), text);
    }
  }

  const events = drafts.map((draft, draftIndex) =>
    applyResolvedLocationToChronologyEvent(draft, draftIndex, anchorTextByDraftAndRole));

  return {
    events,
    geocodeFingerprint: hashChronologyGeocodeFingerprint(fingerprintRows),
  };
}

function buildChronologyLocationAnchors(
  draft: IChronologyEventDraft,
  draftIndex: number,
  context: IChronologyBuildContext,
): Array<{ draftIndex: number; role: 'route-start' | 'route-end' | 'event-point'; point?: IChronologyPoint }> {
  if (draft.event.kind === 'route') {
    return [
      {
        draftIndex,
        role: 'route-start',
        point: resolveDraftAnchorPoint(draft, 'start', context),
      },
      {
        draftIndex,
        role: 'route-end',
        point: resolveDraftAnchorPoint(draft, 'end', context),
      },
    ];
  }

  if (draft.event.kind === 'event') {
    const existingLocation = sanitizeChronologyLocationText(draft.event.location);
    if (draft.directPharosShot && existingLocation) {
      return [];
    }
    return [{
      draftIndex,
      role: 'event-point',
      point: resolveDraftAnchorPoint(draft, 'midpoint', context),
    }];
  }

  return [];
}

function resolveDraftAnchorPoint(
  draft: IChronologyEventDraft,
  role: 'start' | 'end' | 'midpoint',
  context: IChronologyBuildContext,
): IChronologyPoint | undefined {
  const rows = getDraftPrimaryRows(draft);
  const targetMs = resolveDraftAnchorTargetMs(draft, role);
  if (targetMs == null) {
    return resolveRowFallbackAnchor(rows, targetMs, role);
  }

  const tripIds = collectDraftPharosTripIds(draft);
  if (tripIds.size > 0) {
    const sameTripPoint = pickNearestTimedPoint(
      context.pharosGpsPoints.filter(point => point.tripId && tripIds.has(point.tripId)),
      targetMs,
      CCHRONOLOGY_GPS_MATCH_TOLERANCE_MS,
    );
    if (sameTripPoint) {
      return toChronologyPoint(sameTripPoint, 'pharos-gpx');
    }
  }

  const pharosPoint = pickNearestTimedPoint(
    context.pharosGpsPoints,
    targetMs,
    CCHRONOLOGY_GPS_MATCH_TOLERANCE_MS,
  );
  if (pharosPoint) {
    return toChronologyPoint(pharosPoint, 'pharos-gpx');
  }

  const projectPoint = pickNearestTimedPoint(
    context.projectGpsPoints,
    targetMs,
    CCHRONOLOGY_GPS_MATCH_TOLERANCE_MS,
  );
  if (projectPoint) {
    return toChronologyPoint(projectPoint, 'project-gpx');
  }

  const derivedPoint = pickBestDerivedAnchor(context.derivedTrackEntries, targetMs, rows);
  if (derivedPoint) {
    return derivedPoint;
  }

  return resolveRowFallbackAnchor(rows, targetMs, role);
}

function resolveDraftAnchorTargetMs(
  draft: IChronologyEventDraft,
  role: 'start' | 'end' | 'midpoint',
): number | undefined {
  const rows = getDraftPrimaryRows(draft);
  const startMs = minNumber(rows.map(row => row.startMs)) ?? parseTimestamp(draft.event.startAt);
  const endMs = maxNumber(rows.map(row => row.endMs ?? row.startMs)) ?? parseTimestamp(draft.event.endAt);
  if (role === 'start') return startMs;
  if (role === 'end') return endMs ?? startMs;
  if (startMs == null && endMs == null) return undefined;
  if (startMs == null) return endMs;
  if (endMs == null || endMs < startMs) return startMs;
  return Math.round((startMs + endMs) / 2);
}

function collectDraftPharosTripIds(draft: IChronologyEventDraft): Set<string> {
  const tripIds = new Set<string>();
  if (draft.directPharosShot?.ref.tripId) {
    tripIds.add(draft.directPharosShot.ref.tripId);
  }
  for (const row of draft.rows) {
    if (row.directPharosShot?.ref.tripId) tripIds.add(row.directPharosShot.ref.tripId);
    if (row.continuousPharosShot?.ref.tripId) tripIds.add(row.continuousPharosShot.ref.tripId);
  }
  return tripIds;
}

function pickBestDerivedAnchor(
  entries: IChronologyDerivedTrackEntry[],
  targetMs: number,
  rows: IChronologySpanRow[],
): IChronologyPoint | null {
  let best: { point: IChronologyPoint; score: number } | null = null;
  for (const row of rows) {
    const entry = pickBestDerivedPoint(entries.filter(item => item.matchKind === 'point' && item.time), targetMs, row)
      ?? pickBestDerivedWindow(entries, targetMs, row);
    if (!entry) continue;
    const entryMs = parseTimestamp(entry.time ?? entry.startTime ?? entry.endTime);
    const deltaScore = entryMs == null ? 0 : Math.max(0, 1_000_000 - Math.abs(entryMs - targetMs));
    const score = deltaScore + Math.round((entry.confidence ?? 0) * 10_000) + (entry.locationText ? 100 : 0);
    if (best && score <= best.score) continue;
    best = {
      point: {
        lat: entry.lat,
        lng: entry.lng,
        source: 'derived-track',
        time: entry.time,
        locationText: sanitizeChronologyLocationText(entry.locationText),
      },
      score,
    };
  }
  return best?.point ?? null;
}

function resolveRowFallbackAnchor(
  rows: IChronologySpanRow[],
  targetMs: number | undefined,
  role: 'start' | 'end' | 'midpoint',
): IChronologyPoint | undefined {
  if (role === 'start') {
    return cloneChronologyPoint(rows.find(row => row.startPoint || row.spatial || row.endPoint)?.startPoint
      ?? rows.find(row => row.startPoint || row.spatial || row.endPoint)?.spatial
      ?? rows.find(row => row.startPoint || row.spatial || row.endPoint)?.endPoint);
  }
  if (role === 'end') {
    return cloneChronologyPoint([...rows].reverse().find(row => row.endPoint || row.spatial || row.startPoint)?.endPoint
      ?? [...rows].reverse().find(row => row.endPoint || row.spatial || row.startPoint)?.spatial
      ?? [...rows].reverse().find(row => row.endPoint || row.spatial || row.startPoint)?.startPoint);
  }

  let best: { point: IChronologyPoint; delta: number } | null = null;
  for (const row of rows) {
    const point = row.spatial ?? row.startPoint ?? row.endPoint;
    if (!point) continue;
    const rowMs = row.startMs == null ? undefined : getRowMidpointMs(row);
    const delta = targetMs == null || rowMs == null ? 0 : Math.abs(rowMs - targetMs);
    if (best && delta >= best.delta) continue;
    best = { point, delta };
  }
  return cloneChronologyPoint(best?.point);
}

function cloneChronologyPoint(point: IChronologyPoint | undefined): IChronologyPoint | undefined {
  if (!point) return undefined;
  return {
    ...point,
    locationText: sanitizeChronologyLocationText(point.locationText),
  };
}

function dedupeChronologyLocationAnchors(
  anchors: Array<{ point?: IChronologyPoint }>,
): Array<{ locationKey: string; point: IChronologyPoint }> {
  const byKey = new Map<string, IChronologyPoint>();
  for (const anchor of anchors) {
    if (!anchor.point || !Number.isFinite(anchor.point.lat) || !Number.isFinite(anchor.point.lng)) continue;
    const key = formatChronologyPointLocationKey(anchor.point);
    if (!byKey.has(key)) {
      byKey.set(key, anchor.point);
    }
  }
  return [...byKey.entries()].map(([locationKey, point]) => ({ locationKey, point }));
}

function applyResolvedLocationToChronologyEvent(
  draft: IChronologyEventDraft,
  draftIndex: number,
  anchorTextByDraftAndRole: Map<string, string>,
): IChronologyEvent {
  const event = draft.event;
  if (event.kind === 'route') {
    const from = anchorTextByDraftAndRole.get(getChronologyAnchorMapKey(draftIndex, 'route-start'))
      ?? sanitizeChronologyLocationText(event.route?.from);
    const to = anchorTextByDraftAndRole.get(getChronologyAnchorMapKey(draftIndex, 'route-end'))
      ?? sanitizeChronologyLocationText(event.route?.to);
    return buildRouteEventWithResolvedLocation(event, from, to);
  }

  if (event.kind !== 'event') {
    return sanitizeChronologyEventGeneratedFields(event);
  }

  const resolvedLocation = draft.directPharosShot
    ? sanitizeChronologyLocationText(event.location)
      ?? anchorTextByDraftAndRole.get(getChronologyAnchorMapKey(draftIndex, 'event-point'))
    : anchorTextByDraftAndRole.get(getChronologyAnchorMapKey(draftIndex, 'event-point'))
      ?? sanitizeChronologyLocationText(event.location);

  return {
    ...event,
    title: draft.directPharosShot
      ? (isBadGeneratedChronologyTitle(event.title) || event.title === 'Pharos event'
        ? resolvedLocation ?? event.title
        : event.title)
      : resolveClusterTitleWithLocation(getDraftPrimaryRows(draft), resolvedLocation) ?? event.title,
    location: resolvedLocation,
  };
}

function buildRouteEventWithResolvedLocation(
  event: IChronologyEvent,
  from: string | undefined,
  to: string | undefined,
): IChronologyEvent {
  const title = from && to && normalizeChronologyLocationIdentity(from) !== normalizeChronologyLocationIdentity(to)
    ? `行车：${from} → ${to}`
    : from || to
      ? `行车：${from ?? to}`
      : '行车段';
  const route = from || to ? { from, to } : undefined;
  const location = from && to && normalizeChronologyLocationIdentity(from) === normalizeChronologyLocationIdentity(to)
    ? from
    : undefined;
  return {
    ...event,
    title,
    location,
    route,
  };
}

function sanitizeChronologyEventGeneratedFields(event: IChronologyEvent): IChronologyEvent {
  if (event.kind === 'route') {
    return buildRouteEventWithResolvedLocation(
      event,
      sanitizeChronologyLocationText(event.route?.from),
      sanitizeChronologyLocationText(event.route?.to),
    );
  }
  return {
    ...event,
    title: isBadGeneratedChronologyTitle(event.title) ? 'Event' : event.title,
    location: sanitizeChronologyLocationText(event.location),
  };
}

function buildGeocodeFingerprintRow(
  locationKey: string,
  entry: IReverseGeocodeCacheEntry | null,
  localText: string | undefined,
): IChronologyGeocodeFingerprintRow {
  return {
    locationKey,
    provider: entry?.provider,
    status: entry?.status ?? (localText ? 'local' : 'empty'),
    locationText: sanitizeChronologyLocationText(entry?.locationText) ?? localText,
  };
}

function getChronologyAnchorMapKey(
  draftIndex: number,
  role: 'route-start' | 'route-end' | 'event-point',
): string {
  return `${draftIndex}:${role}`;
}

function formatChronologyPointLocationKey(point: Pick<IChronologyPoint, 'lat' | 'lng'>): string {
  return formatReverseGeocodeLocationKey(point.lng, point.lat);
}

function buildSpanRow(
  span: IKtepSlice,
  context: IChronologyBuildContext,
): IChronologySpanRow {
  const asset = context.assetMap.get(span.assetId);
  const report = context.reportMap.get(span.assetId);
  const root = asset?.ingestRootId ? context.rootMap.get(asset.ingestRootId) : undefined;
  const assetSortCapturedAt = context.assetSortMap.get(span.assetId)?.item.sortCapturedAt;
  const startAt = addMs(assetSortCapturedAt, span.sourceInMs);
  const endAt = addMs(assetSortCapturedAt, span.sourceOutMs ?? span.sourceInMs);
  const startMs = parseTimestamp(startAt);
  const endMs = parseTimestamp(endAt);
  const normalizedEndMs = startMs != null && endMs != null && endMs >= startMs ? endMs : startMs;
  const baseRow: IChronologySpanRow = {
    span,
    asset,
    report,
    root,
    startAt,
    endAt,
    startMs,
    endMs: normalizedEndMs,
    durationMs: startMs != null && normalizedEndMs != null ? Math.max(0, normalizedEndMs - startMs) : 0,
    ...resolveLegacySpatialFields(span),
    motion: 'unknown',
  };
  const directPharosShot = pickDirectPharosPointShot(baseRow, context.pharosContext);
  const continuousPharosShot = pickContinuousPharosShot(baseRow, context.pharosContext);
  const spatial = resolveRowSpatial(baseRow, continuousPharosShot, context);

  return {
    ...baseRow,
    directPharosShot,
    continuousPharosShot,
    location: sanitizeChronologyLocationText(directPharosShot?.location)
      ?? sanitizeChronologyLocationText(spatial.location)
      ?? sanitizeChronologyLocationText(baseRow.location)
      ?? sanitizeChronologyLocationText(report?.inferredGps?.locationText)
      ?? sanitizeChronologyLocationText(report?.placeHints[0]),
    spatial: spatial.representative,
    startPoint: spatial.startPoint,
    endPoint: spatial.endPoint,
    motion: spatial.motion,
  };
}

function resolveRowSpatial(
  row: IChronologySpanRow,
  continuousPharosShot: IProjectPharosShot | undefined,
  context: IChronologyBuildContext,
): IChronologySpatialResolution {
  const pharosPoints = continuousPharosShot
    ? context.pharosGpsPoints.filter(point => point.tripId === continuousPharosShot.ref.tripId)
    : context.pharosGpsPoints;
  const pharosSpatial = resolveTimedTrackSpatial({
    row,
    points: pharosPoints,
    source: 'pharos-gpx',
  }) ?? (continuousPharosShot
    ? resolveTimedTrackSpatial({
      row,
      points: context.pharosGpsPoints,
      source: 'pharos-gpx',
    })
    : null);
  if (pharosSpatial) return pharosSpatial;

  const projectGpsSpatial = resolveTimedTrackSpatial({
    row,
    points: context.projectGpsPoints,
    source: 'project-gpx',
  });
  if (projectGpsSpatial) return projectGpsSpatial;

  const derivedSpatial = resolveDerivedTrackSpatial(row, context.derivedTrackEntries);
  if (derivedSpatial) return derivedSpatial;

  const reportSpatial = resolveReportSpatial(row.report);
  if (reportSpatial) return reportSpatial;

  const embeddedSpatial = resolveEmbeddedSpatial(row);
  if (embeddedSpatial) return embeddedSpatial;

  return {
    location: row.location,
    motion: 'unknown',
  };
}

function resolveTimedTrackSpatial(input: {
  row: IChronologySpanRow;
  points: IChronologyTimedPoint[];
  source: Extract<TChronologySpatialSource, 'pharos-gpx' | 'project-gpx' | 'embedded'>;
  location?: string;
}): IChronologySpatialResolution | null {
  if (!input.points.length || input.row.startMs == null) return null;
  const midpointMs = getRowMidpointMs(input.row);
  const representative = pickNearestTimedPoint(input.points, midpointMs, CCHRONOLOGY_GPS_MATCH_TOLERANCE_MS);
  const startPoint = pickNearestTimedPoint(input.points, input.row.startMs, CCHRONOLOGY_GPS_MATCH_TOLERANCE_MS);
  const endPoint = input.row.endMs != null
    ? pickNearestTimedPoint(input.points, input.row.endMs, CCHRONOLOGY_GPS_MATCH_TOLERANCE_MS)
    : null;
  const representativePoint = representative ?? startPoint ?? endPoint;
  if (!representativePoint) return null;

  const resolvedStart = startPoint ? toChronologyPoint(startPoint, input.source, input.location) : undefined;
  const resolvedEnd = endPoint ? toChronologyPoint(endPoint, input.source, input.location) : undefined;
  return {
    representative: toChronologyPoint(representativePoint, input.source, input.location),
    startPoint: resolvedStart,
    endPoint: resolvedEnd,
    location: input.location,
    motion: resolveMotion(resolvedStart, resolvedEnd),
  };
}

function resolveDerivedTrackSpatial(
  row: IChronologySpanRow,
  entries: IChronologyDerivedTrackEntry[],
): IChronologySpatialResolution | null {
  if (!entries.length || row.startMs == null || !row.asset) return null;
  const timestampMs = getRowMidpointMs(row);
  const pointEntries = entries.filter(entry => entry.matchKind === 'point' && entry.time);
  const point = pickBestDerivedPoint(pointEntries, timestampMs, row);
  const window = point ? null : pickBestDerivedWindow(entries, timestampMs, row);
  const entry = point ?? window;
  if (!entry) return null;
  const representative: IChronologyPoint = {
    lat: entry.lat,
    lng: entry.lng,
    source: 'derived-track',
    time: entry.time,
    locationText: entry.locationText,
  };
  return {
    representative,
    location: entry.locationText,
    motion: 'unknown',
  };
}

function resolveReportSpatial(report: IAssetCoarseReport | undefined): IChronologySpatialResolution | null {
  const inferredGps = report?.inferredGps;
  if (!inferredGps || !isReportSpatialSourceAllowed(inferredGps.source)) return null;
  const source = inferredGps.source === 'pharos'
    ? 'report-pharos'
    : inferredGps.source === 'gpx'
      ? 'report-gpx'
      : 'report-derived-track';
  return {
    representative: {
      lat: inferredGps.lat,
      lng: inferredGps.lng,
      source,
      locationText: inferredGps.locationText,
    },
    location: inferredGps.locationText,
    motion: 'unknown',
  };
}

function resolveEmbeddedSpatial(row: IChronologySpanRow): IChronologySpatialResolution | null {
  const binding = row.asset?.embeddedGps;
  if (!binding) return null;
  const embeddedPoints = (binding.points ?? [])
    .filter(point => parseTimestamp(point.time) != null)
    .map(point => ({
      lat: point.lat,
      lng: point.lng,
      time: point.time,
    }));
  if (embeddedPoints.length > 0) {
    return resolveTimedTrackSpatial({
      row,
      points: embeddedPoints,
      source: 'embedded',
    });
  }
  return {
    representative: {
      lat: binding.representativeLat,
      lng: binding.representativeLng,
      source: 'embedded',
      time: binding.representativeTime,
    },
    motion: 'unknown',
  };
}

function pickDirectPharosPointShot(
  row: IChronologySpanRow,
  pharosContext: IProjectPharosContext | null,
): IProjectPharosShot | undefined {
  if (!pharosContext || pharosContext.status !== 'success') return undefined;
  return pharosContext.shots
    .filter(isRealizedPharosPointShot)
    .map(shot => ({
      shot,
      overlapScore: scorePharosPointOverlap(row, shot),
      explicitCaptureScore: scoreExplicitPharosCaptureMatch(row, shot),
      windowDurationMs: getPharosActualWindowDurationMs(shot) ?? Number.MAX_SAFE_INTEGER,
    }))
    .filter(item => item.overlapScore > 0)
    .sort((left, right) =>
      right.explicitCaptureScore - left.explicitCaptureScore
      || right.overlapScore - left.overlapScore
      || left.windowDurationMs - right.windowDurationMs
      || (left.shot.actualTimeStart ?? '').localeCompare(right.shot.actualTimeStart ?? '')
      || left.shot.ref.tripId.localeCompare(right.shot.ref.tripId)
      || left.shot.ref.shotId.localeCompare(right.shot.ref.shotId))[0]?.shot;
}

function pickContinuousPharosShot(
  row: IChronologySpanRow,
  pharosContext: IProjectPharosContext | null,
): IProjectPharosShot | undefined {
  if (!pharosContext || pharosContext.status !== 'success') return undefined;
  const midpointMs = row.startMs == null ? undefined : getRowMidpointMs(row);
  const byTime = midpointMs == null
    ? undefined
    : pharosContext.shots
      .filter(isRealizedPharosContinuousShot)
      .filter(shot => isTimestampInsidePharosActualWindow(midpointMs, shot))
      .sort(comparePharosShots)[0];
  if (byTime) return byTime;

  const reportMatch = row.report?.pharosMatches.find(match => {
    const shot = pharosContext.shots.find(item =>
      item.ref.tripId === match.ref.tripId
      && item.ref.shotId === match.ref.shotId);
    return shot ? isRealizedPharosContinuousShot(shot) : false;
  });
  return reportMatch
    ? pharosContext.shots.find(shot =>
      shot.ref.tripId === reportMatch.ref.tripId
      && shot.ref.shotId === reportMatch.ref.shotId)
    : undefined;
}

function scorePharosPointOverlap(row: IChronologySpanRow, shot: IProjectPharosShot): number {
  const startMs = parseTimestamp(shot.actualTimeStart);
  const endMs = parseTimestamp(shot.actualTimeEnd);
  if (row.startMs == null || startMs == null || endMs == null || endMs < startMs) return 0;
  if (isPointLikeSpan(row)) {
    const pointMs = getRowMidpointMs(row);
    return pointMs >= startMs && pointMs <= endMs ? 1 : 0;
  }
  if (row.endMs == null || row.durationMs <= 0) return 0;
  const overlap = Math.max(0, Math.min(row.endMs, endMs) - Math.max(row.startMs, startMs));
  if (overlap <= 0) return 0;
  if (overlap < CPHAROS_POINT_MIN_OVERLAP_MS && overlap * 2 < row.durationMs) return 0;
  return overlap / Math.max(1, row.durationMs);
}

function getPharosActualWindowDurationMs(shot: IProjectPharosShot): number | undefined {
  const startMs = parseTimestamp(shot.actualTimeStart);
  const endMs = parseTimestamp(shot.actualTimeEnd);
  if (startMs == null || endMs == null || endMs < startMs) return undefined;
  return endMs - startMs;
}

function scoreExplicitPharosCaptureMatch(
  row: IChronologySpanRow,
  shot: IProjectPharosShot,
): number {
  return scoreExplicitPharosCaptureTypeMatch(row.span.type, shot)
    + scoreExplicitPharosCaptureDeviceMatch(row, shot);
}

function scoreExplicitPharosCaptureTypeMatch(
  spanType: IKtepSlice['type'],
  shot: IProjectPharosShot,
): number {
  const captureTypes = (shot.actualCaptures ?? [])
    .map(capture => normalizeExplicitCaptureType(capture.type))
    .filter((type): type is string => Boolean(type));
  if (captureTypes.length === 0) return 0;
  if (captureTypes.some(type => isExplicitCaptureTypeCompatibleWithSpan(type, spanType))) {
    return captureTypes.includes(spanType) ? 3 : 1;
  }
  if (captureTypes.some(isSpecificCaptureType)) return -1;
  return -0.5;
}

function scoreExplicitPharosCaptureDeviceMatch(
  row: IChronologySpanRow,
  shot: IProjectPharosShot,
): number {
  const rowTokens = collectChronologyRowDeviceTokens(row);
  if (rowTokens.length === 0) return 0;
  const shotTokens = collectPharosShotExplicitDeviceTokens(shot);
  const overlap = rowTokens.filter(token => shotTokens.includes(token));
  return overlap.length > 0 ? 2.5 : 0;
}

function normalizeExplicitCaptureType(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized === 'drone') return 'aerial';
  if (normalized === 'hyperlapse') return 'timelapse';
  return normalized;
}

function isExplicitCaptureTypeCompatibleWithSpan(
  captureType: string,
  spanType: IKtepSlice['type'],
): boolean {
  if (captureType === spanType) return true;
  if (captureType === 'video') {
    return ['shot', 'talking-head', 'drive', 'broll', 'unknown'].includes(spanType);
  }
  return false;
}

function isSpecificCaptureType(captureType: string): boolean {
  return captureType === 'aerial' || captureType === 'timelapse' || captureType === 'photo';
}

function collectChronologyRowDeviceTokens(row: IChronologySpanRow): string[] {
  const values: string[] = [];
  if (row.asset?.sourcePath) values.push(row.asset.sourcePath);
  if (row.asset?.displayName) values.push(row.asset.displayName);
  const metadata = row.asset?.metadata && typeof row.asset.metadata === 'object'
    ? row.asset.metadata
    : {};
  for (const [key, value] of Object.entries(metadata)) {
    if (!/device|camera|model|make|lens/i.test(key)) continue;
    if (typeof value === 'string') values.push(value);
  }
  return dedupeStrings(values.flatMap(tokenizeChronologyDeviceToken));
}

function collectPharosShotExplicitDeviceTokens(shot: IProjectPharosShot): string[] {
  return dedupeStrings([
    shot.device,
    ...shot.devices,
    ...(shot.actualCaptures ?? []).flatMap(capture => [capture.camera, capture.lens ?? undefined]),
  ].flatMap(value => tokenizeChronologyDeviceToken(value ?? '')));
}

function tokenizeChronologyDeviceToken(input: string): string[] {
  return input
    .split(/[^a-zA-Z0-9]+/u)
    .map(token => token.trim().toLowerCase())
    .filter(token => token.length >= 2);
}

function canAppendToStationaryEvent(
  cluster: IChronologyEventCluster,
  row: IChronologySpanRow,
  context: IChronologyBuildContext,
): boolean {
  if (cluster.directPharosShot) return false;
  if (!isEventClusterCandidate(row)) return false;
  const previous = cluster.rows.at(-1);
  if (!previous || !isEventClusterCandidate(previous)) return false;
  if (hasPharosPointBoundaryBetween(previous, row, context)) return false;
  return areRowsChronologicallyContinuous(previous, row);
}

function canAppendToRoute(
  cluster: IChronologyEventCluster,
  row: IChronologySpanRow,
  context: IChronologyBuildContext,
): boolean {
  const previous = cluster.rows.at(-1);
  if (!previous) return false;
  if (hasPharosPointBoundaryBetween(previous, row, context)) return false;
  return isMovingRouteCandidate(row) || canAppendRouteCompanion(previous, row);
}

function isEventClusterCandidate(row: IChronologySpanRow): boolean {
  if (isMovingRouteCandidate(row)) return false;
  return isEventPreferredSpan(row.span);
}

function areRowsChronologicallyContinuous(
  previous: IChronologySpanRow,
  row: IChronologySpanRow,
): boolean {
  const previousEndMs = previous.endMs ?? previous.startMs;
  if (previousEndMs == null || row.startMs == null) return false;
  const gapMs = Math.max(0, row.startMs - previousEndMs);
  if (gapMs > CEVENT_CONTINUITY_GAP_MS) return false;
  const leftPoint = previous.spatial;
  const rightPoint = row.spatial;
  if (leftPoint && rightPoint) {
    const distanceM = distanceMeters(leftPoint, rightPoint);
    if (distanceM <= CSTATIONARY_NEIGHBOR_DISTANCE_M) return true;
    const elapsedSeconds = Math.max(1, gapMs / 1000);
    return distanceM / elapsedSeconds <= CMOVING_EVENT_CONTINUITY_MAX_SPEED_MPS;
  }
  return areSameAssetRowsTemporallyAdjacent(previous, row, gapMs);
}

function areSameAssetRowsTemporallyAdjacent(
  previous: IChronologySpanRow,
  row: IChronologySpanRow,
  gapMs: number,
): boolean {
  return previous.span.assetId === row.span.assetId
    && gapMs <= CEVENT_CONTINUITY_GAP_MS;
}

function canAppendRouteCompanion(
  previous: IChronologySpanRow,
  row: IChronologySpanRow,
): boolean {
  if (isPointLikeSpan(row)) return false;
  const previousEndMs = previous.endMs ?? previous.startMs;
  if (previousEndMs == null || row.startMs == null) return false;
  const gapMs = Math.max(0, row.startMs - previousEndMs);
  return gapMs <= CROUTE_COMPANION_GAP_MS;
}

function isMovingRouteCandidate(row: IChronologySpanRow): boolean {
  if (row.directPharosShot) return false;
  if (row.span.type === 'drive') return true;
  if (row.motion === 'stationary') return false;
  return false;
}

function buildClusterEvent(cluster: IChronologyEventCluster): IChronologyEvent {
  if (cluster.directPharosShot) {
    return buildPharosPointEvent(cluster.directPharosShot, cluster.rows);
  }
  return cluster.kind === 'route'
    ? buildRouteEvent(cluster.rows)
    : buildEventFromRows(cluster.rows);
}

function buildClusterEventDraft(cluster: IChronologyEventCluster): IChronologyEventDraft {
  return {
    event: buildClusterEvent(cluster),
    kind: cluster.kind,
    rows: [...cluster.rows],
    primaryRows: [...cluster.rows],
    directPharosShot: cluster.directPharosShot,
  };
}

function buildPharosPointEvent(
  shot: IProjectPharosShot,
  rows: IChronologySpanRow[],
): IChronologyEvent {
  return {
    id: getPharosPointEventId(shot),
    kind: 'event',
    reviewStatus: 'confirmed',
    title: shot.location || truncateText(shot.description, 48) || resolveClusterTitle(rows) || 'Pharos event',
    summary: truncateText(dedupeStrings([
      shot.description,
      summarizeRows(rows),
    ]).join(' / '), 220),
    startAt: minIso(rows.map(row => row.startAt)) ?? shot.actualTimeStart,
    endAt: maxIso(rows.map(row => row.endAt ?? row.startAt)) ?? shot.actualTimeEnd,
    location: shot.location,
    spanIds: rows.map(row => row.span.id),
  };
}

function buildRouteEvent(rows: IChronologySpanRow[]): IChronologyEvent {
  const spanIds = rows.map(row => row.span.id);
  const from = resolveRouteEndpointLocation(rows, 'start');
  const to = resolveRouteEndpointLocation(rows, 'end');
  const title = from && to && from !== to
    ? `行车：${from} → ${to}`
    : from
      ? `行车：${from}`
      : '行车段';
  return {
    id: `route-${hashText(`route:${spanIds[0] ?? ''}`).slice(0, 12)}`,
    kind: 'route',
    reviewStatus: 'pending',
    title,
    summary: summarizeRows(rows),
    startAt: minIso(rows.map(row => row.startAt)),
    endAt: maxIso(rows.map(row => row.endAt ?? row.startAt)),
    location: from && to && from === to ? from : undefined,
    route: from || to ? { from, to } : undefined,
    spanIds,
  };
}

function buildEventFromRows(rows: IChronologySpanRow[]): IChronologyEvent {
  const spanIds = rows.map(row => row.span.id);
  const location = resolveClusterLocation(rows);
  return {
    id: `event-${hashText(`event:${spanIds[0] ?? ''}`).slice(0, 12)}`,
    kind: 'event',
    reviewStatus: 'pending',
    title: resolveClusterTitle(rows) ?? location ?? 'Event',
    summary: summarizeRows(rows),
    startAt: minIso(rows.map(row => row.startAt)),
    endAt: maxIso(rows.map(row => row.endAt ?? row.startAt)),
    location,
    spanIds,
  };
}

function buildPharosGapEvents(
  pharosContext: IProjectPharosContext | null,
  spanEvents: IChronologyEvent[],
): IChronologyEvent[] {
  if (!pharosContext || pharosContext.status !== 'success') return [];
  const coveredPharosEventIds = new Set(spanEvents.map(event => event.id));
  return pharosContext.shots
    .filter(isRealizedPharosPointShot)
    .filter(shot => !coveredPharosEventIds.has(getPharosPointEventId(shot)))
    .map(shot => ({
      id: `gap-${hashText([
        shot.tripTitle,
        shot.dayTitle,
        shot.ref.tripId,
        shot.ref.shotId,
        shot.location,
        shot.description,
        shot.actualTimeStart,
        shot.plannedTimeStart,
        shot.timeWindowStart,
      ].filter(Boolean).join('|')).slice(0, 12)}`,
      kind: 'gap' as const,
      reviewStatus: 'pending' as const,
      title: `Missing: ${shot.location}`,
      summary: shot.description,
      startAt: shot.actualTimeStart ?? shot.plannedTimeStart ?? shot.timeWindowStart,
      endAt: shot.actualTimeEnd ?? shot.plannedTimeEnd ?? shot.timeWindowEnd,
      location: shot.location,
      spanIds: [],
    }));
}

function applyExistingEventReview(
  events: IChronologyEvent[],
  existing: IProjectChronology | null,
): IChronologyEvent[] {
  if (!existing) return events;
  const priorById = new Map(existing.events.map(event => [event.id, event] as const));
  return events.map(event => {
    const prior = priorById.get(event.id);
    if (!prior) return event;
    if (prior.reviewStatus === 'pending') {
      return event;
    }
    const preservedLocation = sanitizeChronologyLocationText(prior.location) ?? event.location;
    const preservedRouteFrom = sanitizeChronologyLocationText(prior.route?.from);
    const preservedRouteTo = sanitizeChronologyLocationText(prior.route?.to);
    const preservedRoute = preservedRouteFrom || preservedRouteTo
      ? { from: preservedRouteFrom, to: preservedRouteTo }
      : event.route;
    return {
      ...event,
      reviewStatus: prior.reviewStatus,
      title: isBadGeneratedChronologyTitle(prior.title) ? event.title : prior.title || event.title,
      summary: prior.summary ?? event.summary,
      location: preservedLocation,
      route: preservedRoute,
    };
  });
}

function isEventPreferredSpan(span: IKtepSlice): boolean {
  return span.type === 'aerial'
    || span.type === 'broll'
    || span.type === 'talking-head'
    || span.type === 'timelapse'
    || span.type === 'shot'
    || span.type === 'unknown';
}

function isPhotoAccessoryRow(row: IChronologySpanRow): boolean {
  return row.span.type === 'photo' || row.asset?.kind === 'photo';
}

function getDraftPrimaryRows(draft: Pick<IChronologyEventDraft, 'rows' | 'primaryRows'>): IChronologySpanRow[] {
  return draft.primaryRows.length > 0 ? draft.primaryRows : draft.rows;
}

function resolveClusterTitle(rows: IChronologySpanRow[]): string | undefined {
  for (const row of rows) {
    const title = resolveSpanStoryTitle(row.span);
    if (title) return title;
  }
  const location = resolveClusterLocation(rows);
  if (location) return location;
  for (const row of rows) {
    const title = truncateText(row.span.semanticKind, 48);
    if (isUsableEventTitle(title)) return title;
  }
  for (const row of rows) {
    const title = resolveSpanFallbackTitle(row.span);
    if (title) return title;
  }
  return undefined;
}

function resolveClusterTitleWithLocation(
  rows: IChronologySpanRow[],
  location: string | undefined,
): string | undefined {
  for (const row of rows) {
    const title = resolveSpanStoryTitle(row.span);
    if (title) return title;
  }
  if (location) return location;
  for (const row of rows) {
    const title = truncateText(row.span.semanticKind, 48);
    if (isUsableEventTitle(title)) return title;
  }
  for (const row of rows) {
    const title = resolveSpanFallbackTitle(row.span);
    if (title) return title;
  }
  return undefined;
}

function resolveSpanStoryTitle(span: IKtepSlice): string | undefined {
  const story = truncateText(span.materialPatterns[4], 48);
  return isUsableEventTitle(story) ? story : undefined;
}

function resolveSpanFallbackTitle(span: IKtepSlice): string | undefined {
  switch (span.type) {
    case 'photo':
      return '照片时刻';
    case 'aerial':
      return '航拍段落';
    case 'talking-head':
      return '口播片段';
    case 'broll':
      return '环境观察';
    case 'timelapse':
      return '延时片段';
    case 'drive':
      return undefined;
    default:
      return '素材事件';
  }
}

function isUsableEventTitle(value: string | undefined): value is string {
  if (!value) return false;
  const normalized = normalizeSemanticText(value);
  return normalized.length > 0
    && normalized !== normalizeSemanticText('情景不明')
    && normalized !== normalizeSemanticText('第一人称行车');
}

function resolveClusterLocation(rows: IChronologySpanRow[]): string | undefined {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const location = sanitizeChronologyLocationText(row.location);
    if (!location) continue;
    counts.set(location, (counts.get(location) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0]?.[0];
}

function resolveRouteEndpointLocation(
  rows: IChronologySpanRow[],
  role: 'start' | 'end',
): string | undefined {
  const orderedRows = role === 'start' ? rows : [...rows].reverse();
  for (const row of orderedRows) {
    const point = role === 'start'
      ? row.startPoint ?? row.spatial ?? row.endPoint
      : row.endPoint ?? row.spatial ?? row.startPoint;
    const location = sanitizeChronologyLocationText(point?.locationText)
      ?? sanitizeChronologyLocationText(row.location);
    if (location) return location;
  }
  return undefined;
}

function summarizeRows(rows: IChronologySpanRow[]): string | undefined {
  return truncateText(dedupeStrings(rows.flatMap(row => [
    ...row.span.materialPatterns,
    row.span.visualObservation,
    row.span.transcript,
  ])).join(' / '), 220);
}

function resolveLegacySpatialFields(span: IKtepSlice): Pick<IChronologySpanRow, 'location' | 'routeRole'> {
  const spatialEvidence = (span.grounding?.spatialEvidence ?? [])
    .filter(evidence => evidence.locationText || typeof evidence.lat === 'number' || typeof evidence.lng === 'number')
    .sort((left, right) => (right.confidence ?? 0) - (left.confidence ?? 0))[0];
  return {
    location: spatialEvidence?.locationText,
    routeRole: spatialEvidence?.routeRole,
  };
}

function buildChronologyInputsHash(input: {
  assets: IKtepAsset[];
  reports: IAssetCoarseReport[];
  roots: IMediaRoot[];
  spans: IKtepSlice[];
  pharosContext: IProjectPharosContext | null;
  pharosGpsPoints: IChronologyTimedPoint[];
  projectGpsPoints: IChronologyTimedPoint[];
  derivedTrackEntries: IChronologyDerivedTrackEntry[];
  geocodeFingerprint: string;
}): string {
  return createHash('sha256')
    .update(stableStringify({
      assets: input.assets.map(asset => ({
        id: asset.id,
        ingestRootId: asset.ingestRootId,
        capturedAt: asset.capturedAt,
        durationMs: asset.durationMs,
        embeddedGps: summarizeEmbeddedGps(asset),
      })).sort((left, right) => left.id.localeCompare(right.id)),
      roots: input.roots.map(root => ({
        id: root.id,
        clockOffsetMs: root.clockOffsetMs,
      })).sort((left, right) => left.id.localeCompare(right.id)),
      reports: input.reports.map(report => ({
        assetId: report.assetId,
        updatedAt: report.updatedAt,
        summary: report.summary,
        gpsSummary: report.gpsSummary,
        inferredGps: report.inferredGps
          ? {
            source: report.inferredGps.source,
            lat: report.inferredGps.lat,
            lng: report.inferredGps.lng,
            locationText: report.inferredGps.locationText,
          }
          : undefined,
        placeHints: report.placeHints,
        pharosStatus: report.pharosStatus,
        primaryPharosRef: report.primaryPharosRef,
        pharosMatches: report.pharosMatches.map(match => ({
          tripId: match.ref.tripId,
          shotId: match.ref.shotId,
          status: match.status,
        })),
      })).sort((left, right) => left.assetId.localeCompare(right.assetId)),
      spans: input.spans.map(span => ({
        id: span.id,
        assetId: span.assetId,
        type: span.type,
        semanticKind: span.semanticKind,
        sourceInMs: span.sourceInMs,
        sourceOutMs: span.sourceOutMs,
        transcript: span.transcript,
        visualObservation: span.visualObservation,
        materialPatterns: span.materialPatterns,
        spatialEvidence: (span.grounding?.spatialEvidence ?? []).map(evidence => ({
          locationText: evidence.locationText,
          routeRole: evidence.routeRole,
          timeReference: evidence.timeReference,
          lat: evidence.lat,
          lng: evidence.lng,
        })),
      })).sort((left, right) => left.id.localeCompare(right.id)),
      pharosParserVersion: input.pharosContext?.parserVersion,
      pharosFingerprint: input.pharosContext?.sourceFingerprint,
      pharosShots: input.pharosContext?.shots.map(shot => ({
        tripId: shot.ref.tripId,
        shotId: shot.ref.shotId,
        type: shot.type,
        actualCaptures: (shot.actualCaptures ?? []).map(capture => ({
          type: capture.type,
          camera: capture.camera,
          lens: capture.lens,
        })),
        location: shot.location,
        description: shot.description,
        status: shot.status,
        actualTimeStart: shot.actualTimeStart,
        actualTimeEnd: shot.actualTimeEnd,
        plannedTimeStart: shot.plannedTimeStart,
        gps: shot.gps,
        gpsStart: shot.gpsStart,
        gpsEnd: shot.gpsEnd,
        actualGpsStart: shot.actualGpsStart,
        actualGpsEnd: shot.actualGpsEnd,
      })),
      pharosGpsPointsHash: hashTimedPoints(input.pharosGpsPoints),
      projectGpsPointsHash: hashTimedPoints(input.projectGpsPoints),
      derivedTrackHash: hashDerivedTrackEntries(input.derivedTrackEntries),
      chronologyGeocodeFingerprint: input.geocodeFingerprint,
    }))
    .digest('hex');
}

function summarizeEmbeddedGps(asset: IKtepAsset): Record<string, unknown> | undefined {
  const binding = asset.embeddedGps;
  if (!binding) return undefined;
  return {
    originType: binding.originType,
    representativeTime: binding.representativeTime,
    representativeLat: binding.representativeLat,
    representativeLng: binding.representativeLng,
    trackId: binding.trackId,
    pointCount: binding.pointCount ?? binding.points?.length,
    startTime: binding.startTime,
    endTime: binding.endTime,
    pointsHash: binding.points ? hashTimedPoints(binding.points) : undefined,
  };
}

function hashTimedPoints(points: Array<Pick<IChronologyTimedPoint, 'lat' | 'lng' | 'time' | 'path' | 'tripId' | 'locationText'>>): string {
  const hash = createHash('sha256');
  hash.update(String(points.length));
  for (const point of points) {
    hash.update(`|${point.time}|${point.lat.toFixed(7)}|${point.lng.toFixed(7)}|${point.path ?? ''}|${point.tripId ?? ''}|${point.locationText ?? ''}`);
  }
  return hash.digest('hex');
}

function hashChronologyGeocodeFingerprint(rows: IChronologyGeocodeFingerprintRow[]): string {
  return createHash('sha256')
    .update(stableStringify(rows
      .map(row => ({
        locationKey: row.locationKey,
        provider: row.provider,
        status: row.status,
        locationText: row.locationText,
      }))
      .sort((left, right) => left.locationKey.localeCompare(right.locationKey))))
    .digest('hex');
}

function hashDerivedTrackEntries(entries: IChronologyDerivedTrackEntry[]): string {
  return createHash('sha256')
    .update(stableStringify(entries.map(entry => ({
      id: entry.id,
      originType: entry.originType,
      matchKind: entry.matchKind,
      lat: entry.lat,
      lng: entry.lng,
      time: entry.time,
      startTime: entry.startTime,
      endTime: entry.endTime,
      locationText: entry.locationText,
      transport: entry.transport,
      rootRef: entry.rootRef,
      pathPrefix: entry.pathPrefix,
    }))))
    .digest('hex');
}

function pickBestDerivedPoint(
  entries: IChronologyDerivedTrackEntry[],
  timestampMs: number,
  row: IChronologySpanRow,
): IChronologyDerivedTrackEntry | null {
  let best: IChronologyDerivedTrackEntry | null = null;
  let bestDelta = Number.POSITIVE_INFINITY;
  for (const entry of entries) {
    if (!matchesDerivedTrackScope(entry, row)) continue;
    const pointMs = parseTimestamp(entry.time);
    if (pointMs == null) continue;
    const delta = Math.abs(pointMs - timestampMs);
    if (delta > CDERIVED_TRACK_MATCH_TOLERANCE_MS || delta >= bestDelta) continue;
    best = entry;
    bestDelta = delta;
  }
  return best;
}

function pickBestDerivedWindow(
  entries: IChronologyDerivedTrackEntry[],
  timestampMs: number,
  row: IChronologySpanRow,
): IChronologyDerivedTrackEntry | null {
  let best: IChronologyDerivedTrackEntry | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const entry of entries) {
    if (entry.matchKind !== 'window') continue;
    if (!matchesDerivedTrackScope(entry, row)) continue;
    const startMs = parseTimestamp(entry.startTime ?? entry.time);
    const endMs = parseTimestamp(entry.endTime ?? entry.time);
    if (startMs == null || endMs == null || timestampMs < startMs || timestampMs > endMs) continue;
    const midMs = Math.round((startMs + endMs) / 2);
    const score = (entry.pathPrefix ? 10000 + entry.pathPrefix.length : 0)
      + (entry.rootRef ? 1000 : 0)
      + (entry.locationText ? 10 : 0)
      + Math.max(0, 1000 - Math.round(Math.abs(timestampMs - midMs) / 1000));
    if (score <= bestScore) continue;
    best = entry;
    bestScore = score;
  }
  return best;
}

function matchesDerivedTrackScope(
  entry: IChronologyDerivedTrackEntry,
  row: IChronologySpanRow,
): boolean {
  return matchesDerivedTrackRoot(entry.rootRef, row.root)
    && matchesDerivedTrackPath(entry.pathPrefix, row.asset?.sourcePath ?? '', row.root);
}

function matchesDerivedTrackRoot(
  rootRef: string | undefined,
  root?: Pick<IMediaRoot, 'id' | 'label'>,
): boolean {
  if (!rootRef) return true;
  const normalized = rootRef.trim().toLowerCase();
  return normalized === (root?.id ?? '').trim().toLowerCase()
    || normalized === (root?.label ?? '').trim().toLowerCase();
}

function matchesDerivedTrackPath(
  pathPrefix: string | undefined,
  sourcePath: string,
  root?: Pick<IMediaRoot, 'id' | 'label'>,
): boolean {
  if (!pathPrefix) return true;
  const normalizedPrefix = normalizePortablePath(pathPrefix);
  const pathCandidates = buildPortablePathCandidates(sourcePath, root);
  return pathCandidates.some(candidate => (
    candidate === normalizedPrefix || candidate.startsWith(`${normalizedPrefix}/`)
  ));
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

function normalizePortablePath(value: string): string {
  return value
    .trim()
    .replace(/\\/gu, '/')
    .replace(/^\.?\//u, '')
    .replace(/\/+/gu, '/')
    .replace(/\/$/u, '')
    .toLowerCase();
}

function pickNearestTimedPoint<T extends Pick<IChronologyTimedPoint, 'time'>>(
  points: T[],
  targetMs: number,
  toleranceMs: number,
): T | null {
  let best: T | null = null;
  let bestDelta = Number.POSITIVE_INFINITY;
  for (const point of points) {
    const pointMs = parseTimestamp(point.time);
    if (pointMs == null) continue;
    const delta = Math.abs(pointMs - targetMs);
    if (delta > toleranceMs || delta >= bestDelta) continue;
    best = point;
    bestDelta = delta;
  }
  return best;
}

function toChronologyPoint(
  point: Pick<IChronologyTimedPoint, 'lat' | 'lng' | 'time' | 'locationText'>,
  source: TChronologySpatialSource,
  locationText?: string,
): IChronologyPoint {
  return {
    lat: point.lat,
    lng: point.lng,
    time: point.time,
    source,
    locationText: sanitizeChronologyLocationText(locationText ?? point.locationText),
  };
}

function resolveMotion(
  startPoint: IChronologyPoint | undefined,
  endPoint: IChronologyPoint | undefined,
): TChronologyMotion {
  if (!startPoint || !endPoint) return 'unknown';
  return distanceMeters(startPoint, endPoint) <= CSTATIONARY_SPAN_DISTANCE_M
    ? 'stationary'
    : 'moving';
}

function isReportSpatialSourceAllowed(source: IInferredGps['source']): source is 'pharos' | 'gpx' | 'derived-track' {
  return source === 'pharos' || source === 'gpx' || source === 'derived-track';
}

function isRealizedPharosPointShot(shot: IProjectPharosShot): boolean {
  return isRealizedPharosShot(shot) && normalizeSemanticText(shot.type) !== 'continuous';
}

function getPharosPointEventId(shot: IProjectPharosShot): string {
  return `event-pharos-${hashText(`${shot.ref.tripId}:${shot.ref.shotId}`).slice(0, 12)}`;
}

function isRealizedPharosContinuousShot(shot: IProjectPharosShot): boolean {
  return isRealizedPharosShot(shot) && normalizeSemanticText(shot.type) === 'continuous';
}

function isRealizedPharosShot(shot: IProjectPharosShot): boolean {
  return shot.status === 'expected' || shot.status === 'unexpected';
}

function isTimestampInsidePharosActualWindow(timestampMs: number, shot: IProjectPharosShot): boolean {
  const startMs = parseTimestamp(shot.actualTimeStart);
  const endMs = parseTimestamp(shot.actualTimeEnd);
  return startMs != null && endMs != null && endMs >= startMs && timestampMs >= startMs && timestampMs <= endMs;
}

function hasPharosPointBoundaryBetween(
  previous: IChronologySpanRow,
  row: IChronologySpanRow,
  context: IChronologyBuildContext,
): boolean {
  if (!context.pharosContext || context.pharosContext.status !== 'success') return false;
  const previousMs = previous.endMs ?? previous.startMs;
  const rowMs = row.startMs;
  if (previousMs == null || rowMs == null) return false;
  const leftMs = Math.min(previousMs, rowMs);
  const rightMs = Math.max(previousMs, rowMs);
  if (rightMs <= leftMs) return false;
  return context.pharosContext.shots
    .filter(isRealizedPharosPointShot)
    .some(shot => isPharosShotBetween(shot, leftMs, rightMs));
}

function isPharosShotBetween(shot: IProjectPharosShot, leftMs: number, rightMs: number): boolean {
  const startMs = parseTimestamp(shot.actualTimeStart ?? shot.plannedTimeStart ?? shot.timeWindowStart);
  const endMs = parseTimestamp(shot.actualTimeEnd ?? shot.plannedTimeEnd ?? shot.timeWindowEnd);
  if (startMs == null && endMs == null) return false;
  const normalizedStartMs = startMs ?? endMs!;
  const normalizedEndMs = endMs ?? startMs!;
  return normalizedStartMs < rightMs && normalizedEndMs > leftMs;
}

function comparePharosShots(left: IProjectPharosShot, right: IProjectPharosShot): number {
  return (left.actualTimeStart ?? '').localeCompare(right.actualTimeStart ?? '')
    || left.ref.tripId.localeCompare(right.ref.tripId)
    || left.ref.shotId.localeCompare(right.ref.shotId);
}

function isPointLikeSpan(row: IChronologySpanRow): boolean {
  return row.span.type === 'photo' || row.asset?.kind === 'photo' || row.durationMs <= 1_000;
}

function getRowMidpointMs(row: IChronologySpanRow): number {
  if (row.startMs == null) return 0;
  if (row.endMs == null || row.endMs < row.startMs) return row.startMs;
  return Math.round((row.startMs + row.endMs) / 2);
}

function addMs(iso: string | undefined, offsetMs: number | undefined): string | undefined {
  if (!iso) return undefined;
  const baseMs = Date.parse(iso);
  if (!Number.isFinite(baseMs)) return iso;
  return new Date(baseMs + Math.max(0, Math.round(offsetMs ?? 0))).toISOString();
}

function parseTimestamp(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function minNumber(values: Array<number | undefined>): number | undefined {
  const numbers = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  return numbers.length > 0 ? Math.min(...numbers) : undefined;
}

function maxNumber(values: Array<number | undefined>): number | undefined {
  const numbers = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  return numbers.length > 0 ? Math.max(...numbers) : undefined;
}

function minIso(values: Array<string | undefined>): string | undefined {
  return values.filter(Boolean).sort()[0];
}

function maxIso(values: Array<string | undefined>): string | undefined {
  return values.filter(Boolean).sort().at(-1);
}

function compareChronologyAssetIndex(
  left: IChronologyAssetIndex,
  right: IChronologyAssetIndex,
): number {
  const leftKey = left.sortCapturedAt ?? '';
  const rightKey = right.sortCapturedAt ?? '';
  if (leftKey && rightKey && leftKey !== rightKey) return leftKey.localeCompare(rightKey);
  if (leftKey && !rightKey) return -1;
  if (!leftKey && rightKey) return 1;
  return left.assetId.localeCompare(right.assetId);
}

function compareSpanRows(left: IChronologySpanRow, right: IChronologySpanRow): number {
  return String(left.startAt ?? '').localeCompare(String(right.startAt ?? ''))
    || left.span.assetId.localeCompare(right.span.assetId)
    || (left.span.sourceInMs ?? 0) - (right.span.sourceInMs ?? 0)
    || left.span.id.localeCompare(right.span.id);
}

function compareChronologyEvents(left: IChronologyEvent, right: IChronologyEvent): number {
  return String(left.startAt ?? left.endAt ?? '').localeCompare(String(right.startAt ?? right.endAt ?? ''))
    || left.id.localeCompare(right.id);
}

function distanceMeters(
  left: Pick<IChronologyPoint, 'lat' | 'lng'>,
  right: Pick<IChronologyPoint, 'lat' | 'lng'>,
): number {
  const earthRadiusM = 6_371_000;
  const leftLat = toRadians(left.lat);
  const rightLat = toRadians(right.lat);
  const deltaLat = toRadians(right.lat - left.lat);
  const deltaLng = toRadians(right.lng - left.lng);
  const a = Math.sin(deltaLat / 2) ** 2
    + Math.cos(leftLat) * Math.cos(rightLat) * Math.sin(deltaLng / 2) ** 2;
  return earthRadiusM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function toRadians(value: number): number {
  return value * Math.PI / 180;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
    return Object.fromEntries(
      Object.entries(item as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)),
    );
  });
}

function shouldReportChronologyProgress(
  current: number,
  total: number,
  batchSize: number,
): boolean {
  const normalizedBatchSize = Math.max(1, Math.round(batchSize));
  return current === total || current === 1 || current % normalizedBatchSize === 0;
}

async function reportChronologyProgress(
  onProgress: IBuildMediaChronologyWithProgressOptions['onProgress'],
  progress: IChronologyBuildProgress,
): Promise<void> {
  await onProgress?.(progress);
  await yieldToEventLoop();
}

async function yieldToEventLoop(): Promise<void> {
  await new Promise<void>(resolve => setTimeout(resolve, 0));
}

function normalizeSemanticText(value: string): string {
  return value.toLowerCase().replace(/\s+/gu, ' ').trim();
}

function sanitizeChronologyLocationText(value: string | undefined): string | undefined {
  const text = value?.trim();
  if (!text || isBadChronologyLocationText(text)) return undefined;
  return text;
}

function isBadChronologyLocationText(value: string): boolean {
  const normalized = normalizeSemanticText(value);
  return normalized.length === 0
    || normalized.includes('→')
    || normalized.includes('->')
    || normalized.includes('全程')
    || normalized.includes('route near')
    || normalized === normalizeSemanticText('第一人称行车');
}

function isBadGeneratedChronologyTitle(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = normalizeSemanticText(value);
  return normalized.includes('全程')
    || normalized.includes('route near')
    || normalized === normalizeSemanticText('第一人称行车');
}

function normalizeChronologyLocationIdentity(value: string): string {
  return value.replace(/[\s，、,.·\-–—>→]+/gu, '').toLowerCase();
}

function truncateText(value: string | undefined, maxLength: number): string | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}...` : text;
}

function dedupeStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === 'string' && value.trim().length > 0))];
}

function hashText(text: string): string {
  return createHash('sha1').update(text).digest('hex');
}
