import { randomUUID } from 'node:crypto';
import type {
  IAgentPacket,
  IKtepProject,
  IKtepScript,
  IKtepScriptSelection,
  IKtepSlice,
  IStageReviewIssue,
  IMediaChronology,
  ISegmentCutReview,
  ISegmentRoughCutBeatPlan,
  ISegmentRoughCutPlan,
  ITimelineRoughCutBase,
} from '../../protocol/schema.js';
import {
  getTimelineCurrentPath,
  loadAssets,
  loadAssetReports,
  loadChronology,
  loadCurrentScript,
  loadProject,
  loadRuntimeConfig,
  loadSpans,
  writeJson,
  writeTimelineAgentPacket,
  writeTimelineAgentPipeline,
  writeTimelineRoughCutBase,
  writeTimelineSegmentCut,
  writeTimelineStageReview,
} from '../../store/index.js';
import type { IJsonPacketAgentRunner } from '../agents/runtime.js';
import { buildCommandJsonPacketAgentRunnerConfig, resolveJsonPacketAgentRunner } from '../agents/runtime.js';
import { buildDeterministicRoughCutBase, buildSegmentRoughCutBeatPlan } from './segment-cuts.js';
import { buildTimeline, resolveTimelineBuildConfig, type IBuildConfig } from './timeline-builder.js';
import { resolveSpeechPacingConfig, type ISpeechPacingConfig } from './pacing.js';

const CTIMELINE_REVIEW_CODES = [
  'recall_regression',
  'segment_scope_violation',
  'time_band_violation',
  'speed_policy_violation',
  'source_speech_violation',
  'subtitle_alignment_drift',
  'chronology_drift',
  'pharos_guardrail_drift',
  'style_guardrail_drift',
] as const;

export interface IBuildProjectTimelineInput {
  projectRoot: string;
  agentRunner?: IJsonPacketAgentRunner;
  config?: Partial<IBuildConfig>;
}

export interface IBuildProjectTimelineResult {
  doc: ReturnType<typeof buildTimeline>;
  roughCutBase: ITimelineRoughCutBase;
  segmentCuts: ISegmentRoughCutPlan[];
  reviews: ISegmentCutReview[];
}

export async function buildProjectTimeline(
  input: IBuildProjectTimelineInput,
): Promise<IBuildProjectTimelineResult> {
  const [
    project,
    assets,
    slices,
    script,
    chronology,
    assetReports,
    runtimeConfig,
  ] = await Promise.all([
    loadProject(input.projectRoot),
    loadAssets(input.projectRoot),
    loadSpans(input.projectRoot),
    loadCurrentScript(input.projectRoot),
    loadChronology(input.projectRoot),
    loadAssetReports(input.projectRoot),
    loadRuntimeConfig(input.projectRoot),
  ]);
  if (!script || script.length === 0) {
    throw new Error('timeline build requires script/current.json');
  }

  const cfg = resolveTimelineBuildConfig(runtimeConfig, {
    ...input.config,
    chronology,
    assetReports,
  });
  const roughCutBase = buildDeterministicRoughCutBase({
    projectId: project.id,
    script,
    slices,
    chronology,
    subtitleConfig: cfg.subtitle,
  });
  await writeTimelineRoughCutBase(input.projectRoot, roughCutBase);

  let agentRunner: IJsonPacketAgentRunner;
  try {
    agentRunner = resolveJsonPacketAgentRunner({
      agentRunner: input.agentRunner,
      commandRunner: buildCommandJsonPacketAgentRunnerConfig(runtimeConfig),
    });
  } catch (error) {
    await writeTimelineAgentPipeline(input.projectRoot, {
      currentStage: 'segment-cut-init',
      stageStatus: 'awaiting_user',
      attemptCount: 0,
      latestReviewResult: 'runner_unavailable',
      blockerSummary: [formatTimelineStageError(error)],
      updatedAt: new Date().toISOString(),
    });
    throw error;
  }
  const sliceMap = new Map(slices.map(slice => [slice.id, slice] as const));
  const subtitleConfig = resolveSpeechPacingConfig(cfg.subtitle);
  const segmentCuts: ISegmentRoughCutPlan[] = [];
  const reviews: ISegmentCutReview[] = [];

  for (const segmentPlan of roughCutBase.segments) {
    const scriptSegment = script.find(segment => segment.id === segmentPlan.segmentId);
    if (!scriptSegment) {
      throw new Error(`timeline rough-cut segment "${segmentPlan.segmentId}" does not exist in script/current.json`);
    }
    const result = await runReviewedSegmentCutStage({
      projectRoot: input.projectRoot,
      agentRunner,
      project,
      scriptSegment,
      segmentPlan,
      sliceMap,
      chronology,
      subtitleConfig,
    });
    segmentCuts.push(result.draft);
    reviews.push(result.review);
  }

  const doc = buildTimeline(project, assets, slices, script, {
    ...cfg,
    reviewedSegmentCuts: segmentCuts,
  });
  await Promise.all([
    writeJson(getTimelineCurrentPath(input.projectRoot), doc),
    writeTimelineAgentPipeline(input.projectRoot, {
      currentStage: 'timeline-build',
      stageStatus: 'completed',
      attemptCount: reviews.length,
      latestReviewResult: 'pass',
      blockerSummary: [],
      updatedAt: new Date().toISOString(),
    }),
  ]);

  return {
    doc,
    roughCutBase,
    segmentCuts,
    reviews,
  };
}

async function runReviewedSegmentCutStage(input: {
  projectRoot: string;
  agentRunner: IJsonPacketAgentRunner;
  project: IKtepProject;
  scriptSegment: IKtepScript;
  segmentPlan: ISegmentRoughCutPlan;
  sliceMap: Map<string, IKtepSlice>;
  chronology: IMediaChronology[];
  subtitleConfig: ISpeechPacingConfig;
}): Promise<{ draft: ISegmentRoughCutPlan; review: ISegmentCutReview }> {
  let previousDraft = input.segmentPlan;
  let revisionBrief: string[] = [];

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const packet = buildSegmentCutRefinerPacket({
      projectRoot: input.projectRoot,
      segmentPlan: input.segmentPlan,
      scriptSegment: input.scriptSegment,
      chronology: input.chronology,
      previousDraft,
      revisionBrief,
    });
    await Promise.all([
      writeTimelineAgentPacket(input.projectRoot, input.segmentPlan.segmentId, packet),
      writeTimelineAgentPipeline(input.projectRoot, {
        currentStage: `segment-cut:${input.segmentPlan.segmentId}`,
        stageStatus: 'running',
        attemptCount: attempt,
        latestReviewResult: undefined,
        blockerSummary: [],
        updatedAt: new Date().toISOString(),
      }),
    ]);

    let rawDraft: unknown;
    try {
      rawDraft = await input.agentRunner.run<unknown>({
        promptId: 'timeline/segment-cut-refiner',
        packet,
      });
    } catch (error) {
      await writeTimelineAgentPipeline(input.projectRoot, {
        currentStage: `segment-cut:${input.segmentPlan.segmentId}`,
        stageStatus: 'writer_failed',
        attemptCount: attempt,
        latestReviewResult: 'writer_failed',
        blockerSummary: [formatTimelineStageError(error)],
        updatedAt: new Date().toISOString(),
      });
      throw new Error(`timeline segment-cut refiner failed for ${input.segmentPlan.segmentId}: ${formatTimelineStageError(error)}`);
    }

    const draft = normalizeReviewedSegmentCutDraft(
      rawDraft,
      input.segmentPlan,
      input.scriptSegment,
      input.sliceMap,
      input.subtitleConfig,
    );
    if (!draft) {
      await writeTimelineAgentPipeline(input.projectRoot, {
        currentStage: `segment-cut:${input.segmentPlan.segmentId}`,
        stageStatus: 'writer_failed',
        attemptCount: attempt,
        latestReviewResult: 'writer_invalid_output',
        blockerSummary: ['segment-cut refiner returned invalid JSON'],
        updatedAt: new Date().toISOString(),
      });
      throw new Error(`timeline segment-cut refiner returned invalid JSON for ${input.segmentPlan.segmentId}`);
    }

    await writeTimelineSegmentCut(input.projectRoot, draft);

    const reviewPacket = buildSegmentCutReviewPacket({
      projectRoot: input.projectRoot,
      segmentPlan: input.segmentPlan,
      scriptSegment: input.scriptSegment,
      draft,
      attempt,
      chronology: input.chronology,
    });
    let rawReview: Partial<ISegmentCutReview>;
    try {
      rawReview = await input.agentRunner.run<Partial<ISegmentCutReview>>({
        promptId: 'timeline/segment-cut-reviewer',
        packet: reviewPacket,
        llm: { temperature: 0.1 },
      });
    } catch (error) {
      const review = buildTimelineStageErrorReview(input.segmentPlan.segmentId, attempt, error);
      await Promise.all([
        writeTimelineStageReview(input.projectRoot, review),
        writeTimelineAgentPipeline(input.projectRoot, {
          currentStage: `segment-cut:${input.segmentPlan.segmentId}`,
          stageStatus: 'review_error',
          attemptCount: attempt,
          latestReviewResult: 'review_error',
          blockerSummary: review.issues.map(issue => `${issue.code}: ${issue.message}`),
          updatedAt: new Date().toISOString(),
        }),
      ]);
      throw new Error(`timeline segment-cut reviewer failed for ${input.segmentPlan.segmentId}: ${formatTimelineStageError(error)}`);
    }

    const review = normalizeSegmentCutReview(rawReview, input.segmentPlan.segmentId, attempt);
    await Promise.all([
      writeTimelineStageReview(input.projectRoot, review),
      writeTimelineAgentPipeline(input.projectRoot, {
        currentStage: `segment-cut:${input.segmentPlan.segmentId}`,
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
        `timeline segment-cut for ${input.segmentPlan.segmentId} is awaiting user review: ${review.issues
          .filter(issue => issue.severity === 'blocker')
          .map(issue => `${issue.code}: ${issue.message}`)
          .join(' | ')}`,
      );
    }

    previousDraft = draft;
    revisionBrief = review.revisionBrief;
  }

  throw new Error(`timeline segment-cut stage failed to complete for ${input.segmentPlan.segmentId}`);
}

function buildSegmentCutRefinerPacket(input: {
  projectRoot: string;
  segmentPlan: ISegmentRoughCutPlan;
  scriptSegment: IKtepScript;
  chronology: IMediaChronology[];
  previousDraft: ISegmentRoughCutPlan;
  revisionBrief: string[];
}): IAgentPacket {
  return {
    stage: `segment-cut:${input.segmentPlan.segmentId}`,
    identity: 'segment-cut-refiner',
    mission: '只在当前 segment 内细化 rough cut：拆并/重排 beat、微调合法 window、覆盖 drive/aerial 速度、细化 source-speech 与字幕切分。',
    hardConstraints: [
      '只能处理当前 segment，不能跨段换料。',
      '不能引入 lockedSpanIds 之外的 span。',
      '只能在 candidate window bounds 内调整 source window。',
      '只有 drive / aerial beat 允许覆盖 speedSuggestion。',
      '不得默默删掉 base recall 里的 span；如确有必要，必须在草稿里明确体现并交 reviewer 判定。',
    ],
    allowedInputs: [
      'timeline/rough-cut-base.json',
      'script/current.json current segment',
      'media/chronology.json',
      'optional previous segment-cut draft',
    ],
    inputArtifacts: [
      {
        label: 'segment-rough-cut-base',
        path: input.previousDraft.segmentId === input.segmentPlan.segmentId
          ? undefined
          : undefined,
        summary: `${input.segmentPlan.beats.length} beats / ${input.segmentPlan.lockedSpanIds.length} locked spans`,
        content: input.segmentPlan,
      },
      {
        label: 'script-segment',
        summary: input.scriptSegment.title ?? input.scriptSegment.id,
        content: input.scriptSegment,
      },
      {
        label: 'chronology-snapshot',
        summary: `${input.chronology.length} chronology items`,
        content: input.chronology,
      },
      input.revisionBrief.length > 0
        ? {
          label: 'revision-brief',
          summary: input.revisionBrief.join(' / '),
          content: input.revisionBrief,
        }
        : null,
      input.revisionBrief.length > 0
        ? {
          label: 'previous-draft',
          summary: '上一轮 segment-cut 草稿',
          content: input.previousDraft,
        }
        : null,
    ].filter((item): item is NonNullable<typeof item> => item != null),
    outputSchema: {
      segmentId: 'string',
      beats: 'ISegmentRoughCutBeatPlan[]',
    },
    reviewRubric: [...CTIMELINE_REVIEW_CODES],
  };
}

function buildSegmentCutReviewPacket(input: {
  projectRoot: string;
  segmentPlan: ISegmentRoughCutPlan;
  scriptSegment: IKtepScript;
  chronology: IMediaChronology[];
  draft: ISegmentRoughCutPlan;
  attempt: number;
}): IAgentPacket {
  return {
    stage: `review-segment-cut:${input.segmentPlan.segmentId}`,
    identity: 'segment-cut-reviewer',
    mission: '审查当前 segment-cut 是否发生 recall、chronology、time-band、speed、source-speech 或 subtitle drift。',
    hardConstraints: [
      '只审查，不直接改写正式稿。',
      'blocker 必须给 revisionBrief。',
    ],
    allowedInputs: [
      'segment rough-cut base',
      'current segment-cut draft',
      'segment-cut audit',
      'script segment',
      'chronology snapshot',
    ],
    inputArtifacts: [
      {
        label: 'segment-rough-cut-base',
        summary: `${input.segmentPlan.beats.length} beats / ${input.segmentPlan.lockedSpanIds.length} locked spans`,
        content: input.segmentPlan,
      },
      {
        label: 'segment-cut-audit',
        summary: summarizeSegmentCutAudit(buildSegmentCutAudit(input.segmentPlan, input.draft)),
        content: buildSegmentCutAudit(input.segmentPlan, input.draft),
      },
      {
        label: 'script-segment',
        summary: input.scriptSegment.title ?? input.scriptSegment.id,
        content: input.scriptSegment,
      },
      {
        label: 'chronology-snapshot',
        summary: `${input.chronology.length} chronology items`,
        content: input.chronology,
      },
      {
        label: 'segment-cut-draft',
        summary: `第 ${input.attempt} 轮 segment-cut 草稿`,
        content: input.draft,
      },
    ],
    outputSchema: {
      verdict: 'pass | revise | awaiting_user',
      issues: 'Array<{ code, severity, message, details? }>',
      revisionBrief: 'string[]',
    },
    reviewRubric: [...CTIMELINE_REVIEW_CODES],
  };
}

function normalizeReviewedSegmentCutDraft(
  raw: unknown,
  base: ISegmentRoughCutPlan,
  scriptSegment: IKtepScript,
  sliceMap: Map<string, IKtepSlice>,
  subtitleConfig: ISpeechPacingConfig,
): ISegmentRoughCutPlan | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  const source = raw as Record<string, unknown>;
  if (!Array.isArray(source.beats)) {
    return null;
  }

  const allowedSpanIds = new Set(base.lockedSpanIds);
  const windowMap = new Map(base.beats.flatMap(beat =>
    beat.candidateWindows.map(window => [buildWindowKey(window.assetId, window.spanId, window.sliceId), window] as const),
  ));
  const baseBeatsById = new Map(base.beats.map(beat => [beat.beatId, beat] as const));
  const candidateBeats = source.beats
    .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item))
    .map(item => {
      const beatId = typeof item.beatId === 'string' && item.beatId.trim().length > 0
        ? item.beatId.trim()
        : typeof item.id === 'string' && item.id.trim().length > 0
          ? item.id.trim()
          : randomUUID();
      const baseBeat = baseBeatsById.get(beatId);
      const audioSelections = normalizeSegmentCutSelections(
        item.audioSelections,
        baseBeat?.audioSelections ?? [],
        allowedSpanIds,
        windowMap,
      );
      const visualSelections = normalizeSegmentCutSelections(
        item.visualSelections,
        baseBeat?.visualSelections ?? [],
        allowedSpanIds,
        windowMap,
      );
      const linkedSpanIds = dedupeStrings([
        ...normalizeOptionalStringList(item.linkedSpanIds),
        ...audioSelections.map(selection => selection.spanId),
        ...visualSelections.map(selection => selection.spanId),
        ...(baseBeat?.linkedSpanIds ?? []),
      ]);
      if (linkedSpanIds.length === 0) {
        return null;
      }

      const tempBeat = {
        id: beatId,
        text: typeof item.text === 'string' ? item.text.trim() : baseBeat?.text ?? '',
        utterances: normalizeSegmentCutUtterances(item.utterances) ?? baseBeat?.utterances,
        actions: {
          ...(typeof resolveSegmentCutSpeed(item) === 'number' ? { speed: resolveSegmentCutSpeed(item) } : {}),
          ...(resolveSegmentCutBool(item, 'preserveNatSound', baseBeat?.preserveNatSound) != null
            ? { preserveNatSound: resolveSegmentCutBool(item, 'preserveNatSound', baseBeat?.preserveNatSound) }
            : {}),
          ...(resolveSegmentCutBool(item, 'muteSource', baseBeat?.muteSource) != null
            ? { muteSource: resolveSegmentCutBool(item, 'muteSource', baseBeat?.muteSource) }
            : {}),
        },
        audioSelections,
        visualSelections,
        linkedSpanIds,
        linkedSliceIds: dedupeStrings([
          ...normalizeOptionalStringList(item.linkedSliceIds),
          ...audioSelections.map(selection => selection.sliceId),
          ...visualSelections.map(selection => selection.sliceId),
          ...(baseBeat?.linkedSliceIds ?? []),
        ]),
        pharosRefs: undefined,
        notes: typeof item.notes === 'string' ? item.notes.trim() : baseBeat?.notes,
      } satisfies IKtepScript['beats'][number];

      const normalizedBeat = buildSegmentRoughCutBeatPlan(
        scriptSegment,
        tempBeat,
        sliceMap,
        subtitleConfig,
      );
      return {
        ...normalizedBeat,
        subtitleCueDrafts: normalizeSegmentCutCueDrafts(
          item.subtitleCueDrafts,
          normalizedBeat.subtitleCueDrafts,
          normalizedBeat.audioSelections,
        ),
      };
    })
    .filter((item): item is ISegmentRoughCutBeatPlan => item != null);

  return {
    segmentId: base.segmentId,
    segmentTitle: base.segmentTitle,
    timeBandGuard: base.timeBandGuard,
    lockedSpanIds: base.lockedSpanIds,
    beats: candidateBeats.length > 0 ? candidateBeats : base.beats,
  };
}

function normalizeSegmentCutSelections(
  raw: unknown,
  fallback: IKtepScriptSelection[],
  allowedSpanIds: Set<string>,
  windowMap: Map<string, ISegmentRoughCutPlan['beats'][number]['candidateWindows'][number]>,
): IKtepScriptSelection[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    return fallback;
  }

  const result: IKtepScriptSelection[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const source = item as Record<string, unknown>;
    const assetId = typeof source.assetId === 'string' ? source.assetId.trim() : '';
    const spanId = typeof source.spanId === 'string'
      ? source.spanId.trim()
      : typeof source.sliceId === 'string'
        ? source.sliceId.trim()
        : '';
    const sliceId = typeof source.sliceId === 'string'
      ? source.sliceId.trim()
      : spanId;
    if (!assetId || !spanId || !allowedSpanIds.has(spanId)) continue;
    const window = windowMap.get(buildWindowKey(assetId, spanId, sliceId))
      ?? windowMap.get(buildWindowKey(assetId, spanId, undefined))
      ?? windowMap.get(buildWindowKey(assetId, undefined, sliceId));
    if (!window) continue;

    const defaultIn = window.defaultSourceInMs ?? window.minSourceInMs;
    const defaultOut = window.defaultSourceOutMs ?? window.maxSourceOutMs;
    const minIn = window.minSourceInMs ?? defaultIn;
    const maxOut = window.maxSourceOutMs ?? defaultOut;
    const sourceInMs = clampSelectionBound(
      typeof source.sourceInMs === 'number' ? source.sourceInMs : defaultIn,
      minIn,
      maxOut,
    );
    if (typeof sourceInMs !== 'number') {
      continue;
    }
    const sourceOutMs = clampSelectionBound(
      typeof source.sourceOutMs === 'number' ? source.sourceOutMs : defaultOut,
      sourceInMs + 1,
      maxOut,
    );
    if (typeof sourceInMs !== 'number' || typeof sourceOutMs !== 'number' || sourceOutMs <= sourceInMs) {
      continue;
    }

    result.push({
      assetId,
      spanId,
      sliceId,
      sourceInMs,
      sourceOutMs,
      notes: typeof source.notes === 'string' ? source.notes.trim() : undefined,
      pharosRefs: undefined,
    });
  }

  return result.length > 0 ? dedupeSelections(result) : fallback;
}

function normalizeSegmentCutUtterances(raw: unknown): IKtepScript['beats'][number]['utterances'] {
  if (!Array.isArray(raw)) return undefined;
  const utterances = raw
    .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item))
    .map(item => ({
      text: typeof item.text === 'string' ? item.text.trim() : '',
      pauseBeforeMs: typeof item.pauseBeforeMs === 'number' ? Math.max(0, item.pauseBeforeMs) : undefined,
      pauseAfterMs: typeof item.pauseAfterMs === 'number' ? Math.max(0, item.pauseAfterMs) : undefined,
    }))
    .filter(item => item.text.length > 0);
  return utterances.length > 0 ? utterances : undefined;
}

function normalizeSegmentCutCueDrafts(
  raw: unknown,
  fallback: ISegmentRoughCutBeatPlan['subtitleCueDrafts'],
  audioSelections: IKtepScriptSelection[],
): ISegmentRoughCutBeatPlan['subtitleCueDrafts'] {
  if (!Array.isArray(raw) || raw.length === 0) {
    return fallback;
  }

  const normalized = raw
    .filter((item): item is Record<string, unknown> =>
      !!item && typeof item === 'object' && !Array.isArray(item))
    .map(item => {
      const text = typeof item.text === 'string' ? item.text.trim() : '';
      const sourceInMs = typeof item.sourceInMs === 'number' ? item.sourceInMs : undefined;
      const sourceOutMs = typeof item.sourceOutMs === 'number' ? item.sourceOutMs : undefined;
      if (!text) return null;
      if (
        typeof sourceInMs === 'number'
        && typeof sourceOutMs === 'number'
        && !isCueInsideSelections(sourceInMs, sourceOutMs, audioSelections)
      ) {
        return null;
      }

      return {
        id: typeof item.id === 'string' && item.id.trim().length > 0 ? item.id.trim() : randomUUID(),
        text,
        sourceInMs,
        sourceOutMs,
      };
    })
    .filter((item): item is NonNullable<typeof item> => item != null);

  return normalized.length > 0 ? normalized : fallback;
}

function resolveSegmentCutBool(
  raw: Record<string, unknown>,
  key: 'preserveNatSound' | 'muteSource',
  fallback?: boolean,
): boolean | undefined {
  if (typeof raw[key] === 'boolean') {
    return raw[key] as boolean;
  }
  if (raw.actions && typeof raw.actions === 'object' && !Array.isArray(raw.actions)) {
    const candidate = (raw.actions as Record<string, unknown>)[key];
    if (typeof candidate === 'boolean') {
      return candidate;
    }
  }
  return fallback;
}

function resolveSegmentCutSpeed(raw: Record<string, unknown>): number | undefined {
  if (typeof raw.speedSuggestion === 'number' && Number.isFinite(raw.speedSuggestion) && raw.speedSuggestion > 0) {
    return raw.speedSuggestion;
  }
  if (raw.actions && typeof raw.actions === 'object' && !Array.isArray(raw.actions)) {
    const speed = (raw.actions as Record<string, unknown>).speed;
    if (typeof speed === 'number' && Number.isFinite(speed) && speed > 0) {
      return speed;
    }
  }
  return undefined;
}

function isCueInsideSelections(
  sourceInMs: number,
  sourceOutMs: number,
  audioSelections: IKtepScriptSelection[],
): boolean {
  if (sourceOutMs <= sourceInMs) {
    return false;
  }
  return audioSelections.some(selection =>
    typeof selection.sourceInMs === 'number'
    && typeof selection.sourceOutMs === 'number'
    && sourceInMs >= selection.sourceInMs
    && sourceOutMs <= selection.sourceOutMs,
  );
}

function buildSegmentCutAudit(
  base: ISegmentRoughCutPlan,
  draft: ISegmentRoughCutPlan,
) {
  const baseSpanIds = new Set(base.lockedSpanIds);
  const draftSpanIds = new Set(dedupeStrings(
    draft.beats.flatMap(beat => [
      ...beat.linkedSpanIds,
      ...beat.audioSelections.map(selection => selection.spanId),
      ...beat.visualSelections.map(selection => selection.spanId),
    ]),
  ));
  const foreignSpanIds = [...draftSpanIds].filter(spanId => spanId && !baseSpanIds.has(spanId));
  const removedSpanIds = base.lockedSpanIds.filter(spanId => !draftSpanIds.has(spanId));
  const nonDriveSpeedBeatIds = draft.beats
    .filter(beat =>
      typeof beat.speedSuggestion === 'number'
      && beat.speedSuggestion > 0
      && !beat.visualSelections.every(selection =>
        selection.sliceId?.includes('drive')
        || selection.sliceId?.includes('aerial')
        || beat.linkedSpanIds.some(spanId => spanId.includes('drive') || spanId.includes('aerial')),
      ))
    .map(beat => beat.beatId);

  return {
    removedSpanIds,
    foreignSpanIds,
    nonDriveSpeedBeatIds,
    beatCountDelta: draft.beats.length - base.beats.length,
  };
}

function summarizeSegmentCutAudit(audit: ReturnType<typeof buildSegmentCutAudit>): string {
  const parts = [
    `removed=${audit.removedSpanIds.length}`,
    `foreign=${audit.foreignSpanIds.length}`,
    `nonDriveSpeed=${audit.nonDriveSpeedBeatIds.length}`,
    `beatDelta=${audit.beatCountDelta}`,
  ];
  return parts.join(' / ');
}

function normalizeSegmentCutReview(
  raw: Partial<ISegmentCutReview>,
  segmentId: string,
  attempt: number,
): ISegmentCutReview {
  const verdict = raw.verdict === 'pass' || raw.verdict === 'revise' || raw.verdict === 'awaiting_user'
    ? raw.verdict
    : 'revise';
  const rawIssues = Array.isArray(raw.issues) ? raw.issues as unknown[] : [];
  const issues: IStageReviewIssue[] = rawIssues.length > 0
    ? rawIssues
      .filter((item): item is Record<string, unknown> =>
        !!item && typeof item === 'object' && !Array.isArray(item))
      .map(item => ({
        code: typeof item.code === 'string' && item.code.trim().length > 0 ? item.code.trim() : 'unknown_issue',
        severity: item.severity === 'warning' ? 'warning' as const : 'blocker' as const,
        message: typeof item.message === 'string' && item.message.trim().length > 0
          ? item.message.trim()
          : 'reviewer flagged an unspecified issue',
        details: item.details,
      }))
    : [];
  const blockerIssues = issues.filter(issue => issue.severity === 'blocker');

  return {
    segmentId,
    stage: `segment-cut:${segmentId}`,
    identity: 'segment-cut-reviewer',
    attempt,
    verdict: blockerIssues.length > 0 && verdict === 'pass' ? 'revise' : verdict,
    issues,
    revisionBrief: Array.isArray(raw.revisionBrief)
      ? raw.revisionBrief.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      : blockerIssues.map(issue => `${issue.code}: ${issue.message}`),
    reviewedAt: typeof raw.reviewedAt === 'string' && raw.reviewedAt.trim().length > 0
      ? raw.reviewedAt
      : new Date().toISOString(),
  };
}

function buildTimelineStageErrorReview(
  segmentId: string,
  attempt: number,
  error: unknown,
): ISegmentCutReview {
  return {
    segmentId,
    stage: `segment-cut:${segmentId}`,
    identity: 'segment-cut-reviewer',
    attempt,
    verdict: 'revise',
    issues: [{
      code: 'review_error',
      severity: 'blocker',
      message: formatTimelineStageError(error),
    }],
    revisionBrief: ['review_error'],
    reviewedAt: new Date().toISOString(),
  };
}

function formatTimelineStageError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function buildWindowKey(assetId: string, spanId?: string, sliceId?: string): string {
  return [assetId, spanId ?? '', sliceId ?? ''].join('|');
}

function clampSelectionBound(
  value: number | undefined,
  minValue: number | undefined,
  maxValue: number | undefined,
): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const lower = typeof minValue === 'number' && Number.isFinite(minValue) ? minValue : value;
  const upper = typeof maxValue === 'number' && Number.isFinite(maxValue) ? maxValue : value;
  if (upper < lower) return undefined;
  return Math.max(lower, Math.min(value, upper));
}

function dedupeSelections(selections: IKtepScriptSelection[]): IKtepScriptSelection[] {
  const seen = new Set<string>();
  const result: IKtepScriptSelection[] = [];
  for (const selection of selections) {
    const key = [
      selection.assetId,
      selection.spanId ?? '',
      selection.sliceId ?? '',
      selection.sourceInMs ?? '',
      selection.sourceOutMs ?? '',
    ].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(selection);
  }
  return result;
}

function dedupeStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === 'string' && value.trim().length > 0))];
}

function normalizeOptionalStringList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return dedupeStrings(raw.filter((item): item is string => typeof item === 'string' && item.trim().length > 0));
}
