import type { IAsrSegment, IAsrWord } from './ml-client.js';

const CSHORT_REPEAT_TOKEN_MAX_LEN = 4;
const CSHORT_REPEAT_GAP_SECONDS = 0.18;
const CMAX_SHORT_REPEAT_COUNT = 2;
const CSHORT_PAUSE_SECONDS = 0.22;
const CLONG_PAUSE_SECONDS = 0.48;
const CSEGMENT_TARGET_UNITS = 18;
const CSEGMENT_HARD_MAX_UNITS = 26;
const CMIN_BREAK_UNITS = 6;

export function normalizeAsrWords(words: IAsrWord[] = []): IAsrWord[] {
  const normalized = words
    .map(word => ({
      start: clampTime(word.start),
      end: Math.max(clampTime(word.start), clampTime(word.end)),
      text: normalizeInlineText(word.text),
    }))
    .filter(word => word.end > word.start && word.text.length > 0)
    .sort((left, right) => left.start - right.start || left.end - right.end);

  const deduped: IAsrWord[] = [];
  let repeatedCount = 0;

  for (const word of normalized) {
    const previous = deduped[deduped.length - 1];
    if (previous) {
      const previousKey = normalizeComparisonKey(previous.text);
      const currentKey = normalizeComparisonKey(word.text);
      const gapSeconds = Math.max(0, word.start - previous.end);
      if (
        previousKey
        && currentKey
        && previousKey === currentKey
        && currentKey.length <= CSHORT_REPEAT_TOKEN_MAX_LEN
        && gapSeconds <= CSHORT_REPEAT_GAP_SECONDS
      ) {
        repeatedCount += 1;
        if (repeatedCount >= CMAX_SHORT_REPEAT_COUNT) {
          continue;
        }
      } else {
        repeatedCount = 0;
      }
    } else {
      repeatedCount = 0;
    }

    deduped.push(word);
  }

  return deduped;
}

export function normalizeAsrSegments(segments: IAsrSegment[] = []): IAsrSegment[] {
  return segments
    .map(segment => {
      const start = clampTime(segment.start);
      const text = normalizeJoinedTranscriptText(segment.text);
      const rawEnd = Math.max(start, clampTime(segment.end));
      const end = text && rawEnd <= start ? start + 0.01 : rawEnd;
      return {
        start,
        end,
        text,
      };
    })
    .filter(segment => segment.end > segment.start && segment.text.length > 0)
    .filter(segment => !isObviousTranscriptHallucination(segment.text));
}

export function refineAsrSegments(input: {
  segments?: IAsrSegment[];
  words?: IAsrWord[];
}): IAsrSegment[] {
  const words = normalizeAsrWords(input.words ?? []);
  if (words.length === 0) {
    return normalizeAsrSegments(input.segments ?? []);
  }

  const refined: IAsrSegment[] = [];
  let current: IAsrWord[] = [];

  const flush = () => {
    if (current.length === 0) return;
    const text = joinTranscriptTokens(current.map(word => word.text));
    const start = current[0]?.start ?? 0;
    const end = current[current.length - 1]?.end ?? start;
    current = [];

    if (!text || end <= start || isObviousTranscriptHallucination(text)) {
      return;
    }

    refined.push({
      start,
      end,
      text,
    });
  };

  for (let index = 0; index < words.length; index += 1) {
    const word = words[index]!;
    current.push(word);

    const next = words[index + 1];
    const text = joinTranscriptTokens(current.map(item => item.text));
    const textUnits = estimateTranscriptTextUnits(text);
    const pauseAfterSeconds = next ? Math.max(0, next.start - word.end) : Number.POSITIVE_INFINITY;
    const shouldBreak
      = !next
        || pauseAfterSeconds >= CLONG_PAUSE_SECONDS
        || endsWithStrongBreak(text)
        || textUnits >= CSEGMENT_HARD_MAX_UNITS
        || (
          textUnits >= CMIN_BREAK_UNITS
          && pauseAfterSeconds >= CSHORT_PAUSE_SECONDS * 1.5
        )
        || (
          textUnits >= CSEGMENT_TARGET_UNITS
          && (pauseAfterSeconds >= CSHORT_PAUSE_SECONDS || endsWithWeakBreak(text))
        )
        || (
          endsWithWeakBreak(text)
          && textUnits >= CMIN_BREAK_UNITS
          && pauseAfterSeconds >= CSHORT_PAUSE_SECONDS / 2
        );
    if (shouldBreak) {
      flush();
    }
  }

  flush();
  if (refined.length > 0) {
    return refined;
  }

  return normalizeAsrSegments(input.segments ?? []);
}

export function buildTranscriptText(input: {
  segments?: IAsrSegment[];
  words?: IAsrWord[];
}): string {
  const words = normalizeAsrWords(input.words ?? []);
  if (words.length > 0) {
    const text = joinTranscriptTokens(words.map(word => word.text));
    if (text) return text;
  }

  return normalizeAsrSegments(input.segments ?? [])
    .map(segment => segment.text)
    .join(' ')
    .trim();
}

export function estimateTranscriptTextUnits(text: string): number {
  const normalized = normalizeJoinedTranscriptText(text);
  if (!normalized) return 0;

  const tokenPattern = /\p{Script=Han}|[A-Za-z]+(?:['’-][A-Za-z0-9]+)*|\d+(?:[.,:/-]\d+)*|[^\s\p{P}\p{S}]/gu;
  return Array.from(normalized.matchAll(tokenPattern)).length;
}

export function isObviousTranscriptHallucination(text: string): boolean {
  const normalized = normalizeJoinedTranscriptText(text);
  if (!normalized) return false;

  const compact = normalized.replace(/\s+/gu, '');
  if (compact.length < 4) return false;
  if (/^(.{1,3})\1{3,}$/u.test(compact)) return true;
  if (/^(\S{1,4})(?:\s+\1){3,}$/iu.test(normalized)) return true;
  return false;
}

function clampTime(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function normalizeInlineText(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

function normalizeJoinedTranscriptText(text: string): string {
  return text
    .replace(/\s+/gu, ' ')
    .replace(/\s+([，。！？!?；;：:、,.%])/gu, '$1')
    .replace(/([（【〈《「『“‘])\s+/gu, '$1')
    .trim();
}

function normalizeComparisonKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .trim();
}

function joinTranscriptTokens(tokens: string[]): string {
  let result = '';

  for (const token of tokens) {
    const normalized = normalizeInlineText(token);
    if (!normalized) continue;
    if (!result) {
      result = normalized;
      continue;
    }

    const previousChar = result[result.length - 1] ?? '';
    const nextChar = normalized[0] ?? '';
    result += shouldInsertSpace(previousChar, nextChar) ? ` ${normalized}` : normalized;
  }

  return normalizeJoinedTranscriptText(result);
}

function shouldInsertSpace(previousChar: string, nextChar: string): boolean {
  if (!previousChar || !nextChar) return false;
  if (isOpeningPunctuation(previousChar)) return false;
  if (isClosingPunctuation(nextChar)) return false;
  if (isCjk(previousChar) || isCjk(nextChar)) return false;
  if (isAsciiWordLike(previousChar) && isAsciiWordLike(nextChar)) return true;
  if ((/\d/u.test(previousChar) && /[A-Za-z]/u.test(nextChar)) || (/[A-Za-z]/u.test(previousChar) && /\d/u.test(nextChar))) {
    return true;
  }
  return false;
}

function isOpeningPunctuation(char: string): boolean {
  return /[（【〈《「『“‘('"$]/u.test(char);
}

function isClosingPunctuation(char: string): boolean {
  return /[）】〉》」』”’),.?!;:，。！？；：、%…]/u.test(char);
}

function isAsciiWordLike(char: string): boolean {
  return /[A-Za-z0-9]/u.test(char);
}

function isCjk(char: string): boolean {
  return /\p{Script=Han}/u.test(char);
}

function endsWithStrongBreak(text: string): boolean {
  return /[。！？!?；;…]$/u.test(text);
}

function endsWithWeakBreak(text: string): boolean {
  return /[，,：:、]$/u.test(text);
}
