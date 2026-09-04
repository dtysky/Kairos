import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  IAssetCoarseReport,
  IKtepAsset,
  IKtepSpan,
} from '../../src/protocol/schema.js';
import {
  applyProjectTranscriptAgentDecisions,
  prepareProjectTranscriptReview,
  resolveTranscriptCorrectionReview,
} from '../../src/modules/media/transcript-review.js';
import {
  getSpansPath,
  loadReviewQueue,
  loadSpans,
  loadSpansMeta,
  loadTranscriptGlossary,
  saveManualItineraryConfig,
  saveProjectBriefConfig,
  saveTranscriptGlossary,
  writeJson,
  writeSpansMeta,
} from '../../src/store/index.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('post-ASR transcript review', () => {
  it('deduplicates a shared segment, uses corrected capturedAt context, and applies grounded text to every span', async () => {
    const fixture = await createFixture();
    await saveTranscriptGlossary(fixture.workspaceRoot, {
      schemaVersion: '2.0',
      entries: [{ canonical: '野猪嶂', pronunciation: 'yě zhū zhàng', context: '行程、路线或地点介绍时' }],
    });
    await saveManualItineraryConfig(fixture.projectRoot, {
      prose: '',
      segments: [{ id: 'day-1', date: '2026-07-01', location: '野猪嶂' }],
      captureTimeOverrides: [],
    });
    const spans = [createSpan('span-a', '野猪掌'), createSpan('span-b', '野猪掌')];
    const prepared = await prepareProjectTranscriptReview({
      ...fixture,
      assets: [fixture.asset],
      reports: [fixture.report],
      spans,
      speechCandidates: spans,
      inputsHash: 'inputs-a',
      generatedAt: '2026-09-04T00:00:00.000Z',
    });

    expect(prepared.artifact.items).toHaveLength(1);
    expect(prepared.artifact.items[0]?.spanIds).toEqual(['span-a', 'span-b']);
    expect(prepared.artifact.items[0]?.contextEvents.some(event => event.location === '野猪嶂')).toBe(true);
    await seedPendingReview(fixture.projectRoot, prepared.spans, 'inputs-a', prepared.artifactPath);

    const item = prepared.artifact.items[0]!;
    await expect(applyProjectTranscriptAgentDecisions({
      workspaceRoot: fixture.workspaceRoot,
      projectRoot: fixture.projectRoot,
      inputsHash: 'inputs-a',
      decisions: [{
        itemId: item.id,
        inputsHash: 'inputs-a',
        originalTextHash: item.originalTextHash,
        startMs: item.startMs + 1,
        endMs: item.endMs,
        action: 'auto-apply',
        suggestedText: '野猪嶂',
        finalText: '野猪嶂',
        confidence: 0.99,
        containsProperNoun: true,
        evidence: [{ source: 'glossary', value: '野猪嶂', ref: '行程、路线或地点介绍时' }],
      }],
    })).rejects.toThrow(/immutable segment timing/u);

    await expect(applyProjectTranscriptAgentDecisions({
      workspaceRoot: fixture.workspaceRoot,
      projectRoot: fixture.projectRoot,
      inputsHash: 'inputs-a',
      decisions: [{
        itemId: item.id,
        inputsHash: 'inputs-a',
        originalTextHash: item.originalTextHash,
        startMs: item.startMs,
        endMs: item.endMs,
        action: 'auto-apply',
        suggestedText: '野猪嶂',
        finalText: '野猪嶂',
        confidence: 0.99,
        containsProperNoun: true,
        evidence: [{ source: 'glossary', value: '野猪嶂' }],
      }],
    })).rejects.toThrow(/unsupported proper name/u);

    await applyProjectTranscriptAgentDecisions({
      workspaceRoot: fixture.workspaceRoot,
      projectRoot: fixture.projectRoot,
      inputsHash: 'inputs-a',
      decisions: [{
        itemId: item.id,
        inputsHash: 'inputs-a',
        originalTextHash: item.originalTextHash,
        startMs: item.startMs,
        endMs: item.endMs,
        action: 'auto-apply',
        suggestedText: '野猪嶂',
        finalText: '野猪嶂',
        confidence: 0.99,
        containsProperNoun: true,
        evidence: [{ source: 'glossary', value: '野猪嶂', ref: '行程、路线或地点介绍时' }],
      }],
    });

    const saved = await loadSpans(fixture.projectRoot);
    expect(saved.map(span => span.transcript)).toEqual(['野猪嶂', '野猪嶂']);
    expect(saved.map(span => span.transcriptSegments?.[0]?.text)).toEqual(['野猪嶂', '野猪嶂']);
    expect((await loadSpansMeta(fixture.projectRoot))?.status).toBe('fresh');
  });

  it('rejects an ungrounded proper-name auto correction', async () => {
    const fixture = await createFixture();
    const spans = [createSpan('span-a', '某个山')];
    const prepared = await prepareProjectTranscriptReview({
      ...fixture,
      assets: [fixture.asset],
      reports: [fixture.report],
      spans,
      speechCandidates: spans,
      inputsHash: 'inputs-b',
      generatedAt: '2026-09-04T00:00:00.000Z',
    });
    await seedPendingReview(fixture.projectRoot, prepared.spans, 'inputs-b', prepared.artifactPath);
    const item = prepared.artifact.items[0]!;
    await expect(applyProjectTranscriptAgentDecisions({
      workspaceRoot: fixture.workspaceRoot,
      projectRoot: fixture.projectRoot,
      inputsHash: 'inputs-b',
      decisions: [{
        itemId: item.id,
        inputsHash: 'inputs-b',
        originalTextHash: item.originalTextHash,
        startMs: item.startMs,
        endMs: item.endMs,
        action: 'auto-apply',
        finalText: '新专名峰',
        confidence: 0.98,
        containsProperNoun: true,
        evidence: [{ source: 'agent-knowledge', value: '新专名峰' }],
      }],
    })).rejects.toThrow(/unsupported proper name/u);
  });

  it('blocks the Agent handoff when a declared Pharos trip has no fresh context', async () => {
    const fixture = await createFixture();
    await saveProjectBriefConfig(fixture.projectRoot, {
      name: 'Trip',
      mappings: [],
      pharos: { includedTripIds: ['trip-33'] },
      materialPatternPhrases: [],
    });
    const span = createSpan('span-a', '野猪掌');
    await expect(prepareProjectTranscriptReview({
      ...fixture,
      assets: [fixture.asset],
      reports: [fixture.report],
      spans: [span],
      speechCandidates: [span],
      inputsHash: 'inputs-pharos-stale',
      generatedAt: '2026-09-04T00:00:00.000Z',
    })).rejects.toThrow(/先运行 Ingest 或刷新 GPS 缓存/u);
  });

  it('rejects a main-Agent span edit that changes transcript segmentation', async () => {
    const fixture = await createFixture();
    const span = createSpan('span-a', '普通词');
    const prepared = await prepareProjectTranscriptReview({
      ...fixture,
      assets: [fixture.asset],
      reports: [fixture.report],
      spans: [span],
      speechCandidates: [span],
      inputsHash: 'inputs-segment-change',
      generatedAt: '2026-09-04T00:00:00.000Z',
    });
    await seedPendingReview(fixture.projectRoot, prepared.spans, 'inputs-segment-change', prepared.artifactPath);
    await writeJson(getSpansPath(fixture.projectRoot), [{
      ...span,
      transcriptSegments: [{ startMs: 1001, endMs: 2000, text: '普通词' }],
    }]);
    const item = prepared.artifact.items[0]!;
    await expect(applyProjectTranscriptAgentDecisions({
      workspaceRoot: fixture.workspaceRoot,
      projectRoot: fixture.projectRoot,
      inputsHash: 'inputs-segment-change',
      decisions: [{
        itemId: item.id,
        inputsHash: 'inputs-segment-change',
        originalTextHash: item.originalTextHash,
        startMs: item.startMs,
        endMs: item.endMs,
        action: 'keep-original',
        confidence: 1,
        containsProperNoun: false,
        evidence: [],
      }],
    })).rejects.toThrow(/changed immutable transcript segmentation/u);
  });

  it('keeps spans pending until all human items resolve and promotes glossary entries only at completion', async () => {
    const fixture = await createFixture();
    const span = IKtepSpan.parse({
      ...createSpan('span-a', '野猪掌'),
      transcript: '野猪掌 山顶站',
      transcriptSegments: [
        { startMs: 1000, endMs: 2000, text: '野猪掌' },
        { startMs: 2100, endMs: 3000, text: '山顶站' },
      ],
    });
    const prepared = await prepareProjectTranscriptReview({
      ...fixture,
      assets: [fixture.asset],
      reports: [fixture.report],
      spans: [span],
      speechCandidates: [span],
      inputsHash: 'inputs-c',
      generatedAt: '2026-09-04T00:00:00.000Z',
    });
    await seedPendingReview(fixture.projectRoot, prepared.spans, 'inputs-c', prepared.artifactPath);
    await applyProjectTranscriptAgentDecisions({
      workspaceRoot: fixture.workspaceRoot,
      projectRoot: fixture.projectRoot,
      inputsHash: 'inputs-c',
      decisions: prepared.artifact.items.map((item, index) => ({
        itemId: item.id,
        inputsHash: 'inputs-c',
        originalTextHash: item.originalTextHash,
        startMs: item.startMs,
        endMs: item.endMs,
        action: 'needs-human' as const,
        suggestedText: index === 0 ? '野猪嶂' : '山顶驿站',
        confidence: 0.7,
        containsProperNoun: true,
        evidence: [{ source: 'agent-knowledge' as const, value: '发音相近但无行程证据' }],
      })),
    });

    let queue = await loadReviewQueue(fixture.projectRoot);
    expect(queue.items.filter(item => item.status === 'open')).toHaveLength(2);
    await resolveTranscriptCorrectionReview({
      workspaceRoot: fixture.workspaceRoot,
      projectRoot: fixture.projectRoot,
      reviewId: queue.items[0]!.id,
      finalText: queue.items[0]!.suggestedValue!.suggestedText,
      promoteToGlossary: true,
    });
    expect((await loadSpansMeta(fixture.projectRoot))?.status).toBe('pending-speech-review');
    expect((await loadTranscriptGlossary(fixture.workspaceRoot)).entries).toHaveLength(0);
    expect((await loadSpans(fixture.projectRoot))[0]?.transcript).toBe('野猪掌 山顶站');

    queue = await loadReviewQueue(fixture.projectRoot);
    const remaining = queue.items.find(item => item.status === 'open')!;
    await resolveTranscriptCorrectionReview({
      workspaceRoot: fixture.workspaceRoot,
      projectRoot: fixture.projectRoot,
      reviewId: remaining.id,
      finalText: remaining.suggestedValue!.suggestedText,
      promoteToGlossary: true,
    });
    expect((await loadSpansMeta(fixture.projectRoot))?.status).toBe('fresh');
    expect((await loadSpans(fixture.projectRoot))[0]?.transcript).toBe('野猪嶂 山顶驿站');
    expect((await loadTranscriptGlossary(fixture.workspaceRoot)).entries).toHaveLength(2);
    expect((await loadTranscriptGlossary(fixture.workspaceRoot)).entries.every(entry => Boolean(entry.context))).toBe(true);
  });
});

async function createFixture() {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'kairos-transcript-review-'));
  roots.push(workspaceRoot);
  const projectId = 'trip';
  const projectRoot = join(workspaceRoot, 'projects', projectId);
  await saveProjectBriefConfig(projectRoot, {
    name: 'Trip',
    mappings: [],
    materialPatternPhrases: [],
  });
  const asset = IKtepAsset.parse({
    id: 'asset-1',
    kind: 'video',
    sourcePath: '/media/asset-1.mp4',
    displayName: 'asset-1.mp4',
    capturedAt: '2026-07-01T00:00:00.000Z',
    appliedClockOffsetMs: 86_400_000,
  });
  const report = IAssetCoarseReport.parse({
    assetId: asset.id,
    clipTypeGuess: 'talking-head',
    keepDecision: 'keep',
    densityScore: 0.8,
    labels: [],
    placeHints: [],
    rootNotes: [],
    sampleFrames: [],
    interestingWindows: [],
    fineScanWindows: [],
    fineScanReasons: [],
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
  });
  return { workspaceRoot, projectRoot, projectId, asset, report };
}

function createSpan(id: string, text: string) {
  return IKtepSpan.parse({
    id,
    assetId: 'asset-1',
    type: 'talking-head',
    semanticKind: 'speech',
    sourceInMs: 1000,
    sourceOutMs: 2000,
    transcript: text,
    transcriptSegments: [{ startMs: 1000, endMs: 2000, text }],
    visualObservation: '人物在镜头前说话',
    materialPatterns: ['固定机位口播', '山路', '晴天', '有口播语音', '情景不明', '旅行', '山景'],
    speechCoverage: 1,
  });
}

async function seedPendingReview(projectRoot: string, spans: ReturnType<typeof createSpan>[], inputsHash: string, artifactPath: string) {
  await writeJson(getSpansPath(projectRoot), spans);
  await writeSpansMeta(projectRoot, {
    schemaVersion: '1.0',
    status: 'pending-speech-review',
    generatedAt: '2026-09-04T00:00:00.000Z',
    inputsHash,
    assetCount: 1,
    reportCount: 1,
    spanCount: spans.length,
    speechReview: {
      status: 'pending',
      phase: 'agent',
      candidateCount: spans.length,
      reviewArtifactPath: artifactPath,
    },
    warnings: [],
  });
}
