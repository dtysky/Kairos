import { randomUUID } from 'node:crypto';
import type {
  IApprovedSegmentPlan,
  IAssetCoarseReport,
  IKtepSlice,
  ISegmentCandidateRecall,
  ISegmentPlanDraft,
  ISegmentPlanSegment,
} from '../../protocol/schema.js';
import {
  extractSegmentBrief,
  loadApprovedSegmentPlan,
  loadAssetReports,
  loadScriptBrief,
  loadSegmentCandidates,
  loadSegmentPlanDrafts,
  loadSlices,
  syncScriptBriefSegments,
  writeApprovedSegmentPlan,
  writeSegmentCandidates,
} from '../../store/index.js';

export interface IApproveSegmentPlanInput {
  projectRoot: string;
  draftId?: string;
}

export interface IRecallSegmentCandidatesInput {
  projectRoot: string;
  maxCandidatesPerSegment?: number;
}

export async function approveSegmentPlan(
  input: IApproveSegmentPlanInput,
): Promise<IApprovedSegmentPlan> {
  const drafts = await loadSegmentPlanDrafts(input.projectRoot);
  if (drafts.length === 0) {
    throw new Error('No segment plan drafts found. Run prepareSegmentPlanning() first.');
  }

  const draft = pickDraft(drafts, input.draftId);
  const approved: IApprovedSegmentPlan = {
    id: randomUUID(),
    projectId: draft.projectId,
    approvedAt: new Date().toISOString(),
    sourceDraftId: draft.id,
    reviewBrief: draft.reviewBrief,
    segments: draft.segments,
    notes: draft.notes,
  };
  await writeApprovedSegmentPlan(input.projectRoot, approved);
  await syncScriptBriefSegments(input.projectRoot, approved.segments);
  return approved;
}

export async function recallSegmentCandidates(
  input: IRecallSegmentCandidatesInput,
): Promise<ISegmentCandidateRecall> {
  const [approvedPlan, slices, reports, scriptBrief] = await Promise.all([
    ensureApprovedPlan(input.projectRoot),
    loadSlices(input.projectRoot),
    loadAssetReports(input.projectRoot),
    loadScriptBrief(input.projectRoot),
  ]);
  const reportMap = new Map(reports.map(report => [report.assetId, report]));
  const maxCandidates = input.maxCandidatesPerSegment ?? 8;

  const segmentResults = approvedPlan.segments.map(segment => {
    const segmentBrief = extractSegmentBrief(scriptBrief, segment.id);
    const candidates = rankCandidatesForSegment(segment, segmentBrief, slices, reportMap)
      .slice(0, maxCandidates);
    return {
      segmentId: segment.id,
      title: segment.title,
      candidates,
    };
  });

  const recall: ISegmentCandidateRecall = {
    id: randomUUID(),
    projectId: approvedPlan.projectId,
    approvedPlanId: approvedPlan.id,
    generatedAt: new Date().toISOString(),
    segments: segmentResults,
  };
  await writeSegmentCandidates(input.projectRoot, recall);
  return recall;
}

function rankCandidatesForSegment(
  segment: ISegmentPlanSegment,
  segmentBrief: string | undefined,
  slices: IKtepSlice[],
  reportMap: Map<string, IAssetCoarseReport>,
) {
  return slices.map(slice => {
    const report = reportMap.get(slice.assetId);
    const semanticLabels = dedupeStrings([
      ...slice.narrativeFunctions.core,
      ...slice.shotGrammar.core,
      ...slice.viewpointRoles.core,
      ...slice.subjectStates.core,
      ...slice.narrativeFunctions.extra,
    ]);
    const placeHints = dedupeStrings([
      ...slice.grounding.spatialEvidence
        .map(item => item.locationText?.trim())
        .filter((value): value is string => Boolean(value)),
      ...(report?.placeHints ?? []),
    ]);
    const summary = buildSliceSummary(slice);
    const reasons: string[] = [];
    let score = 0;

    if (segment.preferredClipTypes.includes(mapSliceTypeToClipType(slice.type))) {
      score += 3;
      reasons.push(`clip-type:${slice.type}`);
    }

    const labelOverlap = overlapScore(semanticLabels, segment.preferredLabels);
    if (labelOverlap > 0) {
      score += labelOverlap * 2.2;
      reasons.push(`semantics:${labelOverlap}`);
    }

    const placeOverlap = overlapScore(placeHints, segment.preferredPlaceHints);
    if (placeOverlap > 0) {
      score += placeOverlap * 2.5;
      reasons.push(`places:${placeOverlap}`);
    }

    const intentTokens = tokenize(segment.intent);
    const summaryOverlap = overlapScore(tokenize(summary), intentTokens);
    if (summaryOverlap > 0) {
      score += summaryOverlap * 1.8;
      reasons.push(`intent:${summaryOverlap}`);
    }

    if (slice.transcript && intentTokens.length > 0) {
      const transcriptOverlap = overlapScore(tokenize(slice.transcript), intentTokens);
      if (transcriptOverlap > 0) {
        score += transcriptOverlap * 2.3;
        reasons.push(`transcript:${transcriptOverlap}`);
      }
    }

    if (segmentBrief) {
      const briefOverlap = overlapScore(
        [
          ...semanticLabels,
          ...placeHints,
          ...tokenize(summary),
          ...tokenize(slice.transcript ?? ''),
        ],
        tokenize(segmentBrief),
      );
      if (briefOverlap > 0) {
        score += briefOverlap;
        reasons.push(`brief:${briefOverlap}`);
      }
    }

    if ((slice.pharosRefs?.length ?? 0) > 0) {
      score += 0.8;
      reasons.push(`pharos:linked-${slice.pharosRefs?.length ?? 0}`);
    }

    if (report?.pharosMatches.length) {
      const pharosTokens = report.pharosMatches.flatMap(match => [
        ...tokenize(match.tripTitle ?? ''),
        ...tokenize(match.dayTitle ?? ''),
      ]);
      const pharosOverlap = overlapScore(
        pharosTokens,
        dedupeStrings([
          ...segment.preferredPlaceHints,
          ...tokenize(segment.intent),
          ...tokenize(segment.title),
        ]),
      );
      if (pharosOverlap > 0) {
        score += pharosOverlap * 1.6;
        reasons.push(`pharos-context:${pharosOverlap}`);
      }
    }

    if (segment.role === 'intro' && (slice.editSourceInMs ?? slice.sourceInMs ?? 0) <= 60_000) {
      score += 0.75;
      reasons.push('role:intro-early-window');
    }

    if (slice.speedCandidate) {
      score += slice.type === 'drive' || slice.type === 'aerial' ? 0.6 : 0.2;
      reasons.push(`speed-candidate:${slice.speedCandidate.suggestedSpeeds.join('/')}`);
    }

    score += averageConfidence(slice);

    return {
      segmentId: segment.id,
      sliceId: slice.id,
      assetId: slice.assetId,
      score,
      reasons: reasons.length > 0 ? reasons : ['fallback:semantic-low-signal'],
      semanticKind: slice.semanticKind,
      summary,
      transcript: slice.transcript,
      labels: semanticLabels,
      placeHints,
      pharosRefs: slice.pharosRefs,
      sourceInMs: slice.sourceInMs,
      sourceOutMs: slice.sourceOutMs,
      editSourceInMs: slice.editSourceInMs,
      editSourceOutMs: slice.editSourceOutMs,
      speedCandidate: slice.speedCandidate,
    };
  }).sort((a, b) =>
    b.score - a.score
    || (a.editSourceInMs ?? a.sourceInMs ?? 0) - (b.editSourceInMs ?? b.sourceInMs ?? 0)
    || a.sliceId.localeCompare(b.sliceId),
  );
}

function averageConfidence(slice: IKtepSlice): number {
  const confidenceValues = [
    ...slice.narrativeFunctions.evidence.map(item => item.confidence),
    ...slice.shotGrammar.evidence.map(item => item.confidence),
    ...slice.viewpointRoles.evidence.map(item => item.confidence),
    ...slice.subjectStates.evidence.map(item => item.confidence),
    ...slice.grounding.spatialEvidence.map(item => item.confidence),
  ].filter(value => Number.isFinite(value));
  if (confidenceValues.length === 0) return 0.5;
  return confidenceValues.reduce((sum, value) => sum + value, 0) / confidenceValues.length;
}

function buildSliceSummary(slice: IKtepSlice): string {
  return [
    slice.narrativeFunctions.core[0],
    slice.shotGrammar.core[0],
    slice.viewpointRoles.core[0],
    slice.grounding.spatialEvidence[0]?.locationText,
    slice.transcript?.trim(),
  ].filter(Boolean).join(' / ') || slice.type;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fa5]+/u)
    .map(token => token.trim())
    .filter(token => token.length >= 2);
}

function overlapScore(source: string[], target: string[]): number {
  if (source.length === 0 || target.length === 0) return 0;
  const targetSet = new Set(target.map(item => item.trim().toLowerCase()).filter(Boolean));
  let count = 0;
  for (const item of source) {
    const normalized = item.trim().toLowerCase();
    if (!normalized) continue;
    if (targetSet.has(normalized)) count++;
  }
  return count;
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))];
}

function mapSliceTypeToClipType(type: IKtepSlice['type']): ISegmentPlanSegment['preferredClipTypes'][number] {
  if (type === 'shot' || type === 'photo') return 'unknown';
  return type;
}

async function ensureApprovedPlan(projectRoot: string): Promise<IApprovedSegmentPlan> {
  const existing = await loadApprovedSegmentPlan(projectRoot);
  if (existing) return existing;
  return approveSegmentPlan({ projectRoot });
}

function pickDraft(drafts: ISegmentPlanDraft[], draftId?: string): ISegmentPlanDraft {
  if (!draftId) return drafts[0];
  const draft = drafts.find(item => item.id === draftId);
  if (!draft) {
    throw new Error(`Segment plan draft not found: ${draftId}`);
  }
  return draft;
}

export async function loadExistingOrRecallSegmentCandidates(
  input: IRecallSegmentCandidatesInput,
): Promise<ISegmentCandidateRecall> {
  const existing = await loadSegmentCandidates(input.projectRoot);
  if (existing) return existing;
  return recallSegmentCandidates(input);
}
