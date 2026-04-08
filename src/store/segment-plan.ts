import { join } from 'node:path';
import { z } from 'zod';
import {
  IApprovedSegmentPlan,
  ISegmentCandidateRecall,
  IProjectMaterialDigest,
  ISegmentPlanDraft,
} from '../protocol/schema.js';
import { readJsonOrNull, writeJson } from './writer.js';

const ISegmentPlanDraftFile = z.array(ISegmentPlanDraft);

export function getProjectMaterialDigestPath(projectRoot: string): string {
  return join(projectRoot, 'analysis', 'material-digest.json');
}

export function getSegmentPlanDraftsPath(projectRoot: string): string {
  return join(projectRoot, 'script', 'segment-plan.drafts.json');
}

export function getApprovedSegmentPlanPath(projectRoot: string): string {
  return join(projectRoot, 'script', 'segment-plan.approved.json');
}

export function getSegmentCandidatesPath(projectRoot: string): string {
  return join(projectRoot, 'script', 'segment-candidates.json');
}

export async function loadProjectMaterialDigest(
  projectRoot: string,
): Promise<IProjectMaterialDigest | null> {
  return readJsonOrNull(
    getProjectMaterialDigestPath(projectRoot),
    IProjectMaterialDigest,
  ) as Promise<IProjectMaterialDigest | null>;
}

export async function writeProjectMaterialDigest(
  projectRoot: string,
  digest: IProjectMaterialDigest,
): Promise<void> {
  await writeJson(getProjectMaterialDigestPath(projectRoot), digest);
}

export async function loadSegmentPlanDrafts(
  projectRoot: string,
): Promise<ISegmentPlanDraft[]> {
  return (await readJsonOrNull(
    getSegmentPlanDraftsPath(projectRoot),
    ISegmentPlanDraftFile,
  ) as ISegmentPlanDraft[] | null) ?? [];
}

export async function writeSegmentPlanDrafts(
  projectRoot: string,
  drafts: ISegmentPlanDraft[],
): Promise<void> {
  await writeJson(getSegmentPlanDraftsPath(projectRoot), drafts);
}

export async function loadApprovedSegmentPlan(
  projectRoot: string,
): Promise<IApprovedSegmentPlan | null> {
  return readJsonOrNull(
    getApprovedSegmentPlanPath(projectRoot),
    IApprovedSegmentPlan,
  ) as Promise<IApprovedSegmentPlan | null>;
}

export async function writeApprovedSegmentPlan(
  projectRoot: string,
  plan: IApprovedSegmentPlan,
): Promise<void> {
  await writeJson(getApprovedSegmentPlanPath(projectRoot), plan);
}

export async function loadSegmentCandidates(
  projectRoot: string,
): Promise<ISegmentCandidateRecall | null> {
  return readJsonOrNull(
    getSegmentCandidatesPath(projectRoot),
    ISegmentCandidateRecall,
  ) as Promise<ISegmentCandidateRecall | null>;
}

export async function writeSegmentCandidates(
  projectRoot: string,
  recall: ISegmentCandidateRecall,
): Promise<void> {
  await writeJson(getSegmentCandidatesPath(projectRoot), recall);
}
