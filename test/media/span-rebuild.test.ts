import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AgentRunnerUnavailableError,
  type IJsonPacketAgentInvocation,
  type IJsonPacketAgentRunner,
} from '../../src/modules/agents/runtime.js';
import { CSPAN_MATERIALIZATION_REVIEW_MAX_TOKENS } from '../../src/modules/agents/span-materialization-review-spec.js';
import {
  buildMaterialSpansFromReports,
  CMATERIAL_PATTERN_PROMPT_VERSION,
  rebuildProjectSpans,
} from '../../src/modules/media/span-rebuild.js';
import type { IAssetCoarseReport, IKtepAsset } from '../../src/protocol/index.js';
import {
  getAssetReportPath,
  getAssetsPath,
  getProjectProgressPath,
  getSpansMetaPath,
  getSpansPath,
  assertFreshSpans,
  initWorkspaceProject,
  loadSpans,
  loadSpansMeta,
  writeJson,
} from '../../src/store/index.js';
import { createVideoAsset } from '../helpers/fixtures.js';

const workspaces: string[] = [];

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

class FakePacketRunner implements IJsonPacketAgentRunner {
  readonly calls: IJsonPacketAgentInvocation[] = [];

  constructor(private readonly responses: unknown[]) {}

  async run<T>(input: IJsonPacketAgentInvocation): Promise<T> {
    this.calls.push(input);
    if (this.responses.length === 0) {
      throw new Error('FakePacketRunner has no queued response');
    }
    const response = this.responses.shift();
    if (response instanceof Error) throw response;
    return response as T;
  }
}

function reviewRow(
  materialPatterns: string[],
  _options: unknown = undefined,
): string[] {
  void _options;
  return materialPatterns;
}

function visualReviewRow(materialPatterns: string[]): ReturnType<typeof reviewRow> {
  return reviewRow(materialPatterns);
}

function speechReviewRow(materialPatterns: string[], _indexes = [1]): ReturnType<typeof reviewRow> {
  void _indexes;
  return reviewRow(materialPatterns);
}

describe('buildMaterialSpansFromReports', () => {
  it('generates stripped material spans for photos, direct video, fallback video, and recognized fine-scan windows', () => {
    const assets: IKtepAsset[] = [
      {
        id: 'photo-1',
        kind: 'photo',
        sourcePath: 'photo.jpg',
        displayName: 'photo.jpg',
        capturedAt: '2026-04-12T00:00:00.000Z',
      },
      createVideoAsset({ id: 'direct-1', durationMs: 10_000 }),
      createVideoAsset({ id: 'fallback-1', durationMs: 8_000 }),
      createVideoAsset({ id: 'fine-1', durationMs: 12_000 }),
      {
        id: 'audio-1',
        kind: 'audio',
        sourcePath: 'voice.wav',
        displayName: 'voice.wav',
        durationMs: 5_000,
      },
      createVideoAsset({ id: 'dropped-1', durationMs: 5_000 }),
    ];
    const reports: IAssetCoarseReport[] = [
      report({ assetId: 'photo-1', clipTypeGuess: 'broll', summary: '雪山照片。' }),
      report({
        assetId: 'direct-1',
        clipTypeGuess: 'drive',
        summary: '车窗外道路。',
        labels: ['drive-label'],
        interestingWindows: [
          { startMs: 500, endMs: 2_000, editStartMs: 250, editEndMs: 2_250, reason: 'visual', semanticKind: 'visual' },
          { startMs: 3_000, endMs: 4_000, reason: 'speech', semanticKind: 'speech' },
        ],
        transcript: '路上第一句。第二句。',
        transcriptSegments: [
          { startMs: 3_100, endMs: 3_600, text: '路上第一句。' },
          { startMs: 3_700, endMs: 4_200, text: '第二句。' },
        ],
      }),
      report({
        assetId: 'fallback-1',
        clipTypeGuess: 'broll',
        summary: '没有窗口的整段素材。',
        interestingWindows: [],
      }),
      report({
        assetId: 'fine-1',
        clipTypeGuess: 'talking-head',
        materializationPath: 'fine-scan',
        summary: '车内口播。',
        labels: ['speech-label'],
        transcriptSegments: [
          { startMs: 1_000, endMs: 2_000, text: '我们准备到达。' },
          { startMs: 6_000, endMs: 7_000, text: '这句不在窗口里。' },
        ],
        fineScanWindows: [{
          windowId: 'fine-window-1',
          sourceInMs: 500,
          sourceOutMs: 2_500,
          editSourceInMs: 400,
          editSourceOutMs: 2_600,
          semanticKind: 'mixed',
          visualObservation: '车内自拍口播',
          status: 'recognized',
          frameTimestampsMs: [],
          framePaths: [],
          speedCandidate: {
            suggestedSpeeds: [2],
            rationale: 'must-not-leak',
          },
        }, {
          windowId: 'fine-window-drop',
          sourceInMs: 3_000,
          sourceOutMs: 4_000,
          status: 'dropped',
          dropReason: 'bad-window',
          frameTimestampsMs: [],
          framePaths: [],
        }],
      }),
      report({ assetId: 'audio-1', clipTypeGuess: 'unknown', summary: 'audio report' }),
      report({ assetId: 'dropped-1', clipTypeGuess: 'broll', keepDecision: 'drop', summary: 'drop me' }),
    ];

    const result = buildMaterialSpansFromReports({ assets, reports, pharosContext: { ignored: true } });

    expect(result.spans.map(span => span.id)).toEqual([
      'direct-1_drive_visual_s0-2',
      'direct-1_drive_speech_s3-4',
      'fallback-1_broll_s0-8',
      'fine-1_talking-head_mixed_s0-3',
      'photo-1_photo',
    ]);
    expect(result.spans.find(span => span.id === 'photo-1_photo')).toMatchObject({
      assetId: 'photo-1',
      type: 'photo',
      sourceInMs: 0,
      sourceOutMs: 0,
    });
    expect(result.spans.find(span => span.id === 'direct-1_drive_visual_s0-2')).toMatchObject({
      type: 'drive',
      semanticKind: 'visual',
      sourceInMs: 500,
      sourceOutMs: 2_000,
      editSourceInMs: 250,
      editSourceOutMs: 2_250,
      visualObservation: '车窗外道路。',
      materialPatterns: [],
    });
    expect(result.spans.find(span => span.id === 'direct-1_drive_speech_s3-4')).toMatchObject({
      semanticKind: 'speech',
      transcript: '路上第一句。 第二句。',
      speechCoverage: 0.8,
    });
    expect(result.spans.find(span => span.id === 'fallback-1_broll_s0-8')).toMatchObject({
      sourceInMs: 0,
      sourceOutMs: 8_000,
    });
    expect(result.spans.find(span => span.id === 'fine-1_talking-head_mixed_s0-3')).toMatchObject({
      semanticKind: 'mixed',
      transcript: '我们准备到达。',
      visualObservation: '车内自拍口播',
      materialPatterns: [],
      speechCoverage: 0.5,
    });
    expect(result.warnings).toEqual(expect.arrayContaining([
      'asset fine-1: fine-scan window fine-window-drop dropped (bad-window)',
      'asset audio-1: skipped because audio assets do not generate material spans',
      'asset dropped-1: skipped because keepDecision=drop',
    ]));
    for (const span of result.spans as Array<Record<string, unknown>>) {
      for (const forbidden of ['speedCandidate', 'pharosRefs', 'grounding', 'spatialEvidence', 'location', 'routeRole']) {
        expect(span).not.toHaveProperty(forbidden);
      }
      expect(span.materialPatterns).toEqual([]);
    }
  });

  it('blocks fine-scan assets when the report has no fineScanWindows', () => {
    expect(() => buildMaterialSpansFromReports({
      assets: [createVideoAsset({ id: 'fine-empty', durationMs: 10_000 })],
      reports: [report({
        assetId: 'fine-empty',
        materializationPath: 'fine-scan',
        fineScanWindows: [],
      })],
    })).toThrow(/requires fine-scan spans but has no fineScanWindows/u);
  });

  it('recovers legacy fine-scan speech semanticKind from matching interestingWindows', () => {
    const result = buildMaterialSpansFromReports({
      assets: [createVideoAsset({ id: 'legacy-speech-match', durationMs: 10_000 })],
      reports: [report({
        assetId: 'legacy-speech-match',
        clipTypeGuess: 'talking-head',
        materializationPath: 'fine-scan',
        transcript: '机场出发前说一段。',
        transcriptSegments: [{ startMs: 1_000, endMs: 2_500, text: '机场出发前说一段。' }],
        speechCoverage: 0.8,
        interestingWindows: [{
          startMs: 900,
          endMs: 2_600,
          reason: 'speech-window',
          semanticKind: 'speech',
        }],
        fineScanWindows: [{
          windowId: 'legacy-speech-window',
          sourceInMs: 900,
          sourceOutMs: 2_600,
          reason: 'speech-window',
          visualObservation: '机场外自拍口播',
          status: 'recognized',
          frameTimestampsMs: [],
          framePaths: [],
        }],
      })],
    });

    expect(result.spans).toHaveLength(1);
    expect(result.spans[0]).toMatchObject({
      id: 'legacy-speech-match_talking-head_speech_s0-3',
      semanticKind: 'speech',
      transcript: '机场出发前说一段。',
    });
    expect(result.spans[0]?.speechCoverage).toBeCloseTo(0.882, 2);
    expect(result.warnings.join('\n')).toMatch(/recovered fine-scan window legacy-speech-window semanticKind=speech/u);
  });

  it('recovers legacy speech-window semanticKind from transcript overlap when interestingWindows lack semanticKind', () => {
    const result = buildMaterialSpansFromReports({
      assets: [createVideoAsset({ id: 'legacy-speech-overlap', durationMs: 10_000 })],
      reports: [report({
        assetId: 'legacy-speech-overlap',
        clipTypeGuess: 'talking-head',
        materializationPath: 'fine-scan',
        transcript: '这段现场口播不能丢。',
        transcriptSegments: [{ startMs: 1_200, endMs: 2_400, text: '这段现场口播不能丢。' }],
        speechCoverage: 0.7,
        interestingWindows: [{
          startMs: 1_000,
          endMs: 2_500,
          reason: 'speech-window',
        }],
        fineScanWindows: [{
          windowId: 'legacy-overlap-window',
          sourceInMs: 1_000,
          sourceOutMs: 2_500,
          reason: 'speech-window',
          visualObservation: '车内对镜头说话',
          status: 'recognized',
          frameTimestampsMs: [],
          framePaths: [],
        }],
      })],
    });

    expect(result.spans[0]).toMatchObject({
      id: 'legacy-speech-overlap_talking-head_speech_s1-3',
      semanticKind: 'speech',
      transcript: '这段现场口播不能丢。',
      materialPatterns: [],
    });
    expect(result.warnings.join('\n')).toMatch(/speech-window transcript overlap/u);
  });

  it('preserves fine-scan window transcript truth before falling back to report transcript', () => {
    const result = buildMaterialSpansFromReports({
      assets: [createVideoAsset({ id: 'fine-window-transcript', durationMs: 10_000 })],
      reports: [report({
        assetId: 'fine-window-transcript',
        clipTypeGuess: 'talking-head',
        materializationPath: 'fine-scan',
        transcript: '这是报告里的整段口播。',
        transcriptSegments: [{ startMs: 1_000, endMs: 4_000, text: '这是报告里的整段口播。' }],
        speechCoverage: 0.6,
        interestingWindows: [{
          windowId: 'iw-speech',
          startMs: 1_000,
          endMs: 4_000,
          reason: 'speech-window',
          semanticKind: 'speech',
        }],
        fineScanWindows: [{
          windowId: 'fine-window-truth',
          sourceInMs: 1_000,
          sourceOutMs: 4_000,
          semanticKind: 'speech',
          reason: 'speech-window',
          sourceInterestingWindowIds: ['iw-speech'],
          sourceWindowReason: 'speech-window',
          transcript: '这是窗口自己裁剪后的口播。',
          transcriptSegments: [{ startMs: 1_200, endMs: 2_800, text: '这是窗口自己裁剪后的口播。' }],
          speechCoverage: 0.533,
          visualObservation: '车内自拍口播',
          status: 'recognized',
          frameTimestampsMs: [],
          framePaths: [],
        }],
      })],
    });

    expect(result.spans[0]).toMatchObject({
      id: 'fine-window-transcript_talking-head_speech_s1-4',
      semanticKind: 'speech',
      transcript: '这是窗口自己裁剪后的口播。',
      transcriptSegments: [{ startMs: 1_200, endMs: 2_800, text: '这是窗口自己裁剪后的口播。' }],
      speechCoverage: 0.533,
    });
  });

  it('recovers legacy missing semanticKind from overlapping speech source without promoting explicit visual windows', () => {
    const base = {
      clipTypeGuess: 'drive' as const,
      materializationPath: 'fine-scan' as const,
      transcript: '车里有人说话。',
      transcriptSegments: [{ startMs: 1_000, endMs: 2_000, text: '车里有人说话。' }],
      speechCoverage: 0.5,
      interestingWindows: [
        {
          windowId: 'iw-visual',
          startMs: 0,
          endMs: 3_000,
          reason: 'coarse-sample-window',
          semanticKind: 'visual' as const,
        },
        {
          windowId: 'iw-speech',
          startMs: 0,
          endMs: 3_000,
          reason: 'speech-window',
          semanticKind: 'speech' as const,
        },
      ],
    };

    const recovered = buildMaterialSpansFromReports({
      assets: [createVideoAsset({ id: 'legacy-overlap-source', durationMs: 10_000 })],
      reports: [report({
        ...base,
        assetId: 'legacy-overlap-source',
        fineScanWindows: [{
          windowId: 'legacy-source-window',
          sourceInMs: 0,
          sourceOutMs: 3_000,
          sourceInterestingWindowIds: ['iw-speech'],
          visualObservation: '车内行驶画面',
          status: 'recognized',
          frameTimestampsMs: [],
          framePaths: [],
        }],
      })],
    });
    expect(recovered.spans[0]).toMatchObject({
      id: 'legacy-overlap-source_drive_speech_s0-3',
      semanticKind: 'speech',
      transcript: '车里有人说话。',
    });

    const visual = buildMaterialSpansFromReports({
      assets: [createVideoAsset({ id: 'explicit-visual-overlap', durationMs: 10_000 })],
      reports: [report({
        ...base,
        assetId: 'explicit-visual-overlap',
        fineScanWindows: [{
          windowId: 'explicit-visual-window',
          sourceInMs: 0,
          sourceOutMs: 3_000,
          semanticKind: 'visual',
          sourceInterestingWindowIds: ['iw-visual'],
          visualObservation: '车内行驶画面',
          status: 'recognized',
          frameTimestampsMs: [],
          framePaths: [],
        }],
      })],
    });
    expect(visual.spans[0]).toMatchObject({
      id: 'explicit-visual-overlap_drive_visual_s0-3',
      semanticKind: 'visual',
    });
    expect(visual.spans[0]?.transcript).toBeUndefined();
    expect(visual.spans[0]?.transcriptSegments).toBeUndefined();
  });

  it('blocks non-audio assets that are missing asset reports', () => {
    expect(() => buildMaterialSpansFromReports({
      assets: [
        createVideoAsset({ id: 'reported', durationMs: 10_000 }),
        createVideoAsset({ id: 'missing-report', durationMs: 10_000 }),
      ],
      reports: [report({ assetId: 'reported', summary: '已分析素材。', interestingWindows: [] })],
    })).toThrow(/missing asset-report visual evidence/u);
  });

  it('blocks recognized fine-scan windows without visualObservation', () => {
    expect(() => buildMaterialSpansFromReports({
      assets: [createVideoAsset({ id: 'fine-no-visual', durationMs: 10_000 })],
      reports: [report({
        assetId: 'fine-no-visual',
        materializationPath: 'fine-scan',
        fineScanWindows: [{
          windowId: 'fine-window-no-visual',
          sourceInMs: 0,
          sourceOutMs: 2_000,
          status: 'recognized',
          frameTimestampsMs: [],
          framePaths: [],
        }],
      })],
    })).toThrow(/recognized without visualObservation/u);
  });

  it('merges only near-duplicate windows from the same non-drive asset and semantic kind', () => {
    const result = buildMaterialSpansFromReports({
      assets: [createVideoAsset({ id: 'asset-1', durationMs: 10_000 })],
      reports: [report({
        assetId: 'asset-1',
        clipTypeGuess: 'broll',
        interestingWindows: [
          { startMs: 0, endMs: 1_000, reason: 'a', semanticKind: 'visual' },
          { startMs: 1_200, endMs: 2_000, reason: 'b', semanticKind: 'visual' },
          { startMs: 2_100, endMs: 2_500, reason: 'c', semanticKind: 'speech' },
          { startMs: 9_000, endMs: 9_500, reason: 'd', semanticKind: 'visual' },
        ],
        transcriptSegments: [{ startMs: 2_100, endMs: 2_500, text: '不合并。' }],
      })],
    });

    expect(result.spans.map(span => [span.id, span.sourceInMs, span.sourceOutMs, span.semanticKind])).toEqual([
      ['asset-1_broll_visual_s0-2', 0, 2_000, 'visual'],
      ['asset-1_broll_speech_s2-3', 2_100, 2_500, 'speech'],
      ['asset-1_broll_visual_s9-10', 9_000, 9_500, 'visual'],
    ]);
  });

  it('keeps overlapping speech and visual spans complete in the same asset', () => {
    const result = buildMaterialSpansFromReports({
      assets: [createVideoAsset({ id: 'asset-overlap', durationMs: 20_000 })],
      reports: [report({
        assetId: 'asset-overlap',
        clipTypeGuess: 'drive',
        materializationPath: 'fine-scan',
        transcript: '这里是口播。',
        transcriptSegments: [{ startMs: 2_000, endMs: 4_000, text: '这里是口播。' }],
        fineScanWindows: [
          {
            windowId: 'asset-overlap_drive_visual_s0-10',
            sourceInMs: 0,
            sourceOutMs: 10_000,
            semanticKind: 'visual',
            visualObservation: '完整的行车视觉段落。',
            status: 'recognized',
            frameTimestampsMs: [],
            framePaths: [],
          },
          {
            windowId: 'asset-overlap_drive_speech_s2-4',
            sourceInMs: 2_000,
            sourceOutMs: 4_000,
            semanticKind: 'speech',
            transcript: '这里是口播。',
            transcriptSegments: [{ startMs: 2_000, endMs: 4_000, text: '这里是口播。' }],
            speechCoverage: 1,
            visualObservation: '车内有人说话。',
            status: 'recognized',
            frameTimestampsMs: [],
            framePaths: [],
          },
        ],
      })],
    });

    expect(result.spans.map(span => [span.id, span.sourceInMs, span.sourceOutMs, span.semanticKind])).toEqual([
      ['asset-overlap_drive_visual_s0-10', 0, 10_000, 'visual'],
      ['asset-overlap_drive_speech_s2-4', 2_000, 4_000, 'speech'],
    ]);
    expect(result.spans[0]?.transcript).toBeUndefined();
    expect(result.spans[0]?.visualObservation).toBe('完整的行车视觉段落。');
    expect(result.spans[1]?.transcript).toBe('这里是口播。');
  });

  it('merges adjacent speech spans under the speech limits without crossing larger pauses', () => {
    const result = buildMaterialSpansFromReports({
      assets: [createVideoAsset({ id: 'asset-speech-merge', durationMs: 30_000 })],
      reports: [report({
        assetId: 'asset-speech-merge',
        clipTypeGuess: 'talking-head',
        materializationPath: 'fine-scan',
        transcript: '第一句。第二句。第三句。',
        transcriptSegments: [
          { startMs: 0, endMs: 2_000, text: '第一句。' },
          { startMs: 4_500, endMs: 6_000, text: '第二句。' },
          { startMs: 10_000, endMs: 12_000, text: '第三句。' },
        ],
        fineScanWindows: [
          {
            windowId: 'asset-speech-merge_talking-head_speech_s0-2',
            sourceInMs: 0,
            sourceOutMs: 2_000,
            semanticKind: 'speech',
            transcriptSegments: [{ startMs: 0, endMs: 2_000, text: '第一句。' }],
            visualObservation: '第一段口播。',
            status: 'recognized',
            frameTimestampsMs: [],
            framePaths: [],
          },
          {
            windowId: 'asset-speech-merge_talking-head_speech_s5-6',
            sourceInMs: 4_500,
            sourceOutMs: 6_000,
            semanticKind: 'speech',
            transcriptSegments: [{ startMs: 4_500, endMs: 6_000, text: '第二句。' }],
            visualObservation: '第二段口播。',
            status: 'recognized',
            frameTimestampsMs: [],
            framePaths: [],
          },
          {
            windowId: 'asset-speech-merge_talking-head_speech_s10-12',
            sourceInMs: 10_000,
            sourceOutMs: 12_000,
            semanticKind: 'speech',
            transcriptSegments: [{ startMs: 10_000, endMs: 12_000, text: '第三句。' }],
            visualObservation: '第三段口播。',
            status: 'recognized',
            frameTimestampsMs: [],
            framePaths: [],
          },
        ],
      })],
    });

    expect(result.spans.map(span => [span.id, span.sourceInMs, span.sourceOutMs, span.transcript])).toEqual([
      ['asset-speech-merge_talking-head_speech_s0-6', 0, 6_000, '第一句。 第二句。'],
      ['asset-speech-merge_talking-head_speech_s10-12', 10_000, 12_000, '第三句。'],
    ]);
  });

  it('coalesces drive visual windows into passages across overlapping speech', () => {
    const result = buildMaterialSpansFromReports({
      assets: [createVideoAsset({ id: 'asset-drive-passage', durationMs: 180_000 })],
      reports: [report({
        assetId: 'asset-drive-passage',
        clipTypeGuess: 'drive',
        interestingWindows: [
          { startMs: 0, endMs: 10_000, reason: 'coarse-sample-window', semanticKind: 'visual' },
          { startMs: 20_000, endMs: 22_000, reason: 'speech-window', semanticKind: 'speech' },
          { startMs: 50_000, endMs: 60_000, reason: 'coarse-sample-window', semanticKind: 'visual' },
          { startMs: 120_000, endMs: 130_000, reason: 'coarse-sample-window', semanticKind: 'visual' },
        ],
        transcriptSegments: [{ startMs: 20_000, endMs: 22_000, text: '行车口播。' }],
      })],
    });

    expect(result.spans.map(span => [span.id, span.sourceInMs, span.sourceOutMs, span.semanticKind])).toEqual([
      ['asset-drive-passage_drive_visual_s0-60', 0, 60_000, 'visual'],
      ['asset-drive-passage_drive_speech_s20-22', 20_000, 22_000, 'speech'],
      ['asset-drive-passage_drive_visual_s120-130', 120_000, 130_000, 'visual'],
    ]);
  });

  it('ignores report labels and window speedCandidate fields in the span inputs hash', () => {
    const assets = [createVideoAsset({ id: 'asset-speed', durationMs: 10_000 })];
    const baseReport = report({
      assetId: 'asset-speed',
      clipTypeGuess: 'drive',
      labels: ['old-label'],
      interestingWindows: [{
        startMs: 0,
        endMs: 3_000,
        reason: 'drive',
        semanticKind: 'visual',
        speedCandidate: { suggestedSpeeds: [2], rationale: 'old' },
      }],
      fineScanWindows: [{
        windowId: 'unused-speed',
        sourceInMs: 0,
        sourceOutMs: 1_000,
        status: 'dropped',
        speedCandidate: { suggestedSpeeds: [2], rationale: 'old' },
        frameTimestampsMs: [],
        framePaths: [],
      }],
    });
    const changedReport = report({
      ...baseReport,
      labels: ['changed-label'],
      interestingWindows: [{
        ...baseReport.interestingWindows[0]!,
        speedCandidate: { suggestedSpeeds: [8], rationale: 'changed' },
      }],
      fineScanWindows: [{
        ...baseReport.fineScanWindows[0]!,
        speedCandidate: { suggestedSpeeds: [8], rationale: 'changed' },
      }],
    });

    expect(buildMaterialSpansFromReports({ assets, reports: [baseReport] }).inputsHash)
      .toBe(buildMaterialSpansFromReports({ assets, reports: [changedReport] }).inputsHash);
  });

  it('changes inputs hash when visualObservation or transcript facts change', () => {
    const assets = [createVideoAsset({ id: 'asset-facts', durationMs: 10_000 })];
    const baseReport = report({
      assetId: 'asset-facts',
      clipTypeGuess: 'talking-head',
      materializationPath: 'fine-scan',
      transcriptSegments: [{ startMs: 0, endMs: 1_000, text: '原始口播。' }],
      fineScanWindows: [{
        windowId: 'fact-window',
        sourceInMs: 0,
        sourceOutMs: 2_000,
        semanticKind: 'mixed',
        visualObservation: '车内自拍视频',
        status: 'recognized',
        frameTimestampsMs: [],
        framePaths: [],
      }],
    });
    const changedVisual = report({
      ...baseReport,
      fineScanWindows: [{
        ...baseReport.fineScanWindows[0]!,
        visualObservation: '车外道路画面',
      }],
    });
    const changedTranscript = report({
      ...baseReport,
      transcriptSegments: [{ startMs: 0, endMs: 1_000, text: '新的口播。' }],
    });

    const baseHash = buildMaterialSpansFromReports({ assets, reports: [baseReport] }).inputsHash;
    expect(buildMaterialSpansFromReports({ assets, reports: [changedVisual] }).inputsHash)
      .not.toBe(baseHash);
    expect(buildMaterialSpansFromReports({ assets, reports: [changedTranscript] }).inputsHash)
      .not.toBe(baseHash);
  });
});

describe('rebuildProjectSpans', () => {
  it('can read legacy span fields until the next stripped rebuild', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'kairos-span-legacy-read-'));
    workspaces.push(workspaceRoot);
    const projectRoot = await initWorkspaceProject(workspaceRoot, 'project-span-legacy-read', 'Span Legacy Read');
    await writeJson(getSpansPath(projectRoot), [{
      id: 'legacy-span',
      assetId: 'asset-1',
      type: 'drive',
      sourceInMs: 0,
      sourceOutMs: 1_000,
      labels: ['legacy-extra'],
      materialPatterns: [{ phrase: '旧对象标签', confidence: 0.9 }],
      narrativeFunctions: { core: [], extra: [], evidence: [] },
      grounding: {
        speechMode: 'none',
        speechValue: 'none',
        spatialEvidence: [],
        pharosRefs: [],
      },
      speedCandidate: {
        suggestedSpeeds: [2],
        rationale: 'legacy-speed',
      },
    }]);

    const spans = await loadSpans(projectRoot);

    expect(spans).toEqual([expect.objectContaining({
      id: 'legacy-span',
      materialPatterns: ['旧对象标签'],
      speedCandidate: {
        suggestedSpeeds: [2],
        rationale: 'legacy-speed',
      },
    })]);
  });

  it('writes only stripped spans plus LM materialPatterns and fresh meta without touching chronology', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'kairos-span-rebuild-'));
    workspaces.push(workspaceRoot);
    const projectId = 'project-span-rebuild';
    const projectRoot = await initWorkspaceProject(workspaceRoot, projectId, 'Span Rebuild');
    await writeJson(getAssetsPath(projectRoot), [createVideoAsset({ id: 'asset-1', durationMs: 5_000 })]);
    await writeJson(getAssetReportPath(projectRoot, 'asset-1'), report({
      assetId: 'asset-1',
      summary: '整段素材。',
      interestingWindows: [],
    }));
    await writeJson(join(projectRoot, 'media', 'chronology.json'), {
      schemaVersion: '2.0',
      status: 'confirmed',
      generatedAt: '2026-04-12T00:00:00.000Z',
      confirmedAt: '2026-04-12T00:00:00.000Z',
      inputsHash: 'old',
      assetIndex: [],
      events: [],
    });

    const runner = new FakePacketRunner([
      [visualReviewRow(['固定机位观察', '环境不明', '天气光线不明', '无口播语音', '情景不明', '补充视觉素材', '整段氛围素材'])],
    ]);
    const result = await rebuildProjectSpans({
      workspaceRoot,
      projectId,
      now: '2026-04-12T01:00:00.000Z',
      agentRunner: runner,
    });
    const rawSpans = JSON.parse(await readFile(getSpansPath(projectRoot), 'utf-8')) as Array<Record<string, unknown>>;
    const meta = await loadSpansMeta(projectRoot);
    const chronology = JSON.parse(await readFile(join(projectRoot, 'media', 'chronology.json'), 'utf-8')) as { status: string };
    const progress = JSON.parse(await readFile(getProjectProgressPath(projectRoot, 'chronology'), 'utf-8')) as { status: string; stepLabel?: string };

    expect(result.spanCount).toBe(1);
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]!.llm).toMatchObject({ maxTokens: CSPAN_MATERIALIZATION_REVIEW_MAX_TOKENS });
    const item = ((runner.calls[0]!.packet.inputArtifacts[0]!.content as { items: Array<Record<string, unknown>> }).items[0]);
    expect(Object.keys(item).sort()).toEqual(['type', 'visualObservation']);
    expect(item).toMatchObject({
      type: 'broll',
      visualObservation: '整段素材。',
    });
    expect(JSON.stringify(item)).not.toContain('labels');
    expect(JSON.stringify(item)).not.toContain('assetId');
    expect(rawSpans).toEqual([expect.objectContaining({
      id: 'asset-1_broll_s0-5',
      assetId: 'asset-1',
      materialPatterns: ['固定机位观察', '环境不明', '天气光线不明', '无口播语音', '情景不明', '补充视觉素材', '整段氛围素材'],
    })]);
    expect(rawSpans[0]).not.toHaveProperty('speedCandidate');
    expect(rawSpans[0]).not.toHaveProperty('grounding');
    expect(meta).toMatchObject({
      schemaVersion: '1.0',
      status: 'fresh',
      generatedAt: '2026-04-12T01:00:00.000Z',
      assetCount: 1,
      reportCount: 1,
      spanCount: 1,
    });
    expect(await readFile(getSpansMetaPath(projectRoot), 'utf-8')).toContain(result.inputsHash);
    expect(chronology.status).toBe('confirmed');
    expect(progress).toMatchObject({
      status: 'succeeded',
      stepLabel: '素材片段已生成',
    });
  });

  it('passes only minimal span facts to the materialPatterns packet', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'kairos-span-packet-'));
    workspaces.push(workspaceRoot);
    const projectId = 'project-span-packet';
    const projectRoot = await initWorkspaceProject(workspaceRoot, projectId, 'Span Packet');
    await writeJson(getAssetsPath(projectRoot), [createVideoAsset({ id: 'asset-packet', durationMs: 5_000 })]);
    await writeJson(getAssetReportPath(projectRoot, 'asset-packet'), report({
      assetId: 'asset-packet',
      clipTypeGuess: 'talking-head',
      materializationPath: 'fine-scan',
      summary: 'SHOULD_NOT_LEAK_SUMMARY',
      labels: ['SHOULD_NOT_LEAK_LABEL'],
      transcriptSegments: [{ startMs: 0, endMs: 1_000, text: '我们到了。' }],
      fineScanWindows: [{
        windowId: 'packet-window',
        sourceInMs: 0,
        sourceOutMs: 2_000,
        semanticKind: 'mixed',
        visualObservation: '车内自拍口播',
        status: 'recognized',
        frameTimestampsMs: [],
        framePaths: [],
      }],
    }));
    const runner = new FakePacketRunner([
      [speechReviewRow(['车内自拍口播', '车内', '天气光线不明', '有口播语音', '车内到达说明', '到达说明', '口播说明'])],
    ]);

    await rebuildProjectSpans({ workspaceRoot, projectId, agentRunner: runner });

    const packetContent = runner.calls[0]!.packet.inputArtifacts[0]!.content as {
      promptVersion: string;
      items: Array<Record<string, unknown>>;
    };
    const serializedInputContent = JSON.stringify(packetContent);
    expect(packetContent.promptVersion).toBe(CMATERIAL_PATTERN_PROMPT_VERSION);
    expect(packetContent.items).toEqual([{
      type: 'talking-head',
      semanticKind: 'mixed',
      transcript: '我们到了。',
      transcriptSegments: [{ index: 1, startMs: 0, endMs: 1000, text: '我们到了。' }],
      visualObservation: '车内自拍口播',
    }]);
    expect(serializedInputContent).not.toContain('packet-window');
    expect(serializedInputContent).not.toContain('SHOULD_NOT_LEAK_SUMMARY');
    expect(serializedInputContent).not.toContain('SHOULD_NOT_LEAK_LABEL');
    expect(serializedInputContent).not.toContain('GPS');
    expect(serializedInputContent).not.toContain('Pharos');
    expect(serializedInputContent).not.toContain('asset-packet');
  });

  it('writes speech candidates as pending Agent review instead of trimming or dropping them in Supervisor', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'kairos-span-speech-pending-'));
    workspaces.push(workspaceRoot);
    const projectId = 'project-span-speech-pending';
    const projectRoot = await initWorkspaceProject(workspaceRoot, projectId, 'Span Speech Pending');
    await writeJson(getAssetsPath(projectRoot), [
      createVideoAsset({ id: 'C0368_zve1_day0', durationMs: 180_000, capturedAt: '2026-04-12T01:00:00.000Z' }),
    ]);
    await writeJson(getAssetReportPath(projectRoot, 'C0368_zve1_day0'), report({
      assetId: 'C0368_zve1_day0',
      clipTypeGuess: 'drive',
      materializationPath: 'fine-scan',
      transcriptSegments: [
        { startMs: 148_000, endMs: 149_400, text: '中' },
      ],
      fineScanWindows: [{
        windowId: 'speech-window-junk',
        sourceInMs: 148_000,
        sourceOutMs: 149_400,
        semanticKind: 'speech',
        visualObservation: '夜间湿滑高速行车，前方有车辆。',
        status: 'recognized',
        frameTimestampsMs: [],
        framePaths: [],
      }],
    }));
    const runner = new FakePacketRunner([[
      speechReviewRow(['第一人称行车', '高速公路', '夜晚', '有口播语音', '夜间高速跟车', '湿滑路面', '前车跟随']),
    ]]);

    await rebuildProjectSpans({ workspaceRoot, projectId, agentRunner: runner, now: '2026-04-12T01:00:00.000Z' });
    const rawSpans = JSON.parse(await readFile(getSpansPath(projectRoot), 'utf-8')) as Array<Record<string, unknown>>;
    const meta = await loadSpansMeta(projectRoot);
    const handoffPath = meta?.speechReview?.handoffPath;
    const handoff = await readFile(handoffPath!, 'utf-8');

    expect(rawSpans).toEqual([expect.objectContaining({
      id: 'C0368_zve1_day0_drive_speech_s148-150',
      semanticKind: 'speech',
      sourceInMs: 148_000,
      sourceOutMs: 149_400,
      transcript: '中',
      materialPatterns: ['第一人称行车', '高速公路', '夜晚', '有口播语音', '夜间高速跟车', '湿滑路面', '前车跟随'],
    })]);
    expect(meta).toMatchObject({
      status: 'pending-speech-review',
      speechReview: {
        status: 'pending',
        candidateCount: 1,
      },
    });
    expect(handoffPath).toContain('speech-window-agent-handoff.md');
    expect(handoff).toContain('C0368_zve1_day0_drive_speech_s148-150');
    expect(handoff).toContain('中');
    expect(handoff).toContain('Speech/mixed candidates needing review: 1');
    await expect(assertFreshSpans(projectRoot))
      .rejects.toThrow(/pending-speech-review.*Codex Agent speech-window review/u);

    await writeJson(getSpansMetaPath(projectRoot), {
      ...meta!,
      status: 'fresh',
      speechReview: {
        ...meta!.speechReview,
        status: 'completed',
        updatedAt: '2026-04-12T01:30:00.000Z',
      },
    });
    await expect(assertFreshSpans(projectRoot)).resolves.toMatchObject({
      spans: expect.any(Array),
      meta: expect.objectContaining({ status: 'fresh' }),
    });
  });

  it('requests materialPatterns in chunks of eight and writes a partial checkpoint', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'kairos-span-chunk-'));
    workspaces.push(workspaceRoot);
    const projectId = 'project-span-chunk';
    const projectRoot = await initWorkspaceProject(workspaceRoot, projectId, 'Span Chunk');
    const assets = Array.from({ length: 16 }, (_, index) => createVideoAsset({
      id: `asset-${index + 1}`,
      durationMs: 5_000,
    }));
    await writeJson(getAssetsPath(projectRoot), assets);
    for (const asset of assets) {
      await writeJson(getAssetReportPath(projectRoot, asset.id), report({
        assetId: asset.id,
        summary: `${asset.id} 视觉素材。`,
        interestingWindows: [],
      }));
    }
    const runner = new FakePacketRunner([
      Array.from({ length: 8 }, (_, index) => visualReviewRow(['固定机位观察', '环境不明', '天气光线不明', '无口播语音', `素材${index + 1}整体观察`, `素材${index + 1}`, '画面记录'])),
      Array.from({ length: 8 }, (_, index) => visualReviewRow(['固定机位观察', '环境不明', '天气光线不明', '无口播语音', `素材${index + 9}整体观察`, `素材${index + 9}`, '画面记录'])),
    ]);

    await rebuildProjectSpans({ workspaceRoot, projectId, agentRunner: runner });

    expect(runner.calls).toHaveLength(2);
    expect((runner.calls[0]!.packet.inputArtifacts[0]!.content as { items: unknown[] }).items).toHaveLength(8);
    expect((runner.calls[1]!.packet.inputArtifacts[0]!.content as { items: unknown[] }).items).toHaveLength(8);
    const partial = JSON.parse(await readFile(
      join(projectRoot, '.tmp', 'chronology', 'span-rebuild.partial.json'),
      'utf-8',
    )) as { status: string; completedCount: number; chunkSize: number; spans: unknown[] };
    expect(partial).toMatchObject({
      status: 'succeeded',
      completedCount: 16,
      chunkSize: 8,
    });
    expect(partial.spans).toHaveLength(16);
  });

  it('blocks without rewriting spans when no local text LM runner is available', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'kairos-span-no-runner-'));
    workspaces.push(workspaceRoot);
    const projectId = 'project-span-no-runner';
    const projectRoot = await initWorkspaceProject(workspaceRoot, projectId, 'Span No Runner');
    await writeJson(getAssetsPath(projectRoot), [createVideoAsset({ id: 'asset-1', durationMs: 5_000 })]);
    await writeJson(getAssetReportPath(projectRoot, 'asset-1'), report({
      assetId: 'asset-1',
      interestingWindows: [],
    }));
    await writeJson(getSpansPath(projectRoot), [{
      id: 'existing-span',
      assetId: 'existing-asset',
      type: 'broll',
      materialPatterns: ['旧索引'],
    }]);

    await expect(rebuildProjectSpans({ workspaceRoot, projectId }))
      .rejects.toBeInstanceOf(AgentRunnerUnavailableError);

    const rawSpans = JSON.parse(await readFile(getSpansPath(projectRoot), 'utf-8')) as Array<Record<string, unknown>>;
    expect(rawSpans).toEqual([expect.objectContaining({
      id: 'existing-span',
      materialPatterns: ['旧索引'],
    })]);
  });

  it('blocks spans with missing visualObservation before calling the materialPatterns LM', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'kairos-span-no-visual-'));
    workspaces.push(workspaceRoot);
    const projectId = 'project-span-no-visual';
    const projectRoot = await initWorkspaceProject(workspaceRoot, projectId, 'Span No Visual');
    await writeJson(getAssetsPath(projectRoot), [createVideoAsset({ id: 'asset-no-visual', durationMs: 5_000 })]);
    await writeJson(getAssetReportPath(projectRoot, 'asset-no-visual'), report({
      assetId: 'asset-no-visual',
      summary: '',
      interestingWindows: [],
    }));
    await writeJson(getSpansPath(projectRoot), [{
      id: 'existing-span',
      assetId: 'existing-asset',
      type: 'broll',
      materialPatterns: ['旧索引'],
    }]);
    const runner = new FakePacketRunner([
      [visualReviewRow(['固定机位观察', '环境不明', '天气光线不明', '无口播语音', '情景不明', '兜底', '兜底'])],
    ]);

    await expect(rebuildProjectSpans({ workspaceRoot, projectId, agentRunner: runner }))
      .rejects.toThrow(/missing visualObservation/u);
    const rawSpans = JSON.parse(await readFile(getSpansPath(projectRoot), 'utf-8')) as Array<Record<string, unknown>>;

    expect(runner.calls).toHaveLength(0);
    expect(rawSpans).toEqual([expect.objectContaining({
      id: 'existing-span',
      materialPatterns: ['旧索引'],
    })]);
  });

  it('orders material pattern packets by material capture time instead of report filename order', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'kairos-span-time-order-'));
    workspaces.push(workspaceRoot);
    const projectId = 'project-span-time-order';
    const projectRoot = await initWorkspaceProject(workspaceRoot, projectId, 'Span Time Order');
    const assets = [
      createVideoAsset({ id: 'z-late', durationMs: 5_000, capturedAt: '2026-04-12T03:00:00.000Z' }),
      createVideoAsset({ id: 'a-early', durationMs: 5_000, capturedAt: '2026-04-12T01:00:00.000Z' }),
      createVideoAsset({ id: 'm-middle', durationMs: 5_000, capturedAt: '2026-04-12T02:00:00.000Z' }),
    ];
    await writeJson(getAssetsPath(projectRoot), assets);
    for (const asset of [assets[0]!, assets[2]!, assets[1]!]) {
      await writeJson(getAssetReportPath(projectRoot, asset.id), report({
        assetId: asset.id,
        summary: `${asset.id} visualObservation`,
        interestingWindows: [],
      }));
    }
    const runner = new FakePacketRunner([[
      visualReviewRow(['固定机位观察', '环境不明', '天气光线不明', '无口播语音', '早素材观察', '早素材', '画面记录']),
      visualReviewRow(['固定机位观察', '环境不明', '天气光线不明', '无口播语音', '中素材观察', '中素材', '画面记录']),
      visualReviewRow(['固定机位观察', '环境不明', '天气光线不明', '无口播语音', '晚素材观察', '晚素材', '画面记录']),
    ]]);

    await rebuildProjectSpans({ workspaceRoot, projectId, agentRunner: runner });
    const packetItems = (runner.calls[0]!.packet.inputArtifacts[0]!.content as {
      items: Array<{ visualObservation?: string }>;
    }).items;
    const rawSpans = JSON.parse(await readFile(getSpansPath(projectRoot), 'utf-8')) as Array<Record<string, unknown>>;

    expect(packetItems.map(item => item.visualObservation)).toEqual([
      'a-early visualObservation',
      'm-middle visualObservation',
      'z-late visualObservation',
    ]);
    expect(rawSpans.map(span => span.id)).toEqual([
      'a-early_broll_s0-5',
      'm-middle_broll_s0-5',
      'z-late_broll_s0-5',
    ]);
  });

  it('accepts a controlled slot1 tag without a regex support heuristic', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'kairos-span-closeup-reject-'));
    workspaces.push(workspaceRoot);
    const projectId = 'project-span-closeup-reject';
    const projectRoot = await initWorkspaceProject(workspaceRoot, projectId, 'Span Closeup Reject');
    await writeJson(getAssetsPath(projectRoot), [createVideoAsset({ id: 'asset-butterfly', durationMs: 5_000 })]);
    await writeJson(getAssetReportPath(projectRoot, 'asset-butterfly'), report({
      assetId: 'asset-butterfly',
      clipTypeGuess: 'broll',
      summary: 'A close-up shot of a butterfly resting on the yellow hood of a car, with hand touching the body surface.',
      interestingWindows: [],
    }));
    const runner = new FakePacketRunner([
      [visualReviewRow(['第一人称行车', '车旁', '晴天', '无口播语音', '蝴蝶停驻特写', '蝴蝶', '车身表面'])],
    ]);

    await rebuildProjectSpans({ workspaceRoot, projectId, agentRunner: runner });
    const rawSpans = JSON.parse(await readFile(getSpansPath(projectRoot), 'utf-8')) as Array<Record<string, unknown>>;

    expect(runner.calls).toHaveLength(1);
    expect(rawSpans).toEqual([expect.objectContaining({
      id: 'asset-butterfly_broll_s0-5',
      materialPatterns: ['第一人称行车', '车旁', '晴天', '无口播语音', '蝴蝶停驻特写', '蝴蝶', '车身表面'],
    })]);
  });

  it('rejects structured slot1 conflicts without reading visual text heuristically', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'kairos-span-structured-slot1-'));
    workspaces.push(workspaceRoot);
    const projectId = 'project-span-structured-slot1';
    const projectRoot = await initWorkspaceProject(workspaceRoot, projectId, 'Span Structured Slot1');
    await writeJson(getAssetsPath(projectRoot), [
      {
        id: 'asset-photo',
        kind: 'photo',
        sourcePath: 'photo.jpg',
        displayName: 'photo.jpg',
        capturedAt: '2026-04-12T01:00:00.000Z',
      },
      createVideoAsset({ id: 'asset-nospeech', durationMs: 5_000, capturedAt: '2026-04-12T02:00:00.000Z' }),
      createVideoAsset({ id: 'asset-drive', durationMs: 5_000, capturedAt: '2026-04-12T03:00:00.000Z' }),
    ]);
    await writeJson(getAssetReportPath(projectRoot, 'asset-photo'), report({
      assetId: 'asset-photo',
      clipTypeGuess: 'broll',
      summary: 'A static road photo.',
      interestingWindows: [],
    }));
    await writeJson(getAssetReportPath(projectRoot, 'asset-nospeech'), report({
      assetId: 'asset-nospeech',
      clipTypeGuess: 'broll',
      summary: 'A person stands beside a sign, but there is no transcript.',
      interestingWindows: [],
    }));
    await writeJson(getAssetReportPath(projectRoot, 'asset-drive'), report({
      assetId: 'asset-drive',
      clipTypeGuess: 'drive',
      summary: 'A car drives on a highway.',
      interestingWindows: [],
    }));
    const runner = new FakePacketRunner([
      [
        visualReviewRow(['第一人称行车', '公路旁', '晴天', '无口播语音', '静态道路照片', '公路', '路牌']),
        visualReviewRow(['手持自拍口播', '路边', '晴天', '无口播语音', '路边人物观察', '人物', '路牌']),
        visualReviewRow(['航拍俯瞰', '高速公路', '晴天', '无口播语音', '高速行车观察', '公路', '车辆']),
      ],
      [
        visualReviewRow(['第一人称行车', '公路旁', '晴天', '无口播语音', '静态道路照片', '公路', '路牌']),
        visualReviewRow(['手持自拍口播', '路边', '晴天', '无口播语音', '路边人物观察', '人物', '路牌']),
        visualReviewRow(['航拍俯瞰', '高速公路', '晴天', '无口播语音', '高速行车观察', '公路', '车辆']),
      ],
      [visualReviewRow(['第一人称行车', '公路旁', '晴天', '无口播语音', '静态道路照片', '公路', '路牌'])],
      [visualReviewRow(['手持自拍口播', '路边', '晴天', '无口播语音', '路边人物观察', '人物', '路牌'])],
      [visualReviewRow(['航拍俯瞰', '高速公路', '晴天', '无口播语音', '高速行车观察', '公路', '车辆'])],
    ]);

    await expect(rebuildProjectSpans({ workspaceRoot, projectId, agentRunner: runner }))
      .rejects.toThrow(/could not generate valid materialPatterns/);
    const partial = JSON.parse(await readFile(
      join(projectRoot, '.tmp', 'chronology', 'span-rebuild.partial.json'),
      'utf-8',
    )) as { failedSpans: Array<{ spanId: string; validationIssues?: string[] }> };
    const issues = partial.failedSpans.flatMap(item => item.validationIssues ?? []);

    expect(issues).toEqual(expect.arrayContaining([
      expect.stringContaining('conflicts with type=photo'),
      expect.stringContaining(`conflicts with slot 4=${'无口播语音'}`),
      expect.stringContaining('conflicts with type=drive'),
    ]));
  });

  it('accepts observable weather and light variants without rewriting them', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'kairos-span-weather-variants-'));
    workspaces.push(workspaceRoot);
    const projectId = 'project-span-weather-variants';
    const projectRoot = await initWorkspaceProject(workspaceRoot, projectId, 'Span Weather Variants');
    await writeJson(getAssetsPath(projectRoot), [
      createVideoAsset({ id: 'asset-dusk', durationMs: 5_000, capturedAt: '2026-04-12T01:00:00.000Z' }),
      createVideoAsset({ id: 'asset-light', durationMs: 5_000, capturedAt: '2026-04-12T02:00:00.000Z' }),
      createVideoAsset({ id: 'asset-dim', durationMs: 5_000, capturedAt: '2026-04-12T03:00:00.000Z' }),
    ]);
    await writeJson(getAssetReportPath(projectRoot, 'asset-dusk'), report({
      assetId: 'asset-dusk',
      clipTypeGuess: 'drive',
      summary: 'A car drives on a tree-lined road at dusk.',
      interestingWindows: [],
    }));
    await writeJson(getAssetReportPath(projectRoot, 'asset-light'), report({
      assetId: 'asset-light',
      clipTypeGuess: 'broll',
      summary: 'A tunnel interior under artificial lighting.',
      interestingWindows: [],
    }));
    await writeJson(getAssetReportPath(projectRoot, 'asset-dim'), report({
      assetId: 'asset-dim',
      clipTypeGuess: 'broll',
      summary: 'A dimly lit indoor corridor.',
      interestingWindows: [],
    }));
    const runner = new FakePacketRunner([[
      visualReviewRow(['第一人称行车', '树荫道路', '黄昏', '无口播语音', '黄昏道路行车', '树荫', '道路转弯']),
      visualReviewRow(['固定机位观察', '隧道内部', '人工照明', '无口播语音', '隧道内观察', '黄色灯光', '墙面纹理']),
      visualReviewRow(['固定机位观察', '室内走廊', '光线昏暗', '无口播语音', '昏暗走廊观察', '走廊空间', '弱光环境']),
    ]]);

    await rebuildProjectSpans({ workspaceRoot, projectId, agentRunner: runner });
    const rawSpans = JSON.parse(await readFile(getSpansPath(projectRoot), 'utf-8')) as Array<Record<string, unknown>>;

    expect(rawSpans.map(span => span.materialPatterns)).toEqual([
      ['第一人称行车', '树荫道路', '黄昏', '无口播语音', '黄昏道路行车', '树荫', '道路转弯'],
      ['固定机位观察', '隧道内部', '人工照明', '无口播语音', '隧道内观察', '黄色灯光', '墙面纹理'],
      ['固定机位观察', '室内走廊', '光线昏暗', '无口播语音', '昏暗走廊观察', '走廊空间', '弱光环境'],
    ]);
  });

  it('does not regex-reject slot2 phrases that include time or motion words', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'kairos-span-slot2-no-regex-'));
    workspaces.push(workspaceRoot);
    const projectId = 'project-span-slot2-no-regex';
    const projectRoot = await initWorkspaceProject(workspaceRoot, projectId, 'Span Slot2 No Regex');
    await writeJson(getAssetsPath(projectRoot), [
      createVideoAsset({ id: 'asset-night-road', durationMs: 5_000, capturedAt: '2026-04-12T01:00:00.000Z' }),
      createVideoAsset({ id: 'asset-harbor', durationMs: 5_000, capturedAt: '2026-04-12T02:00:00.000Z' }),
      createVideoAsset({ id: 'asset-seaside', durationMs: 5_000, capturedAt: '2026-04-12T03:00:00.000Z' }),
    ]);
    await writeJson(getAssetReportPath(projectRoot, 'asset-night-road'), report({
      assetId: 'asset-night-road',
      clipTypeGuess: 'drive',
      summary: 'Night road driving.',
      interestingWindows: [],
    }));
    await writeJson(getAssetReportPath(projectRoot, 'asset-harbor'), report({
      assetId: 'asset-harbor',
      clipTypeGuess: 'broll',
      summary: 'A harbor at dusk.',
      interestingWindows: [],
    }));
    await writeJson(getAssetReportPath(projectRoot, 'asset-seaside'), report({
      assetId: 'asset-seaside',
      clipTypeGuess: 'broll',
      summary: 'A seaside sunset scene.',
      interestingWindows: [],
    }));
    const runner = new FakePacketRunner([[
      visualReviewRow(['第一人称行车', '夜间道路', '夜晚', '无口播语音', '夜间行车观察', '路灯照明', '车辆大灯']),
      visualReviewRow(['环境远景', '港口黄昏', '黄昏', '无口播语音', '静谧港湾', '灯塔倒影', '水面平静']),
      visualReviewRow(['环境远景', '海边日落', '日落', '无口播语音', '日落海景', '海洋', '金色反光']),
    ]]);

    await rebuildProjectSpans({ workspaceRoot, projectId, agentRunner: runner });
    const rawSpans = JSON.parse(await readFile(getSpansPath(projectRoot), 'utf-8')) as Array<Record<string, unknown>>;

    expect(rawSpans.map(span => span.materialPatterns)).toEqual([
      ['第一人称行车', '夜间道路', '夜晚', '无口播语音', '夜间行车观察', '路灯照明', '车辆大灯'],
      ['环境远景', '港口黄昏', '黄昏', '无口播语音', '静谧港湾', '灯塔倒影', '水面平静'],
      ['环境远景', '海边日落', '日落', '无口播语音', '日落海景', '海洋', '金色反光'],
    ]);
  });

  it('rejects invalid positional slots instead of rewriting them heuristically', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'kairos-span-no-fallback-'));
    workspaces.push(workspaceRoot);
    const projectId = 'project-span-no-fallback';
    const projectRoot = await initWorkspaceProject(workspaceRoot, projectId, 'Span No Fallback');
    await writeJson(getAssetsPath(projectRoot), [createVideoAsset({ id: 'asset-drive', durationMs: 5_000 })]);
    await writeJson(getAssetReportPath(projectRoot, 'asset-drive'), report({
      assetId: 'asset-drive',
      clipTypeGuess: 'drive',
      summary: '山路行车画面。',
      interestingWindows: [],
    }));
    await writeJson(getSpansPath(projectRoot), [{
      id: 'existing-span',
      assetId: 'existing-asset',
      type: 'broll',
      materialPatterns: ['旧索引'],
    }]);
    const runner = new FakePacketRunner([
      [],
      [visualReviewRow(['湿滑山路行车', '山路行车', '高反差', '语音口播素材', '连续弯道', '手动跟车', '多余标签'])],
      [visualReviewRow(['湿滑山路行车', '山路行车', '高反差', '语音口播素材', '连续弯道', '手动跟车', '多余标签'])],
    ]);

    await expect(rebuildProjectSpans({ workspaceRoot, projectId, agentRunner: runner }))
      .rejects.toThrow(/could not generate valid materialPatterns/);
    expect(runner.calls).toHaveLength(3);
  });

  it('accepts rows with missing free slots and does not heuristically fill them', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'kairos-span-free-slots-'));
    workspaces.push(workspaceRoot);
    const projectId = 'project-span-free-slots';
    const projectRoot = await initWorkspaceProject(workspaceRoot, projectId, 'Span Free Slots');
    await writeJson(getAssetsPath(projectRoot), [createVideoAsset({ id: 'asset-drone', durationMs: 5_000 })]);
    await writeJson(getAssetReportPath(projectRoot, 'asset-drone'), report({
      assetId: 'asset-drone',
      clipTypeGuess: 'aerial',
      summary: 'A drone flies over snowy mountains under cloudy sky.',
      interestingWindows: [],
    }));
    const runner = new FakePacketRunner([
      [visualReviewRow(['航拍运动', '山地环境', '阴天', '无口播语音', '空中展示山地'])],
    ]);

    await rebuildProjectSpans({ workspaceRoot, projectId, agentRunner: runner });
    const rawSpans = JSON.parse(await readFile(getSpansPath(projectRoot), 'utf-8')) as Array<Record<string, unknown>>;

    expect(runner.calls).toHaveLength(1);
    expect(rawSpans).toEqual([expect.objectContaining({
      id: 'asset-drone_aerial_s0-5',
      materialPatterns: ['航拍运动', '山地环境', '阴天', '无口播语音', '空中展示山地'],
    })]);
  });

  it('retries rows with missing story slot and writes the retried story', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'kairos-span-story-retry-'));
    workspaces.push(workspaceRoot);
    const projectId = 'project-span-story-retry';
    const projectRoot = await initWorkspaceProject(workspaceRoot, projectId, 'Span Story Retry');
    await writeJson(getAssetsPath(projectRoot), [createVideoAsset({ id: 'asset-yak', durationMs: 5_000 })]);
    await writeJson(getAssetReportPath(projectRoot, 'asset-yak'), report({
      assetId: 'asset-yak',
      clipTypeGuess: 'drive',
      summary: 'A yellow vehicle waits while yaks cross a mountain road.',
      transcript: '等牦牛过去。',
      interestingWindows: [],
    }));
    const runner = new FakePacketRunner([
      [visualReviewRow(['第一人称行车', '山路', '雾天', '无口播语音'])],
      [visualReviewRow(['第一人称行车', '山路', '雾天', '无口播语音', '牦牛过路临时等待', '牦牛群', '临时等待'])],
    ]);

    await rebuildProjectSpans({ workspaceRoot, projectId, agentRunner: runner });
    const rawSpans = JSON.parse(await readFile(getSpansPath(projectRoot), 'utf-8')) as Array<Record<string, unknown>>;

    expect(runner.calls).toHaveLength(2);
    expect(rawSpans).toEqual([expect.objectContaining({
      id: 'asset-yak_drive_s0-5',
      materialPatterns: ['第一人称行车', '山路', '雾天', '无口播语音', '牦牛过路临时等待', '牦牛群', '临时等待'],
    })]);
  });

  it('feeds slot validation issues back to the LM retry without filling tags in code', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'kairos-span-validation-feedback-'));
    workspaces.push(workspaceRoot);
    const projectId = 'project-span-validation-feedback';
    const projectRoot = await initWorkspaceProject(workspaceRoot, projectId, 'Span Validation Feedback');
    await writeJson(getAssetsPath(projectRoot), [createVideoAsset({ id: 'asset-speech-drive', durationMs: 5_000 })]);
    await writeJson(getAssetReportPath(projectRoot, 'asset-speech-drive'), report({
      assetId: 'asset-speech-drive',
      clipTypeGuess: 'drive',
      summary: 'A car drives on a highway under a sunny sky.',
      transcript: '我们正在上高速。',
      transcriptSegments: [{ startMs: 0, endMs: 1_000, text: '我们正在上高速。' }],
      interestingWindows: [{ startMs: 0, endMs: 1_000, reason: 'speech-window', semanticKind: 'speech' }],
    }));
    const runner = new FakePacketRunner([
      [speechReviewRow(['第一人称行车', '高速公路', '晴天', '无口播语音', '高速出发说明', '车内说明', '出发提醒'])],
      [speechReviewRow(['第一人称行车', '高速公路', '晴天', '有口播语音', '高速出发说明', '车内说明', '出发提醒'])],
    ]);

    await rebuildProjectSpans({ workspaceRoot, projectId, agentRunner: runner });
    const rawSpans = JSON.parse(await readFile(getSpansPath(projectRoot), 'utf-8')) as Array<Record<string, unknown>>;
    const retryContent = runner.calls[1]!.packet.inputArtifacts[0]!.content as {
      expectedRowCount?: number;
      validationFeedback?: Array<{
        itemIndex: number;
        expectedSpeechTag?: string;
        validationIssues?: string[];
        lastReturnedRow?: string[];
      }>;
    };

    expect(runner.calls).toHaveLength(2);
    expect(retryContent.expectedRowCount).toBe(1);
    expect(retryContent.validationFeedback).toEqual([
      expect.objectContaining({
        itemIndex: 1,
        expectedSpeechTag: '有口播语音',
        validationIssues: expect.arrayContaining([expect.stringContaining('Slot 4 must be exactly 有口播语音')]),
        lastReturnedRow: ['第一人称行车', '高速公路', '晴天', '无口播语音', '高速出发说明', '车内说明', '出发提醒'],
      }),
    ]);
    expect(rawSpans).toEqual([expect.objectContaining({
      id: 'asset-speech-drive_drive_speech_s0-1',
      materialPatterns: ['第一人称行车', '高速公路', '晴天', '有口播语音', '高速出发说明', '车内说明', '出发提醒'],
    })]);
  });

  it('fails when the story slot is still missing after failed-list retry', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'kairos-span-story-fail-'));
    workspaces.push(workspaceRoot);
    const projectId = 'project-span-story-fail';
    const projectRoot = await initWorkspaceProject(workspaceRoot, projectId, 'Span Story Fail');
    await writeJson(getAssetsPath(projectRoot), [createVideoAsset({ id: 'asset-story-fail', durationMs: 5_000 })]);
    await writeJson(getAssetReportPath(projectRoot, 'asset-story-fail'), report({
      assetId: 'asset-story-fail',
      clipTypeGuess: 'drive',
      summary: 'Mountain road driving.',
      interestingWindows: [],
    }));
    await writeJson(getSpansPath(projectRoot), [{
      id: 'existing-span',
      assetId: 'existing-asset',
      type: 'broll',
      materialPatterns: ['旧索引'],
    }]);
    const runner = new FakePacketRunner([
      [visualReviewRow(['第一人称行车', '山路', '阴天', '无口播语音'])],
      [visualReviewRow(['第一人称行车', '山路', '阴天', '无口播语音'])],
      [visualReviewRow(['第一人称行车', '山路', '阴天', '无口播语音'])],
    ]);

    await expect(rebuildProjectSpans({ workspaceRoot, projectId, agentRunner: runner }))
      .rejects.toThrow(/could not generate valid materialPatterns/);
    const partial = JSON.parse(await readFile(
      join(projectRoot, '.tmp', 'chronology', 'span-rebuild.partial.json'),
      'utf-8',
    )) as { failedCount: number; recoveredFailedCount: number; storyUnknownFallbackCount: number };

    expect(runner.calls).toHaveLength(3);
    expect(partial).toMatchObject({
      failedCount: 1,
      recoveredFailedCount: 0,
      storyUnknownFallbackCount: 0,
    });
  });

  it('records a failed row in the checkpoint and recovers it in the failed-list pass', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'kairos-span-failed-list-'));
    workspaces.push(workspaceRoot);
    const projectId = 'project-span-failed-list';
    const projectRoot = await initWorkspaceProject(workspaceRoot, projectId, 'Span Failed List');
    await writeJson(getAssetsPath(projectRoot), [
      createVideoAsset({ id: 'asset-ok', durationMs: 5_000 }),
      createVideoAsset({ id: 'asset-retry', durationMs: 5_000 }),
    ]);
    await writeJson(getAssetReportPath(projectRoot, 'asset-ok'), report({
      assetId: 'asset-ok',
      clipTypeGuess: 'broll',
      summary: '服务区停车场观察。',
      interestingWindows: [],
    }));
    await writeJson(getAssetReportPath(projectRoot, 'asset-retry'), report({
      assetId: 'asset-retry',
      clipTypeGuess: 'drive',
      summary: '山路行车。',
      interestingWindows: [],
    }));
    const runner = new FakePacketRunner([
      [
        visualReviewRow(['固定机位观察', '服务区停车场', '晴天', '无口播语音', '服务区停车观察', '停车场', '车辆停放']),
        visualReviewRow(['第一人称行车', '山路', '阴天', '无口播语音']),
      ],
      [
        visualReviewRow(['固定机位观察', '服务区停车场', '晴天', '无口播语音', '服务区停车观察', '停车场', '车辆停放']),
        visualReviewRow(['第一人称行车', '山路', '阴天', '无口播语音']),
      ],
      [visualReviewRow(['第一人称行车', '山路', '阴天', '无口播语音', '山路行车观察', '连续弯道', '车窗视角'])],
    ]);

    await rebuildProjectSpans({ workspaceRoot, projectId, agentRunner: runner });
    const rawSpans = JSON.parse(await readFile(getSpansPath(projectRoot), 'utf-8')) as Array<Record<string, unknown>>;
    const partial = JSON.parse(await readFile(
      join(projectRoot, '.tmp', 'chronology', 'span-rebuild.partial.json'),
      'utf-8',
    )) as { failedSpans: Array<Record<string, unknown>>; failedCount: number; recoveredFailedCount: number };

    expect(runner.calls).toHaveLength(3);
    expect(rawSpans).toEqual([
      expect.objectContaining({
        id: 'asset-ok_broll_s0-5',
        materialPatterns: ['固定机位观察', '服务区停车场', '晴天', '无口播语音', '服务区停车观察', '停车场', '车辆停放'],
      }),
      expect.objectContaining({
        id: 'asset-retry_drive_s0-5',
        materialPatterns: ['第一人称行车', '山路', '阴天', '无口播语音', '山路行车观察', '连续弯道', '车窗视角'],
      }),
    ]);
    expect(partial.failedCount).toBe(1);
    expect(partial.recoveredFailedCount).toBe(1);
    expect(partial.failedSpans[0]).toMatchObject({
      spanId: 'asset-retry_drive_s0-5',
      recovered: true,
    });
  });

  it('revalidates stale slot1 support failures from checkpoint before retrying the LM', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'kairos-span-stale-slot1-'));
    workspaces.push(workspaceRoot);
    const projectId = 'project-span-stale-slot1';
    const projectRoot = await initWorkspaceProject(workspaceRoot, projectId, 'Span Stale Slot1');
    const assets = [createVideoAsset({ id: 'asset-drive', durationMs: 5_000 })];
    const reports = [report({
      assetId: 'asset-drive',
      clipTypeGuess: 'drive',
      summary: 'A car drives through an urban residential road under overcast sky.',
      interestingWindows: [],
    })];
    await writeJson(getAssetsPath(projectRoot), assets);
    await writeJson(getAssetReportPath(projectRoot, 'asset-drive'), reports[0]);
    const generated = buildMaterialSpansFromReports({ assets, reports });
    const spanId = generated.spans[0]!.id;
    await writeJson(join(projectRoot, '.tmp', 'chronology', 'span-rebuild.partial.json'), {
      schemaVersion: '1.0',
      status: 'running',
      promptVersion: CMATERIAL_PATTERN_PROMPT_VERSION,
      inputsHash: generated.inputsHash,
      spanCount: generated.spans.length,
      chunkSize: 8,
      completedCount: 0,
      spans: [],
      warnings: [],
      failedSpans: [{
        spanId,
        assetId: 'asset-drive',
        chunkIndex: 1,
        reason: 'missing-or-invalid-first-four/story',
        validationIssues: [
          'Slot 1 "第一人称行车" is not supported by this item\'s type/semanticKind/transcript/visualObservation; choose a controlled tag supported by the current item only.',
        ],
        expectedSpeechTag: '无口播语音',
        lastReturnedRow: ['第一人称行车', '城市住宅区', '阴天', '无口播语音', '穿行密集住宅区', '高楼林立', '过街天桥'],
        attempts: 2,
        recovered: false,
      }],
      retryCount: 2,
      updatedAt: '2026-04-12T00:00:00.000Z',
    });
    const runner = new FakePacketRunner([]);

    await rebuildProjectSpans({ workspaceRoot, projectId, agentRunner: runner });
    const rawSpans = JSON.parse(await readFile(getSpansPath(projectRoot), 'utf-8')) as Array<Record<string, unknown>>;
    const partial = JSON.parse(await readFile(
      join(projectRoot, '.tmp', 'chronology', 'span-rebuild.partial.json'),
      'utf-8',
    )) as { failedSpans: Array<Record<string, unknown>>; recoveredFailedCount: number };

    expect(runner.calls).toHaveLength(0);
    expect(rawSpans).toEqual([expect.objectContaining({
      id: spanId,
      materialPatterns: ['第一人称行车', '城市住宅区', '阴天', '无口播语音', '穿行密集住宅区', '高楼林立', '过街天桥'],
    })]);
    expect(partial.recoveredFailedCount).toBe(1);
    expect(partial.failedSpans[0]).toMatchObject({
      spanId,
      reason: 'recovered-by-checkpoint-row-revalidation',
      recovered: true,
    });
  });

  it('resumes from a matching partial checkpoint and skips completed spans', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'kairos-span-resume-'));
    workspaces.push(workspaceRoot);
    const projectId = 'project-span-resume';
    const projectRoot = await initWorkspaceProject(workspaceRoot, projectId, 'Span Resume');
    const assets = [
      createVideoAsset({ id: 'asset-done', durationMs: 5_000 }),
      createVideoAsset({ id: 'asset-pending', durationMs: 5_000 }),
    ];
    const reports = [
      report({ assetId: 'asset-done', clipTypeGuess: 'broll', summary: '室内餐厅。', interestingWindows: [] }),
      report({ assetId: 'asset-pending', clipTypeGuess: 'aerial', summary: '雪山航拍。', interestingWindows: [] }),
    ];
    await writeJson(getAssetsPath(projectRoot), assets);
    for (const item of reports) {
      await writeJson(getAssetReportPath(projectRoot, item.assetId), item);
    }
    const generated = buildMaterialSpansFromReports({ assets, reports });
    await writeJson(join(projectRoot, '.tmp', 'chronology', 'span-rebuild.partial.json'), {
      schemaVersion: '1.0',
      status: 'running',
      promptVersion: CMATERIAL_PATTERN_PROMPT_VERSION,
      inputsHash: generated.inputsHash,
      spanCount: generated.spans.length,
      chunkSize: 8,
      completedCount: 1,
      spans: [{
        ...generated.spans[0],
        sourceSpanId: generated.spans[0]!.id,
        semanticKind: 'visual',
        id: 'asset-done_broll_visual_s0-5',
        materialPatterns: ['固定机位观察', '室内餐厅', '室内灯光', '无口播语音', '餐厅环境观察'],
      }],
      warnings: [],
      failedSpans: [],
      updatedAt: '2026-04-12T00:00:00.000Z',
    });
    const runner = new FakePacketRunner([
      [visualReviewRow(['航拍俯瞰', '山地环境', '晴天', '无口播语音', '空中展示雪山', '雪山航拍', '远景建立'])],
    ]);

    await rebuildProjectSpans({ workspaceRoot, projectId, agentRunner: runner });
    const rawSpans = JSON.parse(await readFile(getSpansPath(projectRoot), 'utf-8')) as Array<Record<string, unknown>>;
    const packetContent = runner.calls[0]!.packet.inputArtifacts[0]!.content as { items: unknown[] };

    expect(runner.calls).toHaveLength(1);
    expect(packetContent.items).toHaveLength(1);
    expect(rawSpans).toEqual([
      expect.objectContaining({
        id: 'asset-done_broll_visual_s0-5',
        materialPatterns: ['固定机位观察', '室内餐厅', '室内灯光', '无口播语音', '餐厅环境观察'],
      }),
      expect.objectContaining({
        id: 'asset-pending_aerial_s0-5',
        materialPatterns: ['航拍俯瞰', '山地环境', '晴天', '无口播语音', '空中展示雪山', '雪山航拍', '远景建立'],
      }),
    ]);
  });

  it('ignores a partial checkpoint when the inputsHash does not match', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'kairos-span-resume-mismatch-'));
    workspaces.push(workspaceRoot);
    const projectId = 'project-span-resume-mismatch';
    const projectRoot = await initWorkspaceProject(workspaceRoot, projectId, 'Span Resume Mismatch');
    await writeJson(getAssetsPath(projectRoot), [
      createVideoAsset({ id: 'asset-one', durationMs: 5_000 }),
      createVideoAsset({ id: 'asset-two', durationMs: 5_000 }),
    ]);
    await writeJson(getAssetReportPath(projectRoot, 'asset-one'), report({
      assetId: 'asset-one',
      clipTypeGuess: 'broll',
      summary: '城市街道。',
      interestingWindows: [],
    }));
    await writeJson(getAssetReportPath(projectRoot, 'asset-two'), report({
      assetId: 'asset-two',
      clipTypeGuess: 'broll',
      summary: '室内餐厅。',
      interestingWindows: [],
    }));
    await writeJson(join(projectRoot, '.tmp', 'chronology', 'span-rebuild.partial.json'), {
      schemaVersion: '1.0',
      status: 'running',
      promptVersion: CMATERIAL_PATTERN_PROMPT_VERSION,
      inputsHash: 'stale-input-hash',
      spanCount: 2,
      chunkSize: 8,
      completedCount: 1,
      spans: [{
        id: 'asset-one_broll_visual_s0-5',
        assetId: 'asset-one',
        type: 'broll',
        semanticKind: 'visual',
        sourceSpanId: 'asset-one_broll_s0-5',
        materialPatterns: ['固定机位观察', '旧环境', '晴天', '无口播语音', '旧情景'],
      }],
      warnings: [],
      updatedAt: '2026-04-12T00:00:00.000Z',
    });
    const runner = new FakePacketRunner([[
      visualReviewRow(['固定机位观察', '城市街道', '晴天', '无口播语音', '街道环境观察', '城市道路', '路边观察']),
      visualReviewRow(['固定机位观察', '室内餐厅', '室内灯光', '无口播语音', '餐厅环境观察', '餐桌区域', '室内空间']),
    ]]);

    await rebuildProjectSpans({ workspaceRoot, projectId, agentRunner: runner });
    const rawSpans = JSON.parse(await readFile(getSpansPath(projectRoot), 'utf-8')) as Array<Record<string, unknown>>;
    const packetContent = runner.calls[0]!.packet.inputArtifacts[0]!.content as { items: unknown[] };

    expect(runner.calls).toHaveLength(1);
    expect(packetContent.items).toHaveLength(2);
    expect(rawSpans[0]).toEqual(expect.objectContaining({
      id: 'asset-one_broll_s0-5',
      materialPatterns: ['固定机位观察', '城市街道', '晴天', '无口播语音', '街道环境观察', '城市道路', '路边观察'],
    }));
  });

  it('accepts drift object responses with materialPatterns items mapped by order', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'kairos-span-drift-'));
    workspaces.push(workspaceRoot);
    const projectId = 'project-span-drift';
    const projectRoot = await initWorkspaceProject(workspaceRoot, projectId, 'Span Drift');
    await writeJson(getAssetsPath(projectRoot), [createVideoAsset({ id: 'asset-talk', durationMs: 5_000 })]);
    await writeJson(getAssetReportPath(projectRoot, 'asset-talk'), report({
      assetId: 'asset-talk',
      clipTypeGuess: 'talking-head',
      materializationPath: 'fine-scan',
      transcriptSegments: [{ startMs: 0, endMs: 1_000, text: '我们终于到了服务区。' }],
      summary: '车内自拍口播。',
      fineScanWindows: [{
        windowId: 'asset-talk-window-1',
        sourceInMs: 0,
        sourceOutMs: 2_000,
        semanticKind: 'mixed',
        visualObservation: '车内自拍口播。',
        status: 'recognized',
        frameTimestampsMs: [],
        framePaths: [],
      }],
    }));
    const runner = new FakePacketRunner([{
      items: [{
        id: 'ignored-by-order',
        materialPatterns: ['车内自拍口播', '车内', '室内灯光', '有口播语音', '车内抵达服务区', '到达说明', '安全提醒'],
      }],
    }]);

    await rebuildProjectSpans({ workspaceRoot, projectId, agentRunner: runner });
    const rawSpans = JSON.parse(await readFile(getSpansPath(projectRoot), 'utf-8')) as Array<Record<string, unknown>>;

    expect(rawSpans).toEqual([expect.objectContaining({
      id: 'asset-talk_talking-head_mixed_s0-2',
      materialPatterns: ['车内自拍口播', '车内', '室内灯光', '有口播语音', '车内抵达服务区', '到达说明', '安全提醒'],
    })]);
  });
});

function report(overrides: Partial<IAssetCoarseReport> & Pick<IAssetCoarseReport, 'assetId'>): IAssetCoarseReport {
  return {
    assetId: overrides.assetId,
    durationMs: overrides.durationMs,
    clipTypeGuess: overrides.clipTypeGuess ?? 'broll',
    keepDecision: overrides.keepDecision ?? 'keep',
    materializationPath: overrides.materializationPath ?? 'direct',
    fineScanMode: overrides.fineScanMode,
    densityScore: overrides.densityScore ?? 0.5,
    summary: overrides.summary ?? '素材摘要。',
    transcript: overrides.transcript,
    transcriptSegments: overrides.transcriptSegments,
    speechCoverage: overrides.speechCoverage,
    labels: overrides.labels ?? [],
    placeHints: overrides.placeHints ?? [],
    rootNotes: overrides.rootNotes ?? [],
    sampleFrames: overrides.sampleFrames ?? [],
    interestingWindows: overrides.interestingWindows ?? [{
      startMs: 0,
      endMs: 1_000,
      reason: 'default',
    }],
    fineScanWindows: overrides.fineScanWindows ?? [],
    fineScanReasons: overrides.fineScanReasons ?? [],
    createdAt: overrides.createdAt ?? '2026-04-12T00:00:00.000Z',
    updatedAt: overrides.updatedAt ?? '2026-04-12T00:00:00.000Z',
  };
}
