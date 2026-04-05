import { basename } from 'node:path';
import {
  loadManualItineraryConfig,
  loadProject,
  replaceReviewItemsByMatcher,
  saveManualItineraryConfig,
} from '../../store/index.js';
import type { IReviewItem } from '../../protocol/schema.js';
import { convertLocalDateTimeToIso } from './timezone-utils.js';

export interface IManualCaptureTimeOverride {
  rootRef?: string;
  sourcePath: string;
  capturedAt: string;
  timezone?: string;
  correctedDate: string;
  correctedTime: string;
  note?: string;
}

export interface IManualCaptureTimeBlocker {
  rootRef?: string;
  sourcePath: string;
  currentCapturedAt?: string;
  currentSource?: string;
  suggestedDate?: string;
  suggestedTime?: string;
  timezone?: string;
  note?: string;
}

interface IManualCaptureTimeRow extends IManualCaptureTimeBlocker {
  correctedDate?: string;
  correctedTime?: string;
}

export async function loadManualCaptureTimeOverrides(
  projectRoot: string,
): Promise<IManualCaptureTimeOverride[]> {
  const config = await loadManualItineraryConfig(projectRoot);
  const rows = config.captureTimeOverrides;
  const overrides: IManualCaptureTimeOverride[] = [];

  for (const row of rows) {
    const correctedDate = normalizeDate(row.correctedDate);
    const correctedTime = normalizeTime(row.correctedTime);
    const timezone = row.timezone?.trim() || undefined;
    if (!correctedDate || !correctedTime) continue;

    const capturedAt = convertLocalDateTimeToIso(correctedDate, correctedTime, timezone);
    if (!capturedAt) continue;

    overrides.push({
      rootRef: row.rootRef,
      sourcePath: row.sourcePath,
      capturedAt,
      timezone,
      correctedDate,
      correctedTime,
      note: row.note,
    });
  }

  return overrides;
}

export function findManualCaptureTimeOverride(
  overrides: IManualCaptureTimeOverride[],
  asset: {
    rootRef?: string;
    sourcePath: string;
  },
): IManualCaptureTimeOverride | null {
  const key = buildManualCaptureTimeKey(asset.rootRef, asset.sourcePath);
  return overrides.find(item => buildManualCaptureTimeKey(item.rootRef, item.sourcePath) === key) ?? null;
}

export async function syncManualCaptureTimeBlockers(
  projectRoot: string,
  blockers: IManualCaptureTimeBlocker[],
): Promise<{ blockerCount: number; updated: boolean }> {
  const [currentConfig, project] = await Promise.all([
    loadManualItineraryConfig(projectRoot),
    loadProject(projectRoot).catch(() => null),
  ]);
  const existingRows = currentConfig.captureTimeOverrides;
  const existingByKey = new Map(existingRows.map(row => [
    buildManualCaptureTimeKey(row.rootRef, row.sourcePath),
    row,
  ]));
  const blockerKeys = new Set(
    blockers.map(blocker => buildManualCaptureTimeKey(blocker.rootRef, blocker.sourcePath)),
  );

  const mergedRows = blockers.map(blocker => {
    const existing = existingByKey.get(buildManualCaptureTimeKey(blocker.rootRef, blocker.sourcePath));
    const hasManualEdits = Boolean(existing?.correctedDate || existing?.correctedTime);
    return {
      ...blocker,
      correctedDate: existing?.correctedDate,
      correctedTime: existing?.correctedTime,
      timezone: existing?.timezone ?? blocker.timezone,
      note: hasManualEdits
        ? pickRowNote(existing?.note, blocker.note)
        : blocker.note,
    } satisfies IManualCaptureTimeRow;
  });
  const preservedManualRows = existingRows.filter(row => {
    if (!row.correctedDate || !row.correctedTime) return false;
    return !blockerKeys.has(buildManualCaptureTimeKey(row.rootRef, row.sourcePath));
  });

  const nextRows = [
    ...mergedRows,
    ...preservedManualRows,
  ];
  await saveManualItineraryConfig(projectRoot, {
    ...currentConfig,
    captureTimeOverrides: nextRows,
  });
  await replaceReviewItemsByMatcher(
    projectRoot,
    buildCaptureTimeReviewItems(project?.id ?? basename(projectRoot), nextRows),
    item => item.kind === 'capture-time-correction',
  );
  return {
    blockerCount: mergedRows.length,
    updated: true,
  };
}

function buildManualCaptureTimeKey(rootRef: string | undefined, sourcePath: string): string {
  return `${(rootRef ?? '').trim().toLowerCase()}::${normalizePortablePath(sourcePath)}`;
}

function normalizePortablePath(value: string): string {
  return value
    .trim()
    .replace(/\\/gu, '/')
    .replace(/^\.?\//u, '')
    .replace(/\/+/gu, '/')
    .toLowerCase();
}

function pickRowNote(existing?: string, generated?: string): string | undefined {
  const trimmedExisting = existing?.trim();
  const trimmedGenerated = generated?.trim();
  if (trimmedExisting && trimmedGenerated && trimmedExisting !== trimmedGenerated) {
    return `${trimmedGenerated}；${trimmedExisting}`;
  }
  return trimmedExisting || trimmedGenerated || undefined;
}

function normalizeDate(value?: string): string | undefined {
  const match = value?.trim().match(/^(\d{4})[-/.](\d{2})[-/.](\d{2})$/u);
  if (!match?.[1] || !match[2] || !match[3]) return undefined;
  return `${match[1]}-${match[2]}-${match[3]}`;
}

function normalizeTime(value?: string): string | undefined {
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

function buildCaptureTimeReviewItems(
  projectId: string,
  rows: IManualCaptureTimeRow[],
): IReviewItem[] {
  const now = new Date().toISOString();
  return rows.map(row => {
    const resolved = Boolean(row.correctedDate && row.correctedTime);
    return {
      id: `capture-time:${buildManualCaptureTimeKey(row.rootRef, row.sourcePath)}`,
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
          required: true,
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
