import { randomUUID } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import type {
  IAgentContract,
  IAgentPacket,
  IAgentPipelineState,
  IKtepScript,
  IKtepSlice,
  IMaterialBundle,
  IMaterialSlotsDocument,
  IPharosRef,
  IProjectMaterialOverviewFacts,
  IProjectPharosContext,
  ISpatialStoryContext,
  IStageReview,
  ISegmentPlan,
  IStyleProfile,
} from '../../protocol/schema.js';
import type { ILlmClient } from '../llm/client.js';
import {
  computeScriptBriefFingerprint,
  getMaterialBundlesPath,
  getMaterialOverviewFactsPath,
  getMaterialOverviewPath,
  getMaterialSlotsPath,
  getCurrentScriptPath,
  getOutlinePromptPath,
  getScriptAgentContractPath,
  getScriptReviewPath,
  getScriptBriefPath,
  getSpatialStoryMarkdownPath,
  getSpatialStoryPath,
  getSegmentPlanPath,
  loadCurrentScript,
  loadAssets,
  loadChronology,
  loadScriptAgentContract,
  loadOptionalMarkdown,
  loadProject,
  loadProjectBriefConfig,
  loadProjectPharosContext,
  loadScriptBriefConfig,
  loadSpans,
  saveScriptBriefConfig,
  writeScriptAgentContract,
  writeScriptAgentPacket,
  writeScriptAgentPipeline,
  writeScriptStageReview,
  writeCurrentScript,
  writeMaterialBundles,
  writeMaterialOverviewFacts,
  writeMaterialSlots,
  writeOutline,
  writeScriptBriefTemplate,
  writeSegmentPlan,
  writeSpatialStory,
} from '../../store/index.js';
import { runJsonPacketAgent } from '../agents/runtime.js';
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

const CSCRIPT_REVIEW_CODES = [
  'missing_requirements',
  'unsupported_claims',
  'gps_story_drift',
  'style_drift',
  'chronology_risk',
  'pharos_mismatch',
  'scope_violation',
] as const;

export interface IDraftProjectScriptOverviewAndBriefInput {
  projectRoot: string;
  llm: ILlmClient;
  workspaceRoot?: string;
  styleCategory?: string;
  style?: IStyleProfile;
}

export interface IDraftProjectScriptOverviewAndBriefResult {
  materialOverviewPath: string;
  scriptBriefPath: string;
  spatialStoryPath: string;
  workflowState: 'review_brief';
}

export async function draftProjectScriptOverviewAndBrief(
  input: IDraftProjectScriptOverviewAndBriefInput,
): Promise<IDraftProjectScriptOverviewAndBriefResult> {
  const style = input.style
    ?? await resolveStyle(input.projectRoot, input.workspaceRoot, input.styleCategory);
  const context = await loadScriptPlanningContext(input.projectRoot);
  const existingBrief = await loadScriptBriefConfig(input.projectRoot);
  const arrangementSignals = resolveArrangementSignals(style);
  const spatialStory = buildSpatialStoryContext(context);
  const facts = enrichMaterialOverviewFactsWithSpatialStory(
    buildProjectMaterialOverviewFacts(context),
    spatialStory,
  );
  const bundles = buildMaterialBundles(context.spans, context.chronology, context.pharosContext);

  await Promise.all([
    writeMaterialOverviewFacts(input.projectRoot, facts),
    writeMaterialBundles(input.projectRoot, bundles),
    writeSpatialStory(input.projectRoot, spatialStory),
    writeFile(getSpatialStoryMarkdownPath(input.projectRoot), buildSpatialStoryMarkdown(spatialStory), 'utf-8'),
  ]);

  const overviewStage = await runReviewedScriptStage<{ markdown: string }>({
    llm: input.llm,
    projectRoot: input.projectRoot,
    stage: 'material-overview',
    writerIdentity: 'overview-cartographer',
    baseDraft: {
      markdown: buildMaterialOverviewMarkdown(facts),
    },
    buildWriterPacket: (revisionBrief, previousDraft) => ({
      stage: 'material-overview',
      identity: 'overview-cartographer',
      mission: '把项目当前材料边界、空间推进线索与缺口整理成 material overview。',
      hardConstraints: [
        '只整理事实，不设计章节结构。',
        '缺证据时必须保守，不把弱线索写成确定事实。',
      ],
      allowedInputs: [
        'script/material-overview.facts.json',
        'script/spatial-story.json',
        'config/project-brief.json',
      ],
      inputArtifacts: [
        {
          label: 'material-overview-facts',
          path: getMaterialOverviewFactsPath(input.projectRoot),
          summary: facts.summary,
          content: facts,
        },
        {
          label: 'spatial-story',
          path: getSpatialStoryPath(input.projectRoot),
          summary: spatialStory.narrativeHints.map(item => item.title).join(' / '),
          content: spatialStory,
        },
        {
          label: 'project-brief',
          summary: context.projectBrief.description,
          content: context.projectBrief,
        },
        revisionBrief.length > 0 ? {
          label: 'revision-brief',
          summary: revisionBrief.join(' / '),
          content: revisionBrief,
        } : null,
        previousDraft ? {
          label: 'previous-draft',
          summary: '上一轮 overview 草稿。',
          content: previousDraft,
        } : null,
      ].filter((item): item is NonNullable<typeof item> => item != null),
      outputSchema: {
        markdown: 'string',
      },
      reviewRubric: [...CSCRIPT_REVIEW_CODES],
    }),
    buildReviewPacket: (draft, attempt) => ({
      stage: 'review-material-overview',
      identity: 'script-reviewer',
      mission: '审查 material overview 是否遗漏关键要求、是否事实漂移、是否弱化空间推进线索。',
      hardConstraints: [
        '只审查当前阶段草稿，不直接改写。',
        '只根据 packet 中的事实与 rubric 判定 blocker / warning。',
      ],
      allowedInputs: [
        'material-overview-facts',
        'spatial-story',
        'overview draft',
      ],
      inputArtifacts: [
        {
          label: 'material-overview-facts',
          path: getMaterialOverviewFactsPath(input.projectRoot),
          summary: facts.summary,
          content: facts,
        },
        {
          label: 'spatial-story',
          path: getSpatialStoryPath(input.projectRoot),
          summary: spatialStory.narrativeHints.map(item => item.title).join(' / '),
          content: spatialStory,
        },
        {
          label: 'overview-draft',
          path: getMaterialOverviewPath(input.projectRoot),
          summary: `第 ${attempt} 轮 overview 草稿。`,
          content: draft,
        },
      ],
      outputSchema: {
        verdict: 'pass | revise | awaiting_user',
        issues: 'Array<{ code, severity, message, details? }>',
        revisionBrief: 'string[]',
      },
      reviewRubric: [...CSCRIPT_REVIEW_CODES],
    }),
    persistDraft: async draft => {
      await writeFile(getMaterialOverviewPath(input.projectRoot), draft.markdown.trim(), 'utf-8');
    },
  });

  const briefBaseDraft = buildFallbackBriefDraft(existingBrief, style, facts);
  const briefStage = await runReviewedScriptStage<{
    goalDraft: string[];
    constraintDraft: string[];
    planReviewDraft: string[];
    segments: Array<{
      segmentId: string;
      title?: string;
      roleHint?: string;
      targetDurationMs?: number;
      intent?: string;
      notes?: string[];
    }>;
  }>({
    llm: input.llm,
    projectRoot: input.projectRoot,
    stage: 'script-brief',
    writerIdentity: 'brief-editor',
    baseDraft: briefBaseDraft,
    buildWriterPacket: (revisionBrief, previousDraft) => ({
      stage: 'script-brief',
      identity: 'brief-editor',
      mission: '把项目目标、风格约束、空间叙事提示和材料边界压成可执行的 script brief 草稿。',
      hardConstraints: [
        '只输出结构化 brief，不直接写 beat 或正式脚本。',
        '缺证据时必须保守，不编造不存在的旅程节点或主题。',
      ],
      allowedInputs: [
        'material overview',
        'style profile',
        'project brief',
        'spatial-story',
      ],
      inputArtifacts: [
        {
          label: 'material-overview',
          path: getMaterialOverviewPath(input.projectRoot),
          summary: '已审核通过的 material overview。',
          content: overviewStage.draft,
        },
        {
          label: 'style-profile',
          summary: style.narrative.pacePattern,
          content: {
            arrangementStructure: style.arrangementStructure,
            narrationConstraints: style.narrationConstraints,
            antiPatterns: style.antiPatterns,
            parameters: style.parameters,
          },
        },
        {
          label: 'project-brief',
          summary: context.projectBrief.description,
          content: context.projectBrief,
        },
        {
          label: 'spatial-story',
          path: getSpatialStoryPath(input.projectRoot),
          summary: spatialStory.narrativeHints.map(item => item.title).join(' / '),
          content: spatialStory,
        },
        revisionBrief.length > 0 ? {
          label: 'revision-brief',
          summary: revisionBrief.join(' / '),
          content: revisionBrief,
        } : null,
        previousDraft ? {
          label: 'previous-draft',
          summary: '上一轮 brief 草稿。',
          content: previousDraft,
        } : null,
      ].filter((item): item is NonNullable<typeof item> => item != null),
      outputSchema: {
        goalDraft: 'string[]',
        constraintDraft: 'string[]',
        planReviewDraft: 'string[]',
        segments: 'Array<{ segmentId, title?, roleHint?, targetDurationMs?, intent?, notes? }>',
      },
      reviewRubric: [...CSCRIPT_REVIEW_CODES],
    }),
    buildReviewPacket: (draft, attempt) => ({
      stage: 'review-script-brief',
      identity: 'script-reviewer',
      mission: '审查 brief 是否遗漏目标、约束、空间叙事要求和风格禁区。',
      hardConstraints: [
        '只审查 brief 草稿，不直接改写。',
        'blocker 必须附 revisionBrief。',
      ],
      allowedInputs: [
        'material overview',
        'style profile',
        'spatial-story',
        'brief draft',
      ],
      inputArtifacts: [
        {
          label: 'material-overview',
          path: getMaterialOverviewPath(input.projectRoot),
          summary: '已审核通过的 material overview。',
          content: overviewStage.draft,
        },
        {
          label: 'style-profile',
          summary: style.narrative.pacePattern,
          content: {
            arrangementStructure: style.arrangementStructure,
            narrationConstraints: style.narrationConstraints,
            antiPatterns: style.antiPatterns,
            parameters: style.parameters,
          },
        },
        {
          label: 'spatial-story',
          path: getSpatialStoryPath(input.projectRoot),
          summary: spatialStory.narrativeHints.map(item => item.title).join(' / '),
          content: spatialStory,
        },
        {
          label: 'brief-draft',
          path: getScriptBriefPath(input.projectRoot),
          summary: `第 ${attempt} 轮 brief 草稿。`,
          content: draft,
        },
      ],
      outputSchema: {
        verdict: 'pass | revise | awaiting_user',
        issues: 'Array<{ code, severity, message, details? }>',
        revisionBrief: 'string[]',
      },
      reviewRubric: [...CSCRIPT_REVIEW_CODES],
    }),
    persistDraft: async draft => {
      const nextConfig = {
        ...existingBrief,
        projectName: existingBrief.projectName?.trim() || context.project.name,
        styleCategory: input.styleCategory ?? existingBrief.styleCategory,
        workflowState: 'review_brief' as const,
        lastAgentDraftAt: new Date().toISOString(),
        lastUserReviewAt: undefined,
        goalDraft: dedupeStrings(draft.goalDraft),
        constraintDraft: dedupeStrings(draft.constraintDraft),
        planReviewDraft: dedupeStrings(draft.planReviewDraft),
        segments: (draft.segments ?? []).map(segment => ({
          segmentId: segment.segmentId,
          title: segment.title?.trim() || undefined,
          roleHint: segment.roleHint?.trim() || undefined,
          targetDurationMs: segment.targetDurationMs,
          intent: segment.intent?.trim() || undefined,
          notes: dedupeStrings(segment.notes ?? []),
        })),
      };
      nextConfig.lastAgentDraftFingerprint = computeScriptBriefFingerprint(nextConfig);
      await saveScriptBriefConfig(input.projectRoot, nextConfig);
      await writeScriptBriefTemplate(input.projectRoot, {
        ...nextConfig,
        workflowState: 'review_brief',
      });
    },
  });

  return {
    materialOverviewPath: getMaterialOverviewPath(input.projectRoot),
    scriptBriefPath: getScriptBriefPath(input.projectRoot),
    spatialStoryPath: getSpatialStoryPath(input.projectRoot),
    workflowState: 'review_brief',
  };
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

  const style = await loadStyleByCategory(`${input.workspaceRoot}/config/styles`, styleCategory);
  const overviewMarkdown = await loadOptionalMarkdown(getMaterialOverviewPath(input.projectRoot));
  if (!overviewMarkdown?.trim()) {
    throw new Error('script prep requires script/material-overview.md');
  }

  const prepared = await ensureMaterialFactsAndBundles(input.projectRoot);
  const spatialStory = buildSpatialStoryContext(prepared.context);
  const factsWithSpatialStory = enrichMaterialOverviewFactsWithSpatialStory(
    prepared.facts,
    spatialStory,
  );
  const contract = buildScriptAgentContract({
    brief: scriptBriefConfig,
    style,
    spatialStory,
    chronology: prepared.context.chronology,
    pharosContext: prepared.context.pharosContext,
  });
  await clearObsoleteArrangementArtifacts(input.projectRoot);

  await Promise.all([
    writeMaterialOverviewFacts(input.projectRoot, factsWithSpatialStory),
    writeSpatialStory(input.projectRoot, spatialStory),
    writeFile(getSpatialStoryMarkdownPath(input.projectRoot), buildSpatialStoryMarkdown(spatialStory), 'utf-8'),
    writeScriptAgentContract(input.projectRoot, contract),
    writeScriptAgentPipeline(input.projectRoot, {
      currentStage: 'segment-plan',
      stageStatus: 'pending',
      attemptCount: 0,
      latestReviewResult: undefined,
      blockerSummary: [],
      updatedAt: new Date().toISOString(),
    }),
    saveScriptBriefConfig(input.projectRoot, {
      ...scriptBriefConfig,
      projectName: scriptBriefConfig.projectName?.trim() || prepared.context.project.name,
      styleCategory,
      workflowState: 'ready_for_agent',
      segments: scriptBriefConfig.segments.map(segment => ({
        ...segment,
        roleHint: segment.roleHint?.trim() || undefined,
        notes: segment.notes ?? [],
      })),
    }),
  ]);

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
      ? '事实刷新、spatial-story、agent-contract 与 bundle 索引已完成。请回到 Agent，用各自 stage packet 继续生成 segment-plan、material-slots 与 script/current.json。'
      : '事实刷新、spatial-story、agent-contract 与 bundle 索引已完成。请回到 Agent 先补齐 script/material-overview.md，再用 stage packet 继续生成 segment-plan、material-slots 与 script/current.json。',
  };
}

export async function generateProjectScriptFromPlanning(
  input: IGenerateProjectScriptInput,
): Promise<IKtepScript[]> {
  const brief = await loadScriptBriefConfig(input.projectRoot);
  ensureScriptGenerationWorkflowState(brief.workflowState);
  const prepared = await ensureMaterialFactsAndBundles(input.projectRoot);
  const materialOverview = await loadOptionalMarkdown(getMaterialOverviewPath(input.projectRoot));
  if (!materialOverview?.trim()) {
    throw new Error('script generation requires script/material-overview.md');
  }
  const arrangementSignals = resolveArrangementSignals(input.style);
  const orderedSpanCandidates = buildOrderedSpanCandidates({
    spans: prepared.context.spans,
    chronology: prepared.context.chronology,
    pharosContext: prepared.context.pharosContext,
  });
  const spatialStory = await ensureSpatialStory(input.projectRoot, prepared.context, prepared.facts);
  const contract = await ensureScriptAgentContract(
    input.projectRoot,
    brief,
    input.style,
    spatialStory,
    prepared.context.chronology,
    prepared.context.pharosContext,
  );

  const baseSegmentPlan = buildSegmentPlanDocument({
    projectId: prepared.context.project.id,
    brief,
    style: input.style,
    facts: enrichMaterialOverviewFactsWithSpatialStory(prepared.facts, spatialStory),
    overviewMarkdown: materialOverview,
    spans: prepared.context.spans,
    chronology: prepared.context.chronology,
    pharosContext: prepared.context.pharosContext,
    arrangementSignals,
    orderedSpanCandidates,
  });
  const segmentStage = await runReviewedScriptStage<ISegmentPlan>({
    llm: input.llm,
    projectRoot: input.projectRoot,
    stage: 'segment-plan',
    writerIdentity: 'segment-architect',
    baseDraft: baseSegmentPlan,
    buildWriterPacket: (revisionBrief, previousDraft) => buildSegmentPlanPacket({
      projectRoot: input.projectRoot,
      contract,
      style: input.style,
      materialOverview,
      facts: prepared.facts,
      spatialStory,
      brief,
      baseDraft: previousDraft ?? baseSegmentPlan,
      revisionBrief,
    }),
    buildReviewPacket: (draft, attempt) => buildScriptReviewPacket({
      projectRoot: input.projectRoot,
      stage: 'segment-plan',
      contract,
      supportingArtifacts: [
        {
          label: 'material-overview',
          path: getMaterialOverviewPath(input.projectRoot),
          summary: '已审核通过的 material overview。',
          content: { markdown: materialOverview },
        },
        {
          label: 'spatial-story',
          path: getSpatialStoryPath(input.projectRoot),
          summary: spatialStory.narrativeHints.map(item => item.title).join(' / '),
          content: spatialStory,
        },
      ],
      draft,
      attempt,
    }),
    persistDraft: draft => writeSegmentPlan(input.projectRoot, draft),
  });

  const baseMaterialSlots = buildMaterialSlotsDocument({
    projectId: prepared.context.project.id,
    segmentPlan: segmentStage.draft,
    bundles: prepared.bundles,
    spans: prepared.context.spans,
    chronology: prepared.context.chronology,
    pharosContext: prepared.context.pharosContext,
    style: input.style,
    arrangementSignals,
    orderedSpanCandidates,
  });
  const materialSlotsStage = await runReviewedScriptStage<IMaterialSlotsDocument>({
    llm: input.llm,
    projectRoot: input.projectRoot,
    stage: 'material-slots',
    writerIdentity: 'route-slot-planner',
    baseDraft: baseMaterialSlots,
    buildWriterPacket: (revisionBrief, previousDraft) => buildMaterialSlotsPacket({
      projectRoot: input.projectRoot,
      contract,
      style: input.style,
      spatialStory,
      segmentPlan: segmentStage.draft,
      bundles: prepared.bundles,
      spans: prepared.context.spans,
      chronology: prepared.context.chronology,
      baseDraft: previousDraft ?? baseMaterialSlots,
      revisionBrief,
    }),
    buildReviewPacket: (draft, attempt) => buildScriptReviewPacket({
      projectRoot: input.projectRoot,
      stage: 'material-slots',
      contract,
      supportingArtifacts: [
        {
          label: 'segment-plan',
          path: getSegmentPlanPath(input.projectRoot),
          summary: segmentStage.draft.summary,
          content: segmentStage.draft,
        },
        {
          label: 'spatial-story',
          path: getSpatialStoryPath(input.projectRoot),
          summary: spatialStory.narrativeHints.map(item => item.title).join(' / '),
          content: spatialStory,
        },
      ],
      draft,
      attempt,
    }),
    persistDraft: draft => writeMaterialSlots(input.projectRoot, draft),
  });

  const outline = buildOutline({
    segmentPlan: segmentStage.draft,
    materialSlots: materialSlotsStage.draft,
    spansById: new Map(prepared.context.spans.map(span => [span.id, span] as const)),
  });
  await Promise.all([
    writeOutline(input.projectRoot, outline),
    writeFile(getOutlinePromptPath(input.projectRoot), buildOutlinePrompt(outline), 'utf-8'),
  ]);

  const baseScript = await generateScript(input.llm, outline, input.style, {
    materialOverview,
    brief: {
      goals: brief.goalDraft,
      constraints: brief.constraintDraft,
      planReviewNotes: brief.planReviewDraft,
    },
    contract,
    spatialStory,
    stage: 'script-current',
  });
  const scriptStage = await runReviewedScriptStage<IKtepScript[]>({
    llm: input.llm,
    projectRoot: input.projectRoot,
    stage: 'script-current',
    writerIdentity: 'beat-writer',
    baseDraft: baseScript,
    buildWriterPacket: (revisionBrief, previousDraft) => buildScriptCurrentPacket({
      projectRoot: input.projectRoot,
      contract,
      style: input.style,
      materialOverview,
      spatialStory,
      outline,
      baseDraft: previousDraft ?? baseScript,
      revisionBrief,
    }),
    buildReviewPacket: (draft, attempt) => buildScriptReviewPacket({
      projectRoot: input.projectRoot,
      stage: 'script-current',
      contract,
      supportingArtifacts: [
        {
          label: 'outline',
          summary: `${outline.length} 个段落的 outline。`,
          content: outline,
        },
        {
          label: 'spatial-story',
          path: getSpatialStoryPath(input.projectRoot),
          summary: spatialStory.narrativeHints.map(item => item.title).join(' / '),
          content: spatialStory,
        },
      ],
      draft,
      attempt,
    }),
    persistDraft: draft => writeCurrentScript(input.projectRoot, draft),
  });

  await Promise.all([
    writeScriptAgentPipeline(input.projectRoot, {
      currentStage: 'script-current',
      stageStatus: 'completed',
      attemptCount: 1,
      latestReviewResult: 'pass',
      blockerSummary: [],
      updatedAt: new Date().toISOString(),
    }),
    saveScriptBriefConfig(input.projectRoot, {
      ...brief,
      workflowState: 'script_generated',
    }),
  ]);

  return scriptStage.draft;
}

export async function loadProjectStyleByCategory(
  workspaceRoot: string,
  category: string,
) : Promise<IStyleProfile> {
  return loadStyleByCategory(`${workspaceRoot}/config/styles`, category);
}

export function buildProjectMaterialOverviewFacts(input: IScriptPlanningContext): IProjectMaterialOverviewFacts {
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
    spatialStorySummary: [],
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
  const sections = [
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
  ];

  if (facts.spatialStorySummary.length > 0) {
    sections.push(
      '## Spatial Story',
      '',
      ...facts.spatialStorySummary.map(item => `- ${item}`),
      '',
    );
  }

  return sections.filter(Boolean).join('\n');
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
    .map(segment => ({
      ...segment,
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
      const slots = chosenSpanIds.length > 0
        ? chosenSpanIds.map((spanId, slotIndex) => ({
          id: `${segment.id}-slot-${slotIndex + 1}`,
          query,
          requirement: 'required' as const,
          targetBundles,
          chosenSpanIds: [spanId],
        }))
        : [{
          id: `${segment.id}-slot-1`,
          query,
          requirement: 'required' as const,
          targetBundles,
          chosenSpanIds: [],
        }];

      return {
        segmentId: segment.id,
        slots,
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
  const bundleIdsBySpanId = buildBundleIdsBySpanId(input.bundles);
  const candidateSpanIds = dedupeStrings(
    arrangementSignals.enforceChronology
      ? orderedSpanCandidates.map(candidate => candidate.spanId)
      : candidateBundles.flatMap(bundle => bundle.memberSpanIds),
  );
  const eligibleSpanIds = resolveEligibleSpanIds(
    candidateSpanIds.length > 0 ? candidateSpanIds : orderedSpanCandidates.map(candidate => candidate.spanId),
    candidateBySpanId,
    input.timeBand,
    arrangementSignals,
  );
  const targetBundleIdSet = new Set(input.targetBundleIds);

  const scored: Array<{
    spanId: string;
    score: number;
    orderIndex: number;
    isKeyProcessVideo: boolean;
  }> = [];
  for (const spanId of eligibleSpanIds) {
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
    const bundleScore = (bundleIdsBySpanId.get(spanId) ?? []).some(bundleId => targetBundleIdSet.has(bundleId))
      ? 18
      : 0;
    scored.push({
      spanId,
      score: bundleScore + materialScore + placeScore + transcriptScore + chronologyScore + pharosScore + keyVideoScore + sourceSpeechScore,
      orderIndex: candidate?.orderIndex ?? Number.MAX_SAFE_INTEGER,
      isKeyProcessVideo: candidate?.isKeyProcessVideo ?? false,
    });
  }

  const ranked = scored
    .sort((left, right) => right.score - left.score || left.orderIndex - right.orderIndex);
  const chosen = filterNearDuplicateSpans(ranked, input.spansById)
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

  return Array.from({ length: segmentCount }, (_, index) => {
    const baseStart = index / segmentCount;
    const baseEnd = (index + 1) / segmentCount;
    return {
      startPosition: baseStart,
      endPosition: baseEnd,
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

function buildBundleIdsBySpanId(
  bundles: IMaterialBundle[],
): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const bundle of bundles) {
    for (const spanId of bundle.memberSpanIds) {
      const current = result.get(spanId) ?? [];
      current.push(bundle.id);
      result.set(spanId, current);
    }
  }
  return result;
}

function filterNearDuplicateSpans<T extends { spanId: string }>(
  ranked: T[],
  spansById: Map<string, IKtepSlice>,
): T[] {
  const retained: T[] = [];
  for (const candidate of ranked) {
    const span = spansById.get(candidate.spanId);
    if (!span) continue;
    const duplicate = retained.some(existing => {
      const existingSpan = spansById.get(existing.spanId);
      return existingSpan != null && areNearDuplicateSpans(span, existingSpan);
    });
    if (duplicate) continue;
    retained.push(candidate);
  }
  return retained;
}

function areNearDuplicateSpans(left: IKtepSlice, right: IKtepSlice): boolean {
  if (left.assetId !== right.assetId || left.type !== right.type) return false;
  return resolveSpanOverlapRatio(left, right) >= 0.6;
}

function resolveSpanOverlapRatio(left: IKtepSlice, right: IKtepSlice): number {
  const leftRange = resolvePreferredSpanRange(left);
  const rightRange = resolvePreferredSpanRange(right);
  if (!leftRange || !rightRange) return 0;
  const overlapStart = Math.max(leftRange.startMs, rightRange.startMs);
  const overlapEnd = Math.min(leftRange.endMs, rightRange.endMs);
  if (overlapEnd <= overlapStart) return 0;
  const overlapMs = overlapEnd - overlapStart;
  const baselineMs = Math.min(leftRange.endMs - leftRange.startMs, rightRange.endMs - rightRange.startMs);
  if (baselineMs <= 0) return 0;
  return overlapMs / baselineMs;
}

function resolvePreferredSpanRange(
  span: Pick<IKtepSlice, 'sourceInMs' | 'sourceOutMs' | 'editSourceInMs' | 'editSourceOutMs'>,
): { startMs: number; endMs: number } | null {
  const editDuration = resolvePositiveDuration(span.editSourceInMs, span.editSourceOutMs);
  if (editDuration != null) {
    return {
      startMs: span.editSourceInMs as number,
      endMs: span.editSourceOutMs as number,
    };
  }

  const sourceDuration = resolvePositiveDuration(span.sourceInMs, span.sourceOutMs);
  if (sourceDuration != null) {
    return {
      startMs: span.sourceInMs as number,
      endMs: span.sourceOutMs as number,
    };
  }

  return null;
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

function enrichMaterialOverviewFactsWithSpatialStory(
  facts: IProjectMaterialOverviewFacts,
  spatialStory: ISpatialStoryContext,
): IProjectMaterialOverviewFacts {
  return {
    ...facts,
    spatialStorySummary: dedupeStrings([
      ...spatialStory.narrativeHints.map(item => item.guidance),
      ...spatialStory.anchors.slice(0, 4).map(anchor => anchor.title),
    ]).slice(0, 8),
    inferredGaps: dedupeStrings([
      ...facts.inferredGaps,
      ...spatialStory.coverageGaps.map(gap => gap.message),
    ]),
  };
}

function buildFallbackBriefDraft(
  brief: Awaited<ReturnType<typeof loadScriptBriefConfig>>,
  style: IStyleProfile,
  facts: IProjectMaterialOverviewFacts,
): {
  goalDraft: string[];
  constraintDraft: string[];
  planReviewDraft: string[];
  segments: Array<{
    segmentId: string;
    title?: string;
    roleHint?: string;
    targetDurationMs?: number;
    intent?: string;
    notes?: string[];
  }>;
} {
  const fallbackSegments = style.arrangementStructure.chapterPrograms.map((program, index) => ({
    segmentId: `segment-${index + 1}`,
    title: humanizeProgramType(program.type, index),
    roleHint: program.materialRoles[0],
    targetDurationMs: undefined,
    intent: program.intent,
    notes: dedupeStrings([
      program.transitionBias,
      program.localNarrationNote,
      ...program.promotionSignals,
    ]),
  }));
  return {
    goalDraft: brief.goalDraft.length > 0
      ? brief.goalDraft
      : dedupeStrings([
        facts.summary,
        facts.mainThemes[0] ? `围绕 ${facts.mainThemes[0]} 建立主叙事。` : undefined,
      ]),
    constraintDraft: brief.constraintDraft.length > 0
      ? brief.constraintDraft
      : dedupeStrings([
        ...style.narrationConstraints.forbiddenPatterns,
        ...(style.antiPatterns ?? []),
      ]),
    planReviewDraft: brief.planReviewDraft.length > 0
      ? brief.planReviewDraft
      : dedupeStrings([
        ...style.arrangementStructure.chapterSplitPrinciples,
        ...style.arrangementStructure.chapterTransitionNotes,
      ]),
    segments: brief.segments.length > 0
      ? brief.segments.map(segment => ({
        segmentId: segment.segmentId,
        title: segment.title,
        roleHint: segment.roleHint,
        targetDurationMs: segment.targetDurationMs,
        intent: segment.intent,
        notes: segment.notes,
      }))
      : fallbackSegments,
  };
}

async function runReviewedScriptStage<TDraft>(input: {
  llm: ILlmClient;
  projectRoot: string;
  stage: string;
  writerIdentity: 'overview-cartographer' | 'brief-editor' | 'segment-architect' | 'route-slot-planner' | 'beat-writer';
  baseDraft: TDraft;
  buildWriterPacket: (revisionBrief: string[], previousDraft: TDraft) => IAgentPacket;
  buildReviewPacket: (draft: TDraft, attempt: number) => IAgentPacket;
  persistDraft: (draft: TDraft) => Promise<void>;
}): Promise<{ draft: TDraft; review: IStageReview }> {
  let revisionBrief: string[] = [];
  let previousDraft = input.baseDraft;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const writerPacket = input.buildWriterPacket(revisionBrief, previousDraft);
    await Promise.all([
      writeScriptAgentPacket(input.projectRoot, input.stage, writerPacket),
      writeScriptAgentPipeline(input.projectRoot, {
        currentStage: input.stage,
        stageStatus: 'running',
        attemptCount: attempt,
        latestReviewResult: undefined,
        blockerSummary: [],
        updatedAt: new Date().toISOString(),
      }),
    ]);
    let draftRaw: unknown;
    try {
      draftRaw = await runJsonPacketAgent<unknown>(
        input.llm,
        resolveScriptWriterPromptId(input.writerIdentity),
        writerPacket,
        { revisionBrief, previousDraft },
      );
    } catch {
      draftRaw = previousDraft;
    }
    const draft = coerceReviewedScriptStageDraft(input.stage, draftRaw, previousDraft);
    await input.persistDraft(draft);

    const reviewPacket = input.buildReviewPacket(draft, attempt);
    await writeScriptAgentPacket(input.projectRoot, `review-${input.stage}`, reviewPacket);
    const reviewRaw = await runJsonPacketAgent<Partial<IStageReview>>(
      input.llm,
      'script/script-reviewer',
      reviewPacket,
      { llm: { temperature: 0.1 } },
    );
    const review = normalizeScriptStageReview(reviewRaw, input.stage, attempt);
    await Promise.all([
      writeScriptStageReview(input.projectRoot, input.stage, review),
      writeScriptAgentPipeline(input.projectRoot, {
        currentStage: input.stage,
        stageStatus: review.verdict === 'pass' ? 'completed' : attempt >= 3 ? 'awaiting_user' : 'review_failed',
        attemptCount: attempt,
        latestReviewResult: review.verdict,
        blockerSummary: review.issues
          .filter(issue => issue.severity === 'blocker')
          .map(issue => `${issue.code}: ${issue.message}`),
        updatedAt: new Date().toISOString(),
      }),
    ]);
    if (review.verdict === 'pass') {
      return { draft, review };
    }
    if (attempt >= 3) {
      throw new Error(
        `script stage "${input.stage}" is awaiting user review: ${review.issues
          .filter(issue => issue.severity === 'blocker')
          .map(issue => `${issue.code}: ${issue.message}`)
          .join(' | ')}`,
      );
    }
    revisionBrief = review.revisionBrief;
    previousDraft = draft;
  }

  throw new Error(`script stage "${input.stage}" failed to complete review loop.`);
}

function coerceReviewedScriptStageDraft<TDraft>(
  stage: string,
  raw: unknown,
  fallback: TDraft,
): TDraft {
  if (stage === 'script-current') {
    return normalizeReviewedScriptCurrentDraft(raw, fallback as IKtepScript[]) as TDraft;
  }

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return fallback;
  }

  const candidate = raw as Record<string, unknown>;
  if (stage === 'material-overview') {
    return (typeof candidate.markdown === 'string' ? raw : fallback) as TDraft;
  }
  if (stage === 'script-brief') {
    return (
      Array.isArray(candidate.goalDraft)
      && Array.isArray(candidate.constraintDraft)
      && Array.isArray(candidate.planReviewDraft)
      && Array.isArray(candidate.segments)
        ? raw
        : fallback
    ) as TDraft;
  }
  if (stage === 'segment-plan' || stage === 'material-slots') {
    return (Array.isArray(candidate.segments) ? raw : fallback) as TDraft;
  }

  return raw as TDraft;
}

function normalizeReviewedScriptCurrentDraft(
  raw: unknown,
  fallback: IKtepScript[],
): IKtepScript[] {
  const sourceSegments = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as Record<string, unknown> | undefined)?.segments)
      ? (raw as { segments: unknown[] }).segments
      : null;
  if (!sourceSegments) {
    return fallback;
  }

  return fallback.map((fallbackSegment, index) => {
    const candidate = sourceSegments[index];
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      return fallbackSegment;
    }

    const source = candidate as Record<string, unknown>;
    const rawBeats = Array.isArray(source.beats) ? source.beats : [];
    const beats = rawBeats.length > 0
      ? fallbackSegment.beats.map((fallbackBeat, beatIndex) => {
        const beatCandidate = rawBeats[beatIndex];
        if (!beatCandidate || typeof beatCandidate !== 'object' || Array.isArray(beatCandidate)) {
          return fallbackBeat;
        }
        const beatSource = beatCandidate as Record<string, unknown>;
        return {
          ...fallbackBeat,
          ...beatSource,
          text: typeof beatSource.text === 'string' ? beatSource.text : fallbackBeat.text,
          linkedSpanIds: normalizeStringList(beatSource.linkedSpanIds, fallbackBeat.linkedSpanIds),
          selections: Array.isArray(beatSource.selections)
            ? beatSource.selections as typeof fallbackBeat.selections
            : fallbackBeat.selections,
        };
      })
      : fallbackSegment.beats;

    return {
      ...fallbackSegment,
      ...source,
      narration: typeof source.narration === 'string' ? source.narration : fallbackSegment.narration,
      linkedSpanIds: normalizeStringList(source.linkedSpanIds, fallbackSegment.linkedSpanIds),
      linkedSliceIds: normalizeStringList(source.linkedSliceIds, fallbackSegment.linkedSliceIds),
      selections: Array.isArray(source.selections)
        ? source.selections as typeof fallbackSegment.selections
        : fallbackSegment.selections,
      pharosRefs: Array.isArray(source.pharosRefs)
        ? source.pharosRefs as typeof fallbackSegment.pharosRefs
        : fallbackSegment.pharosRefs,
      beats,
    };
  });
}

function normalizeStringList(raw: unknown, fallback: string[]): string[] {
  if (!Array.isArray(raw)) {
    return fallback;
  }
  const values = raw.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
  return values.length > 0 ? dedupeStrings(values) : fallback;
}

function normalizeScriptStageReview(
  raw: Partial<IStageReview> | undefined,
  stage: string,
  attempt: number,
): IStageReview {
  const issues = Array.isArray(raw?.issues)
    ? raw.issues
      .filter((issue): issue is NonNullable<IStageReview['issues']>[number] => Boolean(issue && typeof issue === 'object'))
      .map(issue => ({
        code: CSCRIPT_REVIEW_CODES.includes(issue.code as typeof CSCRIPT_REVIEW_CODES[number])
          ? issue.code
          : CSCRIPT_REVIEW_CODES[0],
        severity: issue.severity === 'warning' ? 'warning' as const : 'blocker' as const,
        message: typeof issue.message === 'string' && issue.message.trim()
          ? issue.message.trim()
          : 'reviewer returned an empty issue message.',
        details: typeof issue.details === 'string' && issue.details.trim() ? issue.details.trim() : undefined,
      }))
    : [];
  const hasBlocker = issues.some(issue => issue.severity === 'blocker');
  const revisionBrief = Array.isArray(raw?.revisionBrief)
    ? raw.revisionBrief.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
  return {
    stage,
    identity: 'script-reviewer',
    attempt,
    verdict: raw?.verdict === 'pass' && !hasBlocker
      ? 'pass'
      : raw?.verdict === 'awaiting_user'
        ? 'awaiting_user'
        : hasBlocker
          ? 'revise'
          : 'pass',
    issues,
    revisionBrief: hasBlocker && revisionBrief.length === 0
      ? ['请只依据 packet / contract / facts 回改，不要脑补。']
      : revisionBrief,
    reviewedAt: typeof raw?.reviewedAt === 'string' && raw.reviewedAt.trim()
      ? raw.reviewedAt
      : new Date().toISOString(),
  };
}

function resolveScriptWriterPromptId(
  identity: 'overview-cartographer' | 'brief-editor' | 'segment-architect' | 'route-slot-planner' | 'beat-writer',
): 'script/overview-cartographer' | 'script/brief-editor' | 'script/segment-architect' | 'script/route-slot-planner' | 'script/beat-writer' {
  switch (identity) {
    case 'overview-cartographer':
      return 'script/overview-cartographer';
    case 'brief-editor':
      return 'script/brief-editor';
    case 'segment-architect':
      return 'script/segment-architect';
    case 'route-slot-planner':
      return 'script/route-slot-planner';
    case 'beat-writer':
      return 'script/beat-writer';
  }
}

export function buildSpatialStoryContext(
  context: IScriptPlanningContext,
): ISpatialStoryContext {
  const chronologyByAssetId = new Map(context.chronology.map(item => [item.assetId, item] as const));
  const pharosShotByRef = new Map(
    (context.pharosContext?.shots ?? []).map(shot => [`${shot.ref.tripId}:${shot.ref.shotId}`, shot] as const),
  );
  const rows = context.spans.map(span => {
    const chronology = chronologyByAssetId.get(span.assetId);
    const spatialEvidence = span.grounding.spatialEvidence[0];
    const pharosRefs = dedupePharosRefs([
      ...(span.pharosRefs ?? []),
      ...(span.grounding.pharosRefs ?? []),
    ]);
    const pharosRef = pharosRefs[0];
    const pharosShot = pharosRef ? pharosShotByRef.get(`${pharosRef.tripId}:${pharosRef.shotId}`) : undefined;
    const hasDirectSpatialAnchor = span.grounding.spatialEvidence.length > 0
      || pharosRefs.length > 0;
    const locationText = spatialEvidence?.locationText
      ?? chronology?.placeHints[0]
      ?? pharosShot?.location
      ?? undefined;
    const lat = spatialEvidence?.lat
      ?? pharosShot?.actualGpsStart?.[0]
      ?? pharosShot?.gpsStart?.[0]
      ?? pharosShot?.gps?.[0];
    const lng = spatialEvidence?.lng
      ?? pharosShot?.actualGpsStart?.[1]
      ?? pharosShot?.gpsStart?.[1]
      ?? pharosShot?.gps?.[1];
    return {
      spanId: span.id,
      time: chronology?.sortCapturedAt ?? chronology?.capturedAt,
      locationText,
      lat,
      lng,
      routeRole: spatialEvidence?.routeRole ?? pharosShot?.type,
      pharosRefs,
      hasDirectSpatialAnchor,
    };
  });
  const grouped = new Map<string, typeof rows>();
  for (const row of rows) {
    const groupKey = row.locationText?.trim()
      || row.pharosRefs[0]?.shotId
      || `span:${row.spanId}`;
    const current = grouped.get(groupKey) ?? [];
    current.push(row);
    grouped.set(groupKey, current);
  }
  const anchors = [...grouped.entries()]
    .map(([groupKey, members], index) => ({
      id: `anchor-${index + 1}`,
      title: members[0]?.locationText || `Location ${index + 1}`,
      startAt: members.map(item => item.time).filter((item): item is string => Boolean(item)).sort()[0],
      endAt: members.map(item => item.time).filter((item): item is string => Boolean(item)).sort().slice(-1)[0],
      lat: members.find(item => typeof item.lat === 'number')?.lat,
      lng: members.find(item => typeof item.lng === 'number')?.lng,
      locationText: members[0]?.locationText,
      routeRole: dedupeStrings(members.map(item => item.routeRole)).join(' / ') || undefined,
      spanIds: members.map(item => item.spanId),
      pharosRefs: dedupePharosRefs(members.flatMap(item => item.pharosRefs)),
      groupKey,
    }))
    .sort((left, right) => String(left.startAt ?? '').localeCompare(String(right.startAt ?? '')));
  const transitions = anchors
    .map((anchor, index) => {
      const next = anchors[index + 1];
      if (!next || next.id === anchor.id) return null;
      return {
        id: `transition-${index + 1}`,
        fromAnchorId: anchor.id,
        toAnchorId: next.id,
        title: `${anchor.title} -> ${next.title}`,
        startAt: anchor.endAt ?? anchor.startAt,
        endAt: next.startAt ?? next.endAt,
        routeRole: dedupeStrings([anchor.routeRole, next.routeRole]).join(' / ') || undefined,
        spanIds: dedupeStrings([...anchor.spanIds, ...next.spanIds]),
        pharosRefs: dedupePharosRefs([...anchor.pharosRefs, ...next.pharosRefs]),
      };
    })
    .filter((item): item is NonNullable<typeof item> => item != null);
  const coverageGaps: ISpatialStoryContext['coverageGaps'] = dedupeStrings(rows
    .filter(row => !row.hasDirectSpatialAnchor)
    .map(row => row.spanId))
    .map(spanId => ({
      kind: 'weak-location' as const,
      message: `span ${spanId} 缺少直接的 GPS / Pharos 地点锚点，只能依赖弱 place hint。`,
      spanIds: [spanId],
      pharosRefs: [] as IPharosRef[],
    }));
  if (anchors.length > 1 && transitions.length === 0) {
    coverageGaps.push({
      kind: 'route-break',
      message: '当前空间锚点存在，但没有稳定的路线推进线索。',
      spanIds: anchors.flatMap(anchor => anchor.spanIds),
      pharosRefs: dedupePharosRefs(anchors.flatMap(anchor => anchor.pharosRefs)),
    });
  }
  const pendingShots = (context.pharosContext?.shots ?? []).filter(shot => shot.status === 'pending');
  for (const shot of pendingShots.slice(0, 6)) {
    coverageGaps.push({
      kind: 'pharos-uncovered',
      message: `Pharos 待覆盖镜头：${shot.tripTitle ?? shot.ref.tripId} / ${shot.location}`,
      spanIds: [],
      pharosRefs: [shot.ref],
    });
  }
  const narrativeHints = transitions.length > 0
    ? transitions.slice(0, 6).map(transition => ({
      title: transition.title,
      guidance: `把空间推进写成从 ${anchors.find(anchor => anchor.id === transition.fromAnchorId)?.title ?? '前一地点'} 到 ${anchors.find(anchor => anchor.id === transition.toAnchorId)?.title ?? '后一地点'} 的连续转移。`,
      anchorIds: dedupeStrings([transition.fromAnchorId, transition.toAnchorId]),
      spanIds: transition.spanIds,
      pharosRefs: transition.pharosRefs,
    }))
    : anchors.slice(0, 6).map(anchor => ({
      title: anchor.title,
      guidance: `把 ${anchor.title} 作为一个清晰空间锚点，而不是只当作弱 place hint。`,
      anchorIds: [anchor.id],
      spanIds: anchor.spanIds,
      pharosRefs: anchor.pharosRefs,
    }));
  return {
    generatedAt: new Date().toISOString(),
    anchors: anchors.map(({ groupKey, ...anchor }) => anchor),
    transitions,
    routeWindows: anchors.map((anchor, index) => ({
      id: `window-${index + 1}`,
      title: anchor.title,
      startAt: anchor.startAt,
      endAt: anchor.endAt,
      anchorIds: [anchor.id],
      spanIds: anchor.spanIds,
      notes: dedupeStrings([anchor.routeRole]),
    })),
    coverageGaps,
    narrativeHints,
  };
}

export function buildSpatialStoryMarkdown(
  spatialStory: ISpatialStoryContext,
): string {
  return [
    '# Spatial Story',
    '',
    `- 生成时间：${spatialStory.generatedAt}`,
    '',
    '## Anchors',
    '',
    ...spatialStory.anchors.flatMap(anchor => [
      `### ${anchor.title}`,
      anchor.startAt ? `- startAt: ${anchor.startAt}` : '',
      anchor.endAt ? `- endAt: ${anchor.endAt}` : '',
      anchor.locationText ? `- locationText: ${anchor.locationText}` : '',
      anchor.routeRole ? `- routeRole: ${anchor.routeRole}` : '',
      anchor.spanIds.length > 0 ? `- spanIds: ${anchor.spanIds.join(', ')}` : '',
      '',
    ]),
    '## Transitions',
    '',
    ...spatialStory.transitions.map(transition => `- ${transition.title}${transition.routeRole ? ` | ${transition.routeRole}` : ''}`),
    '',
    spatialStory.coverageGaps.length > 0 ? '## Coverage Gaps' : '',
    spatialStory.coverageGaps.length > 0 ? '' : '',
    ...spatialStory.coverageGaps.map(gap => `- [${gap.kind}] ${gap.message}`),
    '',
    '## Narrative Hints',
    '',
    ...spatialStory.narrativeHints.map(hint => `- ${hint.guidance}`),
    '',
  ].filter(Boolean).join('\n');
}

async function ensureSpatialStory(
  projectRoot: string,
  context: IScriptPlanningContext,
  facts: IProjectMaterialOverviewFacts,
): Promise<ISpatialStoryContext> {
  const spatialStory = buildSpatialStoryContext(context);
  const nextFacts = enrichMaterialOverviewFactsWithSpatialStory(facts, spatialStory);
  await Promise.all([
    writeMaterialOverviewFacts(projectRoot, nextFacts),
    writeSpatialStory(projectRoot, spatialStory),
    writeFile(getSpatialStoryMarkdownPath(projectRoot), buildSpatialStoryMarkdown(spatialStory), 'utf-8'),
  ]);
  return spatialStory;
}

export function buildScriptAgentContract(input: {
  brief: Awaited<ReturnType<typeof loadScriptBriefConfig>>;
  style: IStyleProfile;
  spatialStory: ISpatialStoryContext;
  chronology: IScriptPlanningContext['chronology'];
  pharosContext: IProjectPharosContext | null;
}): IAgentContract {
  const arrangementSignals = resolveArrangementSignals(input.style);
  return {
    generatedAt: new Date().toISOString(),
    goals: dedupeStrings(input.brief.goalDraft),
    constraints: dedupeStrings(input.brief.constraintDraft),
    reviewNotes: dedupeStrings(input.brief.planReviewDraft),
    styleMust: dedupeStrings([
      input.style.arrangementStructure.primaryAxis,
      ...input.style.arrangementStructure.chapterSplitPrinciples,
      ...input.style.arrangementStructure.chapterTransitionNotes,
      ...input.style.narrationConstraints.notes,
    ]),
    styleForbidden: dedupeStrings([
      ...(input.style.antiPatterns ?? []),
      ...input.style.narrationConstraints.forbiddenPatterns,
    ]),
    gpsNarrativeHints: dedupeStrings(input.spatialStory.narrativeHints.map(item => item.guidance)),
    pharosMustCover: dedupeStrings(
      (input.pharosContext?.shots ?? [])
        .filter(shot => shot.priority === 'must')
        .map(shot => `${shot.tripTitle ?? shot.ref.tripId} / ${shot.location}`),
    ),
    pharosPendingHints: dedupeStrings(
      (input.pharosContext?.shots ?? [])
        .filter(shot => shot.status === 'pending')
        .map(shot => `${shot.tripTitle ?? shot.ref.tripId} / ${shot.location}`),
    ),
    chronologyGuardrails: dedupeStrings([
      arrangementSignals.enforceChronology ? '段落与 beat 默认保持非递减 chronology。' : undefined,
      input.chronology[0]?.sortCapturedAt ? `chronology 起点：${input.chronology[0].sortCapturedAt}` : undefined,
      input.chronology.at(-1)?.sortCapturedAt ? `chronology 终点：${input.chronology.at(-1)?.sortCapturedAt}` : undefined,
    ]),
  };
}

async function ensureScriptAgentContract(
  projectRoot: string,
  brief: Awaited<ReturnType<typeof loadScriptBriefConfig>>,
  style: IStyleProfile,
  spatialStory: ISpatialStoryContext,
  chronology: IScriptPlanningContext['chronology'],
  pharosContext: IProjectPharosContext | null,
): Promise<IAgentContract> {
  const existing = await loadScriptAgentContract(projectRoot);
  const next = buildScriptAgentContract({
    brief,
    style,
    spatialStory,
    chronology,
    pharosContext,
  });
  if (JSON.stringify(existing) !== JSON.stringify(next)) {
    await writeScriptAgentContract(projectRoot, next);
  }
  return next;
}

function buildSegmentPlanPacket(input: {
  projectRoot: string;
  contract: IAgentContract;
  style: IStyleProfile;
  materialOverview: string;
  facts: IProjectMaterialOverviewFacts;
  spatialStory: ISpatialStoryContext;
  brief: Awaited<ReturnType<typeof loadScriptBriefConfig>>;
  baseDraft: ISegmentPlan;
  revisionBrief: string[];
}): IAgentPacket {
  return {
    stage: 'segment-plan',
    identity: 'segment-architect',
    mission: '只生成 segment plan，不直接选具体 span，也不写 beat 文案。',
    hardConstraints: [
      '只相信 contract、material overview、style 和 spatial-story。',
      '缺证据时必须保守，不脑补新节点。',
      '不能忽略 chronology / GPS / Pharos guardrails。',
    ],
    allowedInputs: [
      'script/material-overview.md',
      'script/material-overview.facts.json',
      'script/spatial-story.json',
      'script/agent-contract.json',
      'style profile',
      'base segment plan draft',
    ],
    inputArtifacts: [
      {
        label: 'agent-contract',
        path: getScriptAgentContractPath(input.projectRoot),
        summary: input.contract.goals.join(' / '),
        content: input.contract,
      },
      {
        label: 'material-overview',
        path: getMaterialOverviewPath(input.projectRoot),
        summary: input.facts.summary,
        content: { markdown: input.materialOverview },
      },
      {
        label: 'material-overview-facts',
        path: getMaterialOverviewFactsPath(input.projectRoot),
        summary: input.facts.summary,
        content: input.facts,
      },
      {
        label: 'style-profile',
        summary: input.style.narrative.pacePattern,
        content: {
          arrangementStructure: input.style.arrangementStructure,
          narrationConstraints: input.style.narrationConstraints,
          antiPatterns: input.style.antiPatterns,
          parameters: input.style.parameters,
        },
      },
      {
        label: 'spatial-story',
        path: getSpatialStoryPath(input.projectRoot),
        summary: input.spatialStory.narrativeHints.map(item => item.title).join(' / '),
        content: input.spatialStory,
      },
      {
        label: 'script-brief',
        path: getScriptBriefPath(input.projectRoot),
        summary: input.brief.goalDraft.join(' / '),
        content: input.brief,
      },
      {
        label: 'base-draft',
        path: getSegmentPlanPath(input.projectRoot),
        summary: input.baseDraft.summary,
        content: input.baseDraft,
      },
      input.revisionBrief.length > 0 ? {
        label: 'revision-brief',
        summary: input.revisionBrief.join(' / '),
        content: input.revisionBrief,
      } : null,
    ].filter((item): item is NonNullable<typeof item> => item != null),
    outputSchema: {
      id: 'string',
      projectId: 'string',
      generatedAt: 'ISO datetime',
      summary: 'string',
      segments: 'Array<{ id, title, intent, targetDurationMs?, roleHint?, notes[] }>',
      notes: 'string[]',
    },
    reviewRubric: [...CSCRIPT_REVIEW_CODES],
  };
}

function buildMaterialSlotsPacket(input: {
  projectRoot: string;
  contract: IAgentContract;
  style: IStyleProfile;
  spatialStory: ISpatialStoryContext;
  segmentPlan: ISegmentPlan;
  bundles: IMaterialBundle[];
  spans: IKtepSlice[];
  chronology: IScriptPlanningContext['chronology'];
  baseDraft: IMaterialSlotsDocument;
  revisionBrief: string[];
}): IAgentPacket {
  return {
    stage: 'material-slots',
    identity: 'route-slot-planner',
    mission: '只把 segment intent 转成 evidence-first material slots，并显式保留 chosenSpanIds。',
    hardConstraints: [
      '不能改写 segment 结构。',
      '必须服从 chronology / GPS / Pharos guardrails。',
      '缺证据时宁可保守留空，也不要强凑 span。',
    ],
    allowedInputs: [
      'script/segment-plan.json',
      'analysis/material-bundles.json',
      'script/spatial-story.json',
      'script/agent-contract.json',
      'spans / chronology',
      'base material slots draft',
    ],
    inputArtifacts: [
      {
        label: 'agent-contract',
        path: getScriptAgentContractPath(input.projectRoot),
        summary: input.contract.goals.join(' / '),
        content: input.contract,
      },
      {
        label: 'segment-plan',
        path: getSegmentPlanPath(input.projectRoot),
        summary: input.segmentPlan.summary,
        content: input.segmentPlan,
      },
      {
        label: 'material-bundles',
        path: getMaterialBundlesPath(input.projectRoot),
        summary: `${input.bundles.length} 个 bundle`,
        content: input.bundles,
      },
      {
        label: 'spatial-story',
        path: getSpatialStoryPath(input.projectRoot),
        summary: input.spatialStory.narrativeHints.map(item => item.title).join(' / '),
        content: input.spatialStory,
      },
      {
        label: 'span-facts',
        summary: `${input.spans.length} 个 spans + ${input.chronology.length} 条 chronology`,
        content: {
          spans: input.spans,
          chronology: input.chronology,
        },
      },
      {
        label: 'style-profile',
        summary: input.style.narrative.pacePattern,
        content: {
          arrangementStructure: input.style.arrangementStructure,
          narrationConstraints: input.style.narrationConstraints,
          antiPatterns: input.style.antiPatterns,
          parameters: input.style.parameters,
        },
      },
      {
        label: 'base-draft',
        path: getMaterialSlotsPath(input.projectRoot),
        summary: `${input.baseDraft.segments.length} 个 segment slot group`,
        content: input.baseDraft,
      },
      input.revisionBrief.length > 0 ? {
        label: 'revision-brief',
        summary: input.revisionBrief.join(' / '),
        content: input.revisionBrief,
      } : null,
    ].filter((item): item is NonNullable<typeof item> => item != null),
    outputSchema: {
      id: 'string',
      projectId: 'string',
      generatedAt: 'ISO datetime',
      segments: 'Array<{ segmentId, slots: Array<{ id, query, requirement, targetBundles, chosenSpanIds }> }>',
    },
    reviewRubric: [...CSCRIPT_REVIEW_CODES],
  };
}

function buildScriptCurrentPacket(input: {
  projectRoot: string;
  contract: IAgentContract;
  style: IStyleProfile;
  materialOverview: string;
  spatialStory: ISpatialStoryContext;
  outline: IOutlineSegment[];
  baseDraft: IKtepScript[];
  revisionBrief: string[];
}): IAgentPacket {
  return {
    stage: 'script-current',
    identity: 'beat-writer',
    mission: '只写 beat/script，不重做章节结构。',
    hardConstraints: [
      '只相信 contract、outline、style、material overview、spatial-story。',
      '缺证据时必须保守，不脑补地点、事件和情绪。',
      '不要靠删 beat 来掩盖材料密度。',
    ],
    allowedInputs: [
      'script/agent-contract.json',
      'analysis/outline.json',
      'script/material-overview.md',
      'script/spatial-story.json',
      'style profile',
      'base script draft',
    ],
    inputArtifacts: [
      {
        label: 'agent-contract',
        path: getScriptAgentContractPath(input.projectRoot),
        summary: input.contract.goals.join(' / '),
        content: input.contract,
      },
      {
        label: 'outline',
        summary: `${input.outline.length} 个段落的 outline`,
        content: input.outline,
      },
      {
        label: 'material-overview',
        path: getMaterialOverviewPath(input.projectRoot),
        summary: '已审核通过的 material overview。',
        content: { markdown: input.materialOverview },
      },
      {
        label: 'spatial-story',
        path: getSpatialStoryPath(input.projectRoot),
        summary: input.spatialStory.narrativeHints.map(item => item.title).join(' / '),
        content: input.spatialStory,
      },
      {
        label: 'style-profile',
        summary: input.style.narrative.pacePattern,
        content: {
          arrangementStructure: input.style.arrangementStructure,
          narrationConstraints: input.style.narrationConstraints,
          antiPatterns: input.style.antiPatterns,
          parameters: input.style.parameters,
        },
      },
      {
        label: 'base-draft',
        path: getCurrentScriptPath(input.projectRoot),
        summary: `${input.baseDraft.length} 个 script segment`,
        content: input.baseDraft,
      },
      input.revisionBrief.length > 0 ? {
        label: 'revision-brief',
        summary: input.revisionBrief.join(' / '),
        content: input.revisionBrief,
      } : null,
    ].filter((item): item is NonNullable<typeof item> => item != null),
    outputSchema: {
      segments: 'IKtepScript[]',
    },
    reviewRubric: [...CSCRIPT_REVIEW_CODES],
  };
}

function buildScriptReviewPacket(input: {
  projectRoot: string;
  stage: string;
  contract: IAgentContract;
  supportingArtifacts: Array<{ label: string; path?: string; summary?: string; content?: unknown }>;
  draft: unknown;
  attempt: number;
}): IAgentPacket {
  return {
    stage: `review-${input.stage}`,
    identity: 'script-reviewer',
    mission: '审查当前 script stage 草稿是否遗漏需求或发生事实 / GPS / style / chronology / Pharos 漂移。',
    hardConstraints: [
      '只审查，不直接重写正式稿。',
      '只根据 contract、supporting artifacts 和草稿判定 blocker / warning。',
      '存在 blocker 时必须给 revisionBrief。',
    ],
    allowedInputs: [
      'script/agent-contract.json',
      'stage supporting artifacts',
      'current draft',
    ],
    inputArtifacts: [
      {
        label: 'agent-contract',
        path: getScriptAgentContractPath(input.projectRoot),
        summary: input.contract.goals.join(' / '),
        content: input.contract,
      },
      ...input.supportingArtifacts,
      {
        label: 'stage-draft',
        path: input.stage === 'segment-plan'
          ? getSegmentPlanPath(input.projectRoot)
          : input.stage === 'material-slots'
            ? getMaterialSlotsPath(input.projectRoot)
            : getCurrentScriptPath(input.projectRoot),
        summary: `第 ${input.attempt} 轮 ${input.stage} 草稿`,
        content: input.draft,
      },
    ],
    outputSchema: {
      verdict: 'pass | revise | awaiting_user',
      issues: 'Array<{ code, severity, message, details? }>',
      revisionBrief: 'string[]',
    },
    reviewRubric: [...CSCRIPT_REVIEW_CODES],
  };
}

function dedupePharosRefs(refs: IPharosRef[]): IPharosRef[] {
  return dedupeStrings(refs.map(ref => `${ref.tripId}:${ref.shotId}`))
    .map(item => {
      const [tripId, shotId] = item.split(':');
      return { tripId, shotId };
    });
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
    .filter(item => item.score > 0)
    .sort((left, right) => right.score - left.score)
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
