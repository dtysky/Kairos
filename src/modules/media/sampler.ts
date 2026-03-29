import type {
  IMediaAnalysisPlan, EClipType, ESamplingProfile,
  EVlmMode, ETargetBudget,
} from '../../protocol/schema.js';
import type { IDensityResult } from './density.js';
import type { IShotBoundary } from './shot-detect.js';

export interface ISamplerInput {
  assetId: string;
  durationMs: number;
  density: IDensityResult;
  shotBoundaries: IShotBoundary[];
  clipType?: EClipType;
  budget?: ETargetBudget;
}

/**
 * 生成采样计划：根据时长 + 信息密度决定采样策略。
 */
export function buildAnalysisPlan(input: ISamplerInput): IMediaAnalysisPlan {
  const clipType: EClipType = input.clipType ?? 'unknown';
  const budget: ETargetBudget = input.budget ?? 'standard';
  const profile = pickProfile(input.durationMs, input.density.score);
  const interval = pickInterval(input.durationMs, profile);

  const interestingWindows = findInterestingWindows(
    input.shotBoundaries,
    input.durationMs,
  );

  const vlmMode: EVlmMode = budget === 'coarse' ? 'none'
    : input.durationMs < 15000 ? 'video'
    : 'multi-image';

  return {
    assetId: input.assetId,
    clipType,
    densityScore: input.density.score,
    samplingProfile: profile,
    baseSampleIntervalMs: interval,
    interestingWindows,
    vlmMode,
    targetBudget: budget,
  };
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
  if (windows.length === 0) return [];
  const sorted = [...windows].sort((a, b) => a.startMs - b.startMs);
  const merged: typeof windows = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const prev = merged[merged.length - 1];
    const cur = sorted[i];
    if (cur.startMs <= prev.endMs) {
      prev.endMs = Math.max(prev.endMs, cur.endMs);
      prev.reason = `${prev.reason}+${cur.reason}`;
    } else {
      merged.push(cur);
    }
  }
  return merged;
}
