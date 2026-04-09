import { join } from 'node:path';
import { z } from 'zod';
import type {
  IKtepScript,
  IMaterialBundle,
  IMaterialSlotsDocument,
  IProjectMaterialOverviewFacts,
  ISegmentPlan,
} from '../protocol/schema.js';
import {
  IMaterialBundle as ZMaterialBundle,
  IMaterialSlotsDocument as ZMaterialSlotsDocument,
  IProjectMaterialOverviewFacts as ZProjectMaterialOverviewFacts,
  ISegmentPlan as ZSegmentPlan,
} from '../protocol/schema.js';
import type { IOutlineSegment } from '../modules/script/outline-builder.js';
import { readJsonOrNull, writeJson } from './writer.js';

const IOutlineFile = z.array(z.any());
const IScriptFile = z.array(z.any());
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
