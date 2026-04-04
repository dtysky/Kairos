import { createHash } from 'node:crypto';
import { mkdir, open, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, parse } from 'node:path';
import * as nodeFetchModule from 'node-fetch';
import { DJILog } from 'dji-log-parser-js';
import type {
  IEmbeddedGpsBinding,
  IEmbeddedGpsPoint,
  IKtepAsset,
} from '../../protocol/schema.js';
import {
  getProjectSameSourceGpsRoot,
  getProjectSameSourceGpsTrackPath,
  loadProjectSameSourceGpsIndex,
  writeProjectSameSourceGpsIndex,
  type EProjectSameSourceGpsOriginType,
  type IProjectSameSourceGpsIndex,
  type IProjectSameSourceGpsTrackSummary,
} from '../../store/gps.js';
import { loadGpxPoints, pickNearestTimedPoint } from './gpx-spatial.js';

const CSRT_BINDING_CONFIDENCE = 0.96;
const CFLIGHT_RECORD_BINDING_CONFIDENCE = 0.92;
const CFLIGHT_RECORD_VIDEO_MARGIN_MS = 5_000;
const CFLIGHT_RECORD_PHOTO_TOLERANCE_MS = 60_000;
const CFLIGHT_RECORD_MAX_MEDIAN_DEVIATION_MS = 24 * 60 * 60 * 1000;
const CFLIGHT_RECORD_ENV_KEYS = ['KAIROS_DJI_OPEN_API_KEY', 'DJI_OPEN_API_KEY'] as const;
const CFLIGHT_RECORD_HEADER_SIZE = 100;
const CFLIGHT_RECORD_VERSION_OFFSET = 10;
const CFLIGHT_RECORD_ZERO_PAD_START = 12;
const CFLIGHT_RECORD_MAX_VERSION = 64;
const CSRT_TIME_RANGE = /(\d{2}:\d{2}:\d{2}[,.:]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,.:]\d{3})/u;
const CGPS_COORDINATE_PAIR = /\b(?:gps|GPS)\s*[:(]?\s*([+-]?\d+(?:\.\d+)?)\s*[, ]\s*([+-]?\d+(?:\.\d+)?)/u;
const CLATITUDE = /latitude\s*[:=]\s*([+-]?\d+(?:\.\d+)?)/iu;
const CLONGITUDE = /longitude\s*[:=]\s*([+-]?\d+(?:\.\d+)?)/iu;

type ISameSourceAsset = Pick<
  IKtepAsset,
  'kind' | 'capturedAt' | 'durationMs' | 'displayName' | 'sourcePath'
>;

interface ISameSourceTrackPoint extends IEmbeddedGpsPoint {
  trackId: string;
  sourcePath: string;
}

interface IPreparedSameSourceTrack {
  id: string;
  originType: EProjectSameSourceGpsOriginType;
  sourcePath: string;
  points: ISameSourceTrackPoint[];
}

interface IFlightRecordPoint extends ISameSourceTrackPoint {}

export interface IPreparedRootGpsContext {
  flightRecordPoints: IFlightRecordPoint[];
  warnings: string[];
}

export interface IResolveAssetSameSourceGpsBindingInput {
  projectRoot: string;
  trackIdentityKey: string;
  asset: ISameSourceAsset;
  localPath: string;
  preparedRootGps?: IPreparedRootGpsContext;
}

export async function prepareRootSameSourceGpsContext(input: {
  projectRoot: string;
  flightRecordPath?: string;
  djiOpenAPIKey?: string;
}): Promise<IPreparedRootGpsContext> {
  if (!input.flightRecordPath) {
    return {
      flightRecordPoints: [],
      warnings: [],
    };
  }

  const paths = await listFlightRecordPaths(input.flightRecordPath);
  if (paths.length === 0) {
    return {
      flightRecordPoints: [],
      warnings: [`未找到可识别的 DJI FlightRecord 日志：${input.flightRecordPath}`],
    };
  }

  const warnings: string[] = [];
  const tracks = (
    await Promise.all(paths.map(async filePath => (
      loadFlightRecordTrack(filePath, warnings, input.djiOpenAPIKey)
    )))
  )
    .filter((track): track is IPreparedSameSourceTrack => track != null);

  await upsertSameSourceTrackCache(input.projectRoot, tracks);
  const points = tracks
    .flatMap(track => track.points)
    .sort((left, right) => left.time.localeCompare(right.time));

  return {
    flightRecordPoints: dedupeFlightRecordPoints(points),
    warnings,
  };
}

export async function resolveAssetSameSourceGpsBinding(
  input: IResolveAssetSameSourceGpsBindingInput,
): Promise<{ binding: IEmbeddedGpsBinding | null; warnings: string[] }> {
  const srtBinding = await resolveSidecarSrtBinding(
    input.asset,
    input.localPath,
    {
      projectRoot: input.projectRoot,
      trackIdentityKey: input.trackIdentityKey,
    },
  );
  if (srtBinding.binding) {
    return srtBinding;
  }

  const flightRecordBinding = bindAssetToFlightRecordPoints(
    input.asset,
    input.preparedRootGps?.flightRecordPoints ?? [],
  );
  if (flightRecordBinding) {
    return {
      binding: flightRecordBinding,
      warnings: [...srtBinding.warnings],
    };
  }

  return {
    binding: null,
    warnings: [...srtBinding.warnings],
  };
}

export async function loadSameSourceTrackPoints(
  projectRoot: string,
  trackId: string,
): Promise<IEmbeddedGpsPoint[]> {
  const index = await loadProjectSameSourceGpsIndex(projectRoot);
  const track = index?.tracks.find(item => item.id === trackId);
  if (!track) return [];

  const filePath = join(getProjectSameSourceGpsRoot(projectRoot), track.relativePath);
  const points = await loadGpxPoints(filePath);
  return dedupeEmbeddedPoints(points.map(point => ({
    time: point.time,
    lat: point.lat,
    lng: point.lng,
  })));
}

export async function loadEmbeddedGpsBindingPoints(
  projectRoot: string,
  binding: Pick<IEmbeddedGpsBinding, 'trackId' | 'points'>,
): Promise<IEmbeddedGpsPoint[]> {
  if (binding.points?.length) {
    return dedupeEmbeddedPoints(binding.points);
  }
  if (!binding.trackId) return [];
  return loadSameSourceTrackPoints(projectRoot, binding.trackId);
}

export async function pickNearestEmbeddedGpsBindingPoint(input: {
  projectRoot: string;
  binding: Pick<IEmbeddedGpsBinding, 'trackId' | 'points'>;
  targetTime: string;
  toleranceMs: number;
}): Promise<IEmbeddedGpsPoint | null> {
  const targetTimeMs = Date.parse(input.targetTime);
  if (Number.isNaN(targetTimeMs)) return null;

  const points = await loadEmbeddedGpsBindingPoints(input.projectRoot, input.binding);
  const matched = pickNearestTimedPoint(points, targetTimeMs, input.toleranceMs);
  return matched
    ? {
      time: matched.time,
      lat: matched.lat,
      lng: matched.lng,
    }
    : null;
}

export function bindAssetToFlightRecordPoints(
  asset: ISameSourceAsset,
  points: IFlightRecordPoint[],
): IEmbeddedGpsBinding | null {
  if (!asset.capturedAt || points.length === 0) return null;
  const capturedAtMs = Date.parse(asset.capturedAt);
  if (Number.isNaN(capturedAtMs)) return null;

  if (asset.kind === 'photo') {
    const nearest = pickNearestFlightRecordPoint(points, capturedAtMs, CFLIGHT_RECORD_PHOTO_TOLERANCE_MS);
    if (!nearest) return null;
    return {
      originType: 'flight-record',
      confidence: CFLIGHT_RECORD_BINDING_CONFIDENCE,
      representativeTime: nearest.time,
      representativeLat: nearest.lat,
      representativeLng: nearest.lng,
      trackId: nearest.trackId,
      pointCount: 1,
      startTime: nearest.time,
      endTime: nearest.time,
      sourcePath: nearest.sourcePath,
    };
  }

  const durationMs = Math.max(asset.durationMs ?? 0, 0);
  const startMs = capturedAtMs - CFLIGHT_RECORD_VIDEO_MARGIN_MS;
  const endMs = capturedAtMs + durationMs + CFLIGHT_RECORD_VIDEO_MARGIN_MS;
  const matchedCandidates = points.filter(point => {
    const timeMs = Date.parse(point.time);
    return Number.isFinite(timeMs) && timeMs >= startMs && timeMs <= endMs;
  });
  const midpointMs = capturedAtMs + Math.round(durationMs / 2);
  const matched = pickBestFlightRecordTrackPoints(matchedCandidates, midpointMs);
  if (matched.length === 0) return null;

  const representative = pickRepresentativeFlightRecordPoint(matched, midpointMs);
  return {
    originType: 'flight-record',
    confidence: CFLIGHT_RECORD_BINDING_CONFIDENCE,
    representativeTime: representative.time,
    representativeLat: representative.lat,
    representativeLng: representative.lng,
    trackId: representative.trackId,
    pointCount: matched.length,
    startTime: matched[0]!.time,
    endTime: matched[matched.length - 1]!.time,
    sourcePath: representative.sourcePath,
  };
}

export async function resolveSidecarSrtBinding(
  asset: ISameSourceAsset,
  localPath: string,
  cache?: {
    projectRoot: string;
    trackIdentityKey: string;
  },
): Promise<{ binding: IEmbeddedGpsBinding | null; warnings: string[] }> {
  const sidecarPath = await findSidecarSrtPath(localPath);
  if (!sidecarPath) {
    return {
      binding: null,
      warnings: [],
    };
  }
  if (!asset.capturedAt) {
    return {
      binding: null,
      warnings: [`素材缺少 capturedAt，无法绑定 sidecar SRT：${basename(localPath)}`],
    };
  }

  const points = await loadSrtPoints(sidecarPath, asset.capturedAt);
  if (points.length === 0) {
    return {
      binding: null,
      warnings: [`SRT 中未解析出可用 GPS 点：${sidecarPath}`],
    };
  }

  const trackId = buildSameSourceTrackId(
    'sidecar-srt',
    cache?.trackIdentityKey ?? sidecarPath,
  );
  if (cache?.projectRoot) {
    await upsertSameSourceTrackCache(cache.projectRoot, [
      buildPreparedSameSourceTrack(trackId, 'sidecar-srt', sidecarPath, points),
    ]);
  }

  const targetTimeMs = Date.parse(asset.capturedAt) + Math.round(Math.max(asset.durationMs ?? 0, 0) / 2);
  const representative = pickRepresentativeEmbeddedPoint(points, targetTimeMs);
  return {
    binding: {
      originType: 'sidecar-srt',
      confidence: CSRT_BINDING_CONFIDENCE,
      representativeTime: representative.time,
      representativeLat: representative.lat,
      representativeLng: representative.lng,
      trackId,
      pointCount: points.length,
      startTime: points[0]!.time,
      endTime: points[points.length - 1]!.time,
      sourcePath: sidecarPath,
    },
    warnings: [],
  };
}

async function loadSrtPoints(
  filePath: string,
  capturedAt: string,
): Promise<IEmbeddedGpsPoint[]> {
  const content = await readFile(filePath, 'utf-8').catch(() => '');
  if (!content) return [];

  const startMs = Date.parse(capturedAt);
  if (Number.isNaN(startMs)) return [];

  const points: IEmbeddedGpsPoint[] = [];
  const blocks = content.replace(/\r\n/gu, '\n').split(/\n\s*\n/gu);
  for (const block of blocks) {
    const lines = block
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean);
    if (lines.length === 0) continue;

    const timeLine = lines.find(line => CSRT_TIME_RANGE.test(line));
    if (!timeLine) continue;
    const timeMatch = timeLine.match(CSRT_TIME_RANGE);
    if (!timeMatch?.[1]) continue;

    const offsetMs = parseSrtTimestampMs(timeMatch[1]);
    if (!Number.isFinite(offsetMs)) continue;

    const combined = lines.join(' ');
    const coords = parseSrtCoordinates(combined);
    if (!coords) continue;

    points.push({
      time: new Date(startMs + offsetMs).toISOString(),
      lat: coords.lat,
      lng: coords.lng,
    });
  }

  return dedupeEmbeddedPoints(points);
}

async function loadFlightRecordTrack(
  filePath: string,
  warnings: string[],
  explicitApiKey?: string,
): Promise<IPreparedSameSourceTrack | null> {
  try {
    const bytes = new Uint8Array(await readFile(filePath));
    const parser = new DJILog(bytes);
    let frames = tryReadFlightFrames(parser);

    if (frames.length === 0 && parser.version >= 13) {
      const apiKey = resolveFlightRecordApiKey(explicitApiKey);
      if (!apiKey) {
        warnings.push(`FlightRecord 需要 DJI Open API key 才能解密：${filePath}`);
        return null;
      }
      frames = await tryReadEncryptedFlightFrames(parser, apiKey, filePath, warnings);
    }

    const trackId = buildSameSourceTrackId('flight-record', filePath);
    const points = frames
      .map(frame => {
        const time = normalizeFlightRecordTime(frame.custom?.dateTime);
        const lat = frame.osd?.latitude;
        const lng = frame.osd?.longitude;
        if (!time || typeof lat !== 'number' || typeof lng !== 'number') return null;
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
        if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
        if (lat === 0 && lng === 0) return null;
        return {
          time,
          lat,
          lng,
          trackId,
          sourcePath: filePath,
        } satisfies IFlightRecordPoint;
      })
      .filter((point): point is IFlightRecordPoint => point != null)
      .sort((left, right) => left.time.localeCompare(right.time));
    if (points.length === 0) return null;
    const sanitizedPoints = sanitizeFlightRecordPoints(points);
    if (sanitizedPoints.length === 0) return null;
    return {
      id: trackId,
      originType: 'flight-record',
      sourcePath: filePath,
      points: dedupeSameSourceTrackPoints(sanitizedPoints),
    };
  } catch (error) {
    warnings.push(`FlightRecord 解析失败：${filePath} (${String(error)})`);
    return null;
  }
}

function tryReadFlightFrames(parser: DJILog): Array<{ custom?: { dateTime?: string }; osd?: { latitude?: number; longitude?: number } }> {
  try {
    return parser.frames() as Array<{ custom?: { dateTime?: string }; osd?: { latitude?: number; longitude?: number } }>;
  } catch {
    return [];
  }
}

async function tryReadEncryptedFlightFrames(
  parser: DJILog,
  apiKey: string,
  filePath: string,
  warnings: string[],
): Promise<Array<{ custom?: { dateTime?: string }; osd?: { latitude?: number; longitude?: number } }>> {
  try {
    installFlightRecordFetchGlobals();
    const keychains = await parser.fetchKeychains(apiKey);
    return parser.frames(keychains) as Array<{ custom?: { dateTime?: string }; osd?: { latitude?: number; longitude?: number } }>;
  } catch (error) {
    warnings.push(`FlightRecord 解密失败：${filePath} (${String(error)})`);
    return [];
  }
}

export function installFlightRecordFetchGlobals(): void {
  const nodeFetch = nodeFetchModule.default;
  const NodeFetchHeaders = Reflect.get(nodeFetchModule, 'Headers') as typeof Headers | undefined;
  const NodeFetchRequest = Reflect.get(nodeFetchModule, 'Request') as typeof Request | undefined;
  const NodeFetchResponse = Reflect.get(nodeFetchModule, 'Response') as typeof Response | undefined;

  if (typeof globalThis.fetch !== 'function') {
    (globalThis as typeof globalThis & { fetch: typeof fetch }).fetch = ((
      input: Parameters<typeof nodeFetch>[0],
      init?: Parameters<typeof nodeFetch>[1],
    ) => nodeFetch(input, init)) as typeof fetch;
  }

  if (typeof globalThis.Headers !== 'function' && NodeFetchHeaders) {
    (globalThis as typeof globalThis & { Headers: typeof Headers }).Headers = NodeFetchHeaders;
  }

  if (typeof globalThis.Request !== 'function' && NodeFetchRequest) {
    (globalThis as typeof globalThis & { Request: typeof Request }).Request = NodeFetchRequest;
  }

  if (typeof globalThis.Response !== 'function' && NodeFetchResponse) {
    (globalThis as typeof globalThis & { Response: typeof Response }).Response = NodeFetchResponse;
  }
}

export function resolveFlightRecordApiKey(explicitApiKey?: string): string | undefined {
  const fromConfig = explicitApiKey?.trim();
  if (fromConfig) return fromConfig;

  for (const key of CFLIGHT_RECORD_ENV_KEYS) {
    const value = process.env[key]?.trim();
    if (value) return value;
  }
  return undefined;
}

export function sanitizeFlightRecordPoints(points: IFlightRecordPoint[]): IFlightRecordPoint[] {
  if (points.length < 3) {
    return [...points].sort((left, right) => left.time.localeCompare(right.time));
  }

  const withParsedTime = points
    .map(point => ({
      point,
      timeMs: Date.parse(point.time),
    }))
    .filter((entry): entry is { point: IFlightRecordPoint; timeMs: number } => Number.isFinite(entry.timeMs))
    .sort((left, right) => left.timeMs - right.timeMs);

  if (withParsedTime.length < 3) {
    return withParsedTime.map(entry => entry.point);
  }

  const medianTimeMs = withParsedTime[Math.floor(withParsedTime.length / 2)]?.timeMs;
  if (!Number.isFinite(medianTimeMs)) {
    return withParsedTime.map(entry => entry.point);
  }

  const filtered = withParsedTime
    .filter(entry => Math.abs(entry.timeMs - medianTimeMs) <= CFLIGHT_RECORD_MAX_MEDIAN_DEVIATION_MS)
    .map(entry => entry.point);

  return (filtered.length >= 3 ? filtered : withParsedTime.map(entry => entry.point))
    .sort((left, right) => left.time.localeCompare(right.time));
}

function normalizeFlightRecordTime(value?: string): string | null {
  if (!value?.trim()) return null;
  const parsed = Date.parse(value.trim());
  if (Number.isNaN(parsed)) return null;
  return new Date(parsed).toISOString();
}

async function listFlightRecordPaths(path: string): Promise<string[]> {
  const info = await stat(path).catch(() => null);
  if (!info) return [];
  if (info.isFile()) {
    return await isLikelyDjiFlightRecordFile(path) ? [path] : [];
  }
  if (!info.isDirectory()) return [];
  return walkFlightRecordDirectory(path);
}

async function walkFlightRecordDirectory(dir: string): Promise<string[]> {
  const results: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...await walkFlightRecordDirectory(full));
      continue;
    }
    if (entry.isFile() && await isLikelyDjiFlightRecordFile(full)) {
      results.push(full);
    }
  }
  return results.sort((left, right) => left.localeCompare(right));
}

export function isLikelyDjiFlightRecordHeader(header: Uint8Array): boolean {
  if (header.length < CFLIGHT_RECORD_HEADER_SIZE) return false;

  const version = header[CFLIGHT_RECORD_VERSION_OFFSET];
  if (!version || version > CFLIGHT_RECORD_MAX_VERSION) return false;

  let hasNonZeroPrefix = false;
  for (let index = 0; index < CFLIGHT_RECORD_ZERO_PAD_START; index++) {
    if ((header[index] ?? 0) !== 0) {
      hasNonZeroPrefix = true;
      break;
    }
  }
  if (!hasNonZeroPrefix) return false;

  for (let index = CFLIGHT_RECORD_ZERO_PAD_START; index < CFLIGHT_RECORD_HEADER_SIZE; index++) {
    if ((header[index] ?? 0) !== 0) return false;
  }
  return true;
}

async function isLikelyDjiFlightRecordFile(filePath: string): Promise<boolean> {
  const header = await readFileHeader(filePath, CFLIGHT_RECORD_HEADER_SIZE);
  if (isLikelyDjiFlightRecordHeader(header)) return true;
  return await canOpenDjiFlightRecord(filePath);
}

async function readFileHeader(filePath: string, byteCount: number): Promise<Uint8Array> {
  const handle = await open(filePath, 'r').catch(() => null);
  if (!handle) return new Uint8Array();

  try {
    const buffer = Buffer.alloc(byteCount);
    const { bytesRead } = await handle.read(buffer, 0, byteCount, 0);
    return new Uint8Array(buffer.subarray(0, bytesRead));
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function canOpenDjiFlightRecord(filePath: string): Promise<boolean> {
  try {
    const parser = new DJILog(new Uint8Array(await readFile(filePath)));
    const version = parser.version;
    return Number.isFinite(version) && version > 0 && version <= CFLIGHT_RECORD_MAX_VERSION;
  } catch {
    return false;
  }
}

async function findSidecarSrtPath(localPath: string): Promise<string | null> {
  const parsed = parse(localPath);
  const entries = await readdir(parsed.dir, { withFileTypes: true }).catch(() => []);
  const target = `${parsed.name}.srt`.toLowerCase();
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (entry.name.toLowerCase() === target) {
      return join(parsed.dir, entry.name);
    }
  }
  return null;
}

function parseSrtCoordinates(content: string): { lat: number; lng: number } | null {
  const pair = content.match(CGPS_COORDINATE_PAIR);
  if (pair?.[1] && pair[2]) {
    const lat = Number(pair[1]);
    const lng = Number(pair[2]);
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      return { lat, lng };
    }
  }

  const lat = content.match(CLATITUDE)?.[1];
  const lng = content.match(CLONGITUDE)?.[1];
  if (!lat || !lng) return null;
  const parsedLat = Number(lat);
  const parsedLng = Number(lng);
  if (!Number.isFinite(parsedLat) || !Number.isFinite(parsedLng)) return null;
  return { lat: parsedLat, lng: parsedLng };
}

function parseSrtTimestampMs(value: string): number {
  const normalized = value.replace('.', ',');
  const match = normalized.match(/^(\d{2}):(\d{2}):(\d{2}),(\d{3})$/u);
  if (!match?.[1] || !match[2] || !match[3] || !match[4]) return Number.NaN;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3]);
  const millisecond = Number(match[4]);
  if ([hour, minute, second, millisecond].some(value => !Number.isFinite(value))) {
    return Number.NaN;
  }
  return (((hour * 60) + minute) * 60 + second) * 1000 + millisecond;
}

function pickRepresentativeEmbeddedPoint(
  points: IEmbeddedGpsPoint[],
  targetTimeMs: number,
): IEmbeddedGpsPoint {
  let best = points[0]!;
  let bestDelta = Number.POSITIVE_INFINITY;
  for (const point of points) {
    const delta = Math.abs(Date.parse(point.time) - targetTimeMs);
    if (delta < bestDelta) {
      best = point;
      bestDelta = delta;
    }
  }
  return best;
}

function pickNearestFlightRecordPoint(
  points: IFlightRecordPoint[],
  targetTimeMs: number,
  toleranceMs: number,
): IFlightRecordPoint | null {
  let best: IFlightRecordPoint | null = null;
  let bestDelta = Number.POSITIVE_INFINITY;
  for (const point of points) {
    const delta = Math.abs(Date.parse(point.time) - targetTimeMs);
    if (!Number.isFinite(delta) || delta > toleranceMs) continue;
    if (delta < bestDelta) {
      best = point;
      bestDelta = delta;
    }
  }
  return best;
}

function pickRepresentativeFlightRecordPoint(
  points: IFlightRecordPoint[],
  targetTimeMs: number,
): IFlightRecordPoint {
  return pickNearestFlightRecordPoint(points, targetTimeMs, Number.POSITIVE_INFINITY) ?? points[0]!;
}

function pickBestFlightRecordTrackPoints(
  points: IFlightRecordPoint[],
  targetTimeMs: number,
): IFlightRecordPoint[] {
  if (points.length === 0) return [];
  const grouped = new Map<string, IFlightRecordPoint[]>();
  for (const point of points) {
    const group = grouped.get(point.trackId);
    if (group) {
      group.push(point);
    } else {
      grouped.set(point.trackId, [point]);
    }
  }

  let best: IFlightRecordPoint[] = [];
  let bestScore = Number.NEGATIVE_INFINITY;
  let bestDelta = Number.POSITIVE_INFINITY;
  for (const group of grouped.values()) {
    const representative = pickRepresentativeFlightRecordPoint(group, targetTimeMs);
    const delta = Math.abs(Date.parse(representative.time) - targetTimeMs);
    const score = group.length;
    if (score > bestScore || (score === bestScore && delta < bestDelta)) {
      best = group;
      bestScore = score;
      bestDelta = delta;
    }
  }
  return best.sort((left, right) => left.time.localeCompare(right.time));
}

function buildPreparedSameSourceTrack(
  trackId: string,
  originType: EProjectSameSourceGpsOriginType,
  sourcePath: string,
  points: IEmbeddedGpsPoint[],
): IPreparedSameSourceTrack {
  return {
    id: trackId,
    originType,
    sourcePath,
    points: points
      .map(point => ({
        ...point,
        trackId,
        sourcePath,
      }))
      .sort((left, right) => left.time.localeCompare(right.time)),
  };
}

function buildSameSourceTrackId(
  originType: EProjectSameSourceGpsOriginType,
  sourceIdentity: string,
): string {
  return `${originType}-${createHash('sha1').update(`${originType}:${sourceIdentity}`).digest('hex').slice(0, 16)}`;
}

async function upsertSameSourceTrackCache(
  projectRoot: string,
  tracks: IPreparedSameSourceTrack[],
): Promise<void> {
  if (tracks.length === 0) return;

  const existing = await loadProjectSameSourceGpsIndex(projectRoot) ?? {
    schemaVersion: '1.0',
    updatedAt: new Date().toISOString(),
    trackCount: 0,
    tracks: [],
  } satisfies IProjectSameSourceGpsIndex;
  const trackMap = new Map(existing.tracks.map(track => [track.id, track]));

  for (const track of tracks) {
    const relativePath = `tracks/${track.id}.gpx`;
    await writeSameSourceTrackFile(
      getProjectSameSourceGpsTrackPath(projectRoot, track.id),
      track,
    );
    trackMap.set(track.id, {
      id: track.id,
      originType: track.originType,
      relativePath,
      sourcePath: track.sourcePath,
      pointCount: track.points.length,
      startTime: track.points[0]?.time,
      endTime: track.points[track.points.length - 1]?.time,
    } satisfies IProjectSameSourceGpsTrackSummary);
  }

  const index: IProjectSameSourceGpsIndex = {
    schemaVersion: '1.0',
    updatedAt: new Date().toISOString(),
    trackCount: trackMap.size,
    tracks: [...trackMap.values()].sort((left, right) => left.id.localeCompare(right.id)),
  };
  await writeProjectSameSourceGpsIndex(projectRoot, index);
}

async function writeSameSourceTrackFile(
  filePath: string,
  track: IPreparedSameSourceTrack,
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, buildSameSourceTrackContent(track), 'utf-8');
}

function buildSameSourceTrackContent(track: IPreparedSameSourceTrack): string {
  const body = track.points
    .map(point => `      <trkpt lat="${point.lat}" lon="${point.lng}"><time>${escapeXml(point.time)}</time></trkpt>`)
    .join('\n');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx version="1.1" creator="Kairos" xmlns="http://www.topografix.com/GPX/1/1">',
    '  <trk>',
    `    <name>${escapeXml(track.id)}</name>`,
    '    <trkseg>',
    body,
    '    </trkseg>',
    '  </trk>',
    '</gpx>',
    '',
  ].join('\n');
}

function escapeXml(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&apos;');
}

function dedupeEmbeddedPoints(points: IEmbeddedGpsPoint[]): IEmbeddedGpsPoint[] {
  const seen = new Set<string>();
  const deduped: IEmbeddedGpsPoint[] = [];
  for (const point of points) {
    const key = `${point.time}:${point.lat}:${point.lng}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(point);
  }
  return deduped.sort((left, right) => left.time.localeCompare(right.time));
}

function dedupeSameSourceTrackPoints<T extends ISameSourceTrackPoint>(points: T[]): T[] {
  const seen = new Set<string>();
  const deduped: T[] = [];
  for (const point of points) {
    const key = `${point.time}:${point.lat}:${point.lng}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(point);
  }
  return deduped.sort((left, right) => left.time.localeCompare(right.time));
}

function dedupeFlightRecordPoints(points: IFlightRecordPoint[]): IFlightRecordPoint[] {
  const seen = new Set<string>();
  const deduped: IFlightRecordPoint[] = [];
  for (const point of points) {
    const key = `${point.trackId}:${point.time}:${point.lat}:${point.lng}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(point);
  }
  return deduped.sort((left, right) => left.time.localeCompare(right.time));
}
