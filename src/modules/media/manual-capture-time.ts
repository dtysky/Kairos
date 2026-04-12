import { basename } from 'node:path';
import {
  loadManualItineraryConfig,
  loadProject,
  replaceReviewItemsByMatcher,
  saveManualItineraryConfig,
} from '../../store/index.js';
import {
  buildCaptureTimeReviewItems,
  buildManualCaptureTimeReviewKey,
  isManualCaptureTimeResolved,
  resolveManualCaptureTimeRow,
} from './manual-capture-time-shared.js';

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
    const resolved = resolveManualCaptureTimeRow(row);
    if (!resolved) continue;

    overrides.push({
      rootRef: row.rootRef,
      sourcePath: row.sourcePath,
      capturedAt: resolved.capturedAt,
      timezone: resolved.timezone,
      correctedDate: resolved.correctedDate,
      correctedTime: resolved.correctedTime,
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
    if (!isManualCaptureTimeResolved(row)) return false;
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
  return buildManualCaptureTimeReviewKey(rootRef, sourcePath);
}

function pickRowNote(existing?: string, generated?: string): string | undefined {
  const trimmedExisting = existing?.trim();
  const trimmedGenerated = generated?.trim();
  if (trimmedExisting && trimmedGenerated && trimmedExisting !== trimmedGenerated) {
    return `${trimmedGenerated}；${trimmedExisting}`;
  }
  return trimmedExisting || trimmedGenerated || undefined;
}
