import { describe, expect, it } from 'vitest';
import { IAssetCoarseReport, IKtepSpan } from '../../src/protocol/schema.js';

describe('Analyze report and span schema', () => {
  it('accepts string materialPatterns and visualObservation on spans', () => {
    const parsed = IKtepSpan.parse({
      id: 'span-1',
      assetId: 'asset-1',
      type: 'drive',
      sourceInMs: 0,
      sourceOutMs: 1000,
      visualObservation: '车窗外是连续山路和阴天。',
      materialPatterns: ['第一人称行车', '山路', '阴天', '无口播语音', '连续弯道', '湿滑路面'],
      grounding: {
        speechMode: 'none',
        speechValue: 'none',
        spatialEvidence: [],
        pharosRefs: [],
      },
    });

    expect(parsed.materialPatterns).toEqual(['第一人称行车', '山路', '阴天', '无口播语音', '连续弯道', '湿滑路面']);
    expect(parsed.visualObservation).toBe('车窗外是连续山路和阴天。');
  });

  it('rejects old materialPatterns object arrays and semantic tag fields', () => {
    expect(() => IKtepSpan.parse({
      id: 'span-1',
      assetId: 'asset-1',
      type: 'drive',
      materialPatterns: [{ phrase: '旧对象', confidence: 0.9, evidenceRefs: [] }],
      grounding: {
        speechMode: 'none',
        speechValue: 'none',
        spatialEvidence: [],
        pharosRefs: [],
      },
    })).toThrow();

    expect(() => IKtepSpan.parse({
      id: 'span-2',
      assetId: 'asset-1',
      type: 'drive',
      materialPatterns: [],
      grounding: {
        speechMode: 'none',
        speechValue: 'none',
        spatialEvidence: [],
        pharosRefs: [],
      },
      narrativeFunctions: { core: [], extra: [], evidence: [] },
    })).toThrow();
  });

  it('keeps interestingWindows as plan and fineScanWindows as optional results', () => {
    const directReport = IAssetCoarseReport.parse(baseReport({
      materializationPath: 'direct',
      materialPatterns: ['城市步行', '雨天街道'],
    }));
    expect(directReport.fineScanWindows).toEqual([]);
    expect('materialPatterns' in directReport).toBe(false);

    const fineReport = IAssetCoarseReport.parse(baseReport({
      materializationPath: 'fine-scan',
      fineScanMode: 'windowed',
      fineScanWindows: [{
        windowId: 'asset-1-window-1',
        sourceInMs: 0,
        sourceOutMs: 2000,
        editSourceInMs: 0,
        editSourceOutMs: 2000,
        semanticKind: 'visual',
        reason: 'interesting-window',
        frameTimestampsMs: [0, 1000, 2000],
        framePaths: ['kf_0.jpg', 'kf_1000.jpg', 'kf_2000.jpg'],
        visualObservation: '雪山道路上有连续行车视角。',
        status: 'recognized',
      }, {
        windowId: 'asset-1-window-2',
        sourceInMs: 3000,
        sourceOutMs: 4000,
        frameTimestampsMs: [],
        framePaths: [],
        status: 'dropped',
        dropReason: 'invalid-dark-recording',
      }],
    }));

    expect(fineReport.interestingWindows).toHaveLength(1);
    expect(fineReport.fineScanWindows.map(window => window.status)).toEqual(['recognized', 'dropped']);
  });

  it('does not expose fine-scan raw recognition or materialPatterns as formal window fields', () => {
    const parsed = IAssetCoarseReport.parse(baseReport({
      materializationPath: 'fine-scan',
      fineScanMode: 'windowed',
      fineScanWindows: [{
        windowId: 'asset-1-window-1',
        sourceInMs: 0,
        sourceOutMs: 2000,
        frameTimestampsMs: [0],
        framePaths: ['kf_0.jpg'],
        materialPatterns: ['雪山道路'],
        recognitionRaw: {
          promptVersion: 'kairos-fine-scan-v2',
          responseText: '{}',
          parsed: {},
          sceneType: 'legacy-extra',
        },
        status: 'recognized',
      }],
    }));

    expect('materialPatterns' in parsed.fineScanWindows[0]!).toBe(false);
    expect('recognitionRaw' in parsed.fineScanWindows[0]!).toBe(false);
  });
});

function baseReport(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    assetId: 'asset-1',
    durationMs: 5000,
    clipTypeGuess: 'drive',
    keepDecision: 'keep',
    densityScore: 0.5,
    labels: ['drive'],
    placeHints: [],
    rootNotes: [],
    sampleFrames: [],
    interestingWindows: [{
      startMs: 0,
      endMs: 2000,
      reason: 'interesting-window',
    }],
    fineScanReasons: [],
    createdAt: '2026-05-16T00:00:00.000Z',
    updatedAt: '2026-05-16T00:00:00.000Z',
    ...overrides,
  };
}
