import type {
  IMediaAnalysisPlan, EClipType, ESamplingProfile,
  EVlmMode, ETargetBudget, EFineScanMode,
} from '../../protocol/schema.js';
import type { IDensityResult } from './density.js';
import type { IShotBoundary } from './shot-detect.js';
import { isSpeechSemanticWindow, mergeInterestingWindowsByPreferredBounds } from './window-policy.js';

export interface ISamplerInput {
  assetId: string;
  durationMs: number;
  density: IDensityResult;
  shotBoundaries: IShotBoundary[];
  clipType?: EClipType;
  budget?: ETargetBudget;
  extraInterestingWindows?: IMediaAnalysisPlan['interestingWindows'];
}

export interface IAnalysisDecision {
  clipType: EClipType;
  shouldFineScan: boolean;
  fineScanMode: EFineScanMode;
  decisionReasons: string[];
}

export interface IHeuristicAnalysisDecisionInput {
  durationMs: number;
  densityScore: number;
  interestingWindowCount: number;
  clipType?: EClipType;
  initialClipTypeGuess?: EClipType;
  budget?: ETargetBudget;
  sceneType?: string;
  subjects?: string[];
  summary?: string;
  transcript?: string;
  speechCoverage?: number;
  hasAudioTrack?: boolean;
  hasMeaningfulSpeech?: boolean;
  routeTransport?: string;
  spatialHintCount?: number;
}

/**
 * 生成采样计划：根据时长 + 信息密度决定采样策略。
 */
export function buildAnalysisPlan(input: ISamplerInput): IMediaAnalysisPlan {
  const clipType: EClipType = input.clipType ?? 'unknown';
  const budget: ETargetBudget = input.budget ?? 'standard';
  const profile = pickProfile(input.durationMs, input.density.score);
  const coarseSampleCount = pickCoarseSampleCount(input.durationMs);
  const interval = pickInterval(input.durationMs, profile);

  const shotInterestingWindows = findInterestingWindows(
    input.shotBoundaries,
    input.durationMs,
  );
  const extraInterestingWindows = input.extraInterestingWindows ?? [];
  const interestingWindows = mergeWindows(clipType === 'drive'
    ? [
      ...shotInterestingWindows.map(window => tagDriveWindowSemantic(window, 'visual')),
      ...extraInterestingWindows.map(window => tagDriveWindowSemantic(
        window,
        isSpeechSemanticWindow(window) ? 'speech' : 'visual',
      )),
    ]
    : [
      ...shotInterestingWindows,
      ...extraInterestingWindows,
    ]);

  const vlmMode: EVlmMode = budget === 'coarse' ? 'none'
    : input.durationMs < 15000 ? 'video'
    : 'multi-image';
  const fineScanMode = pickFineScanMode(
    input.durationMs,
    input.density.score,
    interestingWindows.length,
    clipType,
    budget,
  );
  const shouldFineScan = fineScanMode !== 'skip';

  return {
    assetId: input.assetId,
    clipType,
    densityScore: input.density.score,
    samplingProfile: profile,
    coarseSampleCount,
    baseSampleIntervalMs: interval,
    interestingWindows,
    vlmMode,
    targetBudget: budget,
    shouldFineScan,
    fineScanMode,
  };
}

export function applyAnalysisDecision(
  plan: IMediaAnalysisPlan,
  decision: IAnalysisDecision,
): IMediaAnalysisPlan {
  return {
    ...plan,
    clipType: decision.clipType,
    shouldFineScan: decision.shouldFineScan,
    fineScanMode: decision.fineScanMode,
  };
}

export function buildHeuristicAnalysisDecision(
  input: IHeuristicAnalysisDecisionInput,
): IAnalysisDecision {
  const clipType = resolveSemanticClipType(input);
  const budget: ETargetBudget = input.budget ?? 'standard';
  const fineScanMode = pickUnifiedFineScanMode({
    budget,
    durationMs: input.durationMs,
    densityScore: input.densityScore,
    interestingWindowCount: input.interestingWindowCount,
    clipType,
    speechCoverage: input.speechCoverage ?? 0,
    hasMeaningfulSpeech: input.hasMeaningfulSpeech ?? false,
    routeTransport: input.routeTransport,
  });

  const reasons = new Set<string>();
  reasons.add(`semantic-clip:${clipType}`);
  if (input.initialClipTypeGuess && input.initialClipTypeGuess !== clipType) {
    reasons.add(`clip-type-corrected:${input.initialClipTypeGuess}->${clipType}`);
  }
  if (input.sceneType) reasons.add(`visual-scene:${normalizeToken(input.sceneType)}`);
  if (input.interestingWindowCount > 0) reasons.add(`interesting-windows:${input.interestingWindowCount}`);
  if ((input.hasMeaningfulSpeech ?? false)) reasons.add('meaningful-human-speech');
  if ((input.speechCoverage ?? 0) >= 0.2) reasons.add('high-speech-coverage');
  if ((input.hasAudioTrack ?? false) && !(input.hasMeaningfulSpeech ?? false)) {
    reasons.add('audio-without-meaningful-speech');
  }
  if ((input.spatialHintCount ?? 0) > 0) reasons.add(`spatial-hints:${input.spatialHintCount}`);
  if (input.routeTransport) reasons.add(`route-transport:${normalizeToken(input.routeTransport)}`);
  reasons.add(`fine-scan:${fineScanMode}`);
  if (fineScanMode === 'skip') reasons.add('coarse-scan-sufficient');

  return {
    clipType,
    shouldFineScan: fineScanMode !== 'skip',
    fineScanMode,
    decisionReasons: [...reasons],
  };
}

export function pickCoarseSampleCount(durationMs: number): number {
  const seconds = durationMs / 1000;
  if (seconds <= 5) return 2;
  if (seconds <= 15) return 3;
  if (seconds <= 60) return 4;
  if (seconds <= 5 * 60) return 6;
  if (seconds <= 20 * 60) return 8;
  return 12;
}

function pickProfile(durationMs: number, density: number): ESamplingProfile {
  if (durationMs < 15000 || density > 0.7) return 'dense';
  if (durationMs < 60000 || density > 0.4) return 'balanced';
  return 'sparse';
}

function pickInterval(durationMs: number, profile: ESamplingProfile): number {
  const sec = durationMs / 1000;
  if (profile === 'dense') return sec <= 15 ? 500 : 1500;
  if (profile === 'balanced') return sec <= 60 ? 2000 : 4000;
  if (sec <= 300) return 8000;
  if (sec <= 1200) return 12000;
  return 20000;
}

function pickUnifiedFineScanMode(input: {
  budget: ETargetBudget;
  durationMs: number;
  densityScore: number;
  interestingWindowCount: number;
  clipType: EClipType;
  speechCoverage: number;
  hasMeaningfulSpeech: boolean;
  routeTransport?: string;
}): EFineScanMode {
  if (input.budget === 'coarse') return 'skip';

  const heuristicMode = pickFineScanMode(
    input.durationMs,
    input.densityScore,
    input.interestingWindowCount,
    input.clipType,
    input.budget,
  );

  if (input.hasMeaningfulSpeech) {
    if (input.clipType === 'talking-head' && input.durationMs <= 3 * 60_000 && input.speechCoverage >= 0.3) {
      return 'full';
    }
    if (heuristicMode === 'skip') {
      return input.durationMs <= 3 * 60_000 ? 'full' : 'windowed';
    }
  }

  if (input.routeTransport === 'drive' && heuristicMode === 'skip' && input.durationMs >= 2 * 60_000) {
    return 'windowed';
  }

  if (input.interestingWindowCount > 0 && heuristicMode === 'skip') {
    return 'windowed';
  }

  return heuristicMode;
}

function pickFineScanMode(
  durationMs: number,
  density: number,
  interestingWindowCount: number,
  clipType: EClipType,
  budget: ETargetBudget,
): EFineScanMode {
  if (budget === 'coarse') return 'skip';

  // Long driving footage should stay cheap by default, but once we have
  // visual or spatial windows (GPS / itinerary / OCR landmarks), we can
  // safely upgrade it to windowed fine-scan.
  if (clipType === 'drive') {
    if (interestingWindowCount > 0 || density >= 0.55) {
      return 'windowed';
    }
    return 'skip';
  }

  if (durationMs <= 120000 && density >= 0.4) {
    return 'full';
  }

  if (interestingWindowCount > 0 || density >= 0.55) {
    return 'windowed';
  }

  if (clipType === 'aerial' || clipType === 'talking-head' || clipType === 'broll') {
    return 'windowed';
  }

  return 'skip';
}

function resolveSemanticClipType(input: IHeuristicAnalysisDecisionInput): EClipType {
  const semanticHints = [
    input.sceneType,
    input.summary,
    ...(input.subjects ?? []),
    input.hasMeaningfulSpeech ? input.transcript : undefined,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  if (includesAny(semanticHints, [
    'driving',
    'drive',
    'dashboard',
    'windshield',
    'road lane',
    'highway',
    'vehicle drives',
    'car driving',
    'road trip',
  ])) {
    return 'drive';
  }

  if (includesAny(semanticHints, [
    'aerial',
    'drone',
    'bird-eye',
    'birds-eye',
    'overhead',
  ])) {
    return 'aerial';
  }

  if (includesAny(semanticHints, [
    'timelapse',
    'time-lapse',
    'time lapse',
  ])) {
    return 'timelapse';
  }

  if (input.hasMeaningfulSpeech) {
    if (includesAny(semanticHints, [
      'talking',
      'speaking',
      'speaker',
      'interview',
      'monologue',
      'dialogue',
      'conversation',
      'portrait',
      'vlog',
    ])) {
      return 'talking-head';
    }
    if (input.durationMs <= 8 * 60_000) {
      return 'talking-head';
    }
  }

  if (input.routeTransport === 'drive' && input.durationMs >= 2 * 60_000) {
    return 'drive';
  }

  if (input.clipType && input.clipType !== 'unknown') {
    return input.clipType;
  }

  if (includesAny(semanticHints, [
    'landscape',
    'cityscape',
    'landmark',
    'nature',
    'food',
    'interior',
    'street',
    'mountain',
    'lake',
    'coast',
    'building',
    'walk',
  ])) {
    return 'broll';
  }

  if (input.durationMs > 0 && input.durationMs <= 20_000) {
    return 'broll';
  }

  return input.initialClipTypeGuess ?? 'unknown';
}

function findInterestingWindows(
  boundaries: IShotBoundary[],
  durationMs: number,
): IMediaAnalysisPlan['interestingWindows'] {
  const windows: IMediaAnalysisPlan['interestingWindows'] = [];

  // Dense shot clusters → interesting
  for (let i = 1; i < boundaries.length; i++) {
    const gap = boundaries[i].timeMs - boundaries[i - 1].timeMs;
    if (gap < 2000 && gap > 0) {
      const start = Math.max(0, boundaries[i - 1].timeMs - 1000);
      const end = Math.min(durationMs, boundaries[i].timeMs + 1000);
      windows.push({ startMs: start, endMs: end, reason: 'dense-shot-cluster' });
    }
  }

  // High scene-change score → interesting
  for (const b of boundaries) {
    if (b.score > 0.7) {
      const start = Math.max(0, b.timeMs - 2000);
      const end = Math.min(durationMs, b.timeMs + 2000);
      windows.push({ startMs: start, endMs: end, reason: 'high-scene-score' });
    }
  }

  return mergeWindows(windows);
}

function mergeWindows(
  windows: IMediaAnalysisPlan['interestingWindows'],
): IMediaAnalysisPlan['interestingWindows'] {
  return mergeInterestingWindowsByPreferredBounds(windows);
}

function tagDriveWindowSemantic(
  window: IMediaAnalysisPlan['interestingWindows'][number],
  semanticKind: 'speech' | 'visual',
): IMediaAnalysisPlan['interestingWindows'][number] {
  return {
    ...window,
    semanticKind: window.semanticKind ?? semanticKind,
  };
}

function includesAny(value: string, needles: string[]): boolean {
  return needles.some(needle => value.includes(needle));
}

function normalizeToken(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, '-');
}
