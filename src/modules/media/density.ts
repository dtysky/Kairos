import type { IShotBoundary } from './shot-detect.js';
import type { IAsrSegment } from './ml-client.js';

export interface IDensityInput {
  durationMs: number;
  shotBoundaries: IShotBoundary[];
  asrSegments?: IAsrSegment[];
  ocrHitCount?: number;
}

export interface IDensityResult {
  score: number;
  shotRate: number;
  speechRatio: number;
  ocrDensity: number;
}

/**
 * 信息密度估算：综合镜头切换率、语音占比、OCR 命中。
 * 返回 0-1 的综合得分。
 */
export function estimateDensity(input: IDensityInput): IDensityResult {
  const durSec = input.durationMs / 1000;
  if (durSec <= 0) return { score: 0, shotRate: 0, speechRatio: 0, ocrDensity: 0 };

  const shotRate = input.shotBoundaries.length / durSec;

  let speechDurSec = 0;
  if (input.asrSegments) {
    for (const s of input.asrSegments) {
      speechDurSec += s.end - s.start;
    }
  }
  const speechRatio = Math.min(speechDurSec / durSec, 1);

  const ocrDensity = Math.min((input.ocrHitCount ?? 0) / durSec, 1);

  // weighted average
  const score = Math.min(
    shotRate * 0.4 + speechRatio * 0.35 + ocrDensity * 0.25,
    1,
  );

  return { score, shotRate, speechRatio, ocrDensity };
}
