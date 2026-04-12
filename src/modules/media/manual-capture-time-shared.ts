import type {
  IManualCaptureTimeOverrideConfig,
  IReviewItem,
} from '../../protocol/schema.js';
import { convertLocalDateTimeToIso, formatDateInTimeZone, isValidTimeZone } from './timezone-utils.js';

type TManualCaptureRow = Pick<
  IManualCaptureTimeOverrideConfig,
  'rootRef'
  | 'sourcePath'
  | 'currentCapturedAt'
  | 'currentSource'
  | 'suggestedDate'
  | 'suggestedTime'
  | 'correctedDate'
  | 'correctedTime'
  | 'timezone'
  | 'note'
>;

export interface IResolvedManualCaptureTimeRow extends TManualCaptureRow {
  correctedDate: string;
  correctedTime: string;
  timezone?: string;
  capturedAt: string;
  correctedDateSource: 'manual' | 'suggested' | 'current-captured-at';
}

export function normalizeManualCaptureDate(value?: string): string | undefined {
  const match = value?.trim().match(/^(\d{4})[-/.](\d{2})[-/.](\d{2})$/u);
  if (!match?.[1] || !match[2] || !match[3]) return undefined;
  return `${match[1]}-${match[2]}-${match[3]}`;
}

export function normalizeManualCaptureTime(value?: string): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;

  const minutePrecision = trimmed.match(/^(\d{2}):(\d{2})$/u);
  if (minutePrecision?.[1] && minutePrecision[2]) {
    return `${minutePrecision[1]}:${minutePrecision[2]}:00`;
  }

  const secondPrecision = trimmed.match(/^(\d{2}):(\d{2}):(\d{2})$/u);
  if (secondPrecision?.[1] && secondPrecision[2] && secondPrecision[3]) {
    return `${secondPrecision[1]}:${secondPrecision[2]}:${secondPrecision[3]}`;
  }

  return undefined;
}

export function normalizeManualCaptureTimezone(value?: string): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

export function inferManualCaptureDate(
  row: Pick<TManualCaptureRow, 'correctedDate' | 'suggestedDate' | 'currentCapturedAt' | 'timezone'>,
): {
  date: string;
  source: IResolvedManualCaptureTimeRow['correctedDateSource'];
} | null {
  const manualDate = normalizeManualCaptureDate(row.correctedDate);
  if (manualDate) {
    return {
      date: manualDate,
      source: 'manual',
    };
  }

  const suggestedDate = normalizeManualCaptureDate(row.suggestedDate);
  if (suggestedDate) {
    return {
      date: suggestedDate,
      source: 'suggested',
    };
  }

  const timezone = normalizeManualCaptureTimezone(row.timezone);
  if (!timezone || !isValidTimeZone(timezone) || !row.currentCapturedAt) {
    return null;
  }

  const zoned = formatDateInTimeZone(row.currentCapturedAt, timezone);
  if (!zoned?.date) return null;
  return {
    date: zoned.date,
    source: 'current-captured-at',
  };
}

export function resolveManualCaptureTimeRow(
  row: TManualCaptureRow,
): IResolvedManualCaptureTimeRow | null {
  const correctedTime = normalizeManualCaptureTime(row.correctedTime);
  if (!correctedTime) return null;

  const inferredDate = inferManualCaptureDate(row);
  if (!inferredDate) return null;

  const timezone = normalizeManualCaptureTimezone(row.timezone);
  const capturedAt = convertLocalDateTimeToIso(inferredDate.date, correctedTime, timezone);
  if (!capturedAt) return null;

  return {
    ...row,
    correctedDate: inferredDate.date,
    correctedTime,
    timezone,
    capturedAt,
    correctedDateSource: inferredDate.source,
  };
}

export function materializeManualCaptureTimeRow(
  row: TManualCaptureRow,
): IManualCaptureTimeOverrideConfig {
  const resolved = resolveManualCaptureTimeRow(row);
  return {
    rootRef: row.rootRef?.trim() || undefined,
    sourcePath: row.sourcePath.trim(),
    currentCapturedAt: row.currentCapturedAt?.trim() || undefined,
    currentSource: row.currentSource?.trim() || undefined,
    suggestedDate: normalizeManualCaptureDate(row.suggestedDate),
    suggestedTime: normalizeManualCaptureTime(row.suggestedTime),
    correctedDate: resolved?.correctedDate ?? normalizeManualCaptureDate(row.correctedDate),
    correctedTime: normalizeManualCaptureTime(row.correctedTime),
    timezone: normalizeManualCaptureTimezone(row.timezone),
    note: row.note?.trim() || undefined,
  };
}

export function isManualCaptureTimeResolved(row: TManualCaptureRow): boolean {
  return resolveManualCaptureTimeRow(row) != null;
}

export function manualCaptureTimeRequiresExplicitDate(
  row: Pick<TManualCaptureRow, 'correctedDate' | 'suggestedDate' | 'currentCapturedAt' | 'correctedTime' | 'timezone'>,
): boolean {
  if (!normalizeManualCaptureTime(row.correctedTime)) return false;
  return inferManualCaptureDate(row) == null;
}

export function buildCaptureTimeReviewItems(
  projectId: string,
  rows: TManualCaptureRow[],
): IReviewItem[] {
  const now = new Date().toISOString();
  return rows.map(row => {
    const resolved = isManualCaptureTimeResolved(row);
    return {
      id: `capture-time:${buildManualCaptureTimeReviewKey(row.rootRef, row.sourcePath)}`,
      projectId,
      kind: 'capture-time-correction',
      stage: 'ingest',
      status: resolved ? 'resolved' : 'open',
      title: `校正素材拍摄时间：${row.sourcePath}`,
      reason: row.note ?? '当前拍摄时间与项目时间线明显不一致。',
      sourcePath: row.sourcePath,
      rootRef: row.rootRef,
      currentValue: {
        currentCapturedAt: row.currentCapturedAt ?? '',
        currentSource: row.currentSource ?? '',
      },
      suggestedValue: {
        suggestedDate: row.suggestedDate ?? '',
        suggestedTime: row.suggestedTime ?? '',
        timezone: row.timezone ?? '',
      },
      fields: [
        {
          key: 'correctedDate',
          label: '正确日期',
          value: row.correctedDate,
          suggestedValue: row.suggestedDate,
          required: manualCaptureTimeRequiresExplicitDate(row),
        },
        {
          key: 'correctedTime',
          label: '正确时间',
          value: row.correctedTime,
          suggestedValue: row.suggestedTime,
          required: true,
        },
        {
          key: 'timezone',
          label: '时区',
          value: row.timezone,
          suggestedValue: row.timezone,
        },
      ],
      note: row.note,
      createdAt: now,
      updatedAt: now,
      resolvedAt: resolved ? now : undefined,
    };
  });
}

export function buildManualCaptureTimeReviewKey(rootRef: string | undefined, sourcePath: string): string {
  return `${(rootRef ?? '').trim().toLowerCase()}::${normalizePortablePath(sourcePath)}`;
}

export function normalizePortablePath(value: string): string {
  return value
    .trim()
    .replace(/\\/gu, '/')
    .replace(/^\.?\//u, '')
    .replace(/\/+/gu, '/')
    .toLowerCase();
}
