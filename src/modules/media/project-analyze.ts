import { join } from 'node:path';
import { access } from 'node:fs/promises';
import type {
  EClipType,
  ETargetBudget,
  IAssetCoarseReport,
  IKtepAsset,
  IKtepEvidence,
  IKtepSlice,
  IMediaAnalysisPlan,
  IInterestingWindow,
  IMediaRoot,
  ITranscriptSegment,
} from '../../protocol/schema.js';
import {
    appendSlices,
    estimateRemainingSeconds,
    findUnreportedAssets,
  loadAssetReports,
  loadAssets,
  loadChronology,
  loadDeviceMediaMaps,
  loadIngestRoots,
  loadProject,
  loadRuntimeConfig,
  resolveWorkspaceProjectRoot,
  getProjectProgressPath,
  touchProjectUpdatedAt,
  writeKairosProgress,
  writeChronology,
  writeAssetReport,
} from '../../store/index.js';
import { buildAssetCoarseReport } from './asset-report.js';
import { buildMediaChronology } from './chronology.js';
import { estimateDensity } from './density.js';
import {
  uniformTimestamps,
  extractImageProxy,
  extractKeyframes,
  groupKeyframesByShot,
  sampleRangeTimestamps,
  type IShotKeyframePlan,
} from './keyframe.js';
import { MlClient } from './ml-client.js';
import { recognizeFrames, recognizeShotGroups } from './recognizer.js';
import { resolveAssetLocalPath } from './root-resolver.js';
import { buildAnalysisPlan, pickCoarseSampleCount } from './sampler.js';
import { computeRhythmStats, detectShots, type IShotBoundary } from './shot-detect.js';
import { sliceInterestingWindows, slicePhoto, sliceVideo } from './slicer.js';
import { transcribe } from './transcriber.js';

export interface IAnalyzeWorkspaceProjectInput {
  workspaceRoot: string;
  projectId: string;
  assetIds?: string[];
  deviceMapPath?: string;
  budget?: ETargetBudget;
  progressPath?: string;
}

export interface IAnalyzeWorkspaceProjectResult {
  projectRoot: string;
  analyzedAssetIds: string[];
  fineScannedAssetIds: string[];
  missingRoots: IMediaRoot[];
  reportCount: number;
  sliceCount: number;
  mlUsed: boolean;
}

const CANALYZE_STEP_DEFINITIONS = [
  { key: 'prepare', label: '准备素材分析' },
  { key: 'coarse-scan', label: '粗扫素材' },
  { key: 'audio-analysis', label: '分析视频内音轨' },
  { key: 'fine-scan', label: '自动细扫重点内容' },
  { key: 'chronology', label: '刷新时间视图' },
] as const;

export async function analyzeWorkspaceProjectMedia(
  input: IAnalyzeWorkspaceProjectInput,
): Promise<IAnalyzeWorkspaceProjectResult> {
  const projectRoot = resolveWorkspaceProjectRoot(input.workspaceRoot, input.projectId);
  const progressPath = input.progressPath ?? getProjectProgressPath(projectRoot, 'media-analyze');
  const startedAtMs = Date.now();
  const [{ roots }, deviceMaps, runtimeConfig, assets, existingReports, project] = await Promise.all([
    loadIngestRoots(projectRoot),
    loadDeviceMediaMaps(input.deviceMapPath),
    loadRuntimeConfig(projectRoot),
    loadAssets(projectRoot),
    loadAssetReports(projectRoot),
    loadProject(projectRoot),
  ]);

  const pendingAssets = selectPendingAssets(assets, existingReports, input.assetIds);
  const analyzedAssetIds: string[] = [];
  const fineScannedAssetIds: string[] = [];
  const pendingSlices: IKtepSlice[] = [];
  let mlHandle: MlAvailability | null = null;
  let mlUsed = false;

  await writeKairosProgress(progressPath, {
    status: 'running',
    pipelineKey: 'media-analyze',
    pipelineLabel: '素材分析流程',
    phaseKey: 'coarse-first-project-analysis',
    phaseLabel: '粗扫优先素材分析',
    step: 'prepare',
    stepLabel: '准备素材分析',
    stepIndex: 1,
    stepTotal: CANALYZE_STEP_DEFINITIONS.length,
    stepDefinitions: [...CANALYZE_STEP_DEFINITIONS],
    fileIndex: 0,
    fileTotal: pendingAssets.length,
    current: 0,
    total: pendingAssets.length,
    unit: 'files',
    detail: `正在读取项目“${project.name}”的素材与设备映射`,
    extra: {
      projectId: input.projectId,
      projectName: project.name,
    },
  });

  try {
    for (const [index, asset] of pendingAssets.entries()) {
      const localPath = resolveAssetLocalPath(input.projectId, asset, roots, deviceMaps);
      const completedCount = analyzedAssetIds.length;
      const fileIndex = index + 1;
      const etaSeconds = estimateRemainingSeconds(startedAtMs, completedCount, pendingAssets.length);

      await writeKairosProgress(progressPath, {
        status: 'running',
        pipelineKey: 'media-analyze',
        pipelineLabel: '素材分析流程',
        phaseKey: 'coarse-first-project-analysis',
        phaseLabel: '粗扫优先素材分析',
        step: 'coarse-scan',
        stepLabel: '粗扫素材',
        stepIndex: 2,
        stepTotal: CANALYZE_STEP_DEFINITIONS.length,
        stepDefinitions: [...CANALYZE_STEP_DEFINITIONS],
        fileName: asset.displayName,
        fileIndex,
        fileTotal: pendingAssets.length,
        current: fileIndex,
        total: pendingAssets.length,
        unit: 'files',
        etaSeconds,
        detail: localPath
          ? `正在粗扫 ${asset.displayName}`
          : `缺少本机路径映射，跳过 ${asset.displayName}`,
        extra: {
          projectId: input.projectId,
          projectName: project.name,
          assetId: asset.id,
          assetKind: asset.kind,
        },
      });

      if (!localPath) continue;

      const analysis = await analyzeSingleAsset({
        asset,
        localPath,
        projectRoot,
        roots,
        runtimeConfig,
        budget: input.budget,
        getMlHandle: async () => {
          mlHandle ??= await createMlAvailability(runtimeConfig.mlServerUrl);
          mlUsed ||= mlHandle.available;
          return mlHandle;
        },
        onStageChange: async (stage, detail) => {
          if (stage !== 'audio-analysis') return;
          await writeKairosProgress(progressPath, {
            status: 'running',
            pipelineKey: 'media-analyze',
            pipelineLabel: '素材分析流程',
            phaseKey: 'coarse-first-project-analysis',
            phaseLabel: '粗扫优先素材分析',
            step: 'audio-analysis',
            stepLabel: '分析视频内音轨',
            stepIndex: 3,
            stepTotal: CANALYZE_STEP_DEFINITIONS.length,
            stepDefinitions: [...CANALYZE_STEP_DEFINITIONS],
            fileName: asset.displayName,
            fileIndex,
            fileTotal: pendingAssets.length,
            current: fileIndex,
            total: pendingAssets.length,
            unit: 'files',
            etaSeconds: estimateRemainingSeconds(startedAtMs, analyzedAssetIds.length, pendingAssets.length),
            detail: detail ?? `正在分析 ${asset.displayName} 的视频内音轨`,
            extra: {
              projectId: input.projectId,
              projectName: project.name,
              assetId: asset.id,
              assetKind: asset.kind,
            },
          });
        },
      });

      await writeAssetReport(projectRoot, analysis.report);
      analyzedAssetIds.push(asset.id);

      if (analysis.slices.length > 0) {
        await writeKairosProgress(progressPath, {
          status: 'running',
          pipelineKey: 'media-analyze',
          pipelineLabel: '素材分析流程',
          phaseKey: 'coarse-first-project-analysis',
          phaseLabel: '粗扫优先素材分析',
          step: 'fine-scan',
          stepLabel: '自动细扫重点内容',
          stepIndex: 4,
          stepTotal: CANALYZE_STEP_DEFINITIONS.length,
          stepDefinitions: [...CANALYZE_STEP_DEFINITIONS],
          fileName: asset.displayName,
          fileIndex,
          fileTotal: pendingAssets.length,
          current: fileIndex,
          total: pendingAssets.length,
          unit: 'files',
          etaSeconds: estimateRemainingSeconds(startedAtMs, analyzedAssetIds.length, pendingAssets.length),
          detail: `已为 ${asset.displayName} 生成 ${analysis.slices.length} 个候选切片`,
          extra: {
            projectId: input.projectId,
            projectName: project.name,
            assetId: asset.id,
            fineScanMode: analysis.report.fineScanMode,
            sliceCount: analysis.slices.length,
          },
        });
        await appendSlices(projectRoot, analysis.slices);
        pendingSlices.push(...analysis.slices);
        fineScannedAssetIds.push(asset.id);
      }
    }

    await writeKairosProgress(progressPath, {
      status: 'running',
      pipelineKey: 'media-analyze',
      pipelineLabel: '素材分析流程',
      phaseKey: 'coarse-first-project-analysis',
      phaseLabel: '粗扫优先素材分析',
      step: 'chronology',
      stepLabel: '刷新时间视图',
      stepIndex: 5,
      stepTotal: CANALYZE_STEP_DEFINITIONS.length,
      stepDefinitions: [...CANALYZE_STEP_DEFINITIONS],
      fileIndex: pendingAssets.length,
      fileTotal: pendingAssets.length,
      current: analyzedAssetIds.length,
      total: pendingAssets.length,
      unit: 'files',
      etaSeconds: 0,
      detail: '正在按拍摄时间刷新 chronology 视图',
      extra: {
        projectId: input.projectId,
        projectName: project.name,
        fineScannedAssetCount: fineScannedAssetIds.length,
      },
    });

    const chronology = buildMediaChronology(
      await loadAssets(projectRoot),
      await loadAssetReports(projectRoot),
      await loadChronology(projectRoot),
    );
    await writeChronology(projectRoot, chronology);
    await touchProjectUpdatedAt(projectRoot);

    const missingRoots = roots.filter(
      root => root.enabled && !resolveAssetRootAvailable(input.projectId, root, deviceMaps),
    );

    await writeKairosProgress(progressPath, {
      status: 'succeeded',
      pipelineKey: 'media-analyze',
      pipelineLabel: '素材分析流程',
      phaseKey: 'coarse-first-project-analysis',
      phaseLabel: '粗扫优先素材分析',
      step: 'chronology',
      stepLabel: '素材分析完成',
      stepIndex: CANALYZE_STEP_DEFINITIONS.length,
      stepTotal: CANALYZE_STEP_DEFINITIONS.length,
      stepDefinitions: [...CANALYZE_STEP_DEFINITIONS],
      fileIndex: pendingAssets.length,
      fileTotal: pendingAssets.length,
      current: analyzedAssetIds.length,
      total: pendingAssets.length,
      unit: 'files',
      etaSeconds: 0,
      detail: `已完成 ${analyzedAssetIds.length} 条素材分析，自动细扫 ${fineScannedAssetIds.length} 条`,
      extra: {
        projectId: input.projectId,
        projectName: project.name,
        analyzedAssetIds,
        fineScannedAssetIds,
        chronologyCount: chronology.length,
      },
    });

    return {
      projectRoot,
      analyzedAssetIds,
      fineScannedAssetIds,
      missingRoots,
      reportCount: analyzedAssetIds.length,
      sliceCount: pendingSlices.length,
      mlUsed,
    };
  } catch (error) {
    await writeKairosProgress(progressPath, {
      status: 'failed',
      pipelineKey: 'media-analyze',
      pipelineLabel: '素材分析流程',
      phaseKey: 'coarse-first-project-analysis',
      phaseLabel: '粗扫优先素材分析',
      stepDefinitions: [...CANALYZE_STEP_DEFINITIONS],
      fileIndex: analyzedAssetIds.length,
      fileTotal: pendingAssets.length,
      current: analyzedAssetIds.length,
      total: pendingAssets.length,
      unit: 'files',
      detail: error instanceof Error ? error.message : String(error),
      extra: {
        projectId: input.projectId,
        projectName: project.name,
      },
    });
    throw error;
  }
}

interface IAnalyzeSingleAssetInput {
  asset: IKtepAsset;
  localPath: string;
  projectRoot: string;
  roots: IMediaRoot[];
  runtimeConfig: {
    ffmpegPath?: string;
    ffprobePath?: string;
    ffmpegHwaccel?: string;
    analysisProxyWidth?: number;
    analysisProxyPixelFormat?: string;
    sceneDetectFps?: number;
    sceneDetectScaleWidth?: number;
    mlServerUrl?: string;
  };
  budget?: ETargetBudget;
  getMlHandle: () => Promise<MlAvailability>;
  onStageChange?: (stage: 'audio-analysis', detail?: string) => Promise<void>;
}

interface IAnalyzeSingleAssetResult {
  report: IAssetCoarseReport;
  slices: IKtepSlice[];
}

interface IFineScanSlicesResult {
  slices: IKtepSlice[];
  droppedInvalidSliceCount: number;
}

interface MlAvailability {
  client: MlClient;
  available: boolean;
}

interface ITranscriptContext {
  transcript: string;
  segments: ITranscriptSegment[];
  evidence: IKtepEvidence[];
  speechCoverage: number;
  speechWindows: IInterestingWindow[];
}

async function analyzeSingleAsset(
  input: IAnalyzeSingleAssetInput,
): Promise<IAnalyzeSingleAssetResult> {
  if (input.asset.kind === 'photo') {
    return analyzePhotoAsset(input);
  }
  if (input.asset.kind === 'audio') {
    return analyzeAudioAsset(input.asset);
  }

  const shotBoundaries = await detectShots(
    input.localPath,
    0.3,
    input.runtimeConfig,
  ).catch(() => [] as IShotBoundary[]);
  const ml = await input.getMlHandle();
  const initialClipTypeGuess = guessClipType(input.asset, shotBoundaries);
  if (shouldAttemptAsr(input.asset, initialClipTypeGuess, input.budget)) {
    await input.onStageChange?.('audio-analysis', `正在分析 ${input.asset.displayName} 的视频内音轨`);
  }
  const transcript = await maybeTranscribeAsset({
    asset: input.asset,
    localPath: input.localPath,
    clipTypeGuess: initialClipTypeGuess,
    budget: input.budget,
    ml,
  });
  const clipTypeGuess = refineClipTypeGuess(input.asset, initialClipTypeGuess, transcript);
  const density = estimateDensity({
    durationMs: input.asset.durationMs ?? 0,
    shotBoundaries,
    asrSegments: transcript?.segments.map(segment => ({
      start: segment.startMs / 1000,
      end: segment.endMs / 1000,
      text: segment.text,
    })),
  });
  const plan = buildAnalysisPlan({
    assetId: input.asset.id,
    durationMs: input.asset.durationMs ?? 0,
    density,
    shotBoundaries,
    clipType: clipTypeGuess,
    budget: input.budget,
    extraInterestingWindows: transcript?.speechWindows,
  });
  const sampleTimestamps = buildCoarseSampleTimestamps(
    input.asset.durationMs ?? 0,
    plan.coarseSampleCount ?? pickCoarseSampleCount(input.asset.durationMs ?? 0),
  );
  const effectivePlan = applyDriveFallbackWindows(
    plan,
    clipTypeGuess,
    input.asset.durationMs ?? 0,
    input.budget,
    sampleTimestamps,
  );
  const extractedFrames = await extractKeyframes(
    input.localPath,
    buildAssetTempDir(input.projectRoot, input.asset.id),
    sampleTimestamps,
    input.runtimeConfig,
  );
  const sampleFrames = await filterExistingKeyframes(extractedFrames);

  const summary = await summarizeSamples(ml, sampleFrames);
  const root = input.roots.find(item => item.id === input.asset.ingestRootId);
  const baseReport = buildAssetCoarseReport({
    asset: input.asset,
    plan: effectivePlan,
    clipTypeGuess,
    summary: summary?.description,
    transcript: transcript?.transcript,
    transcriptSegments: transcript?.segments,
    speechCoverage: transcript?.speechCoverage,
    labels: buildReportLabels(clipTypeGuess, summary?.sceneType, summary?.subjects, transcript),
    placeHints: summary?.placeHints ?? [],
    rootNotes: root?.notes ?? [],
    sampleFrames,
    fineScanReasons: buildFineScanReasons(effectivePlan, density, shotBoundaries, transcript),
  });

  const fineScan = await buildFineScanSlices({
    asset: input.asset,
    localPath: input.localPath,
    projectRoot: input.projectRoot,
    roots: input.roots,
    runtimeConfig: input.runtimeConfig,
    shotBoundaries,
    report: baseReport,
    transcript,
    clipTypeGuess,
    ml,
  });
  const report = reconcileFineScanReport({
    report: baseReport,
    slices: fineScan.slices,
    droppedInvalidSliceCount: fineScan.droppedInvalidSliceCount,
  });

  return {
    report,
    slices: fineScan.slices,
  };
}

function applyDriveFallbackWindows(
  plan: IMediaAnalysisPlan,
  clipTypeGuess: EClipType,
  durationMs: number,
  budget: ETargetBudget | undefined,
  sampleTimestamps: number[],
): IMediaAnalysisPlan {
  if (clipTypeGuess !== 'drive') return plan;
  if ((budget ?? 'standard') === 'coarse') return plan;
  if (plan.interestingWindows.length > 0) return plan;
  if (plan.shouldFineScan && plan.fineScanMode !== 'skip') return plan;

  const fallbackWindows = buildDriveFallbackWindows(durationMs, sampleTimestamps);
  if (fallbackWindows.length === 0) return plan;

  return {
    ...plan,
    interestingWindows: fallbackWindows,
    shouldFineScan: true,
    fineScanMode: 'windowed',
  };
}

async function maybeTranscribeAsset(input: {
  asset: IKtepAsset;
  localPath: string;
  clipTypeGuess: EClipType;
  budget?: ETargetBudget;
  ml: MlAvailability;
}): Promise<ITranscriptContext | null> {
  if (!input.ml.available) return null;
  if (!shouldAttemptAsr(input.asset, input.clipTypeGuess, input.budget)) return null;

  try {
    const result = await transcribe(input.ml.client, input.localPath);
    const segments = result.segments
      .map(segment => ({
        startMs: Math.max(0, Math.round(segment.start * 1000)),
        endMs: Math.max(Math.round(segment.start * 1000), Math.round(segment.end * 1000)),
        text: segment.text.trim(),
      }))
      .filter(segment => segment.endMs > segment.startMs && segment.text.length > 0);

    const transcript = result.fullText.trim();
    if (!transcript && segments.length === 0) {
      return null;
    }

    return {
      transcript,
      segments,
      evidence: result.evidence,
      speechCoverage: computeSpeechCoverage(input.asset.durationMs ?? 0, segments),
      speechWindows: buildSpeechWindows(input.asset.durationMs ?? 0, segments),
    };
  } catch {
    return null;
  }
}

function shouldAttemptAsr(
  asset: IKtepAsset,
  clipTypeGuess: EClipType,
  budget?: ETargetBudget,
): boolean {
  if (budget === 'coarse') return false;
  const durationMs = asset.durationMs ?? 0;
  if (durationMs <= 0) return false;
  if (clipTypeGuess === 'talking-head') return durationMs <= 30 * 60_000;
  if (clipTypeGuess === 'unknown') return durationMs <= 20 * 60_000;
  if (clipTypeGuess === 'drive') return durationMs <= 12 * 60_000;
  return durationMs <= 10 * 60_000;
}

function computeSpeechCoverage(
  durationMs: number,
  segments: ITranscriptSegment[],
): number {
  if (durationMs <= 0 || segments.length === 0) return 0;

  const coveredMs = segments.reduce(
    (sum, segment) => sum + Math.max(0, segment.endMs - segment.startMs),
    0,
  );
  return Math.min(coveredMs / durationMs, 1);
}

function buildSpeechWindows(
  durationMs: number,
  segments: ITranscriptSegment[],
): IInterestingWindow[] {
  if (durationMs <= 0 || segments.length === 0) return [];

  return mergeInterestingWindows(
    segments.map(segment => ({
      startMs: Math.max(0, segment.startMs - 500),
      endMs: Math.min(durationMs, segment.endMs + 900),
      reason: 'speech-window',
    })),
  );
}

function refineClipTypeGuess(
  asset: IKtepAsset,
  clipTypeGuess: EClipType,
  transcript?: ITranscriptContext | null,
): EClipType {
  if (!transcript?.transcript) return clipTypeGuess;
  if (clipTypeGuess === 'drive') return clipTypeGuess;

  const durationMs = asset.durationMs ?? 0;
  if (clipTypeGuess === 'unknown' && durationMs <= 3 * 60_000 && transcript.speechCoverage >= 0.18) {
    return 'talking-head';
  }
  if (clipTypeGuess === 'broll' && durationMs > 20_000 && transcript.speechCoverage >= 0.3) {
    return 'talking-head';
  }
  return clipTypeGuess;
}

function decorateSliceWithTranscript(
  slice: IKtepSlice,
  transcript?: ITranscriptContext | null,
  extraEvidence: IKtepEvidence[] = [],
): IKtepSlice {
  if (!transcript || !transcript.transcript) {
    const evidence = dedupeEvidence([...(slice.evidence ?? []), ...extraEvidence]);
    return evidence.length > 0
      ? { ...slice, evidence }
      : slice;
  }

  const match = collectTranscriptForSlice(slice, transcript);
  const transcriptSummary = shouldUseTranscriptSummary(slice.summary)
    ? match.transcript
    : slice.summary;
  const evidence = dedupeEvidence([
    ...(slice.evidence ?? []),
    ...match.evidence,
    ...extraEvidence,
  ]);

  return {
    ...slice,
    summary: transcriptSummary,
    transcript: match.transcript ?? slice.transcript,
    transcriptSegments: match.transcriptSegments ?? slice.transcriptSegments,
    labels: dedupeStrings([
      ...slice.labels,
      match.transcript ? 'speech' : undefined,
      (match.speechCoverage ?? 0) >= 0.35 ? 'spoken-content' : undefined,
    ]),
    evidence: evidence.length > 0 ? evidence : undefined,
    speechCoverage: match.speechCoverage ?? slice.speechCoverage,
  };
}

function collectTranscriptForSlice(
  slice: IKtepSlice,
  transcript: ITranscriptContext,
): {
  transcript?: string;
  transcriptSegments?: ITranscriptSegment[];
  evidence: IKtepEvidence[];
  speechCoverage?: number;
} {
  if (transcript.segments.length === 0) {
    return {
      transcript: transcript.transcript || undefined,
      transcriptSegments: transcript.transcript
        ? [{
          startMs: slice.sourceInMs ?? 0,
          endMs: slice.sourceOutMs ?? (slice.sourceInMs ?? 0),
          text: transcript.transcript,
        }]
        : undefined,
      evidence: transcript.evidence,
      speechCoverage: transcript.speechCoverage,
    };
  }

  const rangeStartMs = slice.sourceInMs ?? 0;
  const rangeEndMs = slice.sourceOutMs ?? Number.POSITIVE_INFINITY;
  const overlapped = transcript.segments.filter(segment =>
    segment.endMs > rangeStartMs && segment.startMs < rangeEndMs,
  );

  if (overlapped.length === 0) {
    return { evidence: [] };
  }

  const clippedSegments = overlapped
    .map(segment => ({
      startMs: Math.max(rangeStartMs, segment.startMs),
      endMs: Math.min(rangeEndMs, segment.endMs),
      text: segment.text,
    }))
    .filter(segment => segment.endMs > segment.startMs);
  const excerpt = clippedSegments.map(segment => segment.text).join(' ').trim();
  const speechMs = clippedSegments.reduce((sum, segment) => {
    const overlapStart = segment.startMs;
    const overlapEnd = segment.endMs;
    return sum + Math.max(0, overlapEnd - overlapStart);
  }, 0);
  const sliceDurationMs = resolveSliceDurationMs(slice.sourceInMs, slice.sourceOutMs);

  return {
    transcript: excerpt || undefined,
    transcriptSegments: clippedSegments,
    evidence: clippedSegments.map(segment => ({
      source: 'asr',
      value: segment.text,
      confidence: 0.8,
    })),
    speechCoverage: sliceDurationMs && sliceDurationMs > 0
      ? Math.min(speechMs / sliceDurationMs, 1)
      : transcript.speechCoverage,
  };
}

function shouldUseTranscriptSummary(summary?: string): boolean {
  if (!summary) return true;
  return ['speech-window', 'coarse-sample-window', 'whole-asset-window-fallback']
    .some(token => summary.includes(token));
}

async function analyzePhotoAsset(
  input: IAnalyzeSingleAssetInput,
): Promise<IAnalyzeSingleAssetResult> {
  const proxyFrame = await extractImageProxy(
    input.localPath,
    buildAssetTempDir(input.projectRoot, input.asset.id),
    input.runtimeConfig,
  );
  const ml = await input.getMlHandle();
  const sampleFrames = proxyFrame ? [proxyFrame] : [];
  const summary = await summarizeSamples(ml, sampleFrames);
  const density = estimateDensity({ durationMs: 0, shotBoundaries: [] });
  const clipTypeGuess: EClipType = 'broll';
  const root = input.roots.find(item => item.id === input.asset.ingestRootId);
  const plan = buildAnalysisPlan({
    assetId: input.asset.id,
    durationMs: 0,
    density,
    shotBoundaries: [],
    clipType: clipTypeGuess,
    budget: input.budget,
  });

  const report = buildAssetCoarseReport({
    asset: input.asset,
    plan,
    clipTypeGuess,
    summary: summary?.description,
    labels: buildReportLabels(clipTypeGuess, summary?.sceneType, summary?.subjects),
    placeHints: summary?.placeHints ?? [],
    rootNotes: root?.notes ?? [],
    sampleFrames,
    shouldFineScan: true,
    fineScanMode: 'full',
    fineScanReasons: ['photo-assets-are-directly-usable'],
  });

  const slice = slicePhoto(input.asset);
  slice.summary = report.summary;
  slice.labels = report.labels;
  slice.placeHints = report.placeHints;

  return {
    report,
    slices: [slice],
  };
}

async function analyzeAudioAsset(
  asset: IKtepAsset,
): Promise<IAnalyzeSingleAssetResult> {
  const report = buildAssetCoarseReport({
    asset,
    plan: {
      assetId: asset.id,
      clipType: 'unknown',
      densityScore: 0,
      samplingProfile: 'sparse',
      coarseSampleCount: 0,
      baseSampleIntervalMs: 0,
      interestingWindows: [],
      vlmMode: 'none',
      targetBudget: 'coarse',
      shouldFineScan: false,
      fineScanMode: 'skip',
    },
    clipTypeGuess: 'unknown',
    summary: 'Audio asset imported; waiting for downstream use or dedicated audio analysis.',
    labels: ['audio'],
    fineScanReasons: ['audio-assets-skip-visual-fine-scan'],
  });
  return { report, slices: [] };
}

function buildCoarseSampleTimestamps(
  durationMs: number,
  sampleCount: number,
): number[] {
  if (durationMs <= 0) return [0];
  const endMs = Math.max(0, durationMs - 1);
  if (endMs === 0) return [0];

  const count = Math.max(2, sampleCount);
  const anchors = [0, endMs];
  if (count === 2) return anchors;

  const interiorCount = count - anchors.length;
  const intervalMs = Math.max(1, Math.floor(durationMs / (count + 1)));
  const uniform = uniformTimestamps(durationMs, intervalMs)
    .filter(timeMs => timeMs > 0 && timeMs < endMs);

  if (uniform.length === 0) return anchors;
  if (uniform.length <= interiorCount) {
    return [...new Set([0, ...uniform, endMs])].sort((a, b) => a - b);
  }

  const picked: number[] = [];
  for (let i = 1; i <= interiorCount; i++) {
    const index = Math.min(
      uniform.length - 1,
      Math.round((i * (uniform.length - 1)) / (interiorCount + 1)),
    );
    picked.push(uniform[index]);
  }

  return [...new Set([0, ...picked, endMs])].sort((a, b) => a - b);
}

function buildDriveFallbackWindows(
  durationMs: number,
  sampleTimestamps: number[],
): IMediaAnalysisPlan['interestingWindows'] {
  if (durationMs <= 0) return [];

  const uniqueTimestamps = [...new Set(sampleTimestamps)]
    .filter(timeMs => timeMs >= 0 && timeMs < durationMs)
    .sort((a, b) => a - b);
  if (uniqueTimestamps.length === 0) return [];

  const preferred = uniqueTimestamps.filter(timeMs => timeMs > 0 && timeMs < durationMs - 1);
  const anchors = preferred.length > 0 ? preferred : uniqueTimestamps;
  const windowDurationMs = pickDriveFallbackWindowDuration(durationMs);
  const halfWindowMs = Math.max(1000, Math.floor(windowDurationMs / 2));

  const windows = anchors.map(timeMs => ({
    startMs: Math.max(0, timeMs - halfWindowMs),
    endMs: Math.min(durationMs, timeMs + halfWindowMs),
    reason: 'coarse-sample-window',
  })).filter(window => window.endMs > window.startMs);

  return mergeInterestingWindows(windows);
}

function pickDriveFallbackWindowDuration(durationMs: number): number {
  if (durationMs <= 60_000) return 6_000;
  if (durationMs <= 5 * 60_000) return 10_000;
  if (durationMs <= 20 * 60_000) return 16_000;
  return 20_000;
}

function guessClipType(
  asset: IKtepAsset,
  shotBoundaries: IShotBoundary[],
): EClipType {
  if (asset.kind === 'photo') return 'broll';

  const durationSec = Math.max((asset.durationMs ?? 0) / 1000, 1);
  const shotRate = shotBoundaries.length / durationSec;
  if ((asset.durationMs ?? 0) >= 10 * 60 * 1000 && shotRate < 0.002) {
    return 'drive';
  }
  if ((asset.durationMs ?? 0) <= 20_000 && shotRate < 0.01) {
    return 'broll';
  }
  if ((asset.durationMs ?? 0) <= 90_000 && shotRate >= 0.03) {
    return 'talking-head';
  }
  return 'unknown';
}

function buildReportLabels(
  clipType: EClipType,
  sceneType?: string,
  subjects?: string[],
  transcript?: ITranscriptContext | null,
): string[] {
  const speechLabels = transcript?.transcript
    ? [
      'speech',
      transcript.speechCoverage >= 0.3 ? 'spoken-content' : undefined,
    ]
    : [];
  return [...new Set([
    clipType,
    sceneType,
    ...(subjects ?? []).slice(0, 6),
    ...speechLabels,
  ].filter(Boolean) as string[])];
}

function buildFineScanReasons(
  reportPlan: {
    shouldFineScan: boolean;
    fineScanMode: 'skip' | 'windowed' | 'full';
    interestingWindows: { reason: string }[];
  },
  density: { score: number },
  shotBoundaries: IShotBoundary[],
  transcript?: ITranscriptContext | null,
): string[] {
  if (!reportPlan.shouldFineScan) {
    return ['coarse-scan-sufficient'];
  }
  const reasons = new Set<string>();
  reasons.add(`fine-scan:${reportPlan.fineScanMode}`);
  if (density.score >= 0.55) reasons.add('high-density-score');
  if (shotBoundaries.length >= 12) reasons.add('high-shot-count');
  if ((transcript?.speechWindows.length ?? 0) > 0) reasons.add('speech-window');
  if ((transcript?.speechCoverage ?? 0) >= 0.2) reasons.add('high-speech-coverage');
  for (const window of reportPlan.interestingWindows) {
    reasons.add(window.reason);
  }
  return [...reasons];
}

function mergeInterestingWindows(
  windows: IMediaAnalysisPlan['interestingWindows'],
): IMediaAnalysisPlan['interestingWindows'] {
  if (windows.length === 0) return [];
  const sorted = [...windows].sort((a, b) => a.startMs - b.startMs);
  const merged: typeof windows = [{ ...sorted[0] }];

  for (let index = 1; index < sorted.length; index += 1) {
    const previous = merged[merged.length - 1];
    const current = sorted[index];
    if (current.startMs <= previous.endMs) {
      previous.endMs = Math.max(previous.endMs, current.endMs);
      previous.reason = previous.reason === current.reason
        ? previous.reason
        : `${previous.reason}+${current.reason}`;
      continue;
    }
    merged.push({ ...current });
  }

  return merged;
}

interface IBuildFineScanSlicesInput {
  asset: IKtepAsset;
  localPath: string;
  projectRoot: string;
  runtimeConfig: {
    ffmpegPath?: string;
    ffprobePath?: string;
    ffmpegHwaccel?: string;
    analysisProxyWidth?: number;
    analysisProxyPixelFormat?: string;
    sceneDetectFps?: number;
    sceneDetectScaleWidth?: number;
    mlServerUrl?: string;
  };
  shotBoundaries: IShotBoundary[];
  report: IAssetCoarseReport;
  transcript?: ITranscriptContext | null;
  roots: IMediaRoot[];
  clipTypeGuess: EClipType;
  ml: MlAvailability;
}

async function buildFineScanSlices(
  input: IBuildFineScanSlicesInput,
): Promise<IFineScanSlicesResult> {
  if (!input.report.shouldFineScan) {
    return { slices: [], droppedInvalidSliceCount: 0 };
  }

  const baseSlices = input.report.fineScanMode === 'full'
    ? sliceVideo(input.asset, input.shotBoundaries)
    : sliceInterestingWindows(
      input.asset,
      input.report.interestingWindows,
      mapClipTypeToSliceType(input.clipTypeGuess),
    );
  const effectiveSlices = baseSlices.length > 0
    ? baseSlices
    : input.report.fineScanMode === 'windowed' && (input.asset.durationMs ?? 0) > 0
      ? sliceInterestingWindows(
        input.asset,
        [{
          startMs: 0,
          endMs: input.asset.durationMs ?? 0,
          reason: 'whole-asset-window-fallback',
        }],
        mapClipTypeToSliceType(input.clipTypeGuess),
      )
      : baseSlices;

  if (effectiveSlices.length === 0) {
    return { slices: [], droppedInvalidSliceCount: 0 };
  }

  const plans = buildFineScanKeyframePlans(effectiveSlices);
  if (plans.length === 0 || !input.ml.available) {
    return {
      slices: effectiveSlices.map(slice => {
        const withTranscript = decorateSliceWithTranscript(slice, input.transcript);
        return {
          ...withTranscript,
          summary: withTranscript.summary ?? input.report.summary ?? withTranscript.transcript,
          labels: dedupeStrings([...withTranscript.labels, ...input.report.labels]),
          placeHints: dedupeStrings([...withTranscript.placeHints, ...input.report.placeHints]),
        };
      }),
      droppedInvalidSliceCount: 0,
    };
  }

  const timestamps = [...new Set(plans.flatMap(plan => plan.timestampsMs))].sort((a, b) => a - b);
  const extractedFrames = await extractKeyframes(
    input.localPath,
    join(buildAssetTempDir(input.projectRoot, input.asset.id), 'fine-scan'),
    timestamps,
    input.runtimeConfig,
  );
  const keyframes = await filterExistingKeyframes(extractedFrames);
  const groups = groupKeyframesByShot(plans, keyframes);
  const recognitions = await recognizeShotGroups(input.ml.client, groups);
  const recognitionMap = new Map(recognitions.map(item => [item.shotId, item]));

  const slices: IKtepSlice[] = [];
  let droppedInvalidSliceCount = 0;

  for (const slice of effectiveSlices) {
    const recognition = recognitionMap.get(slice.id);
    if (recognition && isLikelyInvalidVisualSegment(recognition.recognition.description)) {
      droppedInvalidSliceCount += 1;
      continue;
    }
    const withTranscript = decorateSliceWithTranscript(
      slice,
      input.transcript,
      recognition?.recognition.evidence,
    );
    slices.push({
      ...withTranscript,
      summary: recognition?.recognition.description
        || withTranscript.summary
        || input.report.summary
        || withTranscript.transcript,
      labels: dedupeStrings([
        ...withTranscript.labels,
        ...input.report.labels,
        recognition?.recognition.sceneType,
        ...(recognition?.recognition.subjects ?? []),
      ]),
      placeHints: dedupeStrings([
        ...withTranscript.placeHints,
        ...input.report.placeHints,
        ...(recognition?.recognition.placeHints ?? []),
      ]),
    });
  }

  return {
    slices,
    droppedInvalidSliceCount,
  };
}

function mapClipTypeToSliceType(clipType: EClipType): IKtepSlice['type'] {
  if (clipType === 'drive') return 'drive';
  if (clipType === 'talking-head') return 'talking-head';
  if (clipType === 'aerial') return 'aerial';
  if (clipType === 'broll') return 'broll';
  if (clipType === 'timelapse') return 'timelapse';
  return 'unknown';
}

async function summarizeSamples(
  ml: MlAvailability,
  sampleFrames: { path: string }[],
) {
  if (!ml.available || sampleFrames.length === 0) return null;

  const paths = pickRepresentativeFramePaths(sampleFrames.map(frame => frame.path), 6);
  if (paths.length === 0) return null;

  try {
    return await recognizeFrames(ml.client, paths);
  } catch {
    return null;
  }
}

async function filterExistingKeyframes(
  frames: { timeMs: number; path: string }[],
): Promise<{ timeMs: number; path: string }[]> {
  const existing = await Promise.all(frames.map(async frame => {
    try {
      await access(frame.path);
      return frame;
    } catch {
      return null;
    }
  }));
  return existing.filter((frame): frame is { timeMs: number; path: string } => Boolean(frame));
}

function pickRepresentativeFramePaths(
  paths: string[],
  maxCount: number,
): string[] {
  if (paths.length <= maxCount) return paths;
  const picked: string[] = [];
  for (let i = 0; i < maxCount; i++) {
    const index = Math.min(
      paths.length - 1,
      Math.round((i * (paths.length - 1)) / Math.max(1, maxCount - 1)),
    );
    picked.push(paths[index]);
  }
  return [...new Set(picked)];
}

function buildAssetTempDir(projectRoot: string, assetId: string): string {
  return join(projectRoot, '.tmp', 'media-analyze', assetId);
}

function buildFineScanKeyframePlans(
  slices: IKtepSlice[],
  framesPerSlice = 3,
): IShotKeyframePlan[] {
  return slices
    .filter(slice => typeof slice.sourceInMs === 'number' && typeof slice.sourceOutMs === 'number')
    .filter(slice => (slice.sourceOutMs as number) > (slice.sourceInMs as number))
    .map(slice => ({
      shotId: slice.id,
      startMs: slice.sourceInMs as number,
      endMs: slice.sourceOutMs as number,
      timestampsMs: sampleRangeTimestamps(
        slice.sourceInMs as number,
        slice.sourceOutMs as number,
        framesPerSlice,
      ),
    }));
}

function reconcileFineScanReport(input: {
  report: IAssetCoarseReport;
  slices: IKtepSlice[];
  droppedInvalidSliceCount: number;
}): IAssetCoarseReport {
  if (input.droppedInvalidSliceCount <= 0) return input.report;

  if (input.slices.length > 0) {
    return {
      ...input.report,
      fineScanReasons: [
        ...new Set([
          ...input.report.fineScanReasons,
          `dropped-invalid-slices:${input.droppedInvalidSliceCount}`,
        ]),
      ],
    };
  }

  return {
    ...input.report,
    shouldFineScan: false,
    fineScanMode: 'skip',
    fineScanReasons: [
      ...new Set([
        ...input.report.fineScanReasons,
        'fine-scan-suppressed:invalid-dark-recording',
      ]),
    ],
  };
}

function isLikelyInvalidVisualSegment(description?: string): boolean {
  if (!description) return false;
  const normalized = description.trim().toLowerCase();
  if (!normalized) return false;

  return [
    'black screen',
    'completely black',
    'completely dark',
    'dark frame',
    'no visible details',
    'no visible subjects',
    'absence of visual information',
  ].some(pattern => normalized.includes(pattern));
}

async function createMlAvailability(baseUrl?: string): Promise<MlAvailability> {
  const client = new MlClient(baseUrl);
  try {
    await client.health();
    return { client, available: true };
  } catch {
    return { client, available: false };
  }
}

function selectPendingAssets(
  assets: IKtepAsset[],
  reports: IAssetCoarseReport[],
  requestedIds?: string[],
): IKtepAsset[] {
  const visualAssets = assets.filter(asset => asset.kind !== 'audio');
  if (requestedIds && requestedIds.length > 0) {
    const requested = new Set(requestedIds);
    return visualAssets.filter(asset => requested.has(asset.id));
  }
  return findUnreportedAssets(visualAssets, reports);
}

function resolveAssetRootAvailable(
  projectId: string,
  root: IMediaRoot,
  deviceMaps: Awaited<ReturnType<typeof loadDeviceMediaMaps>>,
): boolean {
  const projectMap = deviceMaps.projects[projectId];
  if (!projectMap) return Boolean(root.path);
  return projectMap.roots.some(item => item.rootId === root.id) || Boolean(root.path);
}

function dedupeStrings(values: Array<string | undefined>): string[] {
  return [...new Set(
    values
      .map(value => value?.trim())
      .filter((value): value is string => Boolean(value)),
  )];
}

function resolveSliceDurationMs(sourceInMs?: number, sourceOutMs?: number): number | undefined {
  if (sourceInMs == null || sourceOutMs == null) return undefined;
  if (sourceOutMs <= sourceInMs) return undefined;
  return sourceOutMs - sourceInMs;
}

function dedupeEvidence(evidence: IKtepEvidence[]): IKtepEvidence[] {
  const seen = new Set<string>();
  const deduped: IKtepEvidence[] = [];
  for (const item of evidence) {
    const key = `${item.source}:${item.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }
  return deduped;
}
