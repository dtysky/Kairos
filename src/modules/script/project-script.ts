import { randomUUID } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import type {
  IKtepScript,
  IKtepSlice,
  IMaterialBundle,
  IMaterialSlotsDocument,
  IProjectMaterialOverviewFacts,
  IProjectPharosContext,
  ISegmentPlan,
  IStyleProfile,
} from '../../protocol/schema.js';
import type { ILlmClient } from '../llm/client.js';
import {
  getMaterialBundlesPath,
  getMaterialOverviewFactsPath,
  getMaterialOverviewPath,
  getMaterialSlotsPath,
  getOutlinePromptPath,
  getScriptBriefPath,
  getSegmentPlanPath,
  loadAssets,
  loadChronology,
  loadOptionalMarkdown,
  loadProject,
  loadProjectBriefConfig,
  loadProjectPharosContext,
  loadScriptBriefConfig,
  loadSpans,
  saveScriptBriefConfig,
  writeCurrentScript,
  writeMaterialBundles,
  writeMaterialOverviewFacts,
  writeMaterialSlots,
  writeOutline,
  writeSegmentPlan,
} from '../../store/index.js';
import { buildOutline, type IOutlineSegment } from './outline-builder.js';
import { buildOutlinePrompt, generateScript } from './script-generator.js';
import { loadStyleByCategory } from './style-loader.js';
import {
  resolveArrangementSignals,
  type IResolvedArrangementSignals,
} from './arrangement-signals.js';

export interface IBuildProjectOutlineInput {
  projectRoot: string;
  workspaceRoot?: string;
  styleCategory?: string;
  style?: IStyleProfile;
}

export interface IBuildProjectOutlineResult {
  outline: IOutlineSegment[];
  segmentPlan: ISegmentPlan;
  materialSlots: IMaterialSlotsDocument;
}

export interface IGenerateProjectScriptInput {
  projectRoot: string;
  llm: ILlmClient;
  style: IStyleProfile;
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
  materialOverviewFactsPath: string;
  materialOverviewPath: string;
  materialBundlesPath: string;
  scriptBriefPath: string;
  status: 'awaiting_agent';
  message: string;
}

interface IScriptPlanningContext {
  project: Awaited<ReturnType<typeof loadProject>>;
  projectBrief: Awaited<ReturnType<typeof loadProjectBriefConfig>>;
  assets: Awaited<ReturnType<typeof loadAssets>>;
  spans: IKtepSlice[];
  chronology: Awaited<ReturnType<typeof loadChronology>>;
  pharosContext: IProjectPharosContext | null;
}

interface IOrderedSpanCandidate {
  spanId: string;
  assetId: string;
  sortKey: string;
  orderIndex: number;
  orderPosition: number;
  sourceDurationMs: number;
  materialCapacityMs: number;
  isPhoto: boolean;
  hasSourceSpeech: boolean;
  isKeyProcessVideo: boolean;
}

interface ISegmentTimeBand {
  startPosition: number;
  endPosition: number;
  centerPosition: number;
}

export async function buildProjectOutlineFromPlanning(
  input: IBuildProjectOutlineInput,
): Promise<IBuildProjectOutlineResult> {
  const style = input.style
    ?? await resolveStyle(input.projectRoot, input.workspaceRoot, input.styleCategory);
  const brief = await loadScriptBriefConfig(input.projectRoot);
  ensureScriptGenerationWorkflowState(brief.workflowState);
  const prepared = await ensureMaterialFactsAndBundles(input.projectRoot);
  const overviewMarkdown = await loadOptionalMarkdown(getMaterialOverviewPath(input.projectRoot));
  if (!overviewMarkdown?.trim()) {
    throw new Error('script generation requires script/material-overview.md');
  }
  const arrangementSignals = resolveArrangementSignals(style);
  const orderedSpanCandidates = buildOrderedSpanCandidates({
    spans: prepared.context.spans,
    chronology: prepared.context.chronology,
    pharosContext: prepared.context.pharosContext,
  });
  const segmentPlan = buildSegmentPlanDocument({
    projectId: prepared.context.project.id,
    brief,
    style,
    facts: prepared.facts,
    overviewMarkdown,
    spans: prepared.context.spans,
    chronology: prepared.context.chronology,
    pharosContext: prepared.context.pharosContext,
    arrangementSignals,
    orderedSpanCandidates,
  });
  const materialSlots = buildMaterialSlotsDocument({
    projectId: prepared.context.project.id,
    segmentPlan,
    bundles: prepared.bundles,
    spans: prepared.context.spans,
    chronology: prepared.context.chronology,
    pharosContext: prepared.context.pharosContext,
    style,
    arrangementSignals,
    orderedSpanCandidates,
  });
  const spansById = new Map(prepared.context.spans.map(span => [span.id, span] as const));
  const outline = buildOutline({
    segmentPlan,
    materialSlots,
    spansById,
  });

  await Promise.all([
    writeSegmentPlan(input.projectRoot, segmentPlan),
    writeMaterialSlots(input.projectRoot, materialSlots),
    writeOutline(input.projectRoot, outline),
    writeFile(getOutlinePromptPath(input.projectRoot), buildOutlinePrompt(outline), 'utf-8'),
  ]);

  return {
    outline,
    segmentPlan,
    materialSlots,
  };
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

  await loadStyleByCategory(`${input.workspaceRoot}/config/styles`, styleCategory);
  const overviewMarkdown = await loadOptionalMarkdown(getMaterialOverviewPath(input.projectRoot));
  if (!overviewMarkdown?.trim()) {
    throw new Error('script prep requires script/material-overview.md');
  }

  const prepared = await ensureMaterialFactsAndBundles(input.projectRoot);
  await clearObsoleteArrangementArtifacts(input.projectRoot);

  await saveScriptBriefConfig(input.projectRoot, {
    ...scriptBriefConfig,
    projectName: scriptBriefConfig.projectName?.trim() || prepared.context.project.name,
    styleCategory,
    workflowState: 'ready_for_agent',
    segments: scriptBriefConfig.segments.map(segment => ({
      ...segment,
      roleHint: segment.roleHint?.trim() || undefined,
      notes: segment.notes ?? [],
    })),
  });

  const hasOverview = Boolean(
    await loadOptionalMarkdown(getMaterialOverviewPath(input.projectRoot)),
  );

  return {
    projectId: prepared.context.project.id,
    projectName: prepared.context.project.name,
    styleCategory,
    materialOverviewFactsPath: getMaterialOverviewFactsPath(input.projectRoot),
    materialOverviewPath: getMaterialOverviewPath(input.projectRoot),
    materialBundlesPath: getMaterialBundlesPath(input.projectRoot),
    scriptBriefPath: getScriptBriefPath(input.projectRoot),
    status: 'awaiting_agent',
    message: hasOverview
      ? '事实刷新与 bundle 索引已完成。请回到 Agent，用 material-overview.md + script-brief + style profile 继续生成 segment-plan、material-slots 与 script/current.json。'
      : '事实刷新与 bundle 索引已完成。请回到 Agent 先补齐 script/material-overview.md，再继续生成 segment-plan、material-slots 与 script/current.json。',
  };
}

export async function generateProjectScriptFromPlanning(
  input: IGenerateProjectScriptInput,
): Promise<IKtepScript[]> {
  const brief = await loadScriptBriefConfig(input.projectRoot);
  ensureScriptGenerationWorkflowState(brief.workflowState);
  const built = await buildProjectOutlineFromPlanning({
    projectRoot: input.projectRoot,
    style: input.style,
  });
  const materialOverview = await loadOptionalMarkdown(getMaterialOverviewPath(input.projectRoot));
  if (!materialOverview?.trim()) {
    throw new Error('script generation requires script/material-overview.md');
  }
  const script = await generateScript(input.llm, built.outline, input.style, {
    materialOverview,
    brief: {
      goals: brief.goalDraft,
      constraints: brief.constraintDraft,
      planReviewNotes: brief.planReviewDraft,
    },
  });
  await writeCurrentScript(input.projectRoot, script);

  await saveScriptBriefConfig(input.projectRoot, {
    ...brief,
    workflowState: 'script_generated',
  });

  return script;
}

export async function loadProjectStyleByCategory(
  workspaceRoot: string,
  category: string,
) : Promise<IStyleProfile> {
  return loadStyleByCategory(`${workspaceRoot}/config/styles`, category);
}

export function buildProjectMaterialOverviewFacts(input: IScriptPlanningContext): IProjectMaterialOverviewFacts {
  const assetById = new Map(input.assets.map(asset => [asset.id, asset] as const));
  const chronologyByAssetId = new Map(input.chronology.map(item => [item.assetId, item] as const));
  const durations = input.assets
    .map(asset => asset.durationMs)
    .filter((value): value is number => typeof value === 'number' && value > 0);
  const capturedTimes = input.chronology
    .map(item => item.sortCapturedAt ?? item.capturedAt)
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .sort();

  const roots = new Map<string, {
    ingestRootId?: string;
    assetCount: number;
    durationMs: number;
    labels: string[];
    placeHints: string[];
    materialPatterns: string[];
  }>();
  for (const asset of input.assets) {
    const key = asset.ingestRootId ?? 'unassigned';
    const current = roots.get(key) ?? {
      ingestRootId: asset.ingestRootId,
      assetCount: 0,
      durationMs: 0,
      labels: [],
      placeHints: [],
      materialPatterns: [],
    };
    const chronology = chronologyByAssetId.get(asset.id);
    current.assetCount += 1;
    current.durationMs += asset.durationMs ?? 0;
    current.labels.push(...(chronology?.labels ?? []));
    current.placeHints.push(...(chronology?.placeHints ?? []));
    current.materialPatterns.push(...input.spans
      .filter(span => span.assetId === asset.id)
      .flatMap(span => span.materialPatterns.map(pattern => pattern.phrase)));
    roots.set(key, current);
  }

  const clipTypeDistribution = input.spans.reduce<Record<string, number>>((result, span) => {
    result[span.type] = (result[span.type] ?? 0) + 1;
    return result;
  }, {});

  const topLabels = pickTopValues(input.chronology.flatMap(item => item.labels), 8);
  const topPlaceHints = pickTopValues(input.chronology.flatMap(item => item.placeHints), 8);
  const topMaterialPatterns = pickTopValues(
    input.spans.flatMap(span => span.materialPatterns.map(pattern => pattern.phrase)),
    10,
  );
  const mainThemes = topMaterialPatterns.length > 0 ? topMaterialPatterns.slice(0, 5) : topLabels.slice(0, 5);
  const inferredGaps = dedupeStrings([
    input.pharosContext?.shots.some(shot => shot.status === 'pending') ? 'Pharos 仍有待补镜头' : undefined,
    topPlaceHints.length === 0 ? '当前素材的地点线索较弱' : undefined,
    input.spans.every(span => !span.transcript?.trim()) ? '当前正式 spans 基本没有可直接引用的口播' : undefined,
  ]);

  return {
    id: randomUUID(),
    projectId: input.project.id,
    generatedAt: new Date().toISOString(),
    projectBrief: input.projectBrief.description,
    totalAssets: input.assets.length,
    totalDurationMs: durations.reduce((sum, value) => sum + value, 0),
    capturedStartAt: capturedTimes[0],
    capturedEndAt: capturedTimes[capturedTimes.length - 1],
    roots: [...roots.values()].map(root => ({
      ingestRootId: root.ingestRootId === 'unassigned' ? undefined : root.ingestRootId,
      assetCount: root.assetCount,
      durationMs: root.durationMs || undefined,
      topLabels: pickTopValues(root.labels, 6),
      topPlaceHints: pickTopValues(root.placeHints, 6),
      topMaterialPatterns: pickTopValues(root.materialPatterns, 6),
      summary: buildRootSummary(root.assetCount, root.placeHints, root.materialPatterns),
    })),
    topLabels,
    topPlaceHints,
    topMaterialPatterns,
    clipTypeDistribution,
    mainThemes,
    inferredGaps,
    pharos: input.pharosContext ? buildMaterialOverviewPharosSummary(input.pharosContext, input.assets.length) : undefined,
    summary: [
      `项目共 ${input.assets.length} 条素材`,
      durations.length > 0 ? `累计约 ${Math.round(durations.reduce((sum, value) => sum + value, 0) / 1000)} 秒` : '',
      mainThemes.length > 0 ? `主材料主题集中在 ${mainThemes.join(' / ')}` : '',
    ].filter(Boolean).join('，'),
  };
}

export function buildMaterialOverviewMarkdown(facts: IProjectMaterialOverviewFacts): string {
  return [
    '# Material Overview',
    '',
    `- 生成时间：${facts.generatedAt}`,
    `- 素材总数：${facts.totalAssets}`,
    facts.totalDurationMs ? `- 累计时长：${Math.round(facts.totalDurationMs / 1000)}s` : '',
    facts.capturedStartAt ? `- 拍摄起点：${facts.capturedStartAt}` : '',
    facts.capturedEndAt ? `- 拍摄终点：${facts.capturedEndAt}` : '',
    '',
    '## Main Themes',
    '',
    ...facts.mainThemes.map(item => `- ${item}`),
    '',
    '## Place Hints',
    '',
    ...facts.topPlaceHints.map(item => `- ${item}`),
    '',
    '## Material Patterns',
    '',
    ...facts.topMaterialPatterns.map(item => `- ${item}`),
    '',
    '## Roots',
    '',
    ...facts.roots.flatMap(root => [
      `### ${root.ingestRootId ?? 'unassigned'}`,
      `- assetCount: ${root.assetCount}`,
      root.durationMs ? `- durationMs: ${root.durationMs}` : '',
      root.topPlaceHints.length > 0 ? `- placeHints: ${root.topPlaceHints.join(' / ')}` : '',
      root.topMaterialPatterns.length > 0 ? `- materialPatterns: ${root.topMaterialPatterns.join(' / ')}` : '',
      root.summary ? `- summary: ${root.summary}` : '',
      '',
    ]),
    facts.inferredGaps.length > 0 ? '## Gaps' : '',
    facts.inferredGaps.length > 0 ? '' : '',
    ...facts.inferredGaps.flatMap(item => [`- ${item}`]),
    '',
  ].filter(Boolean).join('\n');
}

export function buildMaterialBundles(
  spans: IKtepSlice[],
  chronology: IScriptPlanningContext['chronology'],
  pharosContext: IProjectPharosContext | null,
): IMaterialBundle[] {
  const chronologyByAssetId = new Map(chronology.map(item => [item.assetId, item] as const));
  const pharosShotByRef = new Map(
    (pharosContext?.shots ?? []).map(shot => [`${shot.ref.tripId}:${shot.ref.shotId}`, shot] as const),
  );
  const grouped = new Map<string, IKtepSlice[]>();

  for (const span of spans) {
    const key = resolveBundleKey(span);
    const current = grouped.get(key) ?? [];
    current.push(span);
    grouped.set(key, current);
  }

  return [...grouped.entries()].map(([key, members]) => {
    const placeHints = dedupeStrings([
      ...members.flatMap(span => span.grounding.spatialEvidence.map(evidence => evidence.locationText)),
      ...members.flatMap(span => chronologyByAssetId.get(span.assetId)?.placeHints ?? []),
    ]);
    const pharosTripIds = dedupeStrings(members.flatMap(span => span.pharosRefs?.map(ref => ref.tripId) ?? []));
    const representativeSpanIds = [...members]
      .sort((left, right) => scoreRepresentativeSpan(right) - scoreRepresentativeSpan(left))
      .slice(0, 3)
      .map(span => span.id);

    return {
      id: `bundle-${slugify(key)}`,
      key,
      label: resolveBundleLabel(key, members, pharosShotByRef),
      memberSpanIds: members.map(span => span.id),
      representativeSpanIds,
      placeHints,
      pharosTripIds,
      notes: dedupeStrings([
        ...members.flatMap(span => span.materialPatterns.map(pattern => pattern.phrase)),
        ...members.flatMap(span => span.grounding.spatialEvidence.map(evidence => evidence.locationText)),
      ]).slice(0, 8),
    } satisfies IMaterialBundle;
  }).sort((left, right) => right.memberSpanIds.length - left.memberSpanIds.length);
}

export function buildSegmentPlanDocument(input: {
  projectId: string;
  brief: Awaited<ReturnType<typeof loadScriptBriefConfig>>;
  style: IStyleProfile;
  facts: IProjectMaterialOverviewFacts;
  overviewMarkdown: string;
  spans?: IKtepSlice[];
  chronology?: IScriptPlanningContext['chronology'];
  pharosContext?: IProjectPharosContext | null;
  arrangementSignals?: IResolvedArrangementSignals;
  orderedSpanCandidates?: IOrderedSpanCandidate[];
}): ISegmentPlan {
  const arrangementSignals = input.arrangementSignals ?? resolveArrangementSignals(input.style);
  const providedSegments = input.brief.segments.map(segment => ({
    id: segment.segmentId,
    title: segment.title?.trim() || segment.segmentId,
    intent: segment.intent?.trim() || inferSegmentIntent(segment.segmentId, input.style, input.facts),
    targetDurationMs: segment.targetDurationMs,
    roleHint: segment.roleHint?.trim() || undefined,
    notes: segment.notes ?? [],
  }));

  const derivedSegments = input.style.arrangementStructure.chapterPrograms.map((program, index) => ({
    id: `segment-${index + 1}`,
    title: humanizeProgramType(program.type, index),
    intent: program.intent,
    targetDurationMs: Math.round(input.style.narrative.avgSegmentDurationSec * 1000),
    roleHint: program.materialRoles[0],
    notes: dedupeStrings([
      program.transitionBias,
      program.localNarrationNote,
      ...program.promotionSignals,
    ]),
  }));

  const seedSegments = (providedSegments.length > 0 ? providedSegments : derivedSegments);
  const orderedSpanCandidates = input.orderedSpanCandidates ?? buildOrderedSpanCandidates({
    spans: input.spans ?? [],
    chronology: input.chronology ?? [],
    pharosContext: input.pharosContext ?? null,
  });
  const timeBands = buildSegmentTimeBands(
    seedSegments.length,
    orderedSpanCandidates,
    arrangementSignals,
  );

  const segments = seedSegments
    .map((segment, index, allSegments) => ({
      ...segment,
      targetDurationMs: segment.targetDurationMs ?? inferSegmentDurationMs(
        index,
        allSegments.length,
        input.style,
        timeBands[index],
        orderedSpanCandidates,
        arrangementSignals,
      ),
    }));
  const overviewNotes = extractOverviewGuidance(input.overviewMarkdown, 6);

  return {
    id: randomUUID(),
    projectId: input.projectId,
    generatedAt: new Date().toISOString(),
    summary: `围绕 ${input.style.arrangementStructure.primaryAxis ?? '材料主轴'} 推进，共 ${segments.length} 个段落。`,
    segments,
    notes: dedupeStrings([
      ...input.brief.planReviewDraft,
      ...overviewNotes,
      ...input.style.arrangementStructure.chapterSplitPrinciples,
      ...input.style.arrangementStructure.chapterTransitionNotes,
    ]),
  };
}

export function buildMaterialSlotsDocument(input: {
  projectId: string;
  segmentPlan: ISegmentPlan;
  bundles: IMaterialBundle[];
  spans: IKtepSlice[];
  chronology: IScriptPlanningContext['chronology'];
  pharosContext: IProjectPharosContext | null;
  style: IStyleProfile;
  arrangementSignals?: IResolvedArrangementSignals;
  orderedSpanCandidates?: IOrderedSpanCandidate[];
}): IMaterialSlotsDocument {
  const spansById = new Map(input.spans.map(span => [span.id, span] as const));
  const chronologyByAssetId = new Map(input.chronology.map(item => [item.assetId, item] as const));
  const arrangementSignals = input.arrangementSignals ?? resolveArrangementSignals(input.style);
  const orderedSpanCandidates = input.orderedSpanCandidates ?? buildOrderedSpanCandidates({
    spans: input.spans,
    chronology: input.chronology,
    pharosContext: input.pharosContext,
  });
  const timeBands = buildSegmentTimeBands(
    input.segmentPlan.segments.length,
    orderedSpanCandidates,
    arrangementSignals,
  );

  return {
    id: randomUUID(),
    projectId: input.projectId,
    generatedAt: new Date().toISOString(),
    segments: input.segmentPlan.segments.map((segment, index, allSegments) => {
      const query = dedupeStrings([
        segment.title,
        segment.intent,
        segment.roleHint,
        ...segment.notes,
        input.style.arrangementStructure.chapterPrograms[index]?.intent,
      ]).join(' / ');
      const targetBundles = matchBundlesForQuery(query, input.bundles, segment, input.style);
      const chosenSpanIds = resolveChosenSpanIds({
        query,
        targetBundleIds: targetBundles,
        bundles: input.bundles,
        spansById,
        chronologyByAssetId,
        pharosContext: input.pharosContext,
        segmentIndex: index,
        segmentCount: allSegments.length,
        arrangementSignals,
        orderedSpanCandidates,
        timeBand: timeBands[index],
      });

      return {
        segmentId: segment.id,
        slots: [{
          id: `${segment.id}-slot-1`,
          query,
          requirement: 'required',
          targetBundles,
          chosenSpanIds,
        }],
      };
    }),
  };
}

export function resolveChosenSpanIds(input: {
  query: string;
  targetBundleIds: string[];
  bundles: IMaterialBundle[];
  spansById: Map<string, IKtepSlice>;
  chronologyByAssetId: Map<string, IScriptPlanningContext['chronology'][number]>;
  pharosContext: IProjectPharosContext | null;
  segmentIndex: number;
  segmentCount: number;
  arrangementSignals?: IResolvedArrangementSignals;
  orderedSpanCandidates?: IOrderedSpanCandidate[];
  timeBand?: ISegmentTimeBand;
}): string[] {
  const querySignature = normalizeSemanticText(input.query);
  const queryTokens = tokenizeSemanticText(input.query);
  const desiredPosition = input.timeBand?.centerPosition
    ?? (input.segmentCount <= 1 ? 0 : input.segmentIndex / (input.segmentCount - 1));
  const arrangementSignals = input.arrangementSignals ?? {
    primaryAxisKind: 'mixed',
    chronologyStrength: 0,
    routeContinuityStrength: 0,
    processContinuityStrength: 0,
    spaceStrength: 0,
    emotionStrength: 0,
    payoffStrength: 0,
    enforceChronology: false,
    materialRoleBias: {},
  } satisfies IResolvedArrangementSignals;
  const targeted = input.bundles.filter(bundle =>
    input.targetBundleIds.length > 0 ? input.targetBundleIds.includes(bundle.id) : true,
  );
  const candidateBundles = targeted.length > 0 ? targeted : input.bundles;
  const orderedSpanCandidates = input.orderedSpanCandidates ?? buildOrderedSpanCandidates({
    spans: [...input.spansById.values()],
    chronology: [...input.chronologyByAssetId.values()],
    pharosContext: input.pharosContext,
  });
  const candidateBySpanId = new Map(
    orderedSpanCandidates.map(candidate => [candidate.spanId, candidate] as const),
  );
  const candidateSpanIds = dedupeStrings(candidateBundles.flatMap(bundle => bundle.memberSpanIds));
  const eligibleSpanIds = resolveEligibleSpanIds(
    candidateSpanIds,
    candidateBySpanId,
    input.timeBand,
    arrangementSignals,
  );

  const scored: Array<{
    spanId: string;
    score: number;
    orderIndex: number;
    isKeyProcessVideo: boolean;
  }> = [];
  for (const bundle of candidateBundles) {
    const bundleText = `${bundle.label} ${bundle.key} ${bundle.notes.join(' ')} ${bundle.placeHints.join(' ')}`;
    const bundleScore = input.targetBundleIds.includes(bundle.id)
      ? 40
      : scoreSemanticMatch(queryTokens, normalizeSemanticText(bundleText)) * 16;

    for (const spanId of bundle.memberSpanIds) {
      if (!eligibleSpanIds.has(spanId)) continue;
      const span = input.spansById.get(spanId);
      if (!span) continue;
      const chronology = input.chronologyByAssetId.get(span.assetId);
      const candidate = candidateBySpanId.get(spanId);
      const materialScore = Math.max(
        ...span.materialPatterns.map(pattern => scoreSemanticMatch(queryTokens, normalizeSemanticText(pattern.phrase))),
        0,
      ) * 30;
      const placeScore = Math.max(
        ...span.grounding.spatialEvidence.map(evidence => scoreSemanticMatch(queryTokens, normalizeSemanticText(evidence.locationText ?? ''))),
        0,
      ) * 12;
      const transcriptScore = span.transcript
        ? scoreSemanticMatch(queryTokens, normalizeSemanticText(span.transcript)) * 8
        : 0;
      const chronologyScore = candidate
        ? scoreTimeBandFit(candidate, input.timeBand, desiredPosition, arrangementSignals) * 18
        : chronology
          ? scoreChronologyPosition(chronology, input.chronologyByAssetId, desiredPosition) * 10
          : 0;
      const pharosScore = scorePharosMatch(span, input.pharosContext, querySignature) * 12;
      const keyVideoScore = candidate?.isKeyProcessVideo
        ? 10 + arrangementSignals.processContinuityStrength * 6
        : 0;
      const sourceSpeechScore = candidate?.hasSourceSpeech ? 4 : 0;
      scored.push({
        spanId,
        score: bundleScore + materialScore + placeScore + transcriptScore + chronologyScore + pharosScore + keyVideoScore + sourceSpeechScore,
        orderIndex: candidate?.orderIndex ?? Number.MAX_SAFE_INTEGER,
        isKeyProcessVideo: candidate?.isKeyProcessVideo ?? false,
      });
    }
  }

  const ranked = scored
    .sort((left, right) => right.score - left.score || left.orderIndex - right.orderIndex);
  const selectionLimit = resolveSelectionLimit(ranked, arrangementSignals);
  const prioritized = dedupeRankedSpanIds([
    ...ranked.filter(item => item.isKeyProcessVideo).slice(0, Math.min(2, selectionLimit)),
    ...ranked,
  ]);

  const chosen = prioritized
    .slice(0, selectionLimit)
    .sort((left, right) => arrangementSignals.enforceChronology
      ? left.orderIndex - right.orderIndex || right.score - left.score
      : right.score - left.score || left.orderIndex - right.orderIndex,
    );

  return chosen.map(item => item.spanId);
}

function buildOrderedSpanCandidates(input: {
  spans: IKtepSlice[];
  chronology: IScriptPlanningContext['chronology'];
  pharosContext: IProjectPharosContext | null;
}): IOrderedSpanCandidate[] {
  const chronologyByAssetId = new Map(input.chronology.map(item => [item.assetId, item] as const));
  const pharosOrderMap = buildPharosOrderMap(input.pharosContext);

  const candidates = input.spans.map(span => {
    const chronology = chronologyByAssetId.get(span.assetId);
    const hasSourceSpeech = Boolean(span.transcript?.trim())
      || (span.transcriptSegments?.length ?? 0) > 0
      || span.grounding.speechMode === 'preferred';
    const isPhoto = span.type === 'photo';
    const sourceDurationMs = resolvePositiveDuration(span.sourceInMs, span.sourceOutMs)
      ?? (isPhoto ? 0 : 4_000);
    const keyProcessScore = resolveKeyProcessScore(span, hasSourceSpeech);

    return {
      spanId: span.id,
      assetId: span.assetId,
      sortKey: resolveSpanSortKey(span, chronology, pharosOrderMap),
      orderIndex: -1,
      orderPosition: 0,
      sourceDurationMs,
      materialCapacityMs: estimateSpanCapacityMs(span, sourceDurationMs, hasSourceSpeech, keyProcessScore),
      isPhoto,
      hasSourceSpeech,
      isKeyProcessVideo: !isPhoto && keyProcessScore >= 2,
    } satisfies IOrderedSpanCandidate;
  });

  return candidates
    .sort((left, right) => left.sortKey.localeCompare(right.sortKey))
    .map((candidate, index, all) => ({
      ...candidate,
      orderIndex: index,
      orderPosition: all.length <= 1 ? 0 : index / (all.length - 1),
    }));
}

function buildSegmentTimeBands(
  segmentCount: number,
  orderedSpanCandidates: IOrderedSpanCandidate[],
  arrangementSignals: IResolvedArrangementSignals,
): ISegmentTimeBand[] {
  if (!arrangementSignals.enforceChronology || segmentCount <= 1 || orderedSpanCandidates.length === 0) {
    return Array.from({ length: Math.max(segmentCount, 1) }, () => ({
      startPosition: 0,
      endPosition: 1,
      centerPosition: 0.5,
    }));
  }

  const padding = Math.min(0.16, Math.max(0.06, 0.45 / segmentCount));
  return Array.from({ length: segmentCount }, (_, index) => {
    const baseStart = index / segmentCount;
    const baseEnd = (index + 1) / segmentCount;
    return {
      startPosition: index === 0 ? 0 : Math.max(0, baseStart - padding),
      endPosition: index === segmentCount - 1 ? 1 : Math.min(1, baseEnd + padding),
      centerPosition: (baseStart + baseEnd) / 2,
    };
  });
}

function resolveEligibleSpanIds(
  spanIds: string[],
  candidateBySpanId: Map<string, IOrderedSpanCandidate>,
  timeBand: ISegmentTimeBand | undefined,
  arrangementSignals: IResolvedArrangementSignals,
): Set<string> {
  if (!timeBand || !arrangementSignals.enforceChronology) {
    return new Set(spanIds);
  }

  const tolerances = [0, 0.08, 0.16];
  for (const tolerance of tolerances) {
    const eligible = spanIds.filter(spanId => {
      const candidate = candidateBySpanId.get(spanId);
      if (!candidate) return true;
      return isCandidateWithinTimeBand(candidate, timeBand, arrangementSignals, tolerance);
    });
    if (eligible.length > 0) {
      return new Set(eligible);
    }
  }

  return new Set(spanIds);
}

function isCandidateWithinTimeBand(
  candidate: IOrderedSpanCandidate,
  timeBand: ISegmentTimeBand,
  arrangementSignals: IResolvedArrangementSignals,
  tolerance = 0,
): boolean {
  if (!arrangementSignals.enforceChronology) return true;
  return candidate.orderPosition >= timeBand.startPosition - tolerance
    && candidate.orderPosition <= timeBand.endPosition + tolerance;
}

function scoreTimeBandFit(
  candidate: IOrderedSpanCandidate,
  timeBand: ISegmentTimeBand | undefined,
  desiredPosition: number,
  arrangementSignals: IResolvedArrangementSignals,
): number {
  if (!arrangementSignals.enforceChronology) {
    return Math.max(0, 1 - Math.abs(candidate.orderPosition - desiredPosition));
  }
  if (!timeBand) {
    return Math.max(0, 1 - Math.abs(candidate.orderPosition - desiredPosition));
  }
  const halfWidth = Math.max(0.08, (timeBand.endPosition - timeBand.startPosition) / 2);
  return Math.max(0, 1 - Math.abs(candidate.orderPosition - timeBand.centerPosition) / halfWidth);
}

function resolveSelectionLimit(
  ranked: Array<{ isKeyProcessVideo: boolean }>,
  arrangementSignals: IResolvedArrangementSignals,
): number {
  if (!arrangementSignals.enforceChronology) return 3;
  const keyVideoCount = ranked.filter(item => item.isKeyProcessVideo).length;
  return Math.min(5, keyVideoCount >= 3 ? 4 : 3);
}

function dedupeRankedSpanIds<T extends { spanId: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of items) {
    if (seen.has(item.spanId)) continue;
    seen.add(item.spanId);
    result.push(item);
  }
  return result;
}

function buildPharosOrderMap(
  pharosContext: IProjectPharosContext | null,
): Map<string, string> {
  if (!pharosContext) return new Map();
  const tripOrder = new Map(pharosContext.trips.map((trip, index) => [trip.tripId, index] as const));
  const orderedShots = [...pharosContext.shots]
    .sort((left, right) => resolvePharosShotSortKey(left, tripOrder).localeCompare(resolvePharosShotSortKey(right, tripOrder)));

  return new Map(
    orderedShots.map((shot, index) => [
      `${shot.ref.tripId}:${shot.ref.shotId}`,
      `${String(index).padStart(6, '0')}|${resolvePharosShotSortKey(shot, tripOrder)}`,
    ] as const),
  );
}

function resolveSpanSortKey(
  span: IKtepSlice,
  chronology: IScriptPlanningContext['chronology'][number] | undefined,
  pharosOrderMap: Map<string, string>,
): string {
  const chronologyKey = normalizeChronologyKey(chronology?.sortCapturedAt ?? chronology?.capturedAt);
  if (chronologyKey) {
    return `0|${chronologyKey}|${padMs(span.sourceInMs)}|${span.id}`;
  }

  const pharosRefs = span.pharosRefs ?? [];
  const pharosKey = pharosRefs
    .map(ref => pharosOrderMap.get(`${ref.tripId}:${ref.shotId}`))
    .filter((value): value is string => typeof value === 'string')
    .sort()[0];
  if (pharosKey) {
    return `1|${pharosKey}|${padMs(span.sourceInMs)}|${span.id}`;
  }

  return `2|${span.assetId}|${padMs(span.sourceInMs)}|${span.id}`;
}

function resolvePharosShotSortKey(
  shot: IProjectPharosContext['shots'][number],
  tripOrder: Map<string, number>,
): string {
  const tripIndex = String(tripOrder.get(shot.ref.tripId) ?? Number.MAX_SAFE_INTEGER).padStart(6, '0');
  const timeKey = normalizeChronologyKey(
    shot.actualTimeStart
    ?? shot.timeWindowStart
    ?? shot.actualTimeEnd
    ?? shot.timeWindowEnd
    ?? shot.date,
  ) ?? '9999-12-31t23:59:59.999z';
  const dayKey = String(shot.day ?? Number.MAX_SAFE_INTEGER).padStart(4, '0');
  return `${tripIndex}|${timeKey}|${dayKey}|${shot.ref.shotId}`;
}

function resolveKeyProcessScore(
  span: IKtepSlice,
  hasSourceSpeech: boolean,
): number {
  let score = 0;
  if (hasSourceSpeech) score += 2;
  if (span.pharosRefs?.length) score += 1;
  if (span.type === 'drive' || span.type === 'talking-head' || span.type === 'shot') score += 1;
  if (span.grounding.spatialEvidence.some(evidence => evidence.routeRole || evidence.timeReference)) score += 1;

  const processText = normalizeSemanticText([
    span.transcript ?? '',
    ...span.materialPatterns.map(pattern => pattern.phrase),
    ...span.grounding.spatialEvidence.map(evidence => evidence.locationText ?? ''),
  ].join(' '));
  if (
    /(接人|会合|到场|出发|抵达|返程|路上|准备|进入|拍摄|沟通|聊天)/u.test(processText)
    || /(route|drive|arrive|depart|meet|pickup|return|start|enter)/u.test(processText)
  ) {
    score += 1;
  }

  return score;
}

function estimateSpanCapacityMs(
  span: IKtepSlice,
  sourceDurationMs: number,
  hasSourceSpeech: boolean,
  keyProcessScore: number,
): number {
  if (span.type === 'photo') {
    return 1_500;
  }

  let capacityMs = clampInt(sourceDurationMs || 3_500, 1_500, 6_500);
  if (hasSourceSpeech) {
    capacityMs = Math.max(capacityMs, 3_000);
  }
  capacityMs += Math.min(keyProcessScore, 3) * 600;
  return capacityMs;
}

function normalizeChronologyKey(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const ms = Date.parse(trimmed);
  if (!Number.isFinite(ms)) return undefined;
  return new Date(ms).toISOString().toLowerCase();
}

function resolvePositiveDuration(startMs?: number, endMs?: number): number | undefined {
  if (typeof startMs !== 'number' || typeof endMs !== 'number') return undefined;
  if (endMs <= startMs) return undefined;
  return endMs - startMs;
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}

function padMs(value?: number): string {
  const safe = typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
  return String(safe).padStart(9, '0');
}

async function ensureMaterialFactsAndBundles(projectRoot: string): Promise<{
  context: IScriptPlanningContext;
  facts: IProjectMaterialOverviewFacts;
  bundles: IMaterialBundle[];
}> {
  const context = await loadScriptPlanningContext(projectRoot);
  const facts = buildProjectMaterialOverviewFacts(context);
  const bundles = buildMaterialBundles(context.spans, context.chronology, context.pharosContext);

  await Promise.all([
    writeMaterialOverviewFacts(projectRoot, facts),
    writeMaterialBundles(projectRoot, bundles),
  ]);

  return { context, facts, bundles };
}

async function loadScriptPlanningContext(projectRoot: string): Promise<IScriptPlanningContext> {
  const [project, projectBrief, assets, spans, chronology, pharosContext] = await Promise.all([
    loadProject(projectRoot),
    loadProjectBriefConfig(projectRoot),
    loadAssets(projectRoot),
    loadSpans(projectRoot),
    loadChronology(projectRoot),
    loadProjectPharosContext(projectRoot),
  ]);

  return {
    project,
    projectBrief,
    assets,
    spans,
    chronology,
    pharosContext,
  };
}

async function resolveStyle(
  projectRoot: string,
  workspaceRoot?: string,
  styleCategory?: string,
): Promise<IStyleProfile> {
  if (!workspaceRoot) {
    throw new Error('workspaceRoot is required to resolve style profile');
  }
  const brief = await loadScriptBriefConfig(projectRoot);
  const category = styleCategory ?? brief.styleCategory;
  if (!category) {
    throw new Error('styleCategory is required to resolve style profile');
  }
  return loadProjectStyleByCategory(workspaceRoot, category);
}

async function clearObsoleteArrangementArtifacts(projectRoot: string): Promise<void> {
  await Promise.all([
    rm(`${projectRoot}/analysis/material-digest.json`, { force: true }),
    rm(`${projectRoot}/analysis/motif-bundles.json`, { force: true }),
    rm(`${projectRoot}/script/segment-plan.drafts.json`, { force: true }),
    rm(`${projectRoot}/script/segment-plan.approved.json`, { force: true }),
    rm(`${projectRoot}/script/segment-candidates.json`, { force: true }),
    rm(`${projectRoot}/script/arrangement-skeletons.json`, { force: true }),
    rm(`${projectRoot}/script/segment-cards.json`, { force: true }),
    rm(`${projectRoot}/script/arrangement.current.json`, { force: true }),
  ]);
}

function buildMaterialOverviewPharosSummary(
  context: IProjectPharosContext,
  totalAssets: number,
): IProjectMaterialOverviewFacts['pharos'] {
  const includedTripIds = new Set(context.includedTripIds);
  const trips = context.trips
    .filter(trip => includedTripIds.size === 0 || includedTripIds.has(trip.tripId))
    .map(trip => ({
      tripId: trip.tripId,
      title: trip.title,
      tripKind: trip.tripKind,
      revision: trip.revision,
      dateStart: trip.dateStart,
      dateEnd: trip.dateEnd,
      mustCount: trip.mustCount,
      optionalCount: trip.optionalCount,
      pendingCount: trip.pendingCount,
      abandonedCount: trip.abandonedCount,
      matchedAssetCount: context.shots.filter(shot =>
        shot.ref.tripId === trip.tripId && (shot.status === 'expected' || shot.status === 'unexpected'),
      ).length,
    }));

  const matchedAssetCount = context.shots.filter(shot =>
    shot.status === 'expected' || shot.status === 'unexpected',
  ).length;

  return {
    status: context.status,
    fallbackMode: true,
    discoveredTripCount: context.discoveredTripIds.length,
    includedTripCount: context.includedTripIds.length || context.trips.length,
    matchedAssetCount,
    unmatchedAssetCount: Math.max(0, totalAssets - matchedAssetCount),
    pendingShotCount: context.shots.filter(shot => shot.status === 'pending').length,
    abandonedShotCount: context.shots.filter(shot => shot.status === 'abandoned').length,
    warnings: context.warnings,
    errors: context.errors,
    trips,
  };
}

function buildRootSummary(
  assetCount: number,
  placeHints: string[],
  materialPatterns: string[],
): string {
  return [
    `${assetCount} 条素材`,
    placeHints.length > 0 ? `地点集中在 ${pickTopValues(placeHints, 3).join(' / ')}` : '',
    materialPatterns.length > 0 ? `常见材料模式 ${pickTopValues(materialPatterns, 3).join(' / ')}` : '',
  ].filter(Boolean).join('，');
}

function extractOverviewGuidance(markdown: string, limit: number): string[] {
  return markdown
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.startsWith('- '))
    .map(line => line.slice(2).trim())
    .filter(Boolean)
    .slice(0, limit);
}

function ensureScriptGenerationWorkflowState(workflowState: string | undefined): void {
  if (workflowState === 'ready_for_agent' || workflowState === 'script_generated') {
    return;
  }
  throw new Error(
    `script generation requires script-brief.workflowState=ready_for_agent (current: ${workflowState ?? 'unknown'})`,
  );
}

function resolveBundleKey(span: IKtepSlice): string {
  const topPattern = span.materialPatterns[0]?.phrase?.trim();
  if (topPattern) return topPattern;
  const topLocation = span.grounding.spatialEvidence.find(item => item.locationText)?.locationText;
  if (topLocation) return `${span.type}:${topLocation}`;
  return `type:${span.type}`;
}

function resolveBundleLabel(
  key: string,
  members: IKtepSlice[],
  pharosShotByRef: Map<string, IProjectPharosContext['shots'][number]>,
): string {
  const firstRef = members.flatMap(span => span.pharosRefs ?? [])[0];
  if (firstRef) {
    const shot = pharosShotByRef.get(`${firstRef.tripId}:${firstRef.shotId}`);
    if (shot?.location) {
      return `${key} / ${shot.location}`;
    }
  }
  return key;
}

function scoreRepresentativeSpan(span: IKtepSlice): number {
  return (
    (span.transcript?.trim() ? 8 : 0)
    + span.materialPatterns.length * 3
    + span.grounding.spatialEvidence.length * 2
    + (span.speedCandidate ? 1 : 0)
  );
}

function inferSegmentIntent(
  segmentId: string,
  style: IStyleProfile,
  facts: IProjectMaterialOverviewFacts,
): string {
  const program = style.arrangementStructure.chapterPrograms[0];
  return program?.intent
    ?? `围绕 ${style.arrangementStructure.primaryAxis ?? facts.mainThemes[0] ?? segmentId} 推进该段。`;
}

function humanizeProgramType(type: string, index: number): string {
  const trimmed = type.trim();
  if (!trimmed) return `章节 ${index + 1}`;
  return trimmed.replace(/[-_]/g, ' ');
}

function inferSegmentDurationMs(
  index: number,
  total: number,
  style: IStyleProfile,
  timeBand?: ISegmentTimeBand,
  orderedSpanCandidates: IOrderedSpanCandidate[] = [],
  arrangementSignals?: IResolvedArrangementSignals,
): number {
  const base = inferStyleSegmentDurationMs(index, total, style);
  if (!timeBand || orderedSpanCandidates.length === 0 || !arrangementSignals) {
    return base;
  }
  const bandCandidates = orderedSpanCandidates
    .filter(candidate => isCandidateWithinTimeBand(candidate, timeBand, arrangementSignals, 0.06));
  if (bandCandidates.length === 0) return base;

  const ranked = [...bandCandidates]
    .sort((left, right) =>
      Number(right.isKeyProcessVideo) - Number(left.isKeyProcessVideo)
      || Number(right.hasSourceSpeech) - Number(left.hasSourceSpeech)
      || right.materialCapacityMs - left.materialCapacityMs
      || left.orderIndex - right.orderIndex,
    )
    .slice(0, Math.min(5, bandCandidates.length));
  const materialDriven = ranked.reduce((sum, candidate) => sum + candidate.materialCapacityMs, 0);
  const floor = Math.max(8_000, Math.round(base * 0.65));
  const ceiling = Math.max(floor, Math.round(base * 2.25));
  return Math.max(floor, Math.min(materialDriven, ceiling));
}

function inferStyleSegmentDurationMs(
  index: number,
  total: number,
  style: IStyleProfile,
): number {
  const base = Math.round(style.narrative.avgSegmentDurationSec * 1000);
  if (index === 0) return Math.max(base, Math.round(base * (1 + style.narrative.introRatio)));
  if (index === total - 1) return Math.max(base, Math.round(base * (1 + style.narrative.outroRatio)));
  return base;
}

function matchBundlesForQuery(
  query: string,
  bundles: IMaterialBundle[],
  segment: ISegmentPlan['segments'][number],
  style: IStyleProfile,
): string[] {
  const programHints = style.arrangementStructure.chapterPrograms.find(program =>
    program.intent === segment.intent || program.type === segment.title,
  );
  const tokens = tokenizeSemanticText([
    query,
    ...(programHints?.promotionSignals ?? []),
    ...(programHints?.materialRoles ?? []),
  ].join(' '));

  return bundles
    .map(bundle => ({
      bundle,
      score: scoreSemanticMatch(tokens, normalizeSemanticText([
        bundle.label,
        bundle.key,
        ...bundle.notes,
        ...bundle.placeHints,
      ].join(' '))),
    }))
    .filter(item => item.score > 0.15)
    .sort((left, right) => right.score - left.score)
    .slice(0, 5)
    .map(item => item.bundle.id);
}

function scoreSemanticMatch(tokens: string[], haystack: string): number {
  if (!haystack || tokens.length === 0) return 0;
  const matches = tokens.filter(token => haystack.includes(token)).length;
  return matches / tokens.length;
}

function scoreChronologyPosition(
  chronology: IScriptPlanningContext['chronology'][number],
  chronologyByAssetId: Map<string, IScriptPlanningContext['chronology'][number]>,
  desiredPosition: number,
): number {
  const ordered = [...chronologyByAssetId.values()]
    .sort((left, right) => String(left.sortCapturedAt ?? left.capturedAt ?? '').localeCompare(String(right.sortCapturedAt ?? right.capturedAt ?? '')));
  const index = ordered.findIndex(item => item.assetId === chronology.assetId);
  if (index < 0 || ordered.length <= 1) return 0;
  const actualPosition = index / (ordered.length - 1);
  return Math.max(0, 1 - Math.abs(actualPosition - desiredPosition));
}

function scorePharosMatch(
  span: IKtepSlice,
  pharosContext: IProjectPharosContext | null,
  querySignature: string,
): number {
  if (!pharosContext || !span.pharosRefs?.length) return 0;
  const shotsByRef = new Map(
    pharosContext.shots.map(shot => [`${shot.ref.tripId}:${shot.ref.shotId}`, shot] as const),
  );
  let best = 0;
  for (const ref of span.pharosRefs) {
    const shot = shotsByRef.get(`${ref.tripId}:${ref.shotId}`);
    if (!shot) continue;
    const signature = normalizeSemanticText([
      shot.tripTitle,
      shot.dayTitle,
      shot.location,
      shot.description,
      shot.type,
    ].filter(Boolean).join(' '));
    best = Math.max(best, signature.includes(querySignature) ? 1 : scoreSemanticMatch(tokenizeSemanticText(signature), querySignature));
  }
  return best;
}

function pickTopValues(values: string[], limit: number): string[] {
  const counts = new Map<string, number>();
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    counts.set(trimmed, (counts.get(trimmed) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, limit)
    .map(([value]) => value);
}

function tokenizeSemanticText(value: string): string[] {
  const normalized = normalizeSemanticText(value);
  if (!normalized) return [];
  const asciiTokens = value
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .map(token => token.trim())
    .filter(token => token.length >= 3);
  const bigrams: string[] = [];
  for (let index = 0; index < normalized.length - 1; index += 1) {
    bigrams.push(normalized.slice(index, index + 2));
  }
  return [...new Set([...asciiTokens, ...bigrams])];
}

function normalizeSemanticText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[，。！？；：、,.!?;:()[\]{}"'`~\-_/\\\s]+/gu, '');
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/gu, '-')
    .replace(/-+/gu, '-')
    .replace(/^-|-$/gu, '')
    .slice(0, 64);
}

function dedupeStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.map(value => value?.trim()).filter(Boolean) as string[])];
}
