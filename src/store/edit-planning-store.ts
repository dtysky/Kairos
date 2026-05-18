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
  const parsedRecord = ZEditFlowStepRunRecord.parse(record);
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
