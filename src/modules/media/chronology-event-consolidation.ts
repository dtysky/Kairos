import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  IChronologyEventConsolidationSubmission,
  type IChronologyEvent,
  type IChronologyEventConsolidationDecision,
  type IChronologyEventConsolidationState,
  type IChronologyEventConsolidationSubmission as TChronologyEventConsolidationSubmission,
  type IProjectChronology,
} from '../../protocol/schema.js';
import {
  getChronologyEventConsolidationAuditPath,
  getChronologyEventConsolidationDecisionsPath,
  getChronologyEventConsolidationHandoffPath,
  loadChronology,
  loadChronologyEventConsolidationState,
  resolveWorkspaceProjectRoot,
  writeChronology,
  writeChronologyEventConsolidationAudit,
  writeChronologyEventConsolidationState,
} from '../../store/index.js';

export interface IPrepareChronologyEventConsolidationResult {
  state: IChronologyEventConsolidationState;
  chronology: IProjectChronology;
}

export interface IApplyChronologyEventConsolidationResult {
  state: IChronologyEventConsolidationState;
  chronology: IProjectChronology;
}

export async function prepareProjectChronologyEventConsolidation(input: {
  workspaceRoot: string;
  projectId: string;
  chronology?: IProjectChronology;
  now?: string;
}): Promise<IPrepareChronologyEventConsolidationResult> {
  const projectRoot = resolveWorkspaceProjectRoot(input.workspaceRoot, input.projectId);
  const chronology = input.chronology ?? await requireProjectChronology(projectRoot);
  const generatedAt = input.now ?? new Date().toISOString();
  const candidateHash = computeChronologyEventHash(chronology.events);
  const handoffPath = getChronologyEventConsolidationHandoffPath(projectRoot);
  const decisionsPath = getChronologyEventConsolidationDecisionsPath(projectRoot);
  const candidateEventCount = chronology.events.filter(isAgentMergeCandidate).length;
  const requiresAgent = chronology.status !== 'confirmed' && hasAdjacentMergeCandidates(chronology.events);
  const state: IChronologyEventConsolidationState = {
    schemaVersion: '1.0',
    projectId: input.projectId,
    inputsHash: chronology.inputsHash,
    candidateHash,
    ...(requiresAgent ? {} : { resultHash: candidateHash }),
    status: requiresAgent ? 'pending-agent' : 'not-required',
    generatedAt,
    updatedAt: generatedAt,
    ...(!requiresAgent ? { completedAt: generatedAt } : {}),
    candidateEventCount,
    eventCountBefore: chronology.events.length,
    ...(!requiresAgent ? { eventCountAfter: chronology.events.length } : {}),
    mergeGroupCount: 0,
    handoffPath,
    decisionsPath,
    note: chronology.status === 'confirmed'
      ? 'Chronology is already confirmed; Agent consolidation is not required.'
      : requiresAgent
        ? 'Waiting for Codex Agent event consolidation before human Chronology review.'
        : 'No adjacent ordinary pending events require Agent consolidation.',
  };

  await writeChronologyEventConsolidationHandoff({
    path: handoffPath,
    workspaceRoot: input.workspaceRoot,
    projectRoot,
    projectId: input.projectId,
    chronology,
    state,
  });
  await writeChronologyEventConsolidationState(projectRoot, state);
  return { state, chronology };
}

export async function applyProjectChronologyEventConsolidation(input: {
  workspaceRoot: string;
  projectId: string;
  submission: unknown;
  now?: string;
}): Promise<IApplyChronologyEventConsolidationResult> {
  const projectRoot = resolveWorkspaceProjectRoot(input.workspaceRoot, input.projectId);
  const submission = IChronologyEventConsolidationSubmission.parse(input.submission);
  if (submission.projectId !== input.projectId) {
    throw new Error(`Chronology event consolidation projectId mismatch: expected ${input.projectId}, got ${submission.projectId}`);
  }

  const chronology = await requireProjectChronology(projectRoot);
  const state = await loadChronologyEventConsolidationState(projectRoot);
  if (!state || state.status !== 'pending-agent') {
    throw new Error('Chronology event consolidation is not pending. Rebuild chronology to create a fresh Agent handoff.');
  }
  if (state.inputsHash !== chronology.inputsHash || submission.inputsHash !== chronology.inputsHash) {
    throw new Error('Chronology event consolidation inputsHash is stale. Rebuild chronology and use the new handoff.');
  }
  const candidateHash = computeChronologyEventHash(chronology.events);
  if (candidateHash !== state.candidateHash || submission.candidateHash !== candidateHash) {
    throw new Error('Chronology event consolidation candidateHash is stale. Do not apply decisions to a changed chronology.');
  }

  const decisions = validateChronologyEventConsolidationDecisions(chronology.events, submission);
  const resultEvents = applyChronologyEventMergeDecisions(chronology.events, decisions);
  assertExactSpanSequencePreserved(chronology.events, resultEvents);
  const now = input.now ?? new Date().toISOString();
  const resultHash = computeChronologyEventHash(resultEvents);
  const updatedChronology: IProjectChronology = {
    ...chronology,
    status: 'draft',
    confirmedAt: undefined,
    updatedAt: now,
    events: resultEvents,
  };
  const auditPath = getChronologyEventConsolidationAuditPath(
    projectRoot,
    chronology.inputsHash,
    candidateHash,
  );
  const completedState: IChronologyEventConsolidationState = {
    ...state,
    status: 'completed',
    resultHash,
    updatedAt: now,
    completedAt: now,
    eventCountAfter: resultEvents.length,
    mergeGroupCount: decisions.length,
    auditPath,
    note: decisions.length > 0
      ? `Codex Agent merged ${decisions.length} event groups before human review.`
      : 'Codex Agent completed semantic review and proposed no event merges.',
  };

  await writeChronology(projectRoot, updatedChronology);
  await writeChronologyEventConsolidationAudit(auditPath, {
    schemaVersion: '1.0',
    projectId: input.projectId,
    inputsHash: chronology.inputsHash,
    candidateHash,
    resultHash,
    generatedAt: now,
    decisions,
    beforeEvents: chronology.events,
    afterEvents: resultEvents,
  });
  await writeChronologyEventConsolidationState(projectRoot, completedState);
  return { state: completedState, chronology: updatedChronology };
}

export function computeChronologyEventHash(events: IChronologyEvent[]): string {
  return createHash('sha256').update(JSON.stringify(toCanonicalJson(events))).digest('hex');
}

function toCanonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toCanonicalJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, toCanonicalJson(item)]));
}

function validateChronologyEventConsolidationDecisions(
  events: IChronologyEvent[],
  submission: TChronologyEventConsolidationSubmission,
): IChronologyEventConsolidationDecision[] {
  const eventIndexById = new Map(events.map((event, index) => [event.id, index] as const));
  const usedIds = new Set<string>();

  for (const [decisionIndex, decision] of submission.decisions.entries()) {
    const sourceIds = decision.sourceEventIds;
    if (new Set(sourceIds).size !== sourceIds.length) {
      throw new Error(`Agent merge group ${decisionIndex + 1} contains duplicate event ids.`);
    }
    const indices = sourceIds.map(id => eventIndexById.get(id));
    if (indices.some(index => index === undefined)) {
      const missing = sourceIds.filter(id => !eventIndexById.has(id));
      throw new Error(`Agent merge group ${decisionIndex + 1} references missing events: ${missing.join(', ')}`);
    }
    const resolvedIndices = indices as number[];
    for (let index = 1; index < resolvedIndices.length; index += 1) {
      if (resolvedIndices[index] !== resolvedIndices[index - 1]! + 1) {
        throw new Error(`Agent merge group ${decisionIndex + 1} must contain adjacent events in chronology order.`);
      }
    }
    const sourceEvents = resolvedIndices.map(index => events[index]!);
    if (decision.anchorEventId) {
      validatePharosAbsorptionGroup(sourceEvents, decision, decisionIndex);
    } else {
      if (sourceEvents.some(event => !isAgentMergeCandidate(event))) {
        throw new Error(`Agent merge group ${decisionIndex + 1} crosses a route, gap, confirmed/rejected event, or other protected boundary.`);
      }
      const locationKeys = new Set(sourceEvents.map(event => normalizeLocation(event.location)));
      if (locationKeys.size !== 1) {
        throw new Error(`Agent merge group ${decisionIndex + 1} contains different locations; ordinary event location truth cannot be rewritten by Agent.`);
      }
    }
    for (const eventId of sourceIds) {
      if (usedIds.has(eventId)) {
        throw new Error(`Agent event ${eventId} appears in more than one merge group.`);
      }
      usedIds.add(eventId);
    }
  }

  return submission.decisions.map(decision => ({
    ...decision,
    sourceEventIds: [...decision.sourceEventIds],
    ...(decision.anchorEventId ? { anchorEventId: decision.anchorEventId.trim() } : {}),
    title: decision.title.trim(),
    summary: decision.summary.trim(),
    reason: decision.reason.trim(),
  }));
}

function applyChronologyEventMergeDecisions(
  events: IChronologyEvent[],
  decisions: IChronologyEventConsolidationDecision[],
): IChronologyEvent[] {
  const decisionByFirstId = new Map(decisions.map(decision => [decision.sourceEventIds[0]!, decision] as const));
  const consumedIds = new Set(decisions.flatMap(decision => decision.sourceEventIds.slice(1)));
  const result: IChronologyEvent[] = [];

  for (const event of events) {
    const decision = decisionByFirstId.get(event.id);
    if (decision) {
      const sourceSet = new Set(decision.sourceEventIds);
      const sourceEvents = events.filter(item => sourceSet.has(item.id));
      result.push(buildMergedAgentEvent(sourceEvents, decision));
      continue;
    }
    if (!consumedIds.has(event.id)) result.push(event);
  }
  return result;
}

function buildMergedAgentEvent(
  sourceEvents: IChronologyEvent[],
  decision: IChronologyEventConsolidationDecision,
): IChronologyEvent {
  const sourceIds = decision.sourceEventIds;
  const spanIds = sourceEvents.flatMap(event => event.spanIds);
  if (new Set(spanIds).size !== spanIds.length) {
    throw new Error(`Agent merge group contains duplicate span ids: ${sourceIds.join(', ')}`);
  }
  if (decision.anchorEventId) {
    const anchor = sourceEvents.find(event => event.id === decision.anchorEventId);
    if (!anchor) throw new Error(`Pharos anchor ${decision.anchorEventId} is missing from its merge group.`);
    return {
      ...anchor,
      startAt: minChronologyTime(sourceEvents.map(event => event.startAt)),
      endAt: maxChronologyTime(sourceEvents.map(event => event.endAt ?? event.startAt)),
      summary: decision.summary,
      spanIds,
    };
  }
  const location = sourceEvents[0]?.location;
  return {
    id: `event-${createHash('sha256').update(`agent:${sourceIds.join('|')}`).digest('hex').slice(0, 12)}`,
    kind: 'event',
    reviewStatus: 'pending',
    title: decision.title,
    summary: decision.summary,
    startAt: minChronologyTime(sourceEvents.map(event => event.startAt)),
    endAt: maxChronologyTime(sourceEvents.map(event => event.endAt ?? event.startAt)),
    ...(location ? { location } : {}),
    spanIds,
  };
}

function assertExactSpanSequencePreserved(before: IChronologyEvent[], after: IChronologyEvent[]): void {
  const beforeSpanIds = before.flatMap(event => event.spanIds);
  const afterSpanIds = after.flatMap(event => event.spanIds);
  if (JSON.stringify(beforeSpanIds) !== JSON.stringify(afterSpanIds)) {
    throw new Error('Agent event consolidation must preserve the exact global span id sequence without omissions or duplicates.');
  }
}

function isAgentMergeCandidate(event: IChronologyEvent): boolean {
  return event.kind === 'event' && event.reviewStatus === 'pending';
}

function isConfirmedPharosAnchor(event: IChronologyEvent): boolean {
  return event.kind === 'event'
    && event.reviewStatus === 'confirmed'
    && event.id.startsWith('event-pharos-');
}

function validatePharosAbsorptionGroup(
  sourceEvents: IChronologyEvent[],
  decision: IChronologyEventConsolidationDecision,
  decisionIndex: number,
): void {
  const anchor = sourceEvents.find(event => event.id === decision.anchorEventId);
  if (!anchor || !isConfirmedPharosAnchor(anchor)) {
    throw new Error(`Agent merge group ${decisionIndex + 1} anchorEventId must name its one confirmed Pharos event.`);
  }
  const pharosEvents = sourceEvents.filter(event => event.id.startsWith('event-pharos-'));
  if (pharosEvents.length !== 1 || pharosEvents[0]!.id !== anchor.id) {
    throw new Error(`Agent merge group ${decisionIndex + 1} must contain exactly one Pharos event and cannot cross another Pharos event.`);
  }
  if (sourceEvents.some(event => event.id !== anchor.id && !isAgentMergeCandidate(event))) {
    throw new Error(`Agent merge group ${decisionIndex + 1} may absorb only adjacent ordinary pending events into its Pharos anchor.`);
  }
  if (decision.title.trim() !== anchor.title.trim()) {
    throw new Error(`Agent merge group ${decisionIndex + 1} must preserve the Pharos anchor title exactly.`);
  }
}

function hasAdjacentMergeCandidates(events: IChronologyEvent[]): boolean {
  for (let index = 1; index < events.length; index += 1) {
    const left = events[index - 1]!;
    const right = events[index]!;
    if (isAgentMergeCandidate(left)
      && isAgentMergeCandidate(right)
      && normalizeLocation(left.location) === normalizeLocation(right.location)) {
      return true;
    }
    if ((isAgentMergeCandidate(left) && isConfirmedPharosAnchor(right))
      || (isConfirmedPharosAnchor(left) && isAgentMergeCandidate(right))) {
      return true;
    }
  }
  return false;
}

function normalizeLocation(value: string | undefined): string {
  return value?.trim().toLocaleLowerCase() ?? '';
}

function minChronologyTime(values: Array<string | undefined>): string | undefined {
  return pickChronologyTime(values, 'min');
}

function maxChronologyTime(values: Array<string | undefined>): string | undefined {
  return pickChronologyTime(values, 'max');
}

function pickChronologyTime(values: Array<string | undefined>, mode: 'min' | 'max'): string | undefined {
  const candidates = values.filter((value): value is string => Boolean(value?.trim()));
  return candidates.sort((left, right) => {
    const leftMs = Date.parse(left);
    const rightMs = Date.parse(right);
    const comparison = Number.isFinite(leftMs) && Number.isFinite(rightMs)
      ? leftMs - rightMs
      : left.localeCompare(right);
    return mode === 'min' ? comparison : -comparison;
  })[0];
}

async function requireProjectChronology(projectRoot: string): Promise<IProjectChronology> {
  const chronology = await loadChronology(projectRoot);
  if (!chronology) throw new Error('media/chronology.json is missing. Run chronology-build first.');
  return chronology;
}

async function writeChronologyEventConsolidationHandoff(input: {
  path: string;
  workspaceRoot: string;
  projectRoot: string;
  projectId: string;
  chronology: IProjectChronology;
  state: IChronologyEventConsolidationState;
}): Promise<void> {
  await mkdir(dirname(input.path), { recursive: true });
  const eventRows = input.chronology.events.map((event, index) => [
    `### ${index + 1}. ${event.id}`,
    '',
    `- kind/status: ${event.kind} / ${event.reviewStatus}`,
    `- time: ${event.startAt ?? 'unknown'} -> ${event.endAt ?? event.startAt ?? 'unknown'}`,
    `- location: ${event.location ?? (event.route ? `${event.route.from ?? 'unknown'} -> ${event.route.to ?? 'unknown'}` : 'unknown')}`,
    `- title: ${event.title}`,
    `- summary: ${truncateHandoffText(event.summary, 360) ?? 'none'}`,
    `- spans: ${event.spanIds.length}`,
    '',
  ].join('\n')).join('\n');
  const content = [
    '# Chronology Event Consolidation Agent Handoff',
    '',
    `Generated at: ${input.state.generatedAt}`,
    `Workspace root: ${input.workspaceRoot}`,
    `Project id: ${input.projectId}`,
    `Project root: ${input.projectRoot}`,
    `Inputs hash: ${input.state.inputsHash}`,
    `Candidate hash: ${input.state.candidateHash}`,
    '',
    '## Files',
    '',
    `- Candidate chronology: ${join(input.projectRoot, 'media', 'chronology.json')}`,
    `- Span context: ${join(input.projectRoot, 'store', 'spans.json')}`,
    `- Optional asset reports: ${join(input.projectRoot, 'analysis', 'asset-reports')}`,
    `- Optional Pharos context: ${join(input.projectRoot, 'analysis', 'pharos-context.json')}`,
    `- Write decisions to: ${input.state.decisionsPath}`,
    '',
    '## What To Say In Codex/Agent',
    '',
    '```text',
    `请按 kairos-chronology-consolidation skill 处理项目 ${input.projectId}：读取 ${input.path}、当前 media/chronology.json 和必要的 span 上下文。合并语义连续的相邻普通 pending event；也允许用 anchorEventId 指定组内唯一 confirmed Pharos event，让其吸收两侧属于同一行程的相邻普通 pending event，并原样保留 Pharos id、标题、地点和 confirmed 状态。允许跨自然日零点；不得跨 route、gap 或另一个 Pharos event，不得修改 GPS、路线、源时间和 span。将简洁决定写入 ${input.state.decisionsPath}，然后在仓库根目录运行：node scripts/apply-chronology-event-consolidation.mjs --projectId ${input.projectId} --decisions "${input.state.decisionsPath}"。不要重跑 chronology-build、Analyze 或 span-rebuild。`,
    '```',
    '',
    '## Output Contract',
    '',
    'Write one JSON document. Omit events that should stay unchanged:',
    '',
    '```json',
    JSON.stringify({
      schemaVersion: '1.0',
      projectId: input.projectId,
      inputsHash: input.state.inputsHash,
      candidateHash: input.state.candidateHash,
      decisions: [{
        sourceEventIds: ['event-a', 'event-b'],
        title: '合并后的中文事件标题',
        summary: '合并后的中文事件摘要',
        reason: '两段素材属于同一项连续活动',
      }, {
        sourceEventIds: ['event-before', 'event-pharos-anchor', 'event-after'],
        anchorEventId: 'event-pharos-anchor',
        title: 'Pharos 锚点原始标题',
        summary: '包含周边行程的中文摘要',
        reason: '周边事件属于该 Pharos 行程',
      }],
    }, null, 2),
    '```',
    '',
    '## Hard Rules',
    '',
    '- Ordinary mode merges only adjacent same-location `pending event` rows.',
    '- Pharos absorption mode sets `anchorEventId` to the group\'s one confirmed `event-pharos-*`; every other source row must be an adjacent ordinary pending event.',
    '- A Pharos absorption must preserve the anchor id, title, location, and confirmed status. Use the exact anchor title in the decision.',
    '- Calendar-day rollover is allowed and must not be treated as a boundary by itself.',
    '- `route`, `gap`, and another Pharos event are hard boundaries.',
    '- Ordinary groups require one location string. Pharos absorption may include different surrounding GPS location strings when the semantic trip is the same.',
    '- Do not return keep rows. Do not return location, route, time, spanIds, GPS, or reviewStatus.',
    '- Use semantic continuity from title, summary, transcript, visual observations, and neighboring context; do not use a fixed time-gap threshold as the decision rule.',
    '- If no merge is justified, write an empty decisions array and still run the apply command so human review can begin.',
    '',
    '## Candidate Events And Boundaries',
    '',
    eventRows,
  ].join('\n');
  await writeFile(input.path, content, 'utf-8');
}

function truncateHandoffText(value: string | undefined, maxLength: number): string | undefined {
  const normalized = value?.replace(/\s+/gu, ' ').trim();
  if (!normalized) return undefined;
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}…`;
}
