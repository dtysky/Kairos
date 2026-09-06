import type {
  IAlignedTokenTimingValidation,
  IAlignedTranscriptToken,
} from '../../protocol/schema.js';

export const CALIGNED_TOKEN_TIMING_POLICY_VERSION = 'adaptive-duration-outlier-v1';

export interface IAlignedTokenTimingResult {
  tokens: IAlignedTranscriptToken[];
  validation: IAlignedTokenTimingValidation;
}

export function validateAndRepairAlignedTokenTiming(input: {
  rawText: string;
  tokens: IAlignedTranscriptToken[];
}): IAlignedTokenTimingResult {
  validateAlignedTokenStructure(input.rawText, input.tokens);
  if (input.tokens.length === 0) {
    return {
      tokens: [],
      validation: {
        policyVersion: CALIGNED_TOKEN_TIMING_POLICY_VERSION,
        status: 'valid',
        sourceP90TokenDurationMs: 0,
        adaptiveOutlierThresholdMs: 0,
        replacementTokenDurationMs: 0,
        originalMaxTokenDurationMs: 0,
        repairedMaxTokenDurationMs: 0,
        normalizedGapCount: 0,
        repairs: [],
      },
    };
  }

  const original = input.tokens.map(token => ({ ...token }));
  const tokens = original.map(token => ({ ...token }));
  const positiveDurations = tokens
    .map(token => token.endMs - token.startMs)
    .filter(duration => duration > 0)
    .sort((left, right) => left - right);
  const medianDurationMs = quantileNearestRank(positiveDurations, 0.5);
  const cadenceDurations = positiveDurations.filter(
    duration => duration <= Math.max(1000, medianDurationMs * 4),
  );
  const p90DurationMs = quantileNearestRank(cadenceDurations, 0.9);
  const outlierThresholdMs = Math.max(3000, p90DurationMs * 8);
  const replacementDurationMs = Math.max(320, Math.min(1200, p90DurationMs * 2));
  const punctuation = mapRawPunctuation(input.rawText, tokens);
  const outlierIndexes = tokens
    .map((token, index) => ({ index, durationMs: token.endMs - token.startMs }))
    .filter(row => row.durationMs > outlierThresholdMs)
    .map(row => row.index);
  const groups = groupConsecutiveIndexes(outlierIndexes);
  const repairAnchors = new Map<number, 'left' | 'right'>();

  for (const group of groups) {
    const firstIndex = group[0]!;
    const lastIndex = group.at(-1)!;
    const anchor = chooseRepairAnchor(firstIndex, lastIndex, punctuation);
    const first = tokens[firstIndex]!;
    const last = tokens[lastIndex]!;
    const previousEndMs = tokens[firstIndex - 1]?.endMs ?? 0;
    const nextStartMs = tokens[lastIndex + 1]?.startMs ?? last.endMs;
    const targetDurationMs = replacementDurationMs * group.length;
    const repairedStartMs = anchor === 'right'
      ? Math.max(previousEndMs, last.endMs - targetDurationMs)
      : first.startMs;
    const repairedEndMs = anchor === 'left'
      ? Math.min(nextStartMs, first.startMs + targetDurationMs)
      : last.endMs;
    const availableDurationMs = Math.max(0, repairedEndMs - repairedStartMs);
    for (const [offset, tokenIndex] of group.entries()) {
      const startMs = repairedStartMs
        + Math.round((availableDurationMs * offset) / group.length);
      const endMs = repairedStartMs
        + Math.round((availableDurationMs * (offset + 1)) / group.length);
      tokens[tokenIndex] = { ...tokens[tokenIndex]!, startMs, endMs };
      repairAnchors.set(tokenIndex, anchor);
    }
  }

  let normalizedGapCount = 0;
  for (const [index, token] of tokens.entries()) {
    const next = tokens[index + 1];
    const gapAfterMs = next ? next.startMs - token.endMs : 0;
    if (gapAfterMs !== token.gapAfterMs) normalizedGapCount += 1;
    token.gapAfterMs = Math.max(0, gapAfterMs);
  }
  validateAlignedTokenStructure(input.rawText, tokens);

  const repairs = [...repairAnchors.entries()].map(([index, anchor]) => ({
    index,
    text: tokens[index]!.text,
    anchor,
    originalStartMs: original[index]!.startMs,
    originalEndMs: original[index]!.endMs,
    repairedStartMs: tokens[index]!.startMs,
    repairedEndMs: tokens[index]!.endMs,
  }));
  return {
    tokens,
    validation: {
      policyVersion: CALIGNED_TOKEN_TIMING_POLICY_VERSION,
      status: repairs.length > 0 || normalizedGapCount > 0 ? 'repaired' : 'valid',
      sourceP90TokenDurationMs: p90DurationMs,
      adaptiveOutlierThresholdMs: outlierThresholdMs,
      replacementTokenDurationMs: replacementDurationMs,
      originalMaxTokenDurationMs: Math.max(...positiveDurations, 0),
      repairedMaxTokenDurationMs: Math.max(
        ...tokens.map(token => token.endMs - token.startMs),
        0,
      ),
      normalizedGapCount,
      repairs,
    },
  };
}

export function validateAlignedTokenStructure(
  rawText: string,
  tokens: IAlignedTranscriptToken[],
): void {
  const expectedText = stripPunctuationAndWhitespace(rawText);
  const actualText = tokens.map(token => token.text).join('');
  if (expectedText !== actualText) {
    throw new Error(
      `aligned token 字符覆盖与 ASR 原文不一致：ASR=${JSON.stringify(expectedText)} aligned=${JSON.stringify(actualText)}`,
    );
  }
  for (const [index, token] of tokens.entries()) {
    if (token.index !== index) throw new Error(`aligned token ${index} 的 index=${token.index}`);
    if (Array.from(stripPunctuationAndWhitespace(token.text)).length !== 1) {
      throw new Error(`aligned token ${index} 不符合单字符契约`);
    }
    if (token.endMs < token.startMs) throw new Error(`aligned token ${index} 时间范围无效`);
    const next = tokens[index + 1];
    if (next) {
      if (next.startMs < token.endMs) {
        throw new Error(`aligned token ${index} 与 ${index + 1} 时间重叠`);
      }
      const expectedGap = next.startMs - token.endMs;
      if (token.gapAfterMs !== expectedGap) {
        throw new Error(
          `aligned token ${index} gapAfterMs 应为 ${expectedGap}，实际为 ${token.gapAfterMs}`,
        );
      }
    } else if (token.gapAfterMs !== 0) {
      throw new Error('最后一个 aligned token 的 gapAfterMs 必须为 0');
    }
  }
}

function chooseRepairAnchor(
  firstIndex: number,
  lastIndex: number,
  punctuation: { prefix: string; after: string[] },
): 'left' | 'right' {
  const before = firstIndex === 0 ? punctuation.prefix : punctuation.after[firstIndex - 1] ?? '';
  if (before.length > 0) return 'right';
  const after = punctuation.after[lastIndex] ?? '';
  if (after.length > 0) return 'left';
  return 'right';
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

function groupConsecutiveIndexes(indexes: number[]): number[][] {
  const groups: number[][] = [];
  for (const index of indexes) {
    const active = groups.at(-1);
    if (active && active.at(-1)! + 1 === index) active.push(index);
    else groups.push([index]);
  }
  return groups;
}

function quantileNearestRank(values: number[], quantile: number): number {
  if (values.length === 0) return 0;
  const index = Math.max(0, Math.ceil(values.length * quantile) - 1);
  return values[Math.min(values.length - 1, index)]!;
}

function stripPunctuationAndWhitespace(value: string): string {
  return value.replace(/[\s\p{P}]+/gu, '');
}
