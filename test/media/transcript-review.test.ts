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
    const legacyArtifact = JSON.parse(JSON.stringify(staged.artifact));
    legacyArtifact.schemaVersion = '1.0';
    delete legacyArtifact.duplicateGroups;
    legacyArtifact.items = [{
        id: 'legacy-window-listen',
        category: 'speech-window-needs-listening',
        selection: 'unresolved',
        assetId: span.assetId,
        spanIds: [span.id],
        startMs: span.sourceInMs,
        endMs: span.sourceOutMs,
        originalText: span.transcript,
        reason: '旧窗口听音项',
      }];
    await writeJson(staged.artifactPath, legacyArtifact);
    const migratedLegacy = await readSpeechTranscriptReviewArtifact(staged.artifactPath);
    expect(migratedLegacy.schemaVersion).toBe('1.1');
    expect(migratedLegacy.duplicateGroups).toEqual([]);
    expect(migratedLegacy.items).toHaveLength(0);

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

  it('stages cross-asset duplicate speech groups, persists the draft, and excludes unretained spans on commit', async () => {
    const fixture = await createFixture();
    const secondAsset = IKtepAsset.parse({
      ...fixture.asset,
      id: 'asset-2',
      sourcePath: '/media/asset-2.mp4',
      displayName: 'asset-2.mp4',
    });
    const secondReport = IAssetCoarseReport.parse({ ...fixture.report, assetId: secondAsset.id });
    const spans = [
      createSpan('span-intro-a', '这里是野猪嶂，我们现在开始登山。'),
      IKtepSpan.parse({
        ...createSpan('span-intro-b', '这里是野猪嶂，今天从这里开始登山。'),
        assetId: secondAsset.id,
      }),
      IKtepSpan.parse({
        ...createSpan('span-route', '前方进入盘山公路。'),
        assetId: secondAsset.id,
        sourceInMs: 3000,
        sourceOutMs: 4000,
        transcriptSegments: [{ startMs: 3000, endMs: 4000, text: '前方进入盘山公路。' }],
      }),
    ];
    const prepared = await prepareProjectTranscriptReview({
      ...fixture,
      assets: [fixture.asset, secondAsset],
      reports: [fixture.report, secondReport],
      spans,
      speechCandidates: spans,
      inputsHash: 'inputs-duplicates',
      generatedAt: '2026-10-07T00:00:00.000Z',
    });
    await seedPendingReview(fixture.projectRoot, prepared.spans, 'inputs-duplicates', prepared.artifactPath);
    const staged = await stageProjectSpeechTranscriptReview({
      workspaceRoot: fixture.workspaceRoot,
      projectRoot: fixture.projectRoot,
      inputsHash: 'inputs-duplicates',
      transcriptDecisions: prepared.artifact.items.map(item => ({
        itemId: item.id,
        inputsHash: 'inputs-duplicates',
        originalTextHash: item.originalTextHash,
        startMs: item.startMs,
        endMs: item.endMs,
        action: 'keep-original' as const,
        confidence: 0.98,
        containsProperNoun: false,
        evidence: [],
      })),
      windowDecisions: spans.map(span => ({
        spanId: span.id,
        inputsHash: 'inputs-duplicates',
        action: 'keep' as const,
        confidence: 0.98,
        reason: '有效口播',
        evidence: [],
      })),
      duplicateGroupDecisions: [{
        inputsHash: 'inputs-duplicates',
        spanIds: ['span-intro-a', 'span-intro-b'],
        recommendedSpanIds: ['span-intro-b'],
        label: '野猪嶂开场介绍',
        reason: '两段承担相同开场功能，第二段表达更完整。',
        confidence: 0.97,
      }],
      now: '2026-10-07T00:10:00.000Z',
    });
    expect(staged.artifact.schemaVersion).toBe('1.1');
    expect(staged.artifact.duplicateGroups[0]).toMatchObject({
      label: '野猪嶂开场介绍',
      selection: 'accepted',
      recommendedSpanIds: ['span-intro-b'],
      retainedSpanIds: ['span-intro-b'],
    });
    expect(staged.artifact.duplicateGroups[0]?.candidates.map(candidate => candidate.assetId)).toEqual([
      'asset-1',
      'asset-2',
    ]);
    const groupId = staged.artifact.duplicateGroups[0]!.id;
    await saveProjectSpeechTranscriptReviewDraft({
      workspaceRoot: fixture.workspaceRoot,
      projectRoot: fixture.projectRoot,
      inputsHash: 'inputs-duplicates',
      resolutions: [],
      duplicateGroupResolutions: [{
        groupId,
        selection: 'accepted',
        retainedSpanIds: ['span-intro-a'],
      }],
      now: '2026-10-07T00:15:00.000Z',
    });
    expect((await readSpeechTranscriptReviewArtifact(staged.artifactPath)).duplicateGroups[0]?.retainedSpanIds)
      .toEqual(['span-intro-a']);

    await commitProjectSpeechTranscriptReview({
      workspaceRoot: fixture.workspaceRoot,
      projectRoot: fixture.projectRoot,
      inputsHash: 'inputs-duplicates',
      resolutions: [],
      duplicateGroupResolutions: [],
      now: '2026-10-07T00:20:00.000Z',
    });
    const committed = await loadSpans(fixture.projectRoot);
    expect(committed.some(span => span.assetId === 'asset-1' && span.transcript?.includes('野猪嶂'))).toBe(true);
    expect(committed.some(span => span.assetId === 'asset-2' && span.sourceInMs === 1000)).toBe(false);
    expect(committed.some(span => span.assetId === 'asset-2' && span.sourceInMs === 3000)).toBe(true);
    expect((await loadSpansMeta(fixture.projectRoot))?.speechReview).toMatchObject({
      duplicateGroupCount: 1,
      duplicateCandidateCount: 2,
      duplicateExcludedCount: 1,
    });
    expect(await readFile(staged.reportPath, 'utf-8')).toContain('## 口播｜重复候选');
  });


  it('keeps every candidate when the human rejects a duplicate group and rejects invalid group contracts', async () => {
    const fixture = await createFixture();
    const spans = [
      createSpan('span-repeat-a', '再介绍一次这个景点。'),
      IKtepSpan.parse({
        ...createSpan('span-repeat-b', '再介绍一次这个景点。'),
        sourceInMs: 3000,
        sourceOutMs: 4000,
        transcriptSegments: [{ startMs: 3000, endMs: 4000, text: '再介绍一次这个景点。' }],
      }),
    ];
    const prepared = await prepareProjectTranscriptReview({
      ...fixture,
      assets: [fixture.asset],
      reports: [fixture.report],
      spans,
      speechCandidates: spans,
      inputsHash: 'inputs-reject-duplicates',
      generatedAt: '2026-10-07T01:00:00.000Z',
    });
    await seedPendingReview(fixture.projectRoot, prepared.spans, 'inputs-reject-duplicates', prepared.artifactPath);
    const transcriptDecisions = prepared.artifact.items.map(item => ({
      itemId: item.id,
      inputsHash: 'inputs-reject-duplicates',
      originalTextHash: item.originalTextHash,
      startMs: item.startMs,
      endMs: item.endMs,
      action: 'keep-original' as const,
      confidence: 0.98,
      containsProperNoun: false,
      evidence: [],
    }));
    const windowDecisions = spans.map(span => ({
      spanId: span.id,
      inputsHash: 'inputs-reject-duplicates',
      action: 'keep' as const,
      confidence: 0.98,
      reason: '有效口播',
      evidence: [],
    }));
    await expect(stageProjectSpeechTranscriptReview({
      workspaceRoot: fixture.workspaceRoot,
      projectRoot: fixture.projectRoot,
      inputsHash: 'inputs-reject-duplicates',
      transcriptDecisions,
      windowDecisions,
      duplicateGroupDecisions: [
        {
          inputsHash: 'inputs-reject-duplicates',
          spanIds: ['span-repeat-a', 'span-repeat-b'],
          recommendedSpanIds: ['span-repeat-a'],
          label: '第一次分组',
          reason: '重复',
          confidence: 0.9,
        },
        {
          inputsHash: 'inputs-reject-duplicates',
          spanIds: ['span-repeat-a', 'span-repeat-b'],
          recommendedSpanIds: ['span-repeat-b'],
          label: '第二次分组',
          reason: '重复',
          confidence: 0.9,
        },
      ],
    })).rejects.toThrow(/multiple duplicate groups/u);

    const staged = await stageProjectSpeechTranscriptReview({
      workspaceRoot: fixture.workspaceRoot,
      projectRoot: fixture.projectRoot,
      inputsHash: 'inputs-reject-duplicates',
      transcriptDecisions,
      windowDecisions,
      duplicateGroupDecisions: [{
        inputsHash: 'inputs-reject-duplicates',
        spanIds: ['span-repeat-a', 'span-repeat-b'],
        recommendedSpanIds: ['span-repeat-a'],
        label: '景点介绍重复',
        reason: '两段内容相同。',
        confidence: 0.95,
      }],
    });
    const groupId = staged.artifact.duplicateGroups[0]!.id;
    await expect(commitProjectSpeechTranscriptReview({
      workspaceRoot: fixture.workspaceRoot,
      projectRoot: fixture.projectRoot,
      inputsHash: 'inputs-reject-duplicates',
      duplicateGroupResolutions: [{ groupId, selection: 'accepted', retainedSpanIds: [] }],
    })).rejects.toThrow();
    expect((await loadSpansMeta(fixture.projectRoot))?.status).toBe('pending-speech-review');

    await commitProjectSpeechTranscriptReview({
      workspaceRoot: fixture.workspaceRoot,
      projectRoot: fixture.projectRoot,
      inputsHash: 'inputs-reject-duplicates',
      duplicateGroupResolutions: [{ groupId, selection: 'rejected', retainedSpanIds: [] }],
      now: '2026-10-07T01:20:00.000Z',
    });
    const committed = await loadSpans(fixture.projectRoot);
    expect(committed).toHaveLength(2);
    expect(committed.map(span => span.sourceInMs).sort((left, right) => (left ?? 0) - (right ?? 0))).toEqual([1000, 3000]);
  });

  it('keeps take choices and duplicate filtering disjoint through staging, draft, and commit', async () => {
    const fixture = await createFixture();
    const inputsHash = 'inputs-combined-speech-groups';
    const assets = Array.from({ length: 4 }, (_, index) => IKtepAsset.parse({
      ...fixture.asset,
      id: `asset-${index + 1}`,
      sourcePath: `/media/asset-${index + 1}.mp4`,
      displayName: `asset-${index + 1}.mp4`,
      capturedAt: `2026-07-01T00:00:${String(index * 10).padStart(2, '0')}.000Z`,
    }));
    const spans = assets.map((asset, index) => IKtepSpan.parse({
      ...createSpan(`speech-${index + 1}`, index < 2 ? '这里是山谷观景机位。' : '今天从山脚开始徒步。'),
      assetId: asset.id,
    }));
    await writeJson(join(fixture.projectRoot, 'store', 'assets.json'), assets);
    const prepared = await prepareProjectTranscriptReview({
      ...fixture,
      assets,
      reports: assets.map(asset => IAssetCoarseReport.parse({ ...fixture.report, assetId: asset.id })),
      spans,
      speechCandidates: spans,
      inputsHash,
      generatedAt: '2026-10-08T00:00:00.000Z',
    });
    await seedPendingReview(fixture.projectRoot, prepared.spans, inputsHash, prepared.artifactPath);
    const stageInput = {
      workspaceRoot: fixture.workspaceRoot,
      projectRoot: fixture.projectRoot,
      inputsHash,
      transcriptDecisions: keepTranscriptDecisions(prepared.artifact.items, inputsHash),
      windowDecisions: spans.map(span => ({
        spanId: span.id, inputsHash, action: 'keep' as const,
        confidence: 1, reason: '有效口播', evidence: [],
      })),
      takeDecisions: [{
        groupId: 'adjacent-takes', inputsHash, spanIds: ['speech-1', 'speech-2'],
        action: 'needs-choice' as const, confidence: 0.9,
        reason: '相邻素材同次介绍均完整', evidence: [],
      }],
      duplicateGroupDecisions: [{
        inputsHash, spanIds: ['speech-3', 'speech-4'], recommendedSpanIds: ['speech-3'],
        label: '徒步开场', reason: '两段承担相同功能', confidence: 0.95,
      }],
    };
    for (const action of ['prefer-one', 'needs-choice'] as const) {
      await expect(stageProjectSpeechTranscriptReview({
        ...stageInput,
        takeDecisions: [{
          ...stageInput.takeDecisions[0]!, action,
          preferredSpanId: action === 'prefer-one' ? 'speech-2' : undefined,
        }],
        duplicateGroupDecisions: [{
          ...stageInput.duplicateGroupDecisions[0]!,
          spanIds: ['speech-2', 'speech-3'],
        }],
      })).rejects.toThrow(/both take and duplicate groups/u);
    }
    expect(await loadSpans(fixture.projectRoot)).toEqual(prepared.spans);

    const staged = await stageProjectSpeechTranscriptReview(stageInput);
    const choice = staged.artifact.items.find(item => item.category === 'speech-take-needs-choice')!;
    const group = staged.artifact.duplicateGroups[0]!;
    const saved = await saveProjectSpeechTranscriptReviewDraft({
      workspaceRoot: fixture.workspaceRoot, projectRoot: fixture.projectRoot, inputsHash,
      resolutions: [{ itemId: choice.id, selection: 'accepted', selectedSpanId: 'speech-2' }],
      duplicateGroupResolutions: [{ groupId: group.id, selection: 'accepted', retainedSpanIds: ['speech-4'] }],
    });
    await writeJson(staged.artifactPath, {
      ...saved,
      duplicateGroups: [{ ...saved.duplicateGroups[0], candidates: [...group.candidates, choice.takeCandidates![1]] }],
    });
    const commitInput = { workspaceRoot: fixture.workspaceRoot, projectRoot: fixture.projectRoot, inputsHash };
    await expect(saveProjectSpeechTranscriptReviewDraft({ ...commitInput, resolutions: [] }))
      .rejects.toThrow(/both take and duplicate groups/u);
    await expect(commitProjectSpeechTranscriptReview(commitInput))
      .rejects.toThrow(/both take and duplicate groups/u);
    expect(await loadSpans(fixture.projectRoot)).toEqual(prepared.spans);
    expect((await loadSpansMeta(fixture.projectRoot))?.status).toBe('pending-speech-review');

    await writeJson(staged.artifactPath, saved);
    await commitProjectSpeechTranscriptReview(commitInput);
    const committed = await loadSpans(fixture.projectRoot);
    expect(committed).toHaveLength(3);
    expect(committed.find(span => span.assetId === 'asset-1')?.semanticKind).toBe('visual');
    expect(committed.find(span => span.assetId === 'asset-2')?.semanticKind).toBe('speech');
    expect(committed.some(span => span.assetId === 'asset-3')).toBe(false);
    expect(committed.find(span => span.assetId === 'asset-4')?.semanticKind).toBe('speech');
    expect((await loadSpansMeta(fixture.projectRoot))?.status).toBe('fresh');
  });

  it('stages an earlier failed start as one continuous segment-boundary trim', async () => {
    const fixture = await createFixture();
    await writeJson(join(fixture.projectRoot, 'store', 'assets.json'), [fixture.asset]);
    const span = IKtepSpan.parse({
      ...createSpan('span-restart', '这个兴坪古镇现在， 这兴坪古镇现在怎么到处都是大工地呀？ 搞不懂啊！'),
      sourceInMs: 0,
      sourceOutMs: 8000,
      transcriptSegments: [
        { startMs: 0, endMs: 1600, text: '这个兴坪古镇现在，' },
        { startMs: 2000, endMs: 5280, text: '这兴坪古镇现在怎么到处都是大工地呀？' },
        { startMs: 6640, endMs: 7680, text: '搞不懂啊！' },
      ],
    });
    const prepared = await prepareProjectTranscriptReview({
      ...fixture,
      assets: [fixture.asset],
      reports: [fixture.report],
      spans: [span],
      speechCandidates: [span],
      inputsHash: 'inputs-restart-trim',
      generatedAt: '2026-09-06T03:30:00.000Z',
    });
    await seedPendingReview(fixture.projectRoot, prepared.spans, 'inputs-restart-trim', prepared.artifactPath);
    const staged = await stageProjectSpeechTranscriptReview({
      workspaceRoot: fixture.workspaceRoot,
      projectRoot: fixture.projectRoot,
      inputsHash: 'inputs-restart-trim',
      transcriptDecisions: keepTranscriptDecisions(prepared.artifact.items, 'inputs-restart-trim'),
      windowDecisions: [{
        spanId: span.id,
        inputsHash: 'inputs-restart-trim',
        action: 'trim',
        retainStartMs: 2000,
        retainEndMs: 7680,
        confidence: 0.99,
        reason: '前一残句被后续完整重说覆盖',
        evidence: ['后续句完整包含前一残句主题'],
      }],
    });
    const trim = staged.artifact.items.find(item => item.category === 'speech-window-suggested-trim');
    expect(trim).toMatchObject({
      selection: 'accepted',
      retainStartMs: 2000,
      retainEndMs: 7680,
      suggestedText: '这兴坪古镇现在怎么到处都是大工地呀？ 搞不懂啊！',
    });
  });

  it('turns inferior adjacent takes into default cancel suggestions and names the retained take', async () => {
    const fixture = await createFixture();
    const secondAsset = IKtepAsset.parse({
      ...fixture.asset,
      id: 'asset-2',
      sourcePath: '/media/asset-2.mp4',
      displayName: 'asset-2.mp4',
      capturedAt: '2026-07-01T00:00:10.000Z',
    });
    const failedTake = IKtepSpan.parse({
      ...createSpan('take-failed', '今天这个机位，我重新说。'),
      transcriptSegments: [{ startMs: 1000, endMs: 2000, text: '今天这个机位，我重新说。' }],
    });
    const completeTake = IKtepSpan.parse({
      ...createSpan('take-complete', '今天这个机位能看见完整的山谷和日落。'),
      assetId: 'asset-2',
      transcriptSegments: [{ startMs: 1000, endMs: 2000, text: '今天这个机位能看见完整的山谷和日落。' }],
    });
    const assets = [fixture.asset, secondAsset];
    const spans = [failedTake, completeTake];
    await writeJson(join(fixture.projectRoot, 'store', 'assets.json'), assets);
    const prepared = await prepareProjectTranscriptReview({
      ...fixture,
      assets,
      reports: [fixture.report],
      spans,
      speechCandidates: spans,
      inputsHash: 'inputs-take-winner',
      generatedAt: '2026-09-06T04:00:00.000Z',
    });
    await seedPendingReview(fixture.projectRoot, prepared.spans, 'inputs-take-winner', prepared.artifactPath);
    const staged = await stageProjectSpeechTranscriptReview({
      workspaceRoot: fixture.workspaceRoot,
      projectRoot: fixture.projectRoot,
      inputsHash: 'inputs-take-winner',
      transcriptDecisions: keepTranscriptDecisions(prepared.artifact.items, 'inputs-take-winner'),
      windowDecisions: spans.map(span => ({
        spanId: span.id,
        inputsHash: 'inputs-take-winner',
        action: 'keep' as const,
        confidence: 1,
        reason: '窗口本身可用',
        evidence: [],
      })),
      takeDecisions: [{
        groupId: 'take-position-intro',
        inputsHash: 'inputs-take-winner',
        spanIds: [failedTake.id, completeTake.id],
        action: 'prefer-one',
        preferredSpanId: completeTake.id,
        confidence: 0.98,
        reason: '第二遍信息完整且没有重新起句',
        evidence: ['相邻素材表达同一机位介绍'],
      }],
    });

    const cancel = staged.artifact.items.find(item => item.category === 'speech-window-suggested-cancel')!;
    expect(cancel).toMatchObject({
      selection: 'accepted',
      spanIds: [failedTake.id],
      takeGroupId: 'take-position-intro',
      preferredSpanId: completeTake.id,
    });
    const report = await readFile(staged.reportPath, 'utf-8');
    expect(report).toContain('同组保留 asset-2.mp4');
    await commitProjectSpeechTranscriptReview({
      workspaceRoot: fixture.workspaceRoot,
      projectRoot: fixture.projectRoot,
      inputsHash: 'inputs-take-winner',
      resolutions: [],
    });
    const committed = await loadSpans(fixture.projectRoot);
    expect(committed.find(span => span.assetId === fixture.asset.id)?.semanticKind).toBe('visual');
    expect(committed.find(span => span.assetId === secondAsset.id)?.semanticKind).toBe('speech');
  });

  it('blocks on equally complete adjacent takes until one version is selected', async () => {
    const fixture = await createFixture();
    const secondAsset = IKtepAsset.parse({
      ...fixture.asset,
      id: 'asset-2',
      sourcePath: '/media/asset-2.mp4',
      displayName: 'asset-2.mp4',
      capturedAt: '2026-07-01T00:00:10.000Z',
    });
    const firstTake = createSpan('take-first', '这里能完整看到山谷和日落。');
    const secondTake = IKtepSpan.parse({
      ...createSpan('take-second', '从这个机位可以完整看到山谷和日落。'),
      assetId: 'asset-2',
      transcriptSegments: [{ startMs: 1000, endMs: 2000, text: '从这个机位可以完整看到山谷和日落。' }],
    });
    const assets = [fixture.asset, secondAsset];
    const spans = [firstTake, secondTake];
    await writeJson(join(fixture.projectRoot, 'store', 'assets.json'), assets);
    const prepared = await prepareProjectTranscriptReview({
      ...fixture,
      assets,
      reports: [fixture.report],
      spans,
      speechCandidates: spans,
      inputsHash: 'inputs-take-choice',
      generatedAt: '2026-09-06T05:00:00.000Z',
    });
    await seedPendingReview(fixture.projectRoot, prepared.spans, 'inputs-take-choice', prepared.artifactPath);
    const staged = await stageProjectSpeechTranscriptReview({
      workspaceRoot: fixture.workspaceRoot,
      projectRoot: fixture.projectRoot,
      inputsHash: 'inputs-take-choice',
      transcriptDecisions: keepTranscriptDecisions(prepared.artifact.items, 'inputs-take-choice'),
      windowDecisions: spans.map(span => ({
        spanId: span.id,
        inputsHash: 'inputs-take-choice',
        action: 'keep' as const,
        confidence: 1,
        reason: '窗口本身可用',
        evidence: [],
      })),
      takeDecisions: [{
        groupId: 'take-equal-intro',
        inputsHash: 'inputs-take-choice',
        spanIds: [firstTake.id, secondTake.id],
        action: 'needs-choice',
        confidence: 0.85,
        reason: '两遍都完整且仅表达方式不同',
        evidence: ['相邻素材表达同一机位介绍'],
      }],
    });
    const choice = staged.artifact.items.find(item => item.category === 'speech-take-needs-choice')!;
    expect(choice).toMatchObject({ selection: 'unresolved', takeGroupId: 'take-equal-intro' });
    expect(choice.takeCandidates).toHaveLength(2);
    await expect(commitProjectSpeechTranscriptReview({
      workspaceRoot: fixture.workspaceRoot,
      projectRoot: fixture.projectRoot,
      inputsHash: 'inputs-take-choice',
      resolutions: [],
    })).rejects.toThrow(/unresolved/u);

    await saveProjectSpeechTranscriptReviewDraft({
      workspaceRoot: fixture.workspaceRoot,
      projectRoot: fixture.projectRoot,
      inputsHash: 'inputs-take-choice',
      resolutions: [{ itemId: choice.id, selection: 'accepted', selectedSpanId: secondTake.id }],
    });
    const saved = await readSpeechTranscriptReviewArtifact(staged.artifactPath);
    expect(saved.items.find(item => item.id === choice.id)).toMatchObject({
      selection: 'accepted',
      selectedSpanId: secondTake.id,
    });
    await commitProjectSpeechTranscriptReview({
      workspaceRoot: fixture.workspaceRoot,
      projectRoot: fixture.projectRoot,
      inputsHash: 'inputs-take-choice',
      resolutions: [],
    });
    const committed = await loadSpans(fixture.projectRoot);
    expect(committed.find(span => span.assetId === fixture.asset.id)?.semanticKind).toBe('visual');
    expect(committed.find(span => span.assetId === secondAsset.id)?.semanticKind).toBe('speech');
  });

  it('rejects a take group that skips an intervening video asset', async () => {
    const fixture = await createFixture();
    const middleAsset = IKtepAsset.parse({
      ...fixture.asset,
      id: 'asset-middle',
      sourcePath: '/media/asset-middle.mp4',
      displayName: 'asset-middle.mp4',
      capturedAt: '2026-07-01T00:00:10.000Z',
    });
    const lastAsset = IKtepAsset.parse({
      ...fixture.asset,
      id: 'asset-last',
      sourcePath: '/media/asset-last.mp4',
      displayName: 'asset-last.mp4',
      capturedAt: '2026-07-01T00:00:20.000Z',
    });
    const firstTake = createSpan('take-first', '第一次机位介绍。');
    const lastTake = IKtepSpan.parse({
      ...createSpan('take-last', '第二次机位介绍。'),
      assetId: lastAsset.id,
      transcriptSegments: [{ startMs: 1000, endMs: 2000, text: '第二次机位介绍。' }],
    });
    const assets = [fixture.asset, middleAsset, lastAsset];
    const spans = [firstTake, lastTake];
    await writeJson(join(fixture.projectRoot, 'store', 'assets.json'), assets);
    const prepared = await prepareProjectTranscriptReview({
      ...fixture,
      assets,
      reports: [fixture.report],
      spans,
      speechCandidates: spans,
      inputsHash: 'inputs-take-nonadjacent',
      generatedAt: '2026-09-06T06:00:00.000Z',
    });
    await seedPendingReview(fixture.projectRoot, prepared.spans, 'inputs-take-nonadjacent', prepared.artifactPath);
    await expect(stageProjectSpeechTranscriptReview({
      workspaceRoot: fixture.workspaceRoot,
      projectRoot: fixture.projectRoot,
      inputsHash: 'inputs-take-nonadjacent',
      transcriptDecisions: keepTranscriptDecisions(prepared.artifact.items, 'inputs-take-nonadjacent'),
      windowDecisions: spans.map(span => ({
        spanId: span.id,
        inputsHash: 'inputs-take-nonadjacent',
        action: 'keep' as const,
        confidence: 1,
        reason: '窗口本身可用',
        evidence: [],
      })),
      takeDecisions: [{
        groupId: 'take-skips-video',
        inputsHash: 'inputs-take-nonadjacent',
        spanIds: [firstTake.id, lastTake.id],
        action: 'needs-choice',
        confidence: 0.8,
        reason: '错误地跨过一个视频素材',
        evidence: [],
      }],
    })).rejects.toThrow(/adjacent in capture-time video order/u);
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

function keepTranscriptDecisions(items: Array<{
  id: string;
  originalTextHash: string;
  startMs: number;
  endMs: number;
}>, inputsHash: string) {
  return items.map(item => ({
    itemId: item.id,
    inputsHash,
    originalTextHash: item.originalTextHash,
    startMs: item.startMs,
    endMs: item.endMs,
    action: 'keep-original' as const,
    confidence: 1,
    containsProperNoun: false,
    evidence: [],
  }));
}
