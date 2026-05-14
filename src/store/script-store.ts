import { join } from 'node:path';
import { z } from 'zod';
import type {
  IAgentContract,
  IAgentPacket,
  IAgentPipelineState,
  IKtepScript,
  IMaterialBundle,
  IMaterialSlotsDocument,
  IProjectMaterialOverviewFacts,
  ISpatialStoryContext,
  IStageReview,
  ISegmentPlan,
} from '../protocol/schema.js';
import {
  IAgentContract as ZAgentContract,
  IAgentPacket as ZAgentPacket,
  IAgentPipelineState as ZAgentPipelineState,
  IKtepScript as ZKtepScript,
  IMaterialBundle as ZMaterialBundle,
  IMaterialSlotsDocument as ZMaterialSlotsDocument,
  IProjectMaterialOverviewFacts as ZProjectMaterialOverviewFacts,
  ISpatialStoryContext as ZSpatialStoryContext,
  IStageReview as ZStageReview,
  ISegmentPlan as ZSegmentPlan,
} from '../protocol/schema.js';
import type { IOutlineSegment } from '../modules/script/outline-builder.js';
import {
  getLegacyScriptRoot,
  getProjectEditScriptRoot,
  getProjectEditTimelineRoot,
  getProjectEditPlanningRoot,
  shouldReadLegacyEditPath,
} from './edit-store.js';
import { readJsonOrNull, writeJson } from './writer.js';

const IOutlineFile = z.array(z.any());
const IScriptFile = z.array(ZKtepScript);
const IMaterialBundleFile = z.array(ZMaterialBundle);

export function getMaterialOverviewFactsPath(projectRoot: string, editId?: string | null): string {
  return join(getProjectEditScriptRoot(projectRoot, editId), 'material-overview.facts.json');
}

export function getMaterialOverviewPath(projectRoot: string, editId?: string | null): string {
  return join(getProjectEditScriptRoot(projectRoot, editId), 'material-overview.md');
}

export function getMaterialBundlesPath(projectRoot: string): string {
  return join(projectRoot, 'analysis', 'material-bundles.json');
}

export function getSegmentPlanPath(projectRoot: string, editId?: string | null): string {
  return join(getProjectEditScriptRoot(projectRoot, editId), 'segment-plan.json');
}

export function getMaterialSlotsPath(projectRoot: string, editId?: string | null): string {
  return join(getProjectEditScriptRoot(projectRoot, editId), 'material-slots.json');
}

export function getOutlinePath(projectRoot: string, editId?: string | null): string {
  return join(getProjectEditScriptRoot(projectRoot, editId), 'outline.json');
}

export function getOutlinePromptPath(projectRoot: string, editId?: string | null): string {
  return join(getProjectEditScriptRoot(projectRoot, editId), 'outline-prompt.txt');
}

export function getCurrentScriptPath(projectRoot: string, editId?: string | null): string {
  return join(getProjectEditScriptRoot(projectRoot, editId), 'current.json');
}

export function getSpatialStoryPath(projectRoot: string, editId?: string | null): string {
  return join(getProjectEditScriptRoot(projectRoot, editId), 'spatial-story.json');
}

export function getSpatialStoryMarkdownPath(projectRoot: string, editId?: string | null): string {
  return join(getProjectEditScriptRoot(projectRoot, editId), 'spatial-story.md');
}

export function getScriptAgentContractPath(projectRoot: string, editId?: string | null): string {
  return join(getProjectEditScriptRoot(projectRoot, editId), 'agent-contract.json');
}

export function getScriptAgentPipelinePath(projectRoot: string, editId?: string | null): string {
  return join(getProjectEditScriptRoot(projectRoot, editId), 'agent-pipeline.json');
}

export function getScriptAgentPacketsRoot(projectRoot: string, editId?: string | null): string {
  return join(getProjectEditScriptRoot(projectRoot, editId), 'agent-packets');
}

export function getScriptAgentPacketPath(projectRoot: string, stage: string, editId?: string | null): string {
  return join(getScriptAgentPacketsRoot(projectRoot, editId), `${stage}.json`);
}

export function getScriptReviewsRoot(projectRoot: string, editId?: string | null): string {
  return join(getProjectEditScriptRoot(projectRoot, editId), 'reviews');
}

export function getScriptReviewPath(projectRoot: string, stage: string, editId?: string | null): string {
  return join(getScriptReviewsRoot(projectRoot, editId), `${stage}.json`);
}

export function getLockedRoughCutPath(projectRoot: string, editId?: string | null): string {
  return join(getProjectEditTimelineRoot(projectRoot, editId), 'locked-rough-cut.json');
}

function getLegacyScriptPath(projectRoot: string, fileName: string): string {
  return join(getLegacyScriptRoot(projectRoot), fileName);
}

async function readEditJsonOrLegacy<T>(
  projectRoot: string,
  editId: string | null | undefined,
  primaryPath: string,
  legacyPath: string,
  schema: z.ZodTypeAny,
): Promise<T | null> {
  const primary = await readJsonOrNull(primaryPath, schema) as T | null;
  if (primary || !shouldReadLegacyEditPath(editId)) return primary;
  return readJsonOrNull(legacyPath, schema) as Promise<T | null>;
}

export async function clearScriptArtifactsForStyleChange(
  projectRoot: string,
  editId?: string | null,
): Promise<void> {
  const { rm } = await import('node:fs/promises');
  const scriptRoot = getProjectEditScriptRoot(projectRoot, editId);
  const timelineRoot = getProjectEditTimelineRoot(projectRoot, editId);
  const planningRoot = getProjectEditPlanningRoot(projectRoot, editId);
  await Promise.all([
    rm(planningRoot, { recursive: true, force: true }),
    rm(getMaterialOverviewFactsPath(projectRoot, editId), { force: true }),
    rm(getMaterialOverviewPath(projectRoot, editId), { force: true }),
    rm(getMaterialBundlesPath(projectRoot), { force: true }),
    rm(join(projectRoot, 'analysis', 'material-digest.json'), { force: true }),
    rm(join(projectRoot, 'analysis', 'motif-bundles.json'), { force: true }),
    rm(getSegmentPlanPath(projectRoot, editId), { force: true }),
    rm(join(scriptRoot, 'segment-plan.drafts.json'), { force: true }),
    rm(join(scriptRoot, 'segment-plan.approved.json'), { force: true }),
    rm(getMaterialSlotsPath(projectRoot, editId), { force: true }),
    rm(join(scriptRoot, 'segment-candidates.json'), { force: true }),
    rm(join(scriptRoot, 'arrangement-skeletons.json'), { force: true }),
    rm(join(scriptRoot, 'segment-cards.json'), { force: true }),
    rm(join(scriptRoot, 'arrangement.current.json'), { force: true }),
    rm(getSpatialStoryPath(projectRoot, editId), { force: true }),
    rm(getSpatialStoryMarkdownPath(projectRoot, editId), { force: true }),
    rm(getScriptAgentContractPath(projectRoot, editId), { force: true }),
    rm(getScriptAgentPipelinePath(projectRoot, editId), { force: true }),
    rm(getScriptAgentPacketsRoot(projectRoot, editId), { recursive: true, force: true }),
    rm(getScriptReviewsRoot(projectRoot, editId), { recursive: true, force: true }),
    rm(getOutlinePath(projectRoot, editId), { force: true }),
    rm(getOutlinePromptPath(projectRoot, editId), { force: true }),
    rm(getCurrentScriptPath(projectRoot, editId), { force: true }),
    rm(join(timelineRoot, 'rough-cut-base.json'), { force: true }),
    rm(join(timelineRoot, 'segment-cuts'), { recursive: true, force: true }),
    rm(join(timelineRoot, 'agent-packets'), { recursive: true, force: true }),
    rm(join(timelineRoot, 'reviews'), { recursive: true, force: true }),
    rm(join(timelineRoot, 'agent-pipeline.json'), { force: true }),
    rm(join(timelineRoot, 'current.json'), { force: true }),
    rm(join(timelineRoot, 'locked-rough-cut.json'), { force: true }),
  ]);
}

export async function loadMaterialOverviewFacts(
  projectRoot: string,
  editId?: string | null,
): Promise<IProjectMaterialOverviewFacts | null> {
  return readEditJsonOrLegacy(
    projectRoot,
    editId,
    getMaterialOverviewFactsPath(projectRoot, editId),
    getLegacyScriptPath(projectRoot, 'material-overview.facts.json'),
    ZProjectMaterialOverviewFacts,
  );
}

export async function writeMaterialOverviewFacts(
  projectRoot: string,
  facts: IProjectMaterialOverviewFacts,
  editId?: string | null,
): Promise<void> {
  await writeJson(getMaterialOverviewFactsPath(projectRoot, editId), facts);
}

export async function loadMaterialBundles(
  projectRoot: string,
): Promise<IMaterialBundle[]> {
  return (await readJsonOrNull(
    getMaterialBundlesPath(projectRoot),
    IMaterialBundleFile,
  ) as IMaterialBundle[] | null) ?? [];
}

export async function writeMaterialBundles(
  projectRoot: string,
  bundles: IMaterialBundle[],
): Promise<void> {
  await writeJson(getMaterialBundlesPath(projectRoot), bundles);
}

export async function loadSegmentPlan(
  projectRoot: string,
  editId?: string | null,
): Promise<ISegmentPlan | null> {
  return readEditJsonOrLegacy(
    projectRoot,
    editId,
    getSegmentPlanPath(projectRoot, editId),
    getLegacyScriptPath(projectRoot, 'segment-plan.json'),
    ZSegmentPlan,
  );
}

export async function writeSegmentPlan(
  projectRoot: string,
  plan: ISegmentPlan,
  editId?: string | null,
): Promise<void> {
  await writeJson(getSegmentPlanPath(projectRoot, editId), plan);
}

export async function loadMaterialSlots(
  projectRoot: string,
  editId?: string | null,
): Promise<IMaterialSlotsDocument | null> {
  return readEditJsonOrLegacy(
    projectRoot,
    editId,
    getMaterialSlotsPath(projectRoot, editId),
    getLegacyScriptPath(projectRoot, 'material-slots.json'),
    ZMaterialSlotsDocument,
  );
}

export async function writeMaterialSlots(
  projectRoot: string,
  slots: IMaterialSlotsDocument,
  editId?: string | null,
): Promise<void> {
  await writeJson(getMaterialSlotsPath(projectRoot, editId), slots);
}

export async function loadOutline(
  projectRoot: string,
  editId?: string | null,
): Promise<IOutlineSegment[] | null> {
  return readEditJsonOrLegacy(
    projectRoot,
    editId,
    getOutlinePath(projectRoot, editId),
    join(projectRoot, 'analysis', 'outline.json'),
    IOutlineFile,
  ) as Promise<IOutlineSegment[] | null>;
}

export async function writeOutline(
  projectRoot: string,
  outline: IOutlineSegment[],
  editId?: string | null,
): Promise<void> {
  await writeJson(getOutlinePath(projectRoot, editId), outline);
}

export async function loadCurrentScript(
  projectRoot: string,
  editId?: string | null,
): Promise<IKtepScript[] | null> {
  return readEditJsonOrLegacy(
    projectRoot,
    editId,
    getCurrentScriptPath(projectRoot, editId),
    getLegacyScriptPath(projectRoot, 'current.json'),
    IScriptFile,
  ) as Promise<IKtepScript[] | null>;
}

export async function writeCurrentScript(
  projectRoot: string,
  script: IKtepScript[],
  editId?: string | null,
): Promise<void> {
  await writeJson(getCurrentScriptPath(projectRoot, editId), script);
}

export async function loadSpatialStory(
  projectRoot: string,
  editId?: string | null,
): Promise<ISpatialStoryContext | null> {
  return readEditJsonOrLegacy(
    projectRoot,
    editId,
    getSpatialStoryPath(projectRoot, editId),
    getLegacyScriptPath(projectRoot, 'spatial-story.json'),
    ZSpatialStoryContext,
  );
}

export async function writeSpatialStory(
  projectRoot: string,
  spatialStory: ISpatialStoryContext,
  editId?: string | null,
): Promise<void> {
  await writeJson(getSpatialStoryPath(projectRoot, editId), spatialStory);
}

export async function loadScriptAgentContract(
  projectRoot: string,
  editId?: string | null,
): Promise<IAgentContract | null> {
  return readEditJsonOrLegacy(
    projectRoot,
    editId,
    getScriptAgentContractPath(projectRoot, editId),
    getLegacyScriptPath(projectRoot, 'agent-contract.json'),
    ZAgentContract,
  );
}

export async function writeScriptAgentContract(
  projectRoot: string,
  contract: IAgentContract,
  editId?: string | null,
): Promise<void> {
  await writeJson(getScriptAgentContractPath(projectRoot, editId), contract);
}

export async function loadScriptAgentPipeline(
  projectRoot: string,
  editId?: string | null,
): Promise<IAgentPipelineState | null> {
  return readEditJsonOrLegacy(
    projectRoot,
    editId,
    getScriptAgentPipelinePath(projectRoot, editId),
    getLegacyScriptPath(projectRoot, 'agent-pipeline.json'),
    ZAgentPipelineState,
  );
}

export async function writeScriptAgentPipeline(
  projectRoot: string,
  pipeline: IAgentPipelineState,
  editId?: string | null,
): Promise<void> {
  await writeJson(getScriptAgentPipelinePath(projectRoot, editId), pipeline);
}

export async function loadScriptAgentPacket(
  projectRoot: string,
  stage: string,
  editId?: string | null,
): Promise<IAgentPacket | null> {
  return readEditJsonOrLegacy(
    projectRoot,
    editId,
    getScriptAgentPacketPath(projectRoot, stage, editId),
    join(getLegacyScriptRoot(projectRoot), 'agent-packets', `${stage}.json`),
    ZAgentPacket,
  );
}

export async function writeScriptAgentPacket(
  projectRoot: string,
  stage: string,
  packet: IAgentPacket,
  editId?: string | null,
): Promise<void> {
  await writeJson(getScriptAgentPacketPath(projectRoot, stage, editId), packet);
}

export async function loadScriptStageReview(
  projectRoot: string,
  stage: string,
  editId?: string | null,
): Promise<IStageReview | null> {
  return readEditJsonOrLegacy(
    projectRoot,
    editId,
    getScriptReviewPath(projectRoot, stage, editId),
    join(getLegacyScriptRoot(projectRoot), 'reviews', `${stage}.json`),
    ZStageReview,
  );
}

export async function writeScriptStageReview(
  projectRoot: string,
  stage: string,
  review: IStageReview,
  editId?: string | null,
): Promise<void> {
  await writeJson(getScriptReviewPath(projectRoot, stage, editId), review);
}
