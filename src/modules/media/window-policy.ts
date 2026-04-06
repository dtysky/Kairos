import type {
  EClipType,
  IInterestingWindow,
  ITranscriptSegment,
  IKtepScriptSelection,
  IKtepSlice,
  ISpeedCandidateHint,
} from '../../protocol/schema.js';
import type { IShotBoundary } from './shot-detect.js';

export interface IResolvedRange {
  startMs: number;
  endMs: number;
}

interface IWindowExpansionPolicy {
  beforeMs: number;
  afterMs: number;
  minDurationMs: number;
}

export interface ITypeAwareWindowExpansionInput {
  clipType: EClipType;
  durationMs: number;
  windows: IInterestingWindow[];
  shotBoundaries?: IShotBoundary[];
}

export function applyTypeAwareWindowExpansion(
  input: ITypeAwareWindowExpansionInput,
): IInterestingWindow[] {
  if (input.durationMs <= 0 || input.windows.length === 0) {
    return [];
  }

  const expanded = input.windows
    .map(window => expandWindow(window, input))
    .filter((window): window is IInterestingWindow => window != null);

  return mergeInterestingWindowsByPreferredBounds(expanded);
}

export function isSpeechSemanticWindow(
  window: Pick<IInterestingWindow, 'reason' | 'semanticKind'>,
): boolean {
  if (window.semanticKind === 'speech') return true;
  return window.reason
    .split('+')
    .map(token => token.trim())
    .filter(Boolean)
    .includes('speech-window');
}

export function resolveWindowPreferredRange(
  window: Pick<IInterestingWindow, 'startMs' | 'endMs' | 'editStartMs' | 'editEndMs'>,
): IResolvedRange | null {
  return resolvePreferredRange(
    window.startMs,
    window.endMs,
    window.editStartMs,
    window.editEndMs,
  );
}

export function resolveSlicePreferredRange(
  slice: Pick<IKtepSlice, 'sourceInMs' | 'sourceOutMs' | 'editSourceInMs' | 'editSourceOutMs'>,
): IResolvedRange | null {
  return resolvePreferredRange(
    slice.sourceInMs,
    slice.sourceOutMs,
    slice.editSourceInMs,
    slice.editSourceOutMs,
  );
}

export function resolveSelectionRange(
  selection: Pick<IKtepScriptSelection, 'sourceInMs' | 'sourceOutMs'>,
  slice?: Pick<IKtepSlice, 'sourceInMs' | 'sourceOutMs' | 'editSourceInMs' | 'editSourceOutMs'>,
): IResolvedRange | null {
  const preferredRange = slice ? resolveSlicePreferredRange(slice) : null;
  const startMs = selection.sourceInMs ?? preferredRange?.startMs;
  const endMs = selection.sourceOutMs ?? preferredRange?.endMs;

  if (typeof startMs !== 'number' || typeof endMs !== 'number' || endMs <= startMs) {
    return preferredRange;
  }

  return { startMs, endMs };
}

export function expandRangeToTranscriptSegments(
  range: IResolvedRange,
  transcriptSegments: ITranscriptSegment[] = [],
): IResolvedRange {
  if (transcriptSegments.length === 0) return range;

  const intersectingSegments = transcriptSegments.filter(segment =>
    segment.endMs > range.startMs && segment.startMs < range.endMs,
  );
  if (intersectingSegments.length === 0) return range;

  const startMs = Math.min(
    range.startMs,
    ...intersectingSegments.map(segment => segment.startMs),
  );
  const endMs = Math.max(
    range.endMs,
    ...intersectingSegments.map(segment => segment.endMs),
  );

  return { startMs, endMs };
}

export function snapSelectionToTranscriptSegments<T extends Pick<
  IKtepScriptSelection,
  'sourceInMs' | 'sourceOutMs'
>>(
  selection: T,
  slice?: Pick<
    IKtepSlice,
    'sourceInMs' | 'sourceOutMs' | 'editSourceInMs' | 'editSourceOutMs' | 'transcriptSegments'
  >,
): T {
  const range = resolveSelectionRange(selection, slice);
  if (!range) return selection;

  const snappedRange = expandRangeToTranscriptSegments(range, slice?.transcriptSegments ?? []);
  return {
    ...selection,
    sourceInMs: snappedRange.startMs,
    sourceOutMs: snappedRange.endMs,
  };
}

export function hasExplicitEditRange(
  value: Pick<IInterestingWindow, 'editStartMs' | 'editEndMs'>
    | Pick<IKtepSlice, 'editSourceInMs' | 'editSourceOutMs'>,
): boolean {
  return (
    ('editStartMs' in value
      && typeof value.editStartMs === 'number'
      && typeof value.editEndMs === 'number'
      && value.editEndMs > value.editStartMs)
    || ('editSourceInMs' in value
      && typeof value.editSourceInMs === 'number'
      && typeof value.editSourceOutMs === 'number'
      && value.editSourceOutMs > value.editSourceInMs)
  );
}

export function buildDriveSpeedCandidate(
  assetDurationMs: number,
  windowDurationMs: number,
  rationale = 'continuous-drive-window',
): ISpeedCandidateHint {
  const speeds = new Set<number>([2]);

  if (assetDurationMs >= 2 * 60_000 || windowDurationMs >= 10_000) {
    speeds.add(5);
  }
  if (assetDurationMs >= 10 * 60_000 || windowDurationMs >= 18_000) {
    speeds.add(10);
  }

  return {
    suggestedSpeeds: [...speeds].sort((left, right) => left - right),
    rationale,
    confidence: assetDurationMs >= 5 * 60_000 || windowDurationMs >= 16_000 ? 0.82 : 0.68,
  };
}

export function mergeInterestingWindowsByPreferredBounds(
  windows: IInterestingWindow[],
): IInterestingWindow[] {
  if (windows.length === 0) return [];

  const sorted = [...windows]
    .map(window => cloneWindow(window))
    .sort((left, right) => {
      const leftRange = resolveWindowPreferredRange(left) ?? { startMs: left.startMs, endMs: left.endMs };
      const rightRange = resolveWindowPreferredRange(right) ?? { startMs: right.startMs, endMs: right.endMs };
      return leftRange.startMs - rightRange.startMs || left.startMs - right.startMs;
    });

  const merged: IInterestingWindow[] = [sorted[0]!];

  for (let index = 1; index < sorted.length; index += 1) {
    const previous = merged[merged.length - 1]!;
    const current = sorted[index]!;
    const previousRange = resolveWindowPreferredRange(previous) ?? {
      startMs: previous.startMs,
      endMs: previous.endMs,
    };
    const currentRange = resolveWindowPreferredRange(current) ?? {
      startMs: current.startMs,
      endMs: current.endMs,
    };

    if (currentRange.startMs <= previousRange.endMs && canMergeWindowSemantics(previous, current)) {
      previous.startMs = Math.min(previous.startMs, current.startMs);
      previous.endMs = Math.max(previous.endMs, current.endMs);
      previous.editStartMs = Math.min(previousRange.startMs, currentRange.startMs);
      previous.editEndMs = Math.max(previousRange.endMs, currentRange.endMs);
      previous.semanticKind = previous.semanticKind ?? current.semanticKind;
      previous.reason = mergeReasonTokens(previous.reason, current.reason);
      previous.speedCandidate = mergeSpeedCandidates(previous.speedCandidate, current.speedCandidate);
      continue;
    }

    merged.push(current);
  }

  return merged;
}

function expandWindow(
  window: IInterestingWindow,
  input: ITypeAwareWindowExpansionInput,
): IInterestingWindow | null {
  const focusStart = clampMs(window.startMs, 0, input.durationMs);
  const focusEnd = clampMs(window.endMs, 0, input.durationMs);
  if (focusEnd <= focusStart) return null;

  const policy = resolvePolicy(input.clipType, window, input.durationMs);
  const cuts = buildCutPoints(input.durationMs, input.shotBoundaries ?? []);

  let editStart = Math.max(0, focusStart - policy.beforeMs);
  let editEnd = Math.min(input.durationMs, focusEnd + policy.afterMs);

  const previousCut = findPreviousCut(cuts, focusStart);
  if (previousCut != null && focusStart - previousCut <= policy.beforeMs + 1_500) {
    editStart = Math.min(editStart, previousCut);
  }

  const nextCut = findNextCut(cuts, focusEnd);
  if (nextCut != null && nextCut - focusEnd <= policy.afterMs + 1_500) {
    editEnd = Math.max(editEnd, nextCut);
  }

  const normalized = ensureMinimumDuration(
    {
      startMs: editStart,
      endMs: editEnd,
    },
    Math.max(policy.minDurationMs, focusEnd - focusStart),
    input.durationMs,
  );

  const speedCandidate = input.clipType === 'drive' && !isSpeechSemanticWindow(window)
    ? buildDriveSpeedCandidate(
      input.durationMs,
      normalized.endMs - normalized.startMs,
      `drive:${window.reason}`,
    )
    : undefined;

  return {
    ...window,
    startMs: focusStart,
    endMs: focusEnd,
    editStartMs: normalized.startMs,
    editEndMs: normalized.endMs,
    ...(speedCandidate && { speedCandidate }),
  };
}

function resolvePolicy(
  clipType: EClipType,
  window: IInterestingWindow,
  durationMs: number,
): IWindowExpansionPolicy {
  if (isSpeechSemanticWindow(window) || clipType === 'talking-head') {
    return { beforeMs: 250, afterMs: 750, minDurationMs: 2_400 };
  }

  if (clipType === 'drive') {
    return {
      beforeMs: 4_000,
      afterMs: 6_000,
      minDurationMs: pickDriveEditWindowDuration(durationMs),
    };
  }

  if (clipType === 'aerial' || clipType === 'timelapse') {
    return { beforeMs: 3_000, afterMs: 3_000, minDurationMs: 8_000 };
  }

  if (clipType === 'broll') {
    return { beforeMs: 2_000, afterMs: 2_500, minDurationMs: 6_000 };
  }

  return { beforeMs: 1_500, afterMs: 2_000, minDurationMs: 4_500 };
}

function pickDriveEditWindowDuration(durationMs: number): number {
  if (durationMs <= 60_000) return 8_000;
  if (durationMs <= 5 * 60_000) return 12_000;
  if (durationMs <= 20 * 60_000) return 18_000;
  return 24_000;
}

function buildCutPoints(durationMs: number, boundaries: IShotBoundary[]): number[] {
  const points = new Set<number>([0, durationMs]);
  for (const boundary of boundaries) {
    if (boundary.timeMs > 0 && boundary.timeMs < durationMs) {
      points.add(boundary.timeMs);
    }
  }
  return [...points].sort((left, right) => left - right);
}

function findPreviousCut(cuts: number[], pivotMs: number): number | undefined {
  for (let index = cuts.length - 1; index >= 0; index -= 1) {
    const candidate = cuts[index]!;
    if (candidate <= pivotMs) return candidate;
  }
  return undefined;
}

function findNextCut(cuts: number[], pivotMs: number): number | undefined {
  for (const candidate of cuts) {
    if (candidate >= pivotMs) return candidate;
  }
  return undefined;
}

function resolvePreferredRange(
  startMs: number | undefined,
  endMs: number | undefined,
  editStartMs: number | undefined,
  editEndMs: number | undefined,
): IResolvedRange | null {
  if (
    typeof editStartMs === 'number'
    && typeof editEndMs === 'number'
    && editEndMs > editStartMs
  ) {
    return {
      startMs: editStartMs,
      endMs: editEndMs,
    };
  }

  if (
    typeof startMs === 'number'
    && typeof endMs === 'number'
    && endMs > startMs
  ) {
    return {
      startMs,
      endMs,
    };
  }

  return null;
}

function ensureMinimumDuration(
  range: IResolvedRange,
  minDurationMs: number,
  durationMs: number,
): IResolvedRange {
  if (range.endMs <= range.startMs) {
    return {
      startMs: range.startMs,
      endMs: range.startMs,
    };
  }

  const minimum = Math.max(1_000, minDurationMs);
  const currentDuration = range.endMs - range.startMs;
  if (currentDuration >= minimum) return range;

  const desiredDuration = Math.min(durationMs, minimum);
  const center = (range.startMs + range.endMs) / 2;
  let startMs = Math.round(center - desiredDuration / 2);
  let endMs = startMs + desiredDuration;

  if (startMs < 0) {
    startMs = 0;
    endMs = desiredDuration;
  }
  if (endMs > durationMs) {
    endMs = durationMs;
    startMs = Math.max(0, endMs - desiredDuration);
  }

  return { startMs, endMs };
}

function mergeReasonTokens(left: string, right: string): string {
  const tokens = new Set(
    `${left}+${right}`
      .split('+')
      .map(token => token.trim())
      .filter(Boolean),
  );
  return [...tokens].join('+');
}

function canMergeWindowSemantics(
  left: Pick<IInterestingWindow, 'semanticKind'>,
  right: Pick<IInterestingWindow, 'semanticKind'>,
): boolean {
  return left.semanticKind == null
    || right.semanticKind == null
    || left.semanticKind === right.semanticKind;
}

function mergeSpeedCandidates(
  left?: ISpeedCandidateHint,
  right?: ISpeedCandidateHint,
): ISpeedCandidateHint | undefined {
  if (!left) return right;
  if (!right) return left;

  const rationaleTokens = new Set(
    [left.rationale, right.rationale]
      .flatMap(value => value.split(';'))
      .map(value => value.trim())
      .filter(Boolean),
  );

  return {
    suggestedSpeeds: [...new Set([
      ...left.suggestedSpeeds,
      ...right.suggestedSpeeds,
    ])].sort((a, b) => a - b),
    rationale: [...rationaleTokens].join('; '),
    confidence: Math.max(left.confidence ?? 0, right.confidence ?? 0) || undefined,
  };
}

function cloneWindow(window: IInterestingWindow): IInterestingWindow {
  return {
    ...window,
    ...(window.speedCandidate && {
      speedCandidate: {
        ...window.speedCandidate,
        suggestedSpeeds: [...window.speedCandidate.suggestedSpeeds],
      },
    }),
  };
}

function clampMs(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
