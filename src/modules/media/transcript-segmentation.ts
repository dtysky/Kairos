import type {
  IAlignedTranscriptToken,
  ITranscriptSegmentation,
  ITranscriptSegment,
} from '../../protocol/schema.js';
import { validateAndRepairAlignedTokenTiming } from './aligned-token-timing.js';

export const CTRANSCRIPT_SEGMENTATION_POLICY_VERSION = 'asr-punctuation-gap-v1';
export const CTRANSCRIPT_SEGMENTATION_MAX_CHARACTERS = 36;
export const CTRANSCRIPT_SEGMENTATION_MERGE_GAP_MS = 1500;

export interface ITranscriptSegmentationResult {
  alignedTokens: IAlignedTranscriptToken[];
  transcript: string;
  segments: ITranscriptSegment[];
  segmentation: ITranscriptSegmentation;
}

interface ISegmentDraft {
  startToken: number;
  endToken: number;
  text: string;
}

export function segmentAlignedTranscript(input: {
  assetId: string;
  rawText: string;
  tokens: IAlignedTranscriptToken[];
  completedAt?: string;
}): ITranscriptSegmentationResult {
  const timing = validateAndRepairAlignedTokenTiming({
    rawText: input.rawText,
    tokens: input.tokens,
  });
  const tokens = timing.tokens;
  if (tokens.length === 0) {
    return {
      alignedTokens: [],
      transcript: '',
      segments: [],
      segmentation: {
        status: 'completed',
        provider: 'deterministic',
        policyVersion: CTRANSCRIPT_SEGMENTATION_POLICY_VERSION,
        attempts: 0,
        completedAt: input.completedAt ?? new Date().toISOString(),
        timingValidation: timing.validation,
      },
    };
  }

  const punctuation = mapRawPunctuation(input.rawText, tokens);
  const hardSentenceRanges = buildHardSentenceRanges(tokens.length, punctuation.after);
  const splitDrafts = hardSentenceRanges.flatMap(range => (
    splitLongRangeAtBalancedCommas(range, punctuation.after)
  ));
  const drafts = splitDrafts.map(range => materializeDraft(range, tokens, punctuation));
  const merged = mergeAdjacentDrafts(drafts, tokens);
  const normalized = mergeZeroDurationDrafts(merged, tokens);
  validateSegmentCoverage(normalized, tokens);
  const segments = normalized.map(draft => ({
    startMs: tokens[draft.startToken]!.startMs,
    endMs: tokens[draft.endToken]!.endMs,
    text: draft.text,
  }));
  return {
    alignedTokens: tokens,
    transcript: segments.map(segment => segment.text).join(' ').trim(),
    segments,
    segmentation: {
      status: 'completed',
      provider: 'deterministic',
      policyVersion: CTRANSCRIPT_SEGMENTATION_POLICY_VERSION,
      attempts: 0,
      completedAt: input.completedAt ?? new Date().toISOString(),
      timingValidation: timing.validation,
    },
  };
}

function buildHardSentenceRanges(
  tokenCount: number,
  punctuationAfter: string[],
): Array<{ startToken: number; endToken: number }> {
  const ranges: Array<{ startToken: number; endToken: number }> = [];
  let startToken = 0;
  for (let index = 0; index < tokenCount; index += 1) {
    if (!containsHardPunctuation(punctuationAfter[index] ?? '')) continue;
    ranges.push({ startToken, endToken: index });
    startToken = index + 1;
  }
  if (startToken < tokenCount) ranges.push({ startToken, endToken: tokenCount - 1 });
  return ranges;
}

function splitLongRangeAtBalancedCommas(
  range: { startToken: number; endToken: number },
  punctuationAfter: string[],
): Array<{ startToken: number; endToken: number; replaceTrailingComma?: boolean }> {
  const length = range.endToken - range.startToken + 1;
  if (length <= CTRANSCRIPT_SEGMENTATION_MAX_CHARACTERS) return [range];
  const commaBoundaries = Array.from(
    { length: Math.max(0, range.endToken - range.startToken) },
    (_, offset) => range.startToken + offset,
  ).filter(index => containsSoftComma(punctuationAfter[index] ?? ''));
  if (commaBoundaries.length === 0) return [range];

  const endExclusive = range.endToken + 1;
  const minimumSegments = Math.ceil(length / CTRANSCRIPT_SEGMENTATION_MAX_CHARACTERS);
  let selectedBoundaries: number[] | null = null;
  for (let segmentCount = minimumSegments; segmentCount <= commaBoundaries.length + 1; segmentCount += 1) {
    selectedBoundaries = selectBalancedBoundaries(
      range.startToken,
      endExclusive,
      commaBoundaries.map(index => index + 1),
      segmentCount,
    );
    if (selectedBoundaries) break;
  }
  if (!selectedBoundaries) {
    selectedBoundaries = recursivelySplitOversizeRanges(
      range.startToken,
      endExclusive,
      commaBoundaries.map(index => index + 1),
    );
  }
  const boundaries = [...selectedBoundaries, endExclusive];
  let startToken = range.startToken;
  return boundaries.map((boundary, index) => {
    const result = {
      startToken,
      endToken: boundary - 1,
      ...(index < boundaries.length - 1 ? { replaceTrailingComma: true } : {}),
    };
    startToken = boundary;
    return result;
  });
}

function selectBalancedBoundaries(
  start: number,
  end: number,
  candidates: number[],
  segmentCount: number,
): number[] | null {
  const targetLength = (end - start) / segmentCount;
  const positions = [start, ...candidates, end];
  const memo = new Map<string, { score: number; boundaries: number[] } | null>();
  const visit = (
    positionIndex: number,
    remainingSegments: number,
  ): { score: number; boundaries: number[] } | null => {
    const key = `${positionIndex}:${remainingSegments}`;
    if (memo.has(key)) return memo.get(key)!;
    const current = positions[positionIndex]!;
    if (remainingSegments === 1) {
      const length = end - current;
      const result = length > 0 && length <= CTRANSCRIPT_SEGMENTATION_MAX_CHARACTERS
        ? { score: (length - targetLength) ** 2, boundaries: [] }
        : null;
      memo.set(key, result);
      return result;
    }
    let best: { score: number; boundaries: number[] } | null = null;
    for (let nextIndex = positionIndex + 1; nextIndex < positions.length - 1; nextIndex += 1) {
      const next = positions[nextIndex]!;
      const length = next - current;
      if (length > CTRANSCRIPT_SEGMENTATION_MAX_CHARACTERS) break;
      const tail = visit(nextIndex, remainingSegments - 1);
      if (!tail) continue;
      const score = (length - targetLength) ** 2 + tail.score;
      if (!best || score < best.score) {
        best = { score, boundaries: [next, ...tail.boundaries] };
      }
    }
    memo.set(key, best);
    return best;
  };
  return visit(0, segmentCount)?.boundaries ?? null;
}

function recursivelySplitOversizeRanges(
  start: number,
  end: number,
  candidates: number[],
): number[] {
  if (end - start <= CTRANSCRIPT_SEGMENTATION_MAX_CHARACTERS) return [];
  const eligible = candidates.filter(candidate => candidate > start && candidate < end);
  if (eligible.length === 0) return [];
  const midpoint = (start + end) / 2;
  const selected = eligible.reduce((best, candidate) => (
    Math.abs(candidate - midpoint) < Math.abs(best - midpoint) ? candidate : best
  ));
  return [
    ...recursivelySplitOversizeRanges(start, selected, eligible),
    selected,
    ...recursivelySplitOversizeRanges(selected, end, eligible),
  ];
}

function materializeDraft(
  range: { startToken: number; endToken: number; replaceTrailingComma?: boolean },
  tokens: IAlignedTranscriptToken[],
  punctuation: { prefix: string; after: string[] },
): ISegmentDraft {
  const text = tokens.slice(range.startToken, range.endToken + 1)
    .map((token, offset, selected) => {
      const tokenIndex = range.startToken + offset;
      let suffix = punctuation.after[tokenIndex] ?? '';
      if (offset === selected.length - 1 && range.replaceTrailingComma) {
        suffix = suffix.replace(/[，,]+/gu, '。');
      }
      return `${token.text}${suffix}`;
    })
    .join('');
  return {
    startToken: range.startToken,
    endToken: range.endToken,
    text: range.startToken === 0 ? `${punctuation.prefix}${text}` : text,
  };
}

function mergeAdjacentDrafts(
  drafts: ISegmentDraft[],
  tokens: IAlignedTranscriptToken[],
): ISegmentDraft[] {
  const merged: ISegmentDraft[] = [];
  for (const draft of drafts) {
    const previous = merged.at(-1);
    if (!previous) {
      merged.push({ ...draft });
      continue;
    }
    const gapMs = tokens[draft.startToken]!.startMs - tokens[previous.endToken]!.endMs;
    const combinedLength = draft.endToken - previous.startToken + 1;
    if (
      gapMs < CTRANSCRIPT_SEGMENTATION_MERGE_GAP_MS
      && combinedLength <= CTRANSCRIPT_SEGMENTATION_MAX_CHARACTERS
    ) {
      previous.endToken = draft.endToken;
      previous.text += draft.text;
    } else {
      merged.push({ ...draft });
    }
  }
  return merged;
}

function mergeZeroDurationDrafts(
  drafts: ISegmentDraft[],
  tokens: IAlignedTranscriptToken[],
): ISegmentDraft[] {
  const result: ISegmentDraft[] = [];
  let leading: ISegmentDraft | undefined;
  for (const draft of drafts) {
    const hasDuration = tokens[draft.endToken]!.endMs > tokens[draft.startToken]!.startMs;
    if (hasDuration) {
      result.push(leading
        ? { startToken: leading.startToken, endToken: draft.endToken, text: leading.text + draft.text }
        : { ...draft });
      leading = undefined;
      continue;
    }
    const previous = result.at(-1);
    if (previous) {
      previous.endToken = draft.endToken;
      previous.text += draft.text;
    } else {
      leading = leading
        ? { startToken: leading.startToken, endToken: draft.endToken, text: leading.text + draft.text }
        : { ...draft };
    }
  }
  if (leading || result.length === 0) {
    throw new Error('全部字幕段都只有零时长 token，无法生成有效时间范围');
  }
  return result;
}

function validateSegmentCoverage(drafts: ISegmentDraft[], tokens: IAlignedTranscriptToken[]): void {
  let cursor = 0;
  for (const [index, draft] of drafts.entries()) {
    if (draft.startToken !== cursor) throw new Error(`字幕段 ${index} 未连续覆盖 token ${cursor}`);
    if (draft.endToken < draft.startToken) throw new Error(`字幕段 ${index} token 范围无效`);
    cursor = draft.endToken + 1;
  }
  if (cursor !== tokens.length) throw new Error(`字幕段遗漏 ${tokens.length - cursor} 个 token`);
  const body = stripPunctuationAndWhitespace(drafts.map(draft => draft.text).join(''));
  const expected = tokens.map(token => token.text).join('');
  if (body !== expected) throw new Error('字幕段正文未逐字覆盖 aligned token');
}

function mapRawPunctuation(
  rawText: string,
  tokens: IAlignedTranscriptToken[],
): { prefix: string; after: string[] } {
  const after = Array.from({ length: tokens.length }, () => '');
  let prefix = '';
  let tokenIndex = 0;
  for (const character of Array.from(rawText)) {
    if (/^\s$/u.test(character)) continue;
    if (/^\p{P}$/u.test(character)) {
      if (tokenIndex === 0) prefix += character;
      else after[tokenIndex - 1] += character;
      continue;
    }
    if (tokens[tokenIndex]?.text !== character) {
      throw new Error(`ASR 原文字符 ${tokenIndex} 无法映射到 aligned token`);
    }
    tokenIndex += 1;
  }
  if (tokenIndex !== tokens.length) throw new Error('ASR 原文未覆盖全部 aligned token');
  return { prefix, after };
}

function containsSoftComma(value: string): boolean {
  return /[，,]/u.test(value);
}

function containsHardPunctuation(value: string): boolean {
  return Array.from(value).some(character => /^\p{P}$/u.test(character) && !/[，,]/u.test(character));
}

function stripPunctuationAndWhitespace(value: string): string {
  return value.replace(/[\s\p{P}]+/gu, '');
}
