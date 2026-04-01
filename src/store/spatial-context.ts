import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface IPathTimezoneOverride {
  id: string;
  rootRef?: string;
  pathPrefix: string;
  timezone: string;
  notes?: string;
}

export interface ILoadedPathTimezones {
  overrides: IPathTimezoneOverride[];
  warnings: string[];
}

export interface IManualItinerarySegment {
  id: string;
  date: string;
  startLocalTime?: string;
  endLocalTime?: string;
  timezone?: string;
  rootRef?: string;
  pathPrefix?: string;
  location?: string;
  from?: string;
  to?: string;
  via?: string[];
  transport?: 'drive' | 'walk' | 'train' | 'flight' | 'boat' | 'mixed';
  notes?: string;
}

export interface ILoadedManualItinerary {
  defaultTimezone?: string;
  segments: IManualItinerarySegment[];
  warnings: string[];
}

const CKEY_SPLITTER = /^([^:：]+)\s*[:：]\s*(.+)$/u;

export function getPathTimezonesPath(projectRoot: string): string {
  return join(projectRoot, 'config', 'path-timezones.md');
}

export function getManualItineraryPath(projectRoot: string): string {
  return join(projectRoot, 'config', 'manual-itinerary.md');
}

export async function loadPathTimezones(projectRoot: string): Promise<ILoadedPathTimezones> {
  const content = await loadOptionalMarkdown(getPathTimezonesPath(projectRoot));
  if (!content) {
    return { overrides: [], warnings: [] };
  }

  const warnings: string[] = [];
  const blocks = splitKeyValueBlocks(content);
  const overrides: IPathTimezoneOverride[] = [];

  for (const [index, block] of blocks.entries()) {
    const timezone = block.map.get('时区') ?? block.map.get('timezone');
    const pathPrefix = block.map.get('目录') ?? block.map.get('路径') ?? block.map.get('path') ?? block.map.get('pathprefix');
    if (!timezone || !pathPrefix) {
      warnings.push(`path-timezones block ${index + 1} missing timezone or path prefix`);
      continue;
    }

    overrides.push({
      id: `path-timezone-${index + 1}`,
      rootRef: block.map.get('素材源') ?? block.map.get('root') ?? block.map.get('rootid'),
      pathPrefix: normalizePortablePath(pathPrefix),
      timezone: timezone.trim(),
      notes: block.map.get('备注') ?? block.map.get('notes'),
    });
  }

  return { overrides, warnings };
}

export async function loadManualItinerary(projectRoot: string): Promise<ILoadedManualItinerary> {
  const content = await loadOptionalMarkdown(getManualItineraryPath(projectRoot));
  if (!content) {
    return { segments: [], warnings: [] };
  }

  const warnings: string[] = [];
  const defaultTimezone = extractDefaultTimezone(content);
  const blocks = splitKeyValueBlocks(content);
  const segments: IManualItinerarySegment[] = [];

  for (const [index, block] of blocks.entries()) {
    const dateTime = block.map.get('日期时间') ?? block.map.get('datetime') ?? block.map.get('date time');
    const parsedDateTime = parseManualDateTime(dateTime);
    const date = normalizeManualDate(block.map.get('日期') ?? block.map.get('date'))
      ?? parsedDateTime?.date;
    const time = normalizeManualTimeInput(block.map.get('时间') ?? block.map.get('time'))
      ?? parsedDateTime?.time;
    const location = block.map.get('地点') ?? block.map.get('location');
    const from = block.map.get('从') ?? block.map.get('from');
    const to = block.map.get('到') ?? block.map.get('to');
    const blockDefaultTimezone = block.map.get('默认时区') ?? block.map.get('default timezone');

    if (blockDefaultTimezone && !date && !time && !location && !from && !to && !dateTime) {
      continue;
    }

    if (!date) {
      warnings.push(`manual-itinerary block ${index + 1} missing date`);
      continue;
    }
    if (!location && !from && !to) {
      warnings.push(`manual-itinerary block ${index + 1} missing location/from/to`);
      continue;
    }

    const parsedTime = parseTimeWindow(time);
    if (time && !parsedTime) {
      warnings.push(`manual-itinerary block ${index + 1} has invalid time window "${time}"`);
    }

    segments.push({
      id: `manual-itinerary-${index + 1}`,
      date,
      startLocalTime: parsedTime?.start,
      endLocalTime: parsedTime?.end,
      timezone: block.map.get('时区') ?? block.map.get('timezone'),
      rootRef: block.map.get('素材源') ?? block.map.get('root') ?? block.map.get('rootid'),
      pathPrefix: normalizeOptionalPortablePath(
        block.map.get('目录')
          ?? block.map.get('路径')
          ?? block.map.get('path')
          ?? block.map.get('pathprefix'),
      ),
      location: location?.trim(),
      from: from?.trim(),
      to: to?.trim(),
      via: splitList(block.map.get('途经') ?? block.map.get('via')),
      transport: normalizeTransport(block.map.get('交通方式') ?? block.map.get('transport')),
      notes: block.map.get('备注') ?? block.map.get('notes'),
    });
  }

  return {
    defaultTimezone,
    segments,
    warnings,
  };
}

export function matchPathTimezoneOverride(input: {
  overrides: IPathTimezoneOverride[];
  rootId?: string;
  rootLabel?: string;
  sourcePath: string;
}): IPathTimezoneOverride | null {
  const pathCandidates = buildPortablePathCandidates({
    sourcePath: input.sourcePath,
    rootId: input.rootId,
    rootLabel: input.rootLabel,
  });
  let best: IPathTimezoneOverride | null = null;
  let bestScore = -1;

  for (const override of input.overrides) {
    if (!matchesRootRef(override.rootRef, input.rootId, input.rootLabel)) {
      continue;
    }
    if (!matchesPathPrefix(pathCandidates, override.pathPrefix)) {
      continue;
    }

    const score = override.pathPrefix.length + (override.rootRef ? 10000 : 0);
    if (score > bestScore) {
      best = override;
      bestScore = score;
    }
  }

  return best;
}

async function loadOptionalMarkdown(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf-8');
  } catch {
    return undefined;
  }
}

function splitKeyValueBlocks(content: string): Array<{ map: Map<string, string> }> {
  const lines = content
    .split(/\r?\n/u)
    .map(line => line.trim())
    .filter(line => !line.startsWith('#') && !line.startsWith('```'));

  const blocks: Array<{ map: Map<string, string> }> = [];
  let current = new Map<string, string>();
  let lastKey: string | null = null;

  const pushCurrent = () => {
    if (current.size === 0) return;
    blocks.push({ map: current });
    current = new Map<string, string>();
    lastKey = null;
  };

  for (const line of lines) {
    if (!line) {
      pushCurrent();
      continue;
    }

    const normalizedLine = line.replace(/^[*-]\s+/u, '');
    const match = normalizedLine.match(CKEY_SPLITTER);
    if (match) {
      const rawKey = match[1]?.trim() ?? '';
      const rawValue = match[2]?.trim() ?? '';
      if (!rawKey || !rawValue) continue;
      const key = rawKey.toLowerCase();
      current.set(rawKey, rawValue);
      current.set(key, rawValue);
      lastKey = rawKey;
      continue;
    }

    if (lastKey) {
      const existing = current.get(lastKey) ?? '';
      const appended = `${existing} ${normalizedLine}`.trim();
      current.set(lastKey, appended);
      current.set(lastKey.toLowerCase(), appended);
    }
  }

  pushCurrent();
  return blocks;
}

function extractDefaultTimezone(content: string): string | undefined {
  for (const rawLine of content.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^(默认时区|default timezone)\s*[:：]\s*(.+)$/iu);
    if (match?.[2]) return match[2].trim();
  }
  return undefined;
}

function normalizeOptionalPortablePath(value?: string): string | undefined {
  if (!value) return undefined;
  return normalizePortablePath(value);
}

function normalizeManualDate(raw?: string): string | undefined {
  if (!raw) return undefined;

  const match = raw.trim().match(/^(\d{4})\s*[./-年]\s*(\d{1,2})\s*[./-月]\s*(\d{1,2})\s*日?$/u);
  if (!match?.[1] || !match[2] || !match[3]) {
    return undefined;
  }

  return formatDateParts(match[1], match[2], match[3]);
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

function parseTimeWindow(raw?: string): { start: string; end: string } | null {
  if (!raw) return null;

  const cleaned = normalizeManualTimeInput(raw);
  if (!cleaned) return null;

  const rangeMatch = cleaned.match(/(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})/u);
  if (rangeMatch) {
    const start = normalizeClockValue(rangeMatch[1]);
    const end = normalizeClockValue(rangeMatch[2]);
    if (!start || !end) return null;
    return {
      start,
      end,
    };
  }

  const singleMatch = cleaned.match(/(\d{1,2}:\d{2})/u);
  const single = normalizeClockValue(singleMatch?.[1]);
  if (!single) return null;

  const minutes = timeToMinutes(single);
  if (minutes == null) return null;

  return {
    start: minutesToTime((minutes - 45 + 24 * 60) % (24 * 60)),
    end: minutesToTime((minutes + 45) % (24 * 60)),
  };
}

function parseManualDateTime(raw?: string): { date: string; time?: string } | null {
  if (!raw) return null;

  const match = raw.trim().match(
    /^(\d{4})\s*[./-年]\s*(\d{1,2})\s*[./-月]\s*(\d{1,2})\s*日?(?:[ tT]+(.+))?$/u,
  );
  if (!match?.[1] || !match[2] || !match[3]) {
    return null;
  }

  const date = formatDateParts(match[1], match[2], match[3]);
  const time = normalizeManualTimeInput(match[4]);
  return time ? { date, time } : { date };
}

function normalizeManualTimeInput(raw?: string): string | undefined {
  if (!raw) return undefined;

  const normalized = raw
    .trim()
    .replace(/[–—]/gu, '-')
    .replace(/\s*(?:~|～|至|到)+\s*/gu, ' - ');

  return normalized || undefined;
}

function splitList(raw?: string): string[] | undefined {
  if (!raw) return undefined;
  const items = raw
    .split(/[、,/，>|→]+/u)
    .map(item => item.trim())
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
}

function normalizeTransport(raw?: string): IManualItinerarySegment['transport'] {
  if (!raw) return undefined;
  const normalized = raw.trim().toLowerCase();
  if (['drive', 'driving', '自驾', '开车', '驾车'].includes(normalized)) return 'drive';
  if (['walk', 'walking', '步行', '徒步'].includes(normalized)) return 'walk';
  if (['train', '火车'].includes(normalized)) return 'train';
  if (['flight', 'plane', '飞机', '航班'].includes(normalized)) return 'flight';
  if (['boat', 'ferry', '船', '轮渡'].includes(normalized)) return 'boat';
  if (['mixed', '混合'].includes(normalized)) return 'mixed';
  return undefined;
}

function matchesRootRef(rootRef: string | undefined, rootId?: string, rootLabel?: string): boolean {
  if (!rootRef) return true;
  const normalized = rootRef.trim().toLowerCase();
  return normalized === (rootId ?? '').trim().toLowerCase()
    || normalized === (rootLabel ?? '').trim().toLowerCase();
}

function matchesPathPrefix(pathCandidates: string[], pathPrefix: string): boolean {
  return pathCandidates.some(candidate => candidate === pathPrefix || candidate.startsWith(`${pathPrefix}/`));
}

function buildPortablePathCandidates(input: {
  sourcePath: string;
  rootId?: string;
  rootLabel?: string;
}): string[] {
  const normalizedSource = normalizePortablePath(input.sourcePath);
  const candidates = new Set<string>([normalizedSource]);
  const normalizedRootLabel = normalizeOptionalPortablePath(input.rootLabel);
  const normalizedRootId = normalizeOptionalPortablePath(input.rootId);

  if (normalizedRootLabel) {
    candidates.add(`${normalizedRootLabel}/${normalizedSource}`);
  }
  if (normalizedRootId) {
    candidates.add(`${normalizedRootId}/${normalizedSource}`);
  }

  return [...candidates];
}

function timeToMinutes(value: string): number | null {
  const normalized = normalizeClockValue(value);
  if (!normalized) return null;
  const [hourText, minuteText] = normalized.split(':');
  const hour = Number(hourText);
  const minute = Number(minuteText);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  return hour * 60 + minute;
}

function normalizeClockValue(value?: string): string | undefined {
  if (!value) return undefined;

  const match = value.trim().match(/^(\d{1,2}):(\d{2})$/u);
  if (!match?.[1] || !match[2]) return undefined;

  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return undefined;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return undefined;

  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function formatDateParts(yearText: string, monthText: string, dayText: string): string {
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function minutesToTime(value: number): string {
  const normalized = ((value % (24 * 60)) + (24 * 60)) % (24 * 60);
  const hour = Math.floor(normalized / 60);
  const minute = normalized % 60;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}
