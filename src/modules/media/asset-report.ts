import type {
  IAssetCoarseReport,
  IInferredGps,
  IKtepAsset,
  IMediaAnalysisPlan,
  EClipType,
  EFinalizeFineScanMode,
  EKeepDecision,
  EMaterializationPath,
  ITranscriptSegment,
  IPharosMatch,
  IPharosRef,
  IFineScanWindow,
  ESliceType,
} from '../../protocol/schema.js';
import type { IKeyframeResult } from './keyframe.js';
import { assignUniqueMaterialSpanIds } from './material-ids.js';

export interface IBuildAssetCoarseReportInput {
  asset: IKtepAsset;
  plan: IMediaAnalysisPlan;
  clipTypeGuess?: EClipType;
  gpsSummary?: string;
  inferredGps?: IInferredGps;
  summary?: string;
  transcript?: string;
  transcriptSegments?: ITranscriptSegment[];
  speechCoverage?: number;
  protectedAudio?: IAssetCoarseReport['protectedAudio'];
  pharosMatches?: IPharosMatch[];
  primaryPharosRef?: IPharosRef;
  pharosMatchConfidence?: number;
  pharosStatus?: IAssetCoarseReport['pharosStatus'];
  pharosDayTitle?: string;
  labels?: string[];
  placeHints?: string[];
  rootNotes?: string[];
  sampleFrames?: IKeyframeResult[];
  sampleFrameSummaries?: string[];
  keepDecision?: EKeepDecision;
  materializationPath?: EMaterializationPath;
  fineScanReasons?: string[];
  fineScanMode?: EFinalizeFineScanMode;
  fineScanWindows?: IFineScanWindow[];
}

export function buildAssetCoarseReport(
  input: IBuildAssetCoarseReportInput,
): IAssetCoarseReport {
  const now = new Date().toISOString();
  const keepDecision = input.keepDecision ?? 'keep';
  const materializationPath = keepDecision === 'drop'
    ? undefined
    : input.materializationPath ?? (input.plan.shouldFineScan ? 'fine-scan' : 'direct');
  const fineScanMode = materializationPath === 'fine-scan'
    ? input.fineScanMode ?? (input.plan.fineScanMode === 'full' ? 'full' : 'windowed')
    : undefined;
  const interestingWindows = buildReportInterestingWindows(input);

  return {
    assetId: input.asset.id,
    ingestRootId: input.asset.ingestRootId,
    durationMs: input.asset.durationMs,
    clipTypeGuess: input.clipTypeGuess ?? input.plan.clipType,
    keepDecision,
    materializationPath,
    fineScanMode,
    densityScore: input.plan.densityScore,
    gpsSummary: input.gpsSummary,
    inferredGps: input.inferredGps,
    summary: input.summary,
    transcript: input.transcript?.trim() || undefined,
    transcriptSegments: input.transcriptSegments?.filter(segment => segment.text.trim().length > 0),
    speechCoverage: input.speechCoverage,
    protectedAudio: input.protectedAudio,
    pharosMatches: input.pharosMatches ?? [],
    primaryPharosRef: input.primaryPharosRef,
    pharosMatchConfidence: input.pharosMatchConfidence,
    pharosStatus: input.pharosStatus,
    pharosDayTitle: input.pharosDayTitle,
    labels: dedupe(input.labels ?? []),
    placeHints: dedupe(input.placeHints ?? []),
    rootNotes: dedupe(input.rootNotes ?? []),
    sampleFrames: (input.sampleFrames ?? []).map((frame, index) => ({
      timeMs: frame.timeMs,
      path: frame.path,
      summary: input.sampleFrameSummaries?.[index],
    })),
    interestingWindows,
    fineScanWindows: input.fineScanWindows ?? [],
    fineScanReasons: dedupe(input.fineScanReasons ?? []),
    createdAt: now,
    updatedAt: now,
  };
}

function dedupe(values: string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))];
}

function buildReportInterestingWindows(
  input: IBuildAssetCoarseReportInput,
): IAssetCoarseReport['interestingWindows'] {
  const windowSpans = input.plan.interestingWindows.map(window => ({
    id: window.windowId,
    assetId: input.asset.id,
    type: mapClipTypeToSliceType(input.plan.clipType),
    semanticKind: window.semanticKind,
    sourceInMs: window.startMs,
    sourceOutMs: window.endMs,
  }));
  const assigned = assignUniqueMaterialSpanIds(windowSpans, new Map([[input.asset.id, { kind: input.asset.kind }]]));
  return input.plan.interestingWindows.map((window, index) => {
    const assignedWindow = assigned[index];
    if (!assignedWindow) {
      throw new Error(`failed to assign interesting window id for asset ${input.asset.id} window ${index + 1}`);
    }
    return {
      ...window,
      windowId: assignedWindow.id,
    };
  });
}

function mapClipTypeToSliceType(clipType: IAssetCoarseReport['clipTypeGuess']): ESliceType {
  if (clipType === 'drive') return 'drive';
  if (clipType === 'talking-head') return 'talking-head';
  if (clipType === 'aerial') return 'aerial';
  if (clipType === 'timelapse') return 'timelapse';
  if (clipType === 'broll') return 'broll';
  return 'unknown';
}
