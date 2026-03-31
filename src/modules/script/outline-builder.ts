import type {
  IApprovedSegmentPlan,
  IKtepScriptSelection,
  IKtepSlice,
  ISegmentCandidateRecall,
} from '../../protocol/schema.js';

export interface IOutlineSliceContext {
  sliceId: string;
  assetId: string;
  summary?: string;
  transcript?: string;
  labels: string[];
  placeHints: string[];
  sourceInMs?: number;
  sourceOutMs?: number;
}

export interface IOutlineBeat {
  id: string;
  title: string;
  assetId: string;
  sliceId?: string;
  selection: IKtepScriptSelection;
  summary?: string;
  transcript?: string;
  labels: string[];
  placeHints: string[];
  sourceInMs?: number;
  sourceOutMs?: number;
  estimatedDurationMs: number;
}

export interface IOutlineSegmentContext {
  assetId: string;
  sliceContexts: IOutlineSliceContext[];
  summary: string;
  startMs?: number;
  endMs?: number;
}

export interface IOutlineSegment {
  role: 'intro' | 'scene' | 'transition' | 'highlight' | 'outro';
  title: string;
  assetId: string;
  sliceIds: string[];
  selections: IKtepScriptSelection[];
  beats: IOutlineBeat[];
  context: IOutlineSegmentContext;
  estimatedDurationMs: number;
}

/**
 * 从切片列表构建叙事骨架。
 * 当前实现优先按素材分段：
 *   - 同一 asset 下的切片优先归为同一个段落
 *   - 只有存在多个 asset 时，才按位置推导 intro/outro
 *   - 每个段落下再保留若干可选切片，供脚本阶段选择
 */
export function buildOutline(
  slices: IKtepSlice[],
  targetDurationMs: number,
): IOutlineSegment[] {
  if (slices.length === 0) return [];

  const sorted = [...slices].sort((a, b) =>
    (a.sourceInMs ?? 0) - (b.sourceInMs ?? 0)
    || a.assetId.localeCompare(b.assetId)
    || a.id.localeCompare(b.id),
  );

  const groups = groupByAsset(sorted);
  const groupDurations = groups.map(group => estimateGroupDuration(group));
  const totalDuration = groupDurations.reduce((sum, duration) => sum + duration, 0);

  return groups.map((group, index) => {
    const role = pickSegmentRole(groups.length, index, group);
    const estimatedDurationMs = totalDuration > 0
      ? Math.round(targetDurationMs * (groupDurations[index] / totalDuration))
      : Math.round(targetDurationMs / groups.length);
    const beats = buildSegmentBeats(group, estimatedDurationMs);
    const context = buildSegmentContext(group);

    return {
      role,
      title: buildSegmentTitle(role, index),
      assetId: group[0].assetId,
      sliceIds: group.map(slice => slice.id),
      selections: beats.map(beat => beat.selection),
      beats,
      context,
      estimatedDurationMs,
    };
  });
}

export function buildOutlineFromApprovedPlan(
  approvedPlan: IApprovedSegmentPlan,
  recall: ISegmentCandidateRecall,
): IOutlineSegment[] {
  const totalTargetDuration = approvedPlan.segments.reduce(
    (sum, segment) => sum + (segment.targetDurationMs ?? 0),
    0,
  );
  const usedSliceIds = new Set<string>();

  return approvedPlan.segments.map((segment, index) => {
    const recalled = recall.segments.find(item => item.segmentId === segment.id);
    const sliceContexts: IOutlineSliceContext[] = (recalled?.candidates ?? []).map(candidate => ({
      sliceId: candidate.sliceId,
      assetId: candidate.assetId,
      summary: candidate.summary,
      transcript: candidate.transcript,
      labels: takeUnique(candidate.labels, 4),
      placeHints: takeUnique(candidate.placeHints, 3),
      sourceInMs: candidate.sourceInMs,
      sourceOutMs: candidate.sourceOutMs,
    }));

    const beats = buildPlannedBeatsForSegment(segment, sliceContexts, usedSliceIds);
    for (const beat of beats) {
      if (beat.sliceId) usedSliceIds.add(beat.sliceId);
    }

    const summary = (beats.length > 0 ? beats : sliceContexts)
      .map(candidate => candidate.summary?.trim() || candidate.transcript?.trim())
      .filter((value): value is string => Boolean(value))
      .slice(0, 3)
      .join(' / ') || segment.intent;

    const estimatedDurationMs = segment.targetDurationMs
      ?? (totalTargetDuration > 0 ? Math.round(totalTargetDuration / Math.max(approvedPlan.segments.length, 1)) : 10000);

    return {
      role: segment.role,
      title: segment.title,
      assetId: beats[0]?.assetId ?? '',
      sliceIds: beats.length > 0
        ? beats
          .map(beat => beat.sliceId)
          .filter((sliceId): sliceId is string => typeof sliceId === 'string' && sliceId.length > 0)
        : sliceContexts.map(candidate => candidate.sliceId),
      selections: beats.map(beat => beat.selection),
      beats,
      context: {
        assetId: beats[0]?.assetId ?? '',
        sliceContexts,
        summary,
        startMs: pickMinNumber(sliceContexts.map(candidate => candidate.sourceInMs)),
        endMs: pickMaxNumber(sliceContexts.map(candidate => candidate.sourceOutMs)),
      },
      estimatedDurationMs,
    };
  });
}

function buildPlannedBeatsForSegment(
  segment: IApprovedSegmentPlan['segments'][number],
  sliceContexts: IOutlineSliceContext[],
  usedSliceIds: Set<string>,
): IOutlineBeat[] {
  if (sliceContexts.length === 0) return [];

  const beatCount = determineBeatCount(segment.role, segment.targetDurationMs, sliceContexts.length);
  const selected = selectSegmentBeatCandidates(segment, sliceContexts, usedSliceIds, beatCount);

  return selected.map((candidate, beatIndex) => {
    const selection: IKtepScriptSelection = {
      assetId: candidate.assetId,
      sliceId: candidate.sliceId,
      sourceInMs: candidate.sourceInMs,
      sourceOutMs: candidate.sourceOutMs,
    };
    const beatDuration = estimateBeatDuration(
      selection.sourceInMs,
      selection.sourceOutMs,
      segment.targetDurationMs,
      Math.max(selected.length, 1),
    );
    const trimmedSelection = trimSelection(selection, beatDuration);

    return {
      id: `outline-beat-${segment.id}-${beatIndex + 1}`,
      title: `${segment.title} 拍 ${beatIndex + 1}`,
      assetId: candidate.assetId,
      sliceId: candidate.sliceId,
      selection: trimmedSelection,
      summary: candidate.summary,
      transcript: candidate.transcript,
      labels: candidate.labels,
      placeHints: candidate.placeHints,
      sourceInMs: trimmedSelection.sourceInMs,
      sourceOutMs: trimmedSelection.sourceOutMs,
      estimatedDurationMs: beatDuration,
    };
  });
}

function determineBeatCount(
  role: IOutlineSegment['role'],
  targetDurationMs: number | undefined,
  candidateCount: number,
): number {
  if (candidateCount <= 1) return candidateCount;
  const targetSeconds = Math.round((targetDurationMs ?? candidateCount * 5000) / 1000);

  if (role === 'intro') {
    return Math.min(candidateCount, targetSeconds <= 14 ? 2 : 3);
  }
  if (role === 'transition' || role === 'outro') {
    return Math.min(candidateCount, targetSeconds <= 18 ? 2 : 3);
  }
  if (role === 'highlight') {
    return Math.min(candidateCount, targetSeconds <= 20 ? 2 : 3);
  }
  return Math.min(candidateCount, targetSeconds <= 18 ? 2 : targetSeconds <= 30 ? 3 : 4);
}

function selectSegmentBeatCandidates(
  segment: IApprovedSegmentPlan['segments'][number],
  sliceContexts: IOutlineSliceContext[],
  usedSliceIds: Set<string>,
  beatCount: number,
): IOutlineSliceContext[] {
  const ranked = [...sliceContexts].sort((left, right) =>
    compareCandidateScore(
      scoreCandidateForSegment(right, segment, usedSliceIds),
      scoreCandidateForSegment(left, segment, usedSliceIds),
    )
    || compareCandidateTime(left, right)
    || left.sliceId.localeCompare(right.sliceId),
  );

  const selected: IOutlineSliceContext[] = [];
  const seenSignatures = new Set<string>();
  const minGapMs = segment.role === 'scene' ? 60_000 : 120_000;

  for (const candidate of ranked) {
    if (selected.length >= beatCount) break;
    const signature = buildCandidateSignature(candidate);
    const overlapsTime = selected.some(item => timeDistanceMs(item, candidate) < minGapMs);

    if (segment.role === 'scene' && seenSignatures.has(signature) && ranked.length > beatCount) continue;
    if (overlapsTime && ranked.length > beatCount + 1) continue;

    selected.push(candidate);
    seenSignatures.add(signature);
  }

  for (const candidate of ranked) {
    if (selected.length >= beatCount) break;
    if (selected.some(item => item.sliceId === candidate.sliceId)) continue;
    selected.push(candidate);
  }

  return selected.sort(compareCandidateTime);
}

function scoreCandidateForSegment(
  candidate: IOutlineSliceContext,
  segment: IApprovedSegmentPlan['segments'][number],
  usedSliceIds: Set<string>,
): number {
  const scenicScore = countMatches(
    [...candidate.placeHints, ...tokenizeText(candidate.summary)],
    ['coastal', 'coastal area', 'mountains', 'mountain', 'hills', 'distant', 'blue', 'bright', 'open', 'sky'],
  );
  const roadScore = countMatches(
    [...candidate.labels, ...candidate.placeHints, ...tokenizeText(candidate.summary)],
    ['drive', 'driving', 'road', 'rural', 'gravel', 'trees', 'power', 'wet'],
  );
  const placePreference = overlapScore(candidate.placeHints, segment.preferredPlaceHints);
  const labelPreference = overlapScore(candidate.labels, segment.preferredLabels);
  const timeBias = typeof candidate.sourceInMs === 'number' ? candidate.sourceInMs / 60000 : 0;

  let score = placePreference * 3 + labelPreference * 2 + roadScore;

  if (segment.role === 'intro') {
    score += scenicScore * 3 + timeBias * 0.02;
  } else if (segment.role === 'transition' || segment.role === 'outro') {
    score += scenicScore * 4 + timeBias * 0.04;
  } else if (segment.role === 'highlight') {
    score += scenicScore * 2.5 + roadScore * 0.5;
  } else {
    score += roadScore * 1.5 - scenicScore * 0.5;
  }

  if (usedSliceIds.has(candidate.sliceId)) {
    score -= segment.role === 'scene' ? 1.5 : 3;
  }

  return score;
}

function compareCandidateScore(left: number, right: number): number {
  return left - right;
}

function compareCandidateTime(left: IOutlineSliceContext, right: IOutlineSliceContext): number {
  return (left.sourceInMs ?? 0) - (right.sourceInMs ?? 0);
}

function buildCandidateSignature(candidate: IOutlineSliceContext): string {
  const keyParts = [
    ...takeUnique(candidate.placeHints, 2),
    ...takeUnique(candidate.labels, 2),
  ];
  return keyParts.join('|') || candidate.sliceId;
}

function timeDistanceMs(left: IOutlineSliceContext, right: IOutlineSliceContext): number {
  if (typeof left.sourceInMs !== 'number' || typeof right.sourceInMs !== 'number') {
    return Number.POSITIVE_INFINITY;
  }
  return Math.abs(left.sourceInMs - right.sourceInMs);
}

function countMatches(source: string[], keywords: string[]): number {
  const normalizedKeywords = new Set(keywords.map(item => item.trim().toLowerCase()));
  let count = 0;
  for (const item of source) {
    const normalized = item.trim().toLowerCase();
    if (!normalized) continue;
    if (normalizedKeywords.has(normalized)) count++;
  }
  return count;
}

function overlapScore(source: string[], target: string[]): number {
  if (source.length === 0 || target.length === 0) return 0;
  const normalizedTarget = new Set(target.map(item => item.trim().toLowerCase()).filter(Boolean));
  let count = 0;
  for (const item of source) {
    const normalized = item.trim().toLowerCase();
    if (!normalized) continue;
    if (normalizedTarget.has(normalized)) count++;
  }
  return count;
}

function tokenizeText(text: string | undefined): string[] {
  if (!text) return [];
  return text
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fa5]+/u)
    .map(token => token.trim())
    .filter(token => token.length >= 2);
}

function buildSegmentContext(slices: IKtepSlice[]): IOutlineSegmentContext {
  const sliceContexts: IOutlineSliceContext[] = slices.map(slice => ({
    sliceId: slice.id,
    assetId: slice.assetId,
    summary: slice.summary,
    transcript: slice.transcript,
    labels: takeUnique(slice.labels, 4),
    placeHints: takeUnique(slice.placeHints, 3),
    sourceInMs: slice.sourceInMs,
    sourceOutMs: slice.sourceOutMs,
  }));

  const summaries = slices
    .map(slice => slice.summary?.trim() || slice.transcript?.trim())
    .filter((summary): summary is string => Boolean(summary));
  const startMs = pickMinNumber(slices.map(slice => slice.sourceInMs));
  const endMs = pickMaxNumber(slices.map(slice => slice.sourceOutMs));

  return {
    assetId: slices[0]?.assetId ?? '',
    sliceContexts,
    summary: summaries.length > 1
      ? summaries.slice(0, 3).join(' / ')
      : summaries[0] ?? `包含 ${slices.length} 个候选切片`,
    startMs,
    endMs,
  };
}

function buildSelection(slice: IKtepSlice): IKtepScriptSelection {
  return {
    assetId: slice.assetId,
    sliceId: slice.id,
    sourceInMs: slice.sourceInMs,
    sourceOutMs: slice.sourceOutMs,
  };
}

function trimSelection(
  selection: IKtepScriptSelection,
  targetDurationMs: number,
): IKtepScriptSelection {
  const start = selection.sourceInMs;
  const end = selection.sourceOutMs;
  if (typeof start !== 'number' || typeof end !== 'number' || end <= start) {
    return selection;
  }
  const sourceDuration = end - start;
  if (targetDurationMs <= 0 || sourceDuration <= targetDurationMs) {
    return selection;
  }

  const trimmedDuration = Math.max(1000, Math.min(targetDurationMs, sourceDuration));
  const center = start + sourceDuration / 2;
  let trimmedStart = Math.round(center - trimmedDuration / 2);
  let trimmedEnd = trimmedStart + trimmedDuration;

  if (trimmedStart < start) {
    trimmedStart = start;
    trimmedEnd = start + trimmedDuration;
  }
  if (trimmedEnd > end) {
    trimmedEnd = end;
    trimmedStart = end - trimmedDuration;
  }

  return {
    ...selection,
    sourceInMs: trimmedStart,
    sourceOutMs: trimmedEnd,
  };
}

function estimateBeatDuration(
  sourceInMs: number | undefined,
  sourceOutMs: number | undefined,
  segmentTargetDurationMs: number | undefined,
  beatCount: number,
): number {
  if (
    typeof sourceInMs === 'number'
    && typeof sourceOutMs === 'number'
    && sourceOutMs > sourceInMs
    && segmentTargetDurationMs
    && beatCount > 0
  ) {
    return Math.max(1000, Math.round(segmentTargetDurationMs / beatCount));
  }
  if (segmentTargetDurationMs && beatCount > 0) {
    return Math.max(1000, Math.round(segmentTargetDurationMs / beatCount));
  }
  return 5000;
}

function buildSegmentBeats(
  slices: IKtepSlice[],
  estimatedDurationMs: number,
): IOutlineBeat[] {
  if (slices.length === 0) return [];

  const totalSourceDuration = slices.reduce((sum, slice) => sum + estimateSliceDuration(slice), 0);

  return slices.map((slice, index) => {
    const sliceDuration = estimateSliceDuration(slice);
    const beatDuration = totalSourceDuration > 0
      ? Math.max(1000, Math.round(estimatedDurationMs * (sliceDuration / totalSourceDuration)))
      : Math.max(1000, Math.round(estimatedDurationMs / slices.length));
    const selection = buildTrimmedSelection(slice, beatDuration);

    return {
      id: `outline-beat-${slice.id}`,
      title: buildBeatTitle(index, slice),
      assetId: slice.assetId,
      sliceId: slice.id,
      selection,
      summary: slice.summary,
      transcript: slice.transcript,
      labels: takeUnique(slice.labels, 4),
      placeHints: takeUnique(slice.placeHints, 3),
      sourceInMs: selection.sourceInMs,
      sourceOutMs: selection.sourceOutMs,
      estimatedDurationMs: beatDuration,
    };
  });
}

function groupByAsset(slices: IKtepSlice[]): IKtepSlice[][] {
  const groups = new Map<string, IKtepSlice[]>();
  const order: string[] = [];
  for (const slice of slices) {
    if (!groups.has(slice.assetId)) {
      groups.set(slice.assetId, []);
      order.push(slice.assetId);
    }
    groups.get(slice.assetId)!.push(slice);
  }

  return order.map(assetId => groups.get(assetId)!);
}

function estimateGroupDuration(slices: IKtepSlice[]): number {
  const duration = slices.reduce((sum, slice) => {
    return sum + estimateSliceDuration(slice);
  }, 0);

  return Math.max(duration, 5000);
}

function estimateSliceDuration(slice: IKtepSlice): number {
  if (typeof slice.sourceInMs === 'number' && typeof slice.sourceOutMs === 'number') {
    return Math.max(0, slice.sourceOutMs - slice.sourceInMs);
  }
  return 5000;
}

function buildTrimmedSelection(
  slice: IKtepSlice,
  targetDurationMs: number,
): IKtepScriptSelection {
  const base = buildSelection(slice);
  const start = slice.sourceInMs;
  const end = slice.sourceOutMs;

  if (typeof start !== 'number' || typeof end !== 'number' || end <= start) {
    return base;
  }

  const sourceDuration = end - start;
  if (targetDurationMs <= 0 || sourceDuration <= targetDurationMs) {
    return base;
  }

  const trimmedDuration = Math.max(1000, Math.min(targetDurationMs, sourceDuration));
  const center = start + sourceDuration / 2;
  let trimmedStart = Math.round(center - trimmedDuration / 2);
  let trimmedEnd = trimmedStart + trimmedDuration;

  if (trimmedStart < start) {
    trimmedStart = start;
    trimmedEnd = start + trimmedDuration;
  }
  if (trimmedEnd > end) {
    trimmedEnd = end;
    trimmedStart = end - trimmedDuration;
  }

  return {
    ...base,
    sourceInMs: trimmedStart,
    sourceOutMs: trimmedEnd,
  };
}

function pickSegmentRole(
  groupCount: number,
  index: number,
  slices: IKtepSlice[],
): IOutlineSegment['role'] {
  if (groupCount === 1) return 'scene';
  if (index === 0) return 'intro';
  if (index === groupCount - 1) return 'outro';
  const avgConfidence = slices.reduce((sum, slice) => sum + (slice.confidence ?? 0.5), 0) / slices.length;
  return avgConfidence >= 0.75 ? 'highlight' : 'scene';
}

function buildSegmentTitle(
  role: IOutlineSegment['role'],
  index: number,
): string {
  if (role === 'intro') return '开篇素材';
  if (role === 'outro') return '结尾素材';
  if (role === 'highlight') return `重点段落 ${index + 1}`;
  return `素材段落 ${index + 1}`;
}

function buildBeatTitle(index: number, slice: IKtepSlice): string {
  const type = slice.type === 'unknown' ? '候选镜头' : slice.type;
  return `${type} 拍 ${index + 1}`;
}

function takeUnique(values: string[], limit: number): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))].slice(0, limit);
}

function pickMinNumber(values: Array<number | undefined>): number | undefined {
  const numbers = values.filter((value): value is number => typeof value === 'number');
  if (numbers.length === 0) return undefined;
  return Math.min(...numbers);
}

function pickMaxNumber(values: Array<number | undefined>): number | undefined {
  const numbers = values.filter((value): value is number => typeof value === 'number');
  if (numbers.length === 0) return undefined;
  return Math.max(...numbers);
}
