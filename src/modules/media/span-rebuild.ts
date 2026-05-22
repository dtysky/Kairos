import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  EClipType,
  IAgentPacket,
  IAssetCoarseReport,
  IFineScanWindow,
  IInterestingWindow,
  IKtepAsset,
  IKtepSlice,
  IMediaRoot,
  ISpansMeta,
  ITranscriptSegment,
} from '../../protocol/schema.js';
import { IKtepSlice as IKtepSliceSchema } from '../../protocol/schema.js';
import {
  getProjectProgressPath,
  getSpansPath,
  loadAssetReports,
  loadAssets,
  loadIngestRoots,
  resolveWorkspaceProjectRoot,
  touchProjectUpdatedAt,
  writeKairosProgress,
  writeJson,
  writeSpansMeta,
} from '../../store/index.js';
import {
  AgentRunnerUnavailableError,
  type IJsonPacketAgentRunner,
} from '../agents/runtime.js';
import {
  CSPAN_MATERIAL_PATTERN_ENVIRONMENT_UNKNOWN,
  CSPAN_MATERIAL_PATTERN_MAX_COUNT,
  CSPAN_MATERIAL_PATTERN_REQUIRED_COUNT,
  CSPAN_MATERIAL_PATTERN_SPEECH_ABSENT,
  CSPAN_MATERIAL_PATTERN_SPEECH_PRESENT,
  CSPAN_MATERIAL_PATTERN_SPEECH_TAGS,
  CSPAN_MATERIAL_PATTERN_STORY_UNKNOWN,
  CSPAN_MATERIAL_PATTERN_TECHNICAL_WEATHER_TERMS,
  CSPAN_MATERIAL_PATTERN_VIEWPOINT_TAGS,
  CSPAN_MATERIAL_PATTERN_VIEWPOINT_UNKNOWN,
  CSPAN_MATERIAL_PATTERN_WEATHER_UNKNOWN,
} from '../agents/span-material-pattern-spec.js';
import {
  buildSpanMaterializationReviewHardConstraints,
  buildSpanMaterializationReviewOutputSchema,
  CSPAN_MATERIALIZATION_REVIEW_BATCH_SIZE,
  CSPAN_MATERIALIZATION_REVIEW_MAX_TOKENS,
  CSPAN_MATERIALIZATION_REVIEW_PROMPT_VERSION,
} from '../agents/span-materialization-review-spec.js';
import { assignUniqueMaterialSpanIds, buildMaterialSpanId } from './material-ids.js';
import { sanitizeMaterialPatterns } from './semantic-slice.js';

export const CMATERIAL_PATTERN_PROMPT_VERSION = CSPAN_MATERIALIZATION_REVIEW_PROMPT_VERSION;
const CMATERIAL_PATTERN_SPAN_BATCH_SIZE = CSPAN_MATERIALIZATION_REVIEW_BATCH_SIZE;
const CMATERIAL_PATTERN_TRANSCRIPT_LIMIT = 220;
const CMATERIAL_PATTERN_TEXT_LIMIT = 220;
const CMATERIAL_PATTERN_MAX_TOKENS = CSPAN_MATERIALIZATION_REVIEW_MAX_TOKENS;
const CMATERIAL_PATTERN_MAX_COUNT = CSPAN_MATERIAL_PATTERN_MAX_COUNT;
const CMATERIAL_PATTERN_REQUIRED_COUNT = CSPAN_MATERIAL_PATTERN_REQUIRED_COUNT;
const CMATERIAL_PATTERN_VIEWPOINT_TAG_SET = new Set<string>(CSPAN_MATERIAL_PATTERN_VIEWPOINT_TAGS);
const CMATERIAL_PATTERN_SPEECH_TAG_SET = new Set<string>(CSPAN_MATERIAL_PATTERN_SPEECH_TAGS);

export interface ISpanRebuildResult {
  spans: IKtepSlice[];
  warnings: string[];
  inputsHash: string;
}

export interface IProjectSpanRebuildResult {
  projectRoot: string;
  assetCount: number;
  reportCount: number;
  spanCount: number;
  inputsHash: string;
  warnings: string[];
  meta: ISpansMeta;
}

interface INormalizedWindow {
  id: string;
  semanticKind?: IKtepSlice['semanticKind'];
  sourceInMs: number;
  sourceOutMs: number;
  editSourceInMs: number;
  editSourceOutMs: number;
  visualObservation?: string;
  transcript?: string;
  transcriptSegments?: ITranscriptSegment[];
  speechCoverage?: number;
}

interface ISpanMaterialPatternItem {
  type: string;
  semanticKind?: IKtepSlice['semanticKind'];
  transcript?: string;
  transcriptSegments?: ISpanMaterializationReviewTranscriptSegment[];
  visualObservation?: string;
}

interface ISpanMaterializationReviewTranscriptSegment {
  index: number;
  startMs: number;
  endMs: number;
  text: string;
}

interface ISpanRebuildPartialCheckpoint {
  schemaVersion: '1.0';
  status: 'running' | 'failed' | 'succeeded';
  updatedAt: string;
  promptVersion?: string;
  inputsHash: string;
  spanCount: number;
  chunkSize: number;
  completedCount: number;
  spans: IKtepSlice[];
  warnings: string[];
  lastError?: string;
  failedSpanId?: string;
  activeSpanIds?: string[];
  failedSpans?: ISpanRebuildFailedSpan[];
  failedCount?: number;
  recoveredFailedCount?: number;
  storyUnknownFallbackCount?: number;
  retryCount?: number;
  repairCount?: number;
}

interface ISpanRebuildFailedSpan {
  spanId: string;
  assetId?: string;
  chunkIndex?: number;
  reason: string;
  attempts: number;
  lastError?: string;
  recovered?: boolean;
  fallbackStoryUnknown?: boolean;
}

interface ISpanMaterializationReviewGenerationResult {
  spans: IKtepSlice[];
  checkpointSpans: Array<IKtepSlice & { sourceSpanId?: string; dropped?: boolean }>;
  failedSpans: ISpanRebuildFailedSpan[];
  retryCount: number;
  repairCount: number;
  recoveredFailedCount: number;
  storyUnknownFallbackCount: number;
  droppedCount: number;
  visualOnlyCount: number;
  trimmedSpeechCount: number;
}

interface IChunkMaterialPatternRequestResult {
  decisions: Map<string, ISpanMaterializationReviewDecision>;
  needsRetry: boolean;
  repairCount: number;
  failureReasonBySpanId: Map<string, string>;
  requestError?: string;
}

interface ISpanMaterializationReviewDecision {
  sourceSpanId: string;
  finalSpan?: IKtepSlice;
  dropped: boolean;
  visualOnly: boolean;
  trimmedSpeech: boolean;
}

export function buildMaterialSpansFromReports(input: {
  assets: IKtepAsset[];
  reports: IAssetCoarseReport[];
  roots?: IMediaRoot[];
  pharosContext?: unknown;
}): ISpanRebuildResult {
  const warnings: string[] = [];
  assertMaterialAssetsHaveReports(input.assets, input.reports);
  const assetsById = new Map(input.assets.map(asset => [asset.id, asset] as const));
  const spans: IKtepSlice[] = [];

  for (const report of input.reports) {
    if (report.keepDecision === 'drop') {
      warnings.push(`asset ${report.assetId}: skipped because keepDecision=drop`);
      continue;
    }
    const asset = assetsById.get(report.assetId);
    if (!asset) {
      warnings.push(`asset ${report.assetId}: skipped because asset is missing from store/assets.json`);
      continue;
    }
    if (asset.kind === 'audio') {
      warnings.push(`asset ${asset.id}: skipped because audio assets do not generate material spans`);
      continue;
    }

    if (report.materializationPath === 'fine-scan') {
      spans.push(...buildFineScanSpans({ asset, report, warnings }));
      continue;
    }

    spans.push(...buildDirectSpans({ asset, report, warnings }));
  }

  assertUniqueSpanIds(spans);

  const merged = assignUniqueMaterialSpanIds(
    mergeNearDuplicateWindows(spans),
    new Map(input.assets.map(asset => [asset.id, { kind: asset.kind }] as const)),
  );
  assertUniqueSpanIds(merged);
  assertMaterialSpansHaveVisualObservation(merged, assetsById);

  return {
    spans: merged,
    warnings: dedupeStrings(warnings),
    inputsHash: buildSpanInputsHash({ assets: input.assets, spans: merged }),
  };
}

export async function buildAnalyzeSpansFromReports(input: {
  assets: IKtepAsset[];
  reports: IAssetCoarseReport[];
  roots?: IMediaRoot[];
  pharosContext?: unknown;
}): Promise<IKtepSlice[]> {
  return buildMaterialSpansFromReports(input).spans;
}

function assertMaterialAssetsHaveReports(
  assets: IKtepAsset[],
  reports: IAssetCoarseReport[],
): void {
  const reportedAssetIds = new Set(reports.map(report => report.assetId));
  const missing = assets
    .filter(asset => asset.kind !== 'audio' && !reportedAssetIds.has(asset.id));
  if (missing.length === 0) return;
  throw new Error(
    [
      `span-rebuild blocked: ${missing.length} non-audio asset(s) are missing asset-report visual evidence.`,
      'Copy the full analysis/asset-reports cache back or rerun Analyze before rebuilding spans.',
      `Missing examples: ${formatSpanRebuildInputExamples(missing)}`,
    ].join(' '),
  );
}

function assertMaterialSpansHaveVisualObservation(
  spans: IKtepSlice[],
  assetsById?: Map<string, IKtepAsset>,
): void {
  const missing = spans.filter(span => !span.visualObservation?.trim());
  if (missing.length === 0) return;
  throw new Error(
    [
      `span-rebuild blocked: ${missing.length} material span(s) are missing visualObservation.`,
      'visualObservation must be produced by Analyze; span-rebuild will not invent visual evidence or call the materialization review LM.',
      `Missing examples: ${formatSpanRebuildInputExamples(missing.map(span => assetsById?.get(span.assetId) ?? span))}`,
    ].join(' '),
  );
}

function formatSpanRebuildInputExamples(
  items: Array<IKtepAsset | IKtepSlice>,
  limit = 6,
): string {
  return items
    .slice(0, limit)
    .map(item => {
      if ('sourcePath' in item) {
        return `${item.id}${item.displayName ? ` (${item.displayName})` : ''}`;
      }
      return `${item.id} asset=${item.assetId}`;
    })
    .join(', ');
}

export async function rebuildProjectSpans(input: {
  workspaceRoot: string;
  projectId: string;
  now?: string;
  agentRunner?: IJsonPacketAgentRunner;
  progressPath?: string;
}): Promise<IProjectSpanRebuildResult> {
  if (!input.agentRunner) {
    throw new AgentRunnerUnavailableError(
      'span-rebuild requires a local text LM runner to review speech usability and generate materialPatterns; no spans were rewritten.',
    );
  }
  const projectRoot = resolveWorkspaceProjectRoot(input.workspaceRoot, input.projectId);
  const progressPath = input.progressPath ?? getProjectProgressPath(projectRoot, 'chronology');
  await writeSpanRebuildProgress(progressPath, {
    status: 'running',
    step: 'slice',
    stepLabel: '生成素材片段',
    stepIndex: 1,
    stepTotal: 4,
    current: 0,
    total: 4,
    unit: 'step',
    detail: '读取 assets 与 asset reports，生成 stripped spans',
  });
  const [assets, reports, { roots }] = await Promise.all([
    loadAssets(projectRoot),
    loadAssetReports(projectRoot),
    loadIngestRoots(projectRoot),
  ]);
  const generated = buildMaterialSpansFromReports({ assets, reports, roots });
  const reviewCandidateSpans = sortSpansByMaterialTime(generated.spans, assets, roots);
  const partialPath = getSpanRebuildPartialPath(projectRoot);
  const chunkCount = Math.ceil(reviewCandidateSpans.length / CMATERIAL_PATTERN_SPAN_BATCH_SIZE);
  await writeSpanRebuildProgress(progressPath, {
    status: 'running',
    step: 'patterns',
    stepLabel: '审查口播并生成素材模式',
    stepIndex: 2,
    stepTotal: 4,
    current: 0,
    total: Math.max(reviewCandidateSpans.length, 1),
    unit: 'span',
    detail: reviewCandidateSpans.length > 0
      ? '调用本地文本 LM 审查口播可用性并生成中文 materialPatterns'
      : '没有可审查的 spans',
    extra: {
      spanCount: reviewCandidateSpans.length,
      chunkSize: CMATERIAL_PATTERN_SPAN_BATCH_SIZE,
      chunkCount,
    },
  });
  const reviewWarnings: string[] = [];
  const reviewResult = await generateSpanMaterializationReview({
    spans: reviewCandidateSpans,
    agentRunner: input.agentRunner,
    progressPath,
    partialPath,
    inputsHash: generated.inputsHash,
    baseWarnings: generated.warnings,
    warnings: reviewWarnings,
  });
  const spans = assignUniqueMaterialSpanIds(
    reviewResult.spans,
    new Map(assets.map(asset => [asset.id, { kind: asset.kind }] as const)),
  );
  const now = input.now ?? new Date().toISOString();
  const warnings = dedupeStrings([...generated.warnings, ...reviewWarnings]);
  const meta: ISpansMeta = {
    schemaVersion: '1.0',
    status: 'fresh',
    generatedAt: now,
    inputsHash: generated.inputsHash,
    assetCount: assets.length,
    reportCount: reports.length,
    spanCount: spans.length,
    warnings,
  };

  await writeSpanRebuildProgress(progressPath, {
    status: 'running',
    step: 'write',
    stepLabel: '写入 spans',
    stepIndex: 4,
    stepTotal: 4,
    current: 3,
    total: 4,
    unit: 'step',
    detail: '写入 store/spans.json 与 store/spans.meta.json',
    extra: {
      spanCount: spans.length,
      warningCount: warnings.length,
      failedCount: reviewResult.failedSpans.length,
      recoveredFailedCount: reviewResult.recoveredFailedCount,
      storyUnknownFallbackCount: reviewResult.storyUnknownFallbackCount,
      retryCount: reviewResult.retryCount,
      repairCount: reviewResult.repairCount,
      droppedCount: reviewResult.droppedCount,
      visualOnlyCount: reviewResult.visualOnlyCount,
      trimmedSpeechCount: reviewResult.trimmedSpeechCount,
    },
  });
  await writeJson(getSpansPath(projectRoot), spans);
  await writeSpansMeta(projectRoot, meta);
  await writeSpanRebuildPartial(partialPath, {
    status: 'succeeded',
    promptVersion: CMATERIAL_PATTERN_PROMPT_VERSION,
    inputsHash: generated.inputsHash,
    spanCount: reviewCandidateSpans.length,
    chunkSize: CMATERIAL_PATTERN_SPAN_BATCH_SIZE,
    completedCount: reviewCandidateSpans.length,
    spans: reviewResult.checkpointSpans,
    warnings,
    failedSpans: reviewResult.failedSpans,
    failedCount: reviewResult.failedSpans.length,
    recoveredFailedCount: reviewResult.recoveredFailedCount,
    storyUnknownFallbackCount: reviewResult.storyUnknownFallbackCount,
    retryCount: reviewResult.retryCount,
    repairCount: reviewResult.repairCount,
  });
  await touchProjectUpdatedAt(projectRoot);
  await writeSpanRebuildProgress(progressPath, {
    status: 'succeeded',
    step: 'done',
    stepLabel: '素材片段已生成',
    stepIndex: 4,
    stepTotal: 4,
    current: 4,
    total: 4,
    unit: 'step',
    etaSeconds: 0,
    detail: `写入 ${spans.length} 个 spans，${warnings.length} 条 warning`,
    extra: {
      assetCount: assets.length,
      reportCount: reports.length,
      spanCount: spans.length,
      warningCount: warnings.length,
      inputsHash: generated.inputsHash,
      failedCount: reviewResult.failedSpans.length,
      recoveredFailedCount: reviewResult.recoveredFailedCount,
      storyUnknownFallbackCount: reviewResult.storyUnknownFallbackCount,
      retryCount: reviewResult.retryCount,
      repairCount: reviewResult.repairCount,
      droppedCount: reviewResult.droppedCount,
      visualOnlyCount: reviewResult.visualOnlyCount,
      trimmedSpeechCount: reviewResult.trimmedSpeechCount,
    },
  });

  return {
    projectRoot,
    assetCount: assets.length,
    reportCount: reports.length,
    spanCount: spans.length,
    inputsHash: generated.inputsHash,
    warnings,
    meta,
  };
}

function buildFineScanSpans(input: {
  asset: IKtepAsset;
  report: IAssetCoarseReport;
  warnings: string[];
}): IKtepSlice[] {
  if ((input.report.fineScanWindows ?? []).length === 0) {
    throw new Error(
      `asset report ${input.report.assetId} requires fine-scan spans but has no fineScanWindows; rerun Analyze/fine-scan for this asset.`,
    );
  }

  const spans: IKtepSlice[] = [];
  for (const window of input.report.fineScanWindows ?? []) {
    if (window.status !== 'recognized') {
      if (!window.dropReason?.trim()) {
        throw new Error(
          `asset report ${input.report.assetId} fine-scan window ${window.windowId} is dropped without dropReason; rerun Analyze/fine-scan for this asset.`,
        );
      }
      input.warnings.push(`asset ${input.asset.id}: fine-scan window ${window.windowId} dropped (${window.dropReason ?? 'no reason'})`);
      continue;
    }
    if (!window.visualObservation?.trim()) {
      throw new Error(
        `asset report ${input.report.assetId} fine-scan window ${window.windowId} is recognized without visualObservation; rerun Analyze/fine-scan for this asset.`,
      );
    }
    const semanticKind = resolveFineScanWindowSemanticKind({
      report: input.report,
      window,
      warnings: input.warnings,
    });
    const normalized = normalizeWindow({
      asset: input.asset,
      id: window.windowId,
      sourceInMs: window.sourceInMs,
      sourceOutMs: window.sourceOutMs,
      editSourceInMs: window.editSourceInMs,
      editSourceOutMs: window.editSourceOutMs,
      semanticKind,
      visualObservation: window.visualObservation,
      transcript: window.transcript,
      transcriptSegments: window.transcriptSegments,
      speechCoverage: window.speechCoverage,
      warnings: input.warnings,
    });
    if (!normalized) continue;
    const span = buildSpanFromWindow({
      asset: input.asset,
      report: input.report,
      type: mapClipTypeToSpanType(input.asset, input.report.clipTypeGuess),
      window: normalized,
    });
    assertSpeechFineScanWindowPreserved({
      report: input.report,
      window,
      semanticKind,
      span,
    });
    spans.push(span);
  }
  return spans;
}

function resolveFineScanWindowSemanticKind(input: {
  report: IAssetCoarseReport;
  window: IFineScanWindow;
  warnings: string[];
}): IKtepSlice['semanticKind'] | undefined {
  if (input.window.semanticKind) return input.window.semanticKind;

  if (fineScanWindowHasSpeechTruth(input.window)) {
    input.warnings.push(
      `asset ${input.report.assetId}: recovered fine-scan window ${input.window.windowId} semanticKind=speech from fineScanWindow transcript truth`,
    );
    return 'speech';
  }

  if (!hasReportTranscriptSegmentOverlap(input.report, input.window.sourceInMs, input.window.sourceOutMs)) {
    return undefined;
  }

  if (
    isSpeechWindowReason(input.window.reason)
    || isSpeechWindowReason(input.window.sourceWindowReason)
  ) {
    input.warnings.push(
      `asset ${input.report.assetId}: recovered fine-scan window ${input.window.windowId} semanticKind=speech from speech-window transcript overlap`,
    );
    return 'speech';
  }

  const sourceWindow = findSpeechSourceInterestingWindow(input.report, input.window);
  if (sourceWindow) {
    input.warnings.push(
      `asset ${input.report.assetId}: recovered fine-scan window ${input.window.windowId} semanticKind=speech from source interestingWindow ${sourceWindow.windowId ?? 'overlap'}`,
    );
    return 'speech';
  }

  return undefined;
}

function findSpeechSourceInterestingWindow(
  report: IAssetCoarseReport,
  window: IFineScanWindow,
): IInterestingWindow | undefined {
  const sourceIds = new Set(window.sourceInterestingWindowIds ?? []);
  if (sourceIds.size > 0) {
    const byId = report.interestingWindows.find(candidate =>
      candidate.windowId != null
      && sourceIds.has(candidate.windowId)
      && isSpeechInterestingWindow(candidate),
    );
    if (byId) return byId;
  }
  if (!isFiniteNumber(window.sourceInMs) || !isFiniteNumber(window.sourceOutMs)) return undefined;
  return report.interestingWindows.find(candidate =>
    isSpeechInterestingWindow(candidate)
    && candidate.endMs > (window.sourceInMs as number)
    && candidate.startMs < (window.sourceOutMs as number),
  );
}

function isSpeechInterestingWindow(window: IInterestingWindow): boolean {
  return window.semanticKind === 'speech'
    || window.semanticKind === 'mixed'
    || isSpeechWindowReason(window.reason);
}

function isSpeechWindowReason(reason?: string): boolean {
  return reason?.trim().toLowerCase() === 'speech-window';
}

function hasReportTranscriptSegmentOverlap(
  report: IAssetCoarseReport,
  sourceInMs?: number,
  sourceOutMs?: number,
): boolean {
  if (!isFiniteNumber(sourceInMs) || !isFiniteNumber(sourceOutMs) || sourceOutMs <= sourceInMs) return false;
  return (report.transcriptSegments ?? []).some(segment =>
    segment.text.trim().length > 0
    && segment.endMs > sourceInMs
    && segment.startMs < sourceOutMs,
  );
}

function assertSpeechFineScanWindowPreserved(input: {
  report: IAssetCoarseReport;
  window: IFineScanWindow;
  semanticKind?: IKtepSlice['semanticKind'];
  span: IKtepSlice;
}): void {
  if (
    input.window.status !== 'recognized'
    || (input.semanticKind !== 'speech' && input.semanticKind !== 'mixed')
    || (
      !fineScanWindowHasSpeechTruth(input.window)
      && !hasReportTranscriptSegmentOverlap(input.report, input.window.sourceInMs, input.window.sourceOutMs)
    )
  ) {
    return;
  }
  if (spanHasSpeechTruth(input.span)) return;
  throw new Error(
    `span-rebuild speech truth lost: asset ${input.report.assetId} fine-scan window ${input.window.windowId} has speech-window transcript evidence but output span lacks speech truth`,
  );
}

function buildDirectSpans(input: {
  asset: IKtepAsset;
  report: IAssetCoarseReport;
  warnings: string[];
}): IKtepSlice[] {
  const windows = buildDirectWindows(input.asset, input.report, input.warnings);
  return windows.map(window => buildSpanFromWindow({
    asset: input.asset,
    report: input.report,
    type: mapClipTypeToSpanType(input.asset, input.report.clipTypeGuess),
    window,
  }));
}

function buildDirectWindows(
  asset: IKtepAsset,
  report: IAssetCoarseReport,
  warnings: string[],
): INormalizedWindow[] {
  if (asset.kind === 'photo') {
    return [{
      id: buildMaterialSpanId({
        assetId: asset.id,
        assetKind: asset.kind,
        type: 'photo',
        sourceInMs: 0,
        sourceOutMs: 0,
      }),
      sourceInMs: 0,
      sourceOutMs: 0,
      editSourceInMs: 0,
      editSourceOutMs: 0,
      visualObservation: normalizeText(report.summary),
    }];
  }

  if (report.interestingWindows.length > 0) {
    return report.interestingWindows
      .map((window, index) => normalizeInterestingWindow({
        asset,
        window,
        id: buildMaterialSpanId({
          assetId: asset.id,
          assetKind: asset.kind,
          type: mapClipTypeToSpanType(asset, report.clipTypeGuess),
          semanticKind: window.semanticKind,
          sourceInMs: window.startMs,
          sourceOutMs: window.endMs,
        }),
        warnings,
      }))
      .filter((window): window is INormalizedWindow => window != null);
  }

  if (typeof asset.durationMs === 'number' && asset.durationMs > 0) {
    return [{
      id: buildMaterialSpanId({
        assetId: asset.id,
        assetKind: asset.kind,
        type: mapClipTypeToSpanType(asset, report.clipTypeGuess),
        sourceInMs: 0,
        sourceOutMs: asset.durationMs,
      }),
      sourceInMs: 0,
      sourceOutMs: asset.durationMs,
      editSourceInMs: 0,
      editSourceOutMs: asset.durationMs,
      visualObservation: normalizeText(report.summary),
    }];
  }

  warnings.push(`asset ${asset.id}: skipped direct fallback because durationMs is missing or invalid`);
  return [];
}

function normalizeInterestingWindow(input: {
  asset: IKtepAsset;
  window: IInterestingWindow;
  id: string;
  warnings: string[];
}): INormalizedWindow | null {
  return normalizeWindow({
    asset: input.asset,
    id: input.id,
    sourceInMs: input.window.startMs,
    sourceOutMs: input.window.endMs,
    editSourceInMs: input.window.editStartMs,
    editSourceOutMs: input.window.editEndMs,
    semanticKind: input.window.semanticKind,
    warnings: input.warnings,
  });
}

function normalizeWindow(input: {
  asset: IKtepAsset;
  id: string;
  sourceInMs?: number;
  sourceOutMs?: number;
  editSourceInMs?: number;
  editSourceOutMs?: number;
  semanticKind?: IKtepSlice['semanticKind'];
  visualObservation?: string;
  transcript?: string;
  transcriptSegments?: ITranscriptSegment[];
  speechCoverage?: number;
  warnings: string[];
}): INormalizedWindow | null {
  if (input.asset.kind !== 'video') {
    return {
      id: input.id,
      sourceInMs: 0,
      sourceOutMs: 0,
      editSourceInMs: 0,
      editSourceOutMs: 0,
      semanticKind: input.semanticKind,
      visualObservation: normalizeText(input.visualObservation),
      transcript: input.transcript,
      transcriptSegments: input.transcriptSegments,
      speechCoverage: input.speechCoverage,
    };
  }

  if (!isFiniteNumber(input.sourceInMs) || !isFiniteNumber(input.sourceOutMs)) {
    input.warnings.push(`asset ${input.asset.id}: skipped window ${input.id} because source range is missing`);
    return null;
  }

  const sourceInMs = clampToAsset(input.sourceInMs, input.asset.durationMs);
  const sourceOutMs = clampToAsset(input.sourceOutMs, input.asset.durationMs);
  if (sourceOutMs <= sourceInMs) {
    input.warnings.push(`asset ${input.asset.id}: skipped window ${input.id} because source range is invalid`);
    return null;
  }

  const rawEditInMs = isFiniteNumber(input.editSourceInMs) ? input.editSourceInMs : sourceInMs;
  const rawEditOutMs = isFiniteNumber(input.editSourceOutMs) ? input.editSourceOutMs : sourceOutMs;
  const editSourceInMs = clampToAsset(Math.min(rawEditInMs, sourceInMs), input.asset.durationMs);
  const editSourceOutMs = clampToAsset(Math.max(rawEditOutMs, sourceOutMs), input.asset.durationMs);

  return {
    id: input.id,
    sourceInMs,
    sourceOutMs,
    editSourceInMs,
    editSourceOutMs,
    semanticKind: input.semanticKind,
    visualObservation: normalizeText(input.visualObservation),
    transcript: input.transcript,
    transcriptSegments: input.transcriptSegments,
    speechCoverage: input.speechCoverage,
  };
}

function buildSpanFromWindow(input: {
  asset: IKtepAsset;
  report: IAssetCoarseReport;
  type: IKtepSlice['type'];
  window: INormalizedWindow;
}): IKtepSlice {
  const transcript = clipTranscript(
    input.report,
    input.window.sourceInMs,
    input.window.sourceOutMs,
    input.window.semanticKind,
    input.window,
  );
  const visualObservation = normalizeText(input.window.visualObservation ?? input.report.summary);
  const span = {
    id: input.window.id,
    assetId: input.asset.id,
    type: input.type,
    semanticKind: input.window.semanticKind,
    sourceInMs: input.window.sourceInMs,
    sourceOutMs: input.window.sourceOutMs,
    editSourceInMs: input.window.editSourceInMs,
    editSourceOutMs: input.window.editSourceOutMs,
    transcript: transcript.text,
    transcriptSegments: transcript.segments.length > 0 ? transcript.segments : undefined,
    visualObservation,
    materialPatterns: [],
    speechCoverage: transcript.coverage,
  };
  return stripUndefined(span) as unknown as IKtepSlice;
}

function clipTranscript(
  report: IAssetCoarseReport,
  sourceInMs: number,
  sourceOutMs: number,
  semanticKind?: IKtepSlice['semanticKind'],
  window?: Pick<INormalizedWindow, 'transcript' | 'transcriptSegments' | 'speechCoverage'>,
): { text?: string; segments: ITranscriptSegment[]; coverage?: number } {
  if (semanticKind !== 'speech' && semanticKind !== 'mixed') {
    return { segments: [] };
  }

  const windowSegments = clipTranscriptSegments(window?.transcriptSegments ?? [], sourceInMs, sourceOutMs);
  if (windowSegments.length > 0) {
    return {
      text: windowSegments.map(segment => segment.text).join(' ').trim() || normalizeText(window?.transcript),
      segments: windowSegments,
      coverage: isFiniteNumber(window?.speechCoverage)
        ? window?.speechCoverage
        : computeSpeechCoverage(sourceInMs, sourceOutMs, windowSegments),
    };
  }

  const windowTranscript = normalizeText(window?.transcript);
  if (windowTranscript) {
    return {
      text: windowTranscript,
      segments: [],
      coverage: window?.speechCoverage,
    };
  }

  const segments = clipTranscriptSegments(report.transcriptSegments ?? [], sourceInMs, sourceOutMs);
  if (segments.length === 0) {
    const fullTranscript = normalizeText(report.transcript);
    return {
      text: fullTranscript,
      segments: [],
      coverage: report.speechCoverage,
    };
  }

  return {
    text: segments.map(segment => segment.text).join(' ').trim() || undefined,
    segments,
    coverage: computeSpeechCoverage(sourceInMs, sourceOutMs, segments) ?? report.speechCoverage,
  };
}

function clipTranscriptSegments(
  segments: ITranscriptSegment[],
  sourceInMs: number,
  sourceOutMs: number,
): ITranscriptSegment[] {
  return segments
    .map(segment => ({
      startMs: Math.max(sourceInMs, segment.startMs),
      endMs: Math.min(sourceOutMs, segment.endMs),
      text: segment.text.trim(),
    }))
    .filter(segment => segment.text.length > 0 && segment.endMs > segment.startMs);
}

function fineScanWindowHasSpeechTruth(window: IFineScanWindow): boolean {
  return Boolean(window.transcript?.trim())
    || (window.transcriptSegments ?? []).some(segment => segment.text.trim().length > 0)
    || isFiniteNumber(window.speechCoverage);
}

function spanHasSpeechTruth(span: IKtepSlice): boolean {
  return Boolean(span.transcript?.trim())
    || (span.transcriptSegments?.length ?? 0) > 0
    || span.semanticKind === 'speech'
    || span.semanticKind === 'mixed';
}

function mergeNearDuplicateWindows(spans: IKtepSlice[]): IKtepSlice[] {
  if (spans.length < 2) return spans;
  const sorted = [...spans].sort(compareSpanRanges);
  const merged: IKtepSlice[] = [];
  for (const span of sorted) {
    const previous = merged[merged.length - 1];
    if (previous && canMergeNearDuplicate(previous, span)) {
      merged[merged.length - 1] = mergeMaterialSpans(previous, span);
      continue;
    }
    merged.push(span);
  }
  return merged;
}

function canMergeNearDuplicate(left: IKtepSlice, right: IKtepSlice): boolean {
  if (left.assetId !== right.assetId) return false;
  if (left.semanticKind !== right.semanticKind) return false;
  const leftEndMs = left.sourceOutMs ?? Number.NEGATIVE_INFINITY;
  const rightStartMs = right.sourceInMs ?? Number.POSITIVE_INFINITY;
  return rightStartMs - leftEndMs <= 250;
}

function mergeMaterialSpans(left: IKtepSlice, right: IKtepSlice): IKtepSlice {
  const sourceInMs = pickDefinedMin([left.sourceInMs, right.sourceInMs]);
  const sourceOutMs = pickDefinedMax([left.sourceOutMs, right.sourceOutMs]);
  const editSourceInMs = pickDefinedMin([left.editSourceInMs, right.editSourceInMs, sourceInMs]);
  const editSourceOutMs = pickDefinedMax([left.editSourceOutMs, right.editSourceOutMs, sourceOutMs]);
  const transcriptSegments = mergeTranscriptSegments([
    ...(left.transcriptSegments ?? []),
    ...(right.transcriptSegments ?? []),
  ]);
  const transcript = transcriptSegments.length > 0
    ? transcriptSegments.map(segment => segment.text).join(' ').trim()
    : dedupeStrings([left.transcript, right.transcript]).join(' ').trim();
  const span = {
    ...left,
    sourceInMs,
    sourceOutMs,
    editSourceInMs,
    editSourceOutMs,
    transcript: transcript || undefined,
    transcriptSegments: transcriptSegments.length > 0 ? transcriptSegments : undefined,
    visualObservation: left.visualObservation ?? right.visualObservation,
    materialPatterns: sanitizeMaterialPatterns([
      ...(left.materialPatterns ?? []),
      ...(right.materialPatterns ?? []),
    ]),
    speechCoverage: resolveMergedSpeechCoverage(sourceInMs, sourceOutMs, transcriptSegments, left, right),
  };
  return stripUndefined(span) as unknown as IKtepSlice;
}

async function generateSpanMaterializationReview(input: {
  spans: IKtepSlice[];
  agentRunner: IJsonPacketAgentRunner;
  progressPath?: string;
  partialPath?: string;
  inputsHash: string;
  baseWarnings: string[];
  warnings: string[];
}): Promise<ISpanMaterializationReviewGenerationResult> {
  assertMaterialSpansHaveVisualObservation(input.spans);
  if (input.spans.length === 0) {
    return {
      spans: [],
      checkpointSpans: [],
      failedSpans: [],
      retryCount: 0,
      repairCount: 0,
      recoveredFailedCount: 0,
      storyUnknownFallbackCount: 0,
      droppedCount: 0,
      visualOnlyCount: 0,
      trimmedSpeechCount: 0,
    };
  }
  const chunks = chunkArray(input.spans, CMATERIAL_PATTERN_SPAN_BATCH_SIZE);
  const decisionBySpanId = new Map<string, ISpanMaterializationReviewDecision>();
  const failedBySpanId = new Map<string, ISpanRebuildFailedSpan>();
  const patternStartedAtMs = Date.now();
  let retryCount = 0;
  let repairCount = 0;
  let recoveredFailedCount = 0;
  let storyUnknownFallbackCount = 0;
  const reusableCheckpoint = await loadReusableSpanRebuildPartial({
    partialPath: input.partialPath,
    spans: input.spans,
    inputsHash: input.inputsHash,
  });

  if (reusableCheckpoint) {
    for (const [spanId, decision] of reusableCheckpoint.decisions) {
      decisionBySpanId.set(spanId, decision);
    }
    for (const failure of reusableCheckpoint.failedSpans) {
      failedBySpanId.set(failure.spanId, failure);
    }
    retryCount = reusableCheckpoint.retryCount;
    repairCount = reusableCheckpoint.repairCount;
    recoveredFailedCount = reusableCheckpoint.recoveredFailedCount;
    storyUnknownFallbackCount = reusableCheckpoint.storyUnknownFallbackCount;
    input.warnings.push(`span-rebuild resumed ${decisionBySpanId.size}/${input.spans.length} materialization review rows from checkpoint`);
    for (const warning of reusableCheckpoint.warnings) {
      if (!input.baseWarnings.includes(warning)) {
        input.warnings.push(warning);
      }
    }
  } else {
    await writeSpanRebuildPatternCheckpoint({
      partialPath: input.partialPath,
      status: 'running',
      inputsHash: input.inputsHash,
      spanCount: input.spans.length,
      spans: input.spans,
      decisionBySpanId,
      failedBySpanId,
      baseWarnings: input.baseWarnings,
      warnings: input.warnings,
      retryCount,
      repairCount,
      recoveredFailedCount,
      storyUnknownFallbackCount,
    });
  }

  for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
    const chunk = chunks[chunkIndex]!;
    const activeChunk = chunk.filter(span =>
      !decisionBySpanId.has(span.id) && !isActiveFailedSpan(failedBySpanId.get(span.id)),
    );
    if (activeChunk.length === 0) {
      continue;
    }
    await writeSpanRebuildProgress(input.progressPath, {
      status: 'running',
      step: 'patterns',
      stepLabel: '审查口播并生成素材模式',
      stepIndex: 2,
      stepTotal: 4,
      current: decisionBySpanId.size,
      total: input.spans.length,
      unit: 'span',
      etaSeconds: estimateSpanRebuildEtaSeconds(patternStartedAtMs, decisionBySpanId.size, input.spans.length),
      fileIndex: chunkIndex + 1,
      fileTotal: chunks.length,
      detail: `正在审查第 ${chunkIndex + 1}/${chunks.length} 批 span 的口播与 materialPatterns（本批 ${activeChunk.length} 个待处理）`,
      extra: {
        batchSize: activeChunk.length,
        retryCount,
        repairCount,
        warningCount: input.warnings.length,
        failedCount: activeFailedSpanCount(failedBySpanId),
        recoveredFailedCount,
        storyUnknownFallbackCount,
      },
    });

    const firstAttempt = await requestMaterializationReviewForChunk({
      agentRunner: input.agentRunner,
      chunk: activeChunk,
      items: activeChunk.map(span => buildMaterializationReviewItem(span)),
      chunkIndex,
      chunkTotal: chunks.length,
      attempt: 1,
      warnings: input.warnings,
    });
    repairCount += firstAttempt.repairCount;
    let chunkDecisions = firstAttempt.decisions;
    let failureReasonBySpanId = firstAttempt.failureReasonBySpanId;
    let chunkLastError = firstAttempt.requestError;
    let attempts = 1;
    if (firstAttempt.needsRetry) {
      retryCount += 1;
      input.warnings.push(`materialization review chunk ${chunkIndex + 1}/${chunks.length}: retrying because LM returned missing, invalid, or story-missing rows`);
      const secondAttempt = await requestMaterializationReviewForChunk({
        agentRunner: input.agentRunner,
        chunk: activeChunk,
        items: activeChunk.map(span => buildMaterializationReviewItem(span)),
        chunkIndex,
        chunkTotal: chunks.length,
        attempt: 2,
        warnings: input.warnings,
      });
      repairCount += secondAttempt.repairCount;
      chunkDecisions = mergeDecisionMaps(firstAttempt.decisions, secondAttempt.decisions);
      failureReasonBySpanId = mergeFailureReasonMaps(firstAttempt.failureReasonBySpanId, secondAttempt.failureReasonBySpanId);
      chunkLastError = secondAttempt.requestError ?? firstAttempt.requestError;
      attempts = 2;
    }

    for (const span of activeChunk) {
      const decision = chunkDecisions.get(span.id);
      if (decision) {
        decisionBySpanId.set(span.id, decision);
        continue;
      }
      failedBySpanId.set(span.id, {
        spanId: span.id,
        assetId: span.assetId,
        chunkIndex: chunkIndex + 1,
        reason: failureReasonBySpanId.get(span.id) ?? 'missing-or-invalid-materialPatterns',
        attempts,
        lastError: chunkLastError,
        recovered: false,
      });
    }

    await writeSpanRebuildPatternCheckpoint({
      partialPath: input.partialPath,
      status: 'running',
      inputsHash: input.inputsHash,
      spanCount: input.spans.length,
      spans: input.spans,
      decisionBySpanId,
      failedBySpanId,
      baseWarnings: input.baseWarnings,
      warnings: input.warnings,
      activeSpanIds: activeChunk.map(item => item.id),
      retryCount,
      repairCount,
      recoveredFailedCount,
      storyUnknownFallbackCount,
    });
    await writeSpanRebuildProgress(input.progressPath, {
      status: 'running',
      step: 'patterns',
      stepLabel: '审查口播并生成素材模式',
      stepIndex: 2,
      stepTotal: 4,
      current: decisionBySpanId.size,
      total: input.spans.length,
      unit: 'span',
      etaSeconds: estimateSpanRebuildEtaSeconds(patternStartedAtMs, decisionBySpanId.size, input.spans.length),
      fileIndex: chunkIndex + 1,
      fileTotal: chunks.length,
      detail: `已审查 ${decisionBySpanId.size}/${input.spans.length} 个 span，失败列表 ${activeFailedSpanCount(failedBySpanId)} 个`,
      extra: {
        retryCount,
        repairCount,
        warningCount: input.warnings.length,
        failedCount: activeFailedSpanCount(failedBySpanId),
        recoveredFailedCount,
        storyUnknownFallbackCount,
      },
    });
  }

  const spanById = new Map(input.spans.map(span => [span.id, span] as const));
  const activeFailures = Array.from(failedBySpanId.values())
    .filter(isActiveFailedSpan);
  for (let index = 0; index < activeFailures.length; index += 1) {
    const failure = activeFailures[index]!;
    const span = spanById.get(failure.spanId);
    if (!span) continue;
    await writeSpanRebuildProgress(input.progressPath, {
      status: 'running',
      step: 'pattern-failures',
      stepLabel: '补处理失败列表',
      stepIndex: 3,
      stepTotal: 4,
      current: decisionBySpanId.size,
      total: input.spans.length,
      unit: 'span',
      etaSeconds: estimateSpanRebuildEtaSeconds(patternStartedAtMs, decisionBySpanId.size, input.spans.length),
      fileIndex: index + 1,
      fileTotal: activeFailures.length,
      detail: `正在补处理失败列表 ${index + 1}/${activeFailures.length}：${span.id}`,
      extra: {
        retryCount,
        repairCount,
        warningCount: input.warnings.length,
        failedCount: activeFailedSpanCount(failedBySpanId),
        recoveredFailedCount,
        storyUnknownFallbackCount,
      },
    });

    retryCount += 1;
    const retryResult = await requestMaterializationReviewForChunk({
      agentRunner: input.agentRunner,
      chunk: [span],
      items: [buildMaterializationReviewItem(span)],
      chunkIndex: Math.max(0, (failure.chunkIndex ?? 1) - 1),
      chunkTotal: chunks.length,
      attempt: failure.attempts + 1,
      warnings: input.warnings,
    });
    repairCount += retryResult.repairCount;
    const retriedDecision = retryResult.decisions.get(span.id);
    if (retriedDecision) {
      decisionBySpanId.set(span.id, retriedDecision);
      recoveredFailedCount += failure.recovered ? 0 : 1;
      failedBySpanId.set(span.id, {
        ...failure,
        attempts: failure.attempts + 1,
        reason: 'recovered-by-single-span-retry',
        lastError: retryResult.requestError ?? failure.lastError,
        recovered: true,
      });
    } else {
      failedBySpanId.set(span.id, {
        ...failure,
        attempts: failure.attempts + 1,
        reason: retryResult.failureReasonBySpanId.get(span.id) ?? 'invalid-after-single-span-retry',
        lastError: retryResult.requestError ?? failure.lastError,
        recovered: false,
      });
      input.warnings.push(`materialization review span ${span.id}: failed-list retry still returned invalid row`);
    }

    await writeSpanRebuildPatternCheckpoint({
      partialPath: input.partialPath,
      status: 'running',
      inputsHash: input.inputsHash,
      spanCount: input.spans.length,
      spans: input.spans,
      decisionBySpanId,
      failedBySpanId,
      baseWarnings: input.baseWarnings,
      warnings: input.warnings,
      activeSpanIds: [span.id],
      retryCount,
      repairCount,
      recoveredFailedCount,
      storyUnknownFallbackCount,
    });
  }

  const unresolvedSpans = input.spans.filter(span => !decisionBySpanId.has(span.id));
  if (unresolvedSpans.length > 0) {
    for (const span of unresolvedSpans) {
      if (!failedBySpanId.has(span.id)) {
        failedBySpanId.set(span.id, {
          spanId: span.id,
          assetId: span.assetId,
          reason: 'missing-after-failed-list-pass',
          attempts: 0,
          recovered: false,
        });
      }
    }
    const preview = unresolvedSpans.slice(0, 8).map(span => span.id).join(', ');
    throw new Error(
      `span-rebuild could not generate valid materialization review for ${unresolvedSpans.length} span(s): ${preview}`,
    );
  }

  const decisions = input.spans
    .map(span => decisionBySpanId.get(span.id))
    .filter((decision): decision is ISpanMaterializationReviewDecision => decision != null);
  const spans = decisions
    .map(decision => decision.finalSpan)
    .filter((span): span is IKtepSlice => span != null);
  return {
    spans,
    checkpointSpans: buildPartialSpans(input.spans, decisionBySpanId),
    failedSpans: Array.from(failedBySpanId.values()),
    retryCount,
    repairCount,
    recoveredFailedCount,
    storyUnknownFallbackCount,
    droppedCount: decisions.filter(decision => decision.dropped).length,
    visualOnlyCount: decisions.filter(decision => decision.visualOnly).length,
    trimmedSpeechCount: decisions.filter(decision => decision.trimmedSpeech).length,
  };
}

async function requestMaterializationReviewForChunk(input: {
  agentRunner: IJsonPacketAgentRunner;
  chunk: IKtepSlice[];
  items: ISpanMaterialPatternItem[];
  chunkIndex: number;
  chunkTotal: number;
  attempt: number;
  warnings: string[];
}): Promise<IChunkMaterialPatternRequestResult> {
  const packet = buildMaterializationReviewPacket({
    items: input.items,
    chunkIndex: input.chunkIndex,
    chunkTotal: input.chunkTotal,
    attempt: input.attempt,
  });
  let raw: unknown;
  try {
    raw = await input.agentRunner.run<unknown>({
      promptId: 'media/span-materialization-review',
      packet,
      llm: {
        jsonMode: true,
        temperature: 0.1,
        maxTokens: CMATERIAL_PATTERN_MAX_TOKENS,
      },
    });
  } catch (error) {
    const requestError = error instanceof Error ? error.message : String(error);
    input.warnings.push(
      `materialization review chunk ${input.chunkIndex + 1}/${input.chunkTotal}: LM request failed on attempt ${input.attempt}: ${requestError}`,
    );
    return {
      decisions: new Map(),
      needsRetry: true,
      repairCount: 0,
      failureReasonBySpanId: new Map(input.chunk.map(span => [span.id, 'request-failed'] as const)),
      requestError,
    };
  }

  const rows = normalizeReturnedMaterializationReviewRows({
    raw,
    expectedCount: input.chunk.length,
    chunkIndex: input.chunkIndex,
    chunkTotal: input.chunkTotal,
    warnings: input.warnings,
  });
  const decisions = new Map<string, ISpanMaterializationReviewDecision>();
  const failureReasonBySpanId = new Map<string, string>();
  let repairCount = 0;
  let invalidRowCount = 0;

  if (rows.length > 0) {
    input.chunk.forEach((span, index) => {
      if (index >= rows.length) {
        failureReasonBySpanId.set(span.id, 'missing-row');
        return;
      }
      const decision = applyMaterializationReviewRow(rows[index], span);
      if (!decision.complete) {
        invalidRowCount += 1;
        failureReasonBySpanId.set(span.id, decision.reason);
        return;
      }
      if (decision.repaired) {
        repairCount += 1;
      }
      decisions.set(span.id, decision.decision);
    });
  }

  if (repairCount > 0) {
    input.warnings.push(
      `materialization review chunk ${input.chunkIndex + 1}/${input.chunkTotal}: repaired ${repairCount} materialPatterns rows for the deterministic first-four slots`,
    );
  }

  if (rows.length === 0) {
    input.warnings.push(`materialization review chunk ${input.chunkIndex + 1}/${input.chunkTotal}: LM response did not contain ordered rows`);
    for (const span of input.chunk) {
      failureReasonBySpanId.set(span.id, 'missing-response-rows');
    }
  }
  if (invalidRowCount > 0) {
    input.warnings.push(
      `materialization review chunk ${input.chunkIndex + 1}/${input.chunkTotal}: LM returned ${invalidRowCount} invalid rows`,
    );
  }

  const needsRetry = rows.length === 0 || rows.length < input.chunk.length || invalidRowCount > 0;
  return { decisions, needsRetry, repairCount, failureReasonBySpanId };
}

function normalizeReturnedMaterializationReviewRows(input: {
  raw: unknown;
  expectedCount: number;
  chunkIndex: number;
  chunkTotal: number;
  warnings: string[];
}): unknown[] {
  const rowValue = resolveReturnedRows(input.raw);
  if (!Array.isArray(rowValue)) {
    input.warnings.push(`materialization review chunk ${input.chunkIndex + 1}/${input.chunkTotal}: LM response is not a JSON array`);
    return [];
  }

  const rows = input.expectedCount === 1 && rowValue.length > 0 && rowValue.every(item => typeof item === 'string')
    ? [rowValue]
    : rowValue;
  if (rows.length < input.expectedCount) {
    input.warnings.push(`materialization review chunk ${input.chunkIndex + 1}/${input.chunkTotal}: LM returned ${rows.length}/${input.expectedCount} rows`);
  }
  if (rows.length > input.expectedCount) {
    input.warnings.push(`materialization review chunk ${input.chunkIndex + 1}/${input.chunkTotal}: ignored ${rows.length - input.expectedCount} extra rows`);
  }
  return rows.slice(0, input.expectedCount);
}

function resolveReturnedRows(raw: unknown): unknown {
  if (Array.isArray(raw)) return raw;
  if (!isRecord(raw)) return raw;
  if (Array.isArray(raw.items)) {
    return raw.items.map(item => {
      if (Array.isArray(item)) return item;
      if (isRecord(item) && ('keepSegmentIndexes' in item || 'keepVisualOnly' in item)) return item;
      if (isRecord(item) && Array.isArray(item.materialPatterns)) return item.materialPatterns;
      if (isRecord(item) && Array.isArray(item.patterns)) return item.patterns;
      return item;
    });
  }
  if (Array.isArray(raw.materialPatterns)) return raw.materialPatterns;
  if (Array.isArray(raw.patterns)) return raw.patterns;
  if (Array.isArray(raw.rows)) return raw.rows;
  return raw;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value != null && !Array.isArray(value);
}

function buildMaterializationReviewPacket(input: {
  items: ISpanMaterialPatternItem[];
  chunkIndex: number;
  chunkTotal: number;
  attempt: number;
}): IAgentPacket {
  return {
    stage: 'media/span-materialization-review',
    identity: 'span-materialization-review',
    mission: '审查每个候选 span 的可用口播，决定保留/转视觉/drop，并为最终 span 生成中文 materialPatterns。',
    hardConstraints: buildSpanMaterializationReviewHardConstraints(),
    allowedInputs: ['type', 'semanticKind', 'transcript', 'transcriptSegments', 'visualObservation'],
    inputArtifacts: [{
      label: 'span-materialization-review-items',
      content: {
        promptVersion: CMATERIAL_PATTERN_PROMPT_VERSION,
        chunkIndex: input.chunkIndex + 1,
        chunkTotal: input.chunkTotal,
        attempt: input.attempt,
        items: input.items,
      },
    }],
    outputSchema: buildSpanMaterializationReviewOutputSchema(),
    reviewRubric: buildSpanMaterializationReviewHardConstraints(),
  };
}

function buildMaterializationReviewItem(span: IKtepSlice): ISpanMaterialPatternItem {
  return stripUndefined({
    type: span.type,
    semanticKind: span.semanticKind,
    transcript: truncateTranscript(span.transcript),
    transcriptSegments: buildMaterializationReviewTranscriptSegments(span),
    visualObservation: truncateText(normalizeText(span.visualObservation), CMATERIAL_PATTERN_TEXT_LIMIT),
  });
}

function buildMaterializationReviewTranscriptSegments(span: IKtepSlice): ISpanMaterializationReviewTranscriptSegment[] | undefined {
  const segments = buildReviewSourceSegments(span)
    .map(segment => ({
      index: segment.index,
      startMs: segment.startMs,
      endMs: segment.endMs,
      text: truncateText(segment.text, CMATERIAL_PATTERN_TRANSCRIPT_LIMIT) ?? segment.text,
    }));
  return segments.length > 0 ? segments : undefined;
}

function applyMaterializationReviewRow(
  row: unknown,
  span: IKtepSlice,
): {
  complete: true;
  decision: ISpanMaterializationReviewDecision;
  repaired: boolean;
} | {
  complete: false;
  reason: string;
  repaired: false;
} {
  if (!isRecord(row)) {
    return { complete: false, reason: 'review-row-not-object', repaired: false };
  }
  const keepSegmentIndexes = normalizeKeepSegmentIndexes(row.keepSegmentIndexes);
  if (!keepSegmentIndexes) {
    return { complete: false, reason: 'invalid-keepSegmentIndexes', repaired: false };
  }
  const keepVisualOnly = row.keepVisualOnly === true;

  if (keepSegmentIndexes.length === 0 && !keepVisualOnly) {
    return {
      complete: true,
      decision: {
        sourceSpanId: span.id,
        dropped: true,
        visualOnly: false,
        trimmedSpeech: false,
      },
      repaired: false,
    };
  }

  const finalSpan = keepSegmentIndexes.length > 0
    ? buildSpeechReviewedSpan(span, keepSegmentIndexes)
    : buildVisualOnlyReviewedSpan(span);

  if (!finalSpan) {
    if (keepVisualOnly && keepSegmentIndexes.length === 0) {
      return {
        complete: true,
        decision: {
          sourceSpanId: span.id,
          dropped: true,
          visualOnly: false,
          trimmedSpeech: false,
        },
        repaired: false,
      };
    }
    return { complete: false, reason: 'invalid-or-unsupported-review-decision', repaired: false };
  }

  const repaired = sanitizeReturnedMaterialPatterns(row.materialPatterns, finalSpan);
  if (!repaired.complete || repaired.patterns.length === 0) {
    return { complete: false, reason: 'missing-or-invalid-first-four/story', repaired: false };
  }

  return {
    complete: true,
    decision: {
      sourceSpanId: span.id,
      finalSpan: stripUndefined({
        ...finalSpan,
        materialPatterns: repaired.patterns,
      }) as unknown as IKtepSlice,
      dropped: false,
      visualOnly: finalSpan.semanticKind === 'visual' && !spanHasSpeechTruth(finalSpan),
      trimmedSpeech: hasSpeechRangeChanged(span, finalSpan),
    },
    repaired: repaired.repaired,
  };
}

function normalizeKeepSegmentIndexes(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  const indexes: number[] = [];
  const seen = new Set<number>();
  for (const item of value) {
    if (typeof item !== 'number' || !Number.isInteger(item) || item <= 0) {
      return null;
    }
    if (!seen.has(item)) {
      seen.add(item);
      indexes.push(item);
    }
  }
  return indexes.sort((left, right) => left - right);
}

interface IReviewSourceSegment extends ITranscriptSegment {
  index: number;
  synthetic: boolean;
}

function buildReviewSourceSegments(span: IKtepSlice): IReviewSourceSegment[] {
  const sourceSegments = (span.transcriptSegments ?? [])
    .filter(segment => segment.text.trim().length > 0 && segment.endMs > segment.startMs)
    .map((segment, index) => ({
      index: index + 1,
      startMs: segment.startMs,
      endMs: segment.endMs,
      text: segment.text.trim(),
      synthetic: false,
    }));
  if (sourceSegments.length > 0) return sourceSegments;

  const transcript = normalizeText(span.transcript);
  if (
    transcript
    && isFiniteNumber(span.sourceInMs)
    && isFiniteNumber(span.sourceOutMs)
    && (span.sourceOutMs as number) > (span.sourceInMs as number)
  ) {
    return [{
      index: 1,
      startMs: span.sourceInMs as number,
      endMs: span.sourceOutMs as number,
      text: transcript,
      synthetic: true,
    }];
  }
  return [];
}

function buildSpeechReviewedSpan(span: IKtepSlice, keepSegmentIndexes: number[]): IKtepSlice | null {
  const sourceSegments = buildReviewSourceSegments(span);
  const segmentByIndex = new Map(sourceSegments.map(segment => [segment.index, segment] as const));
  const selected = keepSegmentIndexes.map(index => segmentByIndex.get(index));
  if (selected.some(segment => segment == null)) return null;
  const kept = selected.filter((segment): segment is IReviewSourceSegment => segment != null);
  if (kept.length === 0) return null;

  const sourceInMs = Math.min(...kept.map(segment => segment.startMs));
  const sourceOutMs = Math.max(...kept.map(segment => segment.endMs));
  if (!isFiniteNumber(sourceInMs) || !isFiniteNumber(sourceOutMs) || sourceOutMs <= sourceInMs) return null;

  const actualSegments = kept.filter(segment => !segment.synthetic);
  const transcriptSegments = actualSegments.map(segment => ({
    startMs: segment.startMs,
    endMs: segment.endMs,
    text: segment.text,
  }));
  const transcript = kept.map(segment => segment.text).join(' ').trim();
  const speechCoverage = transcriptSegments.length > 0
    ? computeSpeechCoverage(sourceInMs, sourceOutMs, transcriptSegments)
    : span.speechCoverage;

  return stripUndefined({
    ...span,
    semanticKind: span.semanticKind === 'mixed' ? 'mixed' : 'speech',
    sourceInMs,
    sourceOutMs,
    editSourceInMs: sourceInMs,
    editSourceOutMs: sourceOutMs,
    transcript: transcript || undefined,
    transcriptSegments: transcriptSegments.length > 0 ? transcriptSegments : undefined,
    speechCoverage,
  }) as unknown as IKtepSlice;
}

function buildVisualOnlyReviewedSpan(span: IKtepSlice): IKtepSlice | null {
  if (!hasIndependentVisualObservation(span.visualObservation)) return null;
  const reviewed = {
    ...span,
    semanticKind: 'visual' as const,
    transcript: undefined,
    transcriptSegments: undefined,
    speechCoverage: undefined,
  };
  return stripUndefined(reviewed) as unknown as IKtepSlice;
}

function hasIndependentVisualObservation(value: string | undefined): boolean {
  const normalized = normalizeText(value);
  if (!normalized) return false;
  const withoutSpeechOnlyPhrases = normalized
    .replace(/人物对镜头说话|有人说话|口播画面|口播镜头|说话画面|车内自拍口播|手持自拍口播|固定机位口播/giu, '')
    .replace(/talking[-\s]?head|speaking to camera|person speaking|someone speaking/giu, '')
    .trim();
  return normalizeComparableText(withoutSpeechOnlyPhrases).length >= 4;
}

function hasSpeechRangeChanged(before: IKtepSlice, after: IKtepSlice): boolean {
  if (!spanHasSpeechTruth(after)) return false;
  return before.sourceInMs !== after.sourceInMs
    || before.sourceOutMs !== after.sourceOutMs
    || (before.transcriptSegments?.length ?? 0) !== (after.transcriptSegments?.length ?? 0)
    || normalizeText(before.transcript) !== normalizeText(after.transcript);
}

function sanitizeReturnedMaterialPatterns(
  value: unknown,
  span: IKtepSlice,
  options: { allowStoryUnknownFallback?: boolean } = {},
): { patterns: string[]; repaired: boolean; complete: boolean } {
  if (!Array.isArray(value)) {
    return { patterns: [], repaired: false, complete: false };
  }
  const raw = value
    .filter((item): item is string => typeof item === 'string')
    .map(item => item.trim())
    .filter(Boolean);
  return repairMaterialPatterns(raw, span, options);
}

function repairMaterialPatterns(
  raw: string[],
  span: IKtepSlice,
  options: { allowStoryUnknownFallback?: boolean } = {},
): { patterns: string[]; repaired: boolean; complete: boolean } {
  if (raw.length < CMATERIAL_PATTERN_REQUIRED_COUNT || raw.length > CMATERIAL_PATTERN_MAX_COUNT) {
    return { patterns: [], repaired: false, complete: false };
  }
  const cleaned = raw
    .map(normalizePatternCandidate)
    .filter((item): item is string => typeof item === 'string');
  if (cleaned.length !== raw.length) {
    return { patterns: [], repaired: false, complete: false };
  }

  const viewpoint = normalizeViewpointTag(cleaned[0], span);
  const environment = normalizeEnvironmentTag(cleaned[1]);
  const weatherLight = normalizeWeatherLightTag(cleaned[2]);
  const speech = normalizeSpeechTag(cleaned[3], resolveSpeechTag(span));
  if (!viewpoint || !environment || !weatherLight || !speech) {
    return { patterns: [], repaired: false, complete: false };
  }
  const normalizedStory = normalizeStoryTag(cleaned[4], [viewpoint, environment, weatherLight, speech]);
  const story = normalizedStory ?? (options.allowStoryUnknownFallback ? CSPAN_MATERIAL_PATTERN_STORY_UNKNOWN : undefined);
  const required = [viewpoint, environment, weatherLight, speech];
  const freeCandidates = cleaned.slice(5);
  if (freeCandidates.some(item => required.includes(item) || item === story || !isValidFreeMaterialPattern(item))) {
    return { patterns: [], repaired: false, complete: false };
  }
  const freeTags = freeCandidates
    .slice(0, Math.max(0, CMATERIAL_PATTERN_MAX_COUNT - CMATERIAL_PATTERN_REQUIRED_COUNT));
  const patterns = [...required, ...(story ? [story] : []), ...freeTags].slice(0, CMATERIAL_PATTERN_MAX_COUNT);
  const complete = Boolean(story);

  return {
    patterns,
    repaired: false,
    complete,
  };
}

function normalizeViewpointTag(
  value: string | undefined,
  span: IKtepSlice,
): string | undefined {
  if (
    value
    && CMATERIAL_PATTERN_VIEWPOINT_TAG_SET.has(value)
    && isViewpointTagCompatibleWithSpan(value, span)
  ) {
    return value;
  }
  return undefined;
}

function isViewpointTagCompatibleWithSpan(tag: string, span: IKtepSlice): boolean {
  const text = spanFactText(span);
  const hasAerialEvidence = /航拍|无人机|俯瞰|鸟瞰|空中|aerial|drone|overhead|bird'?s[-\s]?eye/iu.test(text);
  const hasAerialMotionEvidence = /跟随|追踪|环绕|推进|掠过|移动|follow|tracking|orbit|moving|passes?|flies?\s+over|sweeping/iu.test(text);
  const hasDetailEvidence = /特写|细节|近景|close[-\s]?up|macro|detail|resting|停驻|触摸|手部|手表|腕表|车漆特写|车身线条|蝴蝶|butterfly|wrist|watch|hand gently|glossy yellow|yellow (?:car )?surface|paint and body|body lines|speaker grille|water droplets/iu.test(text);
  const hasDrivingPovEvidence = /第一视角|驾驶视角|行车记录|车窗|挡风玻璃|车内向前|windshield|dashcam|driving\s+pov|view from (?:inside )?(?:a|the)?\s*(?:car|vehicle)/iu.test(text);
  const hasWideEnvironmentEvidence = /远景|全景|广角|风景|环境|山谷|山地|森林|村庄|街道|公路|道路|河流|湖泊|建筑|wide shot|wide-angle|panoramic|landscape|scenery|valley|village|street|highway|river|lake|building/iu.test(text);

  if (tag === '第一人称行车') {
    if (hasAerialEvidence || hasDetailEvidence) return false;
    return span.type === 'drive' || hasDrivingPovEvidence;
  }
  if (tag === '车窗外观察') {
    return span.type === 'drive' || /车窗|窗外|挡风玻璃|windshield|vehicle window/iu.test(text);
  }
  if (tag === '航拍俯瞰') {
    return span.type === 'aerial' || hasAerialEvidence;
  }
  if (tag === '航拍运动') {
    return (span.type === 'aerial' || hasAerialEvidence) && hasAerialMotionEvidence;
  }
  if (tag === '细节特写') {
    return hasDetailEvidence;
  }
  if (tag === '环境远景') {
    return hasWideEnvironmentEvidence;
  }
  return true;
}

function normalizeEnvironmentTag(value: string | undefined): string | undefined {
  const candidate = normalizePatternCandidate(value);
  if (
    candidate
    && !CMATERIAL_PATTERN_VIEWPOINT_TAG_SET.has(candidate)
    && !CMATERIAL_PATTERN_SPEECH_TAG_SET.has(candidate)
    && !looksLikeWeatherLightTag(candidate)
    && !looksLikeCompositeEnvironmentTag(candidate)
    && !containsTechnicalWeatherTerm(candidate)
    && !looksLikeSourceSentence(candidate)
  ) {
    return candidate;
  }
  return undefined;
}

function normalizeWeatherLightTag(value: string | undefined): string | undefined {
  const candidate = normalizePatternCandidate(value);
  if (
    candidate
    && candidate !== CSPAN_MATERIAL_PATTERN_ENVIRONMENT_UNKNOWN
    && !CMATERIAL_PATTERN_VIEWPOINT_TAG_SET.has(candidate)
    && !CMATERIAL_PATTERN_SPEECH_TAG_SET.has(candidate)
    && !containsTechnicalWeatherTerm(candidate)
    && (candidate === CSPAN_MATERIAL_PATTERN_WEATHER_UNKNOWN || looksLikeWeatherLightTag(candidate))
    && !looksLikeSourceSentence(candidate)
  ) {
    return candidate;
  }
  return undefined;
}

function normalizeSpeechTag(value: string | undefined, expected: string): string | undefined {
  const candidate = normalizePatternCandidate(value);
  if (!candidate) return undefined;
  if (!CMATERIAL_PATTERN_SPEECH_TAG_SET.has(candidate)) return undefined;
  return candidate === expected ? candidate : undefined;
}

function normalizeStoryTag(value: string | undefined, requiredTags: string[]): string | undefined {
  const candidate = normalizePatternCandidate(value);
  if (!candidate) return undefined;
  if (candidate === CSPAN_MATERIAL_PATTERN_STORY_UNKNOWN) return candidate;
  if (requiredTags.includes(candidate)) return undefined;
  if (CMATERIAL_PATTERN_VIEWPOINT_TAG_SET.has(candidate)) return undefined;
  if (CMATERIAL_PATTERN_SPEECH_TAG_SET.has(candidate)) return undefined;
  if (candidate === CSPAN_MATERIAL_PATTERN_ENVIRONMENT_UNKNOWN) return undefined;
  if (candidate === CSPAN_MATERIAL_PATTERN_WEATHER_UNKNOWN) return undefined;
  if (containsTechnicalWeatherTerm(candidate)) return undefined;
  if (looksLikeSourceSentence(candidate)) return undefined;
  return sanitizeMaterialPatterns([candidate]).length > 0 ? candidate : undefined;
}

function resolveSpeechTag(span: IKtepSlice): string {
  if (span.transcript?.trim()) return CSPAN_MATERIAL_PATTERN_SPEECH_PRESENT;
  if ((span.transcriptSegments ?? []).some(segment => segment.text.trim().length > 0)) {
    return CSPAN_MATERIAL_PATTERN_SPEECH_PRESENT;
  }
  if (span.semanticKind === 'speech' || span.semanticKind === 'mixed') {
    return CSPAN_MATERIAL_PATTERN_SPEECH_PRESENT;
  }
  return CSPAN_MATERIAL_PATTERN_SPEECH_ABSENT;
}


function normalizePatternCandidate(value: string | undefined): string | undefined {
  const trimmed = value?.trim().replace(/^["'“”‘’]+|["'“”‘’]+$/gu, '');
  if (!trimmed) return undefined;
  if (normalizeComparableText(trimmed).length > 48) return undefined;
  return trimmed;
}

function isValidFreeMaterialPattern(value: string): boolean {
  if (!value.trim()) return false;
  if (CMATERIAL_PATTERN_VIEWPOINT_TAG_SET.has(value)) return false;
  if (CMATERIAL_PATTERN_SPEECH_TAG_SET.has(value)) return false;
  if (value === CSPAN_MATERIAL_PATTERN_ENVIRONMENT_UNKNOWN) return false;
  if (value === CSPAN_MATERIAL_PATTERN_WEATHER_UNKNOWN) return false;
  if (containsTechnicalWeatherTerm(value)) return false;
  if (looksLikeSourceSentence(value)) return false;
  return sanitizeMaterialPatterns([value]).length > 0;
}

function looksLikeWeatherLightTag(value: string): boolean {
  return /晴天|晴朗|雨天|下雨|小雨|大雨|暴雨|雪天|下雪|飘雪|降雪|阴天|多云|云层|雾天|大雾|薄雾|晚霞|夕阳|日落|日出|夜晚|夜间|丁达尔|阳光|蓝天|灯光|sunny|sunlight|rain(?:ing)?|snow(?:ing|fall)?|overcast|cloudy|fog(?:gy)?|mist(?:y)?|night|light|tyndall/iu.test(value);
}

function looksLikeCompositeEnvironmentTag(value: string): boolean {
  return /行车|口播|自拍|航拍|照片|语音|素材|画面/iu.test(value);
}

function containsTechnicalWeatherTerm(value: string): boolean {
  return CSPAN_MATERIAL_PATTERN_TECHNICAL_WEATHER_TERMS.some(term => value.includes(term));
}

function spanFactText(span: IKtepSlice): string {
  return [
    span.type,
    span.semanticKind,
    span.transcript,
    span.visualObservation,
  ].filter(Boolean).join(' ');
}

function mergeDecisionMaps(
  first: Map<string, ISpanMaterializationReviewDecision>,
  second: Map<string, ISpanMaterializationReviewDecision>,
): Map<string, ISpanMaterializationReviewDecision> {
  const merged = new Map(first);
  for (const [id, decision] of second) {
    merged.set(id, decision);
  }
  return merged;
}

function mergeFailureReasonMaps(
  first: Map<string, string>,
  second: Map<string, string>,
): Map<string, string> {
  const merged = new Map(first);
  for (const [id, reason] of second) {
    merged.set(id, reason);
  }
  return merged;
}

function isActiveFailedSpan(value: ISpanRebuildFailedSpan | undefined): value is ISpanRebuildFailedSpan {
  return Boolean(value && !value.recovered);
}

function activeFailedSpanCount(failedBySpanId: Map<string, ISpanRebuildFailedSpan>): number {
  return Array.from(failedBySpanId.values()).filter(isActiveFailedSpan).length;
}

async function writeSpanRebuildPatternCheckpoint(input: {
  partialPath?: string;
  status: ISpanRebuildPartialCheckpoint['status'];
  inputsHash: string;
  spanCount: number;
  spans: IKtepSlice[];
  decisionBySpanId: Map<string, ISpanMaterializationReviewDecision>;
  failedBySpanId: Map<string, ISpanRebuildFailedSpan>;
  baseWarnings: string[];
  warnings: string[];
  activeSpanIds?: string[];
  retryCount: number;
  repairCount: number;
  recoveredFailedCount: number;
  storyUnknownFallbackCount: number;
  lastError?: string;
}): Promise<void> {
  const failedSpans = Array.from(input.failedBySpanId.values());
  await writeSpanRebuildPartial(input.partialPath, {
    status: input.status,
    promptVersion: CMATERIAL_PATTERN_PROMPT_VERSION,
    inputsHash: input.inputsHash,
    spanCount: input.spanCount,
    chunkSize: CMATERIAL_PATTERN_SPAN_BATCH_SIZE,
    completedCount: input.decisionBySpanId.size,
    spans: buildPartialSpans(input.spans, input.decisionBySpanId),
    warnings: dedupeStrings([...input.baseWarnings, ...input.warnings]),
    activeSpanIds: input.activeSpanIds,
    failedSpans,
    failedCount: failedSpans.length,
    recoveredFailedCount: input.recoveredFailedCount,
    storyUnknownFallbackCount: input.storyUnknownFallbackCount,
    retryCount: input.retryCount,
    repairCount: input.repairCount,
    lastError: input.lastError,
  });
}

function buildPartialSpans(
  spans: IKtepSlice[],
  decisionBySpanId: Map<string, ISpanMaterializationReviewDecision>,
): Array<IKtepSlice & { sourceSpanId?: string; dropped?: boolean }> {
  return spans
    .map(span => decisionBySpanId.get(span.id))
    .filter((decision): decision is ISpanMaterializationReviewDecision => decision != null)
    .map(decision => stripUndefined({
      ...(decision.finalSpan ?? {}),
      sourceSpanId: decision.sourceSpanId,
      dropped: decision.dropped || undefined,
    }) as IKtepSlice & { sourceSpanId?: string; dropped?: boolean });
}

async function loadReusableSpanRebuildPartial(input: {
  partialPath?: string;
  spans: IKtepSlice[];
  inputsHash: string;
}): Promise<{
  decisions: Map<string, ISpanMaterializationReviewDecision>;
  failedSpans: ISpanRebuildFailedSpan[];
  warnings: string[];
  retryCount: number;
  repairCount: number;
  recoveredFailedCount: number;
  storyUnknownFallbackCount: number;
} | null> {
  if (!input.partialPath) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(input.partialPath, 'utf-8')) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(raw)) return null;
  if (raw.inputsHash !== input.inputsHash) return null;
  if (raw.promptVersion !== CMATERIAL_PATTERN_PROMPT_VERSION) return null;
  if (typeof raw.spanCount === 'number' && raw.spanCount !== input.spans.length) return null;

  const spanById = new Map(input.spans.map(span => [span.id, span] as const));
  const decisions = new Map<string, ISpanMaterializationReviewDecision>();
  const checkpointSpans = Array.isArray(raw.spans) ? raw.spans : [];
  for (const item of checkpointSpans) {
    if (!isRecord(item)) continue;
    const sourceSpanId = typeof item.sourceSpanId === 'string'
      ? item.sourceSpanId
      : typeof item.id === 'string'
        ? item.id
        : undefined;
    if (!sourceSpanId || !spanById.has(sourceSpanId)) continue;
    if (item.dropped === true) {
      decisions.set(sourceSpanId, {
        sourceSpanId,
        dropped: true,
        visualOnly: false,
        trimmedSpeech: false,
      });
      continue;
    }
    if (typeof item.id !== 'string') continue;
    const candidateSpan = { ...item };
    delete candidateSpan.sourceSpanId;
    delete candidateSpan.dropped;
    const parsed = IKtepSliceSchema.safeParse(candidateSpan);
    if (!parsed.success) continue;
    const checkpointSpan = stripUndefined({
      ...parsed.data,
      grounding: undefined,
      pharosRefs: undefined,
      speedCandidate: undefined,
    }) as unknown as IKtepSlice;
    const repaired = sanitizeReturnedMaterialPatterns(checkpointSpan.materialPatterns, checkpointSpan);
    if (repaired.complete && repaired.patterns.length > 0) {
      decisions.set(sourceSpanId, {
        sourceSpanId,
        finalSpan: stripUndefined({
          ...checkpointSpan,
          materialPatterns: repaired.patterns,
        }) as unknown as IKtepSlice,
        dropped: false,
        visualOnly: checkpointSpan.semanticKind === 'visual' && !spanHasSpeechTruth(checkpointSpan),
        trimmedSpeech: hasSpeechRangeChanged(spanById.get(sourceSpanId)!, checkpointSpan),
      });
    }
  }

  const failedSpans = (Array.isArray(raw.failedSpans) ? raw.failedSpans : [])
    .map(item => normalizeCheckpointFailedSpan(item, decisions))
    .filter((item): item is ISpanRebuildFailedSpan => item != null && spanById.has(item.spanId));
  const warnings = (Array.isArray(raw.warnings) ? raw.warnings : [])
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0);

  return {
    decisions,
    failedSpans,
    warnings,
    retryCount: getNonNegativeInteger(raw.retryCount),
    repairCount: getNonNegativeInteger(raw.repairCount),
    recoveredFailedCount: failedSpans.filter(item => item.recovered).length,
    storyUnknownFallbackCount: failedSpans.filter(item => item.fallbackStoryUnknown).length,
  };
}

function normalizeCheckpointFailedSpan(
  value: unknown,
  decisions: Map<string, ISpanMaterializationReviewDecision>,
): ISpanRebuildFailedSpan | null {
  if (!isRecord(value) || typeof value.spanId !== 'string') return null;
  const recovered = value.recovered === true && decisions.has(value.spanId);
  return stripUndefined({
    spanId: value.spanId,
    assetId: typeof value.assetId === 'string' ? value.assetId : undefined,
    chunkIndex: getOptionalPositiveInteger(value.chunkIndex),
    reason: typeof value.reason === 'string' && value.reason.trim()
      ? value.reason.trim()
      : 'checkpoint-failed-span',
    attempts: getNonNegativeInteger(value.attempts),
    lastError: typeof value.lastError === 'string' ? value.lastError : undefined,
    recovered,
    fallbackStoryUnknown: recovered && value.fallbackStoryUnknown === true,
  }) as ISpanRebuildFailedSpan;
}

function getNonNegativeInteger(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : 0;
}

function getOptionalPositiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

function getSpanRebuildPartialPath(projectRoot: string): string {
  return join(projectRoot, '.tmp', 'chronology', 'span-rebuild.partial.json');
}

async function writeSpanRebuildPartial(
  path: string | undefined,
  checkpoint: Omit<ISpanRebuildPartialCheckpoint, 'schemaVersion' | 'updatedAt'>,
): Promise<void> {
  if (!path) return;
  await writeJson(path, {
    schemaVersion: '1.0',
    updatedAt: new Date().toISOString(),
    ...checkpoint,
  } satisfies ISpanRebuildPartialCheckpoint);
}

function truncateTranscript(value: string | undefined): string | undefined {
  const normalized = normalizeText(value);
  if (!normalized) return undefined;
  return normalized.length > CMATERIAL_PATTERN_TRANSCRIPT_LIMIT
    ? normalized.slice(0, CMATERIAL_PATTERN_TRANSCRIPT_LIMIT)
    : normalized;
}

function truncateText(value: string | undefined, limit: number): string | undefined {
  const normalized = normalizeText(value);
  if (!normalized) return undefined;
  return normalized.length > limit ? normalized.slice(0, limit) : normalized;
}

function normalizeComparableText(value: string | undefined): string {
  return (value ?? '').replace(/\s+/gu, '').trim();
}

function looksLikeSourceSentence(value: string | undefined): boolean {
  const normalized = normalizeText(value);
  return Boolean(normalized && (normalized.length > 18 || /[。！？.!?]/u.test(normalized)));
}

function estimateSpanRebuildEtaSeconds(startedAtMs: number, current: number, total: number): number | undefined {
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(current) || !Number.isFinite(total)) return undefined;
  if (total <= 0) return undefined;
  if (current >= total) return 0;
  if (current <= 0) return undefined;
  const elapsedMs = Math.max(0, Date.now() - startedAtMs);
  if (elapsedMs < 500) return undefined;
  const averageMs = elapsedMs / current;
  return Math.max(1, Math.round((averageMs * (total - current)) / 1000));
}

async function writeSpanRebuildProgress(
  progressPath: string | undefined,
  progress: Omit<Parameters<typeof writeKairosProgress>[1], 'pipelineKey' | 'pipelineLabel' | 'phaseKey' | 'phaseLabel' | 'stepDefinitions'>,
): Promise<void> {
  if (!progressPath) return;
  await writeKairosProgress(progressPath, {
    pipelineKey: 'chronology',
    pipelineLabel: 'Chronology 生成链路',
    phaseKey: 'span-rebuild',
    phaseLabel: '生成素材片段与模式',
    stepDefinitions: [
      { key: 'slice', label: '生成素材片段' },
      { key: 'patterns', label: '审查口播并生成素材模式' },
      { key: 'pattern-failures', label: '补处理失败列表' },
      { key: 'write', label: '写入结果' },
    ],
    ...progress,
  });
}

function resolveMergedSpeechCoverage(
  sourceInMs: number | undefined,
  sourceOutMs: number | undefined,
  segments: ITranscriptSegment[],
  left: IKtepSlice,
  right: IKtepSlice,
): number | undefined {
  const computed = computeSpeechCoverage(sourceInMs, sourceOutMs, segments);
  if (computed != null) return computed;
  const fallback = Math.max(left.speechCoverage ?? 0, right.speechCoverage ?? 0);
  return fallback > 0 ? fallback : undefined;
}

function mergeTranscriptSegments(segments: ITranscriptSegment[]): ITranscriptSegment[] {
  const merged: ITranscriptSegment[] = [];
  const normalized = segments
    .map(segment => ({
      startMs: segment.startMs,
      endMs: segment.endMs,
      text: segment.text.trim(),
    }))
    .filter(segment => segment.endMs > segment.startMs && segment.text.length > 0)
    .sort((left, right) =>
      left.startMs - right.startMs || left.endMs - right.endMs || left.text.localeCompare(right.text),
    );

  for (const segment of normalized) {
    const previous = merged[merged.length - 1];
    if (previous && previous.text === segment.text && segment.startMs <= previous.endMs + 50) {
      previous.endMs = Math.max(previous.endMs, segment.endMs);
      continue;
    }
    merged.push(segment);
  }
  return merged;
}

function buildSpanInputsHash(input: {
  assets: IKtepAsset[];
  spans: IKtepSlice[];
}): string {
  return createHash('sha256')
    .update(stableStringify({
      materialPatternPromptVersion: CMATERIAL_PATTERN_PROMPT_VERSION,
      assets: input.assets.map(asset => ({
        id: asset.id,
        kind: asset.kind,
        durationMs: asset.durationMs,
      })).sort((left, right) => left.id.localeCompare(right.id)),
      spans: input.spans.map(span => ({
        id: span.id,
        assetId: span.assetId,
        type: span.type,
        semanticKind: span.semanticKind,
        sourceInMs: span.sourceInMs,
        sourceOutMs: span.sourceOutMs,
        editSourceInMs: span.editSourceInMs,
        editSourceOutMs: span.editSourceOutMs,
        transcript: span.transcript,
        transcriptSegments: span.transcriptSegments,
        visualObservation: span.visualObservation,
        speechCoverage: span.speechCoverage,
      })).sort((left, right) => left.id.localeCompare(right.id)),
    }))
    .digest('hex');
}

function assertUniqueSpanIds(spans: IKtepSlice[]): void {
  const seen = new Set<string>();
  for (const span of spans) {
    if (seen.has(span.id)) {
      throw new Error(`Duplicate material span id generated: ${span.id}`);
    }
    seen.add(span.id);
  }
}

function mapClipTypeToSpanType(asset: IKtepAsset, clipType: EClipType): IKtepSlice['type'] {
  if (asset.kind === 'photo') return 'photo';
  return clipType;
}

function clampToAsset(value: number, durationMs: number | undefined): number {
  const floor = Math.max(0, Math.round(value));
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs <= 0) return floor;
  return Math.min(floor, Math.round(durationMs));
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function normalizeText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function sortSpansByMaterialTime(
  spans: IKtepSlice[],
  assets: IKtepAsset[],
  _roots: IMediaRoot[],
): IKtepSlice[] {
  const assetsById = new Map(assets.map(asset => [asset.id, asset] as const));
  return [...spans].sort((left, right) => {
    const leftAsset = assetsById.get(left.assetId);
    const rightAsset = assetsById.get(right.assetId);
    const leftTime = getAssetMaterialSortMs(leftAsset);
    const rightTime = getAssetMaterialSortMs(rightAsset);
    return (leftTime ?? Number.POSITIVE_INFINITY) - (rightTime ?? Number.POSITIVE_INFINITY)
      || (left.sourceInMs ?? 0) - (right.sourceInMs ?? 0)
      || (left.sourceOutMs ?? 0) - (right.sourceOutMs ?? 0)
      || (leftAsset?.sourcePath ?? leftAsset?.displayName ?? left.assetId)
        .localeCompare(rightAsset?.sourcePath ?? rightAsset?.displayName ?? right.assetId)
      || left.id.localeCompare(right.id);
  });
}

function getAssetMaterialSortMs(
  asset: IKtepAsset | undefined,
): number | undefined {
  if (!asset) return undefined;
  const capturedAtMs = parseTimestampMs(asset.capturedAt);
  if (capturedAtMs != null) return capturedAtMs;
  return parseTimestampMs(asset.createdAt);
}

function parseTimestampMs(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

function compareSpanRanges(left: IKtepSlice, right: IKtepSlice): number {
  return left.assetId.localeCompare(right.assetId)
    || (left.sourceInMs ?? 0) - (right.sourceInMs ?? 0)
    || (left.sourceOutMs ?? 0) - (right.sourceOutMs ?? 0)
    || left.id.localeCompare(right.id);
}

function computeSpeechCoverage(
  sourceInMs: number | undefined,
  sourceOutMs: number | undefined,
  segments: ITranscriptSegment[],
): number | undefined {
  if (sourceInMs == null || sourceOutMs == null || sourceOutMs <= sourceInMs) return undefined;
  if (segments.length === 0) return undefined;
  const coveredMs = segments.reduce(
    (sum, segment) => sum + Math.max(0, segment.endMs - segment.startMs),
    0,
  );
  return Math.min(coveredMs / (sourceOutMs - sourceInMs), 1);
}

function pickDefinedMin(values: Array<number | undefined>): number | undefined {
  const defined = values.filter((value): value is number => typeof value === 'number');
  return defined.length > 0 ? Math.min(...defined) : undefined;
}

function pickDefinedMax(values: Array<number | undefined>): number | undefined {
  const defined = values.filter((value): value is number => typeof value === 'number');
  return defined.length > 0 ? Math.max(...defined) : undefined;
}

function dedupeStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === 'string' && value.trim().length > 0))];
}

function chunkArray<T>(values: T[], chunkSize: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += chunkSize) {
    chunks.push(values.slice(index, index + chunkSize));
  }
  return chunks;
}

function stripUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as T;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
    return Object.fromEntries(
      Object.entries(item as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)),
    );
  });
}
