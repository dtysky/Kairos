import type {
  IAssetCoarseReport,
  IKtepAsset,
  IMediaAnalysisPlan,
  EClipType,
  EFineScanMode,
} from '../../protocol/schema.js';
import type { IKeyframeResult } from './keyframe.js';

export interface IBuildAssetCoarseReportInput {
  asset: IKtepAsset;
  plan: IMediaAnalysisPlan;
  clipTypeGuess?: EClipType;
  gpsSummary?: string;
  summary?: string;
  labels?: string[];
  placeHints?: string[];
  sampleFrames?: IKeyframeResult[];
  sampleFrameSummaries?: string[];
  fineScanReasons?: string[];
  fineScanMode?: EFineScanMode;
}

export function buildAssetCoarseReport(
  input: IBuildAssetCoarseReportInput,
): IAssetCoarseReport {
  const now = new Date().toISOString();

  return {
    assetId: input.asset.id,
    ingestRootId: input.asset.ingestRootId,
    durationMs: input.asset.durationMs,
    clipTypeGuess: input.clipTypeGuess ?? input.plan.clipType,
    densityScore: input.plan.densityScore,
    gpsSummary: input.gpsSummary,
    summary: input.summary,
    labels: dedupe(input.labels ?? []),
    placeHints: dedupe(input.placeHints ?? []),
    sampleFrames: (input.sampleFrames ?? []).map((frame, index) => ({
      timeMs: frame.timeMs,
      path: frame.path,
      summary: input.sampleFrameSummaries?.[index],
    })),
    interestingWindows: input.plan.interestingWindows,
    shouldFineScan: input.plan.shouldFineScan,
    fineScanMode: input.fineScanMode ?? input.plan.fineScanMode,
    fineScanReasons: dedupe(input.fineScanReasons ?? []),
    createdAt: now,
    updatedAt: now,
  };
}

function dedupe(values: string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))];
}
