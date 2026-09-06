import { describe, expect, it } from 'vitest';
import type { IAssetCoarseReport } from '../../src/protocol/schema.js';
import { applyTranscriptSegmentationToAssetReport } from '../../src/modules/media/transcript-segmentation-report.js';

describe('asset report transcript segmentation', () => {
  it('refreshes speech-window transcript truth without changing visual windows', () => {
    const report = {
      assetId: 'asset',
      durationMs: 5000,
      clipTypeGuess: 'drive',
      keepDecision: 'keep',
      densityScore: 0.5,
      asrRawText: '第一句。第二句！',
      alignedTokens: Array.from('第一句第二句').map((text, index) => ({
        index,
        startMs: index * 500,
        endMs: (index + 1) * 500,
        gapAfterMs: 0,
        text,
      })),
      transcript: '旧文本',
      transcriptSegments: [{ startMs: 0, endMs: 3000, text: '旧文本' }],
      labels: [],
      placeHints: [],
      rootNotes: [],
      sampleFrames: [],
      interestingWindows: [],
      fineScanWindows: [{
        windowId: 'speech',
        sourceInMs: 0,
        sourceOutMs: 3000,
        semanticKind: 'speech',
        transcript: '旧文本',
        transcriptSegments: [{ startMs: 0, endMs: 3000, text: '旧文本' }],
        speechCoverage: 1,
        frameTimestampsMs: [],
        framePaths: [],
        visualObservation: '车内视觉保持不变',
        status: 'recognized',
      }, {
        windowId: 'visual',
        sourceInMs: 0,
        sourceOutMs: 5000,
        semanticKind: 'visual',
        frameTimestampsMs: [],
        framePaths: [],
        visualObservation: '完整视觉描述',
        status: 'recognized',
      }],
      fineScanReasons: [],
      createdAt: '2026-09-05T00:00:00.000Z',
      updatedAt: '2026-09-05T00:00:00.000Z',
    } satisfies IAssetCoarseReport;
    const result = applyTranscriptSegmentationToAssetReport(
      report,
      '2026-09-06T00:00:00.000Z',
    );
    expect(result.report.transcriptSegments?.map(segment => segment.text)).toEqual([
      '第一句。第二句！',
    ]);
    expect(result.report.fineScanWindows[0]).toMatchObject({
      transcript: '第一句。第二句！',
      visualObservation: '车内视觉保持不变',
    });
    expect(result.report.fineScanWindows[1]).toEqual(report.fineScanWindows[1]);
  });
});
