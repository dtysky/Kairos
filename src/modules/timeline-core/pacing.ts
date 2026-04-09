import type {
  IKtepScript,
  IKtepScriptBeat,
  IKtepScriptSelection,
  IKtepSlice,
} from '../../protocol/schema.js';
import {
  resolveSelectionRange,
  resolveSelectionTranscriptRange,
  snapSelectionToTranscriptSegments,
} from '../media/window-policy.js';

export interface ISpeechPacingConfig {
  maxCharsPerCue: number;
  cjkCharsPerSecond: number;
  latinWordsPerSecond: number;
  digitGroupsPerSecond: number;
  shortPauseMs: number;
  longPauseMs: number;
  minCueDurationMs: number;
}

export interface ISourceSpeechContext {
  dominantSliceType?: IKtepSlice['type'];
  speechCoverage: number;
  transcriptSegmentCount: number;
  transcriptText: string;
}

export interface ISpeechWindowSelection extends Pick<
  IKtepScriptSelection,
  'sliceId' | 'sourceInMs' | 'sourceOutMs'
> {}

export interface INarrationCuePlan {
  text: string;
  durationMs: number;
}

export interface INarrationUtterancePlan {
  text: string;
  pauseBeforeMs: number;
  pauseAfterMs: number;
  cuePlans: INarrationCuePlan[];
  speechDurationMs: number;
  startOffsetMs: number;
  endOffsetMs: number;
}

export interface INarrationBeatPlan {
  text: string;
  utterances: INarrationUtterancePlan[];
  totalDurationMs: number;
}

interface IResolvedUtterance {
  text: string;
  pauseBeforeMs: number;
  pauseAfterMs: number;
}

const CDEFAULTS: ISpeechPacingConfig = {
  maxCharsPerCue: 20,
  cjkCharsPerSecond: 3.8,
  latinWordsPerSecond: 2.8,
  digitGroupsPerSecond: 2.4,
  shortPauseMs: 180,
  longPauseMs: 320,
  minCueDurationMs: 1100,
};

export function resolveSpeechPacingConfig(
  config: Partial<ISpeechPacingConfig> = {},
): ISpeechPacingConfig {
  return { ...CDEFAULTS, ...config };
}

export function normalizeScriptTiming(
  script: IKtepScript[],
  slices: IKtepSlice[],
  config: Partial<ISpeechPacingConfig> = {},
): IKtepScript[] {
  const cfg = resolveSpeechPacingConfig(config);
  const sliceMap = new Map(slices.map(slice => [slice.id, slice]));

  return script.map(segment => {
    if (!segment.beats || segment.beats.length === 0) {
      return normalizeLegacySegmentTiming(segment, sliceMap, cfg);
    }

    const beats = segment.beats.map(beat => normalizeBeatTiming(segment, beat, sliceMap, cfg));
    const aggregateDurationMs = beats.reduce(
      (sum, beat) => sum + resolveBeatTargetDurationMs(beat, sliceMap, cfg),
      0,
    );
    const currentTargetDurationMs = segment.targetDurationMs ?? 0;

    return {
      ...segment,
      beats,
      ...(aggregateDurationMs > 0 && {
        targetDurationMs: Math.max(currentTargetDurationMs, aggregateDurationMs),
      }),
    };
  });
}

export function resolveBeatNarrationText(
  beat: Pick<IKtepScriptBeat, 'text' | 'utterances'>,
): string {
  const directText = beat.text.trim();
  if (directText) return directText;

  return resolveBeatUtterances(beat)
    .map(utterance => utterance.text)
    .join('');
}

export function buildNarrationBeatPlan(
  beat: Pick<IKtepScriptBeat, 'text' | 'utterances'>,
  config: Partial<ISpeechPacingConfig> = {},
): INarrationBeatPlan {
  const cfg = resolveSpeechPacingConfig(config);
  const utterances = resolveBeatUtterances(beat);
  const plans: INarrationUtterancePlan[] = [];
  let cursor = 0;

  for (const utterance of utterances) {
    const cueTexts = splitCueChunks(utterance.text, cfg.maxCharsPerCue);
    const cueDurations = estimateCueDurations(cueTexts, cfg);
    const cuePlans = cueTexts
      .map((text, index) => ({
        text: sanitizeSubtitleCueText(text),
        durationMs: cueDurations[index] ?? 0,
      }))
      .filter(cue => cue.text && cue.durationMs > 0);
    if (cuePlans.length === 0) continue;

    const speechDurationMs = cuePlans.reduce((sum, cue) => sum + cue.durationMs, 0);
    const startOffsetMs = cursor + utterance.pauseBeforeMs;
    const endOffsetMs = startOffsetMs + speechDurationMs;

    plans.push({
      text: utterance.text,
      pauseBeforeMs: utterance.pauseBeforeMs,
      pauseAfterMs: utterance.pauseAfterMs,
      cuePlans,
      speechDurationMs,
      startOffsetMs,
      endOffsetMs,
    });
    cursor = endOffsetMs + utterance.pauseAfterMs;
  }

  return {
    text: resolveBeatNarrationText(beat),
    utterances: plans,
    totalDurationMs: cursor,
  };
}

export function estimateNarrationBeatDurationMs(
  input: string | Pick<IKtepScriptBeat, 'text' | 'utterances'>,
  config: Partial<ISpeechPacingConfig> = {},
): number {
  const beat = typeof input === 'string'
    ? { text: input, utterances: undefined }
    : input;
  return buildNarrationBeatPlan(beat, config).totalDurationMs;
}

export function estimateNarrationDurationMs(
  text: string,
  config: Partial<ISpeechPacingConfig> = {},
): number {
  const cfg = resolveSpeechPacingConfig(config);
  const trimmed = text.trim();
  if (!trimmed) return 0;

  const cjkCharCount = countMatches(trimmed, /\p{Script=Han}/gu);
  const latinWordCount = countMatches(trimmed, /[A-Za-z]+(?:['’-][A-Za-z]+)*/g);
  const digitGroupCount = countMatches(trimmed, /\d+(?:[.,:/-]\d+)*/g);
  const shortPauseCount = countMatches(trimmed, /[，、；：,;:\n]/g);
  const longPauseCount = countMatches(trimmed, /[。！？!?]|…+|\.{3,}/g);

  const lexicalDurationMs
    = (cjkCharCount / cfg.cjkCharsPerSecond) * 1000
      + (latinWordCount / cfg.latinWordsPerSecond) * 1000
      + (digitGroupCount / cfg.digitGroupsPerSecond) * 1000;
  const pauseDurationMs
    = shortPauseCount * cfg.shortPauseMs
      + longPauseCount * cfg.longPauseMs;

  return Math.max(
    cfg.minCueDurationMs,
    Math.round(lexicalDurationMs + pauseDurationMs),
  );
}

export function estimateCueDurations(
  cueTexts: string[],
  config: Partial<ISpeechPacingConfig> = {},
): number[] {
  const cfg = resolveSpeechPacingConfig(config);

  return cueTexts
    .map(text => estimateNarrationDurationMs(text, cfg))
    .filter(durationMs => durationMs > 0);
}

export function buildSourceSpeechContext(
  selections: ISpeechWindowSelection[],
  sliceMap: Map<string, IKtepSlice>,
): ISourceSpeechContext {
  const transcriptParts: string[] = [];
  const typeWeights = new Map<IKtepSlice['type'], number>();
  let transcriptSegmentCount = 0;
  let totalWindowMs = 0;
  let spokenWindowMs = 0;

  for (const selection of selections) {
    const slice = selection.sliceId ? sliceMap.get(selection.sliceId) : undefined;
    if (!slice) continue;

    const selectionRange = resolveSelectionRange(selection, slice);
    const sourceInMs = selectionRange?.startMs ?? 0;
    const sourceOutMs = selectionRange?.endMs ?? sourceInMs;
    const windowDurationMs = Math.max(0, sourceOutMs - sourceInMs);

    if (windowDurationMs > 0) {
      totalWindowMs += windowDurationMs;
      typeWeights.set(slice.type, (typeWeights.get(slice.type) ?? 0) + windowDurationMs);
    }

    const transcriptSegments = slice.transcriptSegments ?? [];
    if (transcriptSegments.length === 0) continue;

    for (const transcriptSegment of transcriptSegments) {
      const overlapStart = Math.max(sourceInMs, transcriptSegment.startMs);
      const overlapEnd = Math.min(sourceOutMs, transcriptSegment.endMs);
      if (overlapEnd <= overlapStart) continue;

      const normalizedText = sanitizeSubtitleCueText(transcriptSegment.text);
      if (!normalizedText) continue;

      transcriptParts.push(normalizedText);
      transcriptSegmentCount += 1;
      spokenWindowMs += overlapEnd - overlapStart;
    }
  }

  let dominantSliceType: IKtepSlice['type'] | undefined;
  let dominantWeight = -1;
  for (const [sliceType, weight] of typeWeights.entries()) {
    if (weight > dominantWeight) {
      dominantSliceType = sliceType;
      dominantWeight = weight;
    }
  }

  return {
    dominantSliceType,
    speechCoverage: totalWindowMs > 0 ? Math.min(1, spokenWindowMs / totalWindowMs) : 0,
    transcriptSegmentCount,
    transcriptText: transcriptParts.join(' '),
  };
}

export function shouldPreferSourceSpeech(
  segment: Pick<IKtepScript, 'role' | 'actions'>,
  beat: Pick<IKtepScriptBeat, 'text' | 'utterances' | 'actions'>,
  speechContext: ISourceSpeechContext,
): boolean {
  if (beat.actions?.muteSource === true || segment.actions?.muteSource === true) {
    return false;
  }
  if (beat.actions?.preserveNatSound === true) return true;
  if (segment.actions?.preserveNatSound === true) return true;
  if (speechContext.transcriptSegmentCount === 0) return false;
  if (speechContext.speechCoverage < 0.18) return false;

  const beatText = normalizeComparisonText(resolveBeatNarrationText(beat));
  if (!beatText) return true;

  const transcriptText = normalizeComparisonText(speechContext.transcriptText);
  if (!transcriptText) return false;

  if (hasStrongTranscriptContainment(beatText, transcriptText)) {
    return true;
  }

  const matchScore = computeTranscriptMatchScore(beatText, transcriptText);
  if (beatText.length >= 6 && matchScore >= 0.6) return true;

  if (segment.role === 'intro' || segment.role === 'transition' || segment.role === 'outro') {
    return false;
  }

  if (speechContext.dominantSliceType === 'talking-head') {
    return speechContext.speechCoverage >= 0.42 && matchScore >= 0.18;
  }

  return speechContext.speechCoverage >= 0.72 && matchScore >= 0.3;
}

export function splitCueChunks(text: string, maxChars: number): string[] {
  const strongUnits = splitWithDelimiters(text, /([。！？!?；;])/);
  const chunks: string[] = [];

  for (const unit of strongUnits) {
    const normalized = unit.trim();
    if (!normalized) continue;

    if (normalized.length <= maxChars) {
      chunks.push(normalized);
      continue;
    }

    const weakUnits = splitWithDelimiters(normalized, /([，,])/);
    let buffer = '';

    for (const weak of weakUnits) {
      const part = weak.trim();
      if (!part) continue;

      if (buffer.length > 0 && buffer.length + part.length > maxChars) {
        chunks.push(buffer.trim());
        buffer = part;
      } else {
        buffer += part;
      }
    }

    if (buffer.trim()) {
      chunks.push(buffer.trim());
    }
  }

  return rebalanceShortChunks(chunks, maxChars);
}

export function sanitizeSubtitleCueText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return '';
  if (/—{2,}$/.test(trimmed)) return trimmed;

  return trimmed
    .replace(/([。！？!?；;，,：:、……\.]+)([」』”’）】〉》]*)$/u, '$2')
    .trim();
}

function normalizeBeatTiming(
  segment: IKtepScript,
  beat: IKtepScriptBeat,
  sliceMap: Map<string, IKtepSlice>,
  config: ISpeechPacingConfig,
): IKtepScriptBeat {
  const speechContext = buildSourceSpeechContext(beat.selections, sliceMap);
  if (shouldPreferSourceSpeech(segment, beat, speechContext)) {
    const normalizedSelections = normalizeSourceSpeechSelections(beat.selections, sliceMap);
    const targetDurationMs = sumSelectionDurationsMs(normalizedSelections, sliceMap);
    if (
      targetDurationMs === (beat.targetDurationMs ?? 0)
      && !haveSelectionWindowsChanged(beat.selections, normalizedSelections)
    ) {
      return beat;
    }

    return {
      ...beat,
      selections: normalizedSelections,
      ...(targetDurationMs > 0 && { targetDurationMs }),
    };
  }

  const estimatedDurationMs = buildNarrationBeatPlan(beat, config).totalDurationMs;
  if (estimatedDurationMs <= 0) return beat;

  const targetDurationMs = Math.max(beat.targetDurationMs ?? 0, estimatedDurationMs);
  if (targetDurationMs === beat.targetDurationMs) {
    return beat;
  }

  return {
    ...beat,
    targetDurationMs,
  };
}

function normalizeLegacySegmentTiming(
  segment: IKtepScript,
  sliceMap: Map<string, IKtepSlice>,
  config: ISpeechPacingConfig,
): IKtepScript {
  const narration = segment.narration?.trim();
  if (!narration) return segment;

  const legacyBeat: IKtepScriptBeat = {
    id: `${segment.id}-legacy-beat`,
    text: narration,
    actions: segment.actions,
    selections: segment.selections ?? [],
    linkedSpanIds: segment.linkedSpanIds,
    linkedSliceIds: segment.linkedSliceIds,
  };
  const speechContext = buildSourceSpeechContext(legacyBeat.selections, sliceMap);
  if (shouldPreferSourceSpeech(segment, legacyBeat, speechContext)) {
    const normalizedSelections = normalizeSourceSpeechSelections(legacyBeat.selections, sliceMap);
    const targetDurationMs = sumSelectionDurationsMs(normalizedSelections, sliceMap);
    if (
      targetDurationMs === (segment.targetDurationMs ?? 0)
      && !haveSelectionWindowsChanged(segment.selections ?? [], normalizedSelections)
    ) {
      return segment;
    }

    return {
      ...segment,
      selections: normalizedSelections,
      ...(targetDurationMs > 0 && { targetDurationMs }),
    };
  }

  const estimatedDurationMs = estimateNarrationBeatDurationMs(narration, config);
  if (estimatedDurationMs <= 0) return segment;

  const targetDurationMs = Math.max(segment.targetDurationMs ?? 0, estimatedDurationMs);
  if (targetDurationMs === segment.targetDurationMs) {
    return segment;
  }

  return {
    ...segment,
    targetDurationMs,
  };
}

function resolveBeatTargetDurationMs(
  beat: IKtepScriptBeat,
  sliceMap: Map<string, IKtepSlice>,
  config: ISpeechPacingConfig,
): number {
  if (typeof beat.targetDurationMs === 'number' && beat.targetDurationMs > 0) {
    return beat.targetDurationMs;
  }

  const selectionDurationMs = beat.selections.reduce((sum, selection) => {
    const slice = selection.sliceId ? sliceMap.get(selection.sliceId) : undefined;
    const sourceInMs = selection.sourceInMs ?? slice?.sourceInMs;
    const sourceOutMs = selection.sourceOutMs ?? slice?.sourceOutMs;
    const durationMs = resolveSourceDuration(sourceInMs, sourceOutMs) ?? 0;
    return sum + durationMs;
  }, 0);
  if (selectionDurationMs > 0) return selectionDurationMs;

  return estimateNarrationBeatDurationMs(beat, config);
}

function resolveBeatUtterances(
  beat: Pick<IKtepScriptBeat, 'text' | 'utterances'>,
): IResolvedUtterance[] {
  const explicitUtterances = Array.isArray(beat.utterances)
    ? beat.utterances
      .map(utterance => ({
        text: utterance.text.trim(),
        pauseBeforeMs: Math.max(0, utterance.pauseBeforeMs ?? 0),
        pauseAfterMs: Math.max(0, utterance.pauseAfterMs ?? 0),
      }))
      .filter(utterance => utterance.text.length > 0)
    : [];
  if (explicitUtterances.length > 0) return explicitUtterances;

  const fallbackText = beat.text.trim();
  if (!fallbackText) return [];

  return [{
    text: fallbackText,
    pauseBeforeMs: 0,
    pauseAfterMs: 0,
  }];
}

function countMatches(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0;
}

function computeTranscriptMatchScore(beatText: string, transcriptText: string): number {
  const beatTokens = tokenizeComparisonText(beatText);
  const transcriptTokens = tokenizeComparisonText(transcriptText);
  const tokenScore = computeDirectionalOverlap(beatTokens, transcriptTokens);

  const beatNgrams = buildCharacterNgrams(beatText);
  const transcriptNgrams = buildCharacterNgrams(transcriptText);
  const ngramScore = computeDirectionalOverlap(beatNgrams, transcriptNgrams);

  return Math.max(tokenScore, ngramScore);
}

function hasStrongTranscriptContainment(beatText: string, transcriptText: string): boolean {
  const shorterLength = Math.min(beatText.length, transcriptText.length);
  if (shorterLength < 6) return false;
  return transcriptText.includes(beatText) || beatText.includes(transcriptText);
}

function tokenizeComparisonText(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9一-龥]+/u)
    .map(token => token.trim())
    .filter(token => token.length >= 2);
}

function buildCharacterNgrams(text: string, size = 2): string[] {
  const normalized = text
    .toLowerCase()
    .replace(/[^a-z0-9一-龥]+/gu, '');
  if (normalized.length === 0) return [];
  if (normalized.length <= size) return [normalized];

  const grams: string[] = [];
  for (let index = 0; index <= normalized.length - size; index++) {
    grams.push(normalized.slice(index, index + size));
  }
  return grams;
}

function computeDirectionalOverlap(source: string[], target: string[]): number {
  if (source.length === 0 || target.length === 0) return 0;

  const targetSet = new Set(target);
  const uniqueSource = Array.from(new Set(source));
  let hitCount = 0;

  for (const item of uniqueSource) {
    if (targetSet.has(item)) hitCount += 1;
  }

  return hitCount / uniqueSource.length;
}

function normalizeComparisonText(text: string | undefined): string {
  return (text ?? '')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .trim();
}

function splitWithDelimiters(text: string, delimiter: RegExp): string[] {
  const parts = text.split(delimiter);
  const result: string[] = [];

  for (let index = 0; index < parts.length; index += 2) {
    const body = parts[index] ?? '';
    const tail = parts[index + 1] ?? '';
    const combined = `${body}${tail}`.trim();
    if (combined) {
      result.push(combined);
    }
  }

  return result;
}

function rebalanceShortChunks(chunks: string[], maxChars: number): string[] {
  if (chunks.length <= 1) return chunks;

  const result: string[] = [];
  for (const chunk of chunks) {
    const current = chunk.trim();
    if (!current) continue;

    const previous = result[result.length - 1];
    if (
      previous
      && current.length <= 6
      && previous.length + current.length <= maxChars + 4
    ) {
      result[result.length - 1] = `${previous}${current}`;
      continue;
    }

    result.push(current);
  }

  return result;
}

function resolveSourceDuration(sourceInMs?: number, sourceOutMs?: number): number | undefined {
  if (sourceInMs == null || sourceOutMs == null) return undefined;
  if (sourceOutMs <= sourceInMs) return undefined;
  return sourceOutMs - sourceInMs;
}

export function normalizeSourceSpeechSelections(
  selections: IKtepScriptSelection[],
  sliceMap: Map<string, IKtepSlice>,
): IKtepScriptSelection[] {
  const transcriptSelections = selections.flatMap(selection => {
    const slice = selection.sliceId ? sliceMap.get(selection.sliceId) : undefined;
    const transcriptRange = resolveSelectionTranscriptRange(selection, slice);
    if (!transcriptRange) return [];

    return [{
      ...selection,
      sourceInMs: transcriptRange.startMs,
      sourceOutMs: transcriptRange.endMs,
    }];
  });

  if (transcriptSelections.length > 0) {
    return transcriptSelections;
  }

  return selections.map(selection => {
    const slice = selection.sliceId ? sliceMap.get(selection.sliceId) : undefined;
    return snapSelectionToTranscriptSegments(selection, slice);
  });
}

function sumSelectionDurationsMs(
  selections: IKtepScriptSelection[],
  sliceMap: Map<string, IKtepSlice>,
): number {
  return selections.reduce((sum, selection) => {
    const slice = selection.sliceId ? sliceMap.get(selection.sliceId) : undefined;
    const range = resolveSelectionRange(selection, slice);
    if (!range) return sum;
    return sum + Math.max(0, range.endMs - range.startMs);
  }, 0);
}

function haveSelectionWindowsChanged(
  before: IKtepScriptSelection[],
  after: IKtepScriptSelection[],
): boolean {
  if (before.length !== after.length) return true;

  for (let index = 0; index < before.length; index += 1) {
    const previous = before[index];
    const next = after[index];
    if (!previous || !next) return true;
    if (previous.assetId !== next.assetId || previous.sliceId !== next.sliceId) return true;
    if (previous.sourceInMs !== next.sourceInMs || previous.sourceOutMs !== next.sourceOutMs) {
      return true;
    }
  }

  return false;
}
