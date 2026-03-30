import { join } from 'node:path';
import { access } from 'node:fs/promises';
import type {
  EClipType,
  ETargetBudget,
  IAssetCoarseReport,
  IKtepAsset,
  IKtepSlice,
  IMediaAnalysisPlan,
  IMediaRoot,
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
      stepIndex: 4,
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
  const density = estimateDensity({
    durationMs: input.asset.durationMs ?? 0,
    shotBoundaries,
  });
  const clipTypeGuess = guessClipType(input.asset, shotBoundaries);
  const plan = buildAnalysisPlan({
    assetId: input.asset.id,
    durationMs: input.asset.durationMs ?? 0,
    density,
    shotBoundaries,
    clipType: clipTypeGuess,
    budget: input.budget,
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

  const ml = await input.getMlHandle();
  const summary = await summarizeSamples(ml, sampleFrames);
  const root = input.roots.find(item => item.id === input.asset.ingestRootId);
  const baseReport = buildAssetCoarseReport({
    asset: input.asset,
    plan: effectivePlan,
    clipTypeGuess,
    summary: summary?.description,
    labels: buildReportLabels(clipTypeGuess, summary?.sceneType, summary?.subjects),
    placeHints: summary?.placeHints ?? [],
    rootNotes: root?.notes ?? [],
    sampleFrames,
    fineScanReasons: buildFineScanReasons(effectivePlan, density, shotBoundaries),
  });

  const fineScan = await buildFineScanSlices({
    asset: input.asset,
    localPath: input.localPath,
    projectRoot: input.projectRoot,
    roots: input.roots,
    runtimeConfig: input.runtimeConfig,
    shotBoundaries,
    report: baseReport,
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
): string[] {
  return [...new Set([
    clipType,
    sceneType,
    ...(subjects ?? []).slice(0, 6),
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
): string[] {
  if (!reportPlan.shouldFineScan) {
    return ['coarse-scan-sufficient'];
  }
  const reasons = new Set<string>();
  reasons.add(`fine-scan:${reportPlan.fineScanMode}`);
  if (density.score >= 0.55) reasons.add('high-density-score');
  if (shotBoundaries.length >= 12) reasons.add('high-shot-count');
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
      slices: effectiveSlices.map(slice => ({
        ...slice,
        summary: slice.summary ?? input.report.summary,
        labels: dedupeStrings([...slice.labels, ...input.report.labels]),
        placeHints: dedupeStrings([...slice.placeHints, ...input.report.placeHints]),
      })),
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
    slices.push({
      ...slice,
      summary: recognition?.recognition.description || slice.summary || input.report.summary,
      labels: dedupeStrings([
        ...slice.labels,
        ...input.report.labels,
        recognition?.recognition.sceneType,
        ...(recognition?.recognition.subjects ?? []),
      ]),
      placeHints: dedupeStrings([
        ...slice.placeHints,
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
