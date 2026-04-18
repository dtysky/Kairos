import { randomUUID } from 'node:crypto';
import type {
  IKtepScriptSelection,
  IKtepSlice,
  ISegmentPlan,
  IMaterialSlotsDocument,
  EScriptRole,
} from '../../protocol/schema.js';

export interface IOutlineBeat {
  id: string;
  title: string;
  summary: string;
  query: string;
  audioSelections: IKtepScriptSelection[];
  visualSelections: IKtepScriptSelection[];
  linkedSpanIds: string[];
  transcript?: string;
  materialPatterns: string[];
  locations: string[];
  sourceSpeechDecision?: 'preserve' | 'rewrite';
  speedCandidate?: IKtepSlice['speedCandidate'];
  sourceInMs?: number;
  sourceOutMs?: number;
}

export interface IOutlineSegment {
  id: string;
  role: EScriptRole;
  title: string;
  narrativeSketch: string;
  estimatedDurationMs: number;
  notes: string[];
  selections: IKtepScriptSelection[];
  spanIds: string[];
  beats: IOutlineBeat[];
}

const COUTLINE_SOURCE_SPEECH_GAP_MS = 3000;

export interface IBuildOutlineInput {
  segmentPlan: ISegmentPlan;
  materialSlots: IMaterialSlotsDocument;
  spansById: Map<string, IKtepSlice>;
}

export function buildOutline(input: IBuildOutlineInput): IOutlineSegment[] {
  const slotGroupBySegmentId = new Map(
    input.materialSlots.segments.map(group => [group.segmentId, group] as const),
  );

  return input.segmentPlan.segments.map((segment, index, allSegments) => {
    const group = slotGroupBySegmentId.get(segment.id);
    const slots = coalesceOutlineSlots(group?.slots ?? []);
    const beats = slots.flatMap(slot =>
      buildBeats(slot.id, slot.query, slot.chosenSpanIds, input.spansById),
    );

    const selections = dedupeSelections(
      beats.flatMap(beat => collectBeatSelections(beat)),
    );
    const spanIds = dedupeStrings(beats.flatMap(beat => beat.linkedSpanIds));
    return {
      id: segment.id,
      role: normalizeScriptRole(segment.roleHint, index, allSegments.length),
      title: segment.title,
      narrativeSketch: segment.intent,
      estimatedDurationMs: segment.targetDurationMs ?? estimateDurationMs(beats),
      notes: segment.notes ?? [],
      selections,
      spanIds,
      beats,
    };
  });
}

function buildBeats(
  slotId: string,
  query: string,
  chosenSpanIds: string[],
  spansById: Map<string, IKtepSlice>,
): IOutlineBeat[] {
  const spans = chosenSpanIds
    .map(spanId => spansById.get(spanId))
    .filter((span): span is IKtepSlice => Boolean(span));
  const filtered = filterOutlineNoise(spans);
  const source = filtered.length > 0 ? filtered : spans;
  const groups = groupBeatSpans(source);

  return groups
    .map((group, index) => buildBeat(`${slotId || randomUUID()}-${index + 1}`, query, group))
    .filter((beat): beat is IOutlineBeat => Boolean(beat));
}

function buildBeat(
  beatId: string,
  query: string,
  spans: IKtepSlice[],
): IOutlineBeat | null {
  const primary = spans[0];
  if (!primary) return null;

  const speechSpans = spans.filter(shouldPreserveSourceSpeech);
  const audioSelections = speechSpans.map(mapSpanToSelection);
  const visualSelections = spans.map(mapSpanToSelection);

  const locations = dedupeStrings(
    spans.flatMap(span => span.grounding.spatialEvidence.map(evidence => evidence.locationText)),
  );
  const materialPatterns = dedupeStrings(
    spans.flatMap(span => span.materialPatterns.map(pattern => pattern.phrase)),
  );
  const preserveSourceSpeech = audioSelections.length > 0;
  const transcript = preserveSourceSpeech
    ? speechSpans
      .map(span => span.transcript?.trim())
      .filter((value): value is string => typeof value === 'string' && value.length > 0)
      .join(' ')
      || undefined
    : undefined;
  const timingAnchor = speechSpans[0] ?? primary;

  return {
    id: beatId,
    title: summarizeQuery(query),
    summary: buildBeatSummary(query, spans, locations, materialPatterns),
    query,
    audioSelections,
    visualSelections,
    linkedSpanIds: spans.map(span => span.id),
    transcript,
    materialPatterns,
    locations,
    sourceSpeechDecision: preserveSourceSpeech ? 'preserve' : 'rewrite',
    speedCandidate: primary.speedCandidate,
    sourceInMs: timingAnchor.sourceInMs,
    sourceOutMs: timingAnchor.sourceOutMs,
  };
}

function coalesceOutlineSlots(
  slots: IMaterialSlotsDocument['segments'][number]['slots'],
): IMaterialSlotsDocument['segments'][number]['slots'] {
  const result: IMaterialSlotsDocument['segments'][number]['slots'] = [];
  for (const slot of slots) {
    const previous = result[result.length - 1];
    if (
      previous
      && previous.query === slot.query
      && previous.requirement === slot.requirement
      && sameStringList(previous.targetBundles, slot.targetBundles)
    ) {
      previous.chosenSpanIds = dedupeStrings([
        ...previous.chosenSpanIds,
        ...slot.chosenSpanIds,
      ]);
      continue;
    }

    result.push({
      ...slot,
      chosenSpanIds: dedupeStrings(slot.chosenSpanIds),
      targetBundles: [...slot.targetBundles],
    });
  }

  return result;
}

function filterOutlineNoise(spans: IKtepSlice[]): IKtepSlice[] {
  if (spans.length <= 1) return spans;
  const filtered = spans.filter(span => !isLikelyNoisyTranscript(span));
  return filtered.length > 0 ? filtered : spans;
}

function groupBeatSpans(spans: IKtepSlice[]): IKtepSlice[][] {
  const groups: IKtepSlice[][] = [];
  let currentGroup: IKtepSlice[] = [];

  const flushGroup = (): void => {
    if (currentGroup.length === 0) return;
    groups.push(currentGroup);
    currentGroup = [];
  };

  for (const span of spans) {
    if (currentGroup.length === 0) {
      currentGroup = [span];
      continue;
    }

    const previous = currentGroup[currentGroup.length - 1];
    if (!previous) {
      currentGroup = [span];
      continue;
    }

    const currentHasSpeech = currentGroup.some(shouldPreserveSourceSpeech);
    const nextHasSpeech = shouldPreserveSourceSpeech(span);
    if (currentHasSpeech && nextHasSpeech) {
      const previousSpeech = [...currentGroup].reverse().find(shouldPreserveSourceSpeech);
      if (previousSpeech && shouldMergeSourceSpeechSpans(previousSpeech, span)) {
        currentGroup.push(span);
        continue;
      }

      flushGroup();
      currentGroup = [span];
      continue;
    }

    if (currentHasSpeech || nextHasSpeech) {
      if (currentGroup.length < 4 && shouldMergeCompanionSpan(previous, span)) {
        currentGroup.push(span);
        continue;
      }

      flushGroup();
      currentGroup = [span];
      continue;
    }

    if (currentGroup.length < 3 && shouldMergeVisualSpans(previous, span)) {
      currentGroup.push(span);
      continue;
    }

    flushGroup();
    currentGroup = [span];
  }

  flushGroup();
  return groups;
}

function shouldPreserveSourceSpeech(span: IKtepSlice): boolean {
  const transcript = span.transcript?.trim();
  if (!transcript) return false;
  if (isLikelyNoisyTranscript(span)) return false;

  if (span.grounding.speechMode === 'preferred') return true;
  if (span.grounding.speechValue !== 'none') return true;
  if ((span.speechCoverage ?? 0) >= 0.18) return true;
  if ((span.transcriptSegments?.length ?? 0) >= 2) return true;
  return visibleTranscriptLength(transcript) >= 12;
}

function isLikelyNoisyTranscript(span: IKtepSlice): boolean {
  const transcript = span.transcript?.trim();
  if (!transcript) return false;
  const normalized = transcript.replace(/\s+/gu, '');
  const noisyPatterns = [
    /拍摄启动/u,
    /停止录像/u,
    /停止录音/u,
    /开始录音/u,
    /指令执行中/u,
    /重新规划路线/u,
    /recording\s*(started|stopped)/iu,
  ];
  const navigationPatterns = [
    /前方\d+(米|公里).*(左转|右转|掉头|直行)/u,
    /请按导航/u,
    /导航/u,
    /收费站/u,
    /服务区/u,
    /turn\s+(left|right)/iu,
    /continue\s+straight/iu,
  ];
  if (noisyPatterns.some(pattern => pattern.test(normalized))) return true;
  if (navigationPatterns.some(pattern => pattern.test(normalized))) {
    return (span.speechCoverage ?? 0) < 0.35 || visibleTranscriptLength(transcript) <= 24;
  }
  return false;
}

function shouldMergeVisualSpans(left: IKtepSlice, right: IKtepSlice): boolean {
  if (left.assetId === right.assetId) return true;
  if (left.type === right.type) return true;
  if (sharesValue(
    left.materialPatterns.map(pattern => pattern.phrase),
    right.materialPatterns.map(pattern => pattern.phrase),
  )) {
    return true;
  }
  return sharesValue(
    left.grounding.spatialEvidence.map(item => item.locationText),
    right.grounding.spatialEvidence.map(item => item.locationText),
  );
}

function shouldMergeCompanionSpan(left: IKtepSlice, right: IKtepSlice): boolean {
  return shouldMergeVisualSpans(left, right);
}

function shouldMergeSourceSpeechSpans(left: IKtepSlice, right: IKtepSlice): boolean {
  if (left.assetId !== right.assetId) return false;
  const leftOutMs = left.sourceOutMs;
  const rightInMs = right.sourceInMs;
  if (typeof leftOutMs !== 'number' || typeof rightInMs !== 'number') return false;
  if (rightInMs - leftOutMs > COUTLINE_SOURCE_SPEECH_GAP_MS) return false;
  return !hasStrongSentenceBoundary(left);
}

function hasStrongSentenceBoundary(span: IKtepSlice): boolean {
  const transcript = span.transcript?.trim();
  if (!transcript) return false;
  return /[。！？!?；;]$/u.test(transcript);
}

function sharesValue(left: Array<string | undefined>, right: Array<string | undefined>): boolean {
  const leftSet = new Set(left.map(value => value?.trim()).filter(Boolean));
  return right.some(value => {
    const normalized = value?.trim();
    return Boolean(normalized && leftSet.has(normalized));
  });
}

function sameStringList(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function visibleTranscriptLength(value: string): number {
  return value.replace(/[\s\p{P}\p{S}]+/gu, '').length;
}

function buildBeatSummary(
  query: string,
  spans: IKtepSlice[],
  locations: string[],
  materialPatterns: string[],
): string {
  const primary = spans[0]!;
  const transcript = primary.transcript?.trim();
  if (spans.length === 1 && transcript && shouldPreserveSourceSpeech(primary)) {
    return transcript.slice(0, 120);
  }

  const summary = dedupeStrings([
    query,
    materialPatterns[0],
    locations[0],
    primary.narrativeFunctions?.core?.[0],
    primary.shotGrammar?.core?.[0],
  ]);
  return summary.join(' / ') || '根据已选素材推进该段落。';
}

function estimateDurationMs(beats: IOutlineBeat[]): number {
  const explicit = beats
    .flatMap(beat => beat.visualSelections)
    .map(selection => {
      if (typeof selection.sourceInMs !== 'number' || typeof selection.sourceOutMs !== 'number') {
        return 0;
      }
      return Math.max(0, selection.sourceOutMs - selection.sourceInMs);
    })
    .reduce((sum, value) => sum + value, 0);
  return explicit > 0 ? explicit : Math.max(1, beats.length) * 12_000;
}

function mapSpanToSelection(span: IKtepSlice): IKtepScriptSelection {
  return {
    assetId: span.assetId,
    spanId: span.id,
    sliceId: span.id,
    sourceInMs: span.sourceInMs,
    sourceOutMs: span.sourceOutMs,
    pharosRefs: span.pharosRefs,
  };
}

function collectBeatSelections(beat: IOutlineBeat): IKtepScriptSelection[] {
  return dedupeSelections([
    ...beat.audioSelections,
    ...beat.visualSelections,
  ]);
}

function normalizeScriptRole(
  roleHint: string | undefined,
  index: number,
  total: number,
): EScriptRole {
  const normalized = roleHint?.trim().toLowerCase() ?? '';
  if (normalized === 'intro') return 'intro';
  if (normalized === 'transition') return 'transition';
  if (normalized === 'highlight') return 'highlight';
  if (normalized === 'outro') return 'outro';
  if (normalized === 'scene') return 'scene';
  if (index === 0) return 'intro';
  if (index === total - 1) return 'outro';
  return 'scene';
}

function summarizeQuery(query: string): string {
  const trimmed = query.trim();
  if (trimmed.length <= 28) return trimmed;
  return `${trimmed.slice(0, 25).trim()}...`;
}

function dedupeSelections(values: IKtepScriptSelection[]): IKtepScriptSelection[] {
  const seen = new Set<string>();
  const result: IKtepScriptSelection[] = [];
  for (const value of values) {
    const key = [
      value.assetId,
      value.spanId ?? '',
      value.sourceInMs ?? '',
      value.sourceOutMs ?? '',
    ].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function dedupeStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.map(value => value?.trim()).filter(Boolean) as string[])];
}
