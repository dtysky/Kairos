import { createHash } from 'node:crypto';
import type {
  IAssetCoarseReport,
  IChronologyAssetIndex,
  IChronologyEvent,
  IKtepAsset,
  IKtepSlice,
  IMediaRoot,
  IProjectChronology,
  IProjectPharosContext,
} from '../../protocol/schema.js';

export interface IBuildMediaChronologyOptions {
  spans?: IKtepSlice[];
  pharosContext?: IProjectPharosContext | null;
  now?: string;
}

interface IChronologySpanRow {
  span: IKtepSlice;
  startAt?: string;
  endAt?: string;
  location?: string;
  routeRole?: string;
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
  });
  const baseEvents = [
    ...buildSpanEvents(options.spans ?? [], assetIndex),
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
  assetIndex: IChronologyAssetIndex[],
): IChronologyEvent[] {
  const assetSortMap = new Map(assetIndex.map((item, index) => [item.assetId, { item, index }] as const));
  const rows = spans
    .map(span => buildSpanRow(span, assetSortMap.get(span.assetId)?.item.sortCapturedAt))
    .sort(compareSpanRows);
  const events: IChronologyEvent[] = [];
  let currentRoute: IChronologySpanRow[] = [];

  const flushRoute = () => {
    if (currentRoute.length === 0) return;
    events.push(buildRouteEvent(currentRoute));
    currentRoute = [];
  };

  for (const row of rows) {
    if (isSemanticSpeechRouteBreak(row.span)) {
      flushRoute();
      events.push(buildEventFromSpan(row));
      continue;
    }
    if (isRouteLikeSpan(row.span)) {
      currentRoute.push(row);
      continue;
    }
    flushRoute();
    events.push(buildEventFromSpan(row));
  }
  flushRoute();

  return events;
}

function buildSpanRow(
  span: IKtepSlice,
  assetSortCapturedAt?: string,
): IChronologySpanRow {
  const spatialEvidence = (span.grounding?.spatialEvidence ?? [])
    .filter(evidence => evidence.locationText || typeof evidence.lat === 'number' || typeof evidence.lng === 'number')
    .sort((left, right) => (right.confidence ?? 0) - (left.confidence ?? 0))[0];
  return {
    span,
    startAt: addMs(assetSortCapturedAt, span.sourceInMs),
    endAt: addMs(assetSortCapturedAt, span.sourceOutMs ?? span.sourceInMs),
    location: spatialEvidence?.locationText,
    routeRole: spatialEvidence?.routeRole,
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
    id: `route-${hashText(spanIds.join('|')).slice(0, 12)}`,
    kind: 'route',
    reviewStatus: 'pending',
    title,
    summary: summarizeRows(rows),
    startAt: rows.map(row => row.startAt).filter(Boolean).sort()[0],
    endAt: rows.map(row => row.endAt ?? row.startAt).filter(Boolean).sort().at(-1),
    location: from && to && from === to ? from : undefined,
    route: from || to ? { from, to } : undefined,
    spanIds,
  };
}

function buildEventFromSpan(row: IChronologySpanRow): IChronologyEvent {
  return {
    id: `event-${hashText(row.span.id).slice(0, 12)}`,
    kind: 'event',
    reviewStatus: 'pending',
    title: resolveEventTitle(row.span, row.location),
    summary: resolveEventSummary(row.span),
    startAt: row.startAt,
    endAt: row.endAt,
    location: row.location,
    spanIds: [row.span.id],
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

function isRouteLikeSpan(span: IKtepSlice): boolean {
  if (span.type === 'drive' || span.type === 'aerial') return true;
  const text = normalizeSemanticText([
    span.semanticKind,
    span.visualObservation,
    span.transcript,
    ...span.materialPatterns,
  ].filter(Boolean).join(' '));
  return /车内|行车|开车|自驾|路上|公路|高速|山路|drive|driving|road|route|highway|inside car|car cabin/u.test(text);
}

function isSemanticSpeechRouteBreak(span: IKtepSlice): boolean {
  const speechText = normalizeSemanticText([
    span.transcript,
    ...(span.transcriptSegments ?? []).map(segment => segment.text),
  ].filter(Boolean).join(' '));
  if (!speechText) return false;
  return /改线|改道|绕路|封路|事故|堵车|到达|到了|抵达|停车|停一下|住下|住宿|入住|吃饭|午饭|晚饭|早餐|服务区|进景区|进入景区|进山|下车|下高速|上高速|route changed|detour|arrived|arrival|parked|stopped|hotel|check in|lunch|dinner|scenic area/u.test(speechText);
}

function resolveEventTitle(span: IKtepSlice, location?: string): string {
  const pattern = span.materialPatterns.find(item => item.trim().length > 0);
  if (pattern) return truncateText(pattern, 48) ?? pattern;
  if (location) return location;
  if (span.semanticKind) return span.semanticKind;
  if (span.type === 'photo') return 'Photo moment';
  return 'Event';
}

function resolveEventSummary(span: IKtepSlice): string | undefined {
  return truncateText(
    span.visualObservation?.trim()
      || span.transcript?.trim()
      || span.materialPatterns.join(' / '),
    180,
  );
}

function summarizeRows(rows: IChronologySpanRow[]): string | undefined {
  return truncateText(dedupeStrings(rows.flatMap(row => [
    ...row.span.materialPatterns,
    row.span.visualObservation,
  ])).join(' / '), 220);
}

function buildChronologyInputsHash(input: {
  assets: IKtepAsset[];
  reports: IAssetCoarseReport[];
  roots: IMediaRoot[];
  spans: IKtepSlice[];
  pharosContext: IProjectPharosContext | null;
}): string {
  return createHash('sha256')
    .update(stableStringify({
      assets: input.assets.map(asset => ({
        id: asset.id,
        ingestRootId: asset.ingestRootId,
        capturedAt: asset.capturedAt,
        durationMs: asset.durationMs,
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
        location: shot.location,
        description: shot.description,
        status: shot.status,
        actualTimeStart: shot.actualTimeStart,
        plannedTimeStart: shot.plannedTimeStart,
      })),
    }))
    .digest('hex');
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
