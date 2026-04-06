import { join } from 'node:path';
import type { ETargetBudget, IKtepAsset } from '../../protocol/schema.js';
import { writeJson } from '../../store/index.js';
import type { IMlAsrTiming, IMlVlmTiming } from './ml-client.js';

export type TAnalyzeSceneDetectPhase = 'prepare' | 'finalize' | 'fine-scan';

export interface IAnalyzePerformanceProfileOptions {
  enabled?: boolean;
  outputPath?: string;
  runLabel?: string;
  candidateModel?: string;
  notes?: string[];
}

export interface IAnalyzeMlRequestBucket {
  requestCount: number;
  imageCount: number;
  roundTripMs: number;
  serverTotalMs: number;
  loadMs: number;
  imageOpenMs: number;
  processorMs: number;
  h2dMs: number;
  generateMs: number;
  decodeMs: number;
  backend?: string;
  modelRef?: string;
}

export interface IAnalyzeAsrRequestBucket {
  requestCount: number;
  roundTripMs: number;
  serverTotalMs: number;
  loadMs: number;
  wavExtractMs: number;
  inferenceMs: number;
  backend?: string;
  modelRef?: string;
}

export interface IAnalyzeSceneDetectPhaseBucket {
  elapsedMs: number;
  callCount: number;
  shotCount: number;
}

export interface IAnalyzeAssetPerformance {
  assetId: string;
  displayName: string;
  kind: IKtepAsset['kind'];
  durationMs?: number;
  prepareMs: number;
  finalizeMs: number;
  fineScanMs: number;
  sceneDetectMs: number;
  sceneDetectCallCount: number;
  shotCount: number;
  sceneDetectPhases: Record<TAnalyzeSceneDetectPhase, IAnalyzeSceneDetectPhaseBucket>;
  coarseKeyframeExtractMs: number;
  coarseKeyframeCount: number;
  fineKeyframeExtractMs: number;
  fineKeyframeCount: number;
  reportWriteMs: number;
  reportWriteCount: number;
  appendedSliceCount: number;
  droppedInvalidSliceCount: number;
  vlm: {
    finalizeRequestCount: number;
    finalizeRoundTripMs: number;
    fineRequestCount: number;
    fineRoundTripMs: number;
  };
  asr: {
    embeddedRequestCount: number;
    embeddedRoundTripMs: number;
    protectionRequestCount: number;
    protectionRoundTripMs: number;
  };
}

export interface IAnalyzePerformanceProfile {
  version: 1;
  status: 'running' | 'succeeded' | 'failed';
  projectId: string;
  projectRoot: string;
  runLabel?: string;
  candidateModel?: string;
  notes: string[];
  requestedAssetIds: string[];
  budget: ETargetBudget;
  startedAt: string;
  completedAt?: string;
  pipelineTotalMs: number;
  assetCount: number;
  analyzedAssetCount: number;
  fineScannedAssetCount: number;
  missingRootCount: number;
  stageTotals: {
    prepareMs: number;
    finalizeMs: number;
    fineScanMs: number;
    chronologyRefreshMs: number;
  };
  ml: {
    healthCheckMs: number;
    finalizeVlm: IAnalyzeMlRequestBucket;
    fineScanVlm: IAnalyzeMlRequestBucket;
    embeddedAsr: IAnalyzeAsrRequestBucket;
    protectionAsr: IAnalyzeAsrRequestBucket;
  };
  ffmpeg: {
    sceneDetectMs: number;
    sceneDetectCallCount: number;
    sceneDetectPhases: Record<TAnalyzeSceneDetectPhase, IAnalyzeSceneDetectPhaseBucket>;
    keyframeExtractMs: number;
    keyframeExtractCallCount: number;
    coarseKeyframeCount: number;
    fineKeyframeCount: number;
    wavExtractMs: number;
  };
  io: {
    progressWriteMs: number;
    progressWriteCount: number;
    reportWriteMs: number;
    reportWriteCount: number;
    chronologyWriteMs: number;
    chronologyWriteCount: number;
    sliceAppendMs: number;
    sliceAppendCount: number;
  };
  assets: IAnalyzeAssetPerformance[];
  failureMessage?: string;
  failureItems?: Array<{
    assetId: string;
    displayName: string;
    stage: string;
    reason: string;
  }>;
}

export function shouldEnableAnalyzePerformanceProfile(
  options?: IAnalyzePerformanceProfileOptions,
): boolean {
  return Boolean(options?.enabled || options?.outputPath);
}

export function getAnalyzePerformanceProfilePath(projectRoot: string): string {
  return join(projectRoot, '.tmp', 'media-analyze', 'performance-profile.json');
}

export class AnalyzePerformanceSession {
  private readonly profile: IAnalyzePerformanceProfile;

  private readonly assets = new Map<string, IAnalyzeAssetPerformance>();

  constructor(input: {
    projectId: string;
    projectRoot: string;
    budget?: ETargetBudget;
    requestedAssetIds?: string[];
    options?: IAnalyzePerformanceProfileOptions;
  }) {
    this.profile = {
      version: 1,
      status: 'running',
      projectId: input.projectId,
      projectRoot: input.projectRoot,
      runLabel: input.options?.runLabel?.trim() || undefined,
      candidateModel: input.options?.candidateModel?.trim() || undefined,
      notes: input.options?.notes?.map(note => note.trim()).filter(Boolean) ?? [],
      requestedAssetIds: input.requestedAssetIds ?? [],
      budget: input.budget ?? 'standard',
      startedAt: new Date().toISOString(),
      pipelineTotalMs: 0,
      assetCount: 0,
      analyzedAssetCount: 0,
      fineScannedAssetCount: 0,
      missingRootCount: 0,
      stageTotals: {
        prepareMs: 0,
        finalizeMs: 0,
        fineScanMs: 0,
        chronologyRefreshMs: 0,
      },
      ml: {
        healthCheckMs: 0,
        finalizeVlm: createMlBucket(),
        fineScanVlm: createMlBucket(),
        embeddedAsr: createAsrBucket(),
        protectionAsr: createAsrBucket(),
      },
      ffmpeg: {
        sceneDetectMs: 0,
        sceneDetectCallCount: 0,
        sceneDetectPhases: createSceneDetectPhaseBuckets(),
        keyframeExtractMs: 0,
        keyframeExtractCallCount: 0,
        coarseKeyframeCount: 0,
        fineKeyframeCount: 0,
        wavExtractMs: 0,
      },
      io: {
        progressWriteMs: 0,
        progressWriteCount: 0,
        reportWriteMs: 0,
        reportWriteCount: 0,
        chronologyWriteMs: 0,
        chronologyWriteCount: 0,
        sliceAppendMs: 0,
        sliceAppendCount: 0,
      },
      assets: [],
    };
  }

  resolveOutputPath(customPath?: string): string {
    return customPath?.trim() || getAnalyzePerformanceProfilePath(this.profile.projectRoot);
  }

  setAssetCount(assetCount: number): void {
    this.profile.assetCount = Math.max(0, Math.round(assetCount));
  }

  recordMlHealthCheck(elapsedMs: number): void {
    this.profile.ml.healthCheckMs += clampMs(elapsedMs);
  }

  recordStage(asset: IKtepAsset, stage: 'prepare' | 'finalize' | 'fine-scan', elapsedMs: number): void {
    const normalized = clampMs(elapsedMs);
    const record = this.ensureAsset(asset);
    if (stage === 'prepare') {
      this.profile.stageTotals.prepareMs += normalized;
      record.prepareMs += normalized;
      return;
    }
    if (stage === 'finalize') {
      this.profile.stageTotals.finalizeMs += normalized;
      record.finalizeMs += normalized;
      return;
    }
    this.profile.stageTotals.fineScanMs += normalized;
    record.fineScanMs += normalized;
  }

  recordChronologyRefresh(elapsedMs: number): void {
    this.profile.stageTotals.chronologyRefreshMs += clampMs(elapsedMs);
  }

  recordSceneDetect(input: {
    asset: IKtepAsset;
    phase: TAnalyzeSceneDetectPhase;
    elapsedMs: number;
    shotCount: number;
  }): void {
    const normalized = clampMs(input.elapsedMs);
    const normalizedShotCount = Math.max(0, Math.round(input.shotCount));
    const record = this.ensureAsset(input.asset);
    this.profile.ffmpeg.sceneDetectMs += normalized;
    this.profile.ffmpeg.sceneDetectCallCount += 1;
    this.profile.ffmpeg.sceneDetectPhases[input.phase].elapsedMs += normalized;
    this.profile.ffmpeg.sceneDetectPhases[input.phase].callCount += 1;
    this.profile.ffmpeg.sceneDetectPhases[input.phase].shotCount += normalizedShotCount;
    record.sceneDetectMs += normalized;
    record.sceneDetectCallCount += 1;
    record.shotCount += normalizedShotCount;
    record.sceneDetectPhases[input.phase].elapsedMs += normalized;
    record.sceneDetectPhases[input.phase].callCount += 1;
    record.sceneDetectPhases[input.phase].shotCount += normalizedShotCount;
  }

  recordKeyframeExtract(input: {
    asset: IKtepAsset;
    phase: 'coarse' | 'fine';
    elapsedMs: number;
    keyframeCount: number;
  }): void {
    const normalized = clampMs(input.elapsedMs);
    const count = Math.max(0, Math.round(input.keyframeCount));
    const record = this.ensureAsset(input.asset);
    this.profile.ffmpeg.keyframeExtractMs += normalized;
    this.profile.ffmpeg.keyframeExtractCallCount += 1;
    if (input.phase === 'coarse') {
      this.profile.ffmpeg.coarseKeyframeCount += count;
      record.coarseKeyframeExtractMs += normalized;
      record.coarseKeyframeCount += count;
      return;
    }
    this.profile.ffmpeg.fineKeyframeCount += count;
    record.fineKeyframeExtractMs += normalized;
    record.fineKeyframeCount += count;
  }

  recordVlm(input: {
    asset: IKtepAsset;
    phase: 'finalize' | 'fine';
    imageCount: number;
    roundTripMs?: number;
    timing?: IMlVlmTiming;
  }): void {
    const record = this.ensureAsset(input.asset);
    const bucket = input.phase === 'finalize'
      ? this.profile.ml.finalizeVlm
      : this.profile.ml.fineScanVlm;
    bucket.requestCount += 1;
    bucket.imageCount += Math.max(0, Math.round(input.imageCount));
    bucket.roundTripMs += clampMs(input.roundTripMs);
    bucket.serverTotalMs += clampMs(input.timing?.totalMs);
    bucket.loadMs += clampMs(input.timing?.loadMs);
    bucket.imageOpenMs += clampMs(input.timing?.imageOpenMs);
    bucket.processorMs += clampMs(input.timing?.processorMs);
    bucket.h2dMs += clampMs(input.timing?.h2dMs);
    bucket.generateMs += clampMs(input.timing?.generateMs);
    bucket.decodeMs += clampMs(input.timing?.decodeMs);
    bucket.backend ??= normalizeOptionalString(input.timing?.backend);
    bucket.modelRef ??= normalizeOptionalString(input.timing?.modelRef);

    if (input.phase === 'finalize') {
      record.vlm.finalizeRequestCount += 1;
      record.vlm.finalizeRoundTripMs += clampMs(input.roundTripMs);
      return;
    }
    record.vlm.fineRequestCount += 1;
    record.vlm.fineRoundTripMs += clampMs(input.roundTripMs);
  }

  recordAsr(input: {
    asset: IKtepAsset;
    phase: 'embedded' | 'protection';
    roundTripMs?: number;
    timing?: IMlAsrTiming;
  }): void {
    const record = this.ensureAsset(input.asset);
    const bucket = input.phase === 'embedded'
      ? this.profile.ml.embeddedAsr
      : this.profile.ml.protectionAsr;
    bucket.requestCount += 1;
    bucket.roundTripMs += clampMs(input.roundTripMs);
    bucket.serverTotalMs += clampMs(input.timing?.totalMs);
    bucket.loadMs += clampMs(input.timing?.loadMs);
    bucket.wavExtractMs += clampMs(input.timing?.wavExtractMs);
    bucket.inferenceMs += clampMs(input.timing?.inferenceMs);
    bucket.backend ??= normalizeOptionalString(input.timing?.backend);
    bucket.modelRef ??= normalizeOptionalString(input.timing?.modelRef);

    this.profile.ffmpeg.wavExtractMs += clampMs(input.timing?.wavExtractMs);
    if (input.phase === 'embedded') {
      record.asr.embeddedRequestCount += 1;
      record.asr.embeddedRoundTripMs += clampMs(input.roundTripMs);
      return;
    }
    record.asr.protectionRequestCount += 1;
    record.asr.protectionRoundTripMs += clampMs(input.roundTripMs);
  }

  recordProgressWrite(elapsedMs: number): void {
    this.profile.io.progressWriteMs += clampMs(elapsedMs);
    this.profile.io.progressWriteCount += 1;
  }

  recordReportWrite(asset: IKtepAsset, elapsedMs: number): void {
    const normalized = clampMs(elapsedMs);
    const record = this.ensureAsset(asset);
    this.profile.io.reportWriteMs += normalized;
    this.profile.io.reportWriteCount += 1;
    record.reportWriteMs += normalized;
    record.reportWriteCount += 1;
  }

  recordChronologyWrite(elapsedMs: number): void {
    this.profile.io.chronologyWriteMs += clampMs(elapsedMs);
    this.profile.io.chronologyWriteCount += 1;
  }

  recordSliceAppend(asset: IKtepAsset, sliceCount: number, elapsedMs: number): void {
    const normalized = clampMs(elapsedMs);
    const normalizedCount = Math.max(0, Math.round(sliceCount));
    const record = this.ensureAsset(asset);
    this.profile.io.sliceAppendMs += normalized;
    this.profile.io.sliceAppendCount += 1;
    record.appendedSliceCount += normalizedCount;
  }

  recordDroppedInvalidSlices(asset: IKtepAsset, droppedInvalidSliceCount: number): void {
    const normalizedCount = Math.max(0, Math.round(droppedInvalidSliceCount));
    if (normalizedCount <= 0) return;
    const record = this.ensureAsset(asset);
    record.droppedInvalidSliceCount += normalizedCount;
  }

  finalizeSuccess(input: {
    pipelineTotalMs: number;
    analyzedAssetCount: number;
    fineScannedAssetCount: number;
    missingRootCount: number;
  }): void {
    this.profile.status = 'succeeded';
    this.profile.completedAt = new Date().toISOString();
    this.profile.pipelineTotalMs = clampMs(input.pipelineTotalMs);
    this.profile.analyzedAssetCount = Math.max(0, Math.round(input.analyzedAssetCount));
    this.profile.fineScannedAssetCount = Math.max(0, Math.round(input.fineScannedAssetCount));
    this.profile.missingRootCount = Math.max(0, Math.round(input.missingRootCount));
    this.syncAssets();
  }

  finalizeFailure(input: {
    pipelineTotalMs: number;
    failureMessage: string;
    analyzedAssetCount: number;
    fineScannedAssetCount: number;
    failureItems?: Array<{
      assetId: string;
      displayName: string;
      stage: string;
      reason: string;
    }>;
  }): void {
    this.profile.status = 'failed';
    this.profile.completedAt = new Date().toISOString();
    this.profile.pipelineTotalMs = clampMs(input.pipelineTotalMs);
    this.profile.failureMessage = input.failureMessage.trim();
    this.profile.failureItems = input.failureItems?.map(item => ({
      assetId: item.assetId,
      displayName: item.displayName,
      stage: item.stage,
      reason: item.reason,
    }));
    this.profile.analyzedAssetCount = Math.max(0, Math.round(input.analyzedAssetCount));
    this.profile.fineScannedAssetCount = Math.max(0, Math.round(input.fineScannedAssetCount));
    this.syncAssets();
  }

  snapshot(): IAnalyzePerformanceProfile {
    this.syncAssets();
    return {
      ...this.profile,
      notes: [...this.profile.notes],
      requestedAssetIds: [...this.profile.requestedAssetIds],
      stageTotals: { ...this.profile.stageTotals },
      ml: {
        healthCheckMs: this.profile.ml.healthCheckMs,
        finalizeVlm: { ...this.profile.ml.finalizeVlm },
        fineScanVlm: { ...this.profile.ml.fineScanVlm },
        embeddedAsr: { ...this.profile.ml.embeddedAsr },
        protectionAsr: { ...this.profile.ml.protectionAsr },
      },
      ffmpeg: {
        ...this.profile.ffmpeg,
        sceneDetectPhases: cloneSceneDetectPhaseBuckets(this.profile.ffmpeg.sceneDetectPhases),
      },
      io: { ...this.profile.io },
      assets: this.profile.assets.map(asset => ({
        ...asset,
        sceneDetectPhases: cloneSceneDetectPhaseBuckets(asset.sceneDetectPhases),
        vlm: { ...asset.vlm },
        asr: { ...asset.asr },
      })),
      failureItems: this.profile.failureItems?.map(item => ({ ...item })),
    };
  }

  async write(outputPath: string): Promise<void> {
    await writeJson(outputPath, this.snapshot());
  }

  private ensureAsset(asset: IKtepAsset): IAnalyzeAssetPerformance {
    const existing = this.assets.get(asset.id);
    if (existing) return existing;

    const created: IAnalyzeAssetPerformance = {
      assetId: asset.id,
      displayName: asset.displayName,
      kind: asset.kind,
      durationMs: asset.durationMs,
      prepareMs: 0,
      finalizeMs: 0,
      fineScanMs: 0,
      sceneDetectMs: 0,
      sceneDetectCallCount: 0,
      shotCount: 0,
      sceneDetectPhases: createSceneDetectPhaseBuckets(),
      coarseKeyframeExtractMs: 0,
      coarseKeyframeCount: 0,
      fineKeyframeExtractMs: 0,
      fineKeyframeCount: 0,
      reportWriteMs: 0,
      reportWriteCount: 0,
      appendedSliceCount: 0,
      droppedInvalidSliceCount: 0,
      vlm: {
        finalizeRequestCount: 0,
        finalizeRoundTripMs: 0,
        fineRequestCount: 0,
        fineRoundTripMs: 0,
      },
      asr: {
        embeddedRequestCount: 0,
        embeddedRoundTripMs: 0,
        protectionRequestCount: 0,
        protectionRoundTripMs: 0,
      },
    };
    this.assets.set(asset.id, created);
    return created;
  }

  private syncAssets(): void {
    this.profile.assets = [...this.assets.values()]
      .map(asset => ({
        ...asset,
        sceneDetectPhases: cloneSceneDetectPhaseBuckets(asset.sceneDetectPhases),
        vlm: { ...asset.vlm },
        asr: { ...asset.asr },
      }))
      .sort((left, right) => left.displayName.localeCompare(right.displayName));
  }
}

function createMlBucket(): IAnalyzeMlRequestBucket {
  return {
    requestCount: 0,
    imageCount: 0,
    roundTripMs: 0,
    serverTotalMs: 0,
    loadMs: 0,
    imageOpenMs: 0,
    processorMs: 0,
    h2dMs: 0,
    generateMs: 0,
    decodeMs: 0,
  };
}

function createSceneDetectPhaseBucket(): IAnalyzeSceneDetectPhaseBucket {
  return {
    elapsedMs: 0,
    callCount: 0,
    shotCount: 0,
  };
}

function createSceneDetectPhaseBuckets(): Record<TAnalyzeSceneDetectPhase, IAnalyzeSceneDetectPhaseBucket> {
  return {
    prepare: createSceneDetectPhaseBucket(),
    finalize: createSceneDetectPhaseBucket(),
    'fine-scan': createSceneDetectPhaseBucket(),
  };
}

function cloneSceneDetectPhaseBuckets(
  buckets: Record<TAnalyzeSceneDetectPhase, IAnalyzeSceneDetectPhaseBucket>,
): Record<TAnalyzeSceneDetectPhase, IAnalyzeSceneDetectPhaseBucket> {
  return {
    prepare: { ...buckets.prepare },
    finalize: { ...buckets.finalize },
    'fine-scan': { ...buckets['fine-scan'] },
  };
}

function createAsrBucket(): IAnalyzeAsrRequestBucket {
  return {
    requestCount: 0,
    roundTripMs: 0,
    serverTotalMs: 0,
    loadMs: 0,
    wavExtractMs: 0,
    inferenceMs: 0,
  };
}

function clampMs(value: number | undefined): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.round(value as number));
}

function normalizeOptionalString(value?: string): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}
