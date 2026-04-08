import type {
  IArrangementSkeleton,
  IBeatPacket,
  IKtepSlice,
  IMotifBundle,
  IProjectArrangementPacket,
  ISegmentCard,
  ISegmentPacket,
  IStyleProfile,
} from '../../protocol/schema.js';
import {
  bestCrossPhraseSimilarity,
  bestPhraseSimilarity,
  normalizePhraseList,
} from './phrase-match.js';

const CDEFAULT_BUDGET = {
  targetTokenBudget: 2200,
  representationPolicy: 'cards-plus-representatives' as const,
  mustHideRawSlices: true,
};

export function buildProjectArrangementPacket(input: {
  projectGoal: string;
  skeletons: IArrangementSkeleton[];
  segmentCards: ISegmentCard[];
  bundles: IMotifBundle[];
  style: IStyleProfile;
  hardConstraints?: string[];
}): IProjectArrangementPacket {
  return {
    projectGoal: input.projectGoal,
    budget: CDEFAULT_BUDGET,
    skeletonCandidates: input.skeletons,
    arrangementSegments: input.segmentCards,
    segmentCards: input.segmentCards,
    stylePrograms: input.style.arrangementStructure?.arrangementPrograms ?? [],
    styleArchetypeHits: (input.style.arrangementStructure?.arrangementPrograms ?? []).map(program => ({
      archetypeId: program.id,
      matchedBundleIds: input.bundles
        .filter(bundle => bestPhraseSimilarity(program.phrase, [
          bundle.title,
          bundle.description,
          ...bundle.compatibleLocalIntentPhrases,
          ...bundle.reuseHints,
        ]) >= 0.24)
        .map(bundle => bundle.id),
      notes: [program.notes, ...(program.bundlePreferencePhrases ?? [])]
        .filter(Boolean)
        .join(' / ') || undefined,
    })).filter(hit => hit.matchedBundleIds.length > 0),
    hardConstraints: input.hardConstraints ?? [],
    outputContract: {
      chosenSkeletonId: input.skeletons[0]?.id ?? '',
      organizationMode: input.skeletons[0]?.organizationMode ?? `${input.skeletons[0]?.strategy ?? 'mixed'}-arrangement`,
      arrangementStrategy: input.skeletons[0]?.strategy ?? 'mixed',
      segmentOutline: input.segmentCards.map((card, index) => ({
        segmentId: card.id,
        segmentCardId: card.id,
        order: index,
      })),
      narrativeSketch: input.skeletons[0]?.narrativeSketch ?? '',
    },
  };
}

export function buildSegmentPacket(input: {
  segmentCard: ISegmentCard;
  bundles: IMotifBundle[];
  slices: IKtepSlice[];
  style: IStyleProfile;
}): ISegmentPacket {
  const bundleMap = new Map(input.bundles.map(bundle => [bundle.id, bundle]));
  const sliceMap = new Map(input.slices.map(slice => [slice.id, slice]));
  const motifBundles = input.segmentCard.bundleIds
    .map(bundleId => bundleMap.get(bundleId))
    .filter((bundle): bundle is IMotifBundle => Boolean(bundle));
  const representativeSlices = motifBundles
    .flatMap(bundle => bundle.representativeSpanIds)
    .map(sliceId => sliceMap.get(sliceId))
    .filter((slice): slice is IKtepSlice => Boolean(slice));

  return {
    budget: {
      targetTokenBudget: 1800,
      representationPolicy: 'cards-plus-representatives',
      mustHideRawSlices: true,
    },
    arrangementSegment: input.segmentCard,
    segmentCard: input.segmentCard,
    motifBundles,
    representativeSpans: representativeSlices,
    representativeSlices,
    styleProgramPhrases: input.style.arrangementStructure?.arrangementPrograms.map(program => program.phrase) ?? [],
    styleArchetypeHits: input.segmentCard.styleArchetypeHits,
    hardConstraints: input.segmentCard.hardConstraints,
    outputContract: {
      beatPlan: motifBundles.map(bundle => ({
        bundleId: bundle.id,
        functions: bundle.dominantFunctions,
      })),
      narrativeSketch: input.segmentCard.narrativeSketch,
    },
  };
}

export function buildBeatPackets(input: {
  segmentPacket: ISegmentPacket;
  style: IStyleProfile;
}): IBeatPacket[] {
  const segmentCard = input.segmentPacket.segmentCard ?? input.segmentPacket.arrangementSegment;
  const segmentGoal = segmentCard?.segmentGoal ?? segmentCard?.programPhrase ?? segmentCard?.narrativeSketch ?? '';

  return input.segmentPacket.motifBundles.map(bundle => {
    const matchingBlocks = input.style.functionBlocks
      .map(block => ({
        block,
        score: scoreFunctionBlockForBundle(block, bundle, segmentGoal),
      }))
      .filter(item => item.score >= 0.18)
      .sort((left, right) => right.score - left.score)
      .slice(0, 4)
      .map(item => item.block.id);

    return {
      budget: {
        targetTokenBudget: 1100,
        representationPolicy: 'local-representatives-only',
        mustHideRawSlices: true,
      },
      beatGoal: describeBeatGoal(bundle),
      motifBundleIds: [bundle.id],
      representativeSpans: (input.segmentPacket.representativeSpans ?? input.segmentPacket.representativeSlices)
        .filter(slice => bundle.representativeSpanIds.includes(slice.id)),
      representativeSlices: input.segmentPacket.representativeSlices
        .filter(slice => bundle.representativeSliceIds.includes(slice.id)),
      stylePrograms: input.segmentPacket.styleProgramPhrases ?? [],
      styleBlocks: matchingBlocks,
      localTimelineConstraints: input.segmentPacket.hardConstraints,
      outputContract: {
        chosenSpanIds: bundle.representativeSpanIds,
        chosenSliceIds: bundle.representativeSliceIds,
        sourceSpeechDecision: resolveSourceSpeechDecision(bundle),
        roughTextIntent: describeBeatGoal(bundle),
      },
    };
  });
}

function describeBeatGoal(bundle: IMotifBundle): string {
  return [
    bundle.compatibleLocalIntentPhrases[0],
    bundle.title,
    bundle.dominantPlaces[0],
  ].filter(Boolean).join(' / ');
}

function resolveSourceSpeechDecision(bundle: IMotifBundle): IBeatPacket['outputContract']['sourceSpeechDecision'] {
  if (bundle.audioPolicyHint === 'must-use' || bundle.audioPolicyHint === 'prefer-use') return 'use';
  if (bundle.audioPolicyHint === 'must-mute' || bundle.audioPolicyHint === 'prefer-mute') return 'avoid';
  const primary = bundle.compatibleLocalIntentPhrases[0] ?? bundle.dominantFunctions[0] ?? '';
  if (/解释|人物出场|处境|摩擦|风险/u.test(primary)) return 'use';
  if (/时间流逝|收束|气势|情绪/u.test(primary)) return 'avoid';
  return 'optional';
}

function scoreFunctionBlockForBundle(
  block: IStyleProfile['functionBlocks'][number],
  bundle: IMotifBundle,
  segmentGoal: string,
): number {
  const functionOverlap = overlapScore(block.functions, bundle.dominantFunctions);
  const phraseScore = bestPhraseSimilarity(segmentGoal, [block.notes, ...block.disallowedPatterns]);
  const preferenceScore = bestCrossPhraseSimilarity(
    normalizePhraseList([
      ...block.preferredMaterials,
      ...block.preferredShotGrammar,
      ...block.preferredTransitions,
    ]),
    normalizePhraseList([
      ...bundle.dominantMaterialPatterns,
      ...bundle.compatibleLocalIntentPhrases,
      bundle.title,
      bundle.description,
    ]),
  );
  return (functionOverlap * 0.5) + (phraseScore * 0.25) + (preferenceScore * 0.25);
}

function overlapScore(left: string[], right: string[]): number {
  if (left.length === 0 || right.length === 0) return 0;
  const rightSet = new Set(right.map(item => item.trim()).filter(Boolean));
  return left
    .map(item => item.trim())
    .filter(Boolean)
    .filter(item => rightSet.has(item))
    .length;
}
