import { readFile } from 'node:fs/promises';
import type {
  IAgentPacketInputArtifact,
  IEditFlowPlan,
  IEditRuleMarkdownSource,
  IStyleUsage,
} from '../../protocol/schema.js';
import {
  IEditFlowPlan as ZEditFlowPlan,
} from '../../protocol/schema.js';
import {
  getEditFlowPlanPath,
  getEditPlanningArtifactPath,
  loadEditFlowPlan,
  markEditFlowPlanStale,
  normalizeEditId,
} from '../../store/index.js';
import { loadEditRuleByCategory } from '../script/edit-rule-loader.js';
import {
  computeStyleProfileHash,
  isLayeredStyleProfile,
  loadStyleByCategory,
} from '../script/style-loader.js';
import { CMATERIAL_ID_POLICY_VERSION } from '../media/material-ids.js';
import type { TEditFlowCapabilityId } from './capabilities.js';

export const CEDIT_FLOW_PLANNER_POLICY_VERSION = 'codex-agent-v1' as const;
export const CMATERIAL_TIME_POLICY_VERSION = 'normalized-captured-at-v1' as const;

export interface IAssertConfirmedEditFlowPlanInput {
  workspaceRoot: string;
  projectRoot: string;
  editId?: string | null;
  editRuleCategory: string;
  requiredCapabilityIds?: TEditFlowCapabilityId[];
}

export interface IEditFlowPlanFreshness {
  status: 'missing' | 'fresh' | 'stale';
  staleReason?: string;
}

export async function loadEditFlowPlanReadOnly(
  workspaceRoot: string,
  projectRoot: string,
  editId?: string | null,
): Promise<IEditFlowPlan | null> {
  const normalizedEditId = normalizeEditId(editId);
  const plan = await loadEditFlowPlan(projectRoot, normalizedEditId);
  if (!plan) return null;
  const freshness = await evaluateEditFlowPlanFreshness({
    workspaceRoot,
    projectRoot,
    editId: normalizedEditId,
    plan,
  });
  if (freshness.status !== 'stale') return plan;
  return ZEditFlowPlan.parse({
    ...plan,
    status: 'stale',
    staleReason: freshness.staleReason,
  });
}

export async function evaluateEditFlowPlanFreshness(input: {
  workspaceRoot: string;
  projectRoot: string;
  editId?: string | null;
  editRuleCategory?: string;
  plan?: IEditFlowPlan | null;
}): Promise<IEditFlowPlanFreshness> {
  const editId = normalizeEditId(input.editId);
  const plan = input.plan ?? await loadEditFlowPlan(input.projectRoot, editId);
  if (!plan) return { status: 'missing' };
  if (input.editRuleCategory && plan.editRuleCategory !== input.editRuleCategory) {
    return {
      status: 'stale',
      staleReason: `edit unit rule changed: ${input.editRuleCategory}`,
    };
  }
  let editRule: IEditRuleMarkdownSource;
  try {
    editRule = await loadEditRuleByCategory(input.workspaceRoot, input.editRuleCategory || plan.editRuleCategory);
  } catch (error) {
    return {
      status: 'stale',
      staleReason: `edit rule markdown unavailable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (plan.editRuleHash !== editRule.contentHash) {
    return { status: 'stale', staleReason: 'edit rule markdown hash changed' };
  }
  if (!isCurrentPlannerPolicy(plan)) {
    return { status: 'stale', staleReason: plannerPolicyStaleReason() };
  }
  if (!isCurrentMaterialIdPolicy(plan)) {
    return { status: 'stale', staleReason: materialIdPolicyStaleReason() };
  }
  if (!isCurrentMaterialTimePolicy(plan)) {
    return { status: 'stale', staleReason: materialTimePolicyStaleReason() };
  }
  const styleStaleReason = await evaluateStyleUsageFreshness(input.workspaceRoot, plan);
  if (styleStaleReason) {
    return { status: 'stale', staleReason: styleStaleReason };
  }
  return { status: 'fresh' };
}

export async function assertConfirmedEditFlowPlan(
  input: IAssertConfirmedEditFlowPlanInput,
): Promise<IEditFlowPlan> {
  const editId = normalizeEditId(input.editId);
  const plan = await loadEditFlowPlan(input.projectRoot, editId);
  if (!plan) {
    throw new Error(`confirmed edit flow plan is required before this stage: edits/${editId}/planning/flow-plan.json`);
  }
  const freshness = await evaluateEditFlowPlanFreshness({
    workspaceRoot: input.workspaceRoot,
    projectRoot: input.projectRoot,
    editId,
    editRuleCategory: input.editRuleCategory,
    plan,
  });
  if (freshness.status === 'stale') {
    await markEditFlowPlanStale(input.projectRoot, editId, freshness.staleReason ?? 'edit flow plan is stale');
    throw new Error(`edit flow plan is stale for edits/${editId}; ${freshness.staleReason ?? 'regenerate it with Codex Agent'}`);
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
  const artifactNames = ['event-table.md', 'material-archive.md', 'edit-framework.md'];
  const artifacts: IAgentPacketInputArtifact[] = [];
  for (const artifactName of artifactNames) {
    const path = getEditPlanningArtifactPath(projectRoot, artifactName, normalizedEditId);
    const content = await readFile(path, 'utf-8').catch(() => null);
    if (!content?.trim()) continue;
    artifacts.push({
      label: artifactName.replace(/\.md$/u, ''),
      path,
      summary: `edits/${normalizedEditId}/planning/${artifactName}`,
      content: { text: content },
    });
  }
  return artifacts;
}

export function buildEditRuleArtifact(editRule: IEditRuleMarkdownSource): IAgentPacketInputArtifact {
  return {
    label: 'edit-rule-markdown',
    path: editRule.absolutePath,
    summary: `${editRule.displayName} (${editRule.categoryId})`,
    content: {
      categoryId: editRule.categoryId,
      displayName: editRule.displayName,
      description: editRule.description,
      contentHash: editRule.contentHash,
      markdown: editRule.markdown,
    },
  };
}

export function assertEditFrameworkMarkdownContract(
  markdown: string,
  inputArtifacts: IAgentPacketInputArtifact[] = [],
): void {
  const errors: string[] = [];
  if (!markdown.trim()) {
    errors.push('markdown is empty');
  }
  if (/beat\s*边界索引|边界索引/iu.test(markdown)) {
    errors.push('must not contain beat 边界索引');
  }
  if (/\bchronology\b/iu.test(markdown)) {
    errors.push('must not mention chronology in the handoff markdown');
  }
  if (/\b(?:event|route|gap)-[a-z0-9][a-z0-9-]*\b/iu.test(markdown)) {
    errors.push('must not contain chronology event/route/gap ids');
  }
  if (/\b(?:spanId|spanIds|assetId|assetIds)\b/iu.test(markdown) || /\b(?:span|asset)__[^\s|，。；、)）]+/iu.test(markdown)) {
    errors.push('must not contain spanId/assetId fields or legacy span__/asset__ ids');
  }
  const concreteId = markdown.match(/\b[A-Za-z0-9-]{2,}_(?:zve1|drone|ts-final|photos)(?:_[A-Za-z0-9-]{1,}){0,4}(?:_(?:drive|broll|aerial|timelapse|talking-head|photo|speech|visual|mixed|s\d+-\d+))*\b/iu);
  if (concreteId) {
    errors.push(`must not contain concrete material id "${concreteId[0]}"`);
  }
  const knownIds = collectMaterialIdsFromArtifacts(inputArtifacts);
  for (const id of knownIds) {
    if (id.length >= 6 && markdown.includes(id)) {
      errors.push(`must not contain concrete material id "${id}"`);
      break;
    }
  }

  const rows = extractSegmentTableRows(markdown);
  if (rows.length === 0) {
    errors.push('分段操作稿 must contain at least one table row');
  }
  for (const row of rows) {
    const beatCell = row[0] ?? '';
    const spansCell = row[2] ?? '';
    if (!/\bFW-\d{2}-\d{2}\b/u.test(beatCell)) {
      errors.push(`segment row must start with a stable FW beat id: ${beatCell.trim() || '(empty)'}`);
    }
    if (!/^共\s*\d+\s*段\s*[:：]/u.test(spansCell.trim())) {
      errors.push(`spans column must use countable type totals: ${spansCell.trim() || '(empty)'}`);
    }
    if (!/[^\d\s:：、，()（）/]+\s*\d+/u.test(spansCell)) {
      errors.push(`spans column must name material types with counts: ${spansCell.trim() || '(empty)'}`);
    }
    if (/高密度素材组|高密度|多段|少量|若干|含口播|有口播(?!语音\d)|口播素材|素材组/u.test(spansCell)) {
      errors.push(`spans column contains vague material wording: ${spansCell.trim()}`);
    }
  }
  const recallIndex = extractMarkdownSection(markdown, '给 material.recall 的执行索引');
  if (recallIndex && /\bFW-\d{2}-\d{2}\b/u.test(recallIndex)) {
    errors.push('material.recall execution index must contain global rules only, not per-beat FW ids');
  }
  if (errors.length > 0) {
    throw new Error(`edit.framework contract failed:\n- ${[...new Set(errors)].join('\n- ')}`);
  }
}

function isCurrentPlannerPolicy(plan: IEditFlowPlan): boolean {
  return plan.plannerPolicyVersion === CEDIT_FLOW_PLANNER_POLICY_VERSION;
}

function isCurrentMaterialIdPolicy(plan: IEditFlowPlan): boolean {
  return plan.materialIdPolicyVersion === CMATERIAL_ID_POLICY_VERSION;
}

function isCurrentMaterialTimePolicy(plan: IEditFlowPlan): boolean {
  return plan.materialTimePolicyVersion === CMATERIAL_TIME_POLICY_VERSION;
}

function plannerPolicyStaleReason(): string {
  return `planner policy changed: ${CEDIT_FLOW_PLANNER_POLICY_VERSION}`;
}

function materialIdPolicyStaleReason(): string {
  return `material id policy changed: ${CMATERIAL_ID_POLICY_VERSION}`;
}

function materialTimePolicyStaleReason(): string {
  return `material time policy changed: ${CMATERIAL_TIME_POLICY_VERSION}`;
}

async function evaluateStyleUsageFreshness(
  workspaceRoot: string,
  plan: IEditFlowPlan,
): Promise<string | null> {
  const styleUsage = plan.styleUsage;
  if (!styleUsage || !hasAnyStyleLayerUsage(styleUsage)) return null;
  const category = styleUsage.styleCategory?.trim();
  if (!category) return null;
  const profile = await loadStyleByCategory(`${workspaceRoot}/config/styles`, category).catch(() => null);
  if (!profile) return `style profile unavailable: ${category}`;
  if (styleUsage.styleProfileHash && computeStyleProfileHash(profile) !== styleUsage.styleProfileHash) {
    return 'style profile hash changed';
  }
  return null;
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
    throw new Error(`style profile "${category}" is legacy; rerun /style or rewrite it with styleProfileVersion=layered-v1 before using this Flow Plan`);
  }
  const currentHash = computeStyleProfileHash(profile);
  if (styleUsage.styleProfileHash && styleUsage.styleProfileHash !== currentHash) {
    await markEditFlowPlanStale(input.projectRoot, input.editId, 'style profile hash changed');
    throw new Error(`edit flow plan is stale for edits/${input.editId}; selected style profile changed`);
  }
  if (styleUsage.styleProfileVersion && styleUsage.styleProfileVersion !== 'layered-v1') {
    throw new Error(`style profile "${category}" is not layered-v1`);
  }
}

function hasAnyStyleLayerUsage(styleUsage: IStyleUsage): boolean {
  return Object.values(styleUsage.layers).some(layer => layer.mode !== 'off');
}

function collectMaterialIdsFromArtifacts(inputArtifacts: IAgentPacketInputArtifact[]): string[] {
  const ids = new Set<string>();
  const visit = (value: unknown, key?: string): void => {
    if (typeof value === 'string') {
      if (key === 'id' || key === 'assetId' || key === 'spanId' || key === 'chosenSpanId') {
        ids.add(value);
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(item => visit(item, key));
      return;
    }
    if (typeof value !== 'object' || value == null) return;
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
      if (childKey === 'spanIds' || childKey === 'chosenSpanIds') {
        if (Array.isArray(childValue)) {
          childValue.filter((item): item is string => typeof item === 'string').forEach(item => ids.add(item));
        }
        continue;
      }
      visit(childValue, childKey);
    }
  };
  for (const artifact of inputArtifacts) {
    visit(artifact.content);
  }
  return [...ids].sort((a, b) => b.length - a.length);
}

function extractSegmentTableRows(markdown: string): string[][] {
  const section = extractMarkdownSection(markdown, '分段操作稿');
  if (!section) return [];
  return section
    .split(/\r?\n/u)
    .map(line => line.trim())
    .filter(line => line.startsWith('|') && line.endsWith('|'))
    .map(line => line.slice(1, -1).split('|').map(cell => cell.trim()))
    .filter(cells => cells.length >= 4)
    .filter(cells => !/^[-:\s]+$/u.test(cells.join('')))
    .filter(cells => !/^(事件|段落|FW|beat)$/iu.test(cells[0] ?? ''));
}

function extractMarkdownSection(markdown: string, title: string): string | null {
  const lines = markdown.split(/\r?\n/u);
  const start = lines.findIndex(line => line.trim() === `## ${title}`);
  if (start < 0) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex(line => /^##\s+/u.test(line.trim()));
  return (end < 0 ? rest : rest.slice(0, end)).join('\n');
}

export function getCodexAgentFlowPlanPath(projectRoot: string, editId?: string | null): string {
  return getEditFlowPlanPath(projectRoot, editId);
}
