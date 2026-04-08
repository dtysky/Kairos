import { randomUUID } from 'node:crypto';
import type {
  IArrangementSkeleton,
  ICurrentArrangement,
  IKtepSlice,
  IMotifBundle,
  ISegmentCard,
  IStyleProfile,
} from '../../protocol/schema.js';
import {
  bestCrossPhraseSimilarity,
  bestPhraseSimilarity,
  normalizePhraseList,
} from './phrase-match.js';

export interface ISynthesizeArrangementInput {
  projectId: string;
  slices: IKtepSlice[];
  style: IStyleProfile;
  projectGoal?: string;
  hardConstraints?: string[];
}

export interface ISynthesizeArrangementResult {
  bundles: IMotifBundle[];
  skeletons: IArrangementSkeleton[];
  cards: ISegmentCard[];
  current: ICurrentArrangement;
}

interface IBundleSeed {
  key: string;
  kind: 'intent' | 'material' | 'intent-place' | 'audio';
  label: string;
  place?: string;
  slices: Map<string, IKtepSlice>;
}

export function synthesizeArrangement(
  input: ISynthesizeArrangementInput,
): ISynthesizeArrangementResult {
  const sortedSlices = [...input.slices].sort(compareSlices);
  const bundles = buildMotifBundles(sortedSlices, input.style);
  const skeletons = buildArrangementSkeletons(input.projectId, bundles, input.style, input.projectGoal);
  const currentDraft = chooseCurrentArrangement(input.projectId, skeletons);
  const cards = buildSegmentCards(currentDraft, skeletons, bundles, input.style, input.hardConstraints ?? []);
  const current = {
    ...currentDraft,
    segmentCardIds: cards.map(card => card.id),
  };
  return {
    bundles,
    skeletons,
    cards,
    current,
  };
}

export function buildMotifBundles(
  slices: IKtepSlice[],
  style: IStyleProfile,
): IMotifBundle[] {
  if (slices.length === 0) return [];

  const seedMap = new Map<string, IBundleSeed>();
  for (const slice of slices) {
    const materialPhrases = slice.materialPatterns
      .map(item => item.phrase.trim())
      .filter(Boolean)
      .slice(0, 2);
    const primaryIntent = slice.localEditingIntent?.primaryPhrase?.trim();
    const place = slice.grounding.spatialEvidence
      .map(item => item.locationText?.trim())
      .find(Boolean);
    const audioSeed = resolveAudioSeedLabel(slice);

    if (primaryIntent) {
      addSliceToSeed(seedMap, {
        key: `intent:${primaryIntent}`,
        kind: 'intent',
        label: primaryIntent,
      }, slice);
    }
    for (const phrase of materialPhrases) {
      addSliceToSeed(seedMap, {
        key: `material:${phrase}`,
        kind: 'material',
        label: phrase,
      }, slice);
    }
    if (primaryIntent && place) {
      addSliceToSeed(seedMap, {
        key: `intent-place:${primaryIntent}|${place}`,
        kind: 'intent-place',
        label: primaryIntent,
        place,
      }, slice);
    }
    if (audioSeed) {
      addSliceToSeed(seedMap, {
        key: `audio:${audioSeed}`,
        kind: 'audio',
        label: audioSeed,
      }, slice);
    }
  }

  const seeds = [...seedMap.values()]
    .filter(shouldKeepBundleSeed)
    .sort(compareBundleSeedPriority);

  return seeds
    .map((seed, index) => finalizeBundle([...seed.slices.values()], style, index, seed))
    .sort(compareBundleForInventory);
}

export function buildArrangementSkeletons(
  projectId: string,
  bundles: IMotifBundle[],
  style: IStyleProfile,
  projectGoal?: string,
): IArrangementSkeleton[] {
  if (bundles.length === 0) return [];
  const strategies: IArrangementSkeleton['strategy'][] = style.arrangementBias.preferredStrategies.length > 0
    ? style.arrangementBias.preferredStrategies
    : ['mixed'];
  const skeletons = strategies.map(strategy => {
    const orderedBundles = orderBundlesByStrategy(bundles, strategy);
    const stylePrograms = style.arrangementStructure?.arrangementPrograms ?? [];
    const nodes = stylePrograms.length > 0
      ? buildNodesFromPrograms(orderedBundles, stylePrograms)
      : orderedBundles.map(bundle => buildBundleNode(bundle));
    const edges = nodes.slice(0, -1).map((node, index) => ({
      from: node.id,
      to: nodes[index + 1]!.id,
      transitionPurpose: resolveTransitionPurpose(
        node.archetypeId,
        nodes[index + 1]!.archetypeId,
        style,
      ),
    }));
    return {
      id: randomUUID(),
      projectId,
      organizationMode: style.arrangementStructure?.organizationModes?.[0] ?? `${strategy ?? 'mixed'}-arrangement`,
      strategy,
      programPhrases: nodes.map(node => node.programPhrase ?? node.narrativePurpose ?? '').filter(Boolean),
      nodes,
      edges,
      narrativeSketch: [projectGoal, `strategy:${strategy}`, nodes
        .map(node => node.programPhrase ?? node.narrativePurpose ?? node.title ?? '')
        .filter(Boolean)
        .join(' -> ')]
        .filter(Boolean)
        .join(' | '),
    };
  });

  return skeletons.length > 0 ? skeletons : [{
    id: randomUUID(),
    projectId,
    organizationMode: style.arrangementStructure?.organizationModes?.[0] ?? 'mixed-arrangement',
    strategy: 'mixed',
    programPhrases: bundles.map(bundle => describeBundlePurpose(bundle)),
    nodes: bundles.map(bundle => buildBundleNode(bundle)),
    edges: [],
    narrativeSketch: [projectGoal, 'strategy:mixed', bundles.map(bundle => describeBundlePurpose(bundle)).join(' -> ')]
      .filter(Boolean)
      .join(' | '),
  }];
}

export function buildSegmentCards(
  current: ICurrentArrangement,
  skeletons: IArrangementSkeleton[],
  bundles: IMotifBundle[],
  style: IStyleProfile,
  hardConstraints: string[],
): ISegmentCard[] {
  const skeleton = skeletons.find(item => item.id === current.chosenSkeletonId) ?? skeletons[0];
  if (!skeleton) return [];
  const bundleMap = new Map(bundles.map(bundle => [bundle.id, bundle]));

  return skeleton.nodes.map(node => {
    const nodeBundles = node.bundleIds
      .map(bundleId => bundleMap.get(bundleId))
      .filter((bundle): bundle is IMotifBundle => Boolean(bundle));
    const styleHits = dedupeStrings([
      node.programPhrase,
      ...nodeBundles.flatMap(bundle => bundle.compatibleLocalIntentPhrases.slice(0, 2)),
      ...nodeBundles.flatMap(bundle => bundle.reuseHints.slice(0, 1)),
    ]);
    const blockConstraints = style.functionBlocks
      .filter(block => scoreFunctionBlockForNode(block, node, nodeBundles) >= 0.18)
      .flatMap(block => block.disallowedPatterns);
    return {
      id: randomUUID(),
      skeletonId: skeleton.id,
      nodeId: node.id,
      title: node.title ?? node.archetypeId ?? `段落 ${node.id}`,
      description: node.description ?? node.narrativePurpose ?? '',
      programPhrase: node.programPhrase ?? node.narrativePurpose,
      archetypeId: node.archetypeId,
      segmentGoal: node.narrativePurpose ?? node.programPhrase,
      bundleIds: node.bundleIds,
      representativeSpanIds: dedupeStrings(nodeBundles.flatMap(bundle => bundle.representativeSpanIds)).slice(0, 8),
      styleArchetypeHits: styleHits,
      hardConstraints: dedupeStrings([...hardConstraints, ...blockConstraints]),
      narrativeSketch: [
        node.narrativePurpose,
        ...nodeBundles.slice(0, 2).map(bundle => describeBundlePurpose(bundle)),
      ].join(' / '),
    };
  });
}

export function chooseCurrentArrangement(
  projectId: string,
  skeletons: IArrangementSkeleton[],
): ICurrentArrangement {
  const chosen = skeletons[0];
  if (!chosen) {
    return {
      id: randomUUID(),
      projectId,
      generatedAt: new Date().toISOString(),
      chosenSkeletonId: '',
      segmentIds: [],
      segmentCardIds: [],
      narrativeSketch: '',
      organizationMode: 'mixed-arrangement',
      strategy: 'mixed',
    };
  }
  return {
    id: randomUUID(),
    projectId,
    generatedAt: new Date().toISOString(),
    chosenSkeletonId: chosen.id,
    segmentIds: chosen.nodes.map(node => node.id),
    segmentCardIds: chosen.nodes.map(node => node.id),
    narrativeSketch: chosen.narrativeSketch,
    organizationMode: chosen.organizationMode ?? `${chosen.strategy ?? 'mixed'}-arrangement`,
    strategy: chosen.strategy,
  };
}

function finalizeBundle(
  slices: IKtepSlice[],
  style: IStyleProfile,
  index: number,
  seed: IBundleSeed,
): IMotifBundle {
  const dominantFunctions = topValues(
    slices.flatMap(slice => slice.narrativeFunctions?.core?.length
      ? slice.narrativeFunctions.core
      : [mapIntentPhraseToLegacyFunction(slice.localEditingIntent?.primaryPhrase)]),
    3,
  );
  const dominantPlaces = topValues(
    slices.flatMap(slice => slice.grounding.spatialEvidence.map(item => item.locationText).filter(Boolean) as string[]),
    2,
  );
  const dominantViewpoints = topValues(slices.flatMap(slice => slice.viewpointRoles?.core ?? []), 2);
  const dominantMaterialPatterns = topValues(slices.flatMap(slice => slice.materialPatterns.map(item => item.phrase)), 4);
  const compatibleLocalIntentPhrases = topValues(
    slices.flatMap(slice => [
      slice.localEditingIntent?.primaryPhrase,
      ...(slice.localEditingIntent?.secondaryPhrases ?? []),
    ].filter(Boolean) as string[]),
    4,
  );
  const archetypeHits = scoreBundleAgainstArchetypes({
    dominantFunctions,
    dominantPlaces,
    dominantViewpoints,
    sliceTypes: slices.map(slice => slice.type),
    shotGrammar: slices.flatMap(slice => slice.shotGrammar?.core ?? []),
  }, style).slice(0, 3);
  const representativeSliceIds = pickRepresentativeSliceIds(slices, 3);
  const title = buildBundleTitle(seed, dominantMaterialPatterns, compatibleLocalIntentPhrases, dominantPlaces);
  const description = buildBundleDescription({
    slices,
    dominantMaterialPatterns,
    compatibleLocalIntentPhrases,
    dominantPlaces,
    seed,
  });
  const audioPolicyHint = topValues(slices.map(slice => slice.localEditingIntent?.sourceAudioPolicy ?? 'optional'), 1)[0];
  const reuseHints = normalizePhraseList([
    seed.kind === 'intent'
      ? `可在承担“${seed.label}”的段落中复用`
      : '',
    seed.kind === 'material'
      ? `可在需要“${seed.label}”材料模式的段落中复用`
      : '',
    dominantPlaces[0] ? `可在 ${dominantPlaces[0]} 相关内容中复用` : '',
  ]);

  return {
    id: `bundle-${index + 1}-${randomUUID()}`,
    title,
    description,
    memberSpanIds: slices.map(slice => slice.id),
    representativeSpanIds: representativeSliceIds,
    dominantMaterialPatterns,
    compatibleLocalIntentPhrases,
    audioPolicyHint,
    reuseHints,
    sliceIds: slices.map(slice => slice.id),
    dominantFunctions,
    dominantPlaces,
    dominantViewpoints,
    timeContinuity: resolveTimeContinuity(slices),
    spatialContinuity: dominantPlaces.length <= 1 ? 'tight' : dominantPlaces.length === 2 ? 'mixed' : 'loose',
    archetypeHits,
    representativeSliceIds,
    notes: describeBundleNotes(slices, dominantFunctions, dominantPlaces, seed),
  };
}

function scoreBundleAgainstArchetypes(
  bundle: {
    dominantFunctions: string[];
    dominantPlaces: string[];
    dominantViewpoints: string[];
    sliceTypes: string[];
    shotGrammar: string[];
  },
  style: IStyleProfile,
): IMotifBundle['archetypeHits'] {
  return style.segmentArchetypes.map(archetype => {
    let score = 0;
    const reasons: string[] = [];

    const functionHits = overlapScore(bundle.dominantFunctions, archetype.functions);
    if (functionHits > 0) {
      score += functionHits * 2;
      reasons.push(`functions:${functionHits}`);
    }

    const materialHits = overlapScore(bundle.sliceTypes, archetype.preferredMaterials);
    if (materialHits > 0) {
      score += materialHits * 1.5;
      reasons.push(`materials:${materialHits}`);
    }

    const shotHits = overlapScore(bundle.shotGrammar, archetype.preferredShotGrammar);
    if (shotHits > 0) {
      score += shotHits * 1.2;
      reasons.push(`shot-grammar:${shotHits}`);
    }

    const viewpointHits = overlapScore(bundle.dominantViewpoints, archetype.preferredViewpoints ?? []);
    if (viewpointHits > 0) {
      score += viewpointHits;
      reasons.push(`viewpoints:${viewpointHits}`);
    }

    if (bundle.dominantPlaces.length > 0 && archetype.functions.includes('geo-reset')) {
      score += 0.5;
      reasons.push('places:present');
    }

    return {
      archetypeId: archetype.id,
      confidence: Math.max(0, Math.min(1, score / 6)),
      reasons,
    };
  }).filter(hit => hit.confidence > 0.15)
    .sort((left, right) => right.confidence - left.confidence);
}

function orderBundlesByStrategy(
  bundles: IMotifBundle[],
  strategy: IArrangementSkeleton['strategy'],
): IMotifBundle[] {
  const sorted = [...bundles];
  if (strategy === 'time-first' || strategy === 'mixed') {
    return sorted;
  }
  if (strategy === 'space-first') {
    return sorted.sort((left, right) =>
      (left.dominantPlaces[0] ?? '').localeCompare(right.dominantPlaces[0] ?? '')
      || left.id.localeCompare(right.id),
    );
  }
  return sorted.sort((left, right) =>
    scoreFunctionWeight(right.dominantFunctions) - scoreFunctionWeight(left.dominantFunctions)
    || left.id.localeCompare(right.id),
  );
}

function resolveTransitionPurpose(
  fromArchetypeId: string | undefined,
  toArchetypeId: string | undefined,
  style: IStyleProfile,
): string {
  if (fromArchetypeId && toArchetypeId) {
    const explicit = style.transitionRules.find(rule => rule.from === fromArchetypeId && rule.to === toArchetypeId);
    if (explicit) return explicit.purpose;
  }
  return [fromArchetypeId ?? 'segment', 'to', toArchetypeId ?? 'segment'].join(' ');
}

function describeBundlePurpose(bundle: IMotifBundle): string {
  const primaryFunction = bundle.compatibleLocalIntentPhrases[0]
    ?? bundle.title
    ?? bundle.dominantFunctions[0]
    ?? '一组可复用材料';
  const place = bundle.dominantPlaces[0];
  return place ? `${primaryFunction}（${place}）` : primaryFunction;
}

function buildBundleTitle(
  seed: IBundleSeed,
  dominantMaterialPatterns: string[],
  compatibleLocalIntentPhrases: string[],
  dominantPlaces: string[],
): string {
  const mainPattern = dominantMaterialPatterns[0] ?? '一组可复用素材';
  const mainIntent = compatibleLocalIntentPhrases[0];
  const place = seed.place ?? dominantPlaces[0];
  if (seed.kind === 'intent-place' && place) {
    return `一组在 ${place} 用于“${seed.label}”的材料`;
  }
  if (seed.kind === 'intent') {
    return `一组用于“${seed.label}”的材料`;
  }
  if (seed.kind === 'material') {
    return `一组以“${seed.label}”为主的材料`;
  }
  if (seed.kind === 'audio') {
    return `一组 ${seed.label} 材料`;
  }
  return [mainIntent ?? mainPattern, place].filter(Boolean).join(' · ');
}

function buildBundleDescription(input: {
  slices: IKtepSlice[];
  dominantMaterialPatterns: string[];
  compatibleLocalIntentPhrases: string[];
  dominantPlaces: string[];
  seed: IBundleSeed;
}): string {
  return [
    input.seed.kind === 'material'
      ? `这组材料以“${input.seed.label}”为共同母题`
      : input.seed.kind === 'intent'
        ? `这组材料共同适合“${input.seed.label}”`
        : input.seed.kind === 'intent-place' && input.seed.place
          ? `这组材料围绕 ${input.seed.place}，共同适合“${input.seed.label}”`
          : input.compatibleLocalIntentPhrases[0] ?? '一组可复用素材',
    input.dominantMaterialPatterns.length > 0 ? `材料模式：${input.dominantMaterialPatterns.join(' / ')}` : '',
    input.dominantPlaces.length > 0 ? `地点线索：${input.dominantPlaces.join(' / ')}` : '',
    `span 数：${input.slices.length}`,
  ].filter(Boolean).join('；');
}

function describeBundleNotes(
  slices: IKtepSlice[],
  dominantFunctions: string[],
  dominantPlaces: string[],
  seed: IBundleSeed,
): string {
  return [
    `seed:${seed.kind}:${seed.label}`,
    `slices:${slices.length}`,
    dominantFunctions.length > 0 ? `functions:${dominantFunctions.join('/')}` : '',
    dominantPlaces.length > 0 ? `places:${dominantPlaces.join('/')}` : '',
  ].filter(Boolean).join(' | ');
}

function compareSlices(left: IKtepSlice, right: IKtepSlice): number {
  return (left.editSourceInMs ?? left.sourceInMs ?? 0) - (right.editSourceInMs ?? right.sourceInMs ?? 0)
    || (left.editSourceOutMs ?? left.sourceOutMs ?? 0) - (right.editSourceOutMs ?? right.sourceOutMs ?? 0)
    || left.assetId.localeCompare(right.assetId)
    || left.id.localeCompare(right.id);
}

function addSliceToSeed(
  seedMap: Map<string, IBundleSeed>,
  seedInput: Omit<IBundleSeed, 'slices'>,
  slice: IKtepSlice,
): void {
  const existing = seedMap.get(seedInput.key);
  if (existing) {
    existing.slices.set(slice.id, slice);
    return;
  }
  seedMap.set(seedInput.key, {
    ...seedInput,
    slices: new Map([[slice.id, slice]]),
  });
}

function resolveAudioSeedLabel(slice: IKtepSlice): string | null {
  const policy = slice.localEditingIntent?.sourceAudioPolicy ?? 'optional';
  if (policy === 'must-use' || policy === 'prefer-use') return '原声驱动';
  if (policy === 'prefer-mute' || policy === 'must-mute') return '更适合静音或旁白驱动';
  return null;
}

function shouldKeepBundleSeed(seed: IBundleSeed): boolean {
  if (seed.kind === 'intent') return true;
  return seed.slices.size >= 2;
}

function compareBundleSeedPriority(left: IBundleSeed, right: IBundleSeed): number {
  const priority = (seed: IBundleSeed): number => {
    switch (seed.kind) {
      case 'intent-place':
        return 0;
      case 'intent':
        return 1;
      case 'material':
        return 2;
      case 'audio':
        return 3;
      default:
        return 4;
    }
  };
  return priority(left) - priority(right)
    || right.slices.size - left.slices.size
    || left.label.localeCompare(right.label);
}

function compareBundleForInventory(left: IMotifBundle, right: IMotifBundle): number {
  return scoreBundleInventoryWeight(right) - scoreBundleInventoryWeight(left)
    || left.title.localeCompare(right.title);
}

function scoreBundleInventoryWeight(bundle: IMotifBundle): number {
  return bundle.memberSpanIds.length * 10
    + bundle.compatibleLocalIntentPhrases.length * 4
    + bundle.dominantMaterialPatterns.length * 2
    + (bundle.audioPolicyHint === 'prefer-use' || bundle.audioPolicyHint === 'must-use' ? 1 : 0);
}

function buildNodesFromPrograms(
  bundles: IMotifBundle[],
  programs: Array<{ id: string; phrase: string; bundlePreferencePhrases?: string[] }>,
): IArrangementSkeleton['nodes'] {
  const assignments = new Map<string, Array<{ bundle: IMotifBundle; score: number }>>();
  const unmatched: IMotifBundle[] = [];

  for (const bundle of bundles) {
    let bestProgramId: string | null = null;
    let bestScore = 0;
    for (const program of programs) {
      const score = scoreProgramToBundle(program, bundle);
      if (score > bestScore) {
        bestScore = score;
        bestProgramId = program.id;
      }
    }
    if (bestProgramId && bestScore >= 0.24) {
      const assigned = assignments.get(bestProgramId) ?? [];
      assigned.push({ bundle, score: bestScore });
      assignments.set(bestProgramId, assigned);
    } else {
      unmatched.push(bundle);
    }
  }

  const nodes: IArrangementSkeleton['nodes'] = programs
    .map(program => {
      const assigned = (assignments.get(program.id) ?? [])
        .sort((left, right) => right.score - left.score)
        .map(item => item.bundle)
        .slice(0, 4);
      if (assigned.length === 0) return null;
      return {
        id: `node-${program.id}`,
        title: program.phrase,
        description: assigned.map(bundle => bundle.description).slice(0, 2).join(' / '),
        programPhrase: program.phrase,
        archetypeId: resolveDominantArchetypeId(assigned),
        functions: normalizePhraseList(assigned.flatMap(bundle => bundle.dominantFunctions)),
        bundleIds: assigned.map(bundle => bundle.id),
        narrativePurpose: [program.phrase, assigned[0] ? describeBundlePurpose(assigned[0]) : '']
          .filter(Boolean)
          .join(' / '),
        hardConstraints: [],
      };
    })
    .filter((node): node is NonNullable<typeof node> => Boolean(node));

  for (const bundle of unmatched) {
    nodes.push(buildBundleNode(bundle));
  }
  return nodes;
}

function buildBundleNode(bundle: IMotifBundle): IArrangementSkeleton['nodes'][number] {
  return {
    id: `node-${bundle.id}`,
    title: bundle.title,
    description: bundle.description,
    programPhrase: bundle.compatibleLocalIntentPhrases[0] ?? describeBundlePurpose(bundle),
    archetypeId: bundle.archetypeHits[0]?.archetypeId,
    functions: [...bundle.dominantFunctions],
    bundleIds: [bundle.id],
    narrativePurpose: describeBundlePurpose(bundle),
    hardConstraints: [],
  };
}

function resolveDominantArchetypeId(bundles: IMotifBundle[]): string | undefined {
  const counts = new Map<string, number>();
  for (const bundle of bundles) {
    const id = bundle.archetypeHits[0]?.archetypeId;
    if (!id) continue;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0]?.[0];
}

function scoreProgramToBundle(
  program: { phrase: string; bundlePreferencePhrases?: string[]; notes?: string },
  bundle: IMotifBundle,
): number {
  const phraseScore = bestPhraseSimilarity(program.phrase, [
    bundle.title,
    bundle.description,
    ...bundle.compatibleLocalIntentPhrases,
    ...bundle.reuseHints,
  ]);
  const preferenceScore = bestCrossPhraseSimilarity(
    program.bundlePreferencePhrases ?? [],
    [
      ...bundle.dominantMaterialPatterns,
      ...bundle.compatibleLocalIntentPhrases,
      bundle.audioPolicyHint,
    ],
  );
  const noteScore = bestPhraseSimilarity(program.notes, [bundle.description, bundle.title]);
  return Math.max(phraseScore, (phraseScore * 0.65) + (preferenceScore * 0.25) + (noteScore * 0.1));
}

function scoreFunctionBlockForNode(
  block: IStyleProfile['functionBlocks'][number],
  node: IArrangementSkeleton['nodes'][number],
  bundles: IMotifBundle[],
): number {
  const functionOverlap = overlapScore(block.functions, node.functions);
  const phraseScore = bestPhraseSimilarity(node.programPhrase ?? node.narrativePurpose, [
    block.notes,
    ...block.disallowedPatterns,
  ]);
  const preferenceScore = bestCrossPhraseSimilarity(
    normalizePhraseList([
      ...block.preferredMaterials,
      ...block.preferredShotGrammar,
      ...block.preferredTransitions,
    ]),
    normalizePhraseList([
      ...bundles.flatMap(bundle => bundle.dominantMaterialPatterns),
      ...bundles.flatMap(bundle => bundle.compatibleLocalIntentPhrases),
      node.title,
      node.description,
    ]),
  );
  return (functionOverlap * 0.5) + (phraseScore * 0.25) + (preferenceScore * 0.25);
}

function topValues(values: string[], limit: number): string[] {
  const counts = new Map<string, number>();
  for (const value of values.map(item => item.trim()).filter(Boolean)) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit)
    .map(([value]) => value);
}

function pickRepresentativeSliceIds(slices: IKtepSlice[], limit: number): string[] {
  if (slices.length <= limit) return slices.map(slice => slice.id);
  const picked: string[] = [];
  for (let i = 0; i < limit; i++) {
    const index = Math.min(
      slices.length - 1,
      Math.round((i * (slices.length - 1)) / Math.max(1, limit - 1)),
    );
    picked.push(slices[index]!.id);
  }
  return [...new Set(picked)];
}

function resolveTimeContinuity(slices: IKtepSlice[]): IMotifBundle['timeContinuity'] {
  if (slices.length <= 1) return 'tight';
  const gaps: number[] = [];
  for (let i = 1; i < slices.length; i++) {
    const previous = slices[i - 1]!;
    const current = slices[i]!;
    const previousEnd = previous.editSourceOutMs ?? previous.sourceOutMs ?? 0;
    const currentStart = current.editSourceInMs ?? current.sourceInMs ?? previousEnd;
    gaps.push(Math.max(0, currentStart - previousEnd));
  }
  const maxGap = Math.max(...gaps);
  if (maxGap <= 30_000) return 'tight';
  if (maxGap <= 120_000) return 'mixed';
  return 'loose';
}

function scoreFunctionWeight(functions: string[]): number {
  const primary = functions[0] ?? 'transition';
  const table: Record<string, number> = {
    establish: 1,
    'geo-reset': 2,
    'route-advance': 3,
    'info-delivery': 4,
    'conflict-foreshadow': 5,
    'conflict-event': 6,
    'emotion-release': 7,
    departure: 2,
    arrival: 8,
    transition: 0,
    'time-passage': 5,
  };
  return table[primary] ?? 0;
}

function mapIntentPhraseToLegacyFunction(phrase?: string): string {
  const text = phrase?.trim() ?? '';
  if (!text) return 'transition';
  if (/地方|地点|空间/u.test(text)) return 'establish';
  if (/人物|处境|解释/u.test(text)) return 'info-delivery';
  if (/行动|路途|过程/u.test(text)) return 'route-advance';
  if (/摩擦|压力|风险/u.test(text)) return 'conflict-event';
  if (/时间流逝|状态变化/u.test(text)) return 'time-passage';
  if (/尺度|气势|情绪/u.test(text)) return 'emotion-release';
  if (/收束|抵达|下一段/u.test(text)) return 'arrival';
  return 'transition';
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

function dedupeStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.map(value => value?.trim()).filter(Boolean) as string[])];
}
