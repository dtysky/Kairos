import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { IEditFlowPlan } from '../protocol/schema.js';
import { IEditFlowPlan as ZEditFlowPlan } from '../protocol/schema.js';
import { getProjectEditPlanningRoot, shouldReadLegacyEditPath } from './edit-store.js';
import { readJsonOrNull, writeJson } from './writer.js';

export function getEditFlowPlanPath(projectRoot: string, editId?: string | null): string {
  return join(getProjectEditPlanningRoot(projectRoot, editId), 'flow-plan.json');
}

export function getEditPlanningArtifactPath(
  projectRoot: string,
  artifactName: 'event-table.md' | 'material-archive.md' | 'edit-framework.md',
  editId?: string | null,
): string {
  return join(getProjectEditPlanningRoot(projectRoot, editId), artifactName);
}

export function getEditPlanningAgentPacketsRoot(projectRoot: string, editId?: string | null): string {
  return join(getProjectEditPlanningRoot(projectRoot, editId), 'agent-packets');
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
  const primary = await readJsonOrNull(getEditFlowPlanPath(projectRoot, editId), ZEditFlowPlan);
  if (primary || !shouldReadLegacyEditPath(editId)) return primary;
  return readJsonOrNull(join(projectRoot, 'planning', 'flow-plan.json'), ZEditFlowPlan);
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
