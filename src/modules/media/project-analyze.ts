import { join } from 'node:path';
import { access, stat } from 'node:fs/promises';
import { freemem } from 'node:os';
import type {
  EClipType,
  ETargetBudget,
  IAssetCoarseReport,
  IDeviceMediaMapFile,
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
  loadAudioAnalysisCheckpoint,
  loadAssetReports,
  loadAssets,
  loadChronology,
  loadProjectDeviceMediaMaps,
  loadIngestRoots,
  loadPreparedAssetCheckpoint,
  loadProjectDerivedTrack,
  loadProject,
  loadRuntimeConfig,
  loadSlices,
  removeAudioAnalysisCheckpoint,
  removePreparedAssetCheckpoint,
  resolveWorkspaceProjectRoot,
  getProjectProgressPath,
  loadFineScanCheckpoint,
  touchProjectUpdatedAt,
  writeKairosProgress,
  writeChronology,
  writeAssetReport,
  writeAudioAnalysisCheckpoint,
  writeFineScanCheckpoint,
  writePreparedAssetCheckpoint,
  removeFineScanCheckpoint,
  type IProjectDerivedTrack,
  type IFineScanCheckpoint,
} from '../../store/index.js';
import { buildAssetCoarseReport } from './asset-report.js';
import {
  AnalyzePerformanceSession,
  shouldEnableAnalyzePerformanceProfile,
  type IAnalyzePerformanceProfileOptions,
  type TAnalyzeSceneDetectPhase,
} from './analyze-profile.js';
import {
  analyzeAudioHealth,
  recommendProtectedAudioFallback,
  summarizeAudioHealth,
} from './audio-health.js';
import { buildMediaChronology } from './chronology.js';
import { estimateDensity, type IDensityResult } from './density.js';
import {
  uniformTimestamps,
  extractImageProxy,
  extractKeyframes,
  groupKeyframesByShot,
  sampleRangeTimestamps,
  type IKeyframeResult,
  type IShotKeyframePlan,
} from './keyframe.js';
import { MlClient } from './ml-client.js';
import { probe } from './probe.js';
import { canUseProtectionAudio, resolveProtectionAudioLocalPath } from './protection-audio.js';
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
import { resolveProjectGpxPaths } from './project-gps.js';
import { resolveAssetSpatialContext } from './spatial-resolver.js';
import type { IManualSpatialContext } from './manual-spatial.js';
import {
  hasMeaningfulSpeech,
  normalizeTranscriptContext,
  type ITranscriptContext,
} from './transcript-signal.js';
import { transcribe, type ITranscription } from './transcriber.js';
import { enforceProjectTimelineConsistency } from './timeline-consistency.js';
import {
  applyTypeAwareWindowExpansion,
  buildDriveSpeedCandidate,
  isSpeechSemanticWindow,
  mergeInterestingWindowsByPreferredBounds,
  resolveWindowPreferredRange,
} from './window-policy.js';

export interface IAnalyzeWorkspaceProjectInput {
  workspaceRoot: string;
  projectId: string;
  assetIds?: string[];
  deviceMapPath?: string;
  gpxPaths?: string[];
  gpxMatchToleranceMs?: number;
  budget?: ETargetBudget;
  progressPath?: string;
  performanceProfile?: IAnalyzePerformanceProfileOptions;
}

export interface IAnalyzeWorkspaceProjectResult {
  projectRoot: string;
  analyzedAssetIds: string[];
  fineScannedAssetIds: string[];
  missingRoots: IMediaRoot[];
  reportCount: number;
  sliceCount: number;
  mlUsed: boolean;
  performanceProfilePath?: string;
}

const CANALYZE_STEP_DEFINITIONS = [
  { key: 'prepare', label: '准备素材分析' },
  { key: 'coarse-scan', label: '粗扫素材' },
  { key: 'audio-analysis', label: '分析视频内音轨' },
  { key: 'finalize', label: '统一完成素材分析' },
  { key: 'fine-scan-prefetch', label: '预抽细扫关键帧' },
  { key: 'fine-scan-recognition', label: '识别细扫素材' },
  { key: 'chronology', label: '刷新时间视图' },
] as const;
const CAUDIO_ANALYSIS_KEEP_OTHER_MODELS_LOADED = true;
const CFINE_SCAN_PREFETCH_DEFAULTS = {
  baseConcurrency: 1,
  maxConcurrency: 3,
  minFreeMemoryMb: 2048,
  maxReadyAssets: 6,
  maxReadyFrameMb: 768,
} as const;

export async function analyzeWorkspaceProjectMedia(
  input: IAnalyzeWorkspaceProjectInput,
): Promise<IAnalyzeWorkspaceProjectResult> {
  const projectRoot = resolveWorkspaceProjectRoot(input.workspaceRoot, input.projectId);
  const progressPath = input.progressPath ?? getProjectProgressPath(projectRoot, 'media-analyze');
  const startedAtMs = Date.now();
  const performance: AnalyzePerformanceSession | undefined = shouldEnableAnalyzePerformanceProfile(input.performanceProfile)
    ? new AnalyzePerformanceSession({
      projectId: input.projectId,
      projectRoot,
      budget: input.budget,
      requestedAssetIds: input.assetIds,
      options: input.performanceProfile,
    })
    : undefined;
  const performanceProfilePath = performance?.resolveOutputPath(input.performanceProfile?.outputPath);
  const [{ roots }, deviceMaps, runtimeConfig, assets, existingReports, existingSlices, project, derivedTrack] = await Promise.all([
    loadIngestRoots(projectRoot),
    loadProjectDeviceMediaMaps(projectRoot, input.deviceMapPath),
    loadRuntimeConfig(projectRoot),
    loadAssets(projectRoot),
    loadAssetReports(projectRoot),
    loadSlices(projectRoot),
    loadProject(projectRoot),
    loadProjectDerivedTrack(projectRoot),
  ]);
  const gpxPaths = await resolveProjectGpxPaths({
    projectRoot,
    gpxPaths: input.gpxPaths,
  });

  const requestedScope = input.assetIds?.length
    ? new Set(input.assetIds)
    : null;
  const progressScopeAssets = assets.filter(asset => (
    asset.kind !== 'audio'
    && (!requestedScope || requestedScope.has(asset.id))
  ));
  const pendingAssets = selectPendingAssets(assets, existingReports, input.assetIds);
  const pendingFineScanEntries = !input.assetIds?.length
    ? selectPendingFineScanEntries(assets, existingReports, existingSlices)
    : [];
  const progressTotal = progressScopeAssets.length;
  const progressBase = Math.max(0, progressTotal - pendingAssets.length);
  const toOverallProgressIndex = (localIndex: number) => Math.min(
    progressTotal,
    progressBase + Math.max(0, localIndex),
  );
  performance?.setAssetCount(pendingAssets.length);
  const analyzedAssetIds: string[] = [];
  const fineScannedAssetIds: string[] = [];
  const pendingSlices: IKtepSlice[] = [];
  const preparedAnalyses: IPreparedAssetAnalysis[] = [];
  const finalizedAnalyses: IFinalizedAssetAnalysis[] = [];
  let performanceFailureHandled = false;
  let mlHandle: MlAvailability | null = null;
  let mlUsed = false;
  const getMlHandle = async () => {
    if (!mlHandle) {
      const healthStartedAt = Date.now();
      mlHandle = await createMlAvailability(runtimeConfig.mlServerUrl);
      performance?.recordMlHealthCheck(Date.now() - healthStartedAt);
    }
    if (!mlHandle.available) {
      throw new Error(buildMlUnavailableErrorMessage(runtimeConfig.mlServerUrl));
    }
    mlUsed = true;
    return mlHandle;
  };
  const writeTrackedProgress = async (
    payload: Parameters<typeof writeKairosProgress>[1],
  ) => {
    const writeStartedAt = Date.now();
    const result = await writeKairosProgress(progressPath, payload);
    performance?.recordProgressWrite(Date.now() - writeStartedAt);
    return result;
  };
  const writeTrackedReport = async (
    asset: IKtepAsset,
    report: IAssetCoarseReport,
  ) => {
    const writeStartedAt = Date.now();
    await writeAssetReport(projectRoot, report);
    performance?.recordReportWrite(asset, Date.now() - writeStartedAt);
  };
  const appendTrackedSlices = async (
    asset: IKtepAsset,
    slices: IKtepSlice[],
  ) => {
    const writeStartedAt = Date.now();
    await appendSlices(projectRoot, slices);
    performance?.recordSliceAppend(asset, slices.length, Date.now() - writeStartedAt);
  };
  const writeTrackedChronology = async (
    chronology: Awaited<ReturnType<typeof loadChronology>>,
  ) => {
    const writeStartedAt = Date.now();
    await writeChronology(projectRoot, chronology);
    performance?.recordChronologyWrite(Date.now() - writeStartedAt);
  };
  const flushPerformance = async () => {
    if (!performance || !performanceProfilePath) return;
    await performance.write(performanceProfilePath);
  };
  const resolveStepMeta = (step: typeof CANALYZE_STEP_DEFINITIONS[number]['key']) => {
    const stepIndex = CANALYZE_STEP_DEFINITIONS.findIndex(item => item.key === step);
    const definition = CANALYZE_STEP_DEFINITIONS[stepIndex];
    if (!definition) {
      throw new Error(`Unknown analyze step: ${step}`);
    }
    return {
      ...definition,
      stepIndex: stepIndex + 1,
      stepTotal: CANALYZE_STEP_DEFINITIONS.length,
    };
  };
  const writeAnalyzeStepProgress = async (inputStep: {
    step: typeof CANALYZE_STEP_DEFINITIONS[number]['key'];
    fileIndex?: number;
    fileTotal?: number;
    current?: number;
    total?: number;
    unit?: string;
    detail?: string;
    fileName?: string;
    etaSeconds?: number;
    extra?: Record<string, unknown>;
    status?: 'running' | 'succeeded' | 'failed';
  }) => {
    const stepMeta = resolveStepMeta(inputStep.step);
    await writeTrackedProgress({
      status: inputStep.status ?? 'running',
      pipelineKey: 'media-analyze',
      pipelineLabel: '素材分析流程',
      phaseKey: 'coarse-first-project-analysis',
      phaseLabel: '粗扫优先素材分析',
      step: stepMeta.key,
      stepLabel: stepMeta.label,
      stepIndex: stepMeta.stepIndex,
      stepTotal: stepMeta.stepTotal,
      stepDefinitions: [...CANALYZE_STEP_DEFINITIONS],
      fileIndex: inputStep.fileIndex,
      fileTotal: inputStep.fileTotal,
      current: inputStep.current,
      total: inputStep.total,
      unit: inputStep.unit,
      detail: inputStep.detail,
      fileName: inputStep.fileName,
      etaSeconds: inputStep.etaSeconds,
      extra: inputStep.extra,
    });
  };

  await writeAnalyzeStepProgress({
    step: 'prepare',
    status: 'running',
    fileIndex: progressBase,
    fileTotal: progressTotal,
    current: progressBase,
    total: progressTotal,
    unit: 'files',
    detail: `正在读取项目“${project.name}”的素材与设备映射`,
        extra: {
          projectId: input.projectId,
          projectName: project.name,
        },
  });

  try {
    await enforceProjectTimelineConsistency({
      projectRoot,
      assets,
      roots,
    });

    if (pendingAssets.length > 0 || pendingFineScanEntries.length > 0) {
      await getMlHandle();
    }

    const finalizeFailures: IFinalizeFailure[] = [];
    const coarsePhaseStartedAtMs = Date.now();
    for (const [index, asset] of pendingAssets.entries()) {
      const localPath = resolveAssetLocalPath(input.projectId, asset, roots, deviceMaps);
      const fileIndex = toOverallProgressIndex(index + 1);
      const etaSeconds = estimatePhaseEtaSeconds(
        coarsePhaseStartedAtMs,
        preparedAnalyses.length,
        pendingAssets.length,
      );

      await writeAnalyzeStepProgress({
        step: 'coarse-scan',
        fileName: asset.displayName,
        fileIndex,
        fileTotal: progressTotal,
        current: fileIndex,
        total: progressTotal,
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

      const prepareStartedAt = Date.now();
      const prepared = await loadOrPrepareAssetVisualCoarse({
        asset,
        localPath,
        projectRoot,
        roots,
        runtimeConfig,
        getMlHandle,
        performance,
      });
      performance?.recordStage(asset, 'prepare', Date.now() - prepareStartedAt);
      preparedAnalyses.push(prepared);
    }

    const audioPhaseStartedAtMs = Date.now();
    for (const [index, prepared] of preparedAnalyses.entries()) {
      const fileIndex = toOverallProgressIndex(index + 1);

      const writePreparedStageProgress = async (
        stage: 'audio-analysis' | 'finalize',
        detail?: string,
      ) => writeAnalyzeStepProgress({
        step: stage,
        fileName: prepared.asset.displayName,
        fileIndex,
        fileTotal: progressTotal,
        current: fileIndex,
        total: progressTotal,
        unit: 'files',
        etaSeconds: estimatePhaseEtaSeconds(
          audioPhaseStartedAtMs,
          analyzedAssetIds.length,
          preparedAnalyses.length,
        ),
        detail,
        extra: {
          projectId: input.projectId,
          projectName: project.name,
          assetId: prepared.asset.id,
          assetKind: prepared.asset.kind,
        },
      });

      const needsAudioStage = shouldAnalyzeAudioTrack(prepared.asset, prepared.hasAudioTrack)
        || Boolean(prepared.asset.protectionAudio);
      if (needsAudioStage) {
        await writePreparedStageProgress(
          'audio-analysis',
          describeAudioAnalysisStage(prepared.asset, prepared.hasAudioTrack),
        );
      } else {
        await writePreparedStageProgress(
          'finalize',
          describeFinalizeStage(prepared.asset, prepared.hasAudioTrack),
        );
      }

      try {
        const finalizeStartedAt = Date.now();
        const finalized = await finalizePreparedAsset({
          projectId: input.projectId,
          prepared,
          projectRoot,
          roots,
          deviceMaps,
          derivedTrack,
          gpxPaths,
          gpxMatchToleranceMs: input.gpxMatchToleranceMs,
          budget: input.budget,
          getMlHandle,
          performance,
          onStageChange: async (stage, detail) => {
            await writePreparedStageProgress(
              stage,
              detail ?? (
                stage === 'audio-analysis'
                  ? describeAudioAnalysisStage(prepared.asset, prepared.hasAudioTrack)
                  : describeFinalizeStage(prepared.asset, prepared.hasAudioTrack)
              ),
            );
          },
        });
        performance?.recordStage(prepared.asset, 'finalize', Date.now() - finalizeStartedAt);

        await writeTrackedReport(prepared.asset, finalized.report);
        await removeAudioAnalysisCheckpoint(projectRoot, prepared.asset.id);
        if (!finalized.report.shouldFineScan) {
          await removePreparedAssetCheckpoint(projectRoot, prepared.asset.id);
        }
        analyzedAssetIds.push(prepared.asset.id);
        finalizedAnalyses.push(finalized);
      } catch (error) {
        finalizeFailures.push({
          assetId: prepared.asset.id,
          displayName: prepared.asset.displayName,
          stage: 'finalize',
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (finalizeFailures.length > 0) {
      const failedDisplayNames = finalizeFailures
        .map(item => item.displayName)
        .join('、');
      const failureMessage = `统一完成素材分析失败 ${finalizeFailures.length} 条：${failedDisplayNames}`;
      await writeAnalyzeStepProgress({
        step: 'finalize',
        status: 'failed',
        fileIndex: toOverallProgressIndex(analyzedAssetIds.length),
        fileTotal: progressTotal,
        current: toOverallProgressIndex(analyzedAssetIds.length),
        total: progressTotal,
        unit: 'files',
        detail: failureMessage,
        extra: {
          projectId: input.projectId,
          projectName: project.name,
          failures: finalizeFailures,
        },
      });
      performance?.finalizeFailure({
        pipelineTotalMs: Date.now() - startedAtMs,
        failureMessage,
        analyzedAssetCount: analyzedAssetIds.length,
        fineScannedAssetCount: fineScannedAssetIds.length,
        failureItems: finalizeFailures,
      });
      performanceFailureHandled = true;
      await flushPerformance();
      throw new Error(failureMessage);
    }

    const resumedFineScanAnalyses = await loadPendingFineScanAnalyses({
      projectId: input.projectId,
      projectRoot,
      entries: pendingFineScanEntries,
      roots,
      deviceMaps,
      runtimeConfig,
      getMlHandle,
      performance,
    });
    const fineScanCandidates = dedupeFineScanAnalyses([
      ...resumedFineScanAnalyses,
      ...finalizedAnalyses.filter(analysis => analysis.report.shouldFineScan),
    ]);
    const fineScanPhaseStartedAtMs = Date.now();
    const fineScanResult = await runFineScanPipeline({
      fineScanCandidates,
      fineScanPhaseStartedAtMs,
      projectId: input.projectId,
      projectName: project.name,
      projectRoot,
      runtimeConfig,
      getMlHandle,
      performance,
      writeTrackedProgress,
      writeTrackedReport,
      appendTrackedSlices,
    });
    pendingSlices.push(...fineScanResult.pendingSlices);
    fineScannedAssetIds.push(...fineScanResult.fineScannedAssetIds);

    await writeAnalyzeStepProgress({
      step: 'chronology',
      fileIndex: progressTotal,
      fileTotal: progressTotal,
      current: progressTotal,
      total: progressTotal,
      unit: 'files',
      etaSeconds: 0,
      detail: '正在按拍摄时间刷新 chronology 视图',
      extra: {
        projectId: input.projectId,
        projectName: project.name,
        fineScannedAssetCount: fineScannedAssetIds.length,
      },
    });

    const chronologyStartedAt = Date.now();
    const chronology = buildMediaChronology(
      await loadAssets(projectRoot),
      await loadAssetReports(projectRoot),
      await loadChronology(projectRoot),
    );
    await writeTrackedChronology(chronology);
    await touchProjectUpdatedAt(projectRoot);
    performance?.recordChronologyRefresh(Date.now() - chronologyStartedAt);

    const missingRoots = roots.filter(
      root => root.enabled && !resolveAssetRootAvailable(input.projectId, root, deviceMaps),
    );

    await writeAnalyzeStepProgress({
      step: 'chronology',
      status: 'succeeded',
      fileIndex: progressTotal,
      fileTotal: progressTotal,
      current: progressTotal,
      total: progressTotal,
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
    performance?.finalizeSuccess({
      pipelineTotalMs: Date.now() - startedAtMs,
      analyzedAssetCount: analyzedAssetIds.length,
      fineScannedAssetCount: fineScannedAssetIds.length,
      missingRootCount: missingRoots.length,
    });
    await flushPerformance();

    return {
      projectRoot,
      analyzedAssetIds,
      fineScannedAssetIds,
      missingRoots,
      reportCount: analyzedAssetIds.length,
      sliceCount: pendingSlices.length,
      mlUsed,
      performanceProfilePath,
    };
  } catch (error) {
    const failureMessage = error instanceof Error ? error.message : String(error);
    if (!performanceFailureHandled) {
      await writeTrackedProgress({
        status: 'failed',
        pipelineKey: 'media-analyze',
        pipelineLabel: '素材分析流程',
        phaseKey: 'coarse-first-project-analysis',
        phaseLabel: '粗扫优先素材分析',
        stepDefinitions: [...CANALYZE_STEP_DEFINITIONS],
        fileIndex: toOverallProgressIndex(analyzedAssetIds.length),
        fileTotal: progressTotal,
        current: toOverallProgressIndex(analyzedAssetIds.length),
        total: progressTotal,
        unit: 'files',
        detail: failureMessage,
        extra: {
          projectId: input.projectId,
          projectName: project.name,
        },
      });
    }
    if (!performanceFailureHandled) {
      performance?.finalizeFailure({
        pipelineTotalMs: Date.now() - startedAtMs,
        failureMessage,
        analyzedAssetCount: analyzedAssetIds.length,
        fineScannedAssetCount: fineScannedAssetIds.length,
      });
      await flushPerformance();
    }
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
    keyframeExtractConcurrency?: number;
    fineScanPrefetchBaseConcurrency?: number;
    fineScanPrefetchMaxConcurrency?: number;
    fineScanPrefetchMinFreeMemoryMb?: number;
    fineScanPrefetchMaxReadyAssets?: number;
    fineScanPrefetchMaxReadyFrameMb?: number;
    mlServerUrl?: string;
  };
  budget?: ETargetBudget;
  getMlHandle: () => Promise<MlAvailability>;
  performance?: AnalyzePerformanceSession;
}

interface IPreparedAssetAnalysis extends IAnalyzeSingleAssetInput {
  shotBoundaries: IShotBoundary[];
  shotBoundariesResolved: boolean;
  sampleFrames: { timeMs: number; path: string }[];
  coarseSampleTimestamps: number[];
  hasAudioTrack: boolean;
  sourceContext: IPreparedSourceContext;
}

interface IPreparedSourceContext {
  ingestRootId?: string;
  rootLabel?: string;
  rootDescription?: string;
  rootNotes: string[];
}

interface IFinalizePreparedAssetInput {
  projectId: string;
  prepared: IPreparedAssetAnalysis;
  projectRoot: string;
  roots: IMediaRoot[];
  deviceMaps: IDeviceMediaMapFile;
  derivedTrack?: IProjectDerivedTrack | null;
  gpxPaths?: string[];
  gpxMatchToleranceMs?: number;
  budget?: ETargetBudget;
  getMlHandle: () => Promise<MlAvailability>;
  onStageChange?: (stage: 'audio-analysis' | 'finalize', detail?: string) => Promise<void>;
  performance?: AnalyzePerformanceSession;
}

interface IFinalizedAssetAnalysis {
  prepared: IPreparedAssetAnalysis;
  report: IAssetCoarseReport;
  transcript?: ITranscriptContext | null;
  visualSummary?: IRecognition | null;
  clipType: EClipType;
  decisionReasons: string[];
}

interface IFineScanPrefetchLimits {
  baseConcurrency: number;
  maxConcurrency: number;
  minFreeMemoryMb: number;
  maxReadyAssets: number;
  maxReadyFrameMb: number;
}

interface IFineScanTaskState {
  analysis: IFinalizedAssetAnalysis;
  checkpoint: IFineScanCheckpoint;
  plannedAtMs: number;
  prefetchedAtMs?: number;
  persisted: boolean;
}

interface IFineScanRecognitionResult {
  task: IFineScanTaskState;
  slices: IKtepSlice[];
  updatedReport: IAssetCoarseReport;
  droppedInvalidSliceCount: number;
}

interface IPreparedAssetPlanningContext {
  density: IDensityResult;
  basePlan: IMediaAnalysisPlan;
  heuristicClipType: EClipType;
  visualSummary: IRecognition | null;
  decision: IAnalysisDecision;
  finalPlan: IMediaAnalysisPlan;
  decisionReasons: string[];
}

interface IFineScanSlicesResult {
  slices: IKtepSlice[];
  droppedInvalidSliceCount: number;
}

interface ITranscribedAudioContext {
  context: ITranscriptContext | null;
  timing?: ITranscription['timing'];
  roundTripMs?: number;
}

interface IAudioDecisionHints {
  protectionRecommendation?: string;
  protectionTranscriptExcerpt?: string;
}

interface IAudioAnalysisContext {
  embeddedTranscript: ITranscriptContext | null;
  protectionTranscript?: ITranscriptContext | null;
  protectedAudio?: IAssetCoarseReport['protectedAudio'];
  decisionHints: IAudioDecisionHints;
  hasAvailableProtectionAudio: boolean;
}

interface IUnifiedFinalizeAnalysis {
  visualSummary: IRecognition | null;
  decision: IAnalysisDecision;
}

interface IFinalizeFailure {
  assetId: string;
  displayName: string;
  stage: 'finalize';
  reason: string;
}

interface IResumeFineScanEntry {
  asset: IKtepAsset;
  report: IAssetCoarseReport;
}

interface MlAvailability {
  client: MlClient;
  available: boolean;
}

const CTALKING_HEAD_AUDIO_LED_MIN_SPEECH_COVERAGE = 0.12;
const CTALKING_HEAD_AUDIO_LED_GAP_MS = 12_000;
const CDEFERRED_SCENE_DETECT_WINDOW_GAP_MS = 12_000;
const CSCENIC_DRIVE_KEYWORDS = [
  'landscape',
  'nature',
  'mountain',
  'coast',
  'coastal',
  'lake',
  'river',
  'valley',
  'forest',
  'bridge',
  'town',
  'village',
  'cliff',
  'fjord',
  'fiord',
  'countryside',
  'winding',
  'curve',
  'bend',
  'scenic',
  'mist',
  'lush',
  'greenery',
  'lookout',
] as const;
const CMONOTONE_DRIVE_KEYWORDS = [
  'dashboard',
  'highway',
  'freeway',
  'expressway',
  'traffic',
  'lane',
  'intersection',
  'parking',
  'commute',
  'stoplight',
  'tunnel',
] as const;

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
      shotBoundariesResolved: true,
      sampleFrames: [],
      coarseSampleTimestamps: [],
      hasAudioTrack: false,
      sourceContext: buildPreparedSourceContext(input.asset, input.roots),
    };
  }

  const sampleTimestamps = buildCoarseSampleTimestamps(
    input.asset.durationMs ?? 0,
    pickCoarseSampleCount(input.asset.durationMs ?? 0),
  );
  const coarseKeyframeStartedAt = Date.now();
  const extractedFrames = await extractKeyframes(
    input.localPath,
    buildAssetTempDir(input.projectRoot, input.asset.id),
    sampleTimestamps,
    input.runtimeConfig,
  );
  input.performance?.recordKeyframeExtract({
    asset: input.asset,
    phase: 'coarse',
    elapsedMs: Date.now() - coarseKeyframeStartedAt,
    keyframeCount: extractedFrames.length,
  });
  const sampleFrames = await filterExistingKeyframes(extractedFrames);
  const hasAudioTrack = await resolveAssetHasAudioTrack(
    input.asset,
    input.localPath,
    input.runtimeConfig,
  );

  return {
    ...input,
    shotBoundaries: [],
    shotBoundariesResolved: false,
    sampleFrames,
    coarseSampleTimestamps: sampleTimestamps,
    hasAudioTrack,
    sourceContext: buildPreparedSourceContext(input.asset, input.roots),
  };
}

async function loadOrPrepareAssetVisualCoarse(
  input: IAnalyzeSingleAssetInput,
): Promise<IPreparedAssetAnalysis> {
  const restored = await loadPreparedAssetVisualCoarse(input);
  if (restored) {
    return restored;
  }

  const prepared = await prepareAssetVisualCoarse(input);
  await writePreparedAssetCheckpoint(input.projectRoot, {
    schemaVersion: 2,
    assetId: prepared.asset.id,
    shotBoundaries: prepared.shotBoundaries,
    shotBoundariesResolved: prepared.shotBoundariesResolved,
    sampleFrames: prepared.sampleFrames,
    coarseSampleTimestamps: prepared.coarseSampleTimestamps,
    hasAudioTrack: prepared.hasAudioTrack,
    sourceContext: prepared.sourceContext,
  });
  return prepared;
}

async function loadPreparedAssetVisualCoarse(
  input: IAnalyzeSingleAssetInput,
): Promise<IPreparedAssetAnalysis | null> {
  const checkpoint = await loadPreparedAssetCheckpoint(input.projectRoot, input.asset.id);
  if (!checkpoint) return null;

  const sampleFrames = await filterExistingKeyframes(checkpoint.sampleFrames);
  if (checkpoint.sampleFrames.length > 0 && sampleFrames.length === 0) {
    return null;
  }

  return {
    ...input,
    shotBoundaries: checkpoint.shotBoundaries,
    shotBoundariesResolved: checkpoint.shotBoundariesResolved,
    sampleFrames,
    coarseSampleTimestamps: checkpoint.coarseSampleTimestamps,
    hasAudioTrack: checkpoint.hasAudioTrack,
    sourceContext: checkpoint.sourceContext,
  };
}

async function loadOrAnalyzePreparedAudio(input: {
  projectId: string;
  projectRoot: string;
  prepared: IPreparedAssetAnalysis;
  roots: IMediaRoot[];
  deviceMaps: IDeviceMediaMapFile;
  ml: MlAvailability;
  onStageChange?: (stage: 'audio-analysis' | 'finalize', detail?: string) => Promise<void>;
  performance?: AnalyzePerformanceSession;
}): Promise<IAudioAnalysisContext> {
  const shouldCheckpoint = shouldAnalyzeAudioTrack(input.prepared.asset, input.prepared.hasAudioTrack)
    || Boolean(input.prepared.asset.protectionAudio);
  const protectionAudioLocalPath = await resolveAvailableProtectionAudioLocalPath({
    projectId: input.projectId,
    asset: input.prepared.asset,
    roots: input.roots,
    deviceMaps: input.deviceMaps,
  });
  const hasAvailableProtectionAudio = Boolean(protectionAudioLocalPath);

  if (shouldCheckpoint) {
    const checkpoint = await loadAudioAnalysisCheckpoint(input.projectRoot, input.prepared.asset.id);
    if (checkpoint) {
      return {
        embeddedTranscript: normalizeTranscriptContext(checkpoint.transcript ?? null),
        protectionTranscript: normalizeTranscriptContext(checkpoint.protectionTranscript ?? null),
        protectedAudio: checkpoint.protectedAudio,
        decisionHints: {
          protectionRecommendation: typeof checkpoint.decisionHints?.protectionRecommendation === 'string'
            ? checkpoint.decisionHints.protectionRecommendation
            : undefined,
          protectionTranscriptExcerpt: typeof checkpoint.decisionHints?.protectionTranscriptExcerpt === 'string'
            ? checkpoint.decisionHints.protectionTranscriptExcerpt
            : undefined,
        },
        hasAvailableProtectionAudio,
      };
    }
  }

  if (shouldAnalyzeAudioTrack(input.prepared.asset, input.prepared.hasAudioTrack)) {
    await input.onStageChange?.('audio-analysis', `正在分析 ${input.prepared.asset.displayName} 的视频内音轨`);
  }
  const embeddedTranscript = await maybeTranscribeAsset({
    asset: input.prepared.asset,
    localPath: input.prepared.localPath,
    hasAudioTrack: input.prepared.hasAudioTrack,
    ml: input.ml,
    performance: input.performance,
  });
  const protectedAudioContext = input.prepared.asset.protectionAudio
    ? await evaluateProtectedAudioFallback({
      projectId: input.projectId,
      asset: input.prepared.asset,
      localVideoPath: input.prepared.localPath,
      roots: input.roots,
      deviceMaps: input.deviceMaps,
      runtimeConfig: input.prepared.runtimeConfig,
      embeddedTranscript,
      ml: input.ml,
      onStageChange: input.onStageChange,
      performance: input.performance,
      protectionAudioLocalPath,
    })
    : undefined;

  if (shouldCheckpoint) {
    await writeAudioAnalysisCheckpoint(input.projectRoot, {
      assetId: input.prepared.asset.id,
      transcript: embeddedTranscript,
      protectionTranscript: protectedAudioContext?.protectionTranscript,
      protectedAudio: protectedAudioContext?.protectedAudio,
      decisionHints: protectedAudioContext?.decisionHints,
    });
  }

  return {
    embeddedTranscript,
    protectionTranscript: protectedAudioContext?.protectionTranscript,
    protectedAudio: protectedAudioContext?.protectedAudio,
    decisionHints: protectedAudioContext?.decisionHints ?? {},
    hasAvailableProtectionAudio,
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
      visualSummary: null,
      clipType: 'unknown',
      decisionReasons: ['audio-assets-skip-visual-fine-scan'],
    };
  }

  const ml = await input.getMlHandle();
  const audioContext = await loadOrAnalyzePreparedAudio({
    projectId: input.projectId,
    projectRoot: input.projectRoot,
    prepared: input.prepared,
    roots: input.roots,
    deviceMaps: input.deviceMaps,
    ml,
    onStageChange: input.onStageChange,
    performance: input.performance,
  });
  const root = input.roots.find(item => item.id === input.prepared.asset.ingestRootId);
  const manualSpatial = await resolveManualSpatialContext({
    asset: input.prepared.asset,
    root,
    gpxPaths: input.gpxPaths,
    gpxMatchToleranceMs: input.gpxMatchToleranceMs,
    derivedTrack: input.derivedTrack,
  });
  await input.onStageChange?.('finalize', describeFinalizeStage(
    input.prepared.asset,
    input.prepared.hasAudioTrack,
  ));
  const provisionalPlanning = await resolvePreparedAssetPlanning({
    prepared: input.prepared,
    transcript: audioContext.embeddedTranscript,
    audioContext,
    budget: input.budget,
    ml,
    manualSpatial,
    performance: input.performance,
  });

  let prepared = input.prepared;
  let planning = provisionalPlanning;
  if (shouldRunDeferredSceneDetect({
    prepared,
    visualSummary: provisionalPlanning.visualSummary,
    plan: provisionalPlanning.finalPlan,
    manualSpatial,
  })) {
    prepared = await runDeferredSceneDetect({
      prepared,
      phase: 'finalize',
      clipType: provisionalPlanning.finalPlan.clipType,
      performance: input.performance,
    });
    planning = await resolvePreparedAssetPlanning({
      prepared,
      transcript: audioContext.embeddedTranscript,
      audioContext,
      budget: input.budget,
      ml,
      manualSpatial,
      performance: input.performance,
      unifiedAnalysis: {
        visualSummary: provisionalPlanning.visualSummary,
        decision: provisionalPlanning.decision,
      },
    });
  }

  const report = buildAssetCoarseReport({
    asset: prepared.asset,
    plan: planning.finalPlan,
    clipTypeGuess: planning.decision.clipType,
    gpsSummary: manualSpatial?.gpsSummary,
    inferredGps: manualSpatial?.inferredGps,
    summary: planning.visualSummary?.description,
    transcript: audioContext.embeddedTranscript?.transcript,
    transcriptSegments: audioContext.embeddedTranscript?.segments,
    speechCoverage: audioContext.embeddedTranscript?.speechCoverage,
    protectedAudio: audioContext.protectedAudio,
    labels: dedupeStrings([
      ...buildReportLabels(
        planning.decision.clipType,
        planning.visualSummary?.sceneType,
        planning.visualSummary?.subjects,
        audioContext.embeddedTranscript,
      ),
      ...(audioContext.hasAvailableProtectionAudio ? ['protection-audio-available'] : []),
      ...(audioContext.protectedAudio?.recommendedSource === 'protection' ? ['protection-audio-fallback'] : []),
    ]),
    placeHints: dedupeStrings([
      ...(planning.visualSummary?.placeHints ?? []),
      ...(manualSpatial?.placeHints ?? []),
    ]),
    rootNotes: root?.notes ?? [],
    sampleFrames: prepared.sampleFrames,
    fineScanReasons: buildFineScanReasons(
      planning.finalPlan,
      planning.density,
      prepared.shotBoundaries,
      audioContext.embeddedTranscript,
      planning.decisionReasons,
    ),
  });

  return {
    prepared,
    report,
    transcript: audioContext.embeddedTranscript,
    visualSummary: planning.visualSummary,
    clipType: planning.decision.clipType,
    decisionReasons: planning.decisionReasons,
  };
}

async function resolveManualSpatialContext(input: {
  asset: IKtepAsset;
  root?: IMediaRoot;
  gpxPaths?: string[];
  gpxMatchToleranceMs?: number;
  derivedTrack?: IProjectDerivedTrack | null;
}): Promise<IManualSpatialContext | null> {
  return resolveAssetSpatialContext({
    asset: input.asset,
    root: input.root,
    gpxPaths: input.gpxPaths,
    gpxMatchToleranceMs: input.gpxMatchToleranceMs,
    derivedTrack: input.derivedTrack,
  });
}

async function resolvePreparedAssetPlanning(input: {
  prepared: IPreparedAssetAnalysis;
  transcript?: ITranscriptContext | null;
  audioContext?: IAudioAnalysisContext;
  budget?: ETargetBudget;
  ml: MlAvailability;
  manualSpatial?: IManualSpatialContext | null;
  performance?: AnalyzePerformanceSession;
  unifiedAnalysis?: IUnifiedFinalizeAnalysis;
}): Promise<IPreparedAssetPlanningContext> {
  const density = estimateDensity({
    durationMs: input.prepared.asset.durationMs ?? 0,
    shotBoundaries: input.prepared.shotBoundaries,
    asrSegments: buildDensityAsrSegments(input.transcript),
  });
  const heuristicClipType = resolveHeuristicClipType(input.prepared);
  const basePlan = buildAnalysisPlan({
    assetId: input.prepared.asset.id,
    durationMs: input.prepared.asset.durationMs ?? 0,
    density,
    shotBoundaries: input.prepared.shotBoundaries,
    clipType: heuristicClipType,
    budget: input.budget,
    extraInterestingWindows: input.transcript?.speechWindows,
  });
  const fallbackDecision = buildFallbackUnifiedAnalysisDecision({
    prepared: input.prepared,
    transcript: input.transcript,
    audioContext: input.audioContext,
    densityScore: density.score,
    basePlan,
    heuristicClipType,
    budget: input.budget,
    manualSpatial: input.manualSpatial,
  });
  const unifiedAnalysis = input.unifiedAnalysis
    ? {
      visualSummary: input.unifiedAnalysis.visualSummary,
      decision: reconcileUnifiedAnalysisDecision({
        candidate: input.unifiedAnalysis.decision,
        fallback: fallbackDecision,
        basePlan,
        budget: input.budget,
        hasMeaningfulSpeech: hasMeaningfulSpeech(input.transcript),
      }),
    }
    : await resolveUnifiedFinalizeAnalysis({
      prepared: input.prepared,
      transcript: input.transcript,
      audioContext: input.audioContext,
      densityScore: density.score,
      basePlan,
      heuristicClipType,
      budget: input.budget,
      ml: input.ml,
      manualSpatial: input.manualSpatial,
      performance: input.performance,
      fallback: fallbackDecision,
    });
  const decisionBasePlan = buildAnalysisPlan({
    assetId: input.prepared.asset.id,
    durationMs: input.prepared.asset.durationMs ?? 0,
    density,
    shotBoundaries: input.prepared.shotBoundaries,
    clipType: unifiedAnalysis.decision.clipType,
    budget: input.budget,
    extraInterestingWindows: input.transcript?.speechWindows,
  });
  const decidedPlan = applyDriveFallbackWindows(
    applyAnalysisDecision(decisionBasePlan, unifiedAnalysis.decision),
    unifiedAnalysis.decision.clipType,
    input.prepared.asset.durationMs ?? 0,
    input.budget,
    input.prepared.coarseSampleTimestamps,
  );
  const expandedPlan: IMediaAnalysisPlan = {
    ...decidedPlan,
    interestingWindows: applyTypeAwareWindowExpansion({
      clipType: unifiedAnalysis.decision.clipType,
      durationMs: input.prepared.asset.durationMs ?? 0,
      windows: decidedPlan.interestingWindows,
      shotBoundaries: input.prepared.shotBoundaries,
    }),
  };
  const audioLedPlan = applyTalkingHeadAudioLedWindowStrategy({
    plan: expandedPlan,
    clipType: unifiedAnalysis.decision.clipType,
    transcript: input.transcript,
    durationMs: input.prepared.asset.durationMs ?? 0,
  });

  return {
    density,
    basePlan,
    heuristicClipType,
    visualSummary: unifiedAnalysis.visualSummary,
    decision: unifiedAnalysis.decision,
    finalPlan: audioLedPlan.plan,
    decisionReasons: dedupeStrings([
      ...unifiedAnalysis.decision.decisionReasons,
      ...(input.manualSpatial?.decisionReasons ?? []),
      ...(audioLedPlan.applied ? ['talking-head:audio-led-windows'] : []),
    ]),
  };
}

function buildDensityAsrSegments(
  transcript?: ITranscriptContext | null,
): Array<{ start: number; end: number; text: string }> | undefined {
  return transcript?.segments.map(segment => ({
    start: segment.startMs / 1000,
    end: segment.endMs / 1000,
    text: segment.text,
  }));
}

function shouldRunDeferredSceneDetect(input: {
  prepared: IPreparedAssetAnalysis;
  visualSummary?: IRecognition | null;
  plan: IMediaAnalysisPlan;
  manualSpatial?: IManualSpatialContext | null;
}): boolean {
  if (input.prepared.asset.kind !== 'video') return false;
  if (input.prepared.shotBoundariesResolved) return false;
  if (input.plan.fineScanMode === 'full') return true;
  if (shouldRunScenicDriveDeferredSceneDetect(input)) return true;
  if (!input.plan.shouldFineScan || input.plan.fineScanMode !== 'windowed') return false;

  return shouldRunWindowedDeferredSceneDetect(input.plan);
}

async function runDeferredSceneDetect(input: {
  prepared: IPreparedAssetAnalysis;
  phase: TAnalyzeSceneDetectPhase;
  clipType?: EClipType;
  performance?: AnalyzePerformanceSession;
}): Promise<IPreparedAssetAnalysis> {
  if (input.prepared.asset.kind !== 'video' || input.prepared.shotBoundariesResolved) {
    return input.prepared;
  }

  const sceneDetectStartedAt = Date.now();
  let shotBoundaries: IShotBoundary[] = [];
  try {
    shotBoundaries = await detectShots(
      input.prepared.localPath,
      0.3,
      input.prepared.runtimeConfig,
      {
        clipType: input.clipType ?? resolveHeuristicClipType(input.prepared),
        durationMs: input.prepared.asset.durationMs,
      },
    );
  } catch {
    shotBoundaries = [];
  }

  input.performance?.recordSceneDetect({
    asset: input.prepared.asset,
    phase: input.phase,
    elapsedMs: Date.now() - sceneDetectStartedAt,
    shotCount: shotBoundaries.length,
  });

  return {
    ...input.prepared,
    shotBoundaries,
    shotBoundariesResolved: true,
  };
}

async function resolveUnifiedFinalizeAnalysis(input: {
  prepared: IPreparedAssetAnalysis;
  transcript?: ITranscriptContext | null;
  audioContext?: IAudioAnalysisContext;
  densityScore: number;
  basePlan: IMediaAnalysisPlan;
  heuristicClipType: EClipType;
  budget?: ETargetBudget;
  ml: MlAvailability;
  manualSpatial?: IManualSpatialContext | null;
  performance?: AnalyzePerformanceSession;
  fallback: IAnalysisDecision;
}): Promise<IUnifiedFinalizeAnalysis> {
  const inference = await inferUnifiedAnalysisDecision(input);
  if (!inference.ok) {
    throw new Error(inference.reason);
  }

  return {
    visualSummary: inference.value.visualSummary,
    decision: reconcileUnifiedAnalysisDecision({
      candidate: inference.value.decision,
      fallback: input.fallback,
      basePlan: input.basePlan,
      budget: input.budget,
      hasMeaningfulSpeech: hasMeaningfulSpeech(input.transcript),
    }),
  };
}

function buildFallbackUnifiedAnalysisDecision(input: {
  prepared: IPreparedAssetAnalysis;
  transcript?: ITranscriptContext | null;
  audioContext?: IAudioAnalysisContext;
  densityScore: number;
  basePlan: IMediaAnalysisPlan;
  heuristicClipType: EClipType;
  budget?: ETargetBudget;
  manualSpatial?: IManualSpatialContext | null;
}): IAnalysisDecision {
  return buildHeuristicAnalysisDecision({
    durationMs: input.prepared.asset.durationMs ?? 0,
    densityScore: input.densityScore,
    interestingWindowCount: input.basePlan.interestingWindows.length,
    clipType: input.heuristicClipType,
    initialClipTypeGuess: input.heuristicClipType,
    budget: input.budget,
    sourceContextText: buildSourceContextText(input.prepared.sourceContext),
    transcript: input.transcript?.transcript,
    speechCoverage: input.transcript?.speechCoverage,
    hasAudioTrack: input.prepared.hasAudioTrack,
    hasMeaningfulSpeech: hasMeaningfulSpeech(input.transcript),
    routeTransport: input.manualSpatial?.transport,
    spatialHintCount: input.manualSpatial?.placeHints.length,
  });
}

async function inferUnifiedAnalysisDecision(input: {
  prepared: IPreparedAssetAnalysis;
  transcript?: ITranscriptContext | null;
  audioContext?: IAudioAnalysisContext;
  densityScore: number;
  basePlan: IMediaAnalysisPlan;
  heuristicClipType: EClipType;
  budget?: ETargetBudget;
  ml: MlAvailability;
  manualSpatial?: IManualSpatialContext | null;
  performance?: AnalyzePerformanceSession;
}): Promise<
  | { ok: true; value: IUnifiedFinalizeAnalysis }
  | { ok: false; reason: string }
> {
  if (!input.ml.available) {
    return { ok: false, reason: `素材 ${input.prepared.asset.displayName} 在 finalize 阶段无法连接 ML 服务` };
  }

  const framePaths = pickRepresentativeFramePaths(
    input.prepared.sampleFrames.map(frame => frame.path),
    6,
  );
  if (framePaths.length === 0) {
    return { ok: false, reason: `素材 ${input.prepared.asset.displayName} 缺少可用于 finalize 的代表帧` };
  }

  try {
    const decisionStartedAt = Date.now();
    const result = await input.ml.client.vlmAnalyze(
      framePaths,
      buildUnifiedFinalizePrompt({
        prepared: input.prepared,
        transcript: input.transcript,
        audioContext: input.audioContext,
        densityScore: input.densityScore,
        basePlan: input.basePlan,
        heuristicClipType: input.heuristicClipType,
        budget: input.budget,
        manualSpatial: input.manualSpatial,
      }),
      { keepOtherModelsLoaded: CAUDIO_ANALYSIS_KEEP_OTHER_MODELS_LOADED },
    );
    input.performance?.recordVlm({
      asset: input.prepared.asset,
      phase: 'finalize',
      imageCount: framePaths.length,
      roundTripMs: Date.now() - decisionStartedAt,
      timing: result.timing,
    });
    const parsed = parseUnifiedFinalizeAnalysis(result.description);
    if (!parsed) {
      return {
        ok: false,
        reason: `素材 ${input.prepared.asset.displayName} 的 unified finalize 返回了无效 JSON`,
      };
    }
    return {
      ok: true,
      value: parsed,
    };
  } catch (error) {
    return {
      ok: false,
      reason: `素材 ${input.prepared.asset.displayName} 的 unified finalize 失败：${error instanceof Error ? error.message : String(error)}`,
    };
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

function shouldRunWindowedDeferredSceneDetect(plan: IMediaAnalysisPlan): boolean {
  if (plan.clipType === 'drive') return false;

  const separatedWindowClusters = countSeparatedInterestingWindowClusters(plan.interestingWindows);
  if (separatedWindowClusters >= 2) return true;

  const hasSpeechWindow = plan.interestingWindows.some(window => isSpeechSemanticWindow(window));
  const hasNonSpeechWindow = plan.interestingWindows.some(window => !isSpeechSemanticWindow(window));
  return hasSpeechWindow && hasNonSpeechWindow;
}

function countSeparatedInterestingWindowClusters(windows: IInterestingWindow[]): number {
  const ranges = windows
    .map(window => resolveWindowPreferredRange(window) ?? {
      startMs: window.startMs,
      endMs: window.endMs,
    })
    .filter(range => range.endMs > range.startMs)
    .sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs);
  if (ranges.length === 0) return 0;

  let clusters = 1;
  let currentEndMs = ranges[0]!.endMs;
  for (let index = 1; index < ranges.length; index += 1) {
    const range = ranges[index]!;
    if (range.startMs - currentEndMs >= CDEFERRED_SCENE_DETECT_WINDOW_GAP_MS) {
      clusters += 1;
      currentEndMs = range.endMs;
      continue;
    }
    currentEndMs = Math.max(currentEndMs, range.endMs);
  }
  return clusters;
}

function shouldRunScenicDriveDeferredSceneDetect(input: {
  prepared: IPreparedAssetAnalysis;
  visualSummary?: IRecognition | null;
  plan: IMediaAnalysisPlan;
  manualSpatial?: IManualSpatialContext | null;
}): boolean {
  if (input.plan.clipType !== 'drive') return false;

  const visualSummary = input.visualSummary;
  if (!visualSummary) return false;

  const semanticText = [
    visualSummary.sceneType,
    visualSummary.narrativeRole,
    visualSummary.description,
    ...visualSummary.subjects,
    ...visualSummary.placeHints,
    ...(input.manualSpatial?.placeHints ?? []),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  const scenicCueCount = countKeywordMatches(semanticText, CSCENIC_DRIVE_KEYWORDS);
  const monotoneCueCount = countKeywordMatches(semanticText, CMONOTONE_DRIVE_KEYWORDS);
  const hasNarrativeSupport = ['intro', 'establishing', 'transition', 'climax']
    .includes(visualSummary.narrativeRole);
  const hasPlaceSupport = visualSummary.placeHints.length > 0 || (input.manualSpatial?.placeHints.length ?? 0) > 0;

  const scenicSignalStrongEnough = scenicCueCount >= 2
    || (scenicCueCount >= 1 && (hasNarrativeSupport || hasPlaceSupport));

  return scenicSignalStrongEnough && scenicCueCount > monotoneCueCount;
}

function countKeywordMatches(text: string, keywords: readonly string[]): number {
  return keywords.reduce((count, keyword) => (
    text.includes(keyword) ? count + 1 : count
  ), 0);
}

function applyDriveFallbackWindows(
  plan: IMediaAnalysisPlan,
  clipType: EClipType,
  durationMs: number,
  budget: ETargetBudget | undefined,
  sampleTimestamps: number[],
): IMediaAnalysisPlan {
  if (clipType !== 'drive') return plan;

  const speechWindows = plan.interestingWindows
    .filter(window => isSpeechSemanticWindow(window))
    .map(window => withWindowSemanticKind(window, 'speech'));
  const visualWindows = plan.interestingWindows
    .filter(window => !isSpeechSemanticWindow(window))
    .map(window => withWindowSemanticKind(window, 'visual'));

  if ((budget ?? 'standard') === 'coarse' || !plan.shouldFineScan || plan.fineScanMode === 'skip') {
    return {
      ...plan,
      interestingWindows: mergeInterestingWindowsByPreferredBounds([
        ...speechWindows,
        ...visualWindows,
      ]),
    };
  }

  if (plan.fineScanMode === 'full') {
    return {
      ...plan,
      interestingWindows: mergeInterestingWindowsByPreferredBounds([
        ...speechWindows,
        ...visualWindows,
      ]),
    };
  }

  const fallbackVisualWindows = visualWindows.length > 0
    ? visualWindows
    : buildDriveFallbackWindows(durationMs, sampleTimestamps);

  return {
    ...plan,
    interestingWindows: mergeInterestingWindowsByPreferredBounds([
      ...speechWindows,
      ...fallbackVisualWindows,
    ]),
  };
}

function withWindowSemanticKind(
  window: IInterestingWindow,
  semanticKind: 'speech' | 'visual',
): IInterestingWindow {
  return {
    ...window,
    semanticKind: window.semanticKind ?? semanticKind,
    ...(window.speedCandidate && {
      speedCandidate: {
        ...window.speedCandidate,
        suggestedSpeeds: [...window.speedCandidate.suggestedSpeeds],
      },
    }),
  };
}

function applyTalkingHeadAudioLedWindowStrategy(input: {
  plan: IMediaAnalysisPlan;
  clipType: EClipType;
  transcript?: ITranscriptContext | null;
  durationMs: number;
}): {
  plan: IMediaAnalysisPlan;
  applied: boolean;
} {
  if (input.clipType !== 'talking-head') {
    return { plan: input.plan, applied: false };
  }
  if (!hasMeaningfulSpeech(input.transcript)) {
    return { plan: input.plan, applied: false };
  }
  if ((input.transcript?.speechCoverage ?? 0) < CTALKING_HEAD_AUDIO_LED_MIN_SPEECH_COVERAGE) {
    return { plan: input.plan, applied: false };
  }

  const speechWindows = input.plan.interestingWindows
    .filter(window => isSpeechSemanticWindow(window));
  if (speechWindows.length === 0) {
    return { plan: input.plan, applied: false };
  }

  const visualWindows = input.plan.interestingWindows
    .filter(window => !isSpeechSemanticWindow(window));
  const supplementedWindows = pickTalkingHeadGapSupplementWindows({
    speechWindows,
    visualWindows,
  });
  const mergedWindows = mergeInterestingWindowsByPreferredBounds([
    ...speechWindows,
    ...supplementedWindows,
  ]);
  if (mergedWindows.length === 0) {
    return { plan: input.plan, applied: false };
  }

  const mergedCoverageMs = mergedWindows.reduce((sum, window) => {
    const range = resolveWindowPreferredRange(window) ?? {
      startMs: window.startMs,
      endMs: window.endMs,
    };
    return sum + Math.max(0, range.endMs - range.startMs);
  }, 0);
  const shouldPreferWindowed = input.plan.fineScanMode === 'full'
    && input.durationMs > 0
    && mergedCoverageMs < input.durationMs * 0.85;

  return {
    plan: {
      ...input.plan,
      interestingWindows: mergedWindows,
      fineScanMode: shouldPreferWindowed ? 'windowed' : input.plan.fineScanMode,
      shouldFineScan: true,
    },
    applied: true,
  };
}

function pickTalkingHeadGapSupplementWindows(input: {
  speechWindows: IInterestingWindow[];
  visualWindows: IInterestingWindow[];
}): IInterestingWindow[] {
  if (input.speechWindows.length < 2 || input.visualWindows.length === 0) return [];

  const speechRanges = [...input.speechWindows]
    .map(window => ({
      window,
      range: resolveWindowPreferredRange(window) ?? {
        startMs: window.startMs,
        endMs: window.endMs,
      },
    }))
    .sort((left, right) => left.range.startMs - right.range.startMs);
  const visualRanges = input.visualWindows.map(window => ({
    window,
    range: resolveWindowPreferredRange(window) ?? {
      startMs: window.startMs,
      endMs: window.endMs,
    },
  }));
  const supplements: IInterestingWindow[] = [];

  for (let index = 1; index < speechRanges.length; index += 1) {
    const previous = speechRanges[index - 1]!.range;
    const current = speechRanges[index]!.range;
    const gapStartMs = previous.endMs;
    const gapEndMs = current.startMs;
    if (gapEndMs - gapStartMs < CTALKING_HEAD_AUDIO_LED_GAP_MS) continue;

    for (const visual of visualRanges) {
      if (visual.range.endMs <= gapStartMs || visual.range.startMs >= gapEndMs) continue;
      supplements.push(visual.window);
    }
  }

  return supplements;
}

async function maybeTranscribeAsset(input: {
  asset: IKtepAsset;
  localPath: string;
  hasAudioTrack: boolean;
  ml: MlAvailability;
  performance?: AnalyzePerformanceSession;
}): Promise<ITranscriptContext | null> {
  if (!input.ml.available) return null;
  if (!shouldAnalyzeAudioTrack(input.asset, input.hasAudioTrack)) return null;

  const transcript = await transcribeAudioContext({
    localPath: input.localPath,
    durationMs: input.asset.durationMs ?? 0,
    ml: input.ml,
  });
  if (transcript.timing || transcript.roundTripMs != null) {
    input.performance?.recordAsr({
      asset: input.asset,
      phase: 'embedded',
      roundTripMs: transcript.roundTripMs,
      timing: transcript.timing,
    });
  }
  return transcript.context;
}

async function transcribeAudioContext(input: {
  localPath: string;
  durationMs: number;
  ml: MlAvailability;
}): Promise<ITranscribedAudioContext> {
  if (!input.ml.available) {
    return { context: null };
  }

  try {
    const result = await transcribe(
      input.ml.client,
      input.localPath,
      undefined,
      { keepOtherModelsLoaded: CAUDIO_ANALYSIS_KEEP_OTHER_MODELS_LOADED },
    );
    const segments = result.segments
      .map(segment => ({
        startMs: Math.max(0, Math.round(segment.start * 1000)),
        endMs: Math.max(Math.round(segment.start * 1000), Math.round(segment.end * 1000)),
        text: segment.text.trim(),
      }))
      .filter(segment => segment.endMs > segment.startMs && segment.text.length > 0);

    const transcript = result.fullText.trim();
    if (!transcript && segments.length === 0) {
      return {
        context: null,
        timing: result.timing,
        roundTripMs: result.roundTripMs,
      };
    }

    return {
      context: normalizeTranscriptContext({
        transcript,
        segments,
        evidence: result.evidence,
        speechCoverage: computeSpeechCoverage(input.durationMs, segments),
        speechWindows: buildSpeechWindows(input.durationMs, segments),
      }),
      timing: result.timing,
      roundTripMs: result.roundTripMs,
    };
  } catch {
    return { context: null };
  }
}

export async function evaluateProtectedAudioFallback(input: {
  projectId: string;
  asset: IKtepAsset;
  localVideoPath: string;
  roots: IMediaRoot[];
  deviceMaps: IDeviceMediaMapFile;
  runtimeConfig: IPreparedAssetAnalysis['runtimeConfig'];
  embeddedTranscript?: ITranscriptContext | null;
  ml: MlAvailability;
  onStageChange?: (stage: 'audio-analysis' | 'finalize', detail?: string) => Promise<void>;
  performance?: AnalyzePerformanceSession;
  protectionAudioLocalPath?: string | null;
}): Promise<{
  protectedAudio?: IAssetCoarseReport['protectedAudio'];
  protectionTranscript?: ITranscriptContext | null;
  decisionHints: IAudioDecisionHints;
} | undefined> {
  const binding = input.asset.protectionAudio;
  if (!binding) return undefined;

  const embeddedTelemetry = await analyzeAudioHealth(
    input.localVideoPath,
    input.asset.durationMs,
    input.runtimeConfig,
  );
  const embeddedSummary = summarizeAudioHealth({
    telemetry: embeddedTelemetry,
    speechCoverage: input.embeddedTranscript?.speechCoverage,
    transcript: input.embeddedTranscript?.transcript,
  });

  const protectionLocalPath = input.protectionAudioLocalPath ?? await resolveAvailableProtectionAudioLocalPath({
    projectId: input.projectId,
    asset: input.asset,
    roots: input.roots,
    deviceMaps: input.deviceMaps,
  });
  if (!protectionLocalPath) {
    const protectedAudio = recommendProtectedAudioFallback({
      binding,
      embedded: embeddedSummary,
      comparedProtectionTranscript: false,
    });
    return {
      protectedAudio,
      decisionHints: buildProtectedAudioDecisionHints(protectedAudio),
    };
  }

  let protectionTranscript: ITranscriptContext | null = null;
  let comparedProtectionTranscript = false;

  if (shouldCompareProtectionTranscript(binding, embeddedSummary, input.embeddedTranscript)) {
    await input.onStageChange?.('audio-analysis', `正在对比 ${input.asset.displayName} 的保护音轨`);
    const protectionTranscriptResult = await transcribeAudioContext({
      localPath: protectionLocalPath,
      durationMs: binding.durationMs ?? input.asset.durationMs ?? 0,
      ml: input.ml,
    });
    if (protectionTranscriptResult.timing || protectionTranscriptResult.roundTripMs != null) {
      input.performance?.recordAsr({
        asset: input.asset,
        phase: 'protection',
        roundTripMs: protectionTranscriptResult.roundTripMs,
        timing: protectionTranscriptResult.timing,
      });
    }
    protectionTranscript = protectionTranscriptResult.context;
    comparedProtectionTranscript = Boolean(protectionTranscriptResult.context);
  }

  const protectionSummary = summarizeAudioHealth({
    speechCoverage: protectionTranscript?.speechCoverage,
    transcript: protectionTranscript?.transcript,
    notes: [
      '保护音轨默认不做独立健康检查，仅在必要时做语音对比。',
      binding.alignment === 'unknown'
        ? '未确认保护音轨与视频的精确时长关系。'
        : `保护音轨时长对齐状态：${binding.alignment}`,
    ],
  });

  const protectedAudio = recommendProtectedAudioFallback({
    binding,
    embedded: embeddedSummary,
    protection: protectionSummary,
    comparedProtectionTranscript,
  });
  return {
    protectedAudio,
    protectionTranscript,
    decisionHints: buildProtectedAudioDecisionHints(protectedAudio, protectionTranscript),
  };
}

function shouldCompareProtectionTranscript(
  binding: NonNullable<IKtepAsset['protectionAudio']>,
  embeddedSummary: ReturnType<typeof summarizeAudioHealth>,
  embeddedTranscript?: ITranscriptContext | null,
): boolean {
  if (!canUseProtectionAudio(binding) && binding.alignment !== 'unknown') return false;

  const issues = new Set(embeddedSummary.issues ?? []);
  if (issues.has('low-level') || issues.has('speech-coverage-weak') || issues.has('speech-clarity-suspect')) {
    return true;
  }

  if ((embeddedTranscript?.speechCoverage ?? 0) < 0.05) {
    return true;
  }

  return !(embeddedTranscript?.transcript?.trim());
}

async function resolveAvailableProtectionAudioLocalPath(input: {
  projectId: string;
  asset: IKtepAsset;
  roots: IMediaRoot[];
  deviceMaps: IDeviceMediaMapFile;
}): Promise<string | null> {
  const localPath = resolveProtectionAudioLocalPath(
    input.projectId,
    input.asset,
    input.roots,
    input.deviceMaps,
  );
  if (!localPath) return null;

  try {
    await access(localPath);
    return localPath;
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
      semanticKind: 'speech',
      reason: 'speech-window',
    })),
  );
}

function buildUnifiedFinalizePrompt(input: {
  prepared: IPreparedAssetAnalysis;
  transcript?: ITranscriptContext | null;
  audioContext?: IAudioAnalysisContext;
  densityScore: number;
  basePlan: IMediaAnalysisPlan;
  heuristicClipType: EClipType;
  budget?: ETargetBudget;
  manualSpatial?: IManualSpatialContext | null;
}): string {
  const transcriptExcerpt = buildTranscriptExcerpt(input.transcript) ?? 'none';
  const sourceContextText = buildSourceContextText(input.prepared.sourceContext);
  const signalPayload = JSON.stringify({
    duration_ms: input.prepared.asset.durationMs ?? 0,
    budget: input.budget ?? 'standard',
    heuristic_clip_type: input.heuristicClipType,
    density_score: Number(input.densityScore.toFixed(3)),
    shot_count_known: input.prepared.shotBoundariesResolved,
    shot_count: input.prepared.shotBoundariesResolved
      ? input.prepared.shotBoundaries.length
      : null,
    has_audio_track: input.prepared.hasAudioTrack,
    speech_coverage: Number((input.transcript?.speechCoverage ?? 0).toFixed(3)),
    has_meaningful_speech: hasMeaningfulSpeech(input.transcript),
    source_context: {
      ingest_root_id: input.prepared.sourceContext.ingestRootId ?? null,
      root_label: input.prepared.sourceContext.rootLabel ?? null,
      root_description: input.prepared.sourceContext.rootDescription ?? null,
      root_notes: input.prepared.sourceContext.rootNotes,
      summarized_text: sourceContextText || '',
    },
    manual_spatial_summary: input.manualSpatial?.gpsSummary ?? '',
    manual_spatial_hints: input.manualSpatial?.placeHints ?? [],
    manual_transport: input.manualSpatial?.transport ?? '',
    interesting_windows: input.basePlan.interestingWindows.map(window => ({
      start_ms: window.startMs,
      end_ms: window.endMs,
      reason: window.reason,
    })),
    embedded_transcript_excerpt: transcriptExcerpt,
    protection_recommendation: input.audioContext?.decisionHints.protectionRecommendation ?? '',
    protection_transcript_excerpt: input.audioContext?.decisionHints.protectionTranscriptExcerpt ?? '',
  }, null, 2);

  return `You are producing visual summary and deciding semantic clip type and fine-scan policy for a travel documentary editing system.
Return only a raw JSON object with:
{
  "visual_summary": {
    "scene_type": string,
    "subjects": string[],
    "mood": string,
    "place_hints": string[],
    "narrative_role": string,
    "description": string
  },
  "decision": {
    "clip_type": "drive" | "talking-head" | "aerial" | "timelapse" | "broll" | "unknown",
    "should_fine_scan": boolean,
    "fine_scan_mode": "skip" | "windowed" | "full",
    "decision_reasons": string[]
  }
}

Rules:
- Use both the images and the textual signals below.
- Final clip_type must be semantic, not just based on duration heuristics.
- Strong audio means meaningful human speech. Background music, engine noise, road noise, ambience, or other non-speech sounds do not count as strong audio.
- If shot_count_known is false, treat shot_count as unavailable rather than evidence of zero cuts.
- Manual itinerary and spatial hints are weak evidence: useful for place/route inference, but weaker than clear visual or speech contradictions.
- If the frames clearly show sustained driving or road footage, prefer "drive" even when the heuristic clip type is "unknown".
- Do not classify a clip as "timelapse" unless the frames themselves show strong timelapse evidence. Transcript mentions, tripod/static scenery, or source context alone are insufficient.
- If either visual or speech evidence indicates promising regions, prefer "windowed" over "skip".
- Use "full" only for short high-value clips or when both visual and speech signals are strong.

Signals:
${signalPayload}`;
}

function parseUnifiedFinalizeAnalysis(raw: string): IUnifiedFinalizeAnalysis | null {
  const parsed = tryParseJsonObject(raw);
  if (!parsed || typeof parsed !== 'object') return null;

  const root = parsed as Record<string, unknown>;
  const visualNode = root['visual_summary'];
  const decisionNode = root['decision'];
  if (!visualNode || typeof visualNode !== 'object' || !decisionNode || typeof decisionNode !== 'object') {
    return null;
  }

  const clipType = normalizeClipType((decisionNode as Record<string, unknown>)['clip_type']
    ?? (decisionNode as Record<string, unknown>)['clipType']);
  const fineScanMode = normalizeFineScanMode((decisionNode as Record<string, unknown>)['fine_scan_mode']
    ?? (decisionNode as Record<string, unknown>)['fineScanMode']);
  if (!clipType || !fineScanMode) return null;

  const rawShouldFineScan = (decisionNode as Record<string, unknown>)['should_fine_scan']
    ?? (decisionNode as Record<string, unknown>)['shouldFineScan'];
  const shouldFineScan = typeof rawShouldFineScan === 'boolean'
    ? rawShouldFineScan && fineScanMode !== 'skip'
    : fineScanMode !== 'skip';
  const decisionReasons = Array.isArray((decisionNode as Record<string, unknown>)['decision_reasons'])
    ? ((decisionNode as Record<string, unknown>)['decision_reasons'] as unknown[])
      .filter((value): value is string => typeof value === 'string')
    : [];

  return {
    visualSummary: {
      sceneType: normalizePromptString((visualNode as Record<string, unknown>)['scene_type']) ?? 'unknown',
      subjects: normalizePromptStringArray((visualNode as Record<string, unknown>)['subjects']),
      mood: normalizePromptString((visualNode as Record<string, unknown>)['mood']) ?? 'unknown',
      placeHints: normalizePromptStringArray((visualNode as Record<string, unknown>)['place_hints']),
      narrativeRole: normalizePromptString((visualNode as Record<string, unknown>)['narrative_role']) ?? 'unknown',
      description: normalizePromptString((visualNode as Record<string, unknown>)['description']) ?? '',
      evidence: [],
    },
    decision: {
      clipType,
      shouldFineScan,
      fineScanMode,
      decisionReasons,
    },
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

function normalizePromptString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

function normalizePromptStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map(item => item.trim())
    .filter(Boolean);
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

function buildProtectedAudioDecisionHints(
  protectedAudio?: IAssetCoarseReport['protectedAudio'],
  protectionTranscript?: ITranscriptContext | null,
): IAudioDecisionHints {
  if (!protectedAudio) {
    return {};
  }

  return {
    protectionRecommendation: [
      `recommended:${protectedAudio.recommendedSource}`,
      protectedAudio.reason ? `reason:${protectedAudio.reason}` : undefined,
      protectedAudio.comparedProtectionTranscript ? 'compared-transcript:true' : undefined,
    ]
      .filter(Boolean)
      .join(' | '),
    protectionTranscriptExcerpt: buildTranscriptExcerpt(protectionTranscript, 240),
  };
}

function buildPreparedSourceContext(
  asset: IKtepAsset,
  roots: IMediaRoot[],
): IPreparedSourceContext {
  const root = roots.find(item => item.id === asset.ingestRootId);
  return {
    ingestRootId: asset.ingestRootId,
    rootLabel: root?.label,
    rootDescription: root?.description,
    rootNotes: root?.notes ?? [],
  };
}

function buildSourceContextText(
  sourceContext?: IPreparedSourceContext | null,
): string {
  return [
    sourceContext?.rootLabel,
    sourceContext?.rootDescription,
    ...(sourceContext?.rootNotes ?? []),
  ]
    .filter(Boolean)
    .join(' ')
    .trim();
}

function resolveHeuristicClipType(prepared: IPreparedAssetAnalysis): EClipType {
  if (prepared.asset.kind === 'photo') return 'broll';
  if (prepared.asset.kind === 'audio') return 'unknown';
  return guessClipType(
    prepared.asset,
    prepared.shotBoundaries,
    prepared.shotBoundariesResolved,
  );
}

function decorateSliceWithTranscript(
  slice: IKtepSlice,
  transcript?: ITranscriptContext | null,
  extraEvidence: IKtepEvidence[] = [],
): IKtepSlice {
  if (!transcript || !transcript.transcript || (slice.type === 'drive' && slice.semanticKind === 'visual')) {
    const evidence = dedupeEvidence([...(slice.evidence ?? []), ...extraEvidence]);
    return evidence.length > 0
      ? { ...slice, evidence }
      : slice;
  }

  const match = collectTranscriptForSlice(slice, transcript);
  const transcriptSummary = shouldUseTranscriptSummary(slice)
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

function shouldUseTranscriptSummary(
  slice: Pick<IKtepSlice, 'summary' | 'semanticKind'>,
): boolean {
  if (slice.semanticKind === 'speech') return true;
  if (slice.semanticKind === 'visual') return false;
  const summary = slice.summary;
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

  return {
    ...input,
    shotBoundaries: [],
    shotBoundariesResolved: true,
    sampleFrames,
    coarseSampleTimestamps: [0],
    hasAudioTrack: false,
    sourceContext: buildPreparedSourceContext(input.asset, input.roots),
  };
}

async function finalizePhotoPreparedAsset(
  input: IFinalizePreparedAssetInput,
): Promise<IFinalizedAssetAnalysis> {
  const density = estimateDensity({ durationMs: 0, shotBoundaries: [] });
  const clipTypeGuess: EClipType = 'broll';
  const ml = await input.getMlHandle();
  const visualSummary = await summarizeSamples({
    asset: input.prepared.asset,
    ml,
    sampleFrames: input.prepared.sampleFrames,
    performance: input.performance,
    phase: 'finalize',
  });
  const root = input.roots.find(item => item.id === input.prepared.asset.ingestRootId);
  const manualSpatial = await resolveManualSpatialContext({
    asset: input.prepared.asset,
    root,
    gpxPaths: input.gpxPaths,
    gpxMatchToleranceMs: input.gpxMatchToleranceMs,
    derivedTrack: input.derivedTrack,
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
    inferredGps: manualSpatial?.inferredGps,
    summary: visualSummary?.description,
    labels: buildReportLabels(
      clipTypeGuess,
      visualSummary?.sceneType,
      visualSummary?.subjects,
    ),
    placeHints: dedupeStrings([
      ...(visualSummary?.placeHints ?? []),
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
    visualSummary,
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

function resolveFineScanPrefetchLimits(
  runtimeConfig: IAnalyzeSingleAssetInput['runtimeConfig'],
): IFineScanPrefetchLimits {
  const baseConcurrency = Math.max(
    1,
    Math.floor(runtimeConfig.fineScanPrefetchBaseConcurrency ?? CFINE_SCAN_PREFETCH_DEFAULTS.baseConcurrency),
  );
  const maxConcurrency = Math.max(
    baseConcurrency,
    Math.floor(runtimeConfig.fineScanPrefetchMaxConcurrency ?? CFINE_SCAN_PREFETCH_DEFAULTS.maxConcurrency),
  );
  return {
    baseConcurrency,
    maxConcurrency,
    minFreeMemoryMb: Math.max(
      1,
      Math.floor(runtimeConfig.fineScanPrefetchMinFreeMemoryMb ?? CFINE_SCAN_PREFETCH_DEFAULTS.minFreeMemoryMb),
    ),
    maxReadyAssets: Math.max(
      1,
      Math.floor(runtimeConfig.fineScanPrefetchMaxReadyAssets ?? CFINE_SCAN_PREFETCH_DEFAULTS.maxReadyAssets),
    ),
    maxReadyFrameMb: Math.max(
      1,
      Math.floor(runtimeConfig.fineScanPrefetchMaxReadyFrameMb ?? CFINE_SCAN_PREFETCH_DEFAULTS.maxReadyFrameMb),
    ),
  };
}

export function resolveFineScanPrefetchTargetConcurrency(input: {
  limits: IFineScanPrefetchLimits;
  freeMemoryMb: number;
  readyAssetCount: number;
  readyFrameBytes: number;
  hasFramesReady: boolean;
  hasActivePrefetch: boolean;
  hasPendingPrefetch: boolean;
}): number {
  const readyFrameMb = input.readyFrameBytes / (1024 * 1024);
  if (
    input.readyAssetCount >= input.limits.maxReadyAssets
    || readyFrameMb >= input.limits.maxReadyFrameMb
  ) {
    return 0;
  }

  const effectiveFreeMemoryMb = Math.max(0, Math.floor(input.freeMemoryMb));
  if (effectiveFreeMemoryMb < input.limits.minFreeMemoryMb) {
    if (!input.hasFramesReady && !input.hasActivePrefetch && input.hasPendingPrefetch) {
      return 1;
    }
    return 0;
  }

  if (effectiveFreeMemoryMb >= input.limits.minFreeMemoryMb * 2) {
    return input.limits.maxConcurrency;
  }

  return input.limits.baseConcurrency;
}

function buildFineScanOutputDir(projectRoot: string, assetId: string): string {
  return join(buildAssetTempDir(projectRoot, assetId), 'fine-scan');
}

function buildFineScanExpectedFramePaths(
  projectRoot: string,
  assetId: string,
  timestampsMs: number[],
): string[] {
  const outputDir = buildFineScanOutputDir(projectRoot, assetId);
  return timestampsMs.map(timeMs => join(outputDir, `kf_${timeMs}.jpg`));
}

async function resolveReadyFineScanFrames(
  checkpoint: IFineScanCheckpoint,
): Promise<{ frames: IKeyframeResult[]; readyFrameCount: number; readyFrameBytes: number }> {
  const frames = (
    await Promise.all(checkpoint.expectedFramePaths.map(async (path, index) => {
      try {
        const frameStat = await stat(path);
        return {
          timeMs: checkpoint.timestampsMs[index] ?? 0,
          path,
          size: frameStat.size,
        };
      } catch {
        return null;
      }
    }))
  ).filter((frame): frame is { timeMs: number; path: string; size: number } => Boolean(frame));

  return {
    frames: frames.map(({ timeMs, path }) => ({ timeMs, path })),
    readyFrameCount: frames.length,
    readyFrameBytes: frames.reduce((sum, frame) => sum + frame.size, 0),
  };
}

function buildFineScanSlicesFallback(
  effectiveSlices: IKtepSlice[],
  transcript: ITranscriptContext | null | undefined,
  report: IAssetCoarseReport,
): IKtepSlice[] {
  return effectiveSlices.map(slice => {
    const withTranscript = decorateSliceWithTranscript(slice, transcript);
    return {
      ...withTranscript,
      summary: withTranscript.summary ?? report.summary ?? withTranscript.transcript,
      labels: dedupeStrings([...withTranscript.labels, ...report.labels]),
      placeHints: dedupeStrings([...withTranscript.placeHints, ...report.placeHints]),
    };
  });
}

function buildFineScanPlan(input: IBuildFineScanSlicesInput): {
  effectiveSlices: IKtepSlice[];
  keyframePlans: IShotKeyframePlan[];
  timestampsMs: number[];
  expectedFramePaths: string[];
} {
  const baseSlices = input.report.fineScanMode === 'full'
    ? sliceVideo(input.asset, input.shotBoundaries)
    : sliceInterestingWindows(
      input.asset,
      input.report.interestingWindows,
      mapClipTypeToSliceType(input.clipType),
    );
  const rawSlices = baseSlices.length > 0
    ? baseSlices
    : input.report.fineScanMode === 'windowed' && (input.asset.durationMs ?? 0) > 0
      ? sliceInterestingWindows(
        input.asset,
        [{
          startMs: 0,
          endMs: input.asset.durationMs ?? 0,
          ...(input.clipType === 'drive' ? { semanticKind: 'visual' as const } : {}),
          reason: 'whole-asset-window-fallback',
        }],
        mapClipTypeToSliceType(input.clipType),
      )
      : baseSlices;
  const effectiveSlices = rawSlices.map(slice =>
    applySliceWindowSemantics(
      slice,
      input.clipType,
      input.asset.durationMs ?? 0,
    ),
  );
  const keyframePlans = buildFineScanKeyframePlans(effectiveSlices);
  const timestampsMs = [...new Set(keyframePlans.flatMap(plan => plan.timestampsMs))].sort((a, b) => a - b);

  return {
    effectiveSlices,
    keyframePlans,
    timestampsMs,
    expectedFramePaths: buildFineScanExpectedFramePaths(input.projectRoot, input.asset.id, timestampsMs),
  };
}

async function normalizeFineScanCheckpointForResume(
  projectRoot: string,
  checkpoint: IFineScanCheckpoint,
): Promise<IFineScanCheckpoint> {
  const ready = await resolveReadyFineScanFrames(checkpoint);
  const hasReadyFrames = ready.readyFrameCount > 0 || checkpoint.timestampsMs.length === 0;
  const nextStatus = checkpoint.status === 'prefetching'
    ? (hasReadyFrames ? 'frames-ready' : 'frame-plan-ready')
    : checkpoint.status === 'recognizing'
      ? (hasReadyFrames ? 'frames-ready' : 'frame-plan-ready')
      : checkpoint.status === 'persisted'
        ? (hasReadyFrames ? 'frames-ready' : 'frame-plan-ready')
        : checkpoint.status === 'frame-plan-ready' && hasReadyFrames
          ? 'frames-ready'
          : checkpoint.status === 'frames-ready' && !hasReadyFrames
            ? 'frame-plan-ready'
            : checkpoint.status;

  const normalized: IFineScanCheckpoint = {
    ...checkpoint,
    status: nextStatus,
    readyFrameCount: ready.readyFrameCount,
    readyFrameBytes: ready.readyFrameBytes,
  };

  if (
    normalized.status !== checkpoint.status
    || normalized.readyFrameCount !== checkpoint.readyFrameCount
    || normalized.readyFrameBytes !== checkpoint.readyFrameBytes
  ) {
    await writeFineScanCheckpoint(projectRoot, normalized);
  }

  return normalized;
}

async function ensureFineScanTaskState(input: {
  analysis: IFinalizedAssetAnalysis;
  projectRoot: string;
  runtimeConfig: IAnalyzeSingleAssetInput['runtimeConfig'];
  getMlHandle: () => Promise<MlAvailability>;
  performance?: AnalyzePerformanceSession;
}): Promise<IFineScanTaskState | null> {
  if (!input.analysis.report.shouldFineScan) return null;

  const assetId = input.analysis.prepared.asset.id;
  const existingCheckpoint = await loadFineScanCheckpoint(input.projectRoot, assetId);
  if (existingCheckpoint) {
    return {
      analysis: input.analysis,
      checkpoint: await normalizeFineScanCheckpointForResume(input.projectRoot, existingCheckpoint),
      plannedAtMs: Date.now(),
      persisted: false,
    };
  }

  if (input.analysis.prepared.asset.kind === 'audio') {
    const checkpoint: IFineScanCheckpoint = {
      assetId,
      status: 'frames-ready',
      effectiveSlices: [],
      keyframePlans: [],
      timestampsMs: [],
      expectedFramePaths: [],
      readyFrameCount: 0,
      readyFrameBytes: 0,
      droppedInvalidSliceCount: 0,
      updatedAt: new Date().toISOString(),
    };
    await writeFineScanCheckpoint(input.projectRoot, checkpoint);
    return {
      analysis: input.analysis,
      checkpoint,
      plannedAtMs: Date.now(),
      persisted: false,
    };
  }

  if (input.analysis.prepared.asset.kind === 'photo') {
    const checkpoint: IFineScanCheckpoint = {
      assetId,
      status: 'frames-ready',
      effectiveSlices: [slicePhoto(input.analysis.prepared.asset)],
      keyframePlans: [],
      timestampsMs: [],
      expectedFramePaths: [],
      readyFrameCount: 0,
      readyFrameBytes: 0,
      droppedInvalidSliceCount: 0,
      updatedAt: new Date().toISOString(),
    };
    await writeFineScanCheckpoint(input.projectRoot, checkpoint);
    return {
      analysis: input.analysis,
      checkpoint,
      plannedAtMs: Date.now(),
      persisted: false,
    };
  }

  let prepared = input.analysis.prepared;
  if (input.analysis.report.fineScanMode === 'full' && !prepared.shotBoundariesResolved) {
    prepared = await runDeferredSceneDetect({
      prepared,
      phase: 'fine-scan',
      clipType: input.analysis.clipType,
      performance: input.performance,
    });
    input.analysis.prepared = prepared;
  }

  const plan = buildFineScanPlan({
    asset: prepared.asset,
    localPath: prepared.localPath,
    projectRoot: input.projectRoot,
    roots: [],
    runtimeConfig: input.runtimeConfig,
    shotBoundaries: prepared.shotBoundaries,
    report: input.analysis.report,
    transcript: input.analysis.transcript,
    clipType: input.analysis.clipType,
    ml: await input.getMlHandle(),
    performance: input.performance,
  });
  const checkpoint: IFineScanCheckpoint = {
    assetId,
    status: plan.expectedFramePaths.length > 0 ? 'frame-plan-ready' : 'frames-ready',
    effectiveSlices: plan.effectiveSlices,
    keyframePlans: plan.keyframePlans,
    timestampsMs: plan.timestampsMs,
    expectedFramePaths: plan.expectedFramePaths,
    readyFrameCount: 0,
    readyFrameBytes: 0,
    droppedInvalidSliceCount: 0,
    updatedAt: new Date().toISOString(),
  };
  await writeFineScanCheckpoint(input.projectRoot, checkpoint);
  return {
    analysis: input.analysis,
    checkpoint,
    plannedAtMs: Date.now(),
    persisted: false,
  };
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
    keyframeExtractConcurrency?: number;
    fineScanPrefetchBaseConcurrency?: number;
    fineScanPrefetchMaxConcurrency?: number;
    fineScanPrefetchMinFreeMemoryMb?: number;
    fineScanPrefetchMaxReadyAssets?: number;
    fineScanPrefetchMaxReadyFrameMb?: number;
    mlServerUrl?: string;
  };
  getMlHandle: () => Promise<MlAvailability>;
  performance?: AnalyzePerformanceSession;
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

  let prepared = input.analysis.prepared;
  if (input.analysis.report.fineScanMode === 'full' && !prepared.shotBoundariesResolved) {
    prepared = await runDeferredSceneDetect({
      prepared,
      phase: 'fine-scan',
      clipType: input.analysis.clipType,
      performance: input.performance,
    });
    input.analysis.prepared = prepared;
  }

  return buildFineScanSlices({
    asset: prepared.asset,
    localPath: prepared.localPath,
    projectRoot: input.projectRoot,
    roots: input.roots,
    runtimeConfig: input.runtimeConfig,
    shotBoundaries: prepared.shotBoundaries,
    report: input.analysis.report,
    transcript: input.analysis.transcript,
    clipType: input.analysis.clipType,
    ml: await input.getMlHandle(),
    performance: input.performance,
  });
}

function describeAudioAnalysisStage(
  asset: IKtepAsset,
  hasAudioTrack: boolean,
): string {
  if (asset.kind === 'audio') {
    return `正在整理 ${asset.displayName} 的音频上下文`;
  }
  if (shouldAnalyzeAudioTrack(asset, hasAudioTrack)) {
    return `正在分析 ${asset.displayName} 的视频内音轨并评估 protection audio`;
  }
  return `正在检查 ${asset.displayName} 是否需要补充 protection audio 对比`;
}

function describeFinalizeStage(
  asset: IKtepAsset,
  hasAudioTrack: boolean,
): string {
  if (asset.kind === 'photo') {
    return `正在统一完成 ${asset.displayName} 的视觉总结与正式报告`;
  }
  if (asset.kind === 'audio') {
    return `正在整理 ${asset.displayName} 的分析结果`;
  }
  if (shouldAnalyzeAudioTrack(asset, hasAudioTrack)) {
    return `正在结合关键帧、音轨与上下文统一完成 ${asset.displayName} 的视觉总结与切片决策`;
  }
  return `未检测到可用音轨，正在基于关键帧与上下文统一完成 ${asset.displayName} 的视觉总结与切片决策`;
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
    semanticKind: 'visual' as const,
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
  shotBoundariesResolved = true,
): EClipType {
  if (asset.kind === 'photo') return 'broll';
  if (!shotBoundariesResolved) {
    return (asset.durationMs ?? 0) <= 20_000 ? 'broll' : 'unknown';
  }

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
    interestingWindows: IInterestingWindow[];
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
    if (
      typeof window.editStartMs === 'number'
      && typeof window.editEndMs === 'number'
      && (window.editStartMs !== window.startMs || window.editEndMs !== window.endMs)
    ) {
      reasons.add('edit-window-expanded');
    }
    if (window.speedCandidate) {
      reasons.add('drive-speed-candidate');
    }
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
    if (current.startMs <= previous.endMs && canMergeInterestingWindowSemantics(previous, current)) {
      previous.endMs = Math.max(previous.endMs, current.endMs);
      previous.semanticKind = previous.semanticKind ?? current.semanticKind;
      previous.reason = previous.reason === current.reason
        ? previous.reason
        : `${previous.reason}+${current.reason}`;
      continue;
    }
    merged.push({ ...current });
  }

  return merged;
}

function canMergeInterestingWindowSemantics(
  left: Pick<IInterestingWindow, 'semanticKind'>,
  right: Pick<IInterestingWindow, 'semanticKind'>,
): boolean {
  return left.semanticKind == null
    || right.semanticKind == null
    || left.semanticKind === right.semanticKind;
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
    keyframeExtractConcurrency?: number;
    fineScanPrefetchBaseConcurrency?: number;
    fineScanPrefetchMaxConcurrency?: number;
    fineScanPrefetchMinFreeMemoryMb?: number;
    fineScanPrefetchMaxReadyAssets?: number;
    fineScanPrefetchMaxReadyFrameMb?: number;
    mlServerUrl?: string;
  };
  shotBoundaries: IShotBoundary[];
  report: IAssetCoarseReport;
  transcript?: ITranscriptContext | null;
  roots: IMediaRoot[];
  clipType: EClipType;
  ml: MlAvailability;
  performance?: AnalyzePerformanceSession;
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
  const rawSlices = baseSlices.length > 0
    ? baseSlices
    : input.report.fineScanMode === 'windowed' && (input.asset.durationMs ?? 0) > 0
      ? sliceInterestingWindows(
        input.asset,
        [{
          startMs: 0,
          endMs: input.asset.durationMs ?? 0,
          ...(input.clipType === 'drive' ? { semanticKind: 'visual' as const } : {}),
          reason: 'whole-asset-window-fallback',
        }],
        mapClipTypeToSliceType(input.clipType),
      )
      : baseSlices;
  const effectiveSlices = rawSlices.map(slice =>
    applySliceWindowSemantics(
      slice,
      input.clipType,
      input.asset.durationMs ?? 0,
    ),
  );

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
  const fineKeyframeStartedAt = Date.now();
  const extractedFrames = await extractKeyframes(
    input.localPath,
    join(buildAssetTempDir(input.projectRoot, input.asset.id), 'fine-scan'),
    timestamps,
    input.runtimeConfig,
  );
  input.performance?.recordKeyframeExtract({
    asset: input.asset,
    phase: 'fine',
    elapsedMs: Date.now() - fineKeyframeStartedAt,
    keyframeCount: extractedFrames.length,
  });
  const keyframes = await filterExistingKeyframes(extractedFrames);
  const groups = groupKeyframesByShot(plans, keyframes);
  const recognitions = await recognizeShotGroups(input.ml.client, groups);
  for (const recognition of recognitions) {
    input.performance?.recordVlm({
      asset: input.asset,
      phase: 'fine',
      imageCount: recognition.framePaths.length,
      roundTripMs: recognition.recognition.roundTripMs,
      timing: recognition.recognition.timing,
    });
  }
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

async function prefetchFineScanTask(input: {
  task: IFineScanTaskState;
  projectRoot: string;
  runtimeConfig: IAnalyzeSingleAssetInput['runtimeConfig'];
  performance?: AnalyzePerformanceSession;
}): Promise<IFineScanTaskState> {
  const { task } = input;
  const checkpoint = {
    ...task.checkpoint,
    status: 'prefetching' as const,
  };
  await writeFineScanCheckpoint(input.projectRoot, checkpoint);

  if (checkpoint.timestampsMs.length > 0) {
    const fineKeyframeStartedAt = Date.now();
    const extractedFrames = await extractKeyframes(
      task.analysis.prepared.localPath,
      buildFineScanOutputDir(input.projectRoot, task.analysis.prepared.asset.id),
      checkpoint.timestampsMs,
      input.runtimeConfig,
      { concurrencyOverride: 1 },
    );
    input.performance?.recordKeyframeExtract({
      asset: task.analysis.prepared.asset,
      phase: 'fine',
      elapsedMs: Date.now() - fineKeyframeStartedAt,
      keyframeCount: extractedFrames.length,
    });

    const readyFrames = await Promise.all(extractedFrames.map(async frame => {
      try {
        const frameStat = await stat(frame.path);
        return {
          ...frame,
          size: frameStat.size,
        };
      } catch {
        return null;
      }
    }));
    const existingFrames = readyFrames.filter((frame): frame is IKeyframeResult & { size: number } => Boolean(frame));
    const updatedCheckpoint: IFineScanCheckpoint = {
      ...checkpoint,
      status: 'frames-ready',
      timestampsMs: existingFrames.map(frame => frame.timeMs),
      expectedFramePaths: existingFrames.map(frame => frame.path),
      readyFrameCount: existingFrames.length,
      readyFrameBytes: existingFrames.reduce((sum, frame) => sum + frame.size, 0),
    };
    await writeFineScanCheckpoint(input.projectRoot, updatedCheckpoint);
    return {
      ...task,
      checkpoint: updatedCheckpoint,
      prefetchedAtMs: Date.now(),
    };
  }

  const updatedCheckpoint: IFineScanCheckpoint = {
    ...checkpoint,
    status: 'frames-ready',
    readyFrameCount: 0,
    readyFrameBytes: 0,
  };
  await writeFineScanCheckpoint(input.projectRoot, updatedCheckpoint);
  return {
    ...task,
    checkpoint: updatedCheckpoint,
    prefetchedAtMs: Date.now(),
  };
}

async function recognizeFineScanTask(input: {
  task: IFineScanTaskState;
  projectRoot: string;
  runtimeConfig: IAnalyzeSingleAssetInput['runtimeConfig'];
  getMlHandle: () => Promise<MlAvailability>;
  performance?: AnalyzePerformanceSession;
}): Promise<IFineScanRecognitionResult> {
  const updatedCheckpoint: IFineScanCheckpoint = {
    ...input.task.checkpoint,
    status: 'recognizing',
  };
  await writeFineScanCheckpoint(input.projectRoot, updatedCheckpoint);
  let slices: IKtepSlice[] = [];
  let droppedInvalidSliceCount = 0;

  if (input.task.analysis.prepared.asset.kind === 'photo') {
    const slice = updatedCheckpoint.effectiveSlices[0] ?? slicePhoto(input.task.analysis.prepared.asset);
    slice.summary = input.task.analysis.report.summary;
    slice.labels = input.task.analysis.report.labels;
    slice.placeHints = input.task.analysis.report.placeHints;
    slices = [slice];
  } else if (input.task.analysis.prepared.asset.kind === 'audio') {
    slices = [];
  } else {
    const readyFrames = await resolveReadyFineScanFrames(updatedCheckpoint);
    if (updatedCheckpoint.effectiveSlices.length === 0) {
      slices = [];
    } else if (updatedCheckpoint.keyframePlans.length === 0) {
      slices = buildFineScanSlicesFallback(
        updatedCheckpoint.effectiveSlices,
        input.task.analysis.transcript,
        input.task.analysis.report,
      );
    } else {
      const ml = await input.getMlHandle();
      const groups = groupKeyframesByShot(updatedCheckpoint.keyframePlans, readyFrames.frames);
      const recognitions = await recognizeShotGroups(ml.client, groups);
      for (const recognition of recognitions) {
        input.performance?.recordVlm({
          asset: input.task.analysis.prepared.asset,
          phase: 'fine',
          imageCount: recognition.framePaths.length,
          roundTripMs: recognition.recognition.roundTripMs,
          timing: recognition.recognition.timing,
        });
      }
      const recognitionMap = new Map(recognitions.map(item => [item.shotId, item]));

      for (const slice of updatedCheckpoint.effectiveSlices) {
        const recognition = recognitionMap.get(slice.id);
        if (recognition && isLikelyInvalidVisualSegment(recognition.recognition.description)) {
          droppedInvalidSliceCount += 1;
          continue;
        }
        const withTranscript = decorateSliceWithTranscript(
          slice,
          input.task.analysis.transcript,
          recognition?.recognition.evidence,
        );
        slices.push({
          ...withTranscript,
          summary: recognition?.recognition.description
            || withTranscript.summary
            || input.task.analysis.report.summary
            || withTranscript.transcript,
          labels: dedupeStrings([
            ...withTranscript.labels,
            ...input.task.analysis.report.labels,
            recognition?.recognition.sceneType,
            ...(recognition?.recognition.subjects ?? []),
          ]),
          placeHints: dedupeStrings([
            ...withTranscript.placeHints,
            ...input.task.analysis.report.placeHints,
            ...(recognition?.recognition.placeHints ?? []),
          ]),
        });
      }
    }
  }

  return {
    task: {
      ...input.task,
      checkpoint: updatedCheckpoint,
    },
    slices,
    updatedReport: reconcileFineScanReport({
      report: input.task.analysis.report,
      slices,
      droppedInvalidSliceCount,
    }),
    droppedInvalidSliceCount,
  };
}

function countReadyFineScanAssets(tasks: IFineScanTaskState[]): number {
  return tasks.filter(task =>
    task.checkpoint.status === 'frames-ready'
    || task.checkpoint.status === 'recognizing',
  ).length;
}

function sumReadyFineScanFrameBytes(tasks: IFineScanTaskState[]): number {
  return tasks
    .filter(task =>
      task.checkpoint.status === 'frames-ready'
      || task.checkpoint.status === 'recognizing',
    )
    .reduce((sum, task) => sum + task.checkpoint.readyFrameBytes, 0);
}

async function runFineScanPipeline(input: {
  fineScanCandidates: IFinalizedAssetAnalysis[];
  fineScanPhaseStartedAtMs: number;
  projectId: string;
  projectName: string;
  projectRoot: string;
  runtimeConfig: IAnalyzeSingleAssetInput['runtimeConfig'];
  getMlHandle: () => Promise<MlAvailability>;
  performance?: AnalyzePerformanceSession;
  writeTrackedProgress: (payload: Parameters<typeof writeKairosProgress>[1]) => Promise<unknown>;
  writeTrackedReport: (asset: IKtepAsset, report: IAssetCoarseReport) => Promise<void>;
  appendTrackedSlices: (asset: IKtepAsset, slices: IKtepSlice[]) => Promise<void>;
}): Promise<{
  pendingSlices: IKtepSlice[];
  fineScannedAssetIds: string[];
}> {
  const preparedTasks = (
    await Promise.all(input.fineScanCandidates.map(async analysis => ensureFineScanTaskState({
      analysis,
      projectRoot: input.projectRoot,
      runtimeConfig: input.runtimeConfig,
      getMlHandle: input.getMlHandle,
      performance: input.performance,
    })))
  ).filter((task): task is IFineScanTaskState => Boolean(task));

  if (preparedTasks.length === 0) {
    return {
      pendingSlices: [],
      fineScannedAssetIds: [],
    };
  }

  const limits = resolveFineScanPrefetchLimits(input.runtimeConfig);
  const pendingSlices: IKtepSlice[] = [];
  const fineScannedAssetIds: string[] = [];
  const activePrefetches = new Map<string, Promise<IFineScanTaskState>>();
  let activeRecognition: { assetId: string; promise: Promise<IFineScanRecognitionResult> } | null = null;
  let prefetchedCount = preparedTasks.filter(task =>
    task.checkpoint.status === 'frames-ready'
    || task.checkpoint.status === 'recognizing'
    || task.checkpoint.status === 'persisted',
  ).length;
  let recognizedCount = preparedTasks.filter(task => task.persisted).length;

  const writeFineScanProgress = async (
    stage: 'fine-scan-prefetch' | 'fine-scan-recognition',
    task?: IFineScanTaskState,
    detail?: string,
  ) => {
    const current = stage === 'fine-scan-prefetch' ? prefetchedCount : recognizedCount;
    const readyAssetCount = countReadyFineScanAssets(preparedTasks);
    const readyFrameBytes = sumReadyFineScanFrameBytes(preparedTasks);
    const activePrefetchCount = activePrefetches.size;
    const activeRecognitionCount = activeRecognition ? 1 : 0;
    await input.writeTrackedProgress({
      status: 'running',
      pipelineKey: 'media-analyze',
      pipelineLabel: '素材分析流程',
      phaseKey: 'coarse-first-project-analysis',
      phaseLabel: '粗扫优先素材分析',
      step: stage,
      stepLabel: stage === 'fine-scan-prefetch' ? '预抽细扫关键帧' : '识别细扫素材',
      stepIndex: CANALYZE_STEP_DEFINITIONS.findIndex(item => item.key === stage) + 1,
      stepTotal: CANALYZE_STEP_DEFINITIONS.length,
      stepDefinitions: [...CANALYZE_STEP_DEFINITIONS],
      fileName: task?.analysis.prepared.asset.displayName,
      fileIndex: current,
      fileTotal: preparedTasks.length,
      current,
      total: preparedTasks.length,
      unit: 'assets',
      etaSeconds: estimatePhaseEtaSeconds(
        input.fineScanPhaseStartedAtMs,
        current,
        preparedTasks.length,
      ),
      detail,
      extra: {
        projectId: input.projectId,
        projectName: input.projectName,
        assetId: task?.analysis.prepared.asset.id,
        fineScanMode: task?.analysis.report.fineScanMode,
        fineScanAssetTotal: preparedTasks.length,
        prefetchedAssetCount: prefetchedCount,
        recognizedAssetCount: recognizedCount,
        readyAssetCount,
        readyFrameBytes,
        activePrefetchCount,
        activeRecognitionCount,
        persistedAssetCount: recognizedCount,
      },
    });
  };

  while (recognizedCount < preparedTasks.length) {
    while (true) {
      const pendingPrefetchTasks = preparedTasks.filter(task =>
        !task.persisted
        && task.checkpoint.status === 'frame-plan-ready'
        && !activePrefetches.has(task.analysis.prepared.asset.id),
      );
      if (pendingPrefetchTasks.length === 0) break;

      const targetPrefetchConcurrency = resolveFineScanPrefetchTargetConcurrency({
        limits,
        freeMemoryMb: freemem() / (1024 * 1024),
        readyAssetCount: countReadyFineScanAssets(preparedTasks),
        readyFrameBytes: sumReadyFineScanFrameBytes(preparedTasks),
        hasFramesReady: preparedTasks.some(task => task.checkpoint.status === 'frames-ready'),
        hasActivePrefetch: activePrefetches.size > 0,
        hasPendingPrefetch: pendingPrefetchTasks.length > 0,
      });
      if (targetPrefetchConcurrency <= activePrefetches.size) break;

      const nextPrefetchTask = pendingPrefetchTasks[0];
      if (!nextPrefetchTask) break;

      activePrefetches.set(
        nextPrefetchTask.analysis.prepared.asset.id,
        prefetchFineScanTask({
          task: nextPrefetchTask,
          projectRoot: input.projectRoot,
          runtimeConfig: input.runtimeConfig,
          performance: input.performance,
        }),
      );
      if (!activeRecognition) {
        await writeFineScanProgress(
          'fine-scan-prefetch',
          nextPrefetchTask,
          `正在为 ${nextPrefetchTask.analysis.prepared.asset.displayName} 预抽细扫关键帧`,
        );
      }
    }

    if (!activeRecognition) {
      const nextRecognitionTask = preparedTasks.find(task =>
        !task.persisted && task.checkpoint.status === 'frames-ready',
      );
      if (nextRecognitionTask) {
        activeRecognition = {
          assetId: nextRecognitionTask.analysis.prepared.asset.id,
          promise: recognizeFineScanTask({
            task: nextRecognitionTask,
            projectRoot: input.projectRoot,
            runtimeConfig: input.runtimeConfig,
            getMlHandle: input.getMlHandle,
            performance: input.performance,
          }),
        };
        await writeFineScanProgress(
          'fine-scan-recognition',
          nextRecognitionTask,
          `正在识别 ${nextRecognitionTask.analysis.prepared.asset.displayName} 的细扫素材`,
        );
      }
    }

    const pendingEvents: Array<Promise<
      | { type: 'prefetch'; assetId: string; task: IFineScanTaskState }
      | { type: 'recognition'; assetId: string; result: IFineScanRecognitionResult }
    >> = [];
    for (const [assetId, promise] of activePrefetches.entries()) {
      pendingEvents.push(promise.then(task => ({ type: 'prefetch' as const, assetId, task })));
    }
    if (activeRecognition) {
      const recognitionHandle = activeRecognition;
      pendingEvents.push(
        recognitionHandle.promise.then(result => ({
          type: 'recognition' as const,
          assetId: recognitionHandle.assetId,
          result,
        })),
      );
    }

    if (pendingEvents.length === 0) {
      break;
    }

    const nextEvent = await Promise.race(pendingEvents);
    if (nextEvent.type === 'prefetch') {
      activePrefetches.delete(nextEvent.assetId);
      const taskIndex = preparedTasks.findIndex(task => task.analysis.prepared.asset.id === nextEvent.assetId);
      if (taskIndex >= 0) {
        preparedTasks[taskIndex] = nextEvent.task;
      }
      prefetchedCount = preparedTasks.filter(task =>
        task.checkpoint.status === 'frames-ready'
        || task.checkpoint.status === 'recognizing'
        || task.checkpoint.status === 'persisted',
      ).length;
      if (!activeRecognition) {
        await writeFineScanProgress(
          'fine-scan-prefetch',
          nextEvent.task,
          `已为 ${nextEvent.task.analysis.prepared.asset.displayName} 准备 ${nextEvent.task.checkpoint.readyFrameCount} 张细扫关键帧`,
        );
      }
      continue;
    }

    activeRecognition = null;
    const taskIndex = preparedTasks.findIndex(task => task.analysis.prepared.asset.id === nextEvent.assetId);
    if (taskIndex < 0) {
      continue;
    }

    const task = preparedTasks[taskIndex];
    const finalizedReport = finalizeFineScanReport(
      nextEvent.result.updatedReport,
      nextEvent.result.slices.length,
    );
    if (nextEvent.result.slices.length > 0) {
      await input.appendTrackedSlices(task.analysis.prepared.asset, nextEvent.result.slices);
      pendingSlices.push(...nextEvent.result.slices);
      fineScannedAssetIds.push(task.analysis.prepared.asset.id);
    }
    task.analysis.report = finalizedReport;
    await input.writeTrackedReport(task.analysis.prepared.asset, finalizedReport);
    await removePreparedAssetCheckpoint(input.projectRoot, task.analysis.prepared.asset.id);
    await writeFineScanCheckpoint(input.projectRoot, {
      ...task.checkpoint,
      status: 'persisted',
      droppedInvalidSliceCount: nextEvent.result.droppedInvalidSliceCount,
      readyFrameCount: 0,
      readyFrameBytes: 0,
    });
    await removeFineScanCheckpoint(input.projectRoot, task.analysis.prepared.asset.id);

    preparedTasks[taskIndex] = {
      ...task,
      checkpoint: {
        ...task.checkpoint,
        status: 'persisted',
        droppedInvalidSliceCount: nextEvent.result.droppedInvalidSliceCount,
        readyFrameCount: 0,
        readyFrameBytes: 0,
        updatedAt: new Date().toISOString(),
      },
      persisted: true,
    };
    input.performance?.recordStage(
      task.analysis.prepared.asset,
      'fine-scan',
      Date.now() - task.plannedAtMs,
    );
    input.performance?.recordDroppedInvalidSlices(
      task.analysis.prepared.asset,
      nextEvent.result.droppedInvalidSliceCount,
    );
    recognizedCount = preparedTasks.filter(entry => entry.persisted).length;
    await writeFineScanProgress(
      'fine-scan-recognition',
      preparedTasks[taskIndex],
      nextEvent.result.slices.length > 0
        ? `已为 ${task.analysis.prepared.asset.displayName} 生成 ${nextEvent.result.slices.length} 个候选切片`
        : `已完成 ${task.analysis.prepared.asset.displayName} 的细扫识别`,
    );
  }

  return {
    pendingSlices,
    fineScannedAssetIds,
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

async function summarizeSamples(input: {
  asset: IKtepAsset;
  ml: MlAvailability;
  sampleFrames: { path: string }[];
  performance?: AnalyzePerformanceSession;
  phase?: 'finalize';
}) {
  if (!input.ml.available || input.sampleFrames.length === 0) return null;

  const paths = pickRepresentativeFramePaths(input.sampleFrames.map(frame => frame.path), 6);
  if (paths.length === 0) return null;

  try {
    const recognition = await recognizeFrames(input.ml.client, paths);
    input.performance?.recordVlm({
      asset: input.asset,
      phase: input.phase ?? 'finalize',
      imageCount: recognition.imageCount ?? paths.length,
      roundTripMs: recognition.roundTripMs,
      timing: recognition.timing,
    });
    return recognition;
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
    .filter(slice => {
      const startMs = slice.editSourceInMs ?? slice.sourceInMs;
      const endMs = slice.editSourceOutMs ?? slice.sourceOutMs;
      return typeof startMs === 'number' && typeof endMs === 'number' && endMs > startMs;
    })
    .map(slice => ({
      shotId: slice.id,
      startMs: (slice.editSourceInMs ?? slice.sourceInMs) as number,
      endMs: (slice.editSourceOutMs ?? slice.sourceOutMs) as number,
      timestampsMs: sampleRangeTimestamps(
        (slice.editSourceInMs ?? slice.sourceInMs) as number,
        (slice.editSourceOutMs ?? slice.sourceOutMs) as number,
        framesPerSlice,
      ),
    }));
}

function applySliceWindowSemantics(
  slice: IKtepSlice,
  clipType: EClipType,
  assetDurationMs: number,
): IKtepSlice {
  const result: IKtepSlice = {
    ...slice,
    ...(typeof slice.sourceInMs === 'number' && typeof slice.sourceOutMs === 'number'
      ? {
        editSourceInMs: slice.editSourceInMs ?? slice.sourceInMs,
        editSourceOutMs: slice.editSourceOutMs ?? slice.sourceOutMs,
      }
      : {}),
  };

  if (clipType !== 'drive' || result.speedCandidate || result.semanticKind === 'speech') {
    return result;
  }

  const editStartMs = result.editSourceInMs ?? result.sourceInMs;
  const editEndMs = result.editSourceOutMs ?? result.sourceOutMs;
  if (typeof editStartMs !== 'number' || typeof editEndMs !== 'number' || editEndMs <= editStartMs) {
    return result;
  }

  return {
    ...result,
    speedCandidate: buildDriveSpeedCandidate(
      assetDurationMs,
      editEndMs - editStartMs,
      `drive:${result.summary ?? 'fine-scan-slice'}`,
    ),
  };
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

function finalizeFineScanReport(
  report: IAssetCoarseReport,
  sliceCount: number,
): IAssetCoarseReport {
  const now = new Date().toISOString();
  return {
    ...report,
    fineScanCompletedAt: now,
    fineScanSliceCount: sliceCount,
    updatedAt: now,
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

function buildMlUnavailableErrorMessage(baseUrl?: string): string {
  return [
    `ML server 不可用：${baseUrl ?? 'http://127.0.0.1:8910'}`,
    '当前 analyze 不允许在无 ML 服务时静默 fallback。',
    '请先启动或修复 ML server，再重新运行 analyze。',
  ].join(' ');
}

function estimatePhaseEtaSeconds(
  startedAtMs: number,
  completedCount: number,
  totalCount: number,
): number | undefined {
  if (completedCount < 3) return undefined;
  return estimateRemainingSeconds(startedAtMs, completedCount, totalCount);
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

function selectPendingFineScanEntries(
  assets: IKtepAsset[],
  reports: IAssetCoarseReport[],
  slices: IKtepSlice[],
): IResumeFineScanEntry[] {
  const assetById = new Map(
    assets
      .filter(asset => asset.kind !== 'audio')
      .map(asset => [asset.id, asset] as const),
  );
  const sliceAssetIds = new Set(slices.map(slice => slice.assetId));

  return reports
    .filter(report => report.shouldFineScan && !isFineScanComplete(report, sliceAssetIds))
    .map(report => ({
      asset: assetById.get(report.assetId),
      report,
    }))
    .filter((entry): entry is IResumeFineScanEntry => Boolean(entry.asset));
}

function isFineScanComplete(
  report: IAssetCoarseReport,
  sliceAssetIds: Set<string>,
): boolean {
  if (!report.shouldFineScan) return true;
  if (typeof report.fineScanCompletedAt === 'string' && report.fineScanCompletedAt.trim().length > 0) {
    return true;
  }
  if (typeof report.fineScanSliceCount === 'number') {
    return true;
  }
  return sliceAssetIds.has(report.assetId);
}

async function loadPendingFineScanAnalyses(input: {
  projectId: string;
  projectRoot: string;
  entries: IResumeFineScanEntry[];
  roots: IMediaRoot[];
  deviceMaps: IDeviceMediaMapFile;
  runtimeConfig: IAnalyzeSingleAssetInput['runtimeConfig'];
  getMlHandle: () => Promise<MlAvailability>;
  performance?: AnalyzePerformanceSession;
}): Promise<IFinalizedAssetAnalysis[]> {
  const analyses: IFinalizedAssetAnalysis[] = [];
  for (const entry of input.entries) {
    const localPath = resolveAssetLocalPath(input.projectId, entry.asset, input.roots, input.deviceMaps);
    if (!localPath) continue;

    const prepared = await loadPreparedAssetVisualCoarse({
      asset: entry.asset,
      localPath,
      projectRoot: input.projectRoot,
      roots: input.roots,
      runtimeConfig: input.runtimeConfig,
      getMlHandle: input.getMlHandle,
      performance: input.performance,
    });
    if (!prepared) continue;
    analyses.push({
      prepared,
      report: entry.report,
      transcript: restoreTranscriptContextFromReport(entry.report),
      clipType: entry.report.clipTypeGuess,
      decisionReasons: [...entry.report.fineScanReasons],
    });
  }
  return analyses;
}

function dedupeFineScanAnalyses(
  analyses: IFinalizedAssetAnalysis[],
): IFinalizedAssetAnalysis[] {
  const byAssetId = new Map<string, IFinalizedAssetAnalysis>();
  for (const analysis of analyses) {
    byAssetId.set(analysis.prepared.asset.id, analysis);
  }
  return [...byAssetId.values()];
}

function restoreTranscriptContextFromReport(
  report: IAssetCoarseReport,
): ITranscriptContext | null {
  if (!report.transcript && (!report.transcriptSegments || report.transcriptSegments.length === 0)) {
    return null;
  }

  return normalizeTranscriptContext({
    transcript: report.transcript ?? '',
    segments: report.transcriptSegments ?? [],
    evidence: [],
    speechCoverage: report.speechCoverage ?? 0,
    speechWindows: report.interestingWindows.filter(window => isSpeechSemanticWindow(window)),
  });
}

function resolveAssetRootAvailable(
  projectId: string,
  root: IMediaRoot,
  deviceMaps: IDeviceMediaMapFile,
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
