import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, extname, join, relative } from 'node:path';
import type {
  EEditFlowShardBy,
  IAgentPacket,
  IAgentPacketInputArtifact,
  IEditFlowAgentHandoff,
  IEditFlowAgentHandoffShard,
  IEditFlowPlan,
  IEditFlowPlanStep,
  IEditFlowShardPacking,
  IEditFlowStepRunRecord,
} from '../../protocol/schema.js';
import {
  getEditFlowPlanPath,
  getEditFlowTempRunRoot,
  getEditPlanningAgentPacketPath,
  getProjectEditRoot,
  loadAssetReports,
  loadChronologyReviewState,
  loadEditFlowPlan,
  loadEditFlowRunRecords,
  loadRuntimeConfig,
  normalizeEditId,
  writeEditFlowRunRecord,
  findLatestEditFlowStepRunRecord,
} from '../../store/index.js';
import {
  AgentHandoffRequiredError,
  AgentRunnerUnavailableError,
  buildCommandJsonPacketAgentRunnerConfig,
  resolveJsonPacketAgentRunner,
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
  const shouldHandoff = await shouldPrepareAgentHandoff({
    projectRoot: input.projectRoot,
    runner,
    agentRunner: input.agentRunner,
  });
  const inputSnapshot = await resolveInputRefs(input.projectRoot, input.editId, input.step.inputRefs, {
    includeArtifacts: !shouldHandoff,
  });
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
    review: {
      status: input.step.gate === 'human' ? 'pending' : 'not_required',
    },
  };
  await writeEditFlowRunRecord(input.projectRoot, recordBase, input.editId);

  if (shouldHandoff) {
    const handoff = await writeEditFlowAgentHandoff({
      workspaceRoot: input.workspaceRoot,
      projectRoot: input.projectRoot,
      editId: input.editId,
      plan: input.plan,
      step: input.step,
      runId: recordBase.runId,
      capabilityId: input.step.capabilityId,
      inputSnapshot: inputSnapshot.snapshot,
      outputRefs: input.step.outputRefs,
    });
    const message = describeHandoffMessage(handoff);
    const awaitingAgent: IEditFlowStepRunRecord = {
      ...recordBase,
      status: 'awaiting_agent',
      updatedAt: new Date().toISOString(),
      handoff,
      error: message,
    };
    await writeEditFlowRunRecord(input.projectRoot, awaitingAgent, input.editId);
    throw new AgentHandoffRequiredError({
      promptId: 'edit-flow/capability-runner',
      packetPath: handoff.handoffPath,
      handoffPath: handoff.handoffPath,
      handoffMode: handoff.mode,
      shardBy: handoff.shardBy,
      shardCount: handoff.shards.length,
      stage: input.step.capabilityId,
      action: 'run-step',
      editId: input.editId,
      capabilityId: input.step.capabilityId,
      stepId: input.step.id,
    }, message);
  }

  try {
    const outputPaths = await executeStep({
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
      outputPaths,
    };
    await writeEditFlowRunRecord(input.projectRoot, next, input.editId);
    return next;
  } catch (error) {
    if (error instanceof AgentHandoffRequiredError) {
      const awaitingAgent: IEditFlowStepRunRecord = {
        ...recordBase,
        status: 'awaiting_agent',
        updatedAt: new Date().toISOString(),
        error: error.message,
      };
      await writeEditFlowRunRecord(input.projectRoot, awaitingAgent, input.editId);
      throw error;
    }
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

async function shouldPrepareAgentHandoff(input: {
  projectRoot: string;
  runner: 'deterministic' | 'agent' | 'script' | 'manual';
  agentRunner?: IJsonPacketAgentRunner;
}): Promise<boolean> {
  if (input.runner === 'deterministic' || input.runner === 'manual') return false;
  if (input.agentRunner) return false;
  const runtimeConfig = await loadRuntimeConfig(input.projectRoot);
  return !buildCommandJsonPacketAgentRunnerConfig(runtimeConfig)?.command;
}

async function writeEditFlowAgentHandoff(input: {
  workspaceRoot: string;
  projectRoot: string;
  editId: string;
  plan: IEditFlowPlan;
  step: IEditFlowPlanStep;
  runId: string;
  capabilityId: TEditFlowCapabilityId;
  inputSnapshot: Record<string, unknown>;
  outputRefs: string[];
}): Promise<IEditFlowAgentHandoff> {
  const runRoot = getEditFlowTempRunRoot(input.projectRoot, input.runId, input.editId);
  const handoffPath = join(runRoot, 'handoff.json');
  const packetRoot = join(runRoot, 'agent-packets');
  await mkdir(packetRoot, { recursive: true });
  const execution = input.step.execution ?? {
    mode: input.step.runner === 'manual' ? 'manual' as const : 'single-agent' as const,
    shardBy: 'none' as const,
  };
  const handoffId = randomUUID();
  const createdAt = new Date().toISOString();
  const common = {
    schemaVersion: '1.0' as const,
    handoffId,
    createdAt,
    promptId: 'edit-flow/capability-runner',
    editId: input.editId,
    runId: input.runId,
    stepId: input.step.id,
    capabilityId: input.capabilityId,
    outputRefs: input.outputRefs,
    reducerOutputRefs: input.outputRefs,
    handoffPath,
    ...(execution.mode === 'sharded-agent' && execution.shardPacking ? { shardPacking: execution.shardPacking } : {}),
    ...(execution.mode === 'sharded-agent'
      ? {
        codexSubagentProfile: execution.codexSubagentProfile ?? {
          reasoningEffort: 'high' as const,
          forkContext: false,
          speed: 'standard' as const,
        },
      }
      : {}),
  };
  const handoff: IEditFlowAgentHandoff = execution.mode === 'sharded-agent'
    ? {
      ...common,
      mode: 'sharded',
      shardBy: execution.shardBy,
      shards: await writeShardedAgentPackets({
        ...input,
        handoffId,
        packetRoot,
        runRoot,
        shardBy: execution.shardBy,
      }),
    }
    : {
      ...common,
      mode: 'single',
      shardBy: 'none',
      packetPath: await writeSingleAgentPacket({
        ...input,
        packetRoot,
        handoffId,
      }),
      shards: [],
    };
  await writeFile(handoffPath, `${JSON.stringify(handoff, null, 2)}\n`, 'utf-8');
  return handoff;
}

async function writeSingleAgentPacket(input: {
  workspaceRoot: string;
  projectRoot: string;
  editId: string;
  plan: IEditFlowPlan;
  step: IEditFlowPlanStep;
  capabilityId: TEditFlowCapabilityId;
  inputSnapshot: Record<string, unknown>;
  outputRefs: string[];
  packetRoot: string;
  handoffId: string;
}): Promise<string> {
  const editRule = await loadEditRuleByCategory(input.workspaceRoot, input.plan.editRuleCategory);
  const packetPath = join(input.packetRoot, `${safePathPart(input.step.id)}.json`);
  const packet = buildHandoffPacket({
    editRule,
    plan: input.plan,
    step: input.step,
    capabilityId: input.capabilityId,
    inputSnapshot: input.inputSnapshot,
    outputRefs: input.outputRefs,
    shard: null,
    handoffId: input.handoffId,
  });
  await writeFile(packetPath, `${JSON.stringify(packet, null, 2)}\n`, 'utf-8');
  return packetPath;
}

async function writeShardedAgentPackets(input: {
  workspaceRoot: string;
  projectRoot: string;
  editId: string;
  plan: IEditFlowPlan;
  step: IEditFlowPlanStep;
  capabilityId: TEditFlowCapabilityId;
  inputSnapshot: Record<string, unknown>;
  outputRefs: string[];
  handoffId: string;
  packetRoot: string;
  runRoot: string;
  shardBy: EEditFlowShardBy;
}): Promise<IEditFlowAgentHandoffShard[]> {
  if (input.shardBy === 'day') {
    return writeChronologyShardPackets(input, 'day');
  }
  if (input.shardBy === 'event') {
    return writeChronologyShardPackets(input, 'event');
  }
  return writeFallbackShardPacket(input);
}

async function writeChronologyShardPackets(
  input: Parameters<typeof writeShardedAgentPackets>[0],
  shardBy: Extract<EEditFlowShardBy, 'day' | 'event'>,
): Promise<IEditFlowAgentHandoffShard[]> {
  const [editRule, chronologyState] = await Promise.all([
    loadEditRuleByCategory(input.workspaceRoot, input.plan.editRuleCategory),
    loadChronologyReviewState(input.projectRoot),
  ]);
  const chronology = chronologyState.chronology;
  const events = chronology?.events ?? [];
  const groups = shardBy === 'day'
    ? groupChronologyEventsByDay(events, input.step.execution?.shardPacking)
    : events.map(event => ({
      shardId: `event-${safePathPart(event.id)}`,
      label: event.title || event.id,
      events: [event],
      metricCount: 1,
      thresholdExceeded: false,
    }));
  const shards: IEditFlowAgentHandoffShard[] = [];
  const shardOutputRoot = join(input.runRoot, 'shards');
  await mkdir(shardOutputRoot, { recursive: true });
  for (const group of groups) {
    const spanIds = uniqueStrings(group.events.flatMap(event => Array.isArray(event.spanIds) ? event.spanIds : []));
    const shard = {
      shardId: group.shardId,
      label: group.label,
      shardBy,
      summary: `${group.events.length} chronology events / ${spanIds.length} span refs`,
      startAt: firstString(group.events.map(event => event.startAt)),
      endAt: lastString(group.events.map(event => event.endAt)),
      metricCount: group.metricCount,
      thresholdExceeded: group.thresholdExceeded,
      eventIds: group.events.map(event => event.id).filter(isNonEmptyString),
      spanIds,
      outputPaths: [join(shardOutputRoot, `${group.shardId}.json`)],
    };
    const packetPath = join(input.packetRoot, `${group.shardId}.json`);
    const packet = buildHandoffPacket({
      editRule,
      plan: input.plan,
      step: input.step,
      capabilityId: input.capabilityId,
      inputSnapshot: input.inputSnapshot,
      outputRefs: input.outputRefs,
      handoffId: input.handoffId,
      shard: {
        ...shard,
        events: group.events.map(summarizeChronologyEvent),
        metric: input.step.execution?.shardPacking?.metric,
        shardPacking: input.step.execution?.shardPacking,
        codexSubagentProfile: input.step.execution?.codexSubagentProfile,
        sourcePaths: buildShardSourcePaths(input),
      },
    });
    await writeFile(packetPath, `${JSON.stringify(packet, null, 2)}\n`, 'utf-8');
    shards.push({ ...shard, packetPath });
  }
  return shards;
}

async function writeFallbackShardPacket(input: Parameters<typeof writeShardedAgentPackets>[0]): Promise<IEditFlowAgentHandoffShard[]> {
  const packetPath = join(input.packetRoot, `${safePathPart(input.step.id)}-shard.json`);
  const outputPath = join(input.runRoot, 'shards', `${safePathPart(input.step.id)}-shard.json`);
  await mkdir(dirname(outputPath), { recursive: true });
  const editRule = await loadEditRuleByCategory(input.workspaceRoot, input.plan.editRuleCategory);
  const shard = {
    shardId: `${input.shardBy}-default`,
    label: `${input.step.title ?? input.step.id} shard`,
    shardBy: input.shardBy,
    packetPath,
    summary: `No deterministic ${input.shardBy} splitter is implemented yet; Agent should use declared inputs by path.`,
    eventIds: [],
    spanIds: [],
    outputPaths: [outputPath],
  };
  const packet = buildHandoffPacket({
    editRule,
    plan: input.plan,
    step: input.step,
    capabilityId: input.capabilityId,
    inputSnapshot: input.inputSnapshot,
    outputRefs: input.outputRefs,
    handoffId: input.handoffId,
    shard,
  });
  await writeFile(packetPath, `${JSON.stringify(packet, null, 2)}\n`, 'utf-8');
  return [shard];
}

function buildHandoffPacket(input: {
  editRule: Parameters<typeof buildEditRuleArtifact>[0];
  plan: IEditFlowPlan;
  step: IEditFlowPlanStep;
  capabilityId: TEditFlowCapabilityId;
  inputSnapshot: Record<string, unknown>;
  outputRefs: string[];
  handoffId: string;
  shard: Record<string, unknown> | null;
}): IAgentPacket {
  const isShard = input.shard != null;
  return {
    stage: input.capabilityId,
    identity: isShard ? 'edit-flow-shard-agent' : 'edit-flow-capability-runner',
    mission: isShard
      ? 'Execute one shard of a confirmed Edit Flow capability. Write only the shard output path declared in this packet; reducer will create the final outputRefs.'
      : 'Execute exactly one confirmed Edit Flow capability step. Produce only the declared outputRefs and do not invent hidden workflow stages.',
    hardConstraints: [
      'Use only the confirmed Flow Plan step, its execution field, declared inputRefs, and provided shard/source paths.',
      'Do not require script/current.json unless this step explicitly declares it as an inputRef.',
      'Do not parse edit-rule markdown in code; the Flow Plan execution field is the executable interpretation of the natural-language rule.',
      'Do not load or paste entire store/spans.json or media/chronology.json into the answer; use the shard subset and referenced paths.',
      'When spawning Codex SubAgents for this handoff, use reasoning_effort=high, fork_context=false, and standard speed mode; pass only the packet path and task.',
      isShard
        ? 'Write a shard-level JSON or markdown artifact to the shard output path. Do not write final outputRefs.'
        : 'Write the declared outputRefs exactly.',
    ],
    allowedInputs: [
      'confirmed flow plan',
      'current step',
      'edit rule markdown',
      'input snapshot paths',
      isShard ? 'current shard context' : 'declared inputRefs',
    ],
    inputArtifacts: [
      buildEditRuleArtifact(input.editRule),
      {
        label: 'confirmed-flow-plan',
        summary: input.plan.summary ?? `${input.plan.steps.length} steps`,
        content: input.plan,
      },
      {
        label: 'current-step',
        summary: `${input.step.id} / ${input.step.capabilityId}`,
        content: input.step,
      },
      {
        label: 'input-snapshot',
        summary: `${Object.keys(input.inputSnapshot).length} declared refs`,
        content: input.inputSnapshot,
      },
      input.step.execution?.codexSubagentProfile ? {
        label: 'codex-subagent-profile',
        summary: 'reasoning_effort=high / fork_context=false / speed=standard',
        content: input.step.execution.codexSubagentProfile,
      } : null,
      input.shard ? {
        label: 'shard-context',
        summary: String((input.shard as { summary?: unknown }).summary ?? 'shard context'),
        content: input.shard,
      } : null,
    ].filter((item): item is IAgentPacketInputArtifact => item != null),
    outputSchema: isShard
      ? { shardOutput: 'Write to the shard output path declared in shard-context.outputPaths[0].' }
      : { outputs: 'Record<outputRef, JSON-or-markdown-content>. Keys should match outputRefs exactly.' },
    reviewRubric: ['missing_declared_output', 'unsupported_claims', 'scope_violation', 'oversized_context_dump'],
  };
}

function describeHandoffMessage(handoff: IEditFlowAgentHandoff): string {
  if (handoff.mode === 'sharded') {
    return `Edit Flow sharded Agent handoff is ready: ${handoff.shards.length} ${handoff.shardBy} shards at ${handoff.handoffPath}`;
  }
  return `Edit Flow Agent handoff is ready: ${handoff.packetPath ?? handoff.handoffPath}`;
}

interface IChronologyEventLike {
  id: string;
  kind?: string;
  reviewStatus?: string;
  title?: string;
  summary?: string;
  startAt?: string;
  endAt?: string;
  location?: string;
  spanIds?: string[];
}

function groupChronologyEventsByDay(
  events: IChronologyEventLike[],
  packing?: IEditFlowShardPacking,
): Array<{
  shardId: string;
  label: string;
  events: IChronologyEventLike[];
  metricCount?: number;
  thresholdExceeded?: boolean;
}> {
  const groups = new Map<string, IChronologyEventLike[]>();
  for (const event of events) {
    const day = typeof event.startAt === 'string' && event.startAt.length >= 10
      ? event.startAt.slice(0, 10)
      : 'unknown-day';
    const list = groups.get(day) ?? [];
    list.push(event);
    groups.set(day, list);
  }
  const dayGroups = [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([day, dayEvents]) => ({
      shardId: `day-${safePathPart(day)}`,
      label: day,
      events: dayEvents.sort((a, b) => String(a.startAt ?? '').localeCompare(String(b.startAt ?? ''))),
      metricCount: computeShardMetric(dayEvents, packing?.metric ?? 'chronologyEventCount'),
      thresholdExceeded: false,
    }));
  if (!packing || packing.base !== 'day' || !packing.preserveOrder) return dayGroups;
  const packed: typeof dayGroups = [];
  let current: typeof dayGroups[number] | null = null;
  for (const dayGroup of dayGroups) {
    const dayMetric = dayGroup.metricCount ?? 0;
    if (!current) {
      current = {
        ...dayGroup,
        thresholdExceeded: dayMetric > packing.maxPerShard,
      };
      continue;
    }
    const nextMetric = computeShardMetric([...current.events, ...dayGroup.events], packing.metric);
    if ((current.metricCount ?? 0) > 0 && nextMetric > packing.maxPerShard) {
      packed.push(finalizePackedDayGroup(current));
      current = {
        ...dayGroup,
        thresholdExceeded: dayMetric > packing.maxPerShard,
      };
    } else {
      current = {
        ...current,
        label: `${current.label}..${dayGroup.label}`,
        events: [...current.events, ...dayGroup.events],
        metricCount: nextMetric,
        thresholdExceeded: Boolean(current.thresholdExceeded || dayGroup.thresholdExceeded || nextMetric > packing.maxPerShard),
      };
    }
  }
  if (current) packed.push(finalizePackedDayGroup(current));
  return packed;
}

function finalizePackedDayGroup<T extends { label: string; events: IChronologyEventLike[] }>(group: T): T & { shardId: string } {
  return {
    ...group,
    shardId: `days-${safePathPart(group.label.replace('..', '--'))}`,
  };
}

function computeShardMetric(
  events: IChronologyEventLike[],
  metric: 'chronologyEventCount' | 'materialRefCount',
): number {
  if (metric === 'materialRefCount') {
    return uniqueStrings(events.flatMap(event => Array.isArray(event.spanIds) ? event.spanIds : [])).length;
  }
  return events.length;
}

function buildShardSourcePaths(input: {
  projectRoot: string;
  editId: string;
  capabilityId: TEditFlowCapabilityId;
}): Record<string, string> {
  const chronology = relative(input.projectRoot, resolveProjectRef(input.projectRoot, input.editId, 'media/chronology.json') ?? '');
  if (input.capabilityId === 'trip.event_table') return { chronology };
  return {
    chronology,
    spans: relative(input.projectRoot, resolveProjectRef(input.projectRoot, input.editId, 'store/spans.json') ?? ''),
    assetReports: relative(input.projectRoot, resolveProjectRef(input.projectRoot, input.editId, 'analysis/asset-reports/*.json') ?? ''),
  };
}

function summarizeChronologyEvent(event: IChronologyEventLike): Record<string, unknown> {
  return {
    id: event.id,
    kind: event.kind,
    reviewStatus: event.reviewStatus,
    title: event.title,
    location: event.location,
    startAt: event.startAt,
    endAt: event.endAt,
    summary: limitText(event.summary, 700),
    spanCount: event.spanIds?.length ?? 0,
    spanIds: (event.spanIds ?? []).slice(0, 200),
  };
}

function uniqueStrings(values: unknown[]): string[] {
  return [...new Set(values.filter(isNonEmptyString))];
}

function firstString(values: unknown[]): string | undefined {
  return values.filter(isNonEmptyString).sort((a, b) => a.localeCompare(b))[0];
}

function lastString(values: unknown[]): string | undefined {
  return values.filter(isNonEmptyString).sort((a, b) => b.localeCompare(a))[0];
}

function limitText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, Math.max(0, maxLength - 1))}…`;
}

function safePathPart(value: string): string {
  return value.trim().replace(/[^a-z0-9_.-]+/giu, '-').replace(/^-+|-+$/gu, '') || 'shard';
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
}): Promise<string[]> {
  if (input.runner === 'manual') {
    return [];
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
    return [result.outputPath];
  }
  return runGenericAgentCapability(input);
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
  const [runtimeConfig, editRule, chronologyState, assetReports] = await Promise.all([
    loadRuntimeConfig(input.projectRoot),
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
    outputSchema: {
      outputs: 'Record<outputRef, JSON-or-markdown-content>. Keys should match the step outputRefs exactly.',
    },
    reviewRubric: ['missing_declared_output', 'unsupported_claims', 'scope_violation'],
  };
  const packetPath = await writeEditFlowCapabilityPacket(input.projectRoot, input.editId, input.step, packet);
  const runner = resolveEditFlowPacketRunner({
    agentRunner: input.agentRunner,
    runtimeConfig,
    promptId: 'edit-flow/capability-runner',
    packetPath,
    stage: input.capabilityId,
    action: 'run-step',
    editId: input.editId,
    capabilityId: input.capabilityId,
    stepId: input.step.id,
  });
  const result = await runner.run<{ outputs?: Record<string, unknown> }>({
    promptId: 'edit-flow/capability-runner',
    packet,
    llm: { jsonMode: true, temperature: 0.2 },
  });
  return writeDeclaredOutputs(input.projectRoot, input.editId, input.step.outputRefs, result);
}

function resolveEditFlowPacketRunner(input: {
  agentRunner?: IJsonPacketAgentRunner;
  runtimeConfig: Parameters<typeof buildCommandJsonPacketAgentRunnerConfig>[0];
  promptId: 'edit-flow/capability-runner';
  packetPath: string;
  stage: string;
  action: string;
  editId: string;
  capabilityId: string;
  stepId: string;
}): IJsonPacketAgentRunner {
  try {
    return resolveJsonPacketAgentRunner({
      agentRunner: input.agentRunner,
      commandRunner: buildCommandJsonPacketAgentRunnerConfig(input.runtimeConfig),
    });
  } catch (error) {
    if (error instanceof AgentRunnerUnavailableError) {
      throw new AgentHandoffRequiredError({
        promptId: input.promptId,
        packetPath: input.packetPath,
        stage: input.stage,
        action: input.action,
        editId: input.editId,
        capabilityId: input.capabilityId,
        stepId: input.stepId,
      }, `Edit Flow packet is ready for Agent handoff: ${input.packetPath}`);
    }
    throw error;
  }
}

async function writeEditFlowCapabilityPacket(
  projectRoot: string,
  editId: string,
  step: IEditFlowPlanStep,
  packet: IAgentPacket,
): Promise<string> {
  const stage = `${step.capabilityId}-${step.id}`.replace(/[^a-z0-9_.-]+/giu, '-');
  const packetPath = getEditPlanningAgentPacketPath(projectRoot, stage, editId);
  await mkdir(dirname(packetPath), { recursive: true });
  await writeFile(packetPath, `${JSON.stringify(packet, null, 2)}\n`, 'utf-8');
  return packetPath;
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
    || ref === 'DaVinci Resolve timeline';
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
