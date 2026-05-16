import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AgentRunnerUnavailableError,
  type IJsonPacketAgentInvocation,
  type IJsonPacketAgentRunner,
} from '../../src/modules/agents/runtime.js';
import { CSPAN_MATERIAL_PATTERN_MAX_TOKENS } from '../../src/modules/agents/span-material-pattern-spec.js';
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
      'direct-1-direct-1',
      'direct-1-direct-2',
      'fallback-1-direct-full',
      'fine-window-1',
      'photo-1',
    ]);
    expect(result.spans.find(span => span.id === 'photo-1')).toMatchObject({
      assetId: 'photo-1',
      type: 'photo',
      sourceInMs: 0,
      sourceOutMs: 0,
    });
    expect(result.spans.find(span => span.id === 'direct-1-direct-1')).toMatchObject({
      type: 'drive',
      semanticKind: 'visual',
      sourceInMs: 500,
      sourceOutMs: 2_000,
      editSourceInMs: 250,
      editSourceOutMs: 2_250,
      visualObservation: '车窗外道路。',
      materialPatterns: [],
    });
    expect(result.spans.find(span => span.id === 'direct-1-direct-2')).toMatchObject({
      semanticKind: 'speech',
      transcript: '路上第一句。 第二句。',
      speechCoverage: 0.8,
    });
    expect(result.spans.find(span => span.id === 'fallback-1-direct-full')).toMatchObject({
      sourceInMs: 0,
      sourceOutMs: 8_000,
    });
    expect(result.spans.find(span => span.id === 'fine-window-1')).toMatchObject({
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

  it('merges only near-duplicate windows from the same asset and semantic kind', () => {
    const result = buildMaterialSpansFromReports({
      assets: [createVideoAsset({ id: 'asset-1', durationMs: 10_000 })],
      reports: [report({
        assetId: 'asset-1',
        clipTypeGuess: 'drive',
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
      ['asset-1-direct-1', 0, 2_000, 'visual'],
      ['asset-1-direct-3', 2_100, 2_500, 'speech'],
      ['asset-1-direct-4', 9_000, 9_500, 'visual'],
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
      [['补充视觉素材', '整段氛围素材']],
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
    expect(runner.calls[0]!.llm).toMatchObject({ maxTokens: CSPAN_MATERIAL_PATTERN_MAX_TOKENS });
    const item = ((runner.calls[0]!.packet.inputArtifacts[0]!.content as { items: Array<Record<string, unknown>> }).items[0]);
    expect(Object.keys(item).sort()).toEqual(['type', 'visualObservation']);
    expect(item).toMatchObject({
      type: 'broll',
      visualObservation: '整段素材。',
    });
    expect(JSON.stringify(runner.calls[0])).not.toContain('labels');
    expect(JSON.stringify(runner.calls[0])).not.toContain('assetId');
    expect(rawSpans).toEqual([expect.objectContaining({
      id: 'asset-1-direct-full',
      assetId: 'asset-1',
      materialPatterns: ['固定机位观察', '环境不明', '天气光线不明', '无口播语音', '补充视觉素材', '整段氛围素材'],
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
      [['车内自拍口播', '车内', '天气光线不明', '有口播语音', '到达说明']],
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
      visualObservation: '车内自拍口播',
    }]);
    expect(serializedInputContent).not.toContain('packet-window');
    expect(serializedInputContent).not.toContain('SHOULD_NOT_LEAK_SUMMARY');
    expect(serializedInputContent).not.toContain('SHOULD_NOT_LEAK_LABEL');
    expect(serializedInputContent).not.toContain('GPS');
    expect(serializedInputContent).not.toContain('Pharos');
    expect(serializedInputContent).not.toContain('asset-packet');
  });

  it('requests materialPatterns in chunks of ten and writes a partial checkpoint', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'kairos-span-chunk-'));
    workspaces.push(workspaceRoot);
    const projectId = 'project-span-chunk';
    const projectRoot = await initWorkspaceProject(workspaceRoot, projectId, 'Span Chunk');
    const assets = Array.from({ length: 20 }, (_, index) => createVideoAsset({
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
      Array.from({ length: 10 }, (_, index) => ['固定机位观察', '环境不明', '天气光线不明', '无口播语音', `素材${index + 1}`]),
      Array.from({ length: 10 }, (_, index) => ['固定机位观察', '环境不明', '天气光线不明', '无口播语音', `素材${index + 11}`]),
    ]);

    await rebuildProjectSpans({ workspaceRoot, projectId, agentRunner: runner });

    expect(runner.calls).toHaveLength(2);
    expect((runner.calls[0]!.packet.inputArtifacts[0]!.content as { items: unknown[] }).items).toHaveLength(10);
    expect((runner.calls[1]!.packet.inputArtifacts[0]!.content as { items: unknown[] }).items).toHaveLength(10);
    const partial = JSON.parse(await readFile(
      join(projectRoot, '.tmp', 'chronology', 'span-rebuild.partial.json'),
      'utf-8',
    )) as { status: string; completedCount: number; chunkSize: number; spans: unknown[] };
    expect(partial).toMatchObject({
      status: 'succeeded',
      completedCount: 20,
      chunkSize: 10,
    });
    expect(partial.spans).toHaveLength(20);
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

  it('retries missing rows once, then repairs the v4 positional slots deterministically', async () => {
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
      [['湿滑山路行车', '山路行车', '高反差', '语音口播素材', '连续弯道', '手动跟车', '多余标签']],
    ]);

    await rebuildProjectSpans({ workspaceRoot, projectId, agentRunner: runner });
    const rawSpans = JSON.parse(await readFile(getSpansPath(projectRoot), 'utf-8')) as Array<Record<string, unknown>>;

    expect(runner.calls).toHaveLength(2);
    expect(rawSpans).toEqual([expect.objectContaining({
      id: 'asset-drive-direct-full',
      materialPatterns: ['第一人称行车', '山路', '天气光线不明', '无口播语音', '湿滑山路行车', '山路行车'],
    })]);
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
        materialPatterns: ['车内自拍口播', '车内', '室内灯光', '无口播语音', '到达说明', '安全提醒', '多余标签'],
      }],
    }]);

    await rebuildProjectSpans({ workspaceRoot, projectId, agentRunner: runner });
    const rawSpans = JSON.parse(await readFile(getSpansPath(projectRoot), 'utf-8')) as Array<Record<string, unknown>>;

    expect(rawSpans).toEqual([expect.objectContaining({
      id: 'asset-talk-window-1',
      materialPatterns: ['车内自拍口播', '车内', '室内灯光', '有口播语音', '到达说明', '安全提醒'],
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
