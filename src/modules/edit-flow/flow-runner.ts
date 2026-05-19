import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, extname, join, relative } from 'node:path';
import type {
  IAgentPacket,
  IAgentPacketInputArtifact,
  IEditFlowPlan,
  IEditFlowPlanStep,
  IEditFlowStepRunRecord,
  IMaterialSlotsDocument,
} from '../../protocol/schema.js';
import { IMaterialSlotsDocument as ZMaterialSlotsDocument } from '../../protocol/schema.js';
import {
  getEditFlowPlanPath,
  getMaterialSlotsPath,
  getProjectEditRoot,
  getSegmentPlanPath,
  getTimelineCurrentPath,
  assertFreshSpans,
  assertConfirmedProjectChronology,
  loadAssets,
  loadAssetReports,
  loadChronologyReviewState,
  loadEditFlowPlan,
  loadEditFlowRunRecords,
  normalizeEditId,
  writeMaterialSlots,
  writeEditFlowRunRecord,
  findLatestEditFlowStepRunRecord,
  readJsonOrNull,
} from '../../store/index.js';
import {
  AgentRunnerUnavailableError,
  type IJsonPacketAgentRunner,
} from '../agents/runtime.js';
import { loadEditRuleByCategory } from '../script/edit-rule-loader.js';
import {
  CEDIT_FLOW_CAPABILITY_CATALOG,
  isEditFlowCapabilityId,
  type TEditFlowCapabilityId,
} from './capabilities.js';
import {
  assertConfirmedEditFlowPlan,
  buildEditRuleArtifact,
  confirmEditFlowPlan,
  generateEditFlowPlan,
  runEditPlanningDocumentCapability,
} from './flow-planner.js';
import {
  assertMaterialSlotsContract,
  buildMaterialRecallCoverageAudit,
} from './material-slots-contract.js';
import { buildProjectTimeline, syncProjectResolveMedia } from '../timeline-core/project-timeline.js';

export type TEditFlowAction = 'plan' | 'confirm-plan' | 'run-step' | 'confirm-step' | 'run-next';

export interface IRunEditFlowActionInput {
  workspaceRoot: string;
  projectRoot: string;
  editId?: string | null;
  action: TEditFlowAction;
  editRuleCategory?: string;
  styleCategory?: string;
  stepId?: string;
  runner?: 'deterministic' | 'agent' | 'script' | 'manual';
  agentRunner?: IJsonPacketAgentRunner;
}

export async function runEditFlowAction(input: IRunEditFlowActionInput): Promise<{
  action: TEditFlowAction;
  flowPlan?: IEditFlowPlan;
  runRecord?: IEditFlowStepRunRecord;
  runs?: IEditFlowStepRunRecord[];
}> {
  const editId = normalizeEditId(input.editId);
  if (input.action === 'plan') {
    if (!input.editRuleCategory) {
      throw new Error('edit-flow plan requires editRuleCategory');
    }
    const flowPlan = await generateEditFlowPlan({
      workspaceRoot: input.workspaceRoot,
      projectRoot: input.projectRoot,
      editId,
      editRuleCategory: input.editRuleCategory,
      styleCategory: input.styleCategory,
      agentRunner: input.agentRunner,
    });
    return { action: input.action, flowPlan };
  }
  if (input.action === 'confirm-plan') {
    return {
      action: input.action,
      flowPlan: await confirmEditFlowPlan(input.workspaceRoot, input.projectRoot, editId),
    };
  }
  if (input.action === 'confirm-step') {
    if (!input.stepId) throw new Error('edit-flow confirm-step requires stepId');
    return {
      action: input.action,
      runRecord: await confirmEditFlowStep({
        projectRoot: input.projectRoot,
        editId,
        stepId: input.stepId,
      }),
      runs: await loadEditFlowRunRecords(input.projectRoot, editId),
    };
  }

  const plan = await loadAndAssertRunnablePlan({
    workspaceRoot: input.workspaceRoot,
    projectRoot: input.projectRoot,
    editId,
    editRuleCategory: input.editRuleCategory,
  });
  const step = input.action === 'run-next'
    ? await findNextRunnableStep(input.projectRoot, editId, plan)
    : plan.steps.find(item => item.id === input.stepId);
  if (!step) {
    throw new Error(input.action === 'run-next'
      ? `no runnable edit-flow step remains for edits/${editId}`
      : `edit-flow step not found: ${input.stepId ?? '(missing stepId)'}`);
  }
  await assertPriorHumanGatesComplete(input.projectRoot, editId, plan, step.id);
  const runRecord = await runEditFlowStep({
    workspaceRoot: input.workspaceRoot,
    projectRoot: input.projectRoot,
    editId,
    plan,
    step,
    runnerOverride: input.runner,
    agentRunner: input.agentRunner,
  });
  return {
    action: input.action,
    flowPlan: plan,
    runRecord,
    runs: await loadEditFlowRunRecords(input.projectRoot, editId),
  };
}

async function loadAndAssertRunnablePlan(input: {
  workspaceRoot: string;
  projectRoot: string;
  editId: string;
  editRuleCategory?: string;
}): Promise<IEditFlowPlan> {
  const plan = await loadEditFlowPlan(input.projectRoot, input.editId);
  if (!plan) {
    throw new Error(`confirmed edit flow plan is required before running steps: edits/${input.editId}/planning/flow-plan.json`);
  }
  return assertConfirmedEditFlowPlan({
    workspaceRoot: input.workspaceRoot,
    projectRoot: input.projectRoot,
    editId: input.editId,
    editRuleCategory: input.editRuleCategory || plan.editRuleCategory,
  });
}

async function findNextRunnableStep(
  projectRoot: string,
  editId: string,
  plan: IEditFlowPlan,
): Promise<IEditFlowPlanStep | null> {
  const runs = await loadEditFlowRunRecords(projectRoot, editId);
  for (const step of plan.steps) {
    const latest = runs
      .filter(record => record.stepId === step.id)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
    if (!latest || latest.status === 'failed') return step;
    if (latest.status !== 'completed') return null;
  }
  return null;
}

async function assertPriorHumanGatesComplete(
  projectRoot: string,
  editId: string,
  plan: IEditFlowPlan,
  stepId: string,
): Promise<void> {
  const index = plan.steps.findIndex(step => step.id === stepId);
  const prior = plan.steps.slice(0, Math.max(0, index));
  const runs = await loadEditFlowRunRecords(projectRoot, editId);
  const blockers = prior
    .filter(step => step.gate === 'human')
    .filter(step => {
      const latest = runs
        .filter(record => record.stepId === step.id)
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
      return latest?.status !== 'completed';
    })
    .map(step => `${step.id} (${step.capabilityId})`);
  if (blockers.length > 0) {
    throw new Error(`prior human-gated steps must be confirmed before ${stepId}: ${blockers.join(', ')}`);
  }
}

async function runEditFlowStep(input: {
  workspaceRoot: string;
  projectRoot: string;
  editId: string;
  plan: IEditFlowPlan;
  step: IEditFlowPlanStep;
  runnerOverride?: 'deterministic' | 'agent' | 'script' | 'manual';
  agentRunner?: IJsonPacketAgentRunner;
}): Promise<IEditFlowStepRunRecord> {
  if (!isEditFlowCapabilityId(input.step.capabilityId)) {
    throw new Error(`unknown edit-flow capability: ${input.step.capabilityId}`);
  }
  const capability = CEDIT_FLOW_CAPABILITY_CATALOG.find(item => item.capabilityId === input.step.capabilityId);
  if (!capability) {
    throw new Error(`edit-flow capability is not registered: ${input.step.capabilityId}`);
  }
  const runner = input.runnerOverride || input.step.runner || capability.defaultRunner;
  assertDirectRunnerAvailable({
    runner,
    stepId: input.step.id,
    agentRunner: input.agentRunner,
  });
  const inputSnapshot = await resolveInputRefs(input.projectRoot, input.editId, input.step.inputRefs);
  if (inputSnapshot.missing.length > 0) {
    throw new Error(`edit-flow step ${input.step.id} is missing declared inputRefs: ${inputSnapshot.missing.join(', ')}`);
  }

  const now = new Date().toISOString();
  const recordBase: IEditFlowStepRunRecord = {
    schemaVersion: '1.0',
    runId: randomUUID(),
    editId: input.editId,
    flowPlanId: input.plan.id,
    flowPlanHash: hashJson(input.plan),
    stepId: input.step.id,
    capabilityId: input.step.capabilityId,
    runner,
    status: 'running',
    startedAt: now,
    updatedAt: now,
    inputRefs: input.step.inputRefs,
    outputRefs: input.step.outputRefs,
    inputSnapshot: inputSnapshot.snapshot,
    outputPaths: [],
    summary: {},
    review: {
      status: input.step.gate === 'human' ? 'pending' : 'not_required',
    },
  };
  await writeEditFlowRunRecord(input.projectRoot, recordBase, input.editId);

  try {
    const executionResult = await executeStep({
      ...input,
      capabilityId: input.step.capabilityId,
      runner,
      inputArtifacts: inputSnapshot.artifacts,
    });
    const completedAt = new Date().toISOString();
    const next: IEditFlowStepRunRecord = {
      ...recordBase,
      status: input.step.gate === 'human' ? 'awaiting_review' : 'completed',
      updatedAt: completedAt,
      completedAt: input.step.gate === 'human' ? undefined : completedAt,
      outputPaths: executionResult.outputPaths,
      summary: executionResult.summary ?? {},
    };
    await writeEditFlowRunRecord(input.projectRoot, next, input.editId);
    return next;
  } catch (error) {
    const failed: IEditFlowStepRunRecord = {
      ...recordBase,
      status: 'failed',
      updatedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
    };
    await writeEditFlowRunRecord(input.projectRoot, failed, input.editId);
    throw error;
  }
}

function assertDirectRunnerAvailable(input: {
  runner: 'deterministic' | 'agent' | 'script' | 'manual';
  stepId: string;
  agentRunner?: IJsonPacketAgentRunner;
}): void {
  if (input.runner === 'deterministic' || input.runner === 'manual') return;
  if (input.agentRunner) return;
  throw new AgentRunnerUnavailableError(`Edit Flow step "${input.stepId}" requires direct Agent/SubAgent execution`);
}

async function executeStep(input: {
  workspaceRoot: string;
  projectRoot: string;
  editId: string;
  plan: IEditFlowPlan;
  step: IEditFlowPlanStep;
  capabilityId: TEditFlowCapabilityId;
  runner: 'deterministic' | 'agent' | 'script' | 'manual';
  inputArtifacts: IAgentPacketInputArtifact[];
  agentRunner?: IJsonPacketAgentRunner;
}): Promise<{ outputPaths: string[]; summary?: Record<string, unknown> }> {
  if (input.runner === 'manual') {
    return { outputPaths: [] };
  }
  if (['pharos.parse', 'trip.event_table', 'material.archive', 'edit.framework'].includes(input.capabilityId)) {
    const result = await runEditPlanningDocumentCapability({
      workspaceRoot: input.workspaceRoot,
      projectRoot: input.projectRoot,
      editId: input.editId,
      editRuleCategory: input.plan.editRuleCategory,
      capabilityId: input.capabilityId as Extract<TEditFlowCapabilityId, 'pharos.parse' | 'trip.event_table' | 'material.archive' | 'edit.framework'>,
      agentRunner: input.agentRunner,
    });
    return { outputPaths: [result.outputPath] };
  }
  if (input.capabilityId === 'resolve.media_sync') {
    const result = await syncProjectResolveMedia({
      projectRoot: input.projectRoot,
      editId: input.editId,
      workspaceRoot: input.workspaceRoot,
      editRuleCategory: input.plan.editRuleCategory,
    });
    return {
      outputPaths: [],
      summary: {
        resolveProjectName: result.resolveProjectName,
        namespace: result.hostSummary?.namespace,
        imported: result.hostSummary?.imported,
        reused: result.hostSummary?.reused,
        moved: result.hostSummary?.moved,
        eventFolderCount: result.hostSummary?.eventFolderCount,
        mediaItemCount: result.hostSummary?.mediaItemCount,
      },
    };
  }
  if (input.capabilityId === 'timeline.generate') {
    const result = await buildProjectTimeline({
      projectRoot: input.projectRoot,
      editId: input.editId,
      workspaceRoot: input.workspaceRoot,
      editRuleCategory: input.plan.editRuleCategory,
    });
    return {
      outputPaths: [getTimelineCurrentPath(input.projectRoot, input.editId)],
      summary: {
        resolveProjectName: result.resolveTimeline.resolveProjectName,
        timelineName: result.resolveTimeline.timelineName,
        clipCount: result.resolveTimeline.clipCount,
        sourceRangeValidation: result.resolveTimeline.hostSummary?.sourceRangeValidation,
        stillDurationValidation: result.resolveTimeline.hostSummary?.stillDurationValidation,
        syncSummary: result.resolveTimeline.hostSummary?.syncSummary,
      },
    };
  }
  const segmentPlanPath = getSegmentPlanPath(input.projectRoot, input.editId);
  if (input.capabilityId === 'material.recall') {
    await rm(segmentPlanPath, { force: true });
  }
  const outputPaths = await runGenericAgentCapability(input);
  if (input.capabilityId === 'material.recall') {
    const declaredSegmentPlan = outputPaths.some(outputPath => outputPath === segmentPlanPath
      || outputPath.replaceAll('\\', '/').endsWith('/script/segment-plan.json'));
    if (declaredSegmentPlan || await fileExists(segmentPlanPath)) {
      await rm(segmentPlanPath, { force: true });
      throw new Error('material.recall must not declare or write edits/<editId>/script/segment-plan.json');
    }
    const [materialSlots, assets, spansInfo, assetReports, chronology] = await Promise.all([
      readJsonOrNull(
        getMaterialSlotsPath(input.projectRoot, input.editId),
        ZMaterialSlotsDocument,
      ) as Promise<IMaterialSlotsDocument | null>,
      loadAssets(input.projectRoot),
      assertFreshSpans(input.projectRoot),
      loadAssetReports(input.projectRoot),
      assertConfirmedProjectChronology(input.projectRoot),
    ]);
    if (!materialSlots) {
      throw new Error(`material.recall did not write ${getMaterialSlotsPath(input.projectRoot, input.editId)}`);
    }
    try {
      assertMaterialSlotsContract({
        materialSlots,
        assets,
        spans: spansInfo.spans,
        assetReports,
      });
    } catch (error) {
      await rm(getMaterialSlotsPath(input.projectRoot, input.editId), { force: true });
      throw error;
    }
    await writeMaterialSlots(input.projectRoot, {
      ...materialSlots,
      coverageAudit: buildMaterialRecallCoverageAudit({
        materialSlots,
        assets,
        spans: spansInfo.spans,
        chronologyEvents: chronology.events,
      }),
    }, input.editId);
  }
  return { outputPaths };
}

async function runGenericAgentCapability(input: {
  workspaceRoot: string;
  projectRoot: string;
  editId: string;
  plan: IEditFlowPlan;
  step: IEditFlowPlanStep;
  capabilityId: TEditFlowCapabilityId;
  inputArtifacts: IAgentPacketInputArtifact[];
  agentRunner?: IJsonPacketAgentRunner;
}): Promise<string[]> {
  const [editRule, chronologyState, assetReports] = await Promise.all([
    loadEditRuleByCategory(input.workspaceRoot, input.plan.editRuleCategory),
    loadChronologyReviewState(input.projectRoot),
    loadAssetReports(input.projectRoot),
  ]);
  const packet: IAgentPacket = {
    stage: input.capabilityId,
    identity: 'edit-flow-capability-runner',
    mission: 'Execute exactly one confirmed Edit Flow capability step. Produce only the declared outputRefs and do not invent hidden workflow stages.',
    hardConstraints: [
      'Use only the confirmed Flow Plan step, its declared inputRefs, and provided input artifacts.',
      'Do not require script/current.json unless this step explicitly declares it as an inputRef.',
      'Do not parse edit-rule markdown into code-like hidden heuristics; follow the confirmed Flow Plan.',
      ...(input.capabilityId === 'material.recall'
        ? [
          'Write only edits/<editId>/script/material-slots.json; do not write segment-plan.json.',
          'Every chosenSpanId must have treatments[spanId]={ audio:number, speed:number }; audio is dB, default 0, muted is -100, speed is multiplier, default 1.',
          'If a non-photo span has transcript, transcriptSegments, semanticKind=speech/mixed, or materialPatterns includes 有口播语音, its treatment audio must be 0 and must never be muted.',
          'Treat material.recall as a review-candidate pool: maximize useful coverage by type/day/event, and never silently drop any non-photo speech-backed span; unchosen speech-backed spans must be exposed by coverageAudit.',
          'Do not put mixed, audio:*, speed:*, audio=*, or speed=* text into formal material slot fields.',
        ]
        : []),
      'If evidence is missing, return a clear blocker in the output rather than inventing facts.',
    ],
    allowedInputs: ['confirmed flow plan', 'declared inputRefs', 'edit rule metadata', 'chronology summary', 'asset report summary'],
    inputArtifacts: [
      buildEditRuleArtifact(editRule),
      {
        label: 'confirmed-flow-plan',
        path: getEditFlowPlanPath(input.projectRoot, input.editId),
        summary: input.plan.summary ?? `${input.plan.steps.length} steps`,
        content: input.plan,
      },
      {
        label: 'current-step',
        summary: `${input.step.id} / ${input.step.capabilityId}`,
        content: input.step,
      },
      {
        label: 'chronology-summary',
        summary: chronologyState.chronology
          ? `${chronologyState.chronology.events.length} chronology items`
          : chronologyState.message,
        content: {
          status: chronologyState.chronology?.status,
          message: chronologyState.message,
          chronology: chronologyState.chronology,
        },
      },
      {
        label: 'asset-report-summary',
        summary: `${assetReports.length} asset reports`,
        content: { count: assetReports.length },
      },
      ...input.inputArtifacts,
    ],
    outputSchema: buildCapabilityOutputSchema(input.capabilityId),
    reviewRubric: ['missing_declared_output', 'unsupported_claims', 'scope_violation'],
  };
  const runner = requireDirectEditFlowAgentRunner(input.agentRunner, input.capabilityId);
  const result = await runner.run<{ outputs?: Record<string, unknown> }>({
    promptId: 'edit-flow/capability-runner',
    packet,
    llm: { jsonMode: true, temperature: 0.2 },
  });
  return writeDeclaredOutputs(input.projectRoot, input.editId, input.step.outputRefs, result);
}

function buildCapabilityOutputSchema(capabilityId: TEditFlowCapabilityId): Record<string, unknown> {
  if (capabilityId === 'material.recall') {
    return {
      outputs: {
        'edits/<editId>/script/material-slots.json': {
          id: 'string',
          projectId: 'string',
          generatedAt: 'ISO datetime',
          segments: 'Array<{ segmentId, slots: Array<{ id, query, requirement, targetBundles, chosenSpanIds, treatments: Record<spanId,{ audio:number, speed:number }> }> }>',
          coverageAudit: 'optional audit written by Kairos after validation: byType/byDay/byEvent plus speechProtected available/chosen/dropped counts',
        },
      },
    };
  }
  return {
    outputs: 'Record<outputRef, JSON-or-markdown-content>. Keys should match the step outputRefs exactly.',
  };
}

function requireDirectEditFlowAgentRunner(
  agentRunner: IJsonPacketAgentRunner | undefined,
  stage: string,
): IJsonPacketAgentRunner {
  if (agentRunner) return agentRunner;
  throw new AgentRunnerUnavailableError(`${stage} requires direct Agent/SubAgent execution`);
}

async function confirmEditFlowStep(input: {
  projectRoot: string;
  editId: string;
  stepId: string;
}): Promise<IEditFlowStepRunRecord> {
  const latest = await findLatestEditFlowStepRunRecord(input.projectRoot, input.stepId, input.editId);
  if (!latest) {
    throw new Error(`no edit-flow run exists for step ${input.stepId}`);
  }
  if (latest.status !== 'awaiting_review') {
    throw new Error(`edit-flow step ${input.stepId} is not awaiting review (current: ${latest.status})`);
  }
  const now = new Date().toISOString();
  const confirmed: IEditFlowStepRunRecord = {
    ...latest,
    status: 'completed',
    updatedAt: now,
    completedAt: now,
    review: {
      status: 'confirmed',
      confirmedAt: now,
    },
  };
  await writeEditFlowRunRecord(input.projectRoot, confirmed, input.editId);
  return confirmed;
}

async function resolveInputRefs(
  projectRoot: string,
  editId: string,
  refs: string[],
  options: { includeArtifacts?: boolean } = {},
): Promise<{
  missing: string[];
  snapshot: Record<string, unknown>;
  artifacts: IAgentPacketInputArtifact[];
}> {
  const snapshot: Record<string, unknown> = {};
  const artifacts: IAgentPacketInputArtifact[] = [];
  const missing: string[] = [];
  for (const ref of refs) {
    const normalized = ref.trim();
    if (!normalized || isVirtualOrOptionalRef(normalized)) {
      snapshot[ref] = { status: 'virtual' };
      continue;
    }
    const resolved = resolveProjectRef(projectRoot, editId, normalized);
    if (!resolved) {
      snapshot[ref] = { status: 'unresolved' };
      missing.push(ref);
      continue;
    }
    const matches = await resolveRefMatches(resolved).catch(() => []);
    if (matches.length === 0) {
      snapshot[ref] = { status: 'missing', path: resolved };
      missing.push(ref);
      continue;
    }
    snapshot[ref] = {
      status: 'present',
      paths: matches.map(path => relative(projectRoot, path)),
    };
    if (options.includeArtifacts === false) {
      continue;
    }
    for (const path of matches.slice(0, 20)) {
      const artifact = await buildArtifactForPath(projectRoot, ref, path);
      if (artifact) artifacts.push(artifact);
    }
  }
  return { missing, snapshot, artifacts };
}

function isVirtualOrOptionalRef(ref: string): boolean {
  return ref.startsWith('project:')
    || ref.startsWith('optional ')
    || ref.includes('declared predecessor outputs')
    || ref === 'DaVinci Resolve timeline'
    || ref === 'DaVinci Resolve Media Pool';
}

function resolveProjectRef(projectRoot: string, editId: string, ref: string): string | null {
  const replaced = ref.replaceAll('<editId>', editId);
  const editRoot = getProjectEditRoot(projectRoot, editId);
  if (replaced.startsWith('edits/')) return join(projectRoot, replaced);
  if (replaced.startsWith('planning/')) return join(editRoot, replaced);
  if (replaced.startsWith('script/') || replaced.startsWith('timeline/') || replaced.startsWith('subtitles/')) {
    return join(editRoot, replaced);
  }
  if (/^(analysis|store|media|config|gps|pharos|color)\//u.test(replaced)) {
    return join(projectRoot, replaced);
  }
  return null;
}

async function resolveRefMatches(pathOrPattern: string): Promise<string[]> {
  if (!pathOrPattern.includes('*')) {
    await access(pathOrPattern);
    return [pathOrPattern];
  }
  const dir = dirname(pathOrPattern);
  const basename = pathOrPattern.slice(dir.length + 1);
  const pattern = new RegExp(`^${basename.split('*').map(escapeRegExp).join('.*')}$`, 'u');
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries
    .filter(entry => entry.isFile() && pattern.test(entry.name))
    .map(entry => join(dir, entry.name));
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function buildArtifactForPath(
  projectRoot: string,
  ref: string,
  path: string,
): Promise<IAgentPacketInputArtifact | null> {
  const ext = extname(path).toLowerCase();
  if (!['.json', '.md', '.txt'].includes(ext)) {
    return {
      label: ref,
      path,
      summary: relative(projectRoot, path),
    };
  }
  const raw = await readFile(path, 'utf-8').catch(() => '');
  if (!raw.trim()) return null;
  return {
    label: ref,
    path,
    summary: relative(projectRoot, path),
    content: ext === '.json' ? tryParseJson(raw) : { text: raw },
  };
}

async function writeDeclaredOutputs(
  projectRoot: string,
  editId: string,
  refs: string[],
  result: { outputs?: Record<string, unknown> } | Record<string, unknown>,
): Promise<string[]> {
  const outputs = isRecord((result as { outputs?: unknown }).outputs)
    ? (result as { outputs: Record<string, unknown> }).outputs
    : null;
  const written: string[] = [];
  for (const ref of refs) {
    const resolved = resolveProjectRef(projectRoot, editId, ref);
    if (!resolved || resolved.includes('*')) continue;
    const value = outputs?.[ref] ?? (refs.length === 1 ? result : undefined);
    if (value === undefined) continue;
    await mkdir(dirname(resolved), { recursive: true });
    if (extname(resolved).toLowerCase() === '.md') {
      await writeFile(resolved, `${stringifyMarkdown(value).trim()}\n`, 'utf-8');
    } else {
      await writeFile(resolved, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
    }
    written.push(resolved);
  }
  return written;
}

function stringifyMarkdown(value: unknown): string {
  if (typeof value === 'string') return value;
  if (isRecord(value) && typeof value.markdown === 'string') return value.markdown;
  if (isRecord(value) && typeof value.text === 'string') return value.text;
  return JSON.stringify(value, null, 2);
}

function hashJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function tryParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return { text: raw };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value != null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
