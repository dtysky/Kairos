import type {
  IBeatPacket,
  ICurrentArrangement,
  IKtepScriptSelection,
  IKtepSlice,
  ISegmentPacket,
  ISpeedCandidateHint,
} from '../../protocol/schema.js';
import {
  hasExplicitEditRange,
  resolveSlicePreferredRange,
  snapSelectionToTranscriptSegments,
} from '../media/window-policy.js';

export interface IOutlineSliceContext {
  sliceId: string;
  assetId: string;
  semanticKind?: IKtepSlice['semanticKind'];
  summary?: string;
  transcript?: string;
  materialPatterns: string[];
  localEditingIntent?: string;
  sourceAudioPolicy?: IKtepSlice['localEditingIntent']['sourceAudioPolicy'];
  speedPolicy?: IKtepSlice['localEditingIntent']['speedPolicy'];
  narrativeFunctions: string[];
  shotGrammar: string[];
  viewpointRoles: string[];
  subjectStates: string[];
  locations: string[];
  speechMode: IKtepSlice['grounding']['speechMode'];
  speechValue: IKtepSlice['grounding']['speechValue'];
  pharosRefs?: IKtepSlice['pharosRefs'];
  sourceInMs?: number;
  sourceOutMs?: number;
  editSourceInMs?: number;
  editSourceOutMs?: number;
  speedCandidate?: ISpeedCandidateHint;
}

export interface IOutlineBeat {
  id: string;
  title: string;
  assetId: string;
  sliceId?: string;
  semanticKind?: IKtepSlice['semanticKind'];
  selection: IKtepScriptSelection;
  selections: IKtepScriptSelection[];
  summary?: string;
  transcript?: string;
  materialPatterns: string[];
  localEditingIntent?: string;
  sourceAudioPolicy?: IKtepSlice['localEditingIntent']['sourceAudioPolicy'];
  speedPolicy?: IKtepSlice['localEditingIntent']['speedPolicy'];
  narrativeFunctions: string[];
  shotGrammar: string[];
  viewpointRoles: string[];
  locations: string[];
  sourceSpeechDecision?: IBeatPacket['outputContract']['sourceSpeechDecision'];
  sourceInMs?: number;
  sourceOutMs?: number;
  speedCandidate?: ISpeedCandidateHint;
  estimatedDurationMs: number;
}

export interface IOutlineSegmentContext {
  assetId: string;
  sliceContexts: IOutlineSliceContext[];
  summary: string;
  bundleIds: string[];
  startMs?: number;
  endMs?: number;
}

export interface IOutlineSegment {
  id: string;
  role: 'intro' | 'scene' | 'transition' | 'highlight' | 'outro';
  title: string;
  assetId: string;
  sliceIds: string[];
  selections: IKtepScriptSelection[];
  beats: IOutlineBeat[];
  context: IOutlineSegmentContext;
  estimatedDurationMs: number;
  segmentCardId: string;
  narrativeSketch: string;
  styleArchetypeHits: string[];
}

export interface IBuildOutlineFromPacketsInput {
  current: ICurrentArrangement;
  segmentPackets: ISegmentPacket[];
  beatPacketsBySegmentCardId: Record<string, IBeatPacket[]>;
  slices: IKtepSlice[];
  targetDurationMs?: number;
}

/**
 * Fallback outline builder that groups slices by asset order.
 * It remains as a narrow fallback for tests or ad-hoc tooling.
 */
export function buildOutline(
  slices: IKtepSlice[],
  targetDurationMs: number,
): IOutlineSegment[] {
  if (slices.length === 0) return [];

  const sorted = [...slices].sort(compareSlices);
  const groups = groupByAsset(sorted);
  const estimatedTotal = Math.max(targetDurationMs, 1_000);

  return groups.map((group, index) => {
    const sliceContexts = group.map(buildSliceContext);
    const beats = group.map((slice, beatIndex) => buildBeatFromSlice({
      slice,
      beatId: `outline-beat-${slice.id}`,
      beatTitle: `素材拍 ${beatIndex + 1}`,
      estimatedDurationMs: Math.max(1_000, Math.round(estimatedTotal / Math.max(sorted.length, 1))),
      sourceSpeechDecision: slice.grounding?.speechMode === 'preferred' ? 'use' : 'optional',
    }));
    const selections = flattenSelections(beats.map(beat => beat.selections));
    const summary = summarizeSliceContexts(sliceContexts);

    return {
      id: `outline-segment-${index + 1}`,
      role: pickSegmentRole(index, groups.length, summary),
      title: buildFallbackTitle(index, groups.length, summary),
      assetId: group[0]?.assetId ?? '',
      sliceIds: group.map(slice => slice.id),
      selections,
      beats,
      context: {
        assetId: group[0]?.assetId ?? '',
        sliceContexts,
        summary,
        bundleIds: [],
        startMs: pickMinNumber(sliceContexts.map(item => getContextStartMs(item))),
        endMs: pickMaxNumber(sliceContexts.map(item => getContextEndMs(item))),
      },
      estimatedDurationMs: Math.max(1_000, Math.round(estimatedTotal / Math.max(groups.length, 1))),
      segmentCardId: `fallback-segment-${index + 1}`,
      narrativeSketch: summary,
      styleArchetypeHits: [],
    };
  });
}

export function buildOutlineFromPackets(
  input: IBuildOutlineFromPacketsInput,
): IOutlineSegment[] {
  const sliceMap = new Map(input.slices.map(slice => [slice.id, slice]));
  const orderedPackets = orderSegmentPackets(input.segmentPackets, input.current.segmentCardIds);
  if (orderedPackets.length === 0) return [];

  const estimatedTotal = input.targetDurationMs
    ?? orderedPackets.reduce((sum, packet) => sum + estimatePacketDuration(packet), 0)
    ?? orderedPackets.length * 12_000;
  const packetWeights = orderedPackets.map(packet => Math.max(1, estimatePacketDuration(packet)));
  const totalWeight = packetWeights.reduce((sum, weight) => sum + weight, 0) || orderedPackets.length;

  return orderedPackets.map((segmentPacket, index) => {
    const beatPackets = input.beatPacketsBySegmentCardId[segmentPacket.segmentCard.id] ?? [];
    const beats = beatPackets.length > 0
      ? beatPackets.map((beatPacket, beatIndex) => buildBeatFromPacket({
        beatPacket,
        beatIndex,
        segmentPacket,
        sliceMap,
        estimatedDurationMs: Math.max(
          3_000,
          Math.round(
            (estimatePacketDuration(segmentPacket) / Math.max(beatPackets.length, 1))
            || (estimatedTotal / Math.max(orderedPackets.length, 1) / Math.max(beatPackets.length, 1)),
          ),
        ),
      }))
      : buildFallbackBeatsFromSegmentPacket(segmentPacket, sliceMap);

    const sliceContexts = buildSegmentSliceContexts(segmentPacket, sliceMap);
    const selections = flattenSelections(beats.map(beat => beat.selections));
    const summary = segmentPacket.segmentCard.narrativeSketch
      || segmentPacket.outputContract.narrativeSketch
      || summarizeSliceContexts(sliceContexts);
    const estimatedDurationMs = Math.max(
      8_000,
      Math.round(estimatedTotal * (packetWeights[index]! / totalWeight)),
    );

    return {
      id: `outline-segment-${segmentPacket.segmentCard.id}`,
      role: mapSegmentRole(segmentPacket, index, orderedPackets.length),
      title: buildSegmentTitle(segmentPacket, index),
      assetId: beats[0]?.assetId ?? sliceContexts[0]?.assetId ?? '',
      sliceIds: sliceContexts.map(context => context.sliceId),
      selections,
      beats,
      context: {
        assetId: beats[0]?.assetId ?? sliceContexts[0]?.assetId ?? '',
        sliceContexts,
        summary,
        bundleIds: segmentPacket.segmentCard.bundleIds,
        startMs: pickMinNumber(sliceContexts.map(item => getContextStartMs(item))),
        endMs: pickMaxNumber(sliceContexts.map(item => getContextEndMs(item))),
      },
      estimatedDurationMs,
      segmentCardId: segmentPacket.segmentCard.id,
      narrativeSketch: segmentPacket.segmentCard.narrativeSketch,
      styleArchetypeHits: segmentPacket.styleArchetypeHits,
    };
  });
}

function buildSegmentSliceContexts(
  segmentPacket: ISegmentPacket,
  sliceMap: Map<string, IKtepSlice>,
): IOutlineSliceContext[] {
  const seen = new Set<string>();
  const contexts: IOutlineSliceContext[] = [];

  for (const slice of segmentPacket.representativeSlices) {
    if (seen.has(slice.id)) continue;
    contexts.push(buildSliceContext(slice));
    seen.add(slice.id);
  }

  for (const bundle of segmentPacket.motifBundles) {
    for (const sliceId of bundle.representativeSliceIds) {
      if (seen.has(sliceId)) continue;
      const slice = sliceMap.get(sliceId);
      if (!slice) continue;
      contexts.push(buildSliceContext(slice));
      seen.add(sliceId);
    }
  }

  return contexts.sort((left, right) =>
    (getContextStartMs(left) ?? 0) - (getContextStartMs(right) ?? 0)
    || left.sliceId.localeCompare(right.sliceId),
  );
}

function buildBeatFromPacket(input: {
  beatPacket: IBeatPacket;
  beatIndex: number;
  segmentPacket: ISegmentPacket;
  sliceMap: Map<string, IKtepSlice>;
  estimatedDurationMs: number;
}): IOutlineBeat {
  const candidateSlices = input.beatPacket.outputContract.chosenSliceIds
    .concat(input.beatPacket.outputContract.chosenSpanIds ?? [])
    .map(sliceId => input.sliceMap.get(sliceId))
    .filter((slice): slice is IKtepSlice => Boolean(slice));
  const slices = candidateSlices.length > 0
    ? candidateSlices
    : input.beatPacket.representativeSlices;
  const primarySlice = slices[0];

  if (!primarySlice) {
    return {
      id: `outline-beat-${input.segmentPacket.segmentCard.id}-${input.beatIndex + 1}`,
      title: `${buildSegmentTitle(input.segmentPacket, input.beatIndex)} 拍 ${input.beatIndex + 1}`,
      assetId: '',
      selection: { assetId: '' },
      selections: [],
      materialPatterns: [],
      localEditingIntent: undefined,
      sourceAudioPolicy: undefined,
      speedPolicy: undefined,
      narrativeFunctions: [],
      shotGrammar: [],
      viewpointRoles: [],
      locations: [],
      sourceSpeechDecision: input.beatPacket.outputContract.sourceSpeechDecision,
      estimatedDurationMs: input.estimatedDurationMs,
    };
  }

  const selections = slices.map(slice => buildTrimmedSelection(slice, input.estimatedDurationMs));
  const primarySelection = selections[0]!;

  return {
    id: `outline-beat-${input.segmentPacket.segmentCard.id}-${input.beatIndex + 1}`,
    title: `${buildSegmentTitle(input.segmentPacket, input.beatIndex)} 拍 ${input.beatIndex + 1}`,
    assetId: primarySlice.assetId,
    sliceId: primarySlice.id,
    semanticKind: primarySlice.semanticKind,
    selection: primarySelection,
    selections,
    summary: buildSliceSummary(primarySlice),
    transcript: primarySlice.transcript,
    materialPatterns: takeUnique((primarySlice.materialPatterns ?? []).map(item => item.phrase), 4),
    localEditingIntent: primarySlice.localEditingIntent?.primaryPhrase,
    sourceAudioPolicy: primarySlice.localEditingIntent?.sourceAudioPolicy,
    speedPolicy: primarySlice.localEditingIntent?.speedPolicy,
    narrativeFunctions: takeUnique(getTagCore(primarySlice.narrativeFunctions), 4),
    shotGrammar: takeUnique(getTagCore(primarySlice.shotGrammar), 4),
    viewpointRoles: takeUnique(getTagCore(primarySlice.viewpointRoles), 3),
    locations: takeUnique(extractSliceLocations(primarySlice), 3),
    sourceSpeechDecision: input.beatPacket.outputContract.sourceSpeechDecision,
    sourceInMs: primarySelection.sourceInMs,
    sourceOutMs: primarySelection.sourceOutMs,
    speedCandidate: primarySlice.speedCandidate,
    estimatedDurationMs: input.estimatedDurationMs,
  };
}

function buildFallbackBeatsFromSegmentPacket(
  segmentPacket: ISegmentPacket,
  sliceMap: Map<string, IKtepSlice>,
): IOutlineBeat[] {
  return segmentPacket.representativeSlices.map((slice, index) => buildBeatFromSlice({
    slice: sliceMap.get(slice.id) ?? slice,
    beatId: `outline-beat-${segmentPacket.segmentCard.id}-${index + 1}`,
    beatTitle: `${buildSegmentTitle(segmentPacket, index)} 拍 ${index + 1}`,
    estimatedDurationMs: Math.max(3_000, Math.round(estimatePacketDuration(segmentPacket) / Math.max(segmentPacket.representativeSlices.length, 1))),
    sourceSpeechDecision: slice.grounding?.speechMode === 'preferred' ? 'use' : 'optional',
  }));
}

function buildBeatFromSlice(input: {
  slice: IKtepSlice;
  beatId: string;
  beatTitle: string;
  estimatedDurationMs: number;
  sourceSpeechDecision: IBeatPacket['outputContract']['sourceSpeechDecision'];
}): IOutlineBeat {
  const selection = buildTrimmedSelection(input.slice, input.estimatedDurationMs);
  return {
    id: input.beatId,
    title: input.beatTitle,
    assetId: input.slice.assetId,
    sliceId: input.slice.id,
    semanticKind: input.slice.semanticKind,
    selection,
    selections: [selection],
    summary: buildSliceSummary(input.slice),
    transcript: input.slice.transcript,
    materialPatterns: takeUnique((input.slice.materialPatterns ?? []).map(item => item.phrase), 4),
    localEditingIntent: input.slice.localEditingIntent?.primaryPhrase,
    sourceAudioPolicy: input.slice.localEditingIntent?.sourceAudioPolicy,
    speedPolicy: input.slice.localEditingIntent?.speedPolicy,
    narrativeFunctions: takeUnique(getTagCore(input.slice.narrativeFunctions), 4),
    shotGrammar: takeUnique(getTagCore(input.slice.shotGrammar), 4),
    viewpointRoles: takeUnique(getTagCore(input.slice.viewpointRoles), 3),
    locations: takeUnique(extractSliceLocations(input.slice), 3),
    sourceSpeechDecision: input.sourceSpeechDecision,
    sourceInMs: selection.sourceInMs,
    sourceOutMs: selection.sourceOutMs,
    speedCandidate: input.slice.speedCandidate,
    estimatedDurationMs: input.estimatedDurationMs,
  };
}

function buildSliceContext(slice: IKtepSlice): IOutlineSliceContext {
  return {
    sliceId: slice.id,
    assetId: slice.assetId,
    semanticKind: slice.semanticKind,
    summary: buildSliceSummary(slice),
    transcript: slice.transcript,
    materialPatterns: takeUnique((slice.materialPatterns ?? []).map(item => item.phrase), 4),
    localEditingIntent: slice.localEditingIntent?.primaryPhrase,
    sourceAudioPolicy: slice.localEditingIntent?.sourceAudioPolicy,
    speedPolicy: slice.localEditingIntent?.speedPolicy,
    narrativeFunctions: takeUnique(getTagCore(slice.narrativeFunctions), 4),
    shotGrammar: takeUnique(getTagCore(slice.shotGrammar), 4),
    viewpointRoles: takeUnique(getTagCore(slice.viewpointRoles), 3),
    subjectStates: takeUnique(getTagCore(slice.subjectStates), 3),
    locations: takeUnique(extractSliceLocations(slice), 3),
    speechMode: slice.grounding?.speechMode ?? 'none',
    speechValue: slice.grounding?.speechValue ?? 'none',
    pharosRefs: slice.pharosRefs,
    sourceInMs: slice.sourceInMs,
    sourceOutMs: slice.sourceOutMs,
    editSourceInMs: slice.editSourceInMs,
    editSourceOutMs: slice.editSourceOutMs,
    speedCandidate: slice.speedCandidate,
  };
}

function buildSliceSummary(slice: IKtepSlice): string {
  const parts = [
    slice.localEditingIntent?.primaryPhrase,
    slice.materialPatterns?.[0]?.phrase,
    extractSliceLocations(slice)[0],
    slice.transcript?.trim(),
  ].filter(Boolean);
  return parts.join(' / ') || slice.type;
}

function extractSliceLocations(slice: IKtepSlice): string[] {
  return dedupeStrings(
    (slice.grounding?.spatialEvidence ?? [])
      .map(item => item.locationText?.trim())
      .filter((value): value is string => Boolean(value)),
  );
}

function buildTrimmedSelection(
  slice: IKtepSlice,
  targetDurationMs: number,
): IKtepScriptSelection {
  const preferredRange = resolveSlicePreferredRange(slice);
  const base: IKtepScriptSelection = {
    assetId: slice.assetId,
    spanId: slice.id,
    sliceId: slice.id,
    sourceInMs: preferredRange?.startMs ?? slice.sourceInMs,
    sourceOutMs: preferredRange?.endMs ?? slice.sourceOutMs,
    pharosRefs: slice.pharosRefs,
  };

  if ((slice.transcriptSegments?.length ?? 0) > 0) {
    return snapSelectionToTranscriptSegments(base, slice);
  }
  if (hasExplicitEditRange(slice)) {
    return base;
  }
  return trimSelection(base, targetDurationMs);
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
  const durationMs = end - start;
  if (durationMs <= targetDurationMs || targetDurationMs <= 0) {
    return selection;
  }

  const trimmedDuration = Math.max(1_500, Math.min(targetDurationMs, durationMs));
  const center = start + durationMs / 2;
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

function orderSegmentPackets(
  packets: ISegmentPacket[],
  orderedIds: string[],
): ISegmentPacket[] {
  const packetMap = new Map(packets.map(packet => [packet.segmentCard.id, packet]));
  const ordered = orderedIds
    .map(id => packetMap.get(id))
    .filter((packet): packet is ISegmentPacket => Boolean(packet));
  const seen = new Set(ordered.map(packet => packet.segmentCard.id));
  for (const packet of packets) {
    if (!seen.has(packet.segmentCard.id)) ordered.push(packet);
  }
  return ordered;
}

function estimatePacketDuration(packet: ISegmentPacket): number {
  const representativeCount = Math.max(packet.representativeSlices.length, 1);
  const bundleWeight = Math.max(packet.motifBundles.length, 1);
  return Math.max(8_000, representativeCount * 4_000 + bundleWeight * 2_500);
}

function mapSegmentRole(
  segmentPacket: ISegmentPacket,
  index: number,
  total: number,
): IOutlineSegment['role'] {
  if (index === 0) return 'intro';
  if (index === total - 1) return 'outro';

  const text = [
    segmentPacket.segmentCard.programPhrase,
    segmentPacket.segmentCard.segmentGoal,
    segmentPacket.segmentCard.narrativeSketch,
    ...segmentPacket.motifBundles.flatMap(bundle => bundle.compatibleLocalIntentPhrases),
  ].filter(Boolean).join(' ').toLowerCase();

  if (/(过桥|切换|地理重置|时间流逝|transition|bridge)/u.test(text)) return 'transition';
  if (/(摩擦|风险|冲突|drama|conflict|情绪拔升|highlight)/u.test(text)) return 'highlight';
  return 'scene';
}

function buildSegmentTitle(segmentPacket: ISegmentPacket, index: number): string {
  return segmentPacket.segmentCard.programPhrase
    ?? segmentPacket.segmentCard.segmentGoal
    ?? segmentPacket.segmentCard.title
    ?? `段落 ${index + 1}`;
}

function pickSegmentRole(index: number, total: number, summary: string): IOutlineSegment['role'] {
  if (index === 0) return 'intro';
  if (index === total - 1) return 'outro';
  if (/(transition|time-passage|geo-reset)/u.test(summary)) return 'transition';
  if (/(drama|conflict|emotion-release)/u.test(summary)) return 'highlight';
  return 'scene';
}

function buildFallbackTitle(index: number, total: number, summary: string): string {
  if (index === 0) return '开场素材';
  if (index === total - 1) return '收束素材';
  return summary || `段落 ${index + 1}`;
}

function summarizeSliceContexts(contexts: IOutlineSliceContext[]): string {
  const parts = contexts
    .map(context => context.summary?.trim() || context.transcript?.trim())
    .filter((value): value is string => Boolean(value));
  return parts.slice(0, 3).join(' / ') || `包含 ${contexts.length} 条代表素材`;
}

function flattenSelections(groups: IKtepScriptSelection[][]): IKtepScriptSelection[] {
  const seen = new Set<string>();
  const flattened: IKtepScriptSelection[] = [];

  for (const group of groups) {
    for (const selection of group) {
      const key = [
        selection.assetId,
        selection.spanId ?? '',
        selection.sliceId ?? '',
        selection.sourceInMs ?? '',
        selection.sourceOutMs ?? '',
      ].join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      flattened.push(selection);
    }
  }

  return flattened;
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

function compareSlices(left: IKtepSlice, right: IKtepSlice): number {
  return (resolveSlicePreferredRange(left)?.startMs ?? left.sourceInMs ?? 0)
    - (resolveSlicePreferredRange(right)?.startMs ?? right.sourceInMs ?? 0)
    || left.assetId.localeCompare(right.assetId)
    || left.id.localeCompare(right.id);
}

function getContextStartMs(context: IOutlineSliceContext): number | undefined {
  return context.editSourceInMs ?? context.sourceInMs;
}

function getContextEndMs(context: IOutlineSliceContext): number | undefined {
  return context.editSourceOutMs ?? context.sourceOutMs;
}

function takeUnique(values: string[], limit: number): string[] {
  return dedupeStrings(values).slice(0, limit);
}

function getTagCore(
  set: Partial<Pick<IKtepSlice['narrativeFunctions'], 'core'>> | undefined,
): string[] {
  return Array.isArray(set?.core) ? set.core : [];
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))];
}

function pickMinNumber(values: Array<number | undefined>): number | undefined {
  const filtered = values.filter((value): value is number => typeof value === 'number');
  return filtered.length > 0 ? Math.min(...filtered) : undefined;
}

function pickMaxNumber(values: Array<number | undefined>): number | undefined {
  const filtered = values.filter((value): value is number => typeof value === 'number');
  return filtered.length > 0 ? Math.max(...filtered) : undefined;
}
