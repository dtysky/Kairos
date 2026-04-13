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
  selections: IKtepScriptSelection[];
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
    const beats = (group?.slots ?? [])
      .flatMap(slot => buildBeats(slot.id, slot.query, slot.chosenSpanIds, input.spansById));

    const selections = dedupeSelections(beats.flatMap(beat => beat.selections));
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
  return chosenSpanIds
    .map((spanId, index) => buildBeat(`${slotId || randomUUID()}-${index + 1}`, query, spanId, spansById))
    .filter((beat): beat is IOutlineBeat => Boolean(beat));
}

function buildBeat(
  beatId: string,
  query: string,
  chosenSpanId: string,
  spansById: Map<string, IKtepSlice>,
): IOutlineBeat | null {
  const primary = spansById.get(chosenSpanId);
  if (!primary) return null;

  const selections = [{
    assetId: primary.assetId,
    spanId: primary.id,
    sliceId: primary.id,
    sourceInMs: primary.sourceInMs,
    sourceOutMs: primary.sourceOutMs,
    pharosRefs: primary.pharosRefs,
  }];

  const locations = dedupeStrings(primary.grounding.spatialEvidence.map(evidence => evidence.locationText));
  const materialPatterns = dedupeStrings(primary.materialPatterns.map(pattern => pattern.phrase));
  const transcript = primary.transcript?.trim() || undefined;

  return {
    id: beatId,
    title: summarizeQuery(query),
    summary: buildBeatSummary(query, [primary], locations, materialPatterns),
    query,
    selections,
    linkedSpanIds: [primary.id],
    transcript,
    materialPatterns,
    locations,
    sourceSpeechDecision: transcript ? 'preserve' : 'rewrite',
    speedCandidate: primary.speedCandidate,
    sourceInMs: primary.sourceInMs,
    sourceOutMs: primary.sourceOutMs,
  };
}

function buildBeatSummary(
  query: string,
  spans: IKtepSlice[],
  locations: string[],
  materialPatterns: string[],
): string {
  const primary = spans[0]!;
  const transcript = primary.transcript?.trim();
  if (transcript) {
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
    .flatMap(beat => beat.selections)
    .map(selection => {
      if (typeof selection.sourceInMs !== 'number' || typeof selection.sourceOutMs !== 'number') {
        return 0;
      }
      return Math.max(0, selection.sourceOutMs - selection.sourceInMs);
    })
    .reduce((sum, value) => sum + value, 0);
  return explicit > 0 ? explicit : Math.max(1, beats.length) * 12_000;
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
