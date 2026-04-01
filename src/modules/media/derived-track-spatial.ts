import type { IKtepAsset, IMediaRoot } from '../../protocol/schema.js';
import type { IProjectDerivedTrack, IProjectDerivedTrackEntry } from '../../store/index.js';
import type { IManualSpatialContext } from './manual-spatial.js';
import { pickNearestTimedPoint } from './gpx-spatial.js';

const CDEFAULT_DERIVED_POINT_MATCH_TOLERANCE_MS = 15 * 60 * 1000;

export interface IResolveDerivedTrackSpatialContextInput {
  asset: Pick<IKtepAsset, 'capturedAt' | 'sourcePath'>;
  root?: Pick<IMediaRoot, 'id' | 'label'>;
  derivedTrack?: IProjectDerivedTrack | null;
  pointMatchToleranceMs?: number;
}

export function resolveDerivedTrackSpatialContext(
  input: IResolveDerivedTrackSpatialContextInput,
): IManualSpatialContext | null {
  if (!input.asset.capturedAt || !input.derivedTrack?.entries.length) return null;

  const assetTimestamp = Date.parse(input.asset.capturedAt);
  if (Number.isNaN(assetTimestamp)) return null;

  const pointEntries = input.derivedTrack.entries.filter(isTimedPointEntry);
  const pointMatch = pickNearestTimedPoint(
    pointEntries,
    assetTimestamp,
    input.pointMatchToleranceMs ?? CDEFAULT_DERIVED_POINT_MATCH_TOLERANCE_MS,
  );
  if (pointMatch) {
    return buildDerivedTrackContext(pointMatch, assetTimestamp);
  }

  const windowMatch = pickBestWindowEntry(input.derivedTrack.entries, assetTimestamp, input.asset.sourcePath, input.root);
  if (!windowMatch) return null;
  return buildDerivedTrackContext(windowMatch, assetTimestamp);
}

function pickBestWindowEntry(
  entries: IProjectDerivedTrackEntry[],
  assetTimestamp: number,
  sourcePath: string,
  root?: Pick<IMediaRoot, 'id' | 'label'>,
): IProjectDerivedTrackEntry | null {
  let best: IProjectDerivedTrackEntry | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;

  for (const entry of entries) {
    if (entry.matchKind !== 'window') continue;
    if (!matchesDerivedTrackRoot(entry.rootRef, root)) continue;
    if (!matchesDerivedTrackPath(entry.pathPrefix, sourcePath, root)) continue;

    const startMs = Date.parse(entry.startTime ?? entry.time ?? '');
    const endMs = Date.parse(entry.endTime ?? entry.time ?? '');
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) continue;
    if (assetTimestamp < startMs || assetTimestamp > endMs) continue;

    const midMs = Math.round((startMs + endMs) / 2);
    const score = (entry.pathPrefix ? 10000 + entry.pathPrefix.length : 0)
      + (entry.rootRef ? 1000 : 0)
      + (entry.locationText ? 10 : 0)
      + Math.max(0, 1000 - Math.round(Math.abs(assetTimestamp - midMs) / 1000));
    if (score > bestScore) {
      best = entry;
      bestScore = score;
    }
  }

  return best;
}

function isTimedPointEntry(
  entry: IProjectDerivedTrackEntry,
): entry is IProjectDerivedTrackEntry & { time: string } {
  return entry.matchKind === 'point' && typeof entry.time === 'string';
}

function buildDerivedTrackContext(
  entry: IProjectDerivedTrackEntry,
  assetTimestamp: number,
): IManualSpatialContext {
  const gpsSummary = entry.summary ?? buildDerivedTrackSummary(entry, assetTimestamp);
  const placeHints = dedupeStrings([
    entry.locationText,
    ...splitManualPlaceHints(entry.locationText),
  ]);
  const decisionReasons = dedupeStrings([
    'derived-track-match',
    `derived-track-origin:${entry.originType}`,
    entry.time ? `derived-track-delta-ms:${Math.abs(Date.parse(entry.time) - assetTimestamp)}` : undefined,
    entry.startTime && entry.endTime ? `derived-track-window:${entry.startTime}..${entry.endTime}` : undefined,
  ]);

  return {
    gpsSummary,
    inferredGps: {
      source: 'derived-track',
      confidence: entry.confidence,
      lat: entry.lat,
      lng: entry.lng,
      derivedOriginType: entry.originType,
      timezone: entry.timezone,
      sourceAssetId: entry.sourceAssetId,
      sourcePath: entry.sourcePath,
      matchedItinerarySegmentId: entry.matchedItinerarySegmentId,
      locationText: entry.locationText,
      summary: gpsSummary,
    },
    placeHints,
    transport: entry.transport,
    decisionReasons,
  };
}

function buildDerivedTrackSummary(
  entry: IProjectDerivedTrackEntry,
  assetTimestamp: number,
): string {
  if (entry.matchKind === 'point' && entry.time) {
    const deltaSeconds = Math.round(Math.abs(Date.parse(entry.time) - assetTimestamp) / 1000);
    return `derived-track ${entry.originType} ${entry.time} ${entry.lat.toFixed(6)},${entry.lng.toFixed(6)} Δ${deltaSeconds}s`;
  }
  return `derived-track ${entry.originType} ${entry.startTime ?? entry.time ?? ''}-${entry.endTime ?? entry.time ?? ''} ${entry.locationText ?? `${entry.lat.toFixed(6)},${entry.lng.toFixed(6)}`}`.trim();
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
