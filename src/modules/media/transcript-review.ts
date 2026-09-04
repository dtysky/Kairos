import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import {
  ITranscriptAgentDecision,
  ITranscriptReviewArtifact,
  type IAssetCoarseReport,
  type IKtepAsset,
  type IKtepSpan,
  type IProjectPharosContext,
  type IProjectPharosShot,
  type IReviewItem,
  type ITranscriptAgentDecision as TTranscriptAgentDecision,
  type ITranscriptGlossaryConfig,
  type ITranscriptReviewArtifact as TTranscriptReviewArtifact,
  type ITranscriptReviewContextEvent,
  type ITranscriptReviewItem,
} from '../../protocol/schema.js';
import {
  computeTranscriptGlossaryHash,
  getSpansPath,
  loadManualItineraryConfig,
  loadProjectBriefConfig,
  loadProjectPharosContext,
  loadReviewQueue,
  loadSpans,
  loadSpansMeta,
  loadTranscriptGlossary,
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

const CTRANSCRIPT_REVIEW_WINDOW_MS = 2 * 60 * 60 * 1000;

export interface IPrepareTranscriptReviewResult {
  spans: IKtepSpan[];
  artifact: TTranscriptReviewArtifact;
  artifactPath: string;
  glossaryHash: string;
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
  const [brief, glossary, manualItinerary] = await Promise.all([
    loadProjectBriefConfig(input.projectRoot),
    loadTranscriptGlossary(input.workspaceRoot),
    loadManualItineraryConfig(input.projectRoot),
  ]);
  const pharosContext = await loadFreshTranscriptPharosContext({
    projectRoot: input.projectRoot,
    includedTripIds: brief.pharos?.includedTripIds ?? [],
  });
  const glossaryHash = computeTranscriptGlossaryHash(glossary);
  const tripContextHash = hashJson({
    pharosContext,
    manualItinerary: { prose: manualItinerary.prose, segments: manualItinerary.segments },
  });
  const historical = await loadHistoricalTranscriptReviewItems(input.projectRoot);
  const assetById = new Map(input.assets.map(asset => [asset.id, asset] as const));
  const reportByAssetId = new Map(input.reports.map(report => [report.assetId, report] as const));
  const itemByKey = new Map<string, ITranscriptReviewItem>();

  for (const span of input.speechCandidates) {
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
        status: history?.finalText ? 'auto-applied' : 'pending-agent',
        suggestedText: history?.finalText,
        finalText: history?.finalText,
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
        reviewedAt: history?.finalText ? input.generatedAt : undefined,
      });
    }
  }

  const items = [...itemByKey.values()]
    .map(item => ({ ...item, spanIds: [...item.spanIds].sort() }))
    .sort(compareTranscriptReviewItems);
  const spans = applyTranscriptItemTexts(input.spans, items.filter(item => item.status === 'auto-applied'));
  const artifact = ITranscriptReviewArtifact.parse({
    schemaVersion: '1.0',
    projectId: input.projectId,
    inputsHash: input.inputsHash,
    glossaryHash,
    tripContextHash,
    status: 'pending-agent',
    generatedAt: input.generatedAt,
    updatedAt: input.generatedAt,
    items,
  });
  const artifactPath = getTranscriptReviewArtifactPath(input.projectRoot, input.inputsHash);
  await writeJson(artifactPath, artifact);
  return {
    spans,
    artifact,
    artifactPath,
    glossaryHash,
    tripContextHash,
    autoCorrectionCount: items.filter(item => item.status === 'auto-applied').length,
    pendingCorrectionCount: items.filter(item => item.status === 'pending-agent').length,
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
  const glossary = await loadTranscriptGlossary(input.workspaceRoot);
  if (computeTranscriptGlossaryHash(glossary) !== artifact.glossaryHash) {
    throw new Error('transcript glossary changed during Agent review; rerun span-rebuild');
  }
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
      autoCorrectionCount: nextItems.filter(item => item.status === 'auto-applied').length,
      pendingCorrectionCount: pendingHuman.length,
      reviewArtifactPath: artifactPath,
      glossaryHash: artifact.glossaryHash,
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
  const glossary = await loadTranscriptGlossary(input.workspaceRoot);
  if (computeTranscriptGlossaryHash(glossary) !== artifact.glossaryHash) {
    throw new Error('transcript glossary changed during human review; rerun span-rebuild');
  }
  await assertTranscriptTripContextHash(input.projectRoot, artifact.tripContextHash);
  validateCompletedTranscriptItems(nextItems);
  const currentSpans = await loadSpans(input.projectRoot);
  validateSpanSegmentReferences(currentSpans, nextItems);
  const spans = applyTranscriptItemTexts(currentSpans, nextItems);
  const promotedGlossary = buildPromotedTranscriptGlossary(glossary, nextItems);
  const completedArtifact = ITranscriptReviewArtifact.parse({
    ...artifact,
    status: 'completed',
    updatedAt: now,
    items: nextItems,
  });

  await writeJson(getSpansPath(input.projectRoot), spans);
  await writeJson(review.transcriptCorrection.artifactPath, completedArtifact);
  if (promotedGlossary) await saveTranscriptGlossary(input.workspaceRoot, promotedGlossary);
  await saveReviewQueue(input.projectRoot, nextQueue);
  await writeSpansMeta(input.projectRoot, {
    ...meta,
    status: 'fresh',
    spanCount: spans.length,
    speechReview: {
      ...meta.speechReview,
      status: 'completed',
      phase: 'human',
      autoCorrectionCount: nextItems.filter(candidate => candidate.status === 'auto-applied').length,
      pendingCorrectionCount: 0,
      reviewArtifactPath: review.transcriptCorrection.artifactPath,
      glossaryHash: promotedGlossary ? computeTranscriptGlossaryHash(promotedGlossary) : artifact.glossaryHash,
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
  return normalizeTranscriptGlossary({ schemaVersion: '2.0', entries });
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
