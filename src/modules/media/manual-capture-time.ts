import { readFile, writeFile } from 'node:fs/promises';
import { getManualItineraryPath } from '../../store/spatial-context.js';
import { convertLocalDateTimeToIso } from './timezone-utils.js';

const CMANUAL_CAPTURE_TIME_HEADING = '## 素材时间校正';
const CMANUAL_CAPTURE_TIME_HEADER = [
  '状态',
  '素材源',
  '路径',
  '当前时间UTC',
  '当前来源',
  '建议日期',
  '建议时间',
  '正确日期',
  '正确时间',
  '时区',
  '备注',
] as const;

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
  const rows = await loadManualCaptureTimeRows(projectRoot);
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
  const path = getManualItineraryPath(projectRoot);
  const current = await readFile(path, 'utf-8').catch(() => '');
  const { beforeSection, rows: existingRows } = splitManualCaptureTimeSection(current);
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

  const next = renderManualCaptureTimeDocument(beforeSection, [
    ...mergedRows,
    ...preservedManualRows,
  ]);
  if (next === current) {
    return {
      blockerCount: mergedRows.length,
      updated: false,
    };
  }

  await writeFile(path, next, 'utf-8');
  return {
    blockerCount: mergedRows.length,
    updated: true,
  };
}

function splitManualCaptureTimeSection(content: string): {
  beforeSection: string;
  rows: IManualCaptureTimeRow[];
} {
  const normalized = content.replace(/\r\n/gu, '\n');
  const sectionIndex = normalized.indexOf(CMANUAL_CAPTURE_TIME_HEADING);
  if (sectionIndex < 0) {
    return {
      beforeSection: normalized,
      rows: [],
    };
  }

  const beforeSection = normalized.slice(0, sectionIndex).trimEnd();
  const section = normalized.slice(sectionIndex);
  const tableLines = section
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.startsWith('|'));

  if (tableLines.length < 3) {
    return {
      beforeSection,
      rows: [],
    };
  }

  const rows = tableLines
    .slice(2)
    .map(parseManualCaptureTimeRow)
    .filter((row): row is IManualCaptureTimeRow => row != null);

  return { beforeSection, rows };
}

async function loadManualCaptureTimeRows(projectRoot: string): Promise<IManualCaptureTimeRow[]> {
  const path = getManualItineraryPath(projectRoot);
  const content = await readFile(path, 'utf-8').catch(() => '');
  return splitManualCaptureTimeSection(content).rows;
}

function renderManualCaptureTimeDocument(
  beforeSection: string,
  rows: IManualCaptureTimeRow[],
): string {
  const prefix = beforeSection.trimEnd();
  if (rows.length === 0) {
    return prefix ? `${prefix}\n` : '';
  }

  const section = [
    CMANUAL_CAPTURE_TIME_HEADING,
    '',
    '以下素材的拍摄时间和项目时间线明显不一致。请填写“正确日期 / 正确时间 / 时区”后重新运行 ingest；未填写的行会阻塞后续 Analyze。',
    '',
    `| ${CMANUAL_CAPTURE_TIME_HEADER.join(' | ')} |`,
    `| ${CMANUAL_CAPTURE_TIME_HEADER.map(() => '---').join(' | ')} |`,
    ...rows.map(renderManualCaptureTimeRow),
  ].join('\n');

  return prefix ? `${prefix}\n\n${section}\n` : `${section}\n`;
}

function renderManualCaptureTimeRow(row: IManualCaptureTimeRow): string {
  const status = row.correctedDate && row.correctedTime ? '已填写' : '待填写';
  const cells = [
    status,
    row.rootRef ?? '',
    row.sourcePath,
    row.currentCapturedAt ?? '',
    row.currentSource ?? '',
    row.suggestedDate ?? '',
    row.suggestedTime ?? '',
    row.correctedDate ?? '',
    row.correctedTime ?? '',
    row.timezone ?? '',
    row.note ?? '',
  ];

  return `| ${cells.map(escapeMarkdownCell).join(' | ')} |`;
}

function parseManualCaptureTimeRow(line: string): IManualCaptureTimeRow | null {
  const cells = line
    .split('|')
    .slice(1, -1)
    .map(value => value.trim().replace(/\\\|/gu, '|'));
  if (cells.length < CMANUAL_CAPTURE_TIME_HEADER.length) return null;

  const sourcePath = cells[2];
  if (!sourcePath) return null;

  return {
    rootRef: cells[1] || undefined,
    sourcePath,
    currentCapturedAt: cells[3] || undefined,
    currentSource: cells[4] || undefined,
    suggestedDate: cells[5] || undefined,
    suggestedTime: cells[6] || undefined,
    correctedDate: cells[7] || undefined,
    correctedTime: cells[8] || undefined,
    timezone: cells[9] || undefined,
    note: cells[10] || undefined,
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

function escapeMarkdownCell(value: string): string {
  return value.replace(/\|/gu, '\\|').trim();
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
