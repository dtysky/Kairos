import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type {
  IAgentPacket,
  IAgentPacketInputArtifact,
  IEditFlowPlan,
  IEditFlowPlanStep,
  IEditRuleMarkdownSource,
  IStyleUsage,
} from '../../protocol/schema.js';
import { IEditFlowPlan as ZEditFlowPlan, IStyleUsage as ZStyleUsage } from '../../protocol/schema.js';
import {
  getEditFlowPlanPath,
  getEditPlanningAgentPacketPath,
  getEditPlanningArtifactPath,
  loadAssetReports,
  loadAssets,
  loadChronology,
  loadEditFlowPlan,
  loadProject,
  loadProjectBriefConfig,
  loadRuntimeConfig,
  loadSpans,
  normalizeEditId,
  writeEditFlowPlan,
} from '../../store/index.js';
import { loadOrBuildProjectPharosContext } from '../pharos/context.js';
import {
  buildCommandJsonPacketAgentRunnerConfig,
  resolveJsonPacketAgentRunner,
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

export async function generateEditFlowPlan(
  input: IGenerateEditFlowPlanInput,
): Promise<IEditFlowPlan> {
  const editId = normalizeEditId(input.editId);
  const styleProfile = input.styleCategory
    ? await loadStyleByCategory(`${input.workspaceRoot}/config/styles`, input.styleCategory)
    : null;
  const styleProfileHash = styleProfile ? computeStyleProfileHash(styleProfile) : undefined;
  const [editRule, project, projectBrief, assets, spans, chronology, assetReports, runtimeConfig] = await Promise.all([
    loadEditRuleByCategory(input.workspaceRoot, input.editRuleCategory),
    loadProject(input.projectRoot),
    loadProjectBriefConfig(input.projectRoot),
    loadAssets(input.projectRoot),
    loadSpans(input.projectRoot),
    loadChronology(input.projectRoot),
    loadAssetReports(input.projectRoot),
    loadRuntimeConfig(input.projectRoot),
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
      spans: spans.length,
      chronologyItems: chronology.length,
      assetReports: assetReports.length,
    },
  };
  const packet: IAgentPacket = {
    stage: 'edit-flow-plan',
    identity: 'edit-flow-planner',
    mission: '读取剪辑规则 markdown、项目上下文和固定能力目录，生成一个显式、可人工确认、可由代码执行的 Edit Flow Plan。',
    hardConstraints: [
      '只能选择 packet 中 capability catalog 明确列出的 capabilityId。',
      '不要把剪辑规则正文翻译成代码启发式；你的输出必须是显式 flow plan。',
      '每个 step 必须写 capabilityId、inputRefs、outputRefs 和 gate。',
      '需要人工审查的规划文档或阶段必须标记 gate=human。',
      '不要要求代码读取 markdown 正文来做剪辑判断；规则解释只能体现在你的 plan 和后续 LLM stage packet 中。',
      '如果剪辑规则自由正文要求使用风格档案，请把本轮使用层结构化写入 styleUsage。',
      'styleUsage.layers 只能使用 literary / artistic / editingTechnical，mode 只能是 off / soft / hard。',
      'hard 只能来自剪辑规则正文的显式要求；不要把参考视频观察自动升级成硬规则。',
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
        summary: `${assets.length} assets / ${spans.length} spans / ${pharosContext.trips.length} Pharos trips`,
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
      steps: 'Array<{ id: string, capabilityId: one of capability catalog, title?: string, inputRefs: string[], outputRefs: string[], gate: "none" | "human", notes?: string[] }>',
    },
    reviewRubric: [
      'unknown_capability',
      'missing_gate',
      'markdown_heuristic_leak',
      'missing_project_context',
      'missing_required_io_refs',
    ],
  };
  await writePlanningPacket(input.projectRoot, 'edit-flow-plan', packet, editId);

  const runner = resolveJsonPacketAgentRunner({
    agentRunner: input.agentRunner,
    commandRunner: buildCommandJsonPacketAgentRunnerConfig(runtimeConfig),
  });
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

  await assertConfirmedEditFlowPlan({
    workspaceRoot: input.workspaceRoot,
    projectRoot: input.projectRoot,
    editId,
    editRuleCategory: input.editRuleCategory,
    requiredCapabilityIds: [input.capabilityId],
  });

  const [editRule, assets, spans, chronology, assetReports, runtimeConfig, planningArtifacts] = await Promise.all([
    loadEditRuleByCategory(input.workspaceRoot, input.editRuleCategory),
    loadAssets(input.projectRoot),
    loadSpans(input.projectRoot),
    loadChronology(input.projectRoot),
    loadAssetReports(input.projectRoot),
    loadRuntimeConfig(input.projectRoot),
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
          chronology,
          spans,
          assetReports,
        },
      },
    ],
    outputSchema: { markdown: 'string' },
    reviewRubric: ['unsupported_claims', 'missing_required_source', 'scope_violation'],
  };
  await writePlanningPacket(input.projectRoot, input.capabilityId, packet, editId);
  const runner = resolveJsonPacketAgentRunner({
    agentRunner: input.agentRunner,
    commandRunner: buildCommandJsonPacketAgentRunnerConfig(runtimeConfig),
  });
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
    steps.push({
      id: typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : `step-${index + 1}`,
      capabilityId,
      title: typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : undefined,
      inputRefs: Array.isArray(raw.inputRefs) ? raw.inputRefs.filter(isNonEmptyString) : [],
      outputRefs: Array.isArray(raw.outputRefs) ? raw.outputRefs.filter(isNonEmptyString) : [],
      gate: raw.gate === 'human' ? 'human' : 'none',
      notes: Array.isArray(raw.notes) ? raw.notes.filter(isNonEmptyString) : [],
    });
  });
  return steps;
}

async function writePlanningPacket(
  projectRoot: string,
  stage: string,
  packet: IAgentPacket,
  editId?: string | null,
): Promise<void> {
  const target = getEditPlanningAgentPacketPath(projectRoot, stage.replace(/[^a-z0-9_.-]+/giu, '-'), editId);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(packet, null, 2)}\n`, 'utf-8');
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
