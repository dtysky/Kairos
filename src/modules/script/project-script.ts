import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  IBeatPacket,
  IProjectArrangementPacket,
  IArrangementSegment,
  IStyleProfile,
  IKtepScript,
  ISegmentPacket,
} from '../../protocol/schema.js';
import type { ILlmClient } from '../llm/client.js';
import {
  getArrangementSkeletonsPath,
  getCurrentArrangementPath,
  getOutlinePath,
  getOutlinePromptPath,
  getScriptBriefPath,
  getSegmentCardsPath,
  loadScriptBriefConfig,
  saveScriptBriefConfig,
  writeCurrentScript,
  writeJson,
  writeOutline,
} from '../../store/index.js';
import {
  prepareScriptArrangement,
  type IArrangementReviewDraft,
} from './arrangement-preparation.js';
import {
  buildOutlineFromPackets,
  type IOutlineSegment,
} from './outline-builder.js';
import {
  buildBeatPackets,
  buildProjectArrangementPacket,
  buildSegmentPacket,
} from './packet-builder.js';
import { generateScript, buildOutlinePrompt } from './script-generator.js';
import { loadStyleByCategory } from './style-loader.js';

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

export interface IPrepareProjectScriptForAgentInput {
  projectRoot: string;
  workspaceRoot?: string;
  styleCategory?: string;
}

export interface IPrepareProjectScriptForAgentResult {
  projectId: string;
  projectName: string;
  styleCategory: string;
  arrangementPath: string;
  skeletonsPath: string;
  segmentCardsPath: string;
  scriptBriefPath: string;
  status: 'awaiting_agent';
  message: string;
}

interface IPreparedScriptArtifacts {
  outline: IOutlineSegment[];
  projectPacket: IProjectArrangementPacket;
  segmentPackets: ISegmentPacket[];
  beatPacketsBySegmentCardId: Record<string, IBeatPacket[]>;
  projectId: string;
  projectName: string;
  reviewDraft: IArrangementReviewDraft;
}

export async function buildProjectOutlineFromPlanning(
  input: IBuildProjectOutlineInput,
): Promise<IBuildProjectOutlineResult> {
  const style = await resolveStyle(input.projectRoot, input.workspaceRoot, input.styleCategory);
  const scriptBriefConfig = await loadScriptBriefConfig(input.projectRoot);
  const prepared = await prepareArrangementPacketsAndOutline({
    projectRoot: input.projectRoot,
    style,
    projectGoal: resolveProjectGoalFromBrief(scriptBriefConfig.goalDraft),
    hardConstraints: resolveHardConstraintsFromBrief(scriptBriefConfig.constraintDraft, style),
  });

  await writeOutline(input.projectRoot, prepared.outline);
  await writeFile(getOutlinePromptPath(input.projectRoot), buildOutlinePrompt(prepared.outline), 'utf-8');

  return { outline: prepared.outline };
}

export async function prepareProjectScriptForAgent(
  input: IPrepareProjectScriptForAgentInput,
): Promise<IPrepareProjectScriptForAgentResult> {
  const scriptBriefConfig = await loadScriptBriefConfig(input.projectRoot);
  const styleCategory = input.styleCategory ?? scriptBriefConfig.styleCategory;
  if (!styleCategory) {
    throw new Error('script prep requires styleCategory');
  }
  if (!input.workspaceRoot) {
    throw new Error('script prep requires workspaceRoot to resolve style profile');
  }
  if (scriptBriefConfig.workflowState !== 'ready_to_prepare') {
    throw new Error('script prep requires script-brief.workflowState=ready_to_prepare');
  }

  const style = await loadStyleByCategory(`${input.workspaceRoot}/config/styles`, styleCategory);
  if (!style) {
    throw new Error(`style profile not found for category "${styleCategory}"`);
  }

  const prepared = await prepareArrangementPacketsAndOutline({
    projectRoot: input.projectRoot,
    style,
    projectGoal: resolveProjectGoalFromBrief(scriptBriefConfig.goalDraft),
    hardConstraints: resolveHardConstraintsFromBrief(scriptBriefConfig.constraintDraft, style),
  });

  await saveScriptBriefConfig(input.projectRoot, {
    ...scriptBriefConfig,
    projectName: scriptBriefConfig.projectName?.trim() || prepared.projectName,
    styleCategory,
    workflowState: 'ready_for_agent',
    goalDraft: prepared.reviewDraft.goalDraft,
    constraintDraft: prepared.reviewDraft.constraintDraft,
    planReviewDraft: prepared.reviewDraft.planReviewDraft,
    segments: prepared.reviewDraft.segments.map(segment => ({
      ...segment,
      preferredClipTypes: segment.preferredClipTypes ?? [],
      preferredPlaceHints: segment.preferredPlaceHints ?? [],
      notes: segment.notes ?? [],
    })),
  });

  return {
    projectId: prepared.projectId,
    projectName: prepared.projectName,
    styleCategory,
    arrangementPath: getCurrentArrangementPath(input.projectRoot),
    skeletonsPath: getArrangementSkeletonsPath(input.projectRoot),
    segmentCardsPath: getSegmentCardsPath(input.projectRoot),
    scriptBriefPath: getScriptBriefPath(input.projectRoot),
    status: 'awaiting_agent',
    message: 'Arrangement synthesis completed. Review arrangement.current.json, arrangement-skeletons.json, and segment-cards.json before authoring script/current.json.',
  };
}

export async function generateProjectScriptFromPlanning(
  input: IGenerateProjectScriptInput,
): Promise<IKtepScript[]> {
  const scriptBriefConfig = await loadScriptBriefConfig(input.projectRoot);
  const prepared = await prepareArrangementPacketsAndOutline({
    projectRoot: input.projectRoot,
    style: input.style,
    projectGoal: resolveProjectGoalFromBrief(scriptBriefConfig.goalDraft),
    hardConstraints: resolveHardConstraintsFromBrief(scriptBriefConfig.constraintDraft, input.style),
  });
  await writeOutline(input.projectRoot, prepared.outline);
  await writeFile(getOutlinePromptPath(input.projectRoot), buildOutlinePrompt(prepared.outline), 'utf-8');

  const script = await generateScript(input.llm, prepared.outline, input.style);
  await writeCurrentScript(input.projectRoot, script);
  return script;
}

export async function loadProjectStyleByCategory(
  workspaceRoot: string,
  category: string,
): Promise<IStyleProfile | null> {
  return loadStyleByCategory(`${workspaceRoot}/config/styles`, category);
}

async function prepareArrangementPacketsAndOutline(input: {
  projectRoot: string;
  style: IStyleProfile;
  projectGoal?: string;
  hardConstraints?: string[];
}): Promise<IPreparedScriptArtifacts> {
  const prepared = await prepareScriptArrangement({
    projectRoot: input.projectRoot,
    style: input.style,
    projectGoal: input.projectGoal,
    hardConstraints: input.hardConstraints,
  });
  const orderedCards = orderCards(prepared.cards, prepared.current.segmentCardIds);
  const projectPacket = buildProjectArrangementPacket({
    projectGoal: prepared.projectGoal,
    skeletons: prepared.skeletons,
    segmentCards: orderedCards,
    bundles: prepared.bundles,
    style: prepared.style,
    hardConstraints: prepared.hardConstraints,
  });
  const segmentPackets = orderedCards.map(card => buildSegmentPacket({
    segmentCard: card,
    bundles: prepared.bundles,
    slices: prepared.slices,
    style: prepared.style,
  }));
  const beatPacketsBySegmentCardId = Object.fromEntries(
    segmentPackets.map(packet => {
      const segmentCard = packet.segmentCard ?? packet.arrangementSegment;
      if (!segmentCard) {
        throw new Error('segment packet missing segmentCard/arrangementSegment');
      }
      return [
      segmentCard.id,
      buildBeatPackets({
        segmentPacket: packet,
        style: prepared.style,
      }),
    ];
    }),
  );

  const outline = buildOutlineFromPackets({
    current: prepared.current,
    segmentPackets,
    beatPacketsBySegmentCardId,
    slices: prepared.slices,
  });

  await writePacketSnapshots(input.projectRoot, {
    projectPacket,
    segmentPackets,
    beatPacketsBySegmentCardId,
  });

  return {
    outline,
    projectPacket,
    segmentPackets,
    beatPacketsBySegmentCardId,
    projectId: prepared.project.id,
    projectName: prepared.project.name,
    reviewDraft: prepared.reviewDraft,
  };
}

function resolveProjectGoalFromBrief(goalDraft: string[] | undefined): string | undefined {
  const lines = (goalDraft ?? []).map(line => line.trim()).filter(Boolean);
  return lines.length > 0 ? lines.join(' / ') : undefined;
}

function resolveHardConstraintsFromBrief(
  constraintDraft: string[] | undefined,
  style: IStyleProfile,
): string[] {
  return dedupeStrings([
    ...(constraintDraft ?? []),
    ...(style.globalConstraints ?? []),
    ...(style.antiPatterns ?? []),
  ]);
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))];
}

async function resolveStyle(
  projectRoot: string,
  workspaceRoot?: string,
  styleCategory?: string,
): Promise<IStyleProfile> {
  if (!workspaceRoot) {
    throw new Error('workspaceRoot is required to resolve style profile');
  }
  const scriptBriefConfig = await loadScriptBriefConfig(projectRoot);
  const resolvedCategory = styleCategory ?? scriptBriefConfig.styleCategory;
  if (!resolvedCategory) {
    throw new Error('script prep requires styleCategory');
  }
  const style = await loadStyleByCategory(`${workspaceRoot}/config/styles`, resolvedCategory);
  if (!style) {
    throw new Error(`style profile not found for category "${resolvedCategory}"`);
  }
  return style;
}

async function writePacketSnapshots(
  projectRoot: string,
  input: {
    projectPacket: IProjectArrangementPacket;
    segmentPackets: ISegmentPacket[];
    beatPacketsBySegmentCardId: Record<string, IBeatPacket[]>;
  },
): Promise<void> {
  const root = join(projectRoot, '.tmp', 'script-packets');
  await Promise.all([
    writeJson(join(root, 'project-arrangement.packet.json'), input.projectPacket),
    writeJson(join(root, 'segment-packets.json'), input.segmentPackets),
    writeJson(join(root, 'beat-packets.json'), input.beatPacketsBySegmentCardId),
  ]);
}

function orderCards(
  cards: IArrangementSegment[],
  orderedIds: string[],
): IArrangementSegment[] {
  const cardMap = new Map(cards.map(card => [card.id, card]));
  const ordered = orderedIds
    .map(cardId => cardMap.get(cardId))
    .filter((card): card is IArrangementSegment => Boolean(card));
  const seen = new Set(ordered.map(card => card.id));
  for (const card of cards) {
    if (!seen.has(card.id)) ordered.push(card);
  }
  return ordered;
}
