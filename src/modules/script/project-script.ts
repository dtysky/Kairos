import { writeFile } from 'node:fs/promises';
import type { IStyleProfile, IKtepScript } from '../../protocol/schema.js';
import type { ILlmClient } from '../llm/client.js';
import {
  loadApprovedSegmentPlan,
  loadSegmentCandidates,
  writeOutline,
  writeCurrentScript,
  getOutlinePromptPath,
} from '../../store/index.js';
import { loadStyleByCategory } from './style-loader.js';
import { prepareSegmentPlanning } from './segment-planner.js';
import { approveSegmentPlan, recallSegmentCandidates } from './candidate-recall.js';
import { buildOutlineFromApprovedPlan, type IOutlineSegment } from './outline-builder.js';
import { buildOutlinePrompt, generateScript } from './script-generator.js';

export interface IBuildProjectOutlineInput {
  projectRoot: string;
  workspaceRoot?: string;
  styleCategory?: string;
  planningLlm?: ILlmClient;
}

export interface IBuildProjectOutlineResult {
  outline: IOutlineSegment[];
}

export interface IGenerateProjectScriptInput {
  projectRoot: string;
  llm: ILlmClient;
  style: IStyleProfile;
  workspaceRoot?: string;
  styleCategory?: string;
  planningLlm?: ILlmClient;
}

export async function buildProjectOutlineFromPlanning(
  input: IBuildProjectOutlineInput,
): Promise<IBuildProjectOutlineResult> {
  await prepareSegmentPlanning({
    projectRoot: input.projectRoot,
    workspaceRoot: input.workspaceRoot,
    styleCategory: input.styleCategory,
    llm: input.planningLlm,
  });
  const approvedPlan = await loadApprovedSegmentPlan(input.projectRoot)
    ?? await approveSegmentPlan({ projectRoot: input.projectRoot });
  const recall = await loadSegmentCandidates(input.projectRoot)
    ?? await recallSegmentCandidates({ projectRoot: input.projectRoot });

  const outline = buildOutlineFromApprovedPlan(approvedPlan, recall);
  await writeOutline(input.projectRoot, outline);
  await writeFile(getOutlinePromptPath(input.projectRoot), buildOutlinePrompt(outline), 'utf-8');

  return { outline };
}

export async function generateProjectScriptFromPlanning(
  input: IGenerateProjectScriptInput,
): Promise<IKtepScript[]> {
  const { outline } = await buildProjectOutlineFromPlanning({
    projectRoot: input.projectRoot,
    workspaceRoot: input.workspaceRoot,
    styleCategory: input.styleCategory,
    planningLlm: input.planningLlm ?? input.llm,
  });
  const script = await generateScript(input.llm, outline, input.style);
  await writeCurrentScript(input.projectRoot, script);
  return script;
}

export async function loadProjectStyleByCategory(
  workspaceRoot: string,
  category: string,
): Promise<IStyleProfile | null> {
  return loadStyleByCategory(`${workspaceRoot}/config/styles`, category);
}
