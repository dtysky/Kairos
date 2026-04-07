import { access, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  IPharosMatch,
  IPharosRef,
  IProjectPharosContext,
  IProjectPharosGpxSummary,
  IProjectPharosShot,
  IProjectPharosTripSummary,
} from '../../protocol/schema.js';
import {
  getProjectPharosRoot,
  loadProjectPharosContext,
  writeProjectPharosContext,
} from '../../store/pharos.js';

const CPLAN_SCHEMA_PREFIX = 'pharos/plan/';
const CRECORD_SCHEMA_PREFIX = 'pharos/record/';

export interface ILoadOrBuildProjectPharosContextInput {
  projectRoot: string;
  includedTripIds?: string[];
  forceRefresh?: boolean;
}

export interface IProjectPharosAssetStatus {
  status: IProjectPharosContext['status'];
  rootPath: string;
  discoveredTripCount: number;
  includedTripCount: number;
  warnings: string[];
  errors: string[];
  latestMessage?: string;
}

export async function loadOrBuildProjectPharosContext(
  input: ILoadOrBuildProjectPharosContextInput,
): Promise<IProjectPharosContext> {
  if (!input.forceRefresh) {
    const existing = await loadProjectPharosContext(input.projectRoot);
    const existingIncluded = normalizeTripIds(existing?.includedTripIds ?? []);
    const requestedIncluded = normalizeTripIds(input.includedTripIds ?? []);
    if (
      existing
      && existing.schemaVersion === '1.0'
      && JSON.stringify(existingIncluded) === JSON.stringify(requestedIncluded)
    ) {
      return existing;
    }
  }

  const context = await buildProjectPharosContext(input);
  await writeProjectPharosContext(input.projectRoot, context);
  return context;
}

export async function buildProjectPharosContext(
  input: ILoadOrBuildProjectPharosContextInput,
): Promise<IProjectPharosContext> {
  const rootPath = getProjectPharosRoot(input.projectRoot);
  const includedTripIds = normalizeTripIds(input.includedTripIds ?? []);
  const warnings: string[] = [];
  const errors: string[] = [];
  const shots: IProjectPharosShot[] = [];
  const trips: IProjectPharosTripSummary[] = [];
  const gpxFiles: IProjectPharosGpxSummary[] = [];

  if (!(await pathExists(rootPath))) {
    return {
      schemaVersion: '1.0',
      generatedAt: new Date().toISOString(),
      status: includedTripIds.length > 0 ? 'failure' : 'empty',
      rootPath,
      discoveredTripIds: [],
      includedTripIds,
      warnings,
      errors: includedTripIds.length > 0
        ? [`Pharos 目录不存在，但项目指定了包含 Trip：${includedTripIds.join('、')}`]
        : [],
      trips: [],
      shots: [],
      gpxFiles: [],
    };
  }

  const dirEntries = await readdir(rootPath, { withFileTypes: true });
  const discoveredTripIds = dirEntries
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort((left, right) => left.localeCompare(right));
  const effectiveTripIds = includedTripIds.length > 0 ? includedTripIds : discoveredTripIds;

  if (discoveredTripIds.length === 0 || effectiveTripIds.length === 0) {
    return {
      schemaVersion: '1.0',
      generatedAt: new Date().toISOString(),
      status: includedTripIds.length > 0 ? 'failure' : 'empty',
      rootPath,
      discoveredTripIds,
      includedTripIds,
      warnings,
      errors: includedTripIds.length > 0 ? [`未找到项目要求的 Pharos Trip：${includedTripIds.join('、')}`] : [],
      trips: [],
      shots: [],
      gpxFiles: [],
    };
  }

  const missingIncludedTrips = effectiveTripIds.filter(tripId => !discoveredTripIds.includes(tripId));
  if (missingIncludedTrips.length > 0) {
    errors.push(`未找到指定的 Pharos Trip：${missingIncludedTrips.join('、')}`);
  }

  for (const tripId of effectiveTripIds) {
    if (!discoveredTripIds.includes(tripId)) continue;

    const tripRoot = join(rootPath, tripId);
    const parsed = await parseTripDirectory(tripRoot, tripId);
    if (parsed.errors.length > 0) {
      errors.push(...parsed.errors);
    }
    if (parsed.warnings.length > 0) {
      warnings.push(...parsed.warnings);
    }
    if (!parsed.summary) continue;

    trips.push(parsed.summary);
    shots.push(...parsed.shots);
    gpxFiles.push(...parsed.gpxFiles);
  }

  const hasFatalIncludedError = errors.length > 0;
  const status = trips.length === 0
    ? (includedTripIds.length > 0 || hasFatalIncludedError ? 'failure' : 'empty')
    : (hasFatalIncludedError ? 'failure' : 'success');

  return {
    schemaVersion: '1.0',
    generatedAt: new Date().toISOString(),
    status,
    rootPath,
    discoveredTripIds,
    includedTripIds,
    warnings: dedupeStrings(warnings),
    errors: dedupeStrings(errors),
    trips,
    shots,
    gpxFiles,
  };
}

export function buildProjectPharosAssetStatus(
  context: IProjectPharosContext | null,
  projectRoot: string,
): IProjectPharosAssetStatus {
  const rootPath = getProjectPharosRoot(projectRoot);
  if (!context) {
    return {
      status: 'empty',
      rootPath,
      discoveredTripCount: 0,
      includedTripCount: 0,
      warnings: [],
      errors: [],
    };
  }

  return {
    status: context.status,
    rootPath,
    discoveredTripCount: context.discoveredTripIds.length,
    includedTripCount: context.trips.length,
    warnings: context.warnings,
    errors: context.errors,
    latestMessage: context.errors[0] ?? context.warnings[0],
  };
}

export function collectProjectPharosGpxPaths(
  context: IProjectPharosContext | null,
): string[] {
  return dedupeStrings((context?.gpxFiles ?? []).map(item => item.path));
}

export function dedupePharosRefs(refs: IPharosRef[]): IPharosRef[] {
  const seen = new Set<string>();
  const deduped: IPharosRef[] = [];
  for (const ref of refs) {
    const key = `${ref.tripId}::${ref.shotId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(ref);
  }
  return deduped;
}

export function pharosRefsFromMatches(matches: IPharosMatch[]): IPharosRef[] {
  return dedupePharosRefs(matches.map(match => match.ref));
}

async function parseTripDirectory(
  tripRoot: string,
  tripId: string,
): Promise<{
  summary?: IProjectPharosTripSummary;
  shots: IProjectPharosShot[];
  gpxFiles: IProjectPharosGpxSummary[];
  warnings: string[];
  errors: string[];
}> {
  const warnings: string[] = [];
  const errors: string[] = [];
  const planPath = join(tripRoot, 'plan.json');
  if (!(await pathExists(planPath))) {
    errors.push(`Pharos Trip ${tripId} 缺少 plan.json`);
    return { shots: [], gpxFiles: [], warnings, errors };
  }

  const rawPlan = await readJson(planPath).catch((error: unknown) => {
    errors.push(`Pharos Trip ${tripId} plan.json 读取失败：${error instanceof Error ? error.message : String(error)}`);
    return null;
  });
  if (!rawPlan || typeof rawPlan !== 'object') {
    return { shots: [], gpxFiles: [], warnings, errors };
  }

  const plan = rawPlan as Record<string, unknown>;
  const planSchema = typeof plan.$schema === 'string' ? plan.$schema : '';
  if (!planSchema.startsWith(CPLAN_SCHEMA_PREFIX)) {
    errors.push(`Pharos Trip ${tripId} 的 plan.json schema 不受支持：${planSchema || 'unknown'}`);
    return { shots: [], gpxFiles: [], warnings, errors };
  }
  if (typeof plan.trip_id === 'string' && plan.trip_id !== tripId) {
    errors.push(`Pharos Trip ${tripId} 的 plan.json trip_id 与目录名不一致：${String(plan.trip_id)}`);
    return { shots: [], gpxFiles: [], warnings, errors };
  }

  const record = await parseRecordFile(join(tripRoot, 'record.json'), tripId, warnings, errors);
  const recordMap = new Map(
    (record?.records ?? [])
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
      .map(item => [String(item.shot_id ?? ''), item]),
  );
  const dayList = Array.isArray(plan.days) ? plan.days : [];
  const planShots: IProjectPharosShot[] = [];
  let mustCount = 0;
  let optionalCount = 0;
  let pendingCount = 0;
  let expectedCount = 0;
  let unexpectedCount = 0;
  let abandonedCount = 0;

  for (const rawDay of dayList) {
    if (!rawDay || typeof rawDay !== 'object') continue;
    const day = rawDay as Record<string, unknown>;
    const dayShots = Array.isArray(day.shots) ? day.shots : [];
    for (const rawShot of dayShots) {
      if (!rawShot || typeof rawShot !== 'object') continue;
      const shot = rawShot as Record<string, unknown>;
      const shotId = typeof shot.id === 'string' ? shot.id : '';
      if (!shotId) continue;
      const recordEntry = recordMap.get(shotId);
      const status = normalizeShotStatus(recordEntry?.status);
      if (shot.priority === 'must') mustCount += 1;
      if (shot.priority === 'optional') optionalCount += 1;
      if (status === 'pending') pendingCount += 1;
      if (status === 'expected') expectedCount += 1;
      if (status === 'unexpected') unexpectedCount += 1;
      if (status === 'abandoned') abandonedCount += 1;

      planShots.push({
        ref: { tripId, shotId },
        tripTitle: typeof plan.title === 'string' ? plan.title : undefined,
        tripKind: normalizeTripKind(plan.trip_kind),
        day: typeof day.day === 'number' ? day.day : undefined,
        date: typeof day.date === 'string' ? day.date : undefined,
        dayTitle: typeof day.title === 'string' ? day.title : undefined,
        location: typeof shot.location === 'string' ? shot.location : '未知地点',
        description: typeof shot.description === 'string' ? shot.description : '',
        type: typeof shot.type === 'string' ? shot.type : 'unknown',
        priority: shot.priority === 'must' || shot.priority === 'optional'
          ? shot.priority
          : undefined,
        source: typeof shot.source === 'string' ? shot.source : undefined,
        device: typeof shot.device === 'string' ? shot.device : undefined,
        roll: typeof shot.roll === 'string' ? shot.roll : undefined,
        devices: Array.isArray(shot.angles)
          ? shot.angles
            .map(angle => angle && typeof angle === 'object' ? String((angle as Record<string, unknown>).device ?? '').trim() : '')
            .filter(Boolean)
          : (typeof shot.device === 'string' ? [shot.device] : []),
        rolls: Array.isArray(shot.angles)
          ? shot.angles
            .map(angle => angle && typeof angle === 'object' ? String((angle as Record<string, unknown>).roll ?? '').trim() : '')
            .filter(Boolean)
          : (typeof shot.roll === 'string' ? [shot.roll] : []),
        gps: normalizeCoordinate(shot.gps),
        gpsStart: normalizeCoordinate(shot.gps_start),
        gpsEnd: normalizeCoordinate(shot.gps_end),
        timeWindowStart: buildTripWindowIso(
          typeof day.date === 'string' ? day.date : undefined,
          Array.isArray(shot.time_window) ? shot.time_window[0] : undefined,
          typeof plan.timezone === 'string' ? plan.timezone : undefined,
        ),
        timeWindowEnd: buildTripWindowIso(
          typeof day.date === 'string' ? day.date : undefined,
          Array.isArray(shot.time_window) ? shot.time_window[1] : undefined,
          typeof plan.timezone === 'string' ? plan.timezone : undefined,
        ),
        actualTimeStart: readNestedString(recordEntry, 'actual_time', 'start'),
        actualTimeEnd: readNestedString(recordEntry, 'actual_time', 'end'),
        actualGpsStart: readNestedCoordinate(recordEntry, 'actual_gps', 'start'),
        actualGpsEnd: readNestedCoordinate(recordEntry, 'actual_gps', 'end'),
        status,
        note: typeof recordEntry?.note === 'string' || recordEntry?.note === null
          ? (recordEntry.note as string | null)
          : undefined,
        abandonReason: typeof recordEntry?.abandon_reason === 'string' || recordEntry?.abandon_reason === null
          ? (recordEntry.abandon_reason as string | null)
          : undefined,
      });
    }
  }

  const extraShots = Array.isArray(record?.extra_shots) ? record.extra_shots : [];
  for (const rawShot of extraShots) {
    if (!rawShot || typeof rawShot !== 'object') continue;
    const shot = rawShot as Record<string, unknown>;
    const shotId = typeof shot.id === 'string' ? shot.id : '';
    if (!shotId) continue;
    unexpectedCount += 1;
    planShots.push({
      ref: { tripId, shotId },
      tripTitle: typeof plan.title === 'string' ? plan.title : undefined,
      tripKind: normalizeTripKind(plan.trip_kind),
      day: typeof shot.day === 'number' ? shot.day : undefined,
      location: typeof shot.location === 'string' ? shot.location : '未知地点',
      description: typeof shot.description === 'string' ? shot.description : '',
      type: typeof shot.type === 'string' ? shot.type : 'unknown',
      device: typeof shot.device === 'string' ? shot.device : undefined,
      devices: typeof shot.device === 'string' ? [shot.device] : [],
      gps: normalizeCoordinate(shot.gps),
      actualTimeStart: readNestedString(shot, 'time', 'start'),
      actualTimeEnd: readNestedString(shot, 'time', 'end'),
      actualGpsStart: normalizeCoordinate(shot.gps),
      actualGpsEnd: normalizeCoordinate(shot.gps),
      status: 'unexpected',
      isExtraShot: true,
    });
  }

  const gpxFiles = await summarizeTripGpxFiles(join(tripRoot, 'gpx'), tripId, warnings);
  const summary: IProjectPharosTripSummary = {
    tripId,
    title: typeof plan.title === 'string' ? plan.title : tripId,
    tripKind: normalizeTripKind(plan.trip_kind),
    revision: typeof plan.revision === 'number' ? plan.revision : undefined,
    timezone: typeof plan.timezone === 'string' ? plan.timezone : undefined,
    dateStart: readNestedString(plan, 'dates', 'start'),
    dateEnd: readNestedString(plan, 'dates', 'end'),
    mustCount,
    optionalCount,
    pendingCount,
    expectedCount,
    unexpectedCount,
    abandonedCount,
    gpxCount: gpxFiles.length,
    warnings,
  };

  return {
    summary,
    shots: planShots,
    gpxFiles,
    warnings,
    errors,
  };
}

async function parseRecordFile(
  recordPath: string,
  tripId: string,
  warnings: string[],
  errors: string[],
): Promise<Record<string, unknown> | null> {
  if (!(await pathExists(recordPath))) return null;
  const rawRecord = await readJson(recordPath).catch((error: unknown) => {
    errors.push(`Pharos Trip ${tripId} record.json 读取失败：${error instanceof Error ? error.message : String(error)}`);
    return null;
  });
  if (!rawRecord || typeof rawRecord !== 'object') return null;
  const record = rawRecord as Record<string, unknown>;
  const schema = typeof record.$schema === 'string' ? record.$schema : '';
  if (!schema.startsWith(CRECORD_SCHEMA_PREFIX)) {
    warnings.push(`Pharos Trip ${tripId} 的 record.json schema 不受支持，已忽略：${schema || 'unknown'}`);
    return null;
  }
  if (typeof record.trip_id === 'string' && record.trip_id !== tripId) {
    warnings.push(`Pharos Trip ${tripId} 的 record.json trip_id 与目录名不一致，已忽略 record`);
    return null;
  }
  return record;
}

async function summarizeTripGpxFiles(
  gpxRoot: string,
  tripId: string,
  warnings: string[],
): Promise<IProjectPharosGpxSummary[]> {
  if (!(await pathExists(gpxRoot))) return [];
  const entries = await readdir(gpxRoot, { withFileTypes: true });
  const files = entries
    .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.gpx'))
    .map(entry => join(gpxRoot, entry.name))
    .sort((left, right) => left.localeCompare(right));

  const summaries: IProjectPharosGpxSummary[] = [];
  for (const filePath of files) {
    try {
      const raw = await readFile(filePath, 'utf-8');
      summaries.push({
        tripId,
        path: filePath,
        pointCount: countMatches(raw, /<trkpt\b/gu),
        startTime: extractFirstTagValue(raw, 'time'),
        endTime: extractLastTagValue(raw, 'time'),
      });
    } catch (error) {
      warnings.push(`Pharos Trip ${tripId} 的 GPX 读取失败：${filePath} (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  return summaries;
}

function normalizeTripIds(tripIds: string[]): string[] {
  return dedupeStrings(tripIds.map(tripId => tripId.trim()).filter(Boolean)).sort((left, right) => left.localeCompare(right));
}

function normalizeTripKind(value: unknown): 'planned' | 'freeform' | undefined {
  return value === 'planned' || value === 'freeform' ? value : undefined;
}

function normalizeShotStatus(value: unknown): IProjectPharosShot['status'] {
  return value === 'expected' || value === 'unexpected' || value === 'abandoned'
    ? value
    : 'pending';
}

function normalizeCoordinate(value: unknown): [number, number] | undefined {
  if (!Array.isArray(value) || value.length < 2) return undefined;
  const lng = Number(value[0]);
  const lat = Number(value[1]);
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return undefined;
  return [lng, lat];
}

function readNestedString(
  value: Record<string, unknown> | null | undefined,
  key: string,
  nestedKey: string,
): string | undefined {
  const nested = value?.[key];
  if (!nested || typeof nested !== 'object') return undefined;
  const resolved = (nested as Record<string, unknown>)[nestedKey];
  return typeof resolved === 'string' ? resolved : undefined;
}

function readNestedCoordinate(
  value: Record<string, unknown> | null | undefined,
  key: string,
  nestedKey: string,
): [number, number] | undefined {
  const nested = value?.[key];
  if (!nested || typeof nested !== 'object') return undefined;
  return normalizeCoordinate((nested as Record<string, unknown>)[nestedKey]);
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf-8'));
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))];
}

function countMatches(input: string, pattern: RegExp): number {
  const matches = input.match(pattern);
  return matches ? matches.length : 0;
}

function extractFirstTagValue(input: string, tagName: string): string | undefined {
  const match = input.match(new RegExp(`<${tagName}>([^<]+)</${tagName}>`, 'u'));
  return match?.[1]?.trim() || undefined;
}

function extractLastTagValue(input: string, tagName: string): string | undefined {
  const matches = [...input.matchAll(new RegExp(`<${tagName}>([^<]+)</${tagName}>`, 'gu'))];
  const value = matches[matches.length - 1]?.[1];
  return value?.trim() || undefined;
}

function buildTripWindowIso(
  date: string | undefined,
  localTime: unknown,
  timeZone: string | undefined,
): string | undefined {
  if (!date || typeof localTime !== 'string' || !localTime.trim()) return undefined;
  const [hourRaw, minuteRaw] = localTime.trim().split(':');
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const day = Number(date.slice(8, 10));
  const hour = Number(hourRaw);
  const minute = Number(minuteRaw);
  if (![year, month, day, hour, minute].every(Number.isFinite)) return undefined;
  if (!timeZone) return `${date}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00`;

  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, 0);
  const offsetMinutes = getTimeZoneOffsetMinutes(new Date(utcGuess), timeZone);
  const actualUtcMs = utcGuess - offsetMinutes * 60_000;
  return new Date(actualUtcMs).toISOString();
}

function getTimeZoneOffsetMinutes(date: Date, timeZone: string): number {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = formatter.formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  const asUtc = Date.UTC(
    Number(values.year),
    Number(values.month) - 1,
    Number(values.day),
    Number(values.hour),
    Number(values.minute),
    Number(values.second),
  );
  return Math.round((asUtc - date.getTime()) / 60_000);
}
