import type { ITranscriptSegment } from '../../protocol/schema.js';

export const CSPEECH_WINDOW_POLICY_VERSION = 'aligned-token-adaptive-gap-v1';

const CMIN_GAP_SAMPLE_COUNT = 8;
const CTOKEN_CADENCE_MULTIPLIER = 8;
const CSINGLETON_GAP_RATIO = 2;
const CSPARSE_TAIL_RATIO = 10;
const CNATURAL_BREAK_RATIO = 2;

export type TSpeechWindowBoundaryMode =
  | 'single-window'
  | 'upper-tail'
  | 'natural-break'
  | 'singleton-rejected';

export interface IAdaptiveSpeechWindowGroup {
  startMs: number;
  endMs: number;
}

export interface IAdaptiveSpeechWindowDiagnostics {
  policyVersion: typeof CSPEECH_WINDOW_POLICY_VERSION;
  mode: TSpeechWindowBoundaryMode;
  timedTokenCount: number;
  positiveGapCount: number;
  cadenceGuardMs: number;
  statisticalBoundaryMs?: number;
  effectiveBoundaryMs?: number;
  boundaryGapsMs: number[];
}

export interface IAdaptiveSpeechWindowPlan {
  groups: IAdaptiveSpeechWindowGroup[];
  diagnostics: IAdaptiveSpeechWindowDiagnostics;
}

interface INormalizedTimedToken {
  startMs: number;
  endMs: number;
}

interface IRawSpeechWindowGroup extends IAdaptiveSpeechWindowGroup {
  hasPositiveDuration: boolean;
}

export function planAdaptiveSpeechWindows(
  durationMs: number,
  tokens: Array<Pick<ITranscriptSegment, 'startMs' | 'endMs'>>,
): IAdaptiveSpeechWindowPlan {
  const normalized = normalizeTimedTokens(durationMs, tokens);
  const positiveTokenDurationsMs = normalized
    .map(token => token.endMs - token.startMs)
    .filter(tokenDurationMs => tokenDurationMs > 0);
  if (normalized.length === 0 || positiveTokenDurationsMs.length === 0) {
    return emptyPlan();
  }

  const cadenceGuardMs = quantile(positiveTokenDurationsMs, 0.9) * CTOKEN_CADENCE_MULTIPLIER;
  const gapsMs = normalized.slice(0, -1).map((token, index) =>
    Math.max(0, normalized[index + 1]!.startMs - token.endMs),
  );
  const positiveGapsMs = gapsMs.filter(gapMs => gapMs > 0);
  const boundaryIndices: number[] = [];
  let mode: TSpeechWindowBoundaryMode = 'single-window';
  let statisticalBoundaryMs: number | undefined;
  let effectiveBoundaryMs: number | undefined;
  let medianGapMs: number | undefined;
  let upperGapMs: number | undefined;

  if (positiveGapsMs.length >= CMIN_GAP_SAMPLE_COUNT) {
    const logGaps = positiveGapsMs.map(gapMs => Math.log1p(gapMs));
    const medianLogGap = quantile(logGaps, 0.5);
    const upperQuartileLogGap = quantile(logGaps, 0.75);
    const upperDecileLogGap = quantile(logGaps, 0.9);
    medianGapMs = Math.expm1(medianLogGap);
    upperGapMs = Math.expm1(upperDecileLogGap);
    statisticalBoundaryMs = Math.expm1(
      upperDecileLogGap + (upperDecileLogGap - upperQuartileLogGap),
    );
    effectiveBoundaryMs = Math.max(statisticalBoundaryMs, cadenceGuardMs);
    boundaryIndices.push(
      ...findGapIndices(gapsMs, gapMs => gapMs > effectiveBoundaryMs!),
    );
    mode = 'upper-tail';

    if (boundaryIndices.length === 1 && !isSalientSingletonGap(positiveGapsMs)) {
      boundaryIndices.length = 0;
      mode = 'singleton-rejected';
    }
  }

  const sparseTailRatio = upperGapMs != null && medianGapMs != null
    ? upperGapMs / Math.max(medianGapMs, 1)
    : undefined;
  const mayUseNaturalBreak = positiveGapsMs.length >= CMIN_GAP_SAMPLE_COUNT
    && sparseTailRatio != null
    && sparseTailRatio >= CSPARSE_TAIL_RATIO;

  if (boundaryIndices.length === 0 && mayUseNaturalBreak) {
    const naturalBoundaryMs = findNaturalGapBoundary(
      positiveGapsMs,
      cadenceGuardMs,
    );
    if (naturalBoundaryMs != null) {
      boundaryIndices.push(
        ...findGapIndices(gapsMs, gapMs => gapMs >= naturalBoundaryMs),
      );
      effectiveBoundaryMs = naturalBoundaryMs;
      mode = 'natural-break';
    }
  }

  return {
    groups: groupTokensAtBoundaries(normalized, boundaryIndices),
    diagnostics: {
      policyVersion: CSPEECH_WINDOW_POLICY_VERSION,
      mode,
      timedTokenCount: normalized.length,
      positiveGapCount: positiveGapsMs.length,
      cadenceGuardMs,
      statisticalBoundaryMs,
      effectiveBoundaryMs,
      boundaryGapsMs: boundaryIndices.map(index => gapsMs[index]!),
    },
  };
}

export function buildAdaptiveSpeechWindowGroups(
  durationMs: number,
  tokens: Array<Pick<ITranscriptSegment, 'startMs' | 'endMs'>>,
): IAdaptiveSpeechWindowGroup[] {
  return planAdaptiveSpeechWindows(durationMs, tokens).groups;
}

function normalizeTimedTokens(
  durationMs: number,
  tokens: Array<Pick<ITranscriptSegment, 'startMs' | 'endMs'>>,
): INormalizedTimedToken[] {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return [];

  return tokens
    .map(token => ({
      startMs: Math.max(0, Math.min(durationMs, token.startMs)),
      endMs: Math.max(0, Math.min(durationMs, token.endMs)),
    }))
    .filter(token =>
      Number.isFinite(token.startMs)
      && Number.isFinite(token.endMs)
      && token.endMs >= token.startMs,
    )
    .sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs);
}

function emptyPlan(): IAdaptiveSpeechWindowPlan {
  return {
    groups: [],
    diagnostics: {
      policyVersion: CSPEECH_WINDOW_POLICY_VERSION,
      mode: 'single-window',
      timedTokenCount: 0,
      positiveGapCount: 0,
      cadenceGuardMs: 0,
      boundaryGapsMs: [],
    },
  };
}

function findGapIndices(
  gapsMs: number[],
  predicate: (gapMs: number) => boolean,
): number[] {
  const indices: number[] = [];
  for (const [index, gapMs] of gapsMs.entries()) {
    if (predicate(gapMs)) indices.push(index);
  }
  return indices;
}

function isSalientSingletonGap(positiveGapsMs: number[]): boolean {
  const descending = [...positiveGapsMs].sort((left, right) => right - left);
  if (descending.length < 2) return false;
  return descending[0]! >= descending[1]! * CSINGLETON_GAP_RATIO;
}

function findNaturalGapBoundary(
  positiveGapsMs: number[],
  cadenceGuardMs: number,
): number | undefined {
  if (positiveGapsMs.length === 0) return undefined;

  const distinct = [...new Set(positiveGapsMs)].sort((left, right) => left - right);
  if (distinct.length === 1) {
    const onlyGapMs = distinct[0]!;
    return onlyGapMs >= cadenceGuardMs * CNATURAL_BREAK_RATIO
      ? onlyGapMs
      : undefined;
  }

  const upperHalfStart = Math.floor(distinct.length / 2);
  for (let index = Math.max(1, upperHalfStart); index < distinct.length; index += 1) {
    const previousGapMs = distinct[index - 1]!;
    const gapMs = distinct[index]!;
    if (
      gapMs >= cadenceGuardMs
      && gapMs >= previousGapMs * CNATURAL_BREAK_RATIO
    ) {
      return gapMs;
    }
  }
  return undefined;
}

function groupTokensAtBoundaries(
  tokens: INormalizedTimedToken[],
  boundaryIndices: number[],
): IAdaptiveSpeechWindowGroup[] {
  const boundarySet = new Set(boundaryIndices);
  const rawGroups: IRawSpeechWindowGroup[] = [];
  let groupStartIndex = 0;

  for (let index = 0; index < tokens.length - 1; index += 1) {
    if (!boundarySet.has(index)) continue;
    const groupTokens = tokens.slice(groupStartIndex, index + 1);
    rawGroups.push({
      startMs: tokens[groupStartIndex]!.startMs,
      endMs: tokens[index]!.endMs,
      hasPositiveDuration: groupTokens.some(token => token.endMs > token.startMs),
    });
    groupStartIndex = index + 1;
  }

  const finalGroupTokens = tokens.slice(groupStartIndex);
  rawGroups.push({
    startMs: tokens[groupStartIndex]!.startMs,
    endMs: tokens[tokens.length - 1]!.endMs,
    hasPositiveDuration: finalGroupTokens.some(token => token.endMs > token.startMs),
  });

  const groups: IAdaptiveSpeechWindowGroup[] = [];
  let pendingLeadingStartMs: number | undefined;
  for (const rawGroup of rawGroups) {
    if (!rawGroup.hasPositiveDuration) {
      if (groups.length > 0) {
        groups[groups.length - 1]!.endMs = Math.max(
          groups[groups.length - 1]!.endMs,
          rawGroup.endMs,
        );
      } else {
        pendingLeadingStartMs = pendingLeadingStartMs == null
          ? rawGroup.startMs
          : Math.min(pendingLeadingStartMs, rawGroup.startMs);
      }
      continue;
    }
    groups.push({
      startMs: pendingLeadingStartMs == null
        ? rawGroup.startMs
        : Math.min(pendingLeadingStartMs, rawGroup.startMs),
      endMs: rawGroup.endMs,
    });
    pendingLeadingStartMs = undefined;
  }
  return groups;
}

function quantile(values: number[], probability: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * probability;
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.min(lowerIndex + 1, sorted.length - 1);
  const fraction = position - lowerIndex;
  return sorted[lowerIndex]! + (sorted[upperIndex]! - sorted[lowerIndex]!) * fraction;
}
