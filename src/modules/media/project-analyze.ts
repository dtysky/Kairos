import { join } from 'node:path';
import { access } from 'node:fs/promises';
import type {
  EClipType,
  ETargetBudget,
  IAssetCoarseReport,
  IKtepAsset,
  IKtepEvidence,
  IKtepSlice,
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
import { evidenceFromPath, mergeEvidence } from './evidence.js';
import { uniformTimestamps, extractImageProxy, extractKeyframes } from './keyframe.js';
import { MlClient } from './ml-client.js';
import { recognizeFrames } from './recognizer.js';
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
  const extractedFrames = await extractKeyframes(
    input.localPath,
    buildAssetTempDir(input.projectRoot, input.asset.id),
    sampleTimestamps,
    input.runtimeConfig,
  );
  const sampleFrames = await filterExistingKeyframes(extractedFrames);

  const ml = await input.getMlHandle();
  const summary = await summarizeSamples(ml, sampleFrames);
  const report = buildAssetCoarseReport({
    asset: input.asset,
    plan,
    clipTypeGuess,
    summary: summary?.description,
    labels: buildReportLabels(clipTypeGuess, summary?.sceneType, summary?.subjects),
    placeHints: summary?.placeHints ?? [],
    sampleFrames,
    fineScanReasons: buildFineScanReasons(plan, density, shotBoundaries),
  });

  return {
    report,
    slices: buildFineScanSlices(
      input.asset,
      shotBoundaries,
      report,
      input.roots,
      clipTypeGuess,
    ),
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
    sampleFrames,
    fineScanMode: 'full',
    fineScanReasons: ['photo-assets-are-directly-usable'],
  });

  const root = input.roots.find(item => item.id === input.asset.ingestRootId);
  const slice = mergeEvidence(
    slicePhoto(input.asset),
    evidenceFromPath(input.asset.sourcePath, root?.notes),
    summary?.evidence ?? [],
  );
  slice.summary = report.summary;
  slice.labels = report.labels;

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
  const count = Math.max(1, sampleCount);
  if (count === 1) return [Math.round(durationMs / 2)];

  const intervalMs = Math.max(1000, Math.floor(durationMs / (count + 1)));
  const uniform = uniformTimestamps(durationMs, intervalMs);
  if (uniform.length <= count) return uniform;

  const picked: number[] = [];
  for (let i = 1; i <= count; i++) {
    const index = Math.min(
      uniform.length - 1,
      Math.round((i * (uniform.length - 1)) / (count + 1)),
    );
    picked.push(uniform[index]);
  }
  return [...new Set(picked)].sort((a, b) => a - b);
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

function buildFineScanSlices(
  asset: IKtepAsset,
  shotBoundaries: IShotBoundary[],
  report: IAssetCoarseReport,
  roots: IMediaRoot[],
  clipTypeGuess: EClipType,
): IKtepSlice[] {
  if (!report.shouldFineScan) return [];

  const root = roots.find(item => item.id === asset.ingestRootId);
  const sharedEvidence = [
    ...evidenceFromPath(asset.sourcePath, root?.notes),
    ...(report.summary ? [{
      source: 'vision' as const,
      value: report.summary,
      confidence: 0.65,
    }] : []),
  ];

  const baseSlices = report.fineScanMode === 'full'
    ? sliceVideo(asset, shotBoundaries)
    : sliceInterestingWindows(asset, report.interestingWindows, mapClipTypeToSliceType(clipTypeGuess));

  return baseSlices.map(slice => {
    const merged = mergeEvidence(slice, sharedEvidence);
    return {
      ...merged,
      summary: slice.summary ?? report.summary,
      labels: [...new Set([...slice.labels, ...report.labels])],
    };
  });
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
