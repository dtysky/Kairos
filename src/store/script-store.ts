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
import { readJsonOrNull, writeJson } from './writer.js';

const IOutlineFile = z.array(z.any());
const IScriptFile = z.array(ZKtepScript);
const IMaterialBundleFile = z.array(ZMaterialBundle);

export function getMaterialOverviewFactsPath(projectRoot: string): string {
  return join(projectRoot, 'script', 'material-overview.facts.json');
}

export function getMaterialOverviewPath(projectRoot: string): string {
  return join(projectRoot, 'script', 'material-overview.md');
}

export function getMaterialBundlesPath(projectRoot: string): string {
  return join(projectRoot, 'analysis', 'material-bundles.json');
}

export function getSegmentPlanPath(projectRoot: string): string {
  return join(projectRoot, 'script', 'segment-plan.json');
}

export function getMaterialSlotsPath(projectRoot: string): string {
  return join(projectRoot, 'script', 'material-slots.json');
}

export function getOutlinePath(projectRoot: string): string {
  return join(projectRoot, 'analysis', 'outline.json');
}

export function getOutlinePromptPath(projectRoot: string): string {
  return join(projectRoot, 'analysis', 'outline-prompt.txt');
}

export function getCurrentScriptPath(projectRoot: string): string {
  return join(projectRoot, 'script', 'current.json');
}

export function getSpatialStoryPath(projectRoot: string): string {
  return join(projectRoot, 'script', 'spatial-story.json');
}

export function getSpatialStoryMarkdownPath(projectRoot: string): string {
  return join(projectRoot, 'script', 'spatial-story.md');
}

export function getScriptAgentContractPath(projectRoot: string): string {
  return join(projectRoot, 'script', 'agent-contract.json');
}

export function getScriptAgentPipelinePath(projectRoot: string): string {
  return join(projectRoot, 'script', 'agent-pipeline.json');
}

export function getScriptAgentPacketsRoot(projectRoot: string): string {
  return join(projectRoot, 'script', 'agent-packets');
}

export function getScriptAgentPacketPath(projectRoot: string, stage: string): string {
  return join(getScriptAgentPacketsRoot(projectRoot), `${stage}.json`);
}

export function getScriptReviewsRoot(projectRoot: string): string {
  return join(projectRoot, 'script', 'reviews');
}

export function getScriptReviewPath(projectRoot: string, stage: string): string {
  return join(getScriptReviewsRoot(projectRoot), `${stage}.json`);
}

export async function clearScriptArtifactsForStyleChange(projectRoot: string): Promise<void> {
  const { rm } = await import('node:fs/promises');
  await Promise.all([
    rm(getMaterialOverviewFactsPath(projectRoot), { force: true }),
    rm(getMaterialOverviewPath(projectRoot), { force: true }),
    rm(getMaterialBundlesPath(projectRoot), { force: true }),
    rm(join(projectRoot, 'analysis', 'material-digest.json'), { force: true }),
    rm(join(projectRoot, 'analysis', 'motif-bundles.json'), { force: true }),
    rm(getSegmentPlanPath(projectRoot), { force: true }),
    rm(join(projectRoot, 'script', 'segment-plan.drafts.json'), { force: true }),
    rm(join(projectRoot, 'script', 'segment-plan.approved.json'), { force: true }),
    rm(getMaterialSlotsPath(projectRoot), { force: true }),
    rm(join(projectRoot, 'script', 'segment-candidates.json'), { force: true }),
    rm(join(projectRoot, 'script', 'arrangement-skeletons.json'), { force: true }),
    rm(join(projectRoot, 'script', 'segment-cards.json'), { force: true }),
    rm(join(projectRoot, 'script', 'arrangement.current.json'), { force: true }),
    rm(getSpatialStoryPath(projectRoot), { force: true }),
    rm(getSpatialStoryMarkdownPath(projectRoot), { force: true }),
    rm(getScriptAgentContractPath(projectRoot), { force: true }),
    rm(getScriptAgentPipelinePath(projectRoot), { force: true }),
    rm(getScriptAgentPacketsRoot(projectRoot), { recursive: true, force: true }),
    rm(getScriptReviewsRoot(projectRoot), { recursive: true, force: true }),
    rm(getOutlinePath(projectRoot), { force: true }),
    rm(getOutlinePromptPath(projectRoot), { force: true }),
    rm(getCurrentScriptPath(projectRoot), { force: true }),
    rm(join(projectRoot, 'timeline', 'rough-cut-base.json'), { force: true }),
    rm(join(projectRoot, 'timeline', 'segment-cuts'), { recursive: true, force: true }),
    rm(join(projectRoot, 'timeline', 'agent-packets'), { recursive: true, force: true }),
    rm(join(projectRoot, 'timeline', 'reviews'), { recursive: true, force: true }),
    rm(join(projectRoot, 'timeline', 'agent-pipeline.json'), { force: true }),
    rm(join(projectRoot, 'timeline', 'current.json'), { force: true }),
  ]);
}

export async function loadMaterialOverviewFacts(
  projectRoot: string,
): Promise<IProjectMaterialOverviewFacts | null> {
  return readJsonOrNull(
    getMaterialOverviewFactsPath(projectRoot),
    ZProjectMaterialOverviewFacts,
  ) as Promise<IProjectMaterialOverviewFacts | null>;
}

export async function writeMaterialOverviewFacts(
  projectRoot: string,
  facts: IProjectMaterialOverviewFacts,
): Promise<void> {
  await writeJson(getMaterialOverviewFactsPath(projectRoot), facts);
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
): Promise<ISegmentPlan | null> {
  return readJsonOrNull(
    getSegmentPlanPath(projectRoot),
    ZSegmentPlan,
  ) as Promise<ISegmentPlan | null>;
}

export async function writeSegmentPlan(
  projectRoot: string,
  plan: ISegmentPlan,
): Promise<void> {
  await writeJson(getSegmentPlanPath(projectRoot), plan);
}

export async function loadMaterialSlots(
  projectRoot: string,
): Promise<IMaterialSlotsDocument | null> {
  return readJsonOrNull(
    getMaterialSlotsPath(projectRoot),
    ZMaterialSlotsDocument,
  ) as Promise<IMaterialSlotsDocument | null>;
}

export async function writeMaterialSlots(
  projectRoot: string,
  slots: IMaterialSlotsDocument,
): Promise<void> {
  await writeJson(getMaterialSlotsPath(projectRoot), slots);
}

export async function loadOutline(
  projectRoot: string,
): Promise<IOutlineSegment[] | null> {
  return readJsonOrNull(getOutlinePath(projectRoot), IOutlineFile) as Promise<IOutlineSegment[] | null>;
}

export async function writeOutline(
  projectRoot: string,
  outline: IOutlineSegment[],
): Promise<void> {
  await writeJson(getOutlinePath(projectRoot), outline);
}

export async function loadCurrentScript(
  projectRoot: string,
): Promise<IKtepScript[] | null> {
  return readJsonOrNull(getCurrentScriptPath(projectRoot), IScriptFile) as Promise<IKtepScript[] | null>;
}

export async function writeCurrentScript(
  projectRoot: string,
  script: IKtepScript[],
): Promise<void> {
  await writeJson(getCurrentScriptPath(projectRoot), script);
}

export async function loadSpatialStory(
  projectRoot: string,
): Promise<ISpatialStoryContext | null> {
  return readJsonOrNull(
    getSpatialStoryPath(projectRoot),
    ZSpatialStoryContext,
  ) as Promise<ISpatialStoryContext | null>;
}

export async function writeSpatialStory(
  projectRoot: string,
  spatialStory: ISpatialStoryContext,
): Promise<void> {
  await writeJson(getSpatialStoryPath(projectRoot), spatialStory);
}

export async function loadScriptAgentContract(
  projectRoot: string,
): Promise<IAgentContract | null> {
  return readJsonOrNull(
    getScriptAgentContractPath(projectRoot),
    ZAgentContract,
  ) as Promise<IAgentContract | null>;
}

export async function writeScriptAgentContract(
  projectRoot: string,
  contract: IAgentContract,
): Promise<void> {
  await writeJson(getScriptAgentContractPath(projectRoot), contract);
}

export async function loadScriptAgentPipeline(
  projectRoot: string,
): Promise<IAgentPipelineState | null> {
  return readJsonOrNull(
    getScriptAgentPipelinePath(projectRoot),
    ZAgentPipelineState,
  ) as Promise<IAgentPipelineState | null>;
}

export async function writeScriptAgentPipeline(
  projectRoot: string,
  pipeline: IAgentPipelineState,
): Promise<void> {
  await writeJson(getScriptAgentPipelinePath(projectRoot), pipeline);
}

export async function loadScriptAgentPacket(
  projectRoot: string,
  stage: string,
): Promise<IAgentPacket | null> {
  return readJsonOrNull(
    getScriptAgentPacketPath(projectRoot, stage),
    ZAgentPacket,
  ) as Promise<IAgentPacket | null>;
}

export async function writeScriptAgentPacket(
  projectRoot: string,
  stage: string,
  packet: IAgentPacket,
): Promise<void> {
  await writeJson(getScriptAgentPacketPath(projectRoot, stage), packet);
}

export async function loadScriptStageReview(
  projectRoot: string,
  stage: string,
): Promise<IStageReview | null> {
  return readJsonOrNull(
    getScriptReviewPath(projectRoot, stage),
    ZStageReview,
  ) as Promise<IStageReview | null>;
}

export async function writeScriptStageReview(
  projectRoot: string,
  stage: string,
  review: IStageReview,
): Promise<void> {
  await writeJson(getScriptReviewPath(projectRoot, stage), review);
}
