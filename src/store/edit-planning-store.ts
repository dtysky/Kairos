import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { IEditFlowPlan, IEditFlowRunsState, IEditFlowStepRunRecord } from '../protocol/schema.js';
import {
  IEditFlowPlan as ZEditFlowPlan,
  IEditFlowRunsState as ZEditFlowRunsState,
  IEditFlowStepRunRecord as ZEditFlowStepRunRecord,
} from '../protocol/schema.js';
import { getProjectEditPlanningRoot, getProjectEditRoot, shouldReadLegacyEditPath } from './edit-store.js';
import { readJsonOrNull, writeJson } from './writer.js';

export function getEditFlowPlanPath(projectRoot: string, editId?: string | null): string {
  return join(getProjectEditPlanningRoot(projectRoot, editId), 'flow-plan.json');
}

export function getEditPlanningArtifactPath(
  projectRoot: string,
  artifactName: string,
  editId?: string | null,
): string {
  return join(getProjectEditPlanningRoot(projectRoot, editId), artifactName);
}

export function getEditFlowRunsRoot(projectRoot: string, editId?: string | null): string {
  return join(getProjectEditRoot(projectRoot, editId), 'runs');
}

export function getEditFlowRunsCurrentPath(projectRoot: string, editId?: string | null): string {
  return join(getEditFlowRunsRoot(projectRoot, editId), 'current.json');
}

export async function loadEditFlowPlan(
  projectRoot: string,
  editId?: string | null,
): Promise<IEditFlowPlan | null> {
  const primary = await readJsonOrNull(getEditFlowPlanPath(projectRoot, editId), ZEditFlowPlan) as IEditFlowPlan | null;
  if (primary || !shouldReadLegacyEditPath(editId)) return primary;
  return readJsonOrNull(join(projectRoot, 'planning', 'flow-plan.json'), ZEditFlowPlan) as Promise<IEditFlowPlan | null>;
}

export async function writeEditFlowPlan(
  projectRoot: string,
  plan: IEditFlowPlan,
  editId?: string | null,
): Promise<void> {
  const target = getEditFlowPlanPath(projectRoot, editId);
  await mkdir(dirname(target), { recursive: true });
  await writeJson(target, ZEditFlowPlan.parse(plan));
}

export async function markEditFlowPlanStale(
  projectRoot: string,
  editId: string | null | undefined,
  staleReason: string,
): Promise<IEditFlowPlan | null> {
  const existing = await loadEditFlowPlan(projectRoot, editId);
  if (!existing) return null;
  const stale = ZEditFlowPlan.parse({
    ...existing,
    status: 'stale',
    staleReason,
    updatedAt: new Date().toISOString(),
  });
  await writeEditFlowPlan(projectRoot, stale, editId);
  return stale;
}

export async function loadEditFlowRunRecord(
  projectRoot: string,
  runId: string,
  editId?: string | null,
): Promise<IEditFlowStepRunRecord | null> {
  const state = await loadEditFlowRunsState(projectRoot, editId);
  return state.records.find(record => record.runId === runId) ?? null;
}

export async function writeEditFlowRunRecord(
  projectRoot: string,
  record: IEditFlowStepRunRecord,
  editId?: string | null,
): Promise<void> {
  const parsedRecord = sanitizeEditFlowRunRecordForCurrent(ZEditFlowStepRunRecord.parse(record));
  const target = getEditFlowRunsCurrentPath(projectRoot, editId);
  const current = await loadEditFlowRunsState(projectRoot, editId);
  const records = [
    ...current.records.filter(item => item.runId !== parsedRecord.runId),
    parsedRecord,
  ].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  await mkdir(dirname(target), { recursive: true });
  await writeJson(target, ZEditFlowRunsState.parse({
    schemaVersion: '1.0',
    editId: parsedRecord.editId,
    updatedAt: parsedRecord.updatedAt,
    records,
  }));
}

export async function loadEditFlowRunRecords(
  projectRoot: string,
  editId?: string | null,
): Promise<IEditFlowStepRunRecord[]> {
  const state = await loadEditFlowRunsState(projectRoot, editId);
  return state.records
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

export async function markEditFlowRunRecordsStale(
  projectRoot: string,
  editId: string | null | undefined,
  staleReason: string,
): Promise<IEditFlowStepRunRecord[]> {
  const records = await loadEditFlowRunRecords(projectRoot, editId);
  if (records.length === 0) return [];
  const now = new Date().toISOString();
  const nextRecords = records.map(record => sanitizeEditFlowRunRecordForCurrent(ZEditFlowStepRunRecord.parse({
    ...record,
    status: 'stale',
    updatedAt: now,
    error: staleReason,
    review: {
      ...record.review,
      note: staleReason,
    },
  })));
  const target = getEditFlowRunsCurrentPath(projectRoot, editId);
  await mkdir(dirname(target), { recursive: true });
  await writeJson(target, ZEditFlowRunsState.parse({
    schemaVersion: '1.0',
    editId: editId ?? 'main',
    updatedAt: now,
    records: nextRecords,
  }));
  return nextRecords;
}

export async function findLatestEditFlowStepRunRecord(
  projectRoot: string,
  stepId: string,
  editId?: string | null,
): Promise<IEditFlowStepRunRecord | null> {
  const records = await loadEditFlowRunRecords(projectRoot, editId);
  return records
    .filter(record => record.stepId === stepId)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0] ?? null;
}

async function loadEditFlowRunsState(
  projectRoot: string,
  editId?: string | null,
): Promise<IEditFlowRunsState> {
  const state = await readJsonOrNull(
    getEditFlowRunsCurrentPath(projectRoot, editId),
    ZEditFlowRunsState,
  ) as IEditFlowRunsState | null;
  if (state) return state;
  return {
    schemaVersion: '1.0',
    editId: editId ?? 'main',
    updatedAt: new Date(0).toISOString(),
    records: [],
  };
}

function sanitizeEditFlowRunRecordForCurrent(record: IEditFlowStepRunRecord): IEditFlowStepRunRecord {
  if (record.capabilityId !== 'timeline.generate') return record;
  const externalizedArrays: string[] = [];
  const summary = sanitizeTimelineGenerateSummary(record.summary, externalizedArrays);
  return ZEditFlowStepRunRecord.parse({
    ...record,
    summary: externalizedArrays.length > 0
      ? {
        ...summary,
        runRecordSummaryPolicy: {
          summaryOnly: true,
          externalizedArrays,
        },
      }
      : summary,
  });
}

function sanitizeTimelineGenerateSummary(
  value: Record<string, unknown>,
  externalizedArrays: string[],
): Record<string, unknown> {
  const sanitized = sanitizeTimelineSummaryValue(value, [], externalizedArrays);
  return isPlainObject(sanitized) ? sanitized : {};
}

function sanitizeTimelineSummaryValue(
  value: unknown,
  path: string[],
  externalizedArrays: string[],
): unknown {
  if (Array.isArray(value)) {
    return value.map((item, index) => sanitizeTimelineSummaryValue(item, [...path, String(index)], externalizedArrays));
  }
  if (!isPlainObject(value)) return value;

  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (Array.isArray(entry) && shouldExternalizeTimelineRunArray(key, entry)) {
      const fieldPath = [...path, key].join('.');
      output[`${key}Externalized`] = true;
      output[`${key}ExternalizedCount`] = entry.length;
      output[`${key}ExternalizedReason`] = 'runs/current.json stores summary-only timeline.generate records; full clip-level audit and subtitle text belong in timeline artifacts.';
      externalizedArrays.push(`${fieldPath || key}:${entry.length}`);
      continue;
    }
    output[key] = sanitizeTimelineSummaryValue(entry, [...path, key], externalizedArrays);
  }
  return output;
}

function shouldExternalizeTimelineRunArray(key: string, value: unknown[]): boolean {
  const normalized = key.toLowerCase();
  return normalized === 'clips'
    || normalized.endsWith('clips')
    || (normalized.includes('clip') && value.length > 20)
    || normalized === 'subtitles'
    || normalized.endsWith('subtitles')
    || normalized.includes('subtitlecue')
    || normalized === 'cues'
    || value.length > 100;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
