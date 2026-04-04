import { stat } from 'node:fs/promises';
import { basename } from 'node:path';
import type { ICaptureTime } from '../../protocol/schema.js';
import type { IProbeResult } from './probe.js';
import { convertLocalDateTimeToIso } from './timezone-utils.js';

/**
 * 按优先级提取拍摄时间：
 * 1. EXIF DateTimeOriginal(+OffsetTimeOriginal)
 * 2. EXIF CreateDate(+OffsetTimeDigitized/OffsetTime)
 * 3. EXIF GPSDateTime
 * 4. container/quicktime creation_time
 * 5. 文件名中的时间戳
 * 6. 文件系统修改时间
 */
export async function resolveCaptureTime(
  filePath: string,
  probeResult: IProbeResult,
): Promise<ICaptureTime> {
  const exif = resolveExifCaptureTime(probeResult.rawTags);
  if (exif) {
    return exif;
  }

  // Priority 1: container metadata
  if (probeResult.creationTime) {
    const parsed = tryParseIso(probeResult.creationTime);
    if (parsed) {
      return {
        capturedAt: parsed,
        originalValue: probeResult.creationTime,
        source: 'container',
        confidence: 0.9,
      };
    }
  }

  // Priority 2: filename pattern
  const fromName = tryParseFilename(basename(filePath));
  if (fromName) return fromName;

  // Priority 3: filesystem mtime
  try {
    const info = await stat(filePath);
    return {
      capturedAt: info.mtime.toISOString(),
      originalValue: info.mtime.toISOString(),
      source: 'filesystem',
      confidence: 0.3,
    };
  } catch {
    return { source: 'filesystem', confidence: 0 };
  }
}

function tryParseIso(value: string): string | null {
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

export interface IFilenameCaptureTimeHint {
  date: string;
  time: string;
  originalValue: string;
}

const CEXIF_DATETIME = /^(\d{4})[:.-](\d{2})[:.-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:[.,](\d+))?(?:\s*(Z|[+-]\d{2}:\d{2}))?$/u;

// Common filename patterns from cameras/drones
const CFILENAME_PATTERNS: RegExp[] = [
  /(\d{4})[-_]?(\d{2})[-_]?(\d{2})[-_T ]?(\d{2})[-_:]?(\d{2})[-_:]?(\d{2})/,
  /(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/,
  /IMG_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/,
  /DSC(\d{5})/,  // Sony — no time info, skip
];

export function resolveExifCaptureTime(rawTags?: Record<string, string>): ICaptureTime | null {
  if (!rawTags || Object.keys(rawTags).length === 0) return null;

  const original = parseExifDateTime(
    rawTags['subsecdatetimeoriginal'] ?? rawTags['datetimeoriginal'],
    rawTags['offsettimeoriginal'],
  );
  if (original) {
    return {
      capturedAt: original.capturedAt,
      originalValue: original.originalValue,
      originalTimezone: original.originalTimezone,
      source: 'exif',
      confidence: original.explicitTimezone ? 0.98 : 0.8,
    };
  }

  const created = parseExifDateTime(
    rawTags['subseccreatedate'] ?? rawTags['createdate'],
    rawTags['offsettimedigitized'] ?? rawTags['offsettime'],
  );
  if (created) {
    return {
      capturedAt: created.capturedAt,
      originalValue: created.originalValue,
      originalTimezone: created.originalTimezone,
      source: 'exif',
      confidence: created.explicitTimezone ? 0.95 : 0.75,
    };
  }

  const gpsDateTime = parseExifDateTime(
    rawTags['gpsdatetime']
      ?? combineGpsDateTime(rawTags['gpsdatestamp'], rawTags['gpstimestamp']),
  );
  if (gpsDateTime) {
    return {
      capturedAt: gpsDateTime.capturedAt,
      originalValue: gpsDateTime.originalValue,
      originalTimezone: gpsDateTime.originalTimezone,
      source: 'exif',
      confidence: gpsDateTime.explicitTimezone ? 0.92 : 0.88,
    };
  }

  return null;
}

export function extractFilenameCaptureTimeHint(name: string): IFilenameCaptureTimeHint | null {
  for (const pattern of CFILENAME_PATTERNS) {
    const match = name.match(pattern);
    if (!match) continue;

    if (match.length >= 7) {
      const [, yr, mo, dy, hr, mi, sc] = match;
      return {
        date: `${yr}-${mo}-${dy}`,
        time: `${hr}:${mi}:${sc}`,
        originalValue: `${yr}-${mo}-${dy}T${hr}:${mi}:${sc}`,
      };
    }
  }

  return null;
}

function tryParseFilename(
  name: string,
): ICaptureTime | null {
  const hint = extractFilenameCaptureTimeHint(name);
  if (!hint) {
    return null;
  }

  const capturedAt = convertLocalDateTimeToIso(hint.date, hint.time);
  if (!capturedAt) return null;

  return {
    capturedAt,
    originalValue: hint.originalValue,
    source: 'filename',
    confidence: 0.5,
  };
}

function parseExifDateTime(
  value?: string,
  timezoneHint?: string,
): {
  capturedAt: string;
  originalValue: string;
  originalTimezone?: string;
  explicitTimezone: boolean;
} | null {
  if (!value) return null;

  const match = value.trim().match(CEXIF_DATETIME);
  if (!match?.[1] || !match[2] || !match[3] || !match[4] || !match[5] || !match[6]) {
    return null;
  }

  const date = `${match[1]}-${match[2]}-${match[3]}`;
  const time = `${match[4]}:${match[5]}:${match[6]}`;
  const embeddedTimezone = normalizeExifTimezone(match[8]);
  const hintedTimezone = normalizeExifTimezone(timezoneHint);
  const effectiveTimezone = embeddedTimezone ?? hintedTimezone;
  const capturedAt = convertLocalDateTimeToIso(date, time, effectiveTimezone);
  if (!capturedAt) return null;

  return {
    capturedAt,
    originalValue: value.trim(),
    originalTimezone: effectiveTimezone,
    explicitTimezone: Boolean(effectiveTimezone),
  };
}

function normalizeExifTimezone(value?: string): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (trimmed === 'Z') return '+00:00';
  return /^[+-]\d{2}:\d{2}$/u.test(trimmed) ? trimmed : undefined;
}

function combineGpsDateTime(date?: string, time?: string): string | undefined {
  const dateMatch = date?.trim().match(/^(\d{4})[:.-](\d{2})[:.-](\d{2})$/u);
  const timeMatch = time?.trim().match(/^(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?$/u);
  if (!dateMatch?.[1] || !dateMatch[2] || !dateMatch[3] || !timeMatch?.[1] || !timeMatch[2] || !timeMatch[3]) {
    return undefined;
  }

  return `${dateMatch[1]}:${dateMatch[2]}:${dateMatch[3]} ${timeMatch[1]}:${timeMatch[2]}:${timeMatch[3]}Z`;
}
