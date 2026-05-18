import { mkdir, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { IEditFlowPlan, IEditFlowStepRunRecord } from '../protocol/schema.js';
import {
  IEditFlowPlan as ZEditFlowPlan,
  IEditFlowStepRunRecord as ZEditFlowStepRunRecord,
} from '../protocol/schema.js';
import { getProjectEditPlanningRoot, getProjectEditRoot, normalizeEditId, shouldReadLegacyEditPath } from './edit-store.js';
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

export function getEditFlowRunRoot(projectRoot: string, runId: string, editId?: string | null): string {
  return join(getEditFlowRunsRoot(projectRoot, editId), runId);
}

export function getEditFlowTempRunRoot(projectRoot: string, runId: string, editId?: string | null): string {
  return join(projectRoot, '.tmp', 'edit-flow', normalizeEditId(editId), 'runs', runId);
}

export function getEditFlowRunRecordPath(projectRoot: string, runId: string, editId?: string | null): string {
  return join(getEditFlowRunRoot(projectRoot, runId, editId), 'record.json');
}

export function getEditPlanningAgentPacketsRoot(projectRoot: string, editId?: string | null): string {
  return join(projectRoot, '.tmp', 'edit-flow', normalizeEditId(editId), 'planning', 'agent-packets');
}

export function getEditPlanningAgentPacketPath(
  projectRoot: string,
  stage: string,
  editId?: string | null,
): string {
  return join(getEditPlanningAgentPacketsRoot(projectRoot, editId), `${stage}.json`);
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
  return readJsonOrNull(
    getEditFlowRunRecordPath(projectRoot, runId, editId),
    ZEditFlowStepRunRecord,
  ) as Promise<IEditFlowStepRunRecord | null>;
}

export async function writeEditFlowRunRecord(
  projectRoot: string,
  record: IEditFlowStepRunRecord,
  editId?: string | null,
): Promise<void> {
  const target = getEditFlowRunRecordPath(projectRoot, record.runId, editId);
  await mkdir(dirname(target), { recursive: true });
  await writeJson(target, ZEditFlowStepRunRecord.parse(record));
}

export async function loadEditFlowRunRecords(
  projectRoot: string,
  editId?: string | null,
): Promise<IEditFlowStepRunRecord[]> {
  const root = getEditFlowRunsRoot(projectRoot, editId);
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const records = await Promise.all(entries
    .filter(entry => entry.isDirectory())
    .map(entry => loadEditFlowRunRecord(projectRoot, entry.name, editId)));
  return records
    .filter((record): record is IEditFlowStepRunRecord => record != null)
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
