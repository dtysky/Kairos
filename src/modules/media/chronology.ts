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

const CCHRONOLOGY_GPS_MATCH_TOLERANCE_MS = 5 * 60_000;
const CDERIVED_TRACK_MATCH_TOLERANCE_MS = 15 * 60_000;
const CSTATIONARY_SPAN_DISTANCE_M = 200;
const CSTATIONARY_NEIGHBOR_DISTANCE_M = 400;

export interface IChronologyTimedPoint {
  lat: number;
  lng: number;
  time: string;
  path?: string;
  tripId?: string;
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

export function buildMediaChronology(
  assets: IKtepAsset[],
  reports: IAssetCoarseReport[] = [],
  existing: IProjectChronology | null = null,
  roots: IMediaRoot[] = [],
  options: IBuildMediaChronologyOptions = {},
): IProjectChronology {
  const now = options.now ?? new Date().toISOString();
  const rootMap = new Map(roots.map(root => [root.id, root]));
  const assetIndex = buildChronologyAssetIndex(assets, rootMap);
  const inputsHash = buildChronologyInputsHash({
    assets,
    reports,
    roots,
    spans: options.spans ?? [],
    pharosContext: options.pharosContext ?? null,
    pharosGpsPoints: options.pharosGpsPoints ?? [],
    projectGpsPoints: options.projectGpsPoints ?? [],
    derivedTrackEntries: options.derivedTrack?.entries ?? [],
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
  const baseEvents = [
    ...buildSpanEvents(options.spans ?? [], context),
    ...buildPharosGapEvents(options.pharosContext ?? null),
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

function buildChronologyAssetIndex(
  assets: IKtepAsset[],
  rootMap: Map<string, IMediaRoot>,
): IChronologyAssetIndex[] {
  return assets
    .map(asset => ({
      assetId: asset.id,
      sortCapturedAt: applyRootClockOffset(asset.capturedAt, rootMap.get(asset.ingestRootId ?? '')?.clockOffsetMs)
        ?? asset.capturedAt,
    }))
    .sort(compareChronologyAssetIndex);
}

function buildSpanEvents(
  spans: IKtepSlice[],
  context: IChronologyBuildContext,
): IChronologyEvent[] {
  const rows = spans
    .map(span => buildSpanRow(span, context))
    .sort(compareSpanRows);
  const events: IChronologyEvent[] = [];
  let current: IChronologyEventCluster | null = null;

  const flush = () => {
    if (!current || current.rows.length === 0) return;
    events.push(buildClusterEvent(current));
    current = null;
  };

  for (const row of rows) {
    if (row.directPharosShot) {
      if (current?.directPharosShot && isSamePharosShot(current.directPharosShot, row.directPharosShot)) {
        current.rows.push(row);
      } else {
        flush();
        current = {
          kind: 'event',
          rows: [row],
          directPharosShot: row.directPharosShot,
        };
      }
      continue;
    }

    if (current?.directPharosShot) {
      flush();
    }

    if (current?.kind === 'event' && canAppendToStationaryEvent(current, row)) {
      current.rows.push(row);
      continue;
    }

    if (current?.kind === 'route' && canAppendToRoute(current, row)) {
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
    location: directPharosShot?.location
      ?? spatial.location
      ?? baseRow.location
      ?? report?.inferredGps?.locationText
      ?? report?.placeHints[0],
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
    location: continuousPharosShot?.location,
  }) ?? (continuousPharosShot
    ? resolveTimedTrackSpatial({
      row,
      points: context.pharosGpsPoints,
      source: 'pharos-gpx',
      location: continuousPharosShot.location,
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
    .map(shot => ({ shot, score: scorePharosPointOverlap(row, shot) }))
    .filter(item => item.score > 0)
    .sort((left, right) =>
      right.score - left.score
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
  return overlap * 2 >= row.durationMs ? overlap / Math.max(1, row.durationMs) : 0;
}

function canAppendToStationaryEvent(
  cluster: IChronologyEventCluster,
  row: IChronologySpanRow,
): boolean {
  if (cluster.directPharosShot) return false;
  if (!isStationaryEventCandidate(row)) return false;
  const previous = cluster.rows.at(-1);
  if (!previous || !isStationaryEventCandidate(previous)) return false;
  const leftPoint = previous.spatial;
  const rightPoint = row.spatial;
  if (!leftPoint || !rightPoint) return false;
  return distanceMeters(leftPoint, rightPoint) <= CSTATIONARY_NEIGHBOR_DISTANCE_M;
}

function canAppendToRoute(
  _cluster: IChronologyEventCluster,
  row: IChronologySpanRow,
): boolean {
  return isMovingRouteCandidate(row);
}

function isStationaryEventCandidate(row: IChronologySpanRow): boolean {
  if (row.motion === 'moving') return false;
  if (row.motion === 'stationary') return true;
  return Boolean(row.spatial && isEventPreferredSpan(row.span));
}

function isMovingRouteCandidate(row: IChronologySpanRow): boolean {
  if (row.directPharosShot) return false;
  if (row.motion === 'stationary') return false;
  if (row.span.type === 'drive') return true;
  if (row.span.type === 'aerial') return false;
  return isRouteLikeSpan(row.span);
}

function buildClusterEvent(cluster: IChronologyEventCluster): IChronologyEvent {
  if (cluster.directPharosShot) {
    return buildPharosPointEvent(cluster.directPharosShot, cluster.rows);
  }
  return cluster.kind === 'route'
    ? buildRouteEvent(cluster.rows)
    : buildEventFromRows(cluster.rows);
}

function buildPharosPointEvent(
  shot: IProjectPharosShot,
  rows: IChronologySpanRow[],
): IChronologyEvent {
  return {
    id: `event-pharos-${hashText(`${shot.ref.tripId}:${shot.ref.shotId}`).slice(0, 12)}`,
    kind: 'event',
    reviewStatus: 'pending',
    title: shot.location || resolveClusterTitle(rows) || 'Pharos event',
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
  const from = rows.find(row => row.location)?.location;
  const to = [...rows].reverse().find(row => row.location)?.location;
  const title = from && to && from !== to
    ? `${from} -> ${to}`
    : from
      ? `Route near ${from}`
      : 'Route segment';
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
): IChronologyEvent[] {
  if (!pharosContext || pharosContext.status !== 'success') return [];
  return pharosContext.shots
    .filter(shot => shot.status === 'pending')
    .map(shot => ({
      id: `gap-${hashText([
        shot.tripTitle,
        shot.dayTitle,
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
    return {
      ...event,
      reviewStatus: prior.reviewStatus,
      title: prior.title || event.title,
      summary: prior.summary ?? event.summary,
      location: prior.location ?? event.location,
      route: prior.route ?? event.route,
    };
  });
}

function isEventPreferredSpan(span: IKtepSlice): boolean {
  return span.type === 'aerial'
    || span.type === 'photo'
    || span.type === 'broll'
    || span.type === 'talking-head'
    || span.type === 'timelapse'
    || span.type === 'shot'
    || span.type === 'unknown';
}

function isRouteLikeSpan(span: IKtepSlice): boolean {
  if (span.type === 'drive') return true;
  const text = normalizeSemanticText([
    span.semanticKind,
    span.visualObservation,
    span.transcript,
    ...span.materialPatterns,
  ].filter(Boolean).join(' '));
  return /车内|行车|开车|自驾|路上|公路|高速|山路|drive|driving|road|route|highway|inside car|car cabin/u.test(text);
}

function resolveClusterTitle(rows: IChronologySpanRow[]): string | undefined {
  for (const row of rows) {
    const pattern = row.span.materialPatterns.find(item => item.trim().length > 0);
    const title = truncateText(pattern, 48);
    if (title) return title;
  }
  const location = resolveClusterLocation(rows);
  if (location) return location;
  for (const row of rows) {
    if (row.span.semanticKind) return row.span.semanticKind;
  }
  if (rows.some(row => row.span.type === 'photo')) return 'Photo moment';
  return undefined;
}

function resolveClusterLocation(rows: IChronologySpanRow[]): string | undefined {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const location = row.location?.trim();
    if (!location) continue;
    counts.set(location, (counts.get(location) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0]?.[0];
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
      pharosFingerprint: input.pharosContext?.sourceFingerprint,
      pharosShots: input.pharosContext?.shots.map(shot => ({
        tripId: shot.ref.tripId,
        shotId: shot.ref.shotId,
        type: shot.type,
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

function hashTimedPoints(points: Array<Pick<IChronologyTimedPoint, 'lat' | 'lng' | 'time' | 'path' | 'tripId'>>): string {
  const hash = createHash('sha256');
  hash.update(String(points.length));
  for (const point of points) {
    hash.update(`|${point.time}|${point.lat.toFixed(7)}|${point.lng.toFixed(7)}|${point.path ?? ''}|${point.tripId ?? ''}`);
  }
  return hash.digest('hex');
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
  point: Pick<IChronologyTimedPoint, 'lat' | 'lng' | 'time'>,
  source: TChronologySpatialSource,
  locationText?: string,
): IChronologyPoint {
  return {
    lat: point.lat,
    lng: point.lng,
    time: point.time,
    source,
    locationText,
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

function isSamePharosShot(left: IProjectPharosShot, right: IProjectPharosShot): boolean {
  return left.ref.tripId === right.ref.tripId && left.ref.shotId === right.ref.shotId;
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

function applyRootClockOffset(
  capturedAt: string | undefined,
  clockOffsetMs: number | undefined,
): string | undefined {
  if (!capturedAt) return undefined;
  if (clockOffsetMs == null || !Number.isFinite(clockOffsetMs) || clockOffsetMs === 0) {
    return capturedAt;
  }
  const capturedAtMs = Date.parse(capturedAt);
  if (!Number.isFinite(capturedAtMs)) return capturedAt;
  return new Date(capturedAtMs + clockOffsetMs).toISOString();
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

function normalizeSemanticText(value: string): string {
  return value.toLowerCase().replace(/\s+/gu, ' ').trim();
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
