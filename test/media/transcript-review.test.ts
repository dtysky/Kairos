import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
  commitProjectSpeechTranscriptReview,
  prepareProjectTranscriptReview,
  readSpeechTranscriptReviewArtifact,
  resolveTranscriptCorrectionReview,
  saveProjectSpeechTranscriptReviewDraft,
  stageProjectSpeechTranscriptReview,
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
  saveTranscriptNormalization,
  writeJson,
  writeSpansMeta,
} from '../../src/store/index.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('post-ASR transcript review', () => {
  it('applies exact text normalization before Agent review and keeps the normalized sentence reviewable', async () => {
    const fixture = await createFixture();
    await saveTranscriptNormalization(fixture.workspaceRoot, {
      schemaVersion: '1.0',
      rules: [{ from: '我操', to: '卧槽' }],
    });
    const span = createSpan('span-normalization', '我操，裡面有丁达尔现象。');
    const prepared = await prepareProjectTranscriptReview({
      ...fixture,
      assets: [fixture.asset],
      reports: [fixture.report],
      spans: [span],
      speechCandidates: [span],
      inputsHash: 'inputs-normalization',
      generatedAt: '2026-09-06T03:00:00.000Z',
    });

    expect(prepared.spans[0]?.transcript).toBe('卧槽，里面有丁达尔现象。');
    expect(prepared.autoCorrectionCount).toBe(1);
    expect(prepared.artifact.autoNormalizations[0]).toMatchObject({
      originalText: '我操，裡面有丁达尔现象。',
      finalText: '卧槽，里面有丁达尔现象。',
      ruleIds: ['简体中文正字归一', '我操→卧槽'],
    });
    expect(prepared.artifact.items[0]?.originalText).toBe('卧槽，里面有丁达尔现象。');
    expect(prepared.artifact.items[0]?.status).toBe('pending-agent');
    await seedPendingReview(fixture.projectRoot, prepared.spans, 'inputs-normalization', prepared.artifactPath);
    const item = prepared.artifact.items[0]!;
    const staged = await stageProjectSpeechTranscriptReview({
      workspaceRoot: fixture.workspaceRoot,
      projectRoot: fixture.projectRoot,
      inputsHash: 'inputs-normalization',
      transcriptDecisions: [{
        itemId: item.id,
        inputsHash: 'inputs-normalization',
        originalTextHash: item.originalTextHash,
        startMs: item.startMs,
        endMs: item.endMs,
        action: 'keep-original',
        confidence: 1,
        containsProperNoun: false,
        evidence: [],
      }],
      windowDecisions: [{
        spanId: span.id,
        inputsHash: 'inputs-normalization',
        action: 'keep',
        confidence: 1,
        reason: '句子可用',
        evidence: [],
      }],
      now: '2026-09-06T03:10:00.000Z',
    });
    expect(staged.artifact.items).toHaveLength(1);
    expect(staged.artifact.items[0]).toMatchObject({
      category: 'transcript-auto-normalized',
      selection: 'applied',
      finalText: '卧槽，里面有丁达尔现象。',
    });
    await saveTranscriptNormalization(fixture.workspaceRoot, {
      schemaVersion: '1.0',
      rules: [{ from: '我操', to: '天啊' }],
    });
    await expect(saveProjectSpeechTranscriptReviewDraft({
      workspaceRoot: fixture.workspaceRoot,
      projectRoot: fixture.projectRoot,
      inputsHash: 'inputs-normalization',
      resolutions: [],
    })).rejects.toThrow(/normalization changed during human review/u);
  });

  it('deduplicates a shared segment, uses corrected capturedAt context, and applies grounded text to every span', async () => {
    const fixture = await createFixture();
    await saveTranscriptGlossary(fixture.workspaceRoot, {
      schemaVersion: '3.0',
      entries: [{ canonical: '野猪嶂', context: '行程、路线或地点介绍时' }],
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

  it('stages one categorized report, defaults suggestions to accepted, and preserves cancelled windows as visual recall', async () => {
    const fixture = await createFixture();
    await saveTranscriptGlossary(fixture.workspaceRoot, {
      schemaVersion: '3.0',
      entries: [{ canonical: '瞬光', context: '自我介绍或者人物介绍时' }],
    });
    const spans = [
      createSpan('span-auto', '裡面有著風景'),
      IKtepSpan.parse({
        ...createSpan('span-name', '大家好我是顺光'),
        sourceInMs: 3000,
        sourceOutMs: 4000,
        transcriptSegments: [{ startMs: 3000, endMs: 4000, text: '大家好我是顺光' }],
      }),
      IKtepSpan.parse({
        ...createSpan('span-lyrics', '没有你像昨天'),
        sourceInMs: 5000,
        sourceOutMs: 6000,
        transcriptSegments: [{ startMs: 5000, endMs: 6000, text: '没有你像昨天' }],
        visualObservation: '车辆沿山路行驶',
      }),
    ];
    const prepared = await prepareProjectTranscriptReview({
      ...fixture,
      assets: [fixture.asset],
      reports: [fixture.report],
      spans,
      speechCandidates: spans,
      inputsHash: 'inputs-unified',
      generatedAt: '2026-09-06T00:00:00.000Z',
    });
    await seedPendingReview(fixture.projectRoot, prepared.spans, 'inputs-unified', prepared.artifactPath);
    const transcriptDecisions = prepared.artifact.items.map(item => ({
      itemId: item.id,
      inputsHash: 'inputs-unified',
      originalTextHash: item.originalTextHash,
      startMs: item.startMs,
      endMs: item.endMs,
      action: item.originalText === '大家好我是顺光' ? 'auto-apply' as const : 'keep-original' as const,
      suggestedText: item.originalText === '大家好我是顺光' ? '大家好我是瞬光' : item.originalText,
      finalText: item.originalText === '大家好我是顺光' ? '大家好我是瞬光' : item.originalText,
      confidence: 0.99,
      containsProperNoun: item.originalText.includes('顺光'),
      evidence: item.originalText.includes('顺光')
        ? [{ source: 'glossary' as const, value: '瞬光', ref: '自我介绍或者人物介绍时' }]
        : [],
    }));
    const staged = await stageProjectSpeechTranscriptReview({
      workspaceRoot: fixture.workspaceRoot,
      projectRoot: fixture.projectRoot,
      inputsHash: 'inputs-unified',
      transcriptDecisions,
      windowDecisions: spans.map(span => ({
        spanId: span.id,
        inputsHash: 'inputs-unified',
        action: span.id === 'span-lyrics' ? 'cancel' as const : 'keep' as const,
        confidence: 0.98,
        reason: span.id === 'span-lyrics' ? '背景歌词，不属于人物口播' : '有效人物口播',
        evidence: [],
      })),
      now: '2026-09-06T00:10:00.000Z',
    });

    expect(staged.artifact.items.map(item => item.category)).toEqual([
      'transcript-auto-normalized',
      'transcript-suggested-correction',
      'speech-window-suggested-cancel',
    ]);
    expect(staged.artifact.items.filter(item => item.category.includes('suggested')).every(item => item.selection === 'accepted')).toBe(true);
    expect((await loadSpans(fixture.projectRoot)).find(span => span.id === 'span-auto')?.transcript).toBe('里面有着风景');
    expect((await loadSpans(fixture.projectRoot)).find(span => span.id === 'span-name')?.transcript).toBe('大家好我是顺光');
    const report = await readFile(staged.reportPath, 'utf-8');
    expect(report).toContain('## 字幕｜已自动修正');
    expect(report).toContain('## 字幕｜建议修正');
    expect(report).toContain('## 口播窗口｜建议取消');
    expect(report).not.toContain('保持原文');
    expect(report).not.toContain('保持原窗口');

    const cancelReview = staged.artifact.items.find(item => item.category === 'speech-window-suggested-cancel')!;
    await saveProjectSpeechTranscriptReviewDraft({
      workspaceRoot: fixture.workspaceRoot,
      projectRoot: fixture.projectRoot,
      inputsHash: 'inputs-unified',
      resolutions: [{ itemId: cancelReview.id, selection: 'rejected' }],
      now: '2026-09-06T00:15:00.000Z',
    });
    const savedDraft = JSON.parse(await readFile(staged.artifactPath, 'utf-8'));
    expect(savedDraft.items.find((item: { id: string }) => item.id === cancelReview.id)?.selection).toBe('rejected');
    await saveProjectSpeechTranscriptReviewDraft({
      workspaceRoot: fixture.workspaceRoot,
      projectRoot: fixture.projectRoot,
      inputsHash: 'inputs-unified',
      resolutions: [{ itemId: cancelReview.id, selection: 'accepted' }],
      now: '2026-09-06T00:16:00.000Z',
    });

    await commitProjectSpeechTranscriptReview({
      workspaceRoot: fixture.workspaceRoot,
      projectRoot: fixture.projectRoot,
      inputsHash: 'inputs-unified',
      resolutions: [],
      now: '2026-09-06T00:20:00.000Z',
    });
    const committed = await loadSpans(fixture.projectRoot);
    expect(committed.some(span => span.transcript === '大家好我是瞬光')).toBe(true);
    const visualLyrics = committed.find(span => span.assetId === 'asset-1' && span.sourceInMs === 5000);
    expect(visualLyrics?.semanticKind).toBe('visual');
    expect(visualLyrics?.transcript).toBeUndefined();
    expect(visualLyrics?.visualObservation).toBe('车辆沿山路行驶');
    expect((await loadSpansMeta(fixture.projectRoot))?.status).toBe('fresh');
  });

  it('keeps the unified review pending until needs-listening rows are explicitly resolved', async () => {
    const fixture = await createFixture();
    const span = createSpan('span-listen', '野猪掌');
    const prepared = await prepareProjectTranscriptReview({
      ...fixture,
      assets: [fixture.asset],
      reports: [fixture.report],
      spans: [span],
      speechCandidates: [span],
      inputsHash: 'inputs-listen',
      generatedAt: '2026-09-06T01:00:00.000Z',
    });
    await seedPendingReview(fixture.projectRoot, prepared.spans, 'inputs-listen', prepared.artifactPath);
    const item = prepared.artifact.items[0]!;
    const staged = await stageProjectSpeechTranscriptReview({
      workspaceRoot: fixture.workspaceRoot,
      projectRoot: fixture.projectRoot,
      inputsHash: 'inputs-listen',
      transcriptDecisions: [{
        itemId: item.id,
        inputsHash: 'inputs-listen',
        originalTextHash: item.originalTextHash,
        startMs: item.startMs,
        endMs: item.endMs,
        action: 'needs-human',
        suggestedText: '野猪嶂',
        confidence: 0.6,
        containsProperNoun: true,
        evidence: [{ source: 'agent-knowledge', value: '读音相近，缺少上下文证据' }],
      }],
      windowDecisions: [{
        spanId: span.id,
        inputsHash: 'inputs-listen',
        action: 'keep',
        confidence: 0.9,
        reason: '连续人物口播',
        evidence: [],
      }],
      now: '2026-09-06T01:10:00.000Z',
    });

    await expect(commitProjectSpeechTranscriptReview({
      workspaceRoot: fixture.workspaceRoot,
      projectRoot: fixture.projectRoot,
      inputsHash: 'inputs-listen',
      resolutions: [],
    })).rejects.toThrow(/needs-listening/u);
    expect((await loadSpansMeta(fixture.projectRoot))?.status).toBe('pending-speech-review');

    await saveProjectSpeechTranscriptReviewDraft({
      workspaceRoot: fixture.workspaceRoot,
      projectRoot: fixture.projectRoot,
      inputsHash: 'inputs-listen',
      resolutions: [{ itemId: `speech-review-${item.id}`, selection: 'rejected', finalText: '野猪嶂' }],
      now: '2026-09-06T01:15:00.000Z',
    });
    const migrated = await readSpeechTranscriptReviewArtifact(staged.artifactPath);
    expect(migrated.items.find(candidate => candidate.id === `speech-review-${item.id}`)).toMatchObject({
      selection: 'accepted',
      finalText: '野猪掌',
    });

    await commitProjectSpeechTranscriptReview({
      workspaceRoot: fixture.workspaceRoot,
      projectRoot: fixture.projectRoot,
      inputsHash: 'inputs-listen',
      resolutions: [],
      now: '2026-09-06T01:20:00.000Z',
    });
    expect((await loadSpans(fixture.projectRoot))[0]?.transcript).toBe('野猪掌');
    expect((await loadSpansMeta(fixture.projectRoot))?.status).toBe('fresh');
  });

  it('keeps an uncertain speech window unchanged without creating human review work', async () => {
    const fixture = await createFixture();
    const span = createSpan('span-window-listen', '保留这段口播');
    const prepared = await prepareProjectTranscriptReview({
      ...fixture,
      assets: [fixture.asset],
      reports: [fixture.report],
      spans: [span],
      speechCandidates: [span],
      inputsHash: 'inputs-window-listen',
      generatedAt: '2026-09-06T02:00:00.000Z',
    });
    await seedPendingReview(fixture.projectRoot, prepared.spans, 'inputs-window-listen', prepared.artifactPath);
    const transcriptItem = prepared.artifact.items[0]!;
    const staged = await stageProjectSpeechTranscriptReview({
      workspaceRoot: fixture.workspaceRoot,
      projectRoot: fixture.projectRoot,
      inputsHash: 'inputs-window-listen',
      transcriptDecisions: [{
        itemId: transcriptItem.id,
        inputsHash: 'inputs-window-listen',
        originalTextHash: transcriptItem.originalTextHash,
        startMs: transcriptItem.startMs,
        endMs: transcriptItem.endMs,
        action: 'keep-original',
        confidence: 0.95,
        containsProperNoun: false,
        evidence: [],
      }],
      windowDecisions: [{
        spanId: span.id,
        inputsHash: 'inputs-window-listen',
        action: 'needs-human',
        confidence: 0.55,
        reason: '需要听音确认窗口',
        evidence: [],
      }],
      now: '2026-09-06T02:10:00.000Z',
    });
    expect(staged.artifact.items.some(item => item.category === 'speech-window-needs-listening')).toBe(false);
    const report = await readFile(staged.reportPath, 'utf-8');
    expect(report).not.toContain('口播窗口｜需人工听音');
    await writeJson(staged.artifactPath, {
      ...staged.artifact,
      items: [{
        id: 'legacy-window-listen',
        category: 'speech-window-needs-listening',
        selection: 'unresolved',
        assetId: span.assetId,
        spanIds: [span.id],
        startMs: span.sourceInMs,
        endMs: span.sourceOutMs,
        originalText: span.transcript,
        reason: '旧窗口听音项',
      }],
    });
    expect((await readSpeechTranscriptReviewArtifact(staged.artifactPath)).items).toHaveLength(0);

    await commitProjectSpeechTranscriptReview({
      workspaceRoot: fixture.workspaceRoot,
      projectRoot: fixture.projectRoot,
      inputsHash: 'inputs-window-listen',
      resolutions: [],
      now: '2026-09-06T02:20:00.000Z',
    });
    expect((await loadSpans(fixture.projectRoot))[0]?.transcript).toBe('保留这段口播');
    expect((await loadSpansMeta(fixture.projectRoot))?.status).toBe('fresh');
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
