import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type {
  IAgentPacket,
  IAgentPacketInputArtifact,
  IEditFlowPlan,
  IEditFlowPlanStep,
  IEditFlowStepExecution,
  IEditRuleMarkdownSource,
  IStyleUsage,
} from '../../protocol/schema.js';
import { IEditFlowPlan as ZEditFlowPlan, IStyleUsage as ZStyleUsage } from '../../protocol/schema.js';
import {
  getEditFlowPlanPath,
  getEditPlanningArtifactPath,
  loadAssetReports,
  loadAssets,
  loadChronologyReviewState,
  loadEditFlowPlan,
  loadProject,
  loadProjectBriefConfig,
  assertFreshSpans,
  normalizeEditId,
  writeEditFlowPlan,
} from '../../store/index.js';
import { loadOrBuildProjectPharosContext } from '../pharos/context.js';
import {
  AgentRunnerUnavailableError,
  type IJsonPacketAgentRunner,
} from '../agents/runtime.js';
import { loadEditRuleByCategory } from '../script/edit-rule-loader.js';
import {
  computeStyleProfileHash,
  isLayeredStyleProfile,
  loadStyleByCategory,
} from '../script/style-loader.js';
import {
  CEDIT_FLOW_CAPABILITY_CATALOG,
  isEditFlowCapabilityId,
  type TEditFlowCapabilityId,
} from './capabilities.js';

export interface IGenerateEditFlowPlanInput {
  workspaceRoot: string;
  projectRoot: string;
  editId?: string | null;
  editRuleCategory: string;
  styleCategory?: string;
  agentRunner?: IJsonPacketAgentRunner;
}

export interface IAssertConfirmedEditFlowPlanInput {
  workspaceRoot: string;
  projectRoot: string;
  editId?: string | null;
  editRuleCategory: string;
  requiredCapabilityIds?: TEditFlowCapabilityId[];
}

async function loadOptionalFreshSpans(projectRoot: string): Promise<{ count: number; status: 'fresh' | 'missing_or_stale'; message?: string }> {
  try {
    const result = await assertFreshSpans(projectRoot);
    return { count: result.spans.length, status: 'fresh' };
  } catch (error) {
    return {
      count: 0,
      status: 'missing_or_stale',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function generateEditFlowPlan(
  input: IGenerateEditFlowPlanInput,
): Promise<IEditFlowPlan> {
  const editId = normalizeEditId(input.editId);
  const styleProfile = input.styleCategory
    ? await loadStyleByCategory(`${input.workspaceRoot}/config/styles`, input.styleCategory)
    : null;
  const styleProfileHash = styleProfile ? computeStyleProfileHash(styleProfile) : undefined;
  const [editRule, project, projectBrief, assets, spansInfo, chronologyState, assetReports] = await Promise.all([
    loadEditRuleByCategory(input.workspaceRoot, input.editRuleCategory),
    loadProject(input.projectRoot),
    loadProjectBriefConfig(input.projectRoot),
    loadAssets(input.projectRoot),
    loadOptionalFreshSpans(input.projectRoot),
    loadChronologyReviewState(input.projectRoot),
    loadAssetReports(input.projectRoot),
  ]);
  const pharosContext = await loadOrBuildProjectPharosContext({
    projectRoot: input.projectRoot,
    includedTripIds: projectBrief.pharos?.includedTripIds ?? [],
  });
  const projectSummary = {
    project: {
      id: project.id,
      name: project.name,
      description: projectBrief.description,
    },
    projectBrief,
    availability: {
      pharosStatus: pharosContext.status,
      pharosTrips: pharosContext.trips.length,
      pharosShots: pharosContext.shots.length,
      gpxFiles: pharosContext.gpxFiles.length,
      assets: assets.length,
      spans: spansInfo.count,
      spansStatus: spansInfo.status,
      spansMessage: spansInfo.message,
      chronologyItems: chronologyState.chronology?.events.length ?? 0,
      chronologyStatus: chronologyState.chronology?.status ?? (chronologyState.blocked ? 'blocked' : 'missing'),
      assetReports: assetReports.length,
    },
  };
  const packet: IAgentPacket = {
    stage: 'edit-flow-plan',
    identity: 'edit-flow-planner',
    mission: '读取剪辑规则 markdown、项目上下文和固定能力目录，生成一个显式、可人工确认、可由代码执行的 Edit Flow Plan。',
    hardConstraints: [
      '只能选择输入上下文中 capability catalog 明确列出的 capabilityId。',
      '不要把剪辑规则正文翻译成代码启发式；你的输出必须是显式 flow plan。',
      '每个 step 必须写 capabilityId、inputRefs、outputRefs 和 gate。',
      '需要人工审查的规划文档或阶段必须标记 gate=human。',
      '不要要求代码读取 markdown 正文来做剪辑判断；规则解释只能体现在你的 plan 和后续 LLM stage context 中。',
      '如果剪辑规则自由正文要求使用风格档案，请把本轮使用层结构化写入 styleUsage。',
      'styleUsage.layers 只能使用 literary / artistic / editingTechnical，mode 只能是 off / soft / hard。',
      'hard 只能来自剪辑规则正文的显式要求；不要把参考视频观察自动升级成硬规则。',
      '如果剪辑规则正文用自然语言要求 SubAgent、分片、按天/事件/场景/主题/段落切分，请只把这个执行策略写入对应 Flow Plan step.execution；代码不得直接解析 markdown 正文。',
      '没有明确 SubAgent/分片要求的 step 默认 execution.mode=single-agent、shardBy=none；人工 step 使用 execution.mode=manual、shardBy=none。',
      '当前旅行纪录片规则若写“使用 SubAgent，切分按照天数粒度”，只能映射为 shardBy=day，不要自动升级为 route 分片。',
      '如果规则写“按天但不是每天一个，而是按约 N 个事件/素材打包”，写 execution.shardPacking={ base:"day", metric, maxPerShard:N, preserveOrder:true }。',
      'trip.event_table 只应声明 media/chronology.json 作为 inputRefs；素材级 spans/asset reports 留给 material.archive 或 material.recall。',
      'material.recall 的正式结构化输出只能是 edits/<editId>/script/material-slots.json；不要声明 segment-plan.json。',
      'material-slots.json 必须为每个 chosenSpanId 写 treatments[spanId]={ audio:number, speed:number }，audio 单位 dB，默认 0，静音为 -100，speed 单位倍速，默认 1。',
      'material-slots.json 对有 transcript、transcriptSegments、semanticKind=speech/mixed 或 materialPatterns=有口播语音 的非照片 span 不得静音。',
      'material.recall 应作为审查型粗剪候选池规划，要求 type/day/event 覆盖审计；所有非照片 speech-backed span 默认纳入，未纳入必须在审计中暴露 dropped span。',
      '如果计划包含 timeline.generate，必须在它之前包含 resolve.media_sync；resolve.media_sync 是 deterministic runner，只同步达芬奇 Media Pool，不声明 media-archive.json。',
      'timeline.generate 必须使用 runner=deterministic，只读取已同步达芬奇 Media Pool、edit-framework.md、material-slots.json、store/spans.json、store/assets.json 和 media/chronology.json，并直接创建 Resolve 粗剪 timeline。',
      '所有 sharded-agent step 都必须写 execution.codexSubagentProfile={ reasoningEffort:"high", forkContext:false, speed:"standard" }。',
    ],
    allowedInputs: [
      'config/edit-rules/<category>.md raw markdown',
      'fixed capability catalog',
      'config/project-brief.json',
      'analysis/pharos-context.json availability summary',
      'store/assets.json / store/spans.json / media/chronology.json availability summary',
      'optional selected layered-v1 style profile summary',
    ],
    inputArtifacts: [
      buildEditRuleArtifact(editRule),
      {
        label: 'capability-catalog',
        summary: `${CEDIT_FLOW_CAPABILITY_CATALOG.length} fixed edit capabilities`,
        content: CEDIT_FLOW_CAPABILITY_CATALOG,
      },
      {
        label: 'project-context-summary',
        summary: `${assets.length} assets / ${spansInfo.count} spans (${spansInfo.status}) / ${pharosContext.trips.length} Pharos trips`,
        content: projectSummary,
      },
      styleProfile ? {
        label: 'selected-style-profile',
        summary: `${styleProfile.name} (${input.styleCategory}) / ${styleProfile.styleProfileVersion}`,
        content: {
          category: input.styleCategory,
          styleProfileVersion: styleProfile.styleProfileVersion,
          styleProfileHash,
          layers: styleProfile.layers,
        },
      } : null,
    ].filter((item): item is IAgentPacketInputArtifact => item != null),
    outputSchema: {
      summary: 'string',
      assumptions: 'string[]',
      styleUsage: {
        styleCategory: 'string | undefined',
        styleProfileHash: 'string | undefined',
        styleProfileVersion: '"layered-v1" | "legacy" | undefined',
        layers: {
          literary: '{ mode: "off" | "soft" | "hard", appliesTo: string[], rationale?: string }',
          artistic: '{ mode: "off" | "soft" | "hard", appliesTo: string[], rationale?: string }',
          editingTechnical: '{ mode: "off" | "soft" | "hard", appliesTo: string[], rationale?: string }',
        },
        rationale: 'string | undefined',
      },
      steps: 'Array<{ id: string, capabilityId: one of capability catalog, title?: string, inputRefs: string[], outputRefs: string[], outputTypes?: Record<string,string>, runner?: "deterministic" | "agent" | "script" | "manual", execution?: { mode: "single-agent" | "sharded-agent" | "deterministic" | "manual", shardBy: "none" | "day" | "event" | "scene" | "topic" | "segment", shardPacking?: { base: "day", metric: "chronologyEventCount" | "materialRefCount", maxPerShard: number, preserveOrder: true }, codexSubagentProfile?: { reasoningEffort: "high", forkContext: false, speed: "standard" }, reason?: string }, gate: "none" | "human", notes?: string[] }>',
    },
    reviewRubric: [
      'unknown_capability',
      'missing_gate',
      'markdown_heuristic_leak',
      'missing_project_context',
      'missing_required_io_refs',
    ],
  };
  const runner = requireDirectEditFlowAgentRunner(input.agentRunner, 'Edit Flow Plan generation');
  const draft = await runner.run<Partial<IEditFlowPlan>>({
    promptId: 'edit-flow/planner',
    packet,
    llm: { jsonMode: true, temperature: 0.2 },
  });
  const plan = materializeEditFlowPlan({
    draft,
    projectId: project.id,
    editId,
    editRule,
    styleCategory: input.styleCategory,
    styleProfileHash,
    styleProfileVersion: styleProfile?.styleProfileVersion,
  });
  await writeEditFlowPlan(input.projectRoot, plan, editId);
  return plan;
}

export async function confirmEditFlowPlan(
  workspaceRoot: string,
  projectRoot: string,
  editId?: string | null,
): Promise<IEditFlowPlan> {
  const normalizedEditId = normalizeEditId(editId);
  const existing = await loadEditFlowPlan(projectRoot, normalizedEditId);
  if (!existing) {
    throw new Error(`edit flow plan is required: edits/${normalizedEditId}/planning/flow-plan.json`);
  }
  const editRule = await loadEditRuleByCategory(workspaceRoot, existing.editRuleCategory);
  if (existing.editRuleHash !== editRule.contentHash) {
    const stale = {
      ...existing,
      status: 'stale' as const,
      staleReason: 'edit rule markdown hash changed',
      updatedAt: new Date().toISOString(),
    };
    await writeEditFlowPlan(projectRoot, stale, normalizedEditId);
    throw new Error(`edit flow plan is stale for edits/${normalizedEditId}; regenerate before confirming`);
  }
  await assertStyleUsageReadyForPlan({
    workspaceRoot,
    projectRoot,
    editId: normalizedEditId,
    plan: existing,
  });
  const confirmed = ZEditFlowPlan.parse({
    ...existing,
    status: 'confirmed',
    confirmedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    staleReason: undefined,
  });
  await writeEditFlowPlan(projectRoot, confirmed, normalizedEditId);
  return confirmed;
}

export async function loadEditFlowPlanWithFreshness(
  workspaceRoot: string,
  projectRoot: string,
  editId?: string | null,
): Promise<IEditFlowPlan | null> {
  const normalizedEditId = normalizeEditId(editId);
  const existing = await loadEditFlowPlan(projectRoot, normalizedEditId);
  if (!existing) return null;
  const editRule = await loadEditRuleByCategory(workspaceRoot, existing.editRuleCategory);
  if (existing.editRuleHash === editRule.contentHash) return existing;
  const stale = ZEditFlowPlan.parse({
    ...existing,
    status: 'stale',
    staleReason: 'edit rule markdown hash changed',
    updatedAt: new Date().toISOString(),
  });
  await writeEditFlowPlan(projectRoot, stale, normalizedEditId);
  return stale;
}

export async function assertConfirmedEditFlowPlan(
  input: IAssertConfirmedEditFlowPlanInput,
): Promise<IEditFlowPlan> {
  const editId = normalizeEditId(input.editId);
  const plan = await loadEditFlowPlan(input.projectRoot, editId);
  if (!plan) {
    throw new Error(`confirmed edit flow plan is required before this stage: edits/${editId}/planning/flow-plan.json`);
  }
  const editRule = await loadEditRuleByCategory(input.workspaceRoot, input.editRuleCategory);
  if (plan.editRuleCategory !== input.editRuleCategory) {
    throw new Error(`edit flow plan category mismatch: plan=${plan.editRuleCategory}, current=${input.editRuleCategory}`);
  }
  if (plan.editRuleHash !== editRule.contentHash) {
    const stale = {
      ...plan,
      status: 'stale' as const,
      staleReason: 'edit rule markdown hash changed',
      updatedAt: new Date().toISOString(),
    };
    await writeEditFlowPlan(input.projectRoot, stale, editId);
    throw new Error(`edit flow plan is stale for edits/${editId}; regenerate and confirm it`);
  }
  await assertStyleUsageReadyForPlan({
    workspaceRoot: input.workspaceRoot,
    projectRoot: input.projectRoot,
    editId,
    plan,
  });
  if (plan.status !== 'confirmed') {
    throw new Error(`edit flow plan must be confirmed before this stage: edits/${editId}/planning/flow-plan.json`);
  }
  const missing = (input.requiredCapabilityIds ?? [])
    .filter(capabilityId => !plan.steps.some(step => step.capabilityId === capabilityId));
  if (missing.length > 0) {
    throw new Error(`edit flow plan is missing required capabilities: ${missing.join(', ')}`);
  }
  return plan;
}

export async function loadEditPlanningPacketArtifacts(
  projectRoot: string,
  editId?: string | null,
): Promise<IAgentPacketInputArtifact[]> {
  const normalizedEditId = normalizeEditId(editId);
  const artifacts: IAgentPacketInputArtifact[] = [];
  const flowPlan = await loadEditFlowPlan(projectRoot, normalizedEditId);
  if (flowPlan) {
    artifacts.push({
      label: 'edit-flow-plan',
      path: getEditFlowPlanPath(projectRoot, normalizedEditId),
      summary: flowPlan.summary ?? `${flowPlan.steps.length} flow steps`,
      content: flowPlan,
    });
  }
  for (const item of [
    ['event-table', 'event-table.md'] as const,
    ['material-archive', 'material-archive.md'] as const,
    ['edit-framework', 'edit-framework.md'] as const,
  ]) {
    const path = getEditPlanningArtifactPath(projectRoot, item[1], normalizedEditId);
    const markdown = await readFile(path, 'utf-8').catch(() => '');
    if (!markdown.trim()) continue;
    artifacts.push({
      label: item[0],
      path,
      summary: firstMarkdownLine(markdown),
      content: { markdown },
    });
  }
  return artifacts;
}

export function buildEditRuleArtifact(
  editRule: IEditRuleMarkdownSource,
): IAgentPacketInputArtifact {
  return {
    label: 'edit-rule-markdown',
    path: editRule.absolutePath,
    summary: `${editRule.displayName} (${editRule.categoryId})`,
    content: {
      categoryId: editRule.categoryId,
      displayName: editRule.displayName,
      contentHash: editRule.contentHash,
      frontMatter: editRule.frontMatter,
      markdown: editRule.markdown,
    },
  };
}

export async function runEditPlanningDocumentCapability(input: {
  workspaceRoot: string;
  projectRoot: string;
  editId?: string | null;
  editRuleCategory: string;
  capabilityId: Extract<TEditFlowCapabilityId, 'pharos.parse' | 'trip.event_table' | 'material.archive' | 'edit.framework'>;
  agentRunner?: IJsonPacketAgentRunner;
}): Promise<{ capabilityId: TEditFlowCapabilityId; outputPath: string; status: 'completed' }> {
  const editId = normalizeEditId(input.editId);
  const projectBrief = await loadProjectBriefConfig(input.projectRoot);
  if (input.capabilityId === 'pharos.parse') {
    await loadOrBuildProjectPharosContext({
      projectRoot: input.projectRoot,
      includedTripIds: projectBrief.pharos?.includedTripIds ?? [],
      forceRefresh: true,
    });
    return {
      capabilityId: input.capabilityId,
      outputPath: 'analysis/pharos-context.json',
      status: 'completed',
    };
  }

  const plan = await assertConfirmedEditFlowPlan({
    workspaceRoot: input.workspaceRoot,
    projectRoot: input.projectRoot,
    editId,
    editRuleCategory: input.editRuleCategory,
    requiredCapabilityIds: [input.capabilityId],
  });

  if (input.capabilityId === 'trip.event_table') {
    const [editRule, chronologyState] = await Promise.all([
      loadEditRuleByCategory(input.workspaceRoot, input.editRuleCategory),
      loadChronologyReviewState(input.projectRoot),
    ]);
    const outputPath = getPlanningDocumentOutputPath(input.projectRoot, input.capabilityId, editId);
    const packet: IAgentPacket = {
      stage: input.capabilityId,
      identity: 'edit-planning-documenter',
      mission: buildPlanningCapabilityMission(input.capabilityId),
      hardConstraints: [
        '只写 trip.event_table 的 planning markdown，不生成 script/current.json 或 timeline/current.json。',
        '本 capability 的正式事实输入只有 confirmed media/chronology.json；不要要求 store/spans.json 或 analysis/asset-reports/*.json。',
        '缺证据时必须标注缺口，不补写无来源事实。',
        '必须引用 confirmed Flow Plan；不要让代码解析 edit-rule markdown。',
      ],
      allowedInputs: [
        'edit-flow-plan',
        'edit-rule-markdown',
        'confirmed chronology',
      ],
      inputArtifacts: [
        buildEditRuleArtifact(editRule),
        {
          label: 'edit-flow-plan',
          path: getEditFlowPlanPath(input.projectRoot, editId),
          summary: plan.summary ?? `${plan.steps.length} flow steps`,
          content: plan,
        },
        {
          label: 'chronology-summary',
          path: 'media/chronology.json',
          summary: chronologyState.chronology
            ? `${chronologyState.chronology.events.length} chronology events`
            : chronologyState.message,
          content: {
            status: chronologyState.chronology?.status,
            message: chronologyState.message,
            chronology: chronologyState.chronology,
          },
        },
      ],
      outputSchema: { markdown: 'string' },
      reviewRubric: ['unsupported_claims', 'missing_chronology_event', 'scope_violation'],
    };
    const runner = requireDirectEditFlowAgentRunner(input.agentRunner, input.capabilityId);
    const result = await runner.run<{ markdown: string }>({
      promptId: 'edit-flow/planning-documenter',
      packet,
      llm: { jsonMode: true, temperature: 0.2 },
    });
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${(result.markdown ?? '').trim()}\n`, 'utf-8');
    return { capabilityId: input.capabilityId, outputPath, status: 'completed' };
  }

  const [editRule, assets, spans, chronologyState, assetReports, planningArtifacts] = await Promise.all([
    loadEditRuleByCategory(input.workspaceRoot, input.editRuleCategory),
    loadAssets(input.projectRoot),
    assertFreshSpans(input.projectRoot).then(result => result.spans),
    loadChronologyReviewState(input.projectRoot),
    loadAssetReports(input.projectRoot),
    loadEditPlanningPacketArtifacts(input.projectRoot, editId),
  ]);
  const pharosContext = await loadOrBuildProjectPharosContext({
    projectRoot: input.projectRoot,
    includedTripIds: projectBrief.pharos?.includedTripIds ?? [],
  });
  const outputPath = getPlanningDocumentOutputPath(input.projectRoot, input.capabilityId, editId);
  const packet: IAgentPacket = {
    stage: input.capabilityId,
    identity: 'edit-planning-documenter',
    mission: buildPlanningCapabilityMission(input.capabilityId),
    hardConstraints: [
      '只写当前 capability 的 planning markdown，不生成 script/current.json 或 timeline/current.json。',
      '缺证据时必须标注缺口，不补写无来源事实。',
      '必须引用 Flow Plan 和已审 planning artifacts；不要让代码解析 edit-rule markdown。',
    ],
    allowedInputs: [
      'edit-flow-plan',
      'edit-rule-markdown',
      'project brief',
      'Pharos context',
      'chronology',
      'spans',
      'asset reports',
      'prior planning artifacts',
    ],
    inputArtifacts: [
      buildEditRuleArtifact(editRule),
      ...planningArtifacts,
      {
        label: 'project-brief',
        summary: projectBrief.description,
        content: projectBrief,
      },
      {
        label: 'source-context-summary',
        summary: `${assets.length} assets / ${spans.length} spans / ${assetReports.length} reports`,
        content: {
          pharosContext,
          chronology: chronologyState.chronology,
          chronologyMessage: chronologyState.message,
          spans,
          assetReports,
        },
      },
    ],
    outputSchema: { markdown: 'string' },
    reviewRubric: ['unsupported_claims', 'missing_required_source', 'scope_violation'],
  };
  const runner = requireDirectEditFlowAgentRunner(input.agentRunner, input.capabilityId);
  const result = await runner.run<{ markdown: string }>({
    promptId: 'edit-flow/planning-documenter',
    packet,
    llm: { jsonMode: true, temperature: 0.2 },
  });
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${(result.markdown ?? '').trim()}\n`, 'utf-8');
  return { capabilityId: input.capabilityId, outputPath, status: 'completed' };
}

function materializeEditFlowPlan(input: {
  draft: Partial<IEditFlowPlan>;
  projectId: string;
  editId: string;
  editRule: IEditRuleMarkdownSource;
  styleCategory?: string;
  styleProfileHash?: string;
  styleProfileVersion?: 'legacy' | 'layered-v1';
}): IEditFlowPlan {
  const now = new Date().toISOString();
  const steps = normalizePlanSteps(input.draft.steps);
  const styleUsage = normalizeStyleUsage(input.draft.styleUsage, {
    styleCategory: input.styleCategory,
    styleProfileHash: input.styleProfileHash,
    styleProfileVersion: input.styleProfileVersion,
  });
  return ZEditFlowPlan.parse({
    schemaVersion: '1.0',
    id: input.draft.id || randomUUID(),
    projectId: input.projectId,
    editId: input.editId,
    editRuleCategory: input.editRule.categoryId,
    editRuleHash: input.editRule.contentHash,
    generatedAt: now,
    updatedAt: now,
    status: 'draft',
    summary: input.draft.summary?.trim() || undefined,
    assumptions: (input.draft.assumptions ?? []).map(item => item.trim()).filter(Boolean),
    styleUsage,
    steps,
  });
}

function normalizeStyleUsage(
  raw: unknown,
  metadata: {
    styleCategory?: string;
    styleProfileHash?: string;
    styleProfileVersion?: 'legacy' | 'layered-v1';
  },
): IStyleUsage | undefined {
  const parsed = ZStyleUsage.safeParse(raw);
  const hasRequestedLayer = parsed.success && hasAnyStyleLayerUsage(parsed.data);
  if (!parsed.success && !metadata.styleCategory) return undefined;
  const base = parsed.success
    ? parsed.data
    : ZStyleUsage.parse({});
  const next = ZStyleUsage.parse({
    ...base,
    styleCategory: base.styleCategory ?? metadata.styleCategory,
    styleProfileHash: base.styleProfileHash ?? metadata.styleProfileHash,
    styleProfileVersion: base.styleProfileVersion ?? metadata.styleProfileVersion,
  });
  return hasRequestedLayer || metadata.styleCategory ? next : undefined;
}

async function assertStyleUsageReadyForPlan(input: {
  workspaceRoot: string;
  projectRoot: string;
  editId: string;
  plan: IEditFlowPlan;
}): Promise<void> {
  const styleUsage = input.plan.styleUsage;
  if (!styleUsage || !hasAnyStyleLayerUsage(styleUsage)) return;
  const category = styleUsage.styleCategory?.trim();
  if (!category) {
    throw new Error('edit flow plan requires styleCategory because styleUsage enables one or more style layers');
  }
  const profile = await loadStyleByCategory(`${input.workspaceRoot}/config/styles`, category);
  if (!isLayeredStyleProfile(profile)) {
    throw new Error(`style profile "${category}" is legacy; rerun /style or rewrite it with styleProfileVersion=layered-v1 before confirming this Flow Plan`);
  }
  const currentHash = computeStyleProfileHash(profile);
  if (styleUsage.styleProfileHash && styleUsage.styleProfileHash !== currentHash) {
    const stale = {
      ...input.plan,
      status: 'stale' as const,
      staleReason: 'style profile hash changed',
      updatedAt: new Date().toISOString(),
    };
    await writeEditFlowPlan(input.projectRoot, stale, input.editId);
    throw new Error(`edit flow plan is stale for edits/${input.editId}; selected style profile changed`);
  }
  if (styleUsage.styleProfileVersion && styleUsage.styleProfileVersion !== 'layered-v1') {
    throw new Error(`style profile "${category}" is not layered-v1`);
  }
}

function hasAnyStyleLayerUsage(styleUsage: IStyleUsage): boolean {
  return Object.values(styleUsage.layers).some(layer => layer.mode !== 'off');
}

function normalizePlanSteps(value: unknown): IEditFlowPlanStep[] {
  if (!Array.isArray(value)) return [];
  const steps: IEditFlowPlanStep[] = [];
  value.forEach((step, index) => {
    if (typeof step !== 'object' || step == null) return;
    const raw = step as Partial<IEditFlowPlanStep>;
    const capabilityId = typeof raw.capabilityId === 'string' ? raw.capabilityId.trim() : '';
    if (!isEditFlowCapabilityId(capabilityId)) return;
    const runner = normalizeCapabilityRunner(capabilityId, raw.runner);
    steps.push({
      id: typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : `step-${index + 1}`,
      capabilityId,
      title: typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : undefined,
      inputRefs: normalizeStepInputRefs(capabilityId, raw.inputRefs),
      outputRefs: normalizeStepOutputRefs(capabilityId, raw.outputRefs),
      outputTypes: normalizeStepOutputTypes(capabilityId, raw.outputTypes),
      runner,
      execution: normalizeStepExecution(raw.execution, runner),
      gate: raw.gate === 'human' ? 'human' : 'none',
      notes: Array.isArray(raw.notes) ? raw.notes.filter(isNonEmptyString) : [],
    });
  });
  return ensureResolveMediaSyncBeforeTimeline(steps);
}

function normalizeStepInputRefs(capabilityId: TEditFlowCapabilityId, value: unknown): string[] {
  if (capabilityId === 'trip.event_table') return ['media/chronology.json'];
  if (capabilityId === 'resolve.media_sync') {
    return [
      'store/spans.json',
      'store/assets.json',
      'media/chronology.json',
      'config/project-brief.json',
    ];
  }
  if (capabilityId === 'timeline.generate') {
    return [
      'DaVinci Resolve Media Pool',
      'edits/<editId>/planning/edit-framework.md',
      'edits/<editId>/script/material-slots.json',
      'store/spans.json',
      'store/assets.json',
      'media/chronology.json',
    ];
  }
  return Array.isArray(value) ? value.filter(isNonEmptyString) : [];
}

function normalizeStepOutputRefs(capabilityId: TEditFlowCapabilityId, value: unknown): string[] {
  if (capabilityId === 'material.recall') return ['edits/<editId>/script/material-slots.json'];
  if (capabilityId === 'resolve.media_sync') return ['DaVinci Resolve Media Pool'];
  if (capabilityId === 'timeline.generate') return ['DaVinci Resolve Timeline'];
  return Array.isArray(value) ? value.filter(isNonEmptyString) : [];
}

function normalizeStepOutputTypes(capabilityId: TEditFlowCapabilityId, value: unknown): Record<string, string> | undefined {
  if (capabilityId === 'material.recall') {
    return { 'edits/<editId>/script/material-slots.json': 'material-slots' };
  }
  if (capabilityId === 'timeline.generate') {
    return { 'DaVinci Resolve Timeline': 'resolve-timeline' };
  }
  if (capabilityId === 'resolve.media_sync') {
    return { 'DaVinci Resolve Media Pool': 'resolve-state' };
  }
  return normalizeOutputTypes(value);
}

function normalizeStepExecution(
  value: unknown,
  runner?: 'deterministic' | 'agent' | 'script' | 'manual',
): IEditFlowStepExecution {
  const raw = typeof value === 'object' && value != null
    ? value as Partial<IEditFlowStepExecution>
    : {};
  const mode = raw.mode === 'sharded-agent'
    ? 'sharded-agent'
    : raw.mode === 'deterministic' || runner === 'deterministic'
      ? 'deterministic'
    : raw.mode === 'manual' || runner === 'manual'
      ? 'manual'
      : 'single-agent';
  const allowedShardBy = new Set(['none', 'day', 'event', 'scene', 'topic', 'segment']);
  const shardBy = mode === 'sharded-agent' && typeof raw.shardBy === 'string' && allowedShardBy.has(raw.shardBy)
    ? raw.shardBy as IEditFlowStepExecution['shardBy']
    : 'none';
  const shardPacking = normalizeShardPacking(raw.shardPacking);
  return {
    mode,
    shardBy: mode === 'sharded-agent' ? shardBy : 'none',
    ...(mode === 'sharded-agent' && shardPacking ? { shardPacking } : {}),
    ...(mode === 'sharded-agent'
      ? {
        codexSubagentProfile: {
          reasoningEffort: 'high',
          forkContext: false,
          speed: 'standard',
        },
      }
      : {}),
    reason: typeof raw.reason === 'string' && raw.reason.trim() ? raw.reason.trim() : undefined,
  };
}

function normalizeShardPacking(value: unknown): IEditFlowStepExecution['shardPacking'] {
  const raw = typeof value === 'object' && value != null
    ? value as Partial<NonNullable<IEditFlowStepExecution['shardPacking']>>
    : {};
  if (raw.base !== 'day') return undefined;
  if (raw.metric !== 'chronologyEventCount' && raw.metric !== 'materialRefCount') return undefined;
  if (typeof raw.maxPerShard !== 'number' || !Number.isFinite(raw.maxPerShard) || raw.maxPerShard <= 0) {
    return undefined;
  }
  return {
    base: 'day',
    metric: raw.metric,
    maxPerShard: Math.max(1, Math.floor(raw.maxPerShard)),
    preserveOrder: true,
  };
}

function requireDirectEditFlowAgentRunner(
  agentRunner: IJsonPacketAgentRunner | undefined,
  stage: string,
): IJsonPacketAgentRunner {
  if (agentRunner) return agentRunner;
  throw new AgentRunnerUnavailableError(`${stage} requires direct Agent/SubAgent execution`);
}

function getPlanningDocumentOutputPath(
  projectRoot: string,
  capabilityId: TEditFlowCapabilityId,
  editId?: string | null,
): string {
  if (capabilityId === 'trip.event_table') return getEditPlanningArtifactPath(projectRoot, 'event-table.md', editId);
  if (capabilityId === 'material.archive') return getEditPlanningArtifactPath(projectRoot, 'material-archive.md', editId);
  return getEditPlanningArtifactPath(projectRoot, 'edit-framework.md', editId);
}

function buildPlanningCapabilityMission(capabilityId: TEditFlowCapabilityId): string {
  if (capabilityId === 'trip.event_table') {
    return '生成供人工审查的行程和事件表，整合 Pharos、GPS、chronology、ASR 和素材分析缺口。';
  }
  if (capabilityId === 'material.archive') {
    return '生成供下游召回使用的完整素材档案，覆盖素材强项、缺口、可用原声、关键过程与证据索引。';
  }
  return '生成初版剪辑框架文本，严格依据确认过的 Flow Plan、事件表、素材档案和剪辑规则 markdown。';
}

function firstMarkdownLine(markdown: string): string {
  return markdown
    .split('\n')
    .map(line => line.replace(/^#+\s*/u, '').trim())
    .find(Boolean) ?? 'planning artifact';
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizeRunner(value: unknown): IEditFlowPlanStep['runner'] | undefined {
  if (value === 'deterministic' || value === 'agent' || value === 'script' || value === 'manual') return value;
  return undefined;
}

function normalizeCapabilityRunner(
  capabilityId: TEditFlowCapabilityId,
  value: unknown,
): IEditFlowPlanStep['runner'] {
  if (capabilityId === 'resolve.media_sync') return 'deterministic';
  if (capabilityId === 'timeline.generate') return 'deterministic';
  return normalizeRunner(value) ?? CEDIT_FLOW_CAPABILITY_CATALOG.find(item => item.capabilityId === capabilityId)?.defaultRunner;
}

function ensureResolveMediaSyncBeforeTimeline(steps: IEditFlowPlanStep[]): IEditFlowPlanStep[] {
  const timelineIndex = steps.findIndex(step => step.capabilityId === 'timeline.generate');
  if (timelineIndex < 0 || steps.some(step => step.capabilityId === 'resolve.media_sync')) {
    return steps;
  }
  const mediaSyncStep: IEditFlowPlanStep = {
    id: 'resolve-media-sync',
    capabilityId: 'resolve.media_sync',
    title: 'Sync Resolve Media Pool',
    inputRefs: normalizeStepInputRefs('resolve.media_sync', []),
    outputRefs: normalizeStepOutputRefs('resolve.media_sync', []),
    outputTypes: normalizeStepOutputTypes('resolve.media_sync', []),
    runner: 'deterministic',
    execution: normalizeStepExecution({
      mode: 'deterministic',
      shardBy: 'none',
      reason: 'timeline.generate requires already-synced Resolve Media Pool',
    }, 'deterministic'),
    gate: 'none',
    notes: ['Auto-inserted because timeline.generate selects existing Resolve Media Pool items and must not reimport media.'],
  };
  return [
    ...steps.slice(0, timelineIndex),
    mediaSyncStep,
    ...steps.slice(timelineIndex),
  ];
}

function normalizeOutputTypes(value: unknown): Record<string, string> | undefined {
  if (typeof value !== 'object' || value == null || Array.isArray(value)) return undefined;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter((entry): entry is [string, string] => Boolean(entry[0].trim()) && typeof entry[1] === 'string' && Boolean(entry[1].trim()))
    .map(([key, outputType]) => [key.trim(), outputType.trim()] as const);
  if (entries.length === 0) return undefined;
  return Object.fromEntries(entries);
}
