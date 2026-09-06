import type {
  IAssetCoarseReport,
  IFineScanWindow,
  ITranscriptSegment,
} from '../../protocol/schema.js';
import { segmentAlignedTranscript } from './transcript-segmentation.js';

export interface IAssetReportTranscriptSegmentationSummary {
  assetId: string;
  segmentCountBefore: number;
  segmentCountAfter: number;
  repairedTokenCount: number;
  originalMaxTokenDurationMs: number;
  repairedMaxTokenDurationMs: number;
}

export function applyTranscriptSegmentationToAssetReport(
  report: IAssetCoarseReport,
  completedAt = new Date().toISOString(),
): { report: IAssetCoarseReport; summary: IAssetReportTranscriptSegmentationSummary } {
  if (!report.asrRawText?.trim()) throw new Error(`${report.assetId} 缺少 asrRawText`);
  if (!report.alignedTokens || report.alignedTokens.length === 0) {
    throw new Error(`${report.assetId} 缺少 alignedTokens`);
  }
  const segmented = segmentAlignedTranscript({
    assetId: report.assetId,
    rawText: report.asrRawText,
    tokens: report.alignedTokens,
    completedAt,
  });
  const speechCoverage = computeCoverage(
    0,
    report.durationMs ?? segmented.alignedTokens.at(-1)?.endMs ?? 0,
    segmented.alignedTokens,
  );
  const updated: IAssetCoarseReport = {
    ...report,
    alignedTokens: segmented.alignedTokens,
    transcriptSegmentation: segmented.segmentation,
    transcript: segmented.transcript,
    transcriptSegments: segmented.segments,
    speechCoverage,
    fineScanWindows: report.fineScanWindows.map(window => (
      refreshFineScanSpeechTruth(window, segmented.segments)
    )),
    updatedAt: completedAt,
  };
  const timing = segmented.segmentation.timingValidation!;
  return {
    report: updated,
    summary: {
      assetId: report.assetId,
      segmentCountBefore: report.transcriptSegments?.length ?? 0,
      segmentCountAfter: segmented.segments.length,
      repairedTokenCount: timing.repairs.length,
      originalMaxTokenDurationMs: timing.originalMaxTokenDurationMs,
      repairedMaxTokenDurationMs: timing.repairedMaxTokenDurationMs,
    },
  };
}

function refreshFineScanSpeechTruth(
  window: IFineScanWindow,
  segments: ITranscriptSegment[],
): IFineScanWindow {
  if (window.semanticKind !== 'speech' && window.semanticKind !== 'mixed') return window;
  const sourceInMs = window.sourceInMs ?? 0;
  const sourceOutMs = window.sourceOutMs ?? sourceInMs;
  const clipped = segments
    .map(segment => ({
      startMs: Math.max(sourceInMs, segment.startMs),
      endMs: Math.min(sourceOutMs, segment.endMs),
      text: segment.text,
    }))
    .filter(segment => segment.endMs > segment.startMs && segment.text.trim().length > 0);
  return {
    ...window,
    transcript: clipped.length > 0
      ? clipped.map(segment => segment.text).join(' ').trim()
      : undefined,
    transcriptSegments: clipped.length > 0 ? clipped : undefined,
    speechCoverage: clipped.length > 0
      ? computeCoverage(sourceInMs, sourceOutMs, clipped)
      : 0,
  };
}

function computeCoverage(
  startMs: number,
  endMs: number,
  segments: Array<{ startMs: number; endMs: number }>,
): number {
  const durationMs = endMs - startMs;
  if (durationMs <= 0) return 0;
  const coveredMs = segments.reduce(
    (sum, segment) => sum + Math.max(0, segment.endMs - segment.startMs),
    0,
  );
  return Math.max(0, Math.min(1, coveredMs / durationMs));
}
