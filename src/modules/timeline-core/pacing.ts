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
import { estimateTranscriptTextUnits } from '../media/refined-transcript.js';

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

type ITranscriptSegment = NonNullable<IKtepSlice['transcriptSegments']>[number];

const CDEFAULTS: ISpeechPacingConfig = {
  maxCharsPerCue: 20,
  cjkCharsPerSecond: 3.8,
  latinWordsPerSecond: 2.8,
  digitGroupsPerSecond: 2.4,
  shortPauseMs: 180,
  longPauseMs: 320,
  minCueDurationMs: 1100,
};

const CSOURCE_SPEECH_SHORT_GAP_MS = 3000;
const CSOURCE_SPEECH_HEAD_BREATHING_MS = 120;
const CSOURCE_SPEECH_TAIL_BREATHING_MS = 180;
const CNON_SPOKEN_TRANSCRIPT_PATTERNS: RegExp[] = [
  /(?:(?:拍摄|拍攝|录制|錄製|录像|錄像)(?:启动|啟動|开始|開始|停止|结束|結束)|(?:启动|啟動|开始|開始|停止|结束|結束)(?:拍摄|拍攝|录制|錄製|录像|錄像))/u,
  /指令(?:执行|執行)中/u,
  /限制解除/u,
  /全力战斗模式/u,
  /(?:请|請)?集中注意力/u,
  /(?:保持|请保持|請保持)(?:左侧|左側|右侧|右側).{0,10}(?:主路|行驶|行駛|形式)/u,
  /^(?:进入|進入).{0,20}隧道$/u,
  /沿.+继续行驶\d+(?:\.\d+)?公里/u,
  /前方\d+(?:米|公里)/u,
  /(?:限速|線速)\d+/u,
];

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
  const sliceMap = new Map(slices.map(slice => [slice.id, slice]));

  return script.map(segment => {
    if (!segment.beats || segment.beats.length === 0) {
      return normalizeLegacySegmentTiming(segment, sliceMap, config);
    }

    const beats = segment.beats.map(beat => normalizeBeatTiming(segment, beat, sliceMap, config));
    return {
      ...segment,
      beats,
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

    const transcriptSegments = filterSourceSpeechTranscriptSegments(
      slice.transcriptSegments ?? [],
      { startMs: sourceInMs, endMs: sourceOutMs },
    );
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
  if (speechContext.transcriptSegmentCount === 0) return false;
  const transcriptText = normalizeComparisonText(speechContext.transcriptText);
  if (!transcriptText) return false;
  if (shouldPreserveNaturalSound(segment, beat)) return true;
  if (speechContext.dominantSliceType === 'talking-head') {
    return true;
  }

  return speechContext.speechCoverage >= 0.08;
}

export function shouldPreserveNaturalSound(
  segment: Pick<IKtepScript, 'actions'>,
  beat: Pick<IKtepScriptBeat, 'actions'>,
): boolean {
  if (beat.actions?.muteSource === true || segment.actions?.muteSource === true) {
    return false;
  }
  return beat.actions?.preserveNatSound === true || segment.actions?.preserveNatSound === true;
}

export function filterSourceSpeechTranscriptSegments(
  transcriptSegments: ITranscriptSegment[] = [],
  range?: { startMs: number; endMs: number },
): ITranscriptSegment[] {
  return findOverlappingTranscriptSegments(transcriptSegments, range)
    .filter(segment => isSpokenTranscriptSegment(segment.text));
}

export function splitCueChunks(text: string, maxChars: number): string[] {
  const strongUnits = splitWithDelimiters(text, /([。！？!?；;])/);
  const chunks: string[] = [];

  for (const unit of strongUnits) {
    const normalized = unit.trim();
    if (!normalized) continue;

    if (measureCueTextUnits(normalized) <= maxChars) {
      chunks.push(normalized);
      continue;
    }

    const weakUnits = splitWithDelimiters(normalized, /([，,])/);
    let buffer = '';

    for (const weak of weakUnits) {
      const part = weak.trim();
      if (!part) continue;

      if (buffer.length > 0 && measureCueTextUnits(buffer) + measureCueTextUnits(part) > maxChars) {
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

  return rebalanceShortChunks(
    chunks.flatMap(chunk => hardSplitCueChunk(chunk, maxChars)),
    maxChars,
  );
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
  _config: Partial<ISpeechPacingConfig>,
): IKtepScriptBeat {
  const speechContext = buildSourceSpeechContext(beat.audioSelections, sliceMap);
  if (shouldPreferSourceSpeech(segment, beat, speechContext)) {
    const normalizedSelections = normalizeSourceSpeechSelections(beat.audioSelections, sliceMap);
    if (!haveSelectionWindowsChanged(beat.audioSelections, normalizedSelections)) {
      return beat;
    }

    return {
      ...beat,
      audioSelections: normalizedSelections,
    };
  }

  return beat;
}

function normalizeLegacySegmentTiming(
  segment: IKtepScript,
  sliceMap: Map<string, IKtepSlice>,
  _config: Partial<ISpeechPacingConfig>,
): IKtepScript {
  const narration = segment.narration?.trim();
  if (!narration) return segment;

  const legacyBeat: IKtepScriptBeat = {
    id: `${segment.id}-legacy-beat`,
    text: narration,
    actions: segment.actions,
    audioSelections: segment.selections ?? [],
    visualSelections: segment.selections ?? [],
    linkedSpanIds: segment.linkedSpanIds,
    linkedSliceIds: segment.linkedSliceIds,
  };
  const speechContext = buildSourceSpeechContext(legacyBeat.audioSelections, sliceMap);
  if (shouldPreferSourceSpeech(segment, legacyBeat, speechContext)) {
    const normalizedSelections = normalizeSourceSpeechSelections(legacyBeat.audioSelections, sliceMap);
    if (!haveSelectionWindowsChanged(segment.selections ?? [], normalizedSelections)) {
      return segment;
    }

    return {
      ...segment,
      selections: normalizedSelections,
    };
  }

  return segment;
}

function resolveBeatTargetDurationMs(
  beat: IKtepScriptBeat,
  sliceMap: Map<string, IKtepSlice>,
  config: ISpeechPacingConfig,
): number {
  if (typeof beat.targetDurationMs === 'number' && beat.targetDurationMs > 0) {
    return beat.targetDurationMs;
  }

  const selectionDurationMs = beat.visualSelections.reduce((sum, selection) => {
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
      && measureCueTextUnits(current) <= 6
      && measureCueTextUnits(previous) + measureCueTextUnits(current) <= maxChars + 4
    ) {
      result[result.length - 1] = `${previous}${current}`;
      continue;
    }

    result.push(current);
  }

  return result;
}

function hardSplitCueChunk(chunk: string, maxChars: number): string[] {
  const normalized = chunk.trim();
  if (!normalized) return [];
  if (measureCueTextUnits(normalized) <= maxChars) return [normalized];

  const chars = Array.from(normalized);
  const result: string[] = [];
  let index = 0;

  while (index < chars.length) {
    let end = Math.min(chars.length, index + maxChars);
    if (end < chars.length) {
      const preferred = findCueBoundary(chars, index, end);
      if (preferred > index) {
        end = preferred;
      }
    }

    result.push(chars.slice(index, end).join('').trim());
    index = end;
  }

  return result.filter(Boolean);
}

function findCueBoundary(chars: string[], start: number, end: number): number {
  for (let index = end; index > start; index -= 1) {
    const previous = chars[index - 1] ?? '';
    const next = chars[index] ?? '';
    if (/[\s，,。！？!?；;：:、]/u.test(previous) || /[\s，,。！？!?；;：:、]/u.test(next)) {
      return index;
    }
  }
  return end;
}

function resolveSourceDuration(sourceInMs?: number, sourceOutMs?: number): number | undefined {
  if (sourceInMs == null || sourceOutMs == null) return undefined;
  if (sourceOutMs <= sourceInMs) return undefined;
  return sourceOutMs - sourceInMs;
}

function measureCueTextUnits(text: string): number {
  return estimateTranscriptTextUnits(text);
}

export function normalizeSourceSpeechSelections(
  selections: IKtepScriptSelection[],
  sliceMap: Map<string, IKtepSlice>,
): IKtepScriptSelection[] {
  const spokenSelections: IKtepScriptSelection[] = [];
  const fallbackSelections: IKtepScriptSelection[] = [];
  let sawTranscriptOverlap = false;

  for (const selection of selections) {
    const slice = selection.sliceId ? sliceMap.get(selection.sliceId) : undefined;
    const resolution = resolveSelectionSpeechIslands(selection, slice);
    if (resolution.hadTranscriptOverlap) {
      sawTranscriptOverlap = true;
    }

    if (resolution.islands.length > 0) {
      spokenSelections.push(...resolution.islands.map(island => ({
      ...selection,
      sourceInMs: island.startMs,
      sourceOutMs: island.endMs,
      })));
      continue;
    }

    if (!resolution.hadTranscriptOverlap) {
      fallbackSelections.push(snapSelectionToTranscriptSegments(selection, slice));
    }
  }

  if (spokenSelections.length > 0) {
    return spokenSelections;
  }

  if (sawTranscriptOverlap) {
    return [];
  }

  if (fallbackSelections.length > 0) {
    return fallbackSelections;
  }

  return selections.map(selection => {
    const slice = selection.sliceId ? sliceMap.get(selection.sliceId) : undefined;
    return snapSelectionToTranscriptSegments(selection, slice);
  });
}

function resolveSelectionSpeechIslands(
  selection: IKtepScriptSelection,
  slice?: Pick<
    IKtepSlice,
    'sourceInMs' | 'sourceOutMs' | 'editSourceInMs' | 'editSourceOutMs' | 'transcriptSegments'
  >,
) : {
  islands: Array<{ startMs: number; endMs: number }>;
  hadTranscriptOverlap: boolean;
} {
  const selectionRange = resolveSelectionRange(selection, slice);
  if (!selectionRange) {
    return {
      islands: [],
      hadTranscriptOverlap: false,
    };
  }

  const overlappingSegments = findOverlappingTranscriptSegments(
    slice?.transcriptSegments ?? [],
    selectionRange,
  );
  if (overlappingSegments.length === 0) {
    const transcriptRange = resolveSelectionTranscriptRange(selection, slice);
    return {
      islands: transcriptRange ? [transcriptRange] : [],
      hadTranscriptOverlap: false,
    };
  }

  const spokenSegments = overlappingSegments.filter(segment => isSpokenTranscriptSegment(segment.text));
  if (spokenSegments.length === 0) {
    return {
      islands: [],
      hadTranscriptOverlap: true,
    };
  }

  return {
    islands: mergeTranscriptSegmentsToSpeechIslands(spokenSegments, selectionRange)
      .filter(island => island.endMs > island.startMs),
    hadTranscriptOverlap: true,
  };
}

function mergeTranscriptSegmentsToSpeechIslands(
  segments: ITranscriptSegment[],
  selectionRange: { startMs: number; endMs: number },
): Array<{ startMs: number; endMs: number }> {
  const islands: Array<{ startMs: number; endMs: number }> = [];
  let current: { startMs: number; endMs: number; tailText: string } | null = null;

  for (const segment of segments) {
    if (!current) {
      current = {
        startMs: segment.startMs,
        endMs: segment.endMs,
        tailText: segment.text,
      };
      continue;
    }

    if (
      segment.startMs - current.endMs <= CSOURCE_SPEECH_SHORT_GAP_MS
      && !endsWithStrongSentenceBoundary(current.tailText)
    ) {
      current.endMs = Math.max(current.endMs, segment.endMs);
      current.tailText = segment.text;
      continue;
    }

    islands.push(applySpeechIslandBreathing(current, selectionRange));
    current = {
      startMs: segment.startMs,
      endMs: segment.endMs,
      tailText: segment.text,
    };
  }

  if (current) {
    islands.push(applySpeechIslandBreathing(current, selectionRange));
  }

  return islands;
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

function findOverlappingTranscriptSegments(
  transcriptSegments: ITranscriptSegment[] = [],
  range?: { startMs: number; endMs: number },
): ITranscriptSegment[] {
  if (!range) return [];

  return transcriptSegments
    .filter(segment =>
      Math.min(range.endMs, segment.endMs) > Math.max(range.startMs, segment.startMs)
      && sanitizeSubtitleCueText(segment.text).length > 0,
    )
    .sort((left, right) => left.startMs - right.startMs);
}

function isSpokenTranscriptSegment(text: string): boolean {
  const normalized = sanitizeSubtitleCueText(text)
    .replace(/\s+/gu, '')
    .trim();
  if (!normalized) return false;

  return !CNON_SPOKEN_TRANSCRIPT_PATTERNS.some(pattern => pattern.test(normalized));
}

function applySpeechIslandBreathing(
  island: { startMs: number; endMs: number },
  selectionRange: { startMs: number; endMs: number },
): { startMs: number; endMs: number } {
  return {
    startMs: Math.max(selectionRange.startMs, island.startMs - CSOURCE_SPEECH_HEAD_BREATHING_MS),
    endMs: Math.min(selectionRange.endMs, island.endMs + CSOURCE_SPEECH_TAIL_BREATHING_MS),
  };
}

function endsWithStrongSentenceBoundary(text: string | undefined): boolean {
  const normalized = (text ?? '').trim()
    .replace(/[」』”’）】〉》]+$/u, '');
  if (!normalized) return false;
  return /[。！？!?；;]$/u.test(normalized);
}
