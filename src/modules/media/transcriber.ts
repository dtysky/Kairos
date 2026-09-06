import type { IAlignedTranscriptToken } from '../../protocol/schema.js';
import type {
  MlClient,
  IAsrSegment,
  IAsrWord,
  IMlAsrTiming,
  IMlRequestOptions,
} from './ml-client.js';
import {
  normalizeHanTextToSimplified,
} from './chinese-transcript.js';

export interface ITranscription {
  segments: IAsrSegment[];
  words?: IAsrWord[];
  alignedTokens: IAlignedTranscriptToken[];
  fullText: string;
  timing?: IMlAsrTiming;
  roundTripMs?: number;
}

export interface ITranscribeOptions extends IMlRequestOptions {}

export async function transcribe(
  client: MlClient,
  audioPath: string,
  language?: string,
  options?: ITranscribeOptions,
): Promise<ITranscription> {
  const startedAt = Date.now();
  const result = await client.asrDetailed(audioPath, language, options);
  const roundTripMs = Date.now() - startedAt;
  const rawWords = (result.words ?? [])
    .map(word => ({
      start: Number.isFinite(word.start) ? Math.max(0, word.start) : 0,
      end: Number.isFinite(word.end) ? Math.max(0, word.end) : 0,
      text: word.text.replace(/\p{P}+/gu, '').trim(),
    }))
    .filter(word => word.text.length > 0 && word.end >= word.start);
  const fullText = normalizeHanTextToSimplified(
    result.rawText?.trim() || rawWords.map(token => token.text).join(''),
  );
  const normalizedWords = normalizeAlignedWordsWithFullContext(rawWords);
  const hasUsableTiming = normalizedWords.some(word => word.end > word.start);
  const words = hasUsableTiming ? normalizedWords : [];
  const timedWords = normalizeAlignedTimingBoundaries(words.map(word => ({
    startMs: Math.round(word.start * 1000),
    endMs: Math.round(word.end * 1000),
    text: word.text,
  })));
  const timedCharacters = expandAlignedWordsToCharacters(timedWords);
  if (timedCharacters.length > 0) {
    validateAlignedWordCoverage(fullText, timedCharacters);
  }
  const alignedTokens = timedCharacters.map((character, index): IAlignedTranscriptToken => {
    const next = timedCharacters[index + 1];
    return {
      index,
      startMs: character.startMs,
      endMs: character.endMs,
      gapAfterMs: next ? Math.max(0, next.startMs - character.endMs) : 0,
      text: character.text,
    };
  });
  return {
    segments: [],
    ...(words.length > 0 ? { words } : {}),
    alignedTokens,
    fullText,
    timing: result.timing,
    roundTripMs,
  };
}

function expandAlignedWordsToCharacters<T extends {
  startMs: number;
  endMs: number;
  text: string;
}>(words: T[]): Array<{ startMs: number; endMs: number; text: string }> {
  return words.flatMap(word => {
    const characters = Array.from(stripPunctuationAndWhitespace(word.text));
    if (characters.length === 0) return [];
    const durationMs = word.endMs - word.startMs;
    return characters.map((text, index) => ({
      startMs: word.startMs + Math.round((durationMs * index) / characters.length),
      endMs: word.startMs + Math.round((durationMs * (index + 1)) / characters.length),
      text,
    }));
  });
}

function normalizeAlignedWordsWithFullContext<T extends { text: string }>(words: T[]): T[] {
  const rawLengths = words.map(word => Array.from(word.text).length);
  const normalizedCharacters = Array.from(
    normalizeHanTextToSimplified(words.map(word => word.text).join('')),
  );
  const expectedLength = rawLengths.reduce((sum, length) => sum + length, 0);
  if (normalizedCharacters.length !== expectedLength) {
    throw new Error(
      `简体转换改变了 ForcedAligner token 数：转换前=${expectedLength} 转换后=${normalizedCharacters.length}`,
    );
  }
  let cursor = 0;
  return words.map((word, index) => {
    const length = rawLengths[index] ?? 0;
    const text = normalizedCharacters.slice(cursor, cursor + length).join('');
    cursor += length;
    return { ...word, text };
  });
}

function validateAlignedWordCoverage(
  rawText: string,
  words: Array<{ startMs: number; endMs: number; text: string }>,
): void {
  for (const [index, word] of words.entries()) {
    if (word.endMs < word.startMs) {
      throw new Error(`ForcedAligner token ${index} 时间范围无效`);
    }
    const next = words[index + 1];
    if (next && next.startMs < word.endMs) {
      throw new Error(`ForcedAligner token ${index} 与 ${index + 1} 时间重叠`);
    }
  }
  const expected = stripPunctuationAndWhitespace(rawText);
  const actual = stripPunctuationAndWhitespace(words.map(word => word.text).join(''));
  if (actual !== expected) {
    throw new Error(
      `ForcedAligner 字符覆盖不完整：ASR=${JSON.stringify(expected)} aligned=${JSON.stringify(actual)}`,
    );
  }
}

function normalizeAlignedTimingBoundaries<T extends { startMs: number; endMs: number }>(
  words: T[],
): T[] {
  const normalized = words.map(word => ({ ...word }));
  for (let index = 0; index < normalized.length - 1; index += 1) {
    const left = normalized[index]!;
    const right = normalized[index + 1]!;
    if (left.endMs <= right.startMs) continue;
    if (left.startMs > right.endMs) {
      throw new Error(`ForcedAligner token ${index} 与 ${index + 1} 时间顺序倒置`);
    }
    const midpoint = Math.round((left.endMs + right.startMs) / 2);
    const boundary = Math.max(left.startMs, Math.min(right.endMs, midpoint));
    left.endMs = boundary;
    right.startMs = boundary;
  }
  return normalized;
}

function stripPunctuationAndWhitespace(value: string): string {
  return value.replace(/[\s\p{P}]+/gu, '');
}
