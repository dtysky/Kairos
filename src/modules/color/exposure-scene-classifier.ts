import { execFile } from 'node:child_process';
import type { ExecFileOptionsWithBufferEncoding } from 'node:child_process';
import { promisify } from 'node:util';
import { toExecutableInputPath } from '../media/tool-path.js';
import type { IMediaToolConfig } from '../media/probe.js';

const execFileBuffer = promisify(execFile);
const CEXPOSURE_PROXY_WIDTH = 180;
const CEXPOSURE_PROXY_HEIGHT = 102;
const CEXPOSURE_SAMPLE_POSITION = 0.50;
const CWHITE_REFERENCE_TARGET_P90_LUMA = 0.78;
const CWHITE_REFERENCE_SAFE_P98_AFTER_LIFT = 0.96;
const CWHITE_REFERENCE_MIN_ACTIONABLE_EV_LIFT = 0.25;

export type TColorExposureSceneClass = 'normal' | 'high-contrast' | 'overexposed' | 'underexposed' | 'unknown';

export interface IColorExposureSceneFrameMetrics {
  exposureSceneClass: TColorExposureSceneClass;
  confidence: number;
  exposureSceneReason?: string;
  meanLuma: number;
  p02Luma: number;
  p10Luma: number;
  p50Luma: number;
  p90Luma: number;
  p98Luma: number;
  clippedDarkFraction: number;
  darkFraction: number;
  shadowFraction: number;
  midtoneFraction: number;
  brightFraction: number;
  clippedBrightFraction: number;
  lumaSpread: number;
  whiteReferenceCandidateFraction: number;
  whiteReferenceMeanLuma: number;
  whiteReferenceP50Luma: number;
  whiteReferenceP90Luma: number;
  whiteReferenceP98Luma: number;
  whiteReferenceUnderexposedScore?: number;
  whiteReferenceEvLiftToTarget?: number;
  whiteReferencePredictedP98AfterLift?: number;
}

export interface IColorExposureSceneMetrics extends Record<string, unknown> {
  frameCount: number;
  classifiedFrameCount: number;
  meanLuma: number;
  p02Luma: number;
  p10Luma: number;
  p50Luma: number;
  p90Luma: number;
  p98Luma: number;
  clippedDarkFraction: number;
  darkFraction: number;
  shadowFraction: number;
  midtoneFraction: number;
  brightFraction: number;
  clippedBrightFraction: number;
  lumaSpread: number;
  whiteReferenceCandidateFraction: number;
  whiteReferenceMeanLuma: number;
  whiteReferenceP50Luma: number;
  whiteReferenceP90Luma: number;
  whiteReferenceP98Luma: number;
  whiteReferenceUnderexposedScore?: number;
  whiteReferenceEvLiftToTarget?: number;
  whiteReferencePredictedP98AfterLift?: number;
  frames: IColorExposureSceneFrameMetrics[];
}

export interface IColorExposureSceneClassification {
  exposureSceneClass: TColorExposureSceneClass;
  exposureSceneConfidence: number;
  exposureSceneMetrics: IColorExposureSceneMetrics;
}

export async function classifyExposureScene(
  filePath: string,
  tools?: Pick<IMediaToolConfig, 'ffmpegPath'>,
  options: {
    durationMs?: number | null;
    lutPath?: string;
  } = {},
): Promise<IColorExposureSceneClassification> {
  const frames = await extractExposureSceneFrames(filePath, tools, {
    durationMs: options.durationMs,
    lutPath: options.lutPath,
  });
  return classifyExposureSceneFrames(frames);
}

export function classifyRgbFrameExposureScene(input: {
  buffer: Buffer | Uint8Array;
  width: number;
  height: number;
}): IColorExposureSceneFrameMetrics {
  const pixelCount = Math.min(
    Math.floor(input.buffer.length / 3),
    Math.max(0, Math.floor(input.width) * Math.floor(input.height)),
  );
  if (pixelCount <= 0 || input.width <= 0 || input.height <= 0) {
    return buildUnknownFrameMetrics();
  }

  const lumaValues: number[] = [];
  let clippedDarkCount = 0;
  let darkCount = 0;
  let shadowCount = 0;
  let midtoneCount = 0;
  let brightCount = 0;
  let clippedBrightCount = 0;
  const whiteReferenceLumaValues: number[] = [];
  for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex += 1) {
    const offset = pixelIndex * 3;
    const red = input.buffer[offset] / 255;
    const green = input.buffer[offset + 1] / 255;
    const blue = input.buffer[offset + 2] / 255;
    const luma = (0.2126 * red) + (0.7152 * green) + (0.0722 * blue);
    const maximum = Math.max(red, green, blue);
    const minimum = Math.min(red, green, blue);
    const saturation = maximum <= 0 ? 0 : (maximum - minimum) / maximum;
    if (luma <= 0.03) clippedDarkCount += 1;
    if (luma < 0.12) darkCount += 1;
    if (luma < 0.22) shadowCount += 1;
    if (luma >= 0.22 && luma <= 0.78) midtoneCount += 1;
    if (luma > 0.82) brightCount += 1;
    if (luma >= 0.97) clippedBrightCount += 1;
    if (saturation < 0.18 && luma > 0.35) {
      whiteReferenceLumaValues.push(luma);
    }
    lumaValues.push(luma);
  }

  const sortedLuma = [...lumaValues].sort((left, right) => left - right);
  const sortedWhiteReferenceLuma = [...whiteReferenceLumaValues].sort((left, right) => left - right);
  const metrics = {
    meanLuma: average(lumaValues),
    p02Luma: percentile(sortedLuma, 0.02),
    p10Luma: percentile(sortedLuma, 0.10),
    p50Luma: percentile(sortedLuma, 0.50),
    p90Luma: percentile(sortedLuma, 0.90),
    p98Luma: percentile(sortedLuma, 0.98),
    clippedDarkFraction: clippedDarkCount / pixelCount,
    darkFraction: darkCount / pixelCount,
    shadowFraction: shadowCount / pixelCount,
    midtoneFraction: midtoneCount / pixelCount,
    brightFraction: brightCount / pixelCount,
    clippedBrightFraction: clippedBrightCount / pixelCount,
    whiteReferenceCandidateFraction: whiteReferenceLumaValues.length / pixelCount,
    whiteReferenceMeanLuma: average(whiteReferenceLumaValues),
    whiteReferenceP50Luma: percentile(sortedWhiteReferenceLuma, 0.50),
    whiteReferenceP90Luma: percentile(sortedWhiteReferenceLuma, 0.90),
    whiteReferenceP98Luma: percentile(sortedWhiteReferenceLuma, 0.98),
  };
  const lumaSpread = metrics.p98Luma - metrics.p02Luma;
  const whiteReferenceEvidence = scoreWhiteReferenceUnderexposure(metrics, lumaSpread);

  const highContrastScore = Math.min(
    scoreAbove(metrics.shadowFraction, 0.24, 0.24),
    scoreAbove(metrics.brightFraction, 0.18, 0.22),
  ) * scoreAbove(lumaSpread, 0.72, 0.18);
  if (
    highContrastScore >= 0.55
    && metrics.p10Luma <= 0.18
    && metrics.p90Luma >= 0.80
  ) {
    return {
      exposureSceneClass: 'high-contrast',
      confidence: clamp(0.62 + (highContrastScore * 0.32), 0.62, 0.96),
      ...metrics,
      lumaSpread,
      ...whiteReferenceEvidence.metrics,
    };
  }

  const backlitHighContrastScore = Math.min(
    scoreBelow(metrics.p02Luma, 0.08, 0.05),
    scoreBelow(metrics.p10Luma, 0.14, 0.10),
    scoreAbove(metrics.p98Luma, 0.72, 0.08),
    scoreAbove(lumaSpread, 0.66, 0.12),
    Math.max(
      scoreAbove(metrics.darkFraction, 0.06, 0.12),
      scoreAbove(metrics.shadowFraction, 0.14, 0.16),
    ),
  );
  if (backlitHighContrastScore >= 0.55) {
    return {
      exposureSceneClass: 'high-contrast',
      exposureSceneReason: 'backlit-high-contrast',
      confidence: clamp(0.60 + (backlitHighContrastScore * 0.34), 0.60, 0.95),
      ...metrics,
      lumaSpread,
      ...whiteReferenceEvidence.metrics,
    };
  }

  if (
    lumaSpread >= 0.86
    && metrics.p10Luma <= 0.16
    && metrics.p90Luma >= 0.88
    && metrics.p98Luma >= 0.94
    && metrics.brightFraction >= 0.10
    && (metrics.darkFraction >= 0.08 || metrics.shadowFraction >= 0.20)
  ) {
    return {
      exposureSceneClass: 'high-contrast',
      confidence: 0.78,
      ...metrics,
      lumaSpread,
      ...whiteReferenceEvidence.metrics,
    };
  }

  const overexposedScore = Math.max(
    Math.min(scoreAbove(metrics.clippedBrightFraction, 0.10, 0.20), scoreAbove(metrics.p50Luma, 0.60, 0.25)),
    Math.min(scoreAbove(metrics.brightFraction, 0.48, 0.30), scoreAbove(metrics.p10Luma, 0.34, 0.28)),
    Math.min(scoreAbove(metrics.meanLuma, 0.72, 0.18), scoreAbove(metrics.p90Luma, 0.94, 0.06)),
  );
  if (overexposedScore >= 0.62) {
    return {
      exposureSceneClass: 'overexposed',
      confidence: clamp(0.62 + (overexposedScore * 0.30), 0.62, 0.96),
      ...metrics,
      lumaSpread,
      ...whiteReferenceEvidence.metrics,
    };
  }

  const underexposedScore = Math.max(
    Math.min(scoreAbove(metrics.clippedDarkFraction, 0.16, 0.25), scoreBelow(metrics.p50Luma, 0.28, 0.22)),
    Math.min(scoreAbove(metrics.darkFraction, 0.44, 0.34), scoreBelow(metrics.p90Luma, 0.56, 0.26)),
    Math.min(scoreBelow(metrics.meanLuma, 0.25, 0.18), scoreBelow(metrics.brightFraction, 0.08, 0.08)),
  );
  if (underexposedScore >= 0.62) {
    return {
      exposureSceneClass: 'underexposed',
      confidence: clamp(0.62 + (underexposedScore * 0.30), 0.62, 0.96),
      ...metrics,
      lumaSpread,
      ...whiteReferenceEvidence.metrics,
    };
  }

  const strictWhiteReferenceUnderexposedScore = Math.min(
    scoreAbove(metrics.whiteReferenceCandidateFraction, 0.30, 0.30),
    scoreAbove(metrics.whiteReferenceP50Luma, 0.55, 0.12),
    scoreAbove(metrics.whiteReferenceP90Luma, 0.62, 0.12),
    scoreBelow(metrics.whiteReferenceP98Luma, 0.82, 0.16),
    scoreBelow(metrics.p90Luma, 0.80, 0.16),
    scoreBelow(metrics.brightFraction, 0.03, 0.03),
  );
  const compressedWhiteReferenceUnderexposedScore = Math.min(
    scoreAbove(metrics.whiteReferenceCandidateFraction, 0.34, 0.28),
    scoreAbove(metrics.whiteReferenceMeanLuma, 0.48, 0.12),
    scoreBelow(metrics.whiteReferenceMeanLuma, 0.72, 0.14),
    scoreAbove(metrics.whiteReferenceP90Luma, 0.58, 0.14),
    scoreBelow(metrics.whiteReferenceP98Luma, 0.86, 0.14),
    scoreBelow(metrics.p90Luma, 0.82, 0.14),
    scoreBelow(metrics.brightFraction, 0.08, 0.08),
  );
  const whiteReferenceUnderexposedScore = Math.max(
    strictWhiteReferenceUnderexposedScore,
    compressedWhiteReferenceUnderexposedScore,
    whiteReferenceEvidence.score,
  );
  if (
    whiteReferenceUnderexposedScore >= 0.60
    || (
      whiteReferenceEvidence.score >= 0.25
      && (whiteReferenceEvidence.metrics.whiteReferenceEvLiftToTarget ?? 0) >= CWHITE_REFERENCE_MIN_ACTIONABLE_EV_LIFT
    )
  ) {
    return {
      exposureSceneClass: 'underexposed',
      exposureSceneReason: 'white-reference-underexposed',
      confidence: clamp(0.62 + (whiteReferenceUnderexposedScore * 0.30), 0.62, 0.94),
      ...metrics,
      lumaSpread,
      ...whiteReferenceEvidence.metrics,
    };
  }

  return {
    exposureSceneClass: 'normal',
    confidence: clamp(0.55 + (metrics.midtoneFraction * 0.25), 0.35, 0.88),
    ...metrics,
    lumaSpread,
    ...whiteReferenceEvidence.metrics,
  };
}

function classifyExposureSceneFrames(
  frames: IColorExposureSceneFrameMetrics[],
): IColorExposureSceneClassification {
  const classified = frames.filter(frame => frame.exposureSceneClass !== 'unknown');
  if (classified.length === 0) {
    return buildUnknownClassification(frames);
  }
  const abnormal = classified.filter(frame => frame.exposureSceneClass !== 'normal');
  if (abnormal.length === 0) {
    return buildClassification('normal', average(classified.map(frame => frame.confidence)), classified, frames);
  }
  const counts = new Map<TColorExposureSceneClass, { count: number; confidence: number }>();
  for (const frame of abnormal) {
    const entry = counts.get(frame.exposureSceneClass) ?? { count: 0, confidence: 0 };
    entry.count += 1;
    entry.confidence += frame.confidence;
    counts.set(frame.exposureSceneClass, entry);
  }
  const [topClass, top] = [...counts.entries()]
    .sort((left, right) => (right[1].count - left[1].count) || (right[1].confidence - left[1].confidence))[0]
    ?? ['unknown', { count: 0, confidence: 0 }];
  if (topClass === 'unknown' || top.count <= 0) {
    return buildUnknownClassification(frames);
  }
  return buildClassification(topClass, top.confidence / top.count, classified, frames);
}

async function extractExposureSceneFrames(
  filePath: string,
  tools?: Pick<IMediaToolConfig, 'ffmpegPath'>,
  options: {
    durationMs?: number | null;
    lutPath?: string;
  } = {},
): Promise<IColorExposureSceneFrameMetrics[]> {
  const ffmpeg = tools?.ffmpegPath?.trim() || 'ffmpeg';
  const positions = resolveSampleSeconds(options.durationMs);
  const frames: IColorExposureSceneFrameMetrics[] = [];
  for (const seconds of positions) {
    const buffer = await extractRgbFrame(filePath, ffmpeg, seconds, options.lutPath).catch(() => null);
    if (!buffer) continue;
    frames.push(classifyRgbFrameExposureScene({
      buffer,
      width: CEXPOSURE_PROXY_WIDTH,
      height: CEXPOSURE_PROXY_HEIGHT,
    }));
  }
  if (frames.length > 0) return frames;
  throw new Error(`ffmpeg returned no exposure-scene sample frames for ${filePath}`);
}

async function extractRgbFrame(
  filePath: string,
  ffmpeg: string,
  seconds?: number,
  lutPath?: string,
): Promise<Buffer> {
  const inputPath = toExecutableInputPath(filePath, ffmpeg);
  const args = ['-v', 'error'];
  if (seconds != null && Number.isFinite(seconds) && seconds > 0) {
    args.push('-ss', seconds.toFixed(3));
  }
  const filters = [
    `scale=${CEXPOSURE_PROXY_WIDTH}:${CEXPOSURE_PROXY_HEIGHT}:flags=area`,
    ...(lutPath ? [`lut3d=file=${quoteFfmpegFilterValue(lutPath)}:interp=tetrahedral`] : []),
    'format=rgb24',
  ];
  args.push(
    '-i', inputPath,
    '-vf', filters.join(','),
    '-frames:v', '1',
    '-f', 'rawvideo',
    'pipe:1',
  );
  const { stdout } = await execFileBuffer(ffmpeg, args, {
    encoding: 'buffer',
    maxBuffer: 16 * 1024 * 1024,
  } satisfies ExecFileOptionsWithBufferEncoding);
  const buffer = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
  if (buffer.length < CEXPOSURE_PROXY_WIDTH * CEXPOSURE_PROXY_HEIGHT * 3) {
    throw new Error(`ffmpeg returned an incomplete exposure-scene frame for ${filePath}`);
  }
  return buffer;
}

function resolveSampleSeconds(durationMs?: number | null): Array<number | undefined> {
  if (!durationMs || durationMs <= 0) return [undefined];
  const durationSeconds = durationMs / 1000;
  return [Math.min(
    Math.max(0, durationSeconds * CEXPOSURE_SAMPLE_POSITION),
    Math.max(0, durationSeconds - 0.25),
  )];
}

function quoteFfmpegFilterValue(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function buildClassification(
  exposureSceneClass: TColorExposureSceneClass,
  confidence: number,
  classifiedFrames: IColorExposureSceneFrameMetrics[],
  frames: IColorExposureSceneFrameMetrics[],
): IColorExposureSceneClassification {
  return {
    exposureSceneClass,
    exposureSceneConfidence: clamp(confidence, 0, 0.98),
    exposureSceneMetrics: {
      frameCount: frames.length,
      classifiedFrameCount: classifiedFrames.length,
      meanLuma: average(classifiedFrames.map(frame => frame.meanLuma)),
      p02Luma: median(classifiedFrames.map(frame => frame.p02Luma)),
      p10Luma: median(classifiedFrames.map(frame => frame.p10Luma)),
      p50Luma: median(classifiedFrames.map(frame => frame.p50Luma)),
      p90Luma: median(classifiedFrames.map(frame => frame.p90Luma)),
      p98Luma: median(classifiedFrames.map(frame => frame.p98Luma)),
      clippedDarkFraction: average(classifiedFrames.map(frame => frame.clippedDarkFraction)),
      darkFraction: average(classifiedFrames.map(frame => frame.darkFraction)),
      shadowFraction: average(classifiedFrames.map(frame => frame.shadowFraction)),
      midtoneFraction: average(classifiedFrames.map(frame => frame.midtoneFraction)),
      brightFraction: average(classifiedFrames.map(frame => frame.brightFraction)),
      clippedBrightFraction: average(classifiedFrames.map(frame => frame.clippedBrightFraction)),
      lumaSpread: average(classifiedFrames.map(frame => frame.lumaSpread)),
      whiteReferenceCandidateFraction: average(classifiedFrames.map(frame => frame.whiteReferenceCandidateFraction)),
      whiteReferenceMeanLuma: average(classifiedFrames.map(frame => frame.whiteReferenceMeanLuma)),
      whiteReferenceP50Luma: median(classifiedFrames.map(frame => frame.whiteReferenceP50Luma)),
      whiteReferenceP90Luma: median(classifiedFrames.map(frame => frame.whiteReferenceP90Luma)),
      whiteReferenceP98Luma: median(classifiedFrames.map(frame => frame.whiteReferenceP98Luma)),
      whiteReferenceUnderexposedScore: average(classifiedFrames.map(frame => frame.whiteReferenceUnderexposedScore ?? 0)),
      whiteReferenceEvLiftToTarget: median(classifiedFrames.map(frame => frame.whiteReferenceEvLiftToTarget ?? 0)),
      whiteReferencePredictedP98AfterLift: median(classifiedFrames.map(frame => (
        frame.whiteReferencePredictedP98AfterLift ?? 0
      ))),
      exposureSceneReasons: dedupeStrings(
        classifiedFrames
          .map(frame => frame.exposureSceneReason)
          .filter((reason): reason is string => typeof reason === 'string' && reason.trim().length > 0),
      ),
      frames,
    },
  };
}

function buildUnknownClassification(frames: IColorExposureSceneFrameMetrics[]): IColorExposureSceneClassification {
  return {
    exposureSceneClass: 'unknown',
    exposureSceneConfidence: 0,
    exposureSceneMetrics: {
      frameCount: frames.length,
      classifiedFrameCount: 0,
      meanLuma: 0,
      p02Luma: 0,
      p10Luma: 0,
      p50Luma: 0,
      p90Luma: 0,
      p98Luma: 0,
      clippedDarkFraction: 0,
      darkFraction: 0,
      shadowFraction: 0,
      midtoneFraction: 0,
      brightFraction: 0,
      clippedBrightFraction: 0,
      lumaSpread: 0,
      whiteReferenceCandidateFraction: 0,
      whiteReferenceMeanLuma: 0,
      whiteReferenceP50Luma: 0,
      whiteReferenceP90Luma: 0,
      whiteReferenceP98Luma: 0,
      whiteReferenceUnderexposedScore: 0,
      whiteReferenceEvLiftToTarget: 0,
      whiteReferencePredictedP98AfterLift: 0,
      exposureSceneReasons: [],
      frames,
    },
  };
}

function buildUnknownFrameMetrics(): IColorExposureSceneFrameMetrics {
  return {
    exposureSceneClass: 'unknown',
    confidence: 0,
    meanLuma: 0,
    p02Luma: 0,
    p10Luma: 0,
    p50Luma: 0,
    p90Luma: 0,
    p98Luma: 0,
    clippedDarkFraction: 0,
    darkFraction: 0,
    shadowFraction: 0,
    midtoneFraction: 0,
    brightFraction: 0,
    clippedBrightFraction: 0,
    lumaSpread: 0,
    whiteReferenceCandidateFraction: 0,
    whiteReferenceMeanLuma: 0,
    whiteReferenceP50Luma: 0,
    whiteReferenceP90Luma: 0,
    whiteReferenceP98Luma: 0,
    whiteReferenceUnderexposedScore: 0,
    whiteReferenceEvLiftToTarget: 0,
    whiteReferencePredictedP98AfterLift: 0,
  };
}

function scoreWhiteReferenceUnderexposure(
  metrics: {
    p98Luma: number;
    brightFraction: number;
    clippedBrightFraction: number;
    whiteReferenceCandidateFraction: number;
    whiteReferenceP90Luma: number;
  },
  lumaSpread: number,
): {
  score: number;
  metrics: {
    whiteReferenceUnderexposedScore: number;
    whiteReferenceEvLiftToTarget: number;
    whiteReferencePredictedP98AfterLift: number;
  };
} {
  const referenceP90 = Math.max(metrics.whiteReferenceP90Luma, 0.01);
  const liftGain = CWHITE_REFERENCE_TARGET_P90_LUMA / referenceP90;
  const evLiftToTarget = Math.max(0, Math.log2(liftGain));
  const predictedP98AfterLift = metrics.p98Luma * liftGain;
  const score = Math.min(
    scoreAbove(metrics.whiteReferenceCandidateFraction, 0.28, 0.32),
    scoreAbove(evLiftToTarget, 0.18, 0.42),
    scoreBelow(predictedP98AfterLift, CWHITE_REFERENCE_SAFE_P98_AFTER_LIFT, 0.16),
    scoreBelow(metrics.p98Luma, 0.86, 0.16),
    scoreBelow(metrics.brightFraction, 0.025, 0.025),
    scoreBelow(metrics.clippedBrightFraction, 0.003, 0.003),
    scoreAbove(lumaSpread, 0.20, 0.24),
  );
  return {
    score,
    metrics: {
      whiteReferenceUnderexposedScore: score,
      whiteReferenceEvLiftToTarget: evLiftToTarget,
      whiteReferencePredictedP98AfterLift: predictedP98AfterLift,
    },
  };
}

function scoreAbove(value: number, threshold: number, range: number): number {
  return clamp((value - threshold) / range, 0, 1);
}

function scoreBelow(value: number, threshold: number, range: number): number {
  return clamp((threshold - value) / range, 0, 1);
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return percentile(sorted, 0.50);
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))];
}

function percentile(sortedValues: number[], ratio: number): number {
  if (sortedValues.length === 0) return 0;
  const clamped = Math.min(1, Math.max(0, ratio));
  const index = Math.min(sortedValues.length - 1, Math.max(0, Math.round((sortedValues.length - 1) * clamped)));
  return sortedValues[index] ?? 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
