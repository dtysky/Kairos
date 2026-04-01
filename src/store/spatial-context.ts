import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface IManualItinerarySegment {
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
}

export interface ILoadedManualItinerary {
  segments: IManualItinerarySegment[];
  warnings: string[];
}

const CKEY_SPLITTER = /^([^:：]+)\s*[:：]\s*(.+)$/u;
const CNATURAL_TIME_PERIODS = /(凌晨|清晨|早上|上午|中午|下午|傍晚|晚上|夜里|午夜)/u;

interface IManualTextBlock {
  map: Map<string, string>;
  prose: string[];
}

interface IParsedNaturalManualSegment {
  date?: string;
  time?: string;
  location?: string;
  from?: string;
  to?: string;
  transport?: IManualItinerarySegment['transport'];
}

export function getManualItineraryPath(projectRoot: string): string {
  return join(projectRoot, 'config', 'manual-itinerary.md');
}

export async function loadManualItinerary(projectRoot: string): Promise<ILoadedManualItinerary> {
  const content = await loadOptionalMarkdown(getManualItineraryPath(projectRoot));
  if (!content) {
    return { segments: [], warnings: [] };
  }

  const warnings: string[] = [];
  const blocks = splitManualBlocks(content);
  const segments: IManualItinerarySegment[] = [];

  for (const [index, block] of blocks.entries()) {
    const parsedNatural = parseNaturalManualSegment(block.prose.join(' '));
    const dateTime = block.map.get('日期时间') ?? block.map.get('datetime') ?? block.map.get('date time');
    const parsedDateTime = parseManualDateTime(dateTime);
    const date = normalizeManualDate(block.map.get('日期') ?? block.map.get('date'))
      ?? parsedNatural.date
      ?? parsedDateTime?.date;
    const time = normalizeManualTimeInput(block.map.get('时间') ?? block.map.get('time'))
      ?? parsedNatural.time
      ?? parsedDateTime?.time;
    const location = block.map.get('地点') ?? block.map.get('location') ?? parsedNatural.location;
    const from = block.map.get('从') ?? block.map.get('from') ?? parsedNatural.from;
    const to = block.map.get('到') ?? block.map.get('to') ?? parsedNatural.to;
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
      transport: normalizeTransport(block.map.get('交通方式') ?? block.map.get('transport'))
        ?? parsedNatural.transport,
      notes: block.map.get('备注') ?? block.map.get('notes'),
    });
  }

  return {
    segments,
    warnings,
  };
}

async function loadOptionalMarkdown(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf-8');
  } catch {
    return undefined;
  }
}

function splitManualBlocks(content: string): IManualTextBlock[] {
  const lines = content
    .split(/\r?\n/u)
    .map(line => line.trim())
    .filter(line => !line.startsWith('#') && !line.startsWith('```'));

  const blocks: IManualTextBlock[] = [];
  let current = new Map<string, string>();
  let prose: string[] = [];
  let lastKey: string | null = null;

  const pushCurrent = () => {
    if (current.size === 0 && prose.length === 0) return;
    blocks.push({ map: current, prose });
    current = new Map<string, string>();
    prose = [];
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
      continue;
    }

    prose.push(normalizedLine);
  }

  pushCurrent();
  return blocks;
}

function normalizeOptionalPortablePath(value?: string): string | undefined {
  if (!value) return undefined;
  return normalizePortablePath(value);
}

function normalizeManualDate(raw?: string): string | undefined {
  if (!raw) return undefined;

  const match = raw.trim().match(/^(\d{4})\s*[./年-]\s*(\d{1,2})\s*[./月-]\s*(\d{1,2})\s*日?$/u);
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
    /^(\d{4})\s*[./年-]\s*(\d{1,2})\s*[./月-]\s*(\d{1,2})\s*日?(?:[ tT]+(.+))?$/u,
  );
  if (!match?.[1] || !match[2] || !match[3]) {
    return null;
  }

  const date = formatDateParts(match[1], match[2], match[3]);
  const time = normalizeManualTimeInput(match[4]);
  return time ? { date, time } : { date };
}

function parseNaturalManualSegment(raw?: string): IParsedNaturalManualSegment {
  if (!raw) return {};

  const text = raw.trim();
  if (!text) return {};

  const route = extractNaturalRoute(text);
  return {
    date: extractNaturalDate(text),
    time: extractNaturalTimeInput(text),
    transport: extractNaturalTransport(text),
    ...route,
  };
}

function extractNaturalDate(raw: string): string | undefined {
  const match = raw.match(/(\d{4}\s*[./年-]\s*\d{1,2}\s*[./月-]\s*\d{1,2}\s*日?)/u);
  return normalizeManualDate(match?.[1]);
}

function extractNaturalTimeInput(raw: string): string | undefined {
  const match = raw.match(
    /(?:凌晨|清晨|早上|上午|中午|下午|傍晚|晚上|夜里|午夜)?\s*[零一二两三四五六七八九十\d]{1,3}\s*点(?:\s*(?:半|[零一二两三四五六七八九十\d]{1,3}\s*分?))?\s*(?:左右)?/u,
  );
  return parseNaturalClockPhrase(match?.[0]);
}

function parseNaturalClockPhrase(raw?: string): string | undefined {
  if (!raw) return undefined;

  const match = raw.trim().match(
    /(?:(凌晨|清晨|早上|上午|中午|下午|傍晚|晚上|夜里|午夜))?\s*([零一二两三四五六七八九十\d]{1,3})\s*点(?:\s*(半|[零一二两三四五六七八九十\d]{1,3})\s*分?)?\s*(?:左右)?/u,
  );
  if (!match?.[2]) return undefined;

  const period = match[1];
  const hour = parseNaturalNumber(match[2]);
  if (hour == null) return undefined;

  const minute = match[3] === '半'
    ? 30
    : (parseNaturalNumber(match[3]) ?? 0);
  if (minute < 0 || minute > 59) return undefined;

  const resolvedHour = resolveNaturalHour(hour, period);
  if (resolvedHour == null) return undefined;

  return `${String(resolvedHour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function resolveNaturalHour(hour: number, period?: string): number | null {
  if (!Number.isFinite(hour) || hour < 0 || hour > 23) return null;

  if (period === '下午' || period === '傍晚' || period === '晚上') {
    return hour < 12 ? hour + 12 : hour;
  }
  if (period === '中午') {
    if (hour === 0) return 12;
    return hour < 11 ? hour + 12 : hour;
  }
  if (period === '午夜') {
    return hour === 12 ? 0 : hour;
  }
  if (period === '凌晨' || period === '清晨' || period === '早上' || period === '上午' || period === '夜里') {
    return hour === 24 ? 0 : hour;
  }
  return hour;
}

function parseNaturalNumber(raw?: string): number | null {
  if (!raw) return null;

  const normalized = raw.trim().replace(/两/gu, '二');
  if (!normalized) return null;
  if (/^\d+$/u.test(normalized)) {
    const value = Number(normalized);
    return Number.isFinite(value) ? value : null;
  }

  const digits: Record<string, number> = {
    零: 0,
    一: 1,
    二: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
  };

  if (normalized === '十') return 10;
  if (normalized.includes('十')) {
    const [left, right] = normalized.split('十');
    const tens = left ? digits[left] : 1;
    const ones = right ? digits[right] : 0;
    if (tens == null || ones == null) return null;
    return tens * 10 + ones;
  }

  return digits[normalized] ?? null;
}

function extractNaturalTransport(raw: string): IManualItinerarySegment['transport'] {
  if (/(自驾|开车|驾车)/u.test(raw)) return 'drive';
  if (/(步行|徒步|走路)/u.test(raw)) return 'walk';
  if (/(火车|高铁)/u.test(raw)) return 'train';
  if (/(飞机|航班|飞往)/u.test(raw)) return 'flight';
  if (/(轮渡|渡轮|坐船|乘船|船)/u.test(raw)) return 'boat';
  if (/(混合|转场)/u.test(raw)) return 'mixed';
  return undefined;
}

function extractNaturalRoute(raw: string): Pick<IParsedNaturalManualSegment, 'location' | 'from' | 'to'> {
  const fromTo = raw.match(/从\s*([^，。,；;]+?)\s*(?:到|至)\s*([^，。,；;]+?)(?:[，。,；;]|$)/u);
  if (fromTo?.[1] && fromTo[2]) {
    return {
      from: cleanNaturalPlace(fromTo[1]),
      to: cleanNaturalPlace(fromTo[2]),
    };
  }

  const from = cleanNaturalPlace(
    raw.match(/从\s*([^，。,；;]+?)\s*(?:出发|启程|返程|返回|前往|去|[，。,；;]|$)/u)?.[1],
  );
  const to = cleanNaturalPlace(
    raw.match(/(?:到|至|抵达|到达)\s*([^，。,；;]+?)(?:[，。,；;]|$)/u)?.[1],
  );
  const location = cleanNaturalPlace(
    raw.match(/(?:在|于)\s*([^，。,；;]+?)(?:拍摄|停留|休息|附近|一带|[，。,；;]|$)/u)?.[1],
  );

  return { location, from, to };
}

function cleanNaturalPlace(value?: string): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
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
