import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import {
  ITranscriptAgentDecision,
  ITranscriptReviewArtifact,
  ISpeechTranscriptReviewArtifact,
  ISpeechTranscriptReviewDraftResolution,
  ISpeechTranscriptReviewResolution,
  ISpeechWindowAgentDecision,
  type IAssetCoarseReport,
  type IKtepAsset,
  type IKtepSpan,
  type IProjectPharosContext,
  type IProjectPharosShot,
  type IReviewItem,
  type ITranscriptAgentDecision as TTranscriptAgentDecision,
  type ITranscriptAutoNormalizationItem,
  type ITranscriptGlossaryConfig,
  type ITranscriptNormalizationConfig,
  type ITranscriptReviewArtifact as TTranscriptReviewArtifact,
  type ITranscriptReviewContextEvent,
  type ITranscriptReviewItem,
  type ISpeechTranscriptReviewArtifact as TSpeechTranscriptReviewArtifact,
  type ISpeechTranscriptReviewDraftResolution as TSpeechTranscriptReviewDraftResolution,
  type ISpeechTranscriptReviewItem,
  type ISpeechTranscriptReviewResolution as TSpeechTranscriptReviewResolution,
  type ISpeechWindowAgentDecision as TSpeechWindowAgentDecision,
} from '../../protocol/schema.js';
import {
  computeTranscriptGlossaryHash,
  computeTranscriptNormalizationHash,
  getSpansPath,
  loadManualItineraryConfig,
  loadProjectBriefConfig,
  loadProjectPharosContext,
  loadReviewQueue,
  loadSpans,
  loadSpansMeta,
  loadEffectiveTranscriptGlossary,
  loadTranscriptGlossary,
  loadTranscriptNormalization,
  applyTranscriptNormalizations,
  normalizeGlossaryLookupKey,
  normalizeTranscriptGlossary,
  saveReviewQueue,
  saveTranscriptGlossary,
  writeJson,
  writeSpansMeta,
} from '../../store/index.js';
import {
  CPROJECT_PHAROS_CONTEXT_PARSER_VERSION,
  computeProjectPharosSourceFingerprint,
} from '../pharos/context.js';
import { normalizeHanTextToSimplified } from './chinese-transcript.js';
import { assignUniqueMaterialSpanIds } from './material-ids.js';
import { summarizeSpanMaterialPatternIntegrity } from '../../protocol/material-pattern-integrity.js';

const CTRANSCRIPT_REVIEW_WINDOW_MS = 2 * 60 * 60 * 1000;

export interface IPrepareTranscriptReviewResult {
  spans: IKtepSpan[];
  artifact: TTranscriptReviewArtifact;
  artifactPath: string;
  glossaryHash: string;
  normalizationHash: string;
  tripContextHash: string;
  autoCorrectionCount: number;
  pendingCorrectionCount: number;
}

export async function prepareProjectTranscriptReview(input: {
  workspaceRoot: string;
  projectId: string;
  projectRoot: string;
  assets: IKtepAsset[];
  reports: IAssetCoarseReport[];
  spans: IKtepSpan[];
  speechCandidates: IKtepSpan[];
  inputsHash: string;
  generatedAt: string;
}): Promise<IPrepareTranscriptReviewResult> {
  const [brief, glossary, normalization, manualItinerary] = await Promise.all([
    loadProjectBriefConfig(input.projectRoot),
    loadEffectiveTranscriptGlossary(input.workspaceRoot),
    loadTranscriptNormalization(input.workspaceRoot),
    loadManualItineraryConfig(input.projectRoot),
  ]);
  const pharosContext = await loadFreshTranscriptPharosContext({
    projectRoot: input.projectRoot,
    includedTripIds: brief.pharos?.includedTripIds ?? [],
  });
  const glossaryHash = computeTranscriptGlossaryHash(glossary);
  const normalizationHash = computeTranscriptNormalizationHash(normalization);
  const tripContextHash = hashJson({
    pharosContext,
    manualItinerary: { prose: manualItinerary.prose, segments: manualItinerary.segments },
  });
  const assetById = new Map(input.assets.map(asset => [asset.id, asset] as const));
  const normalized = applyConfiguredTranscriptNormalizations({
    spans: input.spans,
    speechCandidates: input.speechCandidates,
    assetById,
    normalization,
  });
  const normalizedSpanById = new Map(normalized.spans.map(span => [span.id, span] as const));
  const normalizedSpeechCandidates = input.speechCandidates
    .map(span => normalizedSpanById.get(span.id))
    .filter((span): span is IKtepSpan => Boolean(span));
  const historical = await loadHistoricalTranscriptReviewItems(input.projectRoot);
  const reportByAssetId = new Map(input.reports.map(report => [report.assetId, report] as const));
  const itemByKey = new Map<string, ITranscriptReviewItem>();

  for (const span of normalizedSpeechCandidates) {
    const segments = span.transcriptSegments?.length
      ? span.transcriptSegments.map(segment => ({ ...segment, synthetic: false }))
      : span.transcript?.trim()
        ? [{
            startMs: span.sourceInMs ?? 0,
            endMs: span.sourceOutMs ?? span.sourceInMs ?? 0,
            text: span.transcript.trim(),
            synthetic: true,
          }]
        : [];
    for (const segment of segments) {
      const originalText = segment.text.trim();
      if (!originalText) continue;
      const originalTextHash = hashText(originalText);
      const key = buildTranscriptSegmentKey(span.assetId, segment.startMs, segment.endMs, originalTextHash);
      const current = itemByKey.get(key);
      if (current) {
        if (!current.spanIds.includes(span.id)) current.spanIds.push(span.id);
        continue;
      }
      const history = historical.get(key);
      const asset = assetById.get(span.assetId);
      itemByKey.set(key, {
        id: `tr-${hashText(key).slice(0, 20)}`,
        assetId: span.assetId,
        assetDisplayName: asset?.displayName,
        assetCapturedAt: asset?.capturedAt,
        spanIds: [span.id],
        spanType: span.type,
        semanticKind: span.semanticKind,
        originalSpanTranscript: span.transcript,
        startMs: segment.startMs,
        endMs: segment.endMs,
        originalText,
        originalTextHash,
        status: 'pending-agent',
        suggestedText: history?.finalText,
        confidence: history?.finalText ? 1 : undefined,
        syntheticSegment: segment.synthetic || undefined,
        evidence: history?.finalText
          ? [{ source: 'history', value: history.finalText, ref: history.reviewedAt }]
          : [],
        contextEvents: buildTranscriptContextEvents({
          asset,
          segmentStartMs: segment.startMs,
          report: reportByAssetId.get(span.assetId),
          pharosContext,
          manualSegments: manualItinerary.segments,
        }),
      });
    }
  }

  const items = [...itemByKey.values()]
    .map(item => ({ ...item, spanIds: [...item.spanIds].sort() }))
    .sort(compareTranscriptReviewItems);
  const artifact = ITranscriptReviewArtifact.parse({
    schemaVersion: '1.0',
    projectId: input.projectId,
    inputsHash: input.inputsHash,
    glossaryHash,
    normalizationHash,
    tripContextHash,
    status: 'pending-agent',
    generatedAt: input.generatedAt,
    updatedAt: input.generatedAt,
    autoNormalizations: normalized.items,
    items,
  });
  const artifactPath = getTranscriptReviewArtifactPath(input.projectRoot, input.inputsHash);
  await writeJson(artifactPath, artifact);
  return {
    spans: normalized.spans,
    artifact,
    artifactPath,
    glossaryHash,
    normalizationHash,
    tripContextHash,
    autoCorrectionCount: normalized.items.length,
    pendingCorrectionCount: items.length,
  };
}

export async function applyProjectTranscriptAgentDecisions(input: {
  workspaceRoot: string;
  projectRoot: string;
  inputsHash: string;
  decisions: TTranscriptAgentDecision[];
  now?: string;
}): Promise<TTranscriptReviewArtifact> {
  const now = input.now ?? new Date().toISOString();
  const artifactPath = getTranscriptReviewArtifactPath(input.projectRoot, input.inputsHash);
  const artifact = await readTranscriptReviewArtifact(artifactPath);
  const meta = await loadSpansMeta(input.projectRoot);
  if (!meta || meta.inputsHash !== input.inputsHash || meta.status !== 'pending-speech-review') {
    throw new Error('transcript review inputsHash is stale; rerun span-rebuild before applying Agent decisions');
  }
  const [glossary, normalization] = await Promise.all([
    loadEffectiveTranscriptGlossary(input.workspaceRoot),
    loadTranscriptNormalization(input.workspaceRoot),
  ]);
  assertTranscriptReviewConfiguration(artifact, glossary, normalization, 'Agent');
  await assertTranscriptTripContextHash(input.projectRoot, artifact.tripContextHash);

  const parsedDecisions = z.array(ITranscriptAgentDecision).parse(input.decisions);
  const decisionById = new Map<string, TTranscriptAgentDecision>();
  const pendingItemIds = new Set(artifact.items.filter(item => item.status === 'pending-agent').map(item => item.id));
  for (const decision of parsedDecisions) {
    if (decisionById.has(decision.itemId)) throw new Error(`duplicate Agent transcript decision: ${decision.itemId}`);
    if (!pendingItemIds.has(decision.itemId)) throw new Error(`Agent transcript decision references an unknown or completed item: ${decision.itemId}`);
    decisionById.set(decision.itemId, decision);
  }
  const pendingItems = artifact.items.filter(item => item.status === 'pending-agent');
  const missing = pendingItems.filter(item => !decisionById.has(item.id));
  if (missing.length > 0) throw new Error(`Agent transcript decisions are incomplete: ${missing.length} item(s) missing`);

  const nextItems = artifact.items.map(item => {
    if (item.status !== 'pending-agent') return item;
    const decision = decisionById.get(item.id)!;
    validateAgentDecision(item, artifact, decision, glossary);
    if (decision.action === 'needs-human') {
      return {
        ...item,
        status: 'pending-human' as const,
        suggestedText: requireText(decision.suggestedText, `decision ${item.id} suggestedText`),
        confidence: decision.confidence,
        containsProperNoun: decision.containsProperNoun,
        evidence: decision.evidence,
        reviewedAt: now,
      };
    }
    const finalText = decision.action === 'keep-original'
      ? item.originalText
      : requireText(decision.finalText ?? decision.suggestedText, `decision ${item.id} finalText`);
    return {
      ...item,
      status: decision.action === 'keep-original' ? 'kept-original' as const : 'auto-applied' as const,
      suggestedText: decision.suggestedText ?? finalText,
      finalText,
      confidence: decision.confidence,
      containsProperNoun: decision.containsProperNoun,
      evidence: decision.evidence,
      reviewedAt: now,
    };
  });
  const pendingHuman = nextItems.filter(item => item.status === 'pending-human');
  const nextArtifact = ITranscriptReviewArtifact.parse({
    ...artifact,
    status: pendingHuman.length > 0 ? 'pending-human' : 'completed',
    updatedAt: now,
    items: nextItems,
  });
  const currentSpans = await loadSpans(input.projectRoot);
  validateSpanSegmentReferences(currentSpans, artifact.items);
  const spans = applyTranscriptItemTexts(
    currentSpans,
    nextItems.filter(item => item.status === 'auto-applied' || item.status === 'kept-original'),
  );
  const reviewItems = pendingHuman.map(item => buildTranscriptCorrectionReviewItem({
    projectId: artifact.projectId,
    artifactPath,
    artifact,
    item,
    now,
  }));

  await writeJson(getSpansPath(input.projectRoot), spans);
  await writeJson(artifactPath, nextArtifact);
  await replaceCurrentTranscriptReviews(input.projectRoot, input.inputsHash, reviewItems);
  await writeSpansMeta(input.projectRoot, {
    ...meta,
    status: pendingHuman.length > 0 ? 'pending-speech-review' : 'fresh',
    spanCount: spans.length,
    speechReview: {
      ...meta.speechReview,
      status: pendingHuman.length > 0 ? 'pending' : 'completed',
      phase: pendingHuman.length > 0 ? 'human' : 'agent',
      autoCorrectionCount: artifact.autoNormalizations.length
        + nextItems.filter(item => item.status === 'auto-applied').length,
      pendingCorrectionCount: pendingHuman.length,
      reviewArtifactPath: artifactPath,
      glossaryHash: artifact.glossaryHash,
      normalizationHash: artifact.normalizationHash,
      tripContextHash: artifact.tripContextHash,
      updatedAt: now,
    },
  });
  return nextArtifact;
}

export async function resolveTranscriptCorrectionReview(input: {
  workspaceRoot: string;
  projectRoot: string;
  reviewId: string;
  finalText?: string;
  promoteToGlossary?: boolean;
  note?: string;
  now?: string;
}): Promise<IReviewItem | null> {
  const now = input.now ?? new Date().toISOString();
  const queue = await loadReviewQueue(input.projectRoot);
  const reviewIndex = queue.items.findIndex(item => item.id === input.reviewId);
  if (reviewIndex < 0) return null;
  const review = queue.items[reviewIndex]!;
  if (review.kind !== 'transcript-correction' || !review.transcriptCorrection) {
    throw new Error(`review ${input.reviewId} is not a transcript correction`);
  }
  const artifact = await readTranscriptReviewArtifact(review.transcriptCorrection.artifactPath);
  const itemIndex = artifact.items.findIndex(item => item.id === review.transcriptCorrection!.itemId);
  if (itemIndex < 0) throw new Error(`transcript review item is missing: ${review.transcriptCorrection.itemId}`);
  const item = artifact.items[itemIndex]!;
  if (item.originalTextHash !== review.transcriptCorrection.originalTextHash) {
    throw new Error('transcript review original text hash no longer matches');
  }
  const finalText = requireText(input.finalText, 'finalText');
  const status = finalText === item.originalText
    ? 'kept-original' as const
    : finalText === item.suggestedText
      ? 'accepted' as const
      : 'edited' as const;
  const nextItem: ITranscriptReviewItem = {
    ...item,
    status,
    finalText,
    promoteToGlossary: input.promoteToGlossary === true,
    reviewedAt: now,
  };
  const nextItems = [...artifact.items];
  nextItems[itemIndex] = nextItem;
  const remaining = nextItems.filter(candidate => candidate.status === 'pending-human');
  const nextReview: IReviewItem = {
    ...review,
    status: 'resolved',
    fields: review.fields.map(field => field.key === 'finalText' ? { ...field, value: finalText } : field),
    note: input.note?.trim() || review.note,
    updatedAt: now,
    resolvedAt: now,
  };
  const nextQueue = {
    ...queue,
    items: queue.items.map((candidate, index) => index === reviewIndex ? nextReview : candidate),
  };

  if (remaining.length > 0) {
    await writeJson(review.transcriptCorrection.artifactPath, {
      ...artifact,
      status: 'pending-human',
      updatedAt: now,
      items: nextItems,
    });
    await saveReviewQueue(input.projectRoot, nextQueue);
    return nextReview;
  }

  const meta = await loadSpansMeta(input.projectRoot);
  if (!meta || meta.inputsHash !== artifact.inputsHash || meta.status !== 'pending-speech-review') {
    throw new Error('transcript review is stale; spans meta no longer matches the review inputsHash');
  }
  const [glossary, workspaceGlossary, normalization] = await Promise.all([
    loadEffectiveTranscriptGlossary(input.workspaceRoot),
    loadTranscriptGlossary(input.workspaceRoot),
    loadTranscriptNormalization(input.workspaceRoot),
  ]);
  assertTranscriptReviewConfiguration(artifact, glossary, normalization, 'human');
  await assertTranscriptTripContextHash(input.projectRoot, artifact.tripContextHash);
  validateCompletedTranscriptItems(nextItems);
  const currentSpans = await loadSpans(input.projectRoot);
  validateSpanSegmentReferences(currentSpans, nextItems);
  const spans = applyTranscriptItemTexts(currentSpans, nextItems);
  const promotedGlossary = buildPromotedTranscriptGlossary(workspaceGlossary, nextItems);
  const completedArtifact = ITranscriptReviewArtifact.parse({
    ...artifact,
    status: 'completed',
    updatedAt: now,
    items: nextItems,
  });

  await writeJson(getSpansPath(input.projectRoot), spans);
  await writeJson(review.transcriptCorrection.artifactPath, completedArtifact);
  if (promotedGlossary) await saveTranscriptGlossary(input.workspaceRoot, promotedGlossary);
  const finalEffectiveGlossary = promotedGlossary
    ? await loadEffectiveTranscriptGlossary(input.workspaceRoot)
    : glossary;
  await saveReviewQueue(input.projectRoot, nextQueue);
  await writeSpansMeta(input.projectRoot, {
    ...meta,
    status: 'fresh',
    spanCount: spans.length,
    speechReview: {
      ...meta.speechReview,
      status: 'completed',
      phase: 'human',
      autoCorrectionCount: artifact.autoNormalizations.length
        + nextItems.filter(candidate => candidate.status === 'auto-applied').length,
      pendingCorrectionCount: 0,
      reviewArtifactPath: review.transcriptCorrection.artifactPath,
      glossaryHash: computeTranscriptGlossaryHash(finalEffectiveGlossary),
      normalizationHash: artifact.normalizationHash,
      tripContextHash: artifact.tripContextHash,
      updatedAt: now,
    },
  });
  return nextReview;
}

export function getTranscriptReviewArtifactPath(projectRoot: string, inputsHash: string): string {
  return join(projectRoot, 'analysis', 'transcript-reviews', `${inputsHash}.json`);
}

export async function readTranscriptReviewArtifact(path: string): Promise<TTranscriptReviewArtifact> {
  return ITranscriptReviewArtifact.parse(JSON.parse(await readFile(path, 'utf-8')));
}

export interface IStageSpeechTranscriptReviewResult {
  artifact: TSpeechTranscriptReviewArtifact;
  artifactPath: string;
  reportPath: string;
  spans: IKtepSpan[];
}

export async function stageProjectSpeechTranscriptReview(input: {
  workspaceRoot: string;
  projectRoot: string;
  inputsHash: string;
  transcriptDecisions: TTranscriptAgentDecision[];
  windowDecisions: TSpeechWindowAgentDecision[];
  now?: string;
}): Promise<IStageSpeechTranscriptReviewResult> {
  const now = input.now ?? new Date().toISOString();
  const meta = await loadSpansMeta(input.projectRoot);
  if (!meta || meta.inputsHash !== input.inputsHash || meta.status !== 'pending-speech-review') {
    throw new Error('speech/transcript review inputsHash is stale; rerun span-rebuild');
  }
  const candidateArtifact = await readTranscriptReviewArtifact(
    getTranscriptReviewArtifactPath(input.projectRoot, input.inputsHash),
  );
  const [glossary, normalization] = await Promise.all([
    loadEffectiveTranscriptGlossary(input.workspaceRoot),
    loadTranscriptNormalization(input.workspaceRoot),
  ]);
  assertTranscriptReviewConfiguration(candidateArtifact, glossary, normalization, 'Agent');
  await assertTranscriptTripContextHash(input.projectRoot, candidateArtifact.tripContextHash);

  const transcriptDecisions = z.array(ITranscriptAgentDecision).parse(input.transcriptDecisions);
  const pendingTranscriptItems = candidateArtifact.items.filter(item => item.status === 'pending-agent');
  const transcriptDecisionById = new Map<string, TTranscriptAgentDecision>();
  for (const decision of transcriptDecisions) {
    if (transcriptDecisionById.has(decision.itemId)) {
      throw new Error(`duplicate Agent transcript decision: ${decision.itemId}`);
    }
    transcriptDecisionById.set(decision.itemId, decision);
  }
  const missingTranscript = pendingTranscriptItems.filter(item => !transcriptDecisionById.has(item.id));
  if (missingTranscript.length > 0) {
    throw new Error(`Agent transcript decisions are incomplete: ${missingTranscript.length} item(s) missing`);
  }

  const currentSpans = await loadSpans(input.projectRoot);
  validateSpanSegmentReferences(currentSpans, candidateArtifact.items);
  const candidateBySpanId = new Map(
    currentSpans
      .filter(span => span.semanticKind === 'speech' || span.semanticKind === 'mixed')
      .map(span => [span.id, span] as const),
  );
  const windowDecisions = z.array(ISpeechWindowAgentDecision).parse(input.windowDecisions);
  const windowDecisionBySpanId = new Map<string, TSpeechWindowAgentDecision>();
  for (const decision of windowDecisions) {
    if (decision.inputsHash !== input.inputsHash) throw new Error(`window decision ${decision.spanId} uses stale inputsHash`);
    if (!candidateBySpanId.has(decision.spanId)) {
      throw new Error(`window decision references unknown speech candidate: ${decision.spanId}`);
    }
    if (windowDecisionBySpanId.has(decision.spanId)) {
      throw new Error(`duplicate Agent window decision: ${decision.spanId}`);
    }
    windowDecisionBySpanId.set(decision.spanId, decision);
  }
  const missingWindows = [...candidateBySpanId.keys()].filter(spanId => !windowDecisionBySpanId.has(spanId));
  if (missingWindows.length > 0) {
    throw new Error(`Agent window decisions are incomplete: ${missingWindows.length} span(s) missing`);
  }

  const reviewItems: ISpeechTranscriptReviewItem[] = candidateArtifact.autoNormalizations.map(item => ({
    id: `speech-review-${item.id}`,
    category: 'transcript-auto-normalized' as const,
    selection: 'applied' as const,
    assetId: item.assetId,
    assetDisplayName: item.assetDisplayName,
    spanIds: item.spanIds,
    startMs: item.startMs,
    endMs: item.endMs,
    originalText: item.originalText,
    originalTextHash: item.originalTextHash,
    suggestedText: item.finalText,
    finalText: item.finalText,
    reason: `固定文字归一：${item.ruleIds.join('、')}`,
    evidence: item.ruleIds.map(ruleId => ({ source: 'normalization' as const, value: item.finalText, ref: ruleId })),
    contextEvents: [],
    confidence: 1,
    containsProperNoun: false,
    windowEvidence: [],
    visualSpanIds: [],
    resolvedAt: now,
  }));
  const autoTextItems: ITranscriptReviewItem[] = [];
  for (const item of pendingTranscriptItems) {
    const decision = transcriptDecisionById.get(item.id)!;
    validateAgentDecision(item, candidateArtifact, decision, glossary);
    if (decision.action === 'keep-original') continue;
    const proposedText = requireText(
      decision.finalText ?? decision.suggestedText,
      `decision ${item.id} suggestedText`,
    );
    const isSimplifiedNormalization = proposedText !== item.originalText
      && normalizeHanTextToSimplified(item.originalText) === proposedText;
    if (isSimplifiedNormalization) {
      autoTextItems.push({ ...item, status: 'auto-applied', suggestedText: proposedText, finalText: proposedText });
      reviewItems.push({
        id: `speech-review-${item.id}`,
        category: 'transcript-auto-normalized',
        selection: 'applied',
        assetId: item.assetId,
        assetDisplayName: item.assetDisplayName,
        spanIds: item.spanIds,
        startMs: item.startMs,
        endMs: item.endMs,
        originalText: item.originalText,
        originalTextHash: item.originalTextHash,
        suggestedText: proposedText,
        finalText: proposedText,
        reason: '简体中文正字归一',
        evidence: decision.evidence,
        contextEvents: item.contextEvents,
        confidence: decision.confidence,
        containsProperNoun: decision.containsProperNoun,
        windowEvidence: [],
        visualSpanIds: [],
        resolvedAt: now,
      });
      continue;
    }
    reviewItems.push({
      id: `speech-review-${item.id}`,
      category: decision.action === 'needs-human'
        ? 'transcript-needs-listening'
        : 'transcript-suggested-correction',
      selection: decision.action === 'needs-human' ? 'unresolved' : 'accepted',
      assetId: item.assetId,
      assetDisplayName: item.assetDisplayName,
      spanIds: item.spanIds,
      startMs: item.startMs,
      endMs: item.endMs,
      originalText: item.originalText,
      originalTextHash: item.originalTextHash,
      suggestedText: proposedText,
      reason: summarizeTranscriptDecisionReason(decision),
      evidence: decision.evidence,
      contextEvents: item.contextEvents,
      confidence: decision.confidence,
      containsProperNoun: decision.containsProperNoun,
      windowEvidence: [],
      visualSpanIds: [],
    });
  }

  const spansAfterNormalization = applyTranscriptItemTexts(currentSpans, autoTextItems);
  const normalizedSpanById = new Map(spansAfterNormalization.map(span => [span.id, span] as const));
  for (const decision of windowDecisions) {
    if (decision.action === 'keep' || decision.action === 'needs-human') continue;
    const span = normalizedSpanById.get(decision.spanId)!;
    const visualSpanIds = findVisualRecallSpans(spansAfterNormalization, span);
    if (decision.action === 'trim') validateWindowTrim(span, decision.retainStartMs, decision.retainEndMs);
    if (decision.action === 'cancel' && !span.visualObservation?.trim() && visualSpanIds.length === 0) {
      throw new Error(`window ${span.id} cannot be cancelled without retained visual evidence; use needs-human`);
    }
    reviewItems.push({
      id: `speech-window-review-${hashText(`${input.inputsHash}:${span.id}`).slice(0, 20)}`,
      category: decision.action === 'trim'
        ? 'speech-window-suggested-trim'
        : 'speech-window-suggested-cancel',
      selection: 'accepted',
      assetId: span.assetId,
      spanIds: [span.id],
      startMs: span.sourceInMs ?? 0,
      endMs: span.sourceOutMs ?? span.sourceInMs ?? 0,
      originalText: span.transcript,
      transcriptSegments: span.transcriptSegments,
      suggestedText: decision.action === 'trim'
        ? retainedTranscriptText(span, decision.retainStartMs, decision.retainEndMs)
        : undefined,
      retainStartMs: decision.retainStartMs,
      retainEndMs: decision.retainEndMs,
      reason: decision.reason.trim(),
      evidence: [],
      contextEvents: [],
      confidence: decision.confidence,
      containsProperNoun: false,
      windowEvidence: decision.evidence,
      visualSpanIds: visualSpanIds.length > 0 ? visualSpanIds : [span.id],
    });
  }

  const artifactPath = getSpeechTranscriptReviewArtifactPath(input.projectRoot, input.inputsHash);
  const reportPath = getSpeechTranscriptReviewReportPath(input.projectRoot, input.inputsHash);
  const artifact = ISpeechTranscriptReviewArtifact.parse({
    schemaVersion: '1.0',
    projectId: candidateArtifact.projectId,
    inputsHash: input.inputsHash,
    baselineSpansHash: hashJson(spansAfterNormalization),
    glossaryHash: candidateArtifact.glossaryHash,
    normalizationHash: candidateArtifact.normalizationHash,
    tripContextHash: candidateArtifact.tripContextHash,
    status: 'pending-human',
    generatedAt: now,
    updatedAt: now,
    reportPath,
    items: reviewItems,
  });
  await writeJson(getSpansPath(input.projectRoot), spansAfterNormalization);
  await writeJson(artifactPath, artifact);
  await writeSpeechTranscriptReviewReport(reportPath, artifact);
  await replaceCurrentTranscriptReviews(input.projectRoot, input.inputsHash, []);
  await writeSpansMeta(input.projectRoot, {
    ...meta,
    status: 'pending-speech-review',
    spanCount: spansAfterNormalization.length,
    speechReview: {
      ...meta.speechReview,
      status: 'pending',
      phase: 'human',
      autoCorrectionCount: countReviewCategory(reviewItems, 'transcript-auto-normalized'),
      pendingCorrectionCount: reviewItems.filter(item => item.selection === 'unresolved').length,
      suggestedCorrectionCount: countReviewCategory(reviewItems, 'transcript-suggested-correction'),
      suggestedTrimCount: countReviewCategory(reviewItems, 'speech-window-suggested-trim'),
      suggestedCancelCount: countReviewCategory(reviewItems, 'speech-window-suggested-cancel'),
      needsListeningCount: reviewItems.filter(item => item.category.endsWith('needs-listening')).length,
      reviewArtifactPath: artifactPath,
      reportPath,
      glossaryHash: artifact.glossaryHash,
      normalizationHash: artifact.normalizationHash,
      tripContextHash: artifact.tripContextHash,
      updatedAt: now,
    },
  });
  return { artifact, artifactPath, reportPath, spans: spansAfterNormalization };
}

export async function saveProjectSpeechTranscriptReviewDraft(input: {
  workspaceRoot: string;
  projectRoot: string;
  inputsHash: string;
  resolutions: TSpeechTranscriptReviewDraftResolution[];
  now?: string;
}): Promise<TSpeechTranscriptReviewArtifact> {
  const now = input.now ?? new Date().toISOString();
  const artifactPath = getSpeechTranscriptReviewArtifactPath(input.projectRoot, input.inputsHash);
  const artifact = await readSpeechTranscriptReviewArtifact(artifactPath);
  const meta = await loadSpansMeta(input.projectRoot);
  if (!meta || meta.inputsHash !== input.inputsHash || meta.status !== 'pending-speech-review') {
    throw new Error('speech/transcript review draft is stale; rerun span-rebuild');
  }
  if (artifact.status !== 'pending-human') throw new Error('speech/transcript review draft is not editable');
  const [glossary, normalization] = await Promise.all([
    loadEffectiveTranscriptGlossary(input.workspaceRoot),
    loadTranscriptNormalization(input.workspaceRoot),
  ]);
  assertTranscriptReviewConfiguration(artifact, glossary, normalization, 'human');
  await assertTranscriptTripContextHash(input.projectRoot, artifact.tripContextHash);
  const baselineSpans = await loadSpans(input.projectRoot);
  if (hashJson(baselineSpans) !== artifact.baselineSpansHash) {
    throw new Error('candidate spans changed during speech/transcript review');
  }

  const resolutions = z.array(ISpeechTranscriptReviewDraftResolution).parse(input.resolutions);
  const resolutionById = new Map<string, TSpeechTranscriptReviewDraftResolution>();
  for (const resolution of resolutions) {
    if (resolutionById.has(resolution.itemId)) throw new Error(`duplicate review draft resolution: ${resolution.itemId}`);
    if (!artifact.items.some(item => item.id === resolution.itemId)) {
      throw new Error(`review draft references unknown item: ${resolution.itemId}`);
    }
    resolutionById.set(resolution.itemId, resolution);
  }
  const items = artifact.items.map(item => applyDraftResolution(item, resolutionById.get(item.id)));
  const spanById = new Map(baselineSpans.map(span => [span.id, span] as const));
  const normalizedItems = items.map(item => {
    const action = item.category === 'speech-window-suggested-trim'
      ? item.selection === 'accepted' ? 'trim' : 'keep'
      : item.category === 'speech-window-needs-listening'
        ? item.resolvedWindowAction
        : undefined;
    if (action !== 'trim' || item.selection === 'unresolved') return item;
    const span = spanById.get(item.spanIds[0]!);
    if (!span) throw new Error(`review ${item.id} no longer references a speech window`);
    validateWindowTrim(span, item.retainStartMs, item.retainEndMs);
    return {
      ...item,
      suggestedText: retainedTranscriptText(span, item.retainStartMs, item.retainEndMs),
    };
  });
  const nextArtifact = ISpeechTranscriptReviewArtifact.parse({
    ...artifact,
    updatedAt: now,
    items: normalizedItems,
  });
  await writeJson(artifactPath, nextArtifact);
  await writeSpeechTranscriptReviewReport(nextArtifact.reportPath, nextArtifact);
  await writeSpansMeta(input.projectRoot, {
    ...meta,
    speechReview: {
      ...meta.speechReview,
      pendingCorrectionCount: normalizedItems.filter(item => item.selection === 'unresolved').length,
      updatedAt: now,
    },
  });
  return nextArtifact;
}

export async function commitProjectSpeechTranscriptReview(input: {
  workspaceRoot: string;
  projectRoot: string;
  inputsHash: string;
  resolutions?: TSpeechTranscriptReviewResolution[];
  now?: string;
}): Promise<TSpeechTranscriptReviewArtifact> {
  const now = input.now ?? new Date().toISOString();
  const artifactPath = getSpeechTranscriptReviewArtifactPath(input.projectRoot, input.inputsHash);
  const artifact = await readSpeechTranscriptReviewArtifact(artifactPath);
  const meta = await loadSpansMeta(input.projectRoot);
  if (!meta || meta.inputsHash !== input.inputsHash || meta.status !== 'pending-speech-review') {
    throw new Error('speech/transcript review is stale; rerun span-rebuild');
  }
  const [glossary, normalization] = await Promise.all([
    loadEffectiveTranscriptGlossary(input.workspaceRoot),
    loadTranscriptNormalization(input.workspaceRoot),
  ]);
  assertTranscriptReviewConfiguration(artifact, glossary, normalization, 'human');
  await assertTranscriptTripContextHash(input.projectRoot, artifact.tripContextHash);
  const baselineSpans = await loadSpans(input.projectRoot);
  if (hashJson(baselineSpans) !== artifact.baselineSpansHash) {
    throw new Error('candidate spans changed during speech/transcript review');
  }

  const resolutions = z.array(ISpeechTranscriptReviewResolution).parse(input.resolutions ?? []);
  const resolutionById = new Map<string, TSpeechTranscriptReviewResolution>();
  for (const resolution of resolutions) {
    if (resolutionById.has(resolution.itemId)) throw new Error(`duplicate review resolution: ${resolution.itemId}`);
    resolutionById.set(resolution.itemId, resolution);
  }
  const unknown = resolutions.filter(resolution => !artifact.items.some(item => item.id === resolution.itemId));
  if (unknown.length > 0) throw new Error(`review resolution references unknown item: ${unknown[0]!.itemId}`);

  const resolvedItems = artifact.items.map(item => resolveUnifiedReviewItem(item, resolutionById.get(item.id), now));
  const unresolved = resolvedItems.filter(item => item.selection === 'unresolved');
  if (unresolved.length > 0) {
    throw new Error(`speech/transcript review still has ${unresolved.length} needs-listening item(s)`);
  }

  let spans = baselineSpans;
  for (const item of resolvedItems) {
    if (item.selection !== 'accepted') continue;
    if (item.category === 'transcript-suggested-correction' || item.category === 'transcript-needs-listening') {
      spans = applyUnifiedTranscriptCorrection(spans, item);
      continue;
    }
    const action = item.category === 'speech-window-suggested-trim'
      ? 'trim'
      : item.category === 'speech-window-suggested-cancel'
        ? 'cancel'
        : item.resolvedWindowAction;
    if (action === 'trim') spans = applyUnifiedWindowTrim(spans, item);
    if (action === 'cancel') spans = applyUnifiedWindowCancel(spans, item);
  }
  spans = assignUniqueMaterialSpanIds(spans);
  const completedArtifact = ISpeechTranscriptReviewArtifact.parse({
    ...artifact,
    status: 'completed',
    updatedAt: now,
    items: resolvedItems,
  });
  validateFinalSpeechTranscriptReview(spans, completedArtifact);
  await writeJson(getSpansPath(input.projectRoot), spans);
  await writeJson(artifactPath, completedArtifact);
  await writeSpeechTranscriptReviewReport(artifact.reportPath, completedArtifact);
  await writeSpansMeta(input.projectRoot, {
    ...meta,
    status: 'fresh',
    spanCount: spans.length,
    speechReview: {
      ...meta.speechReview,
      status: 'completed',
      phase: 'human',
      pendingCorrectionCount: 0,
      updatedAt: now,
    },
  });
  return completedArtifact;
}

export function getSpeechTranscriptReviewArtifactPath(projectRoot: string, inputsHash: string): string {
  return join(projectRoot, 'analysis', 'speech-transcript-reviews', `${inputsHash}.json`);
}

export function getSpeechTranscriptReviewReportPath(projectRoot: string, inputsHash: string): string {
  return join(projectRoot, '.tmp', 'chronology', `speech-transcript-review-${inputsHash.slice(0, 8)}.md`);
}

export async function readSpeechTranscriptReviewArtifact(path: string): Promise<TSpeechTranscriptReviewArtifact> {
  const artifact = ISpeechTranscriptReviewArtifact.parse(JSON.parse(await readFile(path, 'utf-8')));
  return ISpeechTranscriptReviewArtifact.parse({
    ...artifact,
    items: artifact.items
      .filter(item => item.category !== 'speech-window-needs-listening')
      .map(normalizeLegacyNeedsListeningItem),
  });
}

function normalizeLegacyNeedsListeningItem(
  item: ISpeechTranscriptReviewItem,
): ISpeechTranscriptReviewItem {
  if (item.category === 'transcript-needs-listening' && item.selection === 'rejected') {
    return {
      ...item,
      selection: 'accepted',
      finalText: item.originalText ?? item.finalText ?? item.suggestedText,
    };
  }
  return item;
}

export async function loadCurrentSpeechTranscriptReview(
  projectRoot: string,
): Promise<TSpeechTranscriptReviewArtifact | null> {
  const meta = await loadSpansMeta(projectRoot);
  const path = meta?.speechReview?.reviewArtifactPath;
  if (!path || !path.includes('speech-transcript-reviews')) return null;
  try {
    return await readSpeechTranscriptReviewArtifact(path);
  } catch {
    return null;
  }
}

function applyConfiguredTranscriptNormalizations(input: {
  spans: IKtepSpan[];
  speechCandidates: IKtepSpan[];
  assetById: Map<string, IKtepAsset>;
  normalization: ITranscriptNormalizationConfig;
}): { spans: IKtepSpan[]; items: ITranscriptAutoNormalizationItem[] } {
  const normalizedTextByRange = new Map<string, string>();
  const itemByKey = new Map<string, ITranscriptAutoNormalizationItem>();
  for (const span of input.speechCandidates) {
    const segments = span.transcriptSegments?.length
      ? span.transcriptSegments
      : span.transcript?.trim()
        ? [{
            startMs: span.sourceInMs ?? 0,
            endMs: span.sourceOutMs ?? span.sourceInMs ?? 0,
            text: span.transcript.trim(),
          }]
        : [];
    for (const segment of segments) {
      const originalText = segment.text.trim();
      if (!originalText) continue;
      const simplifiedText = normalizeHanTextToSimplified(originalText);
      const exact = applyTranscriptNormalizations(simplifiedText, input.normalization);
      const finalText = exact.text;
      const ruleIds = [
        ...(simplifiedText !== originalText ? ['简体中文正字归一'] : []),
        ...exact.appliedRules,
      ];
      if (finalText === originalText) continue;
      normalizedTextByRange.set(`${span.id}:${segment.startMs}:${segment.endMs}`, finalText);
      const originalTextHash = hashText(originalText);
      const key = buildTranscriptSegmentKey(span.assetId, segment.startMs, segment.endMs, originalTextHash);
      const existing = itemByKey.get(key);
      if (existing) {
        if (!existing.spanIds.includes(span.id)) existing.spanIds.push(span.id);
        existing.ruleIds = dedupeStrings([...existing.ruleIds, ...ruleIds]);
        continue;
      }
      itemByKey.set(key, {
        id: `tn-${hashText(key).slice(0, 20)}`,
        assetId: span.assetId,
        assetDisplayName: input.assetById.get(span.assetId)?.displayName,
        spanIds: [span.id],
        startMs: segment.startMs,
        endMs: segment.endMs,
        originalText,
        originalTextHash,
        finalText,
        ruleIds,
      });
    }
  }
  const candidateIds = new Set(input.speechCandidates.map(span => span.id));
  const spans = input.spans.map(span => {
    if (!candidateIds.has(span.id)) return span;
    if (!span.transcriptSegments?.length) {
      const key = `${span.id}:${span.sourceInMs ?? 0}:${span.sourceOutMs ?? span.sourceInMs ?? 0}`;
      const transcript = normalizedTextByRange.get(key);
      return transcript && transcript !== span.transcript ? { ...span, transcript } : span;
    }
    let changed = false;
    const transcriptSegments = span.transcriptSegments.map(segment => {
      const text = normalizedTextByRange.get(`${span.id}:${segment.startMs}:${segment.endMs}`);
      if (!text || text === segment.text) return segment;
      changed = true;
      return { ...segment, text };
    });
    return changed
      ? { ...span, transcriptSegments, transcript: transcriptSegments.map(segment => segment.text).join(' ').trim() }
      : span;
  });
  const items = [...itemByKey.values()]
    .map(item => ({ ...item, spanIds: [...item.spanIds].sort(), ruleIds: dedupeStrings(item.ruleIds) }))
    .sort((left, right) => (
      left.assetId.localeCompare(right.assetId, 'en')
      || left.startMs - right.startMs
      || left.endMs - right.endMs
      || left.id.localeCompare(right.id, 'en')
    ));
  return { spans, items };
}

function assertTranscriptReviewConfiguration(
  artifact: Pick<TTranscriptReviewArtifact | TSpeechTranscriptReviewArtifact, 'glossaryHash' | 'normalizationHash'>,
  glossary: ITranscriptGlossaryConfig,
  normalization: ITranscriptNormalizationConfig,
  phase: 'Agent' | 'human',
): void {
  if (computeTranscriptGlossaryHash(glossary) !== artifact.glossaryHash) {
    throw new Error(`transcript glossary changed during ${phase} review; rerun span-rebuild`);
  }
  if (
    artifact.normalizationHash
    && computeTranscriptNormalizationHash(normalization) !== artifact.normalizationHash
  ) {
    throw new Error(`transcript normalization changed during ${phase} review; rerun span-rebuild`);
  }
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function summarizeTranscriptDecisionReason(decision: TTranscriptAgentDecision): string {
  const evidence = decision.evidence
    .map(item => `${item.source}: ${item.value}${item.ref ? ` (${item.ref})` : ''}`)
    .join('；');
  return evidence || (decision.action === 'needs-human' ? '仅凭上下文无法可靠确定文字' : 'Agent 建议修正');
}

function countReviewCategory(
  items: ISpeechTranscriptReviewItem[],
  category: ISpeechTranscriptReviewItem['category'],
): number {
  return items.filter(item => item.category === category).length;
}

function findVisualRecallSpans(spans: IKtepSpan[], speechSpan: IKtepSpan): string[] {
  const startMs = speechSpan.sourceInMs ?? 0;
  const endMs = speechSpan.sourceOutMs ?? startMs;
  return spans
    .filter(span => (
      span.id !== speechSpan.id
      && span.assetId === speechSpan.assetId
      && span.semanticKind === 'visual'
      && Boolean(span.visualObservation?.trim())
      && (span.sourceOutMs ?? span.sourceInMs ?? 0) > startMs
      && (span.sourceInMs ?? 0) < endMs
    ))
    .map(span => span.id);
}

function validateWindowTrim(span: IKtepSpan, retainStartMs?: number, retainEndMs?: number): void {
  if (retainStartMs === undefined || retainEndMs === undefined || retainEndMs <= retainStartMs) {
    throw new Error(`window ${span.id} trim requires a positive retained range`);
  }
  const sourceStartMs = span.sourceInMs ?? 0;
  const sourceEndMs = span.sourceOutMs ?? sourceStartMs;
  if (retainStartMs < sourceStartMs || retainEndMs > sourceEndMs) {
    throw new Error(`window ${span.id} trim range is outside the source window`);
  }
  const segments = span.transcriptSegments ?? [];
  if (segments.length === 0) throw new Error(`window ${span.id} trim requires transcript segment boundaries`);
  if (!segments.some(segment => segment.startMs === retainStartMs)) {
    throw new Error(`window ${span.id} trim start must match an existing transcript segment boundary`);
  }
  if (!segments.some(segment => segment.endMs === retainEndMs)) {
    throw new Error(`window ${span.id} trim end must match an existing transcript segment boundary`);
  }
  if (!segments.some(segment => segment.startMs >= retainStartMs && segment.endMs <= retainEndMs)) {
    throw new Error(`window ${span.id} trim removes every transcript segment`);
  }
}

function resolveUnifiedReviewItem(
  item: ISpeechTranscriptReviewItem,
  resolution: TSpeechTranscriptReviewResolution | undefined,
  now: string,
): ISpeechTranscriptReviewItem {
  if (item.selection === 'applied') return item;
  if (!resolution) return item;
  if (resolution.selection === 'rejected') {
    return { ...item, selection: 'rejected', resolvedWindowAction: 'keep', resolvedAt: now };
  }
  if (item.category.startsWith('transcript-')) {
    const finalText = requireText(resolution.finalText ?? item.suggestedText, `review ${item.id} finalText`);
    return { ...item, selection: 'accepted', finalText, resolvedAt: now };
  }
  const windowAction = item.category === 'speech-window-suggested-trim'
    ? 'trim'
    : item.category === 'speech-window-suggested-cancel'
      ? 'cancel'
      : resolution.windowAction;
  if (!windowAction) throw new Error(`review ${item.id} requires a windowAction`);
  if (windowAction === 'keep') {
    return { ...item, selection: 'accepted', resolvedWindowAction: 'keep', resolvedAt: now };
  }
  const next = {
    ...item,
    selection: 'accepted' as const,
    resolvedWindowAction: windowAction,
    retainStartMs: resolution.retainStartMs ?? item.retainStartMs,
    retainEndMs: resolution.retainEndMs ?? item.retainEndMs,
    resolvedAt: now,
  };
  if (windowAction === 'trim') {
    const placeholder = {
      id: item.spanIds[0]!,
      assetId: item.assetId,
      type: 'broll' as const,
      sourceInMs: item.startMs,
      sourceOutMs: item.endMs,
      transcriptSegments: [],
      materialPatterns: [],
      grounding: { speechMode: 'none' as const, speechValue: 'none' as const, spatialEvidence: [], pharosRefs: [] },
    };
    if (next.retainStartMs === undefined || next.retainEndMs === undefined) {
      throw new Error(`review ${item.id} trim requires retained bounds`);
    }
    if (next.retainStartMs < placeholder.sourceInMs || next.retainEndMs > placeholder.sourceOutMs) {
      throw new Error(`review ${item.id} trim bounds are outside the original window`);
    }
  }
  return next;
}

function applyDraftResolution(
  item: ISpeechTranscriptReviewItem,
  resolution?: TSpeechTranscriptReviewDraftResolution,
): ISpeechTranscriptReviewItem {
  if (item.selection === 'applied' || !resolution) return item;
  const needsListening = item.category.endsWith('needs-listening');
  if (resolution.selection === 'unresolved') {
    if (!needsListening) throw new Error(`suggested review ${item.id} cannot be unresolved`);
    return {
      ...item,
      selection: 'unresolved',
      finalText: resolution.finalText ?? item.finalText,
      resolvedWindowAction: item.category === 'speech-window-needs-listening'
        ? resolution.windowAction ?? item.resolvedWindowAction
        : undefined,
      retainStartMs: resolution.retainStartMs ?? item.retainStartMs,
      retainEndMs: resolution.retainEndMs ?? item.retainEndMs,
      resolvedAt: undefined,
    };
  }
  if (resolution.selection === 'rejected') {
    return {
      ...item,
      selection: 'rejected',
      finalText: resolution.finalText ?? item.finalText,
      resolvedWindowAction: item.category.startsWith('speech-window-') ? 'keep' : item.resolvedWindowAction,
      resolvedAt: undefined,
    };
  }
  if (item.category.startsWith('transcript-')) {
    return {
      ...item,
      selection: 'accepted',
      finalText: requireText(resolution.finalText ?? item.finalText ?? item.suggestedText, `review ${item.id} finalText`),
      resolvedAt: undefined,
    };
  }
  const action = item.category === 'speech-window-suggested-trim'
    ? 'trim'
    : item.category === 'speech-window-suggested-cancel'
      ? 'cancel'
      : resolution.windowAction;
  if (!action) throw new Error(`review ${item.id} requires a window action when accepted`);
  return {
    ...item,
    selection: 'accepted',
    resolvedWindowAction: action,
    retainStartMs: resolution.retainStartMs ?? item.retainStartMs,
    retainEndMs: resolution.retainEndMs ?? item.retainEndMs,
    resolvedAt: undefined,
  };
}

function applyUnifiedTranscriptCorrection(
  spans: IKtepSpan[],
  item: ISpeechTranscriptReviewItem,
): IKtepSpan[] {
  const finalText = requireText(item.finalText ?? item.suggestedText, `review ${item.id} finalText`);
  let matches = 0;
  const next = spans.map(span => {
    if (!item.spanIds.includes(span.id)) return span;
    if (!span.transcriptSegments?.length) {
      if ((span.sourceInMs ?? 0) !== item.startMs || (span.sourceOutMs ?? span.sourceInMs ?? 0) !== item.endMs) {
        throw new Error(`review ${item.id} no longer matches synthetic transcript timing`);
      }
      if (item.originalTextHash && hashText(span.transcript?.trim() ?? '') !== item.originalTextHash) {
        throw new Error(`review ${item.id} original text hash no longer matches`);
      }
      matches += 1;
      return { ...span, transcript: finalText };
    }
    let changed = false;
    const transcriptSegments = span.transcriptSegments.map(segment => {
      if (segment.startMs !== item.startMs || segment.endMs !== item.endMs) return segment;
      if (item.originalTextHash && hashText(segment.text.trim()) !== item.originalTextHash) {
        throw new Error(`review ${item.id} original text hash no longer matches`);
      }
      matches += 1;
      changed = true;
      return { ...segment, text: finalText };
    });
    return changed
      ? { ...span, transcriptSegments, transcript: transcriptSegments.map(segment => segment.text).join(' ').trim() }
      : span;
  });
  if (matches === 0) throw new Error(`review ${item.id} no longer references any transcript segment`);
  return next;
}

function applyUnifiedWindowTrim(spans: IKtepSpan[], item: ISpeechTranscriptReviewItem): IKtepSpan[] {
  let matches = 0;
  const next = spans.map(span => {
    if (!item.spanIds.includes(span.id)) return span;
    validateWindowTrim(span, item.retainStartMs, item.retainEndMs);
    const transcriptSegments = span.transcriptSegments!.filter(segment => (
      segment.startMs >= item.retainStartMs! && segment.endMs <= item.retainEndMs!
    ));
    matches += 1;
    const sourceDurationMs = Math.max(1, (span.sourceOutMs ?? item.endMs) - (span.sourceInMs ?? item.startMs));
    const speechDurationMs = transcriptSegments.reduce((sum, segment) => sum + Math.max(0, segment.endMs - segment.startMs), 0);
    return {
      ...span,
      effectiveSpeechStartMs: item.retainStartMs,
      effectiveSpeechEndMs: item.retainEndMs,
      transcriptSegments,
      transcript: transcriptSegments.map(segment => segment.text).join(' ').trim(),
      speechCoverage: Math.min(1, speechDurationMs / sourceDurationMs),
      materialPatterns: withSpeechPattern(span.materialPatterns, true),
    };
  });
  if (matches === 0) throw new Error(`review ${item.id} no longer references a speech window`);
  return next;
}

function applyUnifiedWindowCancel(spans: IKtepSpan[], item: ISpeechTranscriptReviewItem): IKtepSpan[] {
  let matches = 0;
  const next = spans.map(span => {
    if (!item.spanIds.includes(span.id)) return span;
    if (!span.visualObservation?.trim()) {
      throw new Error(`review ${item.id} cannot preserve visual recall because visualObservation is missing`);
    }
    matches += 1;
    return {
      ...span,
      semanticKind: 'visual' as const,
      transcript: undefined,
      transcriptSegments: undefined,
      speechCoverage: undefined,
      effectiveSpeechStartMs: undefined,
      effectiveSpeechEndMs: undefined,
      materialPatterns: withSpeechPattern(span.materialPatterns, false),
      grounding: {
        ...span.grounding,
        speechMode: 'none' as const,
        speechValue: 'none' as const,
      },
    };
  });
  if (matches === 0) throw new Error(`review ${item.id} no longer references a speech window`);
  return next;
}

function withSpeechPattern(patterns: string[], hasSpeech: boolean): string[] {
  const next = [...patterns];
  while (next.length < 4) next.push('');
  next[3] = hasSpeech ? '有口播语音' : '无口播语音';
  return next;
}

function validateFinalSpeechTranscriptReview(
  spans: IKtepSpan[],
  artifact: TSpeechTranscriptReviewArtifact,
): void {
  const ids = new Set<string>();
  for (const span of spans) {
    if (ids.has(span.id)) throw new Error(`speech/transcript review generated duplicate span id: ${span.id}`);
    ids.add(span.id);
  }
  const materialPatternIntegrity = summarizeSpanMaterialPatternIntegrity(spans);
  if (materialPatternIntegrity.incompleteCount > 0) {
    throw new Error(
      `speech/transcript review cannot complete because ${materialPatternIntegrity.incompleteCount} span(s) do not contain exactly ${materialPatternIntegrity.expectedCount} materialPatterns`,
    );
  }
  if (artifact.items.some(item => item.selection === 'unresolved')) {
    throw new Error('speech/transcript review cannot complete with unresolved items');
  }
  for (const item of artifact.items.filter(candidate => (
    candidate.selection === 'accepted'
    && (candidate.category === 'speech-window-suggested-cancel'
      || candidate.resolvedWindowAction === 'cancel')
  ))) {
    const retainedVisual = spans.some(span => (
      span.assetId === item.assetId
      && span.semanticKind === 'visual'
      && Boolean(span.visualObservation?.trim())
      && (span.sourceOutMs ?? span.sourceInMs ?? 0) > item.startMs
      && (span.sourceInMs ?? 0) < item.endMs
    ));
    if (!retainedVisual) throw new Error(`cancelled speech window ${item.id} lost visual recall`);
  }
}

async function writeSpeechTranscriptReviewReport(
  path: string,
  artifact: TSpeechTranscriptReviewArtifact,
): Promise<void> {
  const categories: Array<{
    category: ISpeechTranscriptReviewItem['category'];
    title: string;
    kind: 'transcript' | 'window';
  }> = [
    { category: 'transcript-auto-normalized', title: '字幕｜已自动修正', kind: 'transcript' },
    { category: 'transcript-suggested-correction', title: '字幕｜建议修正', kind: 'transcript' },
    { category: 'transcript-needs-listening', title: '字幕｜需人工听音', kind: 'transcript' },
    { category: 'speech-window-suggested-trim', title: '口播窗口｜建议裁切', kind: 'window' },
    { category: 'speech-window-suggested-cancel', title: '口播窗口｜建议取消', kind: 'window' },
  ];
  const lines = [
    '# 口播与字幕审查报告',
    '',
    `- 项目：${artifact.projectId}`,
    `- inputsHash：${artifact.inputsHash}`,
    `- 状态：${artifact.status}`,
    `- 更新时间：${artifact.updatedAt}`,
    '',
    '## 汇总',
    '',
    '| 分类 | 数量 |',
    '|---|---:|',
    ...categories.map(entry => `| ${entry.title} | ${countReviewCategory(artifact.items, entry.category)} |`),
    '',
  ];
  for (const entry of categories) {
    const items = artifact.items.filter(item => item.category === entry.category);
    if (items.length === 0) continue;
    lines.push(`## ${entry.title}`, '');
    if (entry.kind === 'transcript') {
      lines.push('| 状态 | 素材 | 段 | 时间 | 原文 | 建议文本 | 依据 |', '|---|---|---|---|---|---|---|');
      for (const item of items) {
        lines.push(`| ${reviewSelectionLabel(item)} | ${md(item.assetDisplayName ?? item.assetId)} | ${md(item.spanIds.join(', '))} | ${formatReviewRange(item.startMs, item.endMs)} | ${md(item.originalText)} | ${md(item.finalText ?? item.suggestedText)} | ${md(item.reason)} |`);
      }
    } else {
      lines.push('| 状态 | 素材 | 窗口 | 时间 | 原内容 | 建议结果 | 依据 |', '|---|---|---|---|---|---|---|');
      for (const item of items) {
        lines.push(`| ${reviewSelectionLabel(item)} | ${md(item.assetDisplayName ?? item.assetId)} | ${md(item.spanIds.join(', '))} | ${formatReviewRange(item.startMs, item.endMs)} | ${md(item.originalText)} | ${md(formatWindowSuggestion(item))} | ${md(item.reason)} |`);
      }
    }
    lines.push('');
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${lines.join('\n').trim()}\n`, 'utf-8');
}

function reviewSelectionLabel(item: ISpeechTranscriptReviewItem): string {
  if (item.selection === 'applied') return '已应用';
  if (item.category.endsWith('needs-listening') && item.selection !== 'unresolved') return '审查完成';
  if (item.selection === 'accepted') {
    if (item.resolvedAt) return '已接受';
    return item.category.endsWith('needs-listening') ? '已选择' : '默认接受';
  }
  if (item.selection === 'rejected') return '不接受';
  return '待人工听音';
}

function formatWindowSuggestion(item: ISpeechTranscriptReviewItem): string {
  if (item.category === 'speech-window-needs-listening' && item.selection === 'unresolved') {
    return '待听音确认';
  }
  const action = item.resolvedWindowAction
    ?? (item.category === 'speech-window-suggested-trim' ? 'trim' : undefined)
    ?? (item.category === 'speech-window-suggested-cancel' ? 'cancel' : undefined);
  if (action === 'trim') {
    const range = `保留 ${formatReviewRange(item.retainStartMs ?? 0, item.retainEndMs ?? 0)}`;
    return item.suggestedText?.trim() ? `${range}；裁切后：${item.suggestedText.trim()}` : range;
  }
  if (action === 'cancel') return '取消口播属性和字幕，保留视觉素材召回';
  if (action === 'keep') return item.category === 'speech-window-needs-listening' ? '不调整' : '保持原窗口';
  return '需人工听音后决定';
}

function retainedTranscriptText(span: IKtepSpan, startMs?: number, endMs?: number): string | undefined {
  if (startMs === undefined || endMs === undefined) return undefined;
  const segments = (span.transcriptSegments ?? []).filter(segment => (
    segment.startMs >= startMs && segment.endMs <= endMs
  ));
  const text = segments.map(segment => segment.text.trim()).filter(Boolean).join(' ').trim();
  return text || undefined;
}

function formatReviewRange(startMs: number, endMs: number): string {
  return `${formatReviewTime(startMs)}–${formatReviewTime(endMs)}`;
}

function formatReviewTime(value: number): string {
  const totalMs = Math.max(0, Math.round(value));
  const hours = Math.floor(totalMs / 3_600_000);
  const minutes = Math.floor((totalMs % 3_600_000) / 60_000);
  const seconds = Math.floor((totalMs % 60_000) / 1000);
  const ms = totalMs % 1000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

function md(value: string | undefined): string {
  return (value ?? '').replace(/\|/gu, '\\|').replace(/[\r\n]+/gu, '<br>');
}

function validateAgentDecision(
  item: ITranscriptReviewItem,
  artifact: TTranscriptReviewArtifact,
  decision: TTranscriptAgentDecision,
  glossary: ITranscriptGlossaryConfig,
): void {
  if (decision.inputsHash !== artifact.inputsHash) throw new Error(`decision ${item.id} uses stale inputsHash`);
  if (decision.originalTextHash !== item.originalTextHash) throw new Error(`decision ${item.id} changes original text hash`);
  if (decision.startMs !== item.startMs || decision.endMs !== item.endMs) {
    throw new Error(`decision ${item.id} changes immutable segment timing`);
  }
  const proposedText = decision.finalText ?? decision.suggestedText ?? item.originalText;
  if (decision.action === 'auto-apply' && proposedText !== item.originalText && decision.confidence < 0.9) {
    throw new Error(`decision ${item.id} is not high-confidence enough for automatic correction`);
  }
  if (decision.action === 'auto-apply' && decision.containsProperNoun) {
    const supported = decision.evidence.some(evidence => {
      if (evidence.source === 'glossary') {
        const entry = glossary.entries.find(candidate => (
          normalizeGlossaryLookupKey(candidate.canonical) === normalizeGlossaryLookupKey(evidence.value)
        ));
        return Boolean(
          entry
          && proposedText.includes(entry.canonical)
          && evidence.ref === entry.context
        );
      }
      if (['pharos', 'manual-itinerary', 'place-hint'].includes(evidence.source)) {
        return proposedText.includes(evidence.value) && item.contextEvents.some(event => event.source === evidence.source && (
          event.id === evidence.ref
          || event.title === evidence.value
          || event.location === evidence.value
          || event.note === evidence.value
        ));
      }
      return false;
    });
    if (!supported) throw new Error(`decision ${item.id} introduces an unsupported proper name; use needs-human`);
  }
}

function applyTranscriptItemTexts(spans: IKtepSpan[], items: ITranscriptReviewItem[]): IKtepSpan[] {
  const itemBySpanAndTime = new Map<string, ITranscriptReviewItem>();
  for (const item of items) {
    if (!item.finalText) continue;
    for (const spanId of item.spanIds) itemBySpanAndTime.set(`${spanId}:${item.startMs}:${item.endMs}`, item);
  }
  return spans.map(span => {
    if (!span.transcriptSegments?.length) {
      if (span.semanticKind === 'visual') return span;
      const synthetic = items.find(item => item.syntheticSegment && item.spanIds.includes(span.id));
      return synthetic?.finalText ? { ...span, transcript: synthetic.finalText } : span;
    }
    let changed = false;
    const transcriptSegments = span.transcriptSegments.map(segment => {
      const item = itemBySpanAndTime.get(`${span.id}:${segment.startMs}:${segment.endMs}`);
      if (!item?.finalText || item.finalText === segment.text) return segment;
      changed = true;
      return { ...segment, text: item.finalText };
    });
    return changed
      ? { ...span, transcriptSegments, transcript: transcriptSegments.map(segment => segment.text).join(' ').trim() }
      : span;
  });
}

function buildTranscriptCorrectionReviewItem(input: {
  projectId: string;
  artifactPath: string;
  artifact: TTranscriptReviewArtifact;
  item: ITranscriptReviewItem;
  now: string;
}): IReviewItem {
  const evidence = input.item.evidence.map(item => `${item.source}: ${item.value}`).join('\n');
  const context = input.item.contextEvents
    .map(item => [item.title, item.location, item.note].filter(Boolean).join(' · '))
    .filter(Boolean)
    .join('\n');
  return {
    id: `transcript-correction-${input.item.id}`,
    projectId: input.projectId,
    kind: 'transcript-correction',
    stage: 'chronology',
    status: 'open',
    title: `字幕校对 · ${input.item.assetId}`,
    reason: 'Agent 无法在不引入歧义的前提下自动确认此处文字。',
    sourcePath: input.artifactPath,
    currentValue: { originalText: input.item.originalText, evidence, context },
    suggestedValue: { suggestedText: input.item.suggestedText ?? input.item.originalText },
    transcriptCorrection: {
      artifactPath: input.artifactPath,
      itemId: input.item.id,
      inputsHash: input.artifact.inputsHash,
      originalTextHash: input.item.originalTextHash,
    },
    fields: [{
      key: 'finalText',
      label: '最终文本',
      value: input.item.originalText,
      suggestedValue: input.item.suggestedText,
      required: true,
    }],
    createdAt: input.now,
    updatedAt: input.now,
  };
}

async function replaceCurrentTranscriptReviews(
  projectRoot: string,
  inputsHash: string,
  items: IReviewItem[],
): Promise<void> {
  const queue = await loadReviewQueue(projectRoot);
  await saveReviewQueue(projectRoot, {
    items: [
      ...queue.items.filter(item => !(
        item.kind === 'transcript-correction'
        && item.transcriptCorrection?.inputsHash === inputsHash
      )),
      ...items,
    ],
  });
}

function validateCompletedTranscriptItems(items: ITranscriptReviewItem[]): void {
  const unresolved = items.filter(item => item.status === 'pending-agent' || item.status === 'pending-human');
  if (unresolved.length > 0) throw new Error(`transcript review still has ${unresolved.length} unresolved item(s)`);
  for (const item of items) requireText(item.finalText, `transcript review item ${item.id} finalText`);
}

function validateSpanSegmentReferences(spans: IKtepSpan[], items: ITranscriptReviewItem[]): void {
  const spanById = new Map(spans.map(span => [span.id, span] as const));
  for (const item of items) {
    if (item.syntheticSegment) continue;
    for (const spanId of item.spanIds) {
      const span = spanById.get(spanId);
      if (!span) continue;
      if (span.semanticKind === 'visual' && !span.transcriptSegments?.length) continue;
      const segment = span.transcriptSegments?.find(candidate => (
        candidate.startMs === item.startMs && candidate.endMs === item.endMs
      ));
      if (!segment) throw new Error(`span ${spanId} changed immutable transcript segmentation for review item ${item.id}`);
      const textHash = hashText(segment.text.trim());
      const allowedTexts = new Set([item.originalText, item.finalText].filter(Boolean).map(value => hashText(value!)));
      if (!allowedTexts.has(textHash)) {
        throw new Error(`span ${spanId} transcript text no longer matches review item ${item.id}`);
      }
    }
  }
}

function buildPromotedTranscriptGlossary(
  glossary: ITranscriptGlossaryConfig,
  items: ITranscriptReviewItem[],
): ITranscriptGlossaryConfig | null {
  const promoted = items.filter(item => item.promoteToGlossary && item.finalText && item.finalText !== item.originalText);
  if (promoted.length === 0) return null;
  const entries = glossary.entries.map(entry => ({ ...entry }));
  for (const item of promoted) {
    const canonical = item.finalText!.trim();
    const existing = entries.find(entry => entry.canonical === canonical);
    if (existing) continue;
    const eventContext = item.contextEvents
      .map(event => [event.title, event.location, event.note].filter(Boolean).join(' · '))
      .filter(Boolean)
      .join('；');
    entries.push({
      canonical,
      context: eventContext
        ? `本次确认所在行程语境：${eventContext}`
        : `仅在与原句“${item.originalText}”相同的完整口播语境中`,
    });
  }
  return normalizeTranscriptGlossary({ schemaVersion: '3.0', entries });
}

async function loadFreshTranscriptPharosContext(input: {
  projectRoot: string;
  includedTripIds: string[];
}): Promise<IProjectPharosContext | null> {
  const existing = await loadProjectPharosContext(input.projectRoot);
  const currentFingerprint = await computeProjectPharosSourceFingerprint(input);
  const fresh = Boolean(
    existing
    && existing.parserVersion === CPROJECT_PHAROS_CONTEXT_PARSER_VERSION
    && existing.sourceFingerprint === currentFingerprint,
  );
  if (input.includedTripIds.length > 0 && (!fresh || existing?.status !== 'success')) {
    throw new Error('项目声明了 Pharos Trip，但 analysis/pharos-context.json 缺失、失败或已过期；请先运行 Ingest 或刷新 GPS 缓存');
  }
  return fresh && existing?.status === 'success' ? existing : null;
}

async function assertTranscriptTripContextHash(projectRoot: string, expectedHash: string): Promise<void> {
  const [brief, manualItinerary] = await Promise.all([
    loadProjectBriefConfig(projectRoot),
    loadManualItineraryConfig(projectRoot),
  ]);
  const pharosContext = await loadFreshTranscriptPharosContext({
    projectRoot,
    includedTripIds: brief.pharos?.includedTripIds ?? [],
  });
  const currentHash = hashJson({
    pharosContext,
    manualItinerary: { prose: manualItinerary.prose, segments: manualItinerary.segments },
  });
  if (currentHash !== expectedHash) {
    throw new Error('trip context changed during transcript review; rerun span-rebuild');
  }
}

function buildTranscriptContextEvents(input: {
  asset?: IKtepAsset;
  segmentStartMs: number;
  report?: IAssetCoarseReport;
  pharosContext: IProjectPharosContext | null;
  manualSegments: Array<{
    id: string;
    date: string;
    startLocalTime?: string;
    endLocalTime?: string;
    location?: string;
    from?: string;
    to?: string;
    notes?: string;
  }>;
}): ITranscriptReviewContextEvent[] {
  const capturedAtMs = input.asset?.capturedAt ? Date.parse(input.asset.capturedAt) : Number.NaN;
  const candidateAtMs = Number.isFinite(capturedAtMs) ? capturedAtMs + input.segmentStartMs : Number.NaN;
  const timezone = input.pharosContext?.trips[0]?.timezone || 'UTC';
  const candidateLocal = Number.isFinite(candidateAtMs) ? formatLocalDateTimeInTimezone(candidateAtMs, timezone) : undefined;
  const candidateDate = candidateLocal?.date;
  const exactRefs = new Set((input.report?.pharosMatches ?? []).map(match => `${match.ref.tripId}:${match.ref.shotId}`));
  const events: ITranscriptReviewContextEvent[] = [];

  for (const shot of input.pharosContext?.shots ?? []) {
    const id = `${shot.ref.tripId}:${shot.ref.shotId}`;
    const shotAtMs = getPharosShotTimeMs(shot);
    const sameDay = Boolean(candidateDate && shot.date === candidateDate);
    const nearby = Number.isFinite(candidateAtMs) && Number.isFinite(shotAtMs)
      ? Math.abs(candidateAtMs - shotAtMs) <= CTRANSCRIPT_REVIEW_WINDOW_MS
      : false;
    if (!exactRefs.has(id) && !sameDay && !nearby) continue;
    events.push({
      source: 'pharos',
      id,
      title: shot.dayTitle || shot.tripTitle,
      location: shot.location || undefined,
      startAt: shot.actualTimeStart || shot.timeWindowStart || shot.plannedTimeStart,
      endAt: shot.actualTimeEnd || shot.timeWindowEnd || shot.plannedTimeEnd,
      note: shot.description || undefined,
    });
  }
  for (const segment of input.manualSegments) {
    const manualLocalMs = getManualLocalSerialMs(segment.date, segment.startLocalTime ?? segment.endLocalTime);
    const nearby = candidateLocal && Number.isFinite(manualLocalMs)
      ? Math.abs(candidateLocal.serialMs - manualLocalMs) <= CTRANSCRIPT_REVIEW_WINDOW_MS
      : false;
    if (!candidateDate || (segment.date !== candidateDate && !nearby)) continue;
    events.push({
      source: 'manual-itinerary',
      id: segment.id,
      title: [segment.from, segment.to].filter(Boolean).join(' → ') || undefined,
      location: segment.location,
      startAt: segment.startLocalTime ? `${segment.date}T${segment.startLocalTime}` : segment.date,
      endAt: segment.endLocalTime ? `${segment.date}T${segment.endLocalTime}` : undefined,
      note: segment.notes,
    });
  }
  for (const hint of input.report?.placeHints ?? []) {
    const value = hint.trim();
    if (!value) continue;
    events.push({ source: 'place-hint', id: `place:${hashText(value).slice(0, 12)}`, location: value });
  }
  return dedupeContextEvents(events);
}

async function loadHistoricalTranscriptReviewItems(projectRoot: string): Promise<Map<string, ITranscriptReviewItem>> {
  const root = join(projectRoot, 'analysis', 'transcript-reviews');
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const artifacts: TTranscriptReviewArtifact[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    try {
      const artifact = await readTranscriptReviewArtifact(join(root, entry.name));
      if (artifact.status === 'completed') artifacts.push(artifact);
    } catch {
      // Malformed history is never reused as correction truth.
    }
  }
  artifacts.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const result = new Map<string, ITranscriptReviewItem>();
  for (const artifact of artifacts) {
    for (const item of artifact.items) {
      if (!item.finalText) continue;
      const key = buildTranscriptSegmentKey(item.assetId, item.startMs, item.endMs, item.originalTextHash);
      if (!result.has(key)) result.set(key, item);
    }
  }
  return result;
}

function getPharosShotTimeMs(shot: IProjectPharosShot): number {
  for (const value of [shot.actualTimeStart, shot.timeWindowStart, shot.plannedTimeStart]) {
    const parsed = value ? Date.parse(value) : Number.NaN;
    if (Number.isFinite(parsed)) return parsed;
  }
  return Number.NaN;
}

function formatLocalDateTimeInTimezone(timestampMs: number, timezone: string): { date: string; serialMs: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(timestampMs));
  const byType = Object.fromEntries(parts.map(part => [part.type, part.value]));
  const date = `${byType.year}-${byType.month}-${byType.day}`;
  return {
    date,
    serialMs: Date.UTC(
      Number(byType.year),
      Number(byType.month) - 1,
      Number(byType.day),
      Number(byType.hour),
      Number(byType.minute),
    ),
  };
}

function getManualLocalSerialMs(date: string, time: string | undefined): number {
  if (!time) return Number.NaN;
  const dateMatch = date.match(/^(\d{4})-(\d{2})-(\d{2})$/u);
  const timeMatch = time.match(/^(\d{1,2}):(\d{2})/u);
  if (!dateMatch || !timeMatch) return Number.NaN;
  return Date.UTC(
    Number(dateMatch[1]),
    Number(dateMatch[2]) - 1,
    Number(dateMatch[3]),
    Number(timeMatch[1]),
    Number(timeMatch[2]),
  );
}

function compareTranscriptReviewItems(left: ITranscriptReviewItem, right: ITranscriptReviewItem): number {
  return left.assetId.localeCompare(right.assetId)
    || left.startMs - right.startMs
    || left.endMs - right.endMs
    || left.id.localeCompare(right.id);
}

function dedupeContextEvents(events: ITranscriptReviewContextEvent[]): ITranscriptReviewContextEvent[] {
  const seen = new Set<string>();
  return events.filter(event => {
    const key = `${event.source}:${event.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildTranscriptSegmentKey(assetId: string, startMs: number, endMs: number, originalTextHash: string): string {
  return `${assetId}:${startMs}:${endMs}:${originalTextHash}`;
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function hashJson(value: unknown): string {
  return hashText(JSON.stringify(value));
}

function requireText(value: string | undefined, label: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}
