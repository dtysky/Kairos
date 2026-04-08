import type {
  IArrangementSkeleton,
  ICurrentArrangement,
  IKtepProject,
  IKtepSlice,
  IMotifBundle,
  ISegmentCard,
  IStyleProfile,
} from '../../protocol/schema.js';
import {
  loadProject,
  loadSlices,
  writeArrangementSkeletons,
  writeCurrentArrangement,
  writeMotifBundles,
  writeSegmentCards,
  type IScriptBriefSegmentTemplateInput,
} from '../../store/index.js';
import {
  synthesizeArrangement,
  type ISynthesizeArrangementResult,
} from './arrangement-synthesis.js';

export interface IPrepareScriptArrangementInput {
  projectRoot: string;
  style: IStyleProfile;
  projectGoal?: string;
  hardConstraints?: string[];
}

export interface IPrepareScriptArrangementResult {
  project: IKtepProject;
  style: IStyleProfile;
  slices: IKtepSlice[];
  projectGoal: string;
  hardConstraints: string[];
  bundles: IMotifBundle[];
  skeletons: IArrangementSkeleton[];
  cards: ISegmentCard[];
  current: ICurrentArrangement;
  reviewDraft: IArrangementReviewDraft;
}

export interface IArrangementReviewDraft {
  statusText: string;
  goalDraft: string[];
  constraintDraft: string[];
  planReviewDraft: string[];
  segments: IScriptBriefSegmentTemplateInput[];
}

export async function prepareScriptArrangement(
  input: IPrepareScriptArrangementInput,
): Promise<IPrepareScriptArrangementResult> {
  const [project, slices] = await Promise.all([
    loadProject(input.projectRoot),
    loadSlices(input.projectRoot),
  ]);

  const projectGoal = input.projectGoal?.trim() || resolveProjectGoal(project);
  const hardConstraints = input.hardConstraints?.length
    ? dedupeStrings(input.hardConstraints)
    : resolveHardConstraints(input.style);
  const synthesis = synthesizeArrangement({
    projectId: project.id,
    slices,
    style: input.style,
    projectGoal,
    hardConstraints,
  });

  await persistArrangementArtifacts(input.projectRoot, synthesis);
  const reviewDraft = buildArrangementReviewDraft({
    project,
    projectGoal,
    hardConstraints,
    synthesis,
  });

  return {
    project,
    style: input.style,
    slices,
    projectGoal,
    hardConstraints,
    bundles: synthesis.bundles,
    skeletons: synthesis.skeletons,
    cards: synthesis.cards,
    current: synthesis.current,
    reviewDraft,
  };
}

async function persistArrangementArtifacts(
  projectRoot: string,
  synthesis: ISynthesizeArrangementResult,
): Promise<void> {
  await Promise.all([
    writeMotifBundles(projectRoot, synthesis.bundles),
    writeArrangementSkeletons(projectRoot, synthesis.skeletons),
    writeSegmentCards(projectRoot, synthesis.cards),
    writeCurrentArrangement(projectRoot, synthesis.current),
  ]);
}

function buildArrangementReviewDraft(
  input: {
    project: IKtepProject;
    projectGoal: string;
    hardConstraints: string[];
    synthesis: ISynthesizeArrangementResult;
  },
): IArrangementReviewDraft {
  const skeleton = input.synthesis.skeletons.find(
    item => item.id === input.synthesis.current.chosenSkeletonId,
  ) ?? input.synthesis.skeletons[0];
  const orderedCards = orderCardsByCurrent(input.synthesis.cards, input.synthesis.current);
  const cardMap = new Map(orderedCards.map(card => [card.id, card]));

  return {
    statusText: '系统已基于新语义协议生成编排骨架，请先审查 skeleton / segment cards 后再继续。',
    goalDraft: [
      `当前全片目标：${input.projectGoal}`,
      skeleton?.narrativeSketch
        ? `当前骨架草图：${skeleton.narrativeSketch}`
        : '当前骨架草图：待补充',
      `当前主编排轴：${input.synthesis.current.strategy}`,
    ],
    constraintDraft: input.hardConstraints.length > 0
      ? input.hardConstraints.map(item => `约束：${item}`)
      : ['约束：当前未在 brief 中提取出明确硬约束，请人工补充'],
    planReviewDraft: [
      `当前选中 skeleton：${input.synthesis.current.chosenSkeletonId || '未生成'}`,
      `段落数量：${orderedCards.length}`,
      '请重点确认：段落顺序、桥段是否缺失、drama 是否被压扁、收尾是否成立。',
      '如需修改，请直接在章节备注里说明每段该提前、后移、删除还是拆分。',
    ],
    segments: input.synthesis.current.segmentCardIds.map((cardId, index) => {
      const card = cardMap.get(cardId);
      return {
        segmentId: card?.id ?? `segment-card-${index + 1}`,
        title: buildSegmentCardTitle(card, index),
        role: mapSegmentCardRole(card, index, orderedCards.length),
        targetDurationMs: estimateSegmentCardDuration(card),
        intent: card?.narrativeSketch ?? card?.segmentGoal ?? '',
        preferredClipTypes: [],
        preferredPlaceHints: collectCardPlaces(card, input.synthesis.bundles),
        notes: buildSegmentCardNotes(card),
      };
    }),
  };
}

function resolveProjectGoal(project: IKtepProject): string {
  return `${project.name} 的旅拍纪录片叙事编排`;
}

function resolveHardConstraints(style: IStyleProfile): string[] {
  return dedupeStrings([
    ...(style.globalConstraints ?? []),
    ...(style.antiPatterns ?? []),
  ]);
}

function orderCardsByCurrent(
  cards: ISegmentCard[],
  current: ICurrentArrangement,
): ISegmentCard[] {
  const cardMap = new Map(cards.map(card => [card.id, card]));
  const ordered = current.segmentCardIds
    .map(cardId => cardMap.get(cardId))
    .filter((card): card is ISegmentCard => Boolean(card));
  const seen = new Set(ordered.map(card => card.id));
  for (const card of cards) {
    if (!seen.has(card.id)) ordered.push(card);
  }
  return ordered;
}

function buildSegmentCardTitle(card: ISegmentCard | undefined, index: number): string {
  if (!card) return `段落 ${index + 1}`;
  if (card.title?.trim()) return card.title.trim();
  const archetype = card.archetypeId?.trim();
  if (archetype) return archetype;
  return `段落 ${index + 1}`;
}

function mapSegmentCardRole(
  card: ISegmentCard | undefined,
  index: number,
  total: number,
): 'intro' | 'scene' | 'transition' | 'highlight' | 'outro' {
  if (index === 0) return 'intro';
  if (index === total - 1) return 'outro';

  const text = [card?.archetypeId, card?.segmentGoal, card?.narrativeSketch]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  if (/(transition|bridge|geo-reset|time-passage)/u.test(text)) return 'transition';
  if (/(drama|conflict|highlight|emotion-release)/u.test(text)) return 'highlight';
  return 'scene';
}

function estimateSegmentCardDuration(card: ISegmentCard | undefined): number {
  if (!card) return 12_000;
  return Math.max(8_000, card.bundleIds.length * 6_000);
}

function collectCardPlaces(
  card: ISegmentCard | undefined,
  bundles: IMotifBundle[],
): string[] {
  if (!card) return [];
  const bundleMap = new Map(bundles.map(bundle => [bundle.id, bundle]));
  return dedupeStrings(card.bundleIds.flatMap(bundleId => bundleMap.get(bundleId)?.dominantPlaces ?? []));
}

function buildSegmentCardNotes(card: ISegmentCard | undefined): string[] {
  if (!card) return [];
  return dedupeStrings([
    card.segmentGoal ?? '',
    card.narrativeSketch,
    card.styleArchetypeHits.length > 0
      ? `style-program-hints:${card.styleArchetypeHits.join('/')}`
      : '',
    ...card.hardConstraints.map(item => `constraint:${item}`),
  ]);
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))];
}
