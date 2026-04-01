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
  loadManualItinerary,
  loadPathTimezones,
  loadProject,
  loadRuntimeConfig,
  matchPathTimezoneOverride,
  resolveWorkspaceProjectRoot,
  getProjectProgressPath,
  touchProjectUpdatedAt,
  writeKairosProgress,
  writeChronology,
  writeAssetReport,
  type ILoadedManualItinerary,
  type IPathTimezoneOverride,
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
import { probe } from './probe.js';
import { recognizeFrames, recognizeShotGroups, type IRecognition } from './recognizer.js';
import { resolveAssetLocalPath } from './root-resolver.js';
import {
  applyAnalysisDecision,
  buildAnalysisPlan,
  buildHeuristicAnalysisDecision,
  type IAnalysisDecision,
  pickCoarseSampleCount,
} from './sampler.js';
import { detectShots, type IShotBoundary } from './shot-detect.js';
import { sliceInterestingWindows, slicePhoto, sliceVideo } from './slicer.js';
import { formatDateInTimeZone } from './timezone-utils.js';
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
  const [{ roots }, deviceMaps, runtimeConfig, assets, existingReports, project, manualItinerary, pathTimezones] = await Promise.all([
    loadIngestRoots(projectRoot),
    loadDeviceMediaMaps(input.deviceMapPath),
    loadRuntimeConfig(projectRoot),
    loadAssets(projectRoot),
    loadAssetReports(projectRoot),
    loadProject(projectRoot),
    loadManualItinerary(projectRoot),
    loadPathTimezones(projectRoot),
  ]);

  const pendingAssets = selectPendingAssets(assets, existingReports, input.assetIds);
  const analyzedAssetIds: string[] = [];
  const fineScannedAssetIds: string[] = [];
  const pendingSlices: IKtepSlice[] = [];
  const preparedAnalyses: IPreparedAssetAnalysis[] = [];
  const finalizedAnalyses: IFinalizedAssetAnalysis[] = [];
  let mlHandle: MlAvailability | null = null;
  let mlUsed = false;
  const getMlHandle = async () => {
    mlHandle ??= await createMlAvailability(runtimeConfig.mlServerUrl);
    mlUsed ||= mlHandle.available;
    return mlHandle;
  };

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
      const fileIndex = index + 1;
      const etaSeconds = estimateRemainingSeconds(startedAtMs, preparedAnalyses.length, pendingAssets.length);

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

      const prepared = await prepareAssetVisualCoarse({
        asset,
        localPath,
        projectRoot,
        runtimeConfig,
        getMlHandle,
      });
      preparedAnalyses.push(prepared);
    }

    for (const [index, prepared] of preparedAnalyses.entries()) {
      const fileIndex = index + 1;

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
        fileName: prepared.asset.displayName,
        fileIndex,
        fileTotal: preparedAnalyses.length,
        current: fileIndex,
        total: preparedAnalyses.length,
        unit: 'files',
        etaSeconds: estimateRemainingSeconds(startedAtMs, analyzedAssetIds.length, preparedAnalyses.length),
        detail: describeDecisionStage(prepared.asset, prepared.hasAudioTrack),
        extra: {
          projectId: input.projectId,
          projectName: project.name,
          assetId: prepared.asset.id,
          assetKind: prepared.asset.kind,
        },
      });

      const finalized = await finalizePreparedAsset({
        prepared,
        projectRoot,
        roots,
        manualItinerary,
        pathTimezones: pathTimezones.overrides,
        budget: input.budget,
        getMlHandle,
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
            fileName: prepared.asset.displayName,
            fileIndex,
            fileTotal: preparedAnalyses.length,
            current: fileIndex,
            total: preparedAnalyses.length,
            unit: 'files',
            etaSeconds: estimateRemainingSeconds(startedAtMs, analyzedAssetIds.length, preparedAnalyses.length),
            detail: detail ?? `正在分析 ${prepared.asset.displayName} 的视频内音轨`,
            extra: {
              projectId: input.projectId,
              projectName: project.name,
              assetId: prepared.asset.id,
              assetKind: prepared.asset.kind,
            },
          });
        },
      });

      await writeAssetReport(projectRoot, finalized.report);
      analyzedAssetIds.push(prepared.asset.id);
      finalizedAnalyses.push(finalized);
    }

    const fineScanCandidates = finalizedAnalyses.filter(analysis => analysis.report.shouldFineScan);
    for (const [index, analysis] of fineScanCandidates.entries()) {
      const fileIndex = index + 1;

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
        fileName: analysis.prepared.asset.displayName,
        fileIndex,
        fileTotal: fineScanCandidates.length,
        current: fileIndex,
        total: fineScanCandidates.length,
        unit: 'files',
        etaSeconds: estimateRemainingSeconds(startedAtMs, fineScannedAssetIds.length, fineScanCandidates.length),
        detail: `正在细扫 ${analysis.prepared.asset.displayName}`,
        extra: {
          projectId: input.projectId,
          projectName: project.name,
          assetId: analysis.prepared.asset.id,
          fineScanMode: analysis.report.fineScanMode,
        },
      });

      const fineScan = await generateFineScanOutput({
        analysis,
        projectRoot,
        roots,
        runtimeConfig,
        getMlHandle,
      });
      const updatedReport = reconcileFineScanReport({
        report: analysis.report,
        slices: fineScan.slices,
        droppedInvalidSliceCount: fineScan.droppedInvalidSliceCount,
      });
      if (updatedReport !== analysis.report) {
        analysis.report = updatedReport;
        await writeAssetReport(projectRoot, updatedReport);
      }

      if (fineScan.slices.length > 0) {
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
          fileName: analysis.prepared.asset.displayName,
          fileIndex,
          fileTotal: fineScanCandidates.length,
          current: fileIndex,
          total: fineScanCandidates.length,
          unit: 'files',
          etaSeconds: estimateRemainingSeconds(startedAtMs, fineScannedAssetIds.length, fineScanCandidates.length),
          detail: `已为 ${analysis.prepared.asset.displayName} 生成 ${fineScan.slices.length} 个候选切片`,
          extra: {
            projectId: input.projectId,
            projectName: project.name,
            assetId: analysis.prepared.asset.id,
            fineScanMode: updatedReport.fineScanMode,
            sliceCount: fineScan.slices.length,
          },
        });
        await appendSlices(projectRoot, fineScan.slices);
        pendingSlices.push(...fineScan.slices);
        fineScannedAssetIds.push(analysis.prepared.asset.id);
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

interface IPreparedAssetAnalysis extends IAnalyzeSingleAssetInput {
  shotBoundaries: IShotBoundary[];
  sampleFrames: { timeMs: number; path: string }[];
  coarseSampleTimestamps: number[];
  visualSummary: IRecognition | null;
  initialClipTypeGuess: EClipType;
  hasAudioTrack: boolean;
}

interface IFinalizePreparedAssetInput {
  prepared: IPreparedAssetAnalysis;
  projectRoot: string;
  roots: IMediaRoot[];
  manualItinerary: ILoadedManualItinerary;
  pathTimezones: IPathTimezoneOverride[];
  budget?: ETargetBudget;
  getMlHandle: () => Promise<MlAvailability>;
  onStageChange?: (stage: 'audio-analysis', detail?: string) => Promise<void>;
}

interface IFinalizedAssetAnalysis {
  prepared: IPreparedAssetAnalysis;
  report: IAssetCoarseReport;
  transcript?: ITranscriptContext | null;
  clipType: EClipType;
  decisionReasons: string[];
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

interface IManualSpatialContext {
  gpsSummary?: string;
  placeHints: string[];
  transport?: 'drive' | 'walk' | 'train' | 'flight' | 'boat' | 'mixed';
  decisionReasons: string[];
}

async function prepareAssetVisualCoarse(
  input: IAnalyzeSingleAssetInput,
): Promise<IPreparedAssetAnalysis> {
  if (input.asset.kind === 'photo') {
    return preparePhotoVisualCoarse(input);
  }
  if (input.asset.kind === 'audio') {
    return {
      ...input,
      shotBoundaries: [],
      sampleFrames: [],
      coarseSampleTimestamps: [],
      visualSummary: null,
      initialClipTypeGuess: 'unknown',
      hasAudioTrack: false,
    };
  }

  const shotBoundaries = await detectShots(
    input.localPath,
    0.3,
    input.runtimeConfig,
  ).catch(() => [] as IShotBoundary[]);
  const sampleTimestamps = buildCoarseSampleTimestamps(
    input.asset.durationMs ?? 0,
    pickCoarseSampleCount(input.asset.durationMs ?? 0),
  );
  const extractedFrames = await extractKeyframes(
    input.localPath,
    buildAssetTempDir(input.projectRoot, input.asset.id),
    sampleTimestamps,
    input.runtimeConfig,
  );
  const sampleFrames = await filterExistingKeyframes(extractedFrames);
  const visualSummary = await summarizeSamples(await input.getMlHandle(), sampleFrames);
  const hasAudioTrack = await resolveAssetHasAudioTrack(
    input.asset,
    input.localPath,
    input.runtimeConfig,
  );

  return {
    ...input,
    shotBoundaries,
    sampleFrames,
    coarseSampleTimestamps: sampleTimestamps,
    visualSummary,
    initialClipTypeGuess: guessClipType(input.asset, shotBoundaries),
    hasAudioTrack,
  };
}

async function finalizePreparedAsset(
  input: IFinalizePreparedAssetInput,
): Promise<IFinalizedAssetAnalysis> {
  if (input.prepared.asset.kind === 'photo') {
    return finalizePhotoPreparedAsset(input);
  }
  if (input.prepared.asset.kind === 'audio') {
    return {
      prepared: input.prepared,
      report: buildAudioAssetReport(input.prepared.asset),
      clipType: 'unknown',
      decisionReasons: ['audio-assets-skip-visual-fine-scan'],
    };
  }

  const ml = await input.getMlHandle();
  if (shouldAnalyzeAudioTrack(input.prepared.asset, input.prepared.hasAudioTrack)) {
    await input.onStageChange?.('audio-analysis', `正在分析 ${input.prepared.asset.displayName} 的视频内音轨`);
  }
  const transcript = await maybeTranscribeAsset({
    asset: input.prepared.asset,
    localPath: input.prepared.localPath,
    hasAudioTrack: input.prepared.hasAudioTrack,
    ml,
  });
  const density = estimateDensity({
    durationMs: input.prepared.asset.durationMs ?? 0,
    shotBoundaries: input.prepared.shotBoundaries,
    asrSegments: transcript?.segments.map(segment => ({
      start: segment.startMs / 1000,
      end: segment.endMs / 1000,
      text: segment.text,
    })),
  });
  const root = input.roots.find(item => item.id === input.prepared.asset.ingestRootId);
  const manualSpatial = resolveManualSpatialContext({
    asset: input.prepared.asset,
    root,
    itinerary: input.manualItinerary,
    pathTimezones: input.pathTimezones,
  });
  const plan = buildAnalysisPlan({
    assetId: input.prepared.asset.id,
    durationMs: input.prepared.asset.durationMs ?? 0,
    density,
    shotBoundaries: input.prepared.shotBoundaries,
    clipType: input.prepared.initialClipTypeGuess,
    budget: input.budget,
    extraInterestingWindows: transcript?.speechWindows,
  });
  const decision = await resolveUnifiedAnalysisDecision({
    prepared: input.prepared,
    transcript,
    densityScore: density.score,
    basePlan: plan,
    budget: input.budget,
    ml,
    manualSpatial,
  });
  const effectivePlan = applyDriveFallbackWindows(
    applyAnalysisDecision(plan, decision),
    decision.clipType,
    input.prepared.asset.durationMs ?? 0,
    input.budget,
    input.prepared.coarseSampleTimestamps,
  );
  const report = buildAssetCoarseReport({
    asset: input.prepared.asset,
    plan: effectivePlan,
    clipTypeGuess: decision.clipType,
    gpsSummary: manualSpatial?.gpsSummary,
    summary: input.prepared.visualSummary?.description,
    transcript: transcript?.transcript,
    transcriptSegments: transcript?.segments,
    speechCoverage: transcript?.speechCoverage,
    labels: buildReportLabels(
      decision.clipType,
      input.prepared.visualSummary?.sceneType,
      input.prepared.visualSummary?.subjects,
      transcript,
    ),
    placeHints: dedupeStrings([
      ...(input.prepared.visualSummary?.placeHints ?? []),
      ...(manualSpatial?.placeHints ?? []),
    ]),
    rootNotes: root?.notes ?? [],
    sampleFrames: input.prepared.sampleFrames,
    fineScanReasons: buildFineScanReasons(
      effectivePlan,
      density,
      input.prepared.shotBoundaries,
      transcript,
      dedupeStrings([
        ...decision.decisionReasons,
        ...(manualSpatial?.decisionReasons ?? []),
      ]),
    ),
  });

  return {
    prepared: input.prepared,
    report,
    transcript,
    clipType: decision.clipType,
    decisionReasons: dedupeStrings([
      ...decision.decisionReasons,
      ...(manualSpatial?.decisionReasons ?? []),
    ]),
  };
}

function resolveManualSpatialContext(input: {
  asset: IKtepAsset;
  root?: IMediaRoot;
  itinerary: ILoadedManualItinerary;
  pathTimezones: IPathTimezoneOverride[];
}): IManualSpatialContext | null {
  const matched = pickManualItinerarySegment(input);
  if (!matched) return null;

  const placeHints = dedupeStrings([
    matched.segment.location,
    ...splitManualPlaceHints(matched.segment.location),
    matched.segment.from,
    matched.segment.to,
    ...(matched.segment.via ?? []),
  ]);

  return {
    gpsSummary: buildManualSpatialSummary(matched.segment, matched.timezone),
    placeHints,
    transport: matched.segment.transport,
    decisionReasons: dedupeStrings([
      'manual-itinerary-match',
      matched.segment.transport ? `manual-transport:${matched.segment.transport}` : undefined,
      placeHints.length > 0 ? `manual-spatial-hints:${placeHints.length}` : undefined,
    ]),
  };
}

function pickManualItinerarySegment(input: {
  asset: IKtepAsset;
  root?: IMediaRoot;
  itinerary: ILoadedManualItinerary;
  pathTimezones: IPathTimezoneOverride[];
}): { segment: ILoadedManualItinerary['segments'][number]; timezone: string } | null {
  if (!input.asset.capturedAt || input.itinerary.segments.length === 0) return null;

  const assetTimezone = resolveAssetSpatialTimezone(input.asset, input.root, input.pathTimezones);
  let best: { segment: ILoadedManualItinerary['segments'][number]; timezone: string } | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;

  for (const segment of input.itinerary.segments) {
    if (!matchesManualItineraryRoot(segment.rootRef, input.root)) continue;
    if (!matchesManualItineraryPath(segment.pathPrefix, input.asset.sourcePath, input.root)) continue;

    const timezone = segment.timezone?.trim()
      || input.itinerary.defaultTimezone?.trim()
      || assetTimezone;
    if (!timezone) continue;

    const localCapture = formatDateInTimeZone(input.asset.capturedAt, timezone);
    if (!localCapture) continue;
    if (localCapture.date !== segment.date) continue;
    if (!matchesManualItineraryTimeWindow(localCapture.hourMinute, segment.startLocalTime, segment.endLocalTime)) {
      continue;
    }

    const score = (segment.pathPrefix ? 10000 + segment.pathPrefix.length : 0)
      + (segment.rootRef ? 1000 : 0)
      + (segment.timezone ? 100 : 0)
      + (segment.startLocalTime || segment.endLocalTime ? 10 : 0)
      + (segment.location ? 5 : 0)
      + (segment.transport ? 2 : 0);

    if (score > bestScore) {
      best = { segment, timezone };
      bestScore = score;
    }
  }

  return best;
}

function resolveAssetSpatialTimezone(
  asset: IKtepAsset,
  root: IMediaRoot | undefined,
  pathTimezones: IPathTimezoneOverride[],
): string | undefined {
  const metadataTimezone = readMetadataString(asset.metadata, 'effectiveTimezone');
  if (metadataTimezone) return metadataTimezone;

  const override = matchPathTimezoneOverride({
    overrides: pathTimezones,
    rootId: root?.id,
    rootLabel: root?.label,
    sourcePath: asset.sourcePath,
  });
  return override?.timezone ?? root?.defaultTimezone;
}

function matchesManualItineraryRoot(
  rootRef: string | undefined,
  root?: IMediaRoot,
): boolean {
  if (!rootRef) return true;
  const normalized = rootRef.trim().toLowerCase();
  return normalized === (root?.id ?? '').trim().toLowerCase()
    || normalized === (root?.label ?? '').trim().toLowerCase();
}

function matchesManualItineraryPath(
  pathPrefix: string | undefined,
  sourcePath: string,
  root?: IMediaRoot,
): boolean {
  if (!pathPrefix) return true;
  const pathCandidates = buildPortablePathCandidates(sourcePath, root);
  return pathCandidates.some(candidate => candidate === pathPrefix || candidate.startsWith(`${pathPrefix}/`));
}

function matchesManualItineraryTimeWindow(
  localTime: string,
  startLocalTime?: string,
  endLocalTime?: string,
): boolean {
  if (!startLocalTime && !endLocalTime) return true;

  const time = parseHourMinute(localTime);
  const start = parseHourMinute(startLocalTime ?? '00:00');
  const end = parseHourMinute(endLocalTime ?? '23:59');
  if (time == null || start == null || end == null) return false;

  if (end >= start) {
    return time >= start && time <= end;
  }
  return time >= start || time <= end;
}

function buildManualSpatialSummary(
  segment: ILoadedManualItinerary['segments'][number],
  timezone: string,
): string {
  const route = segment.location
    ?? ([segment.from, segment.to].filter(Boolean).join(' -> ')
      || (segment.via ?? []).join(' -> '));
  const timeWindow = segment.startLocalTime && segment.endLocalTime
    ? `${segment.startLocalTime}-${segment.endLocalTime}`
    : 'all-day';
  const transport = segment.transport ? ` ${segment.transport}` : '';
  const notes = segment.notes ? `; ${segment.notes}` : '';
  return `manual-itinerary ${segment.date} ${timeWindow} ${route}${transport} @${timezone}${notes}`.trim();
}

function splitManualPlaceHints(value?: string): string[] {
  if (!value) return [];
  return value
    .split(/[、,/，>|→-]+/u)
    .map(item => item.trim())
    .filter(Boolean);
}

function normalizePortablePath(value: string): string {
  return value
    .trim()
    .replace(/\\/gu, '/')
    .replace(/^\.?\//u, '')
    .replace(/\/+/gu, '/')
    .replace(/\/$/u, '')
    .toLowerCase();
}

function buildPortablePathCandidates(sourcePath: string, root?: IMediaRoot): string[] {
  const normalizedSource = normalizePortablePath(sourcePath);
  const candidates = new Set<string>([normalizedSource]);
  const normalizedRootLabel = root?.label ? normalizePortablePath(root.label) : undefined;
  const normalizedRootId = root?.id ? normalizePortablePath(root.id) : undefined;

  if (normalizedRootLabel) {
    candidates.add(`${normalizedRootLabel}/${normalizedSource}`);
  }
  if (normalizedRootId) {
    candidates.add(`${normalizedRootId}/${normalizedSource}`);
  }

  return [...candidates];
}

function parseHourMinute(value: string): number | null {
  const match = value.trim().match(/^(\d{2}):(\d{2})$/u);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  return hour * 60 + minute;
}

async function resolveUnifiedAnalysisDecision(input: {
  prepared: IPreparedAssetAnalysis;
  transcript?: ITranscriptContext | null;
  densityScore: number;
  basePlan: IMediaAnalysisPlan;
  budget?: ETargetBudget;
  ml: MlAvailability;
  manualSpatial?: IManualSpatialContext | null;
}): Promise<IAnalysisDecision> {
  const fallbackDecision = buildHeuristicAnalysisDecision({
    durationMs: input.prepared.asset.durationMs ?? 0,
    densityScore: input.densityScore,
    interestingWindowCount: input.basePlan.interestingWindows.length,
    clipType: input.prepared.initialClipTypeGuess,
    initialClipTypeGuess: input.prepared.initialClipTypeGuess,
    budget: input.budget,
    sceneType: input.prepared.visualSummary?.sceneType,
    subjects: input.prepared.visualSummary?.subjects,
    summary: input.prepared.visualSummary?.description,
    transcript: input.transcript?.transcript,
    speechCoverage: input.transcript?.speechCoverage,
    hasAudioTrack: input.prepared.hasAudioTrack,
    hasMeaningfulSpeech: hasMeaningfulSpeech(input.transcript),
    routeTransport: input.manualSpatial?.transport,
    spatialHintCount: input.manualSpatial?.placeHints.length,
  });

  const inferredDecision = await inferUnifiedAnalysisDecision(input);
  if (!inferredDecision) return fallbackDecision;

  return reconcileUnifiedAnalysisDecision({
    candidate: inferredDecision,
    fallback: fallbackDecision,
    basePlan: input.basePlan,
    budget: input.budget,
    hasMeaningfulSpeech: hasMeaningfulSpeech(input.transcript),
  });
}

async function inferUnifiedAnalysisDecision(input: {
  prepared: IPreparedAssetAnalysis;
  transcript?: ITranscriptContext | null;
  densityScore: number;
  basePlan: IMediaAnalysisPlan;
  budget?: ETargetBudget;
  ml: MlAvailability;
  manualSpatial?: IManualSpatialContext | null;
}): Promise<IAnalysisDecision | null> {
  if (!input.ml.available) return null;

  const framePaths = pickRepresentativeFramePaths(
    input.prepared.sampleFrames.map(frame => frame.path),
    6,
  );
  if (framePaths.length === 0) return null;

  try {
    const result = await input.ml.client.vlmAnalyze(
      framePaths,
      buildUnifiedDecisionPrompt({
        prepared: input.prepared,
        transcript: input.transcript,
        densityScore: input.densityScore,
        basePlan: input.basePlan,
        budget: input.budget,
        manualSpatial: input.manualSpatial,
      }),
    );
    return parseUnifiedAnalysisDecision(result.description);
  } catch {
    return null;
  }
}

function reconcileUnifiedAnalysisDecision(input: {
  candidate: IAnalysisDecision;
  fallback: IAnalysisDecision;
  basePlan: IMediaAnalysisPlan;
  budget?: ETargetBudget;
  hasMeaningfulSpeech: boolean;
}): IAnalysisDecision {
  const budget = input.budget ?? 'standard';
  if (budget === 'coarse') {
    return {
      ...input.fallback,
      shouldFineScan: false,
      fineScanMode: 'skip',
      decisionReasons: dedupeStrings([
        ...input.fallback.decisionReasons,
        'budget:coarse',
        'fine-scan:skip',
      ]),
    };
  }

  const decision: IAnalysisDecision = {
    ...input.candidate,
    decisionReasons: [...input.candidate.decisionReasons],
  };

  if (decision.clipType === 'unknown' && input.fallback.clipType !== 'unknown') {
    decision.clipType = input.fallback.clipType;
    decision.decisionReasons.push(`fallback-clip:${input.fallback.clipType}`);
  }

  const hasCredibleWindows = input.basePlan.interestingWindows.length > 0;
  if (decision.fineScanMode === 'skip' && (hasCredibleWindows || input.hasMeaningfulSpeech)) {
    decision.fineScanMode = input.fallback.fineScanMode === 'full' ? 'full' : 'windowed';
    decision.shouldFineScan = true;
    decision.decisionReasons.push(
      hasCredibleWindows
        ? 'guardrail:interesting-window-promoted'
        : 'guardrail:meaningful-speech-promoted',
    );
  }

  if (decision.fineScanMode === 'skip') {
    decision.shouldFineScan = false;
  } else if (!decision.shouldFineScan) {
    decision.shouldFineScan = true;
  }

  const inheritedFallbackReasons = input.fallback.decisionReasons.filter(reason => {
    if (reason.startsWith('semantic-clip:')) return reason === `semantic-clip:${decision.clipType}`;
    if (reason.startsWith('fine-scan:')) return reason === `fine-scan:${decision.fineScanMode}`;
    if (reason.startsWith('clip-type-corrected:')) return false;
    return true;
  });

  return {
    ...decision,
    decisionReasons: dedupeStrings([
      ...inheritedFallbackReasons,
      ...decision.decisionReasons,
      `semantic-clip:${decision.clipType}`,
      `fine-scan:${decision.fineScanMode}`,
    ]),
  };
}

function applyDriveFallbackWindows(
  plan: IMediaAnalysisPlan,
  clipType: EClipType,
  durationMs: number,
  budget: ETargetBudget | undefined,
  sampleTimestamps: number[],
): IMediaAnalysisPlan {
  if (clipType !== 'drive') return plan;
  if ((budget ?? 'standard') === 'coarse') return plan;
  if (!plan.shouldFineScan || plan.fineScanMode === 'skip') return plan;
  if (plan.interestingWindows.length > 0) return plan;
  if (plan.fineScanMode === 'full') return plan;

  const fallbackWindows = buildDriveFallbackWindows(durationMs, sampleTimestamps);
  if (fallbackWindows.length === 0) return plan;

  return {
    ...plan,
    interestingWindows: fallbackWindows,
  };
}

async function maybeTranscribeAsset(input: {
  asset: IKtepAsset;
  localPath: string;
  hasAudioTrack: boolean;
  ml: MlAvailability;
}): Promise<ITranscriptContext | null> {
  if (!input.ml.available) return null;
  if (!shouldAnalyzeAudioTrack(input.asset, input.hasAudioTrack)) return null;

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

function shouldAnalyzeAudioTrack(
  asset: IKtepAsset,
  hasAudioTrack: boolean,
): boolean {
  if (asset.kind !== 'video') return false;
  if (!hasAudioTrack) return false;
  return (asset.durationMs ?? 0) > 0;
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

function hasMeaningfulSpeech(
  transcript?: ITranscriptContext | null,
): boolean {
  if (!transcript) return false;

  const compactTranscript = transcript.transcript.replace(/\s+/g, '');
  if (compactTranscript.length >= 20) return true;
  if (transcript.segments.length >= 2 && transcript.speechCoverage >= 0.08) return true;
  return transcript.speechCoverage >= 0.18;
}

function buildUnifiedDecisionPrompt(input: {
  prepared: IPreparedAssetAnalysis;
  transcript?: ITranscriptContext | null;
  densityScore: number;
  basePlan: IMediaAnalysisPlan;
  budget?: ETargetBudget;
  manualSpatial?: IManualSpatialContext | null;
}): string {
  const transcriptExcerpt = buildTranscriptExcerpt(input.transcript) ?? 'none';
  const signalPayload = JSON.stringify({
    duration_ms: input.prepared.asset.durationMs ?? 0,
    budget: input.budget ?? 'standard',
    initial_clip_type_guess: input.prepared.initialClipTypeGuess,
    density_score: Number(input.densityScore.toFixed(3)),
    shot_count: input.prepared.shotBoundaries.length,
    has_audio_track: input.prepared.hasAudioTrack,
    speech_coverage: Number((input.transcript?.speechCoverage ?? 0).toFixed(3)),
    has_meaningful_speech: hasMeaningfulSpeech(input.transcript),
    visual_scene_type: input.prepared.visualSummary?.sceneType ?? 'unknown',
    visual_subjects: input.prepared.visualSummary?.subjects ?? [],
    visual_description: input.prepared.visualSummary?.description ?? '',
    place_hints: input.prepared.visualSummary?.placeHints ?? [],
    manual_spatial_summary: input.manualSpatial?.gpsSummary ?? '',
    manual_spatial_hints: input.manualSpatial?.placeHints ?? [],
    manual_transport: input.manualSpatial?.transport ?? '',
    interesting_windows: input.basePlan.interestingWindows.map(window => ({
      start_ms: window.startMs,
      end_ms: window.endMs,
      reason: window.reason,
    })),
    transcript_excerpt: transcriptExcerpt,
  }, null, 2);

  return `You are deciding semantic clip type and fine-scan policy for a travel documentary editing system.
Return only a raw JSON object with:
{
  "clip_type": "drive" | "talking-head" | "aerial" | "timelapse" | "broll" | "unknown",
  "should_fine_scan": boolean,
  "fine_scan_mode": "skip" | "windowed" | "full",
  "decision_reasons": string[]
}

Rules:
- Use both the images and the textual signals below.
- Final clip_type must be semantic, not just based on duration heuristics.
- Strong audio means meaningful human speech. Background music, engine noise, road noise, ambience, or other non-speech sounds do not count as strong audio.
- Manual itinerary and spatial hints are weak evidence: useful for place/route inference, but weaker than clear visual or speech contradictions.
- If the frames clearly show sustained driving or road footage, prefer "drive" even when the initial heuristic guess is "unknown".
- If either visual or speech evidence indicates promising regions, prefer "windowed" over "skip".
- Use "full" only for short high-value clips or when both visual and speech signals are strong.

Signals:
${signalPayload}`;
}

function parseUnifiedAnalysisDecision(raw: string): IAnalysisDecision | null {
  const parsed = tryParseJsonObject(raw);
  if (!parsed || typeof parsed !== 'object') return null;

  const clipType = normalizeClipType((parsed as Record<string, unknown>)['clip_type']
    ?? (parsed as Record<string, unknown>)['clipType']);
  const fineScanMode = normalizeFineScanMode((parsed as Record<string, unknown>)['fine_scan_mode']
    ?? (parsed as Record<string, unknown>)['fineScanMode']);

  if (!clipType || !fineScanMode) return null;

  const rawShouldFineScan = (parsed as Record<string, unknown>)['should_fine_scan']
    ?? (parsed as Record<string, unknown>)['shouldFineScan'];
  const shouldFineScan = typeof rawShouldFineScan === 'boolean'
    ? rawShouldFineScan && fineScanMode !== 'skip'
    : fineScanMode !== 'skip';
  const decisionReasons = Array.isArray((parsed as Record<string, unknown>)['decision_reasons'])
    ? ((parsed as Record<string, unknown>)['decision_reasons'] as unknown[])
      .filter((value): value is string => typeof value === 'string')
    : [];

  return {
    clipType,
    shouldFineScan,
    fineScanMode,
    decisionReasons,
  };
}

function tryParseJsonObject(raw: string): unknown {
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;
  try {
    return JSON.parse(jsonMatch[0]);
  } catch {
    return null;
  }
}

function normalizeClipType(value: unknown): EClipType | null {
  if (typeof value !== 'string') return null;

  const normalized = value.trim().toLowerCase();
  if (normalized === 'driving') return 'drive';
  if (normalized === 'portrait') return 'talking-head';
  if (normalized === 'time-lapse' || normalized === 'time lapse') return 'timelapse';
  if (normalized === 'drive'
    || normalized === 'talking-head'
    || normalized === 'aerial'
    || normalized === 'timelapse'
    || normalized === 'broll'
    || normalized === 'unknown') {
    return normalized;
  }
  return null;
}

function normalizeFineScanMode(value: unknown): 'skip' | 'windowed' | 'full' | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'skip' || normalized === 'windowed' || normalized === 'full') {
    return normalized;
  }
  return null;
}

function buildTranscriptExcerpt(
  transcript?: ITranscriptContext | null,
  maxLength = 480,
): string | undefined {
  if (!transcript) return undefined;

  const source = transcript.segments.length > 0
    ? transcript.segments
      .slice(0, 8)
      .map(segment => segment.text.trim())
      .filter(Boolean)
      .join(' ')
    : transcript.transcript.trim();
  if (!source) return undefined;
  if (source.length <= maxLength) return source;
  return `${source.slice(0, Math.max(0, maxLength - 3)).trim()}...`;
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

async function preparePhotoVisualCoarse(
  input: IAnalyzeSingleAssetInput,
): Promise<IPreparedAssetAnalysis> {
  const proxyFrame = await extractImageProxy(
    input.localPath,
    buildAssetTempDir(input.projectRoot, input.asset.id),
    input.runtimeConfig,
  );
  const sampleFrames = proxyFrame ? [proxyFrame] : [];
  const visualSummary = await summarizeSamples(await input.getMlHandle(), sampleFrames);

  return {
    ...input,
    shotBoundaries: [],
    sampleFrames,
    coarseSampleTimestamps: [0],
    visualSummary,
    initialClipTypeGuess: 'broll',
    hasAudioTrack: false,
  };
}

async function finalizePhotoPreparedAsset(
  input: IFinalizePreparedAssetInput,
): Promise<IFinalizedAssetAnalysis> {
  const density = estimateDensity({ durationMs: 0, shotBoundaries: [] });
  const clipTypeGuess: EClipType = 'broll';
  const root = input.roots.find(item => item.id === input.prepared.asset.ingestRootId);
  const manualSpatial = resolveManualSpatialContext({
    asset: input.prepared.asset,
    root,
    itinerary: input.manualItinerary,
    pathTimezones: input.pathTimezones,
  });
  const plan = buildAnalysisPlan({
    assetId: input.prepared.asset.id,
    durationMs: 0,
    density,
    shotBoundaries: [],
    clipType: clipTypeGuess,
    budget: input.budget,
  });

  const report = buildAssetCoarseReport({
    asset: input.prepared.asset,
    plan,
    clipTypeGuess,
    gpsSummary: manualSpatial?.gpsSummary,
    summary: input.prepared.visualSummary?.description,
    labels: buildReportLabels(
      clipTypeGuess,
      input.prepared.visualSummary?.sceneType,
      input.prepared.visualSummary?.subjects,
    ),
    placeHints: dedupeStrings([
      ...(input.prepared.visualSummary?.placeHints ?? []),
      ...(manualSpatial?.placeHints ?? []),
    ]),
    rootNotes: root?.notes ?? [],
    sampleFrames: input.prepared.sampleFrames,
    shouldFineScan: true,
    fineScanMode: 'full',
    fineScanReasons: dedupeStrings([
      'photo-assets-are-directly-usable',
      ...(manualSpatial?.decisionReasons ?? []),
    ]),
  });

  return {
    prepared: input.prepared,
    report,
    clipType: clipTypeGuess,
    decisionReasons: dedupeStrings([
      'photo-assets-are-directly-usable',
      ...(manualSpatial?.decisionReasons ?? []),
    ]),
  };
}

function buildAudioAssetReport(
  asset: IKtepAsset,
): IAssetCoarseReport {
  return buildAssetCoarseReport({
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
}

async function generateFineScanOutput(input: {
  analysis: IFinalizedAssetAnalysis;
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
  getMlHandle: () => Promise<MlAvailability>;
}): Promise<IFineScanSlicesResult> {
  if (!input.analysis.report.shouldFineScan) {
    return { slices: [], droppedInvalidSliceCount: 0 };
  }

  if (input.analysis.prepared.asset.kind === 'photo') {
    const slice = slicePhoto(input.analysis.prepared.asset);
    slice.summary = input.analysis.report.summary;
    slice.labels = input.analysis.report.labels;
    slice.placeHints = input.analysis.report.placeHints;
    return {
      slices: [slice],
      droppedInvalidSliceCount: 0,
    };
  }

  if (input.analysis.prepared.asset.kind === 'audio') {
    return { slices: [], droppedInvalidSliceCount: 0 };
  }

  return buildFineScanSlices({
    asset: input.analysis.prepared.asset,
    localPath: input.analysis.prepared.localPath,
    projectRoot: input.projectRoot,
    roots: input.roots,
    runtimeConfig: input.runtimeConfig,
    shotBoundaries: input.analysis.prepared.shotBoundaries,
    report: input.analysis.report,
    transcript: input.analysis.transcript,
    clipType: input.analysis.clipType,
    ml: await input.getMlHandle(),
  });
}

function describeDecisionStage(
  asset: IKtepAsset,
  hasAudioTrack: boolean,
): string {
  if (asset.kind === 'photo') {
    return `正在整理 ${asset.displayName} 的视觉粗扫结果并判断切片策略`;
  }
  if (asset.kind === 'audio') {
    return `正在整理 ${asset.displayName} 的粗扫结果`;
  }
  if (shouldAnalyzeAudioTrack(asset, hasAudioTrack)) {
    return `正在结合视觉粗扫与音轨结果判断 ${asset.displayName} 是否值得细扫`;
  }
  return `未检测到可用音轨，正在根据视觉粗扫结果判断 ${asset.displayName} 是否值得细扫`;
}

async function resolveAssetHasAudioTrack(
  asset: IKtepAsset,
  localPath: string,
  runtimeConfig: IAnalyzeSingleAssetInput['runtimeConfig'],
): Promise<boolean> {
  if (asset.kind !== 'video') return false;

  const metadataFlag = readMetadataBoolean(asset.metadata, 'hasAudioStream');
  if (typeof metadataFlag === 'boolean') {
    return metadataFlag;
  }

  try {
    const probed = await probe(localPath, runtimeConfig);
    return probed.hasAudioStream;
  } catch {
    // If probing fails, prefer attempting ASR over silently suppressing audio analysis.
    return true;
  }
}

function readMetadataBoolean(
  metadata: IKtepAsset['metadata'],
  key: string,
): boolean | undefined {
  if (!metadata || typeof metadata !== 'object') return undefined;
  const value = metadata[key];
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value > 0;
  if (typeof value === 'string') {
    if (value === 'true') return true;
    if (value === 'false') return false;
  }
  return undefined;
}

function readMetadataString(
  metadata: IKtepAsset['metadata'],
  key: string,
): string | undefined {
  if (!metadata || typeof metadata !== 'object') return undefined;
  const value = metadata[key];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
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
  decisionReasons: string[] = [],
): string[] {
  const reasons = new Set<string>(decisionReasons);
  if (!reportPlan.shouldFineScan) {
    reasons.add('coarse-scan-sufficient');
    return [...reasons];
  }
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
  clipType: EClipType;
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
      mapClipTypeToSliceType(input.clipType),
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
        mapClipTypeToSliceType(input.clipType),
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
