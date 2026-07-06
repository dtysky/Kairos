import { execFile } from 'node:child_process';
import type { ExecFileOptionsWithBufferEncoding } from 'node:child_process';
import { promisify } from 'node:util';
import { toExecutableInputPath } from '../media/tool-path.js';
import type { IMediaToolConfig } from '../media/probe.js';

const execFileBuffer = promisify(execFile);
const CWINDOW_HAZE_PROXY_WIDTH = 180;
const CWINDOW_HAZE_PROXY_HEIGHT = 102;
const CWINDOW_HAZE_SAMPLE_POSITIONS = [0.25, 0.50, 0.75];

export interface IColorWindshieldHazeFrameMetrics {
  windshieldHaze: boolean;
  confidence: number;
  windshieldHazeReason?: string;
  meanLuma: number;
  p02Luma: number;
  p10Luma: number;
  p50Luma: number;
  p90Luma: number;
  p98Luma: number;
  brightFraction: number;
  clippedBrightFraction: number;
  lumaSpread: number;
  meanSaturation: number;
  whiteReferenceCandidateFraction: number;
  whiteReferenceP50Luma: number;
  whiteReferenceP90Luma: number;
  whiteReferenceP98Luma: number;
  lowerBandMeanLuma: number;
  lowerBandDarkFraction: number;
  lowerBandShadowFraction: number;
  vehicleForegroundScore: number;
  grayCompressionScore: number;
  daylightScore: number;
  hazeScore: number;
}

export interface IColorWindshieldHazeMetrics extends Record<string, unknown> {
  frameCount: number;
  classifiedFrameCount: number;
  positiveFrameCount: number;
  positiveFrameRatio: number;
  meanConfidence: number;
  frames: IColorWindshieldHazeFrameMetrics[];
}

export interface IColorWindshieldHazeClassification {
  windshieldHaze: boolean;
  windshieldHazeConfidence: number;
  windshieldHazeMetrics: IColorWindshieldHazeMetrics;
}

export async function classifyWindshieldHaze(
  filePath: string,
  tools?: Pick<IMediaToolConfig, 'ffmpegPath'>,
  options: {
    durationMs?: number | null;
    lutPath?: string;
  } = {},
): Promise<IColorWindshieldHazeClassification> {
  const frames = await extractWindshieldHazeFrames(filePath, tools, {
    durationMs: options.durationMs,
    lutPath: options.lutPath,
  });
  return classifyWindshieldHazeFrames(frames);
}

export function classifyRgbFrameWindshieldHaze(input: {
  buffer: Buffer | Uint8Array;
  width: number;
  height: number;
}): IColorWindshieldHazeFrameMetrics {
  const width = Math.max(0, Math.floor(input.width));
  const height = Math.max(0, Math.floor(input.height));
  const pixelCount = Math.min(
    Math.floor(input.buffer.length / 3),
    width * height,
  );
  if (pixelCount <= 0 || width <= 0 || height <= 0) {
    return buildEmptyFrameMetrics();
  }

  const lumaValues: number[] = [];
  const saturationValues: number[] = [];
  const whiteReferenceLumaValues: number[] = [];
  const lowerBandLumaValues: number[] = [];
  let brightCount = 0;
  let clippedBrightCount = 0;
  let lowerBandDarkCount = 0;
  let lowerBandShadowCount = 0;
  const lowerBandStartY = Math.max(0, Math.floor(height * 0.78));

  for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex += 1) {
    const offset = pixelIndex * 3;
    const red = input.buffer[offset] / 255;
    const green = input.buffer[offset + 1] / 255;
    const blue = input.buffer[offset + 2] / 255;
    const luma = (0.2126 * red) + (0.7152 * green) + (0.0722 * blue);
    const maximum = Math.max(red, green, blue);
    const minimum = Math.min(red, green, blue);
    const saturation = maximum <= 0 ? 0 : (maximum - minimum) / maximum;
    const y = Math.floor(pixelIndex / width);

    if (luma > 0.82) brightCount += 1;
    if (luma >= 0.97) clippedBrightCount += 1;
    if (saturation < 0.22 && luma > 0.32) {
      whiteReferenceLumaValues.push(luma);
    }
    if (y >= lowerBandStartY) {
      lowerBandLumaValues.push(luma);
      if (luma < 0.18) lowerBandDarkCount += 1;
      if (luma < 0.28) lowerBandShadowCount += 1;
    }
    lumaValues.push(luma);
    saturationValues.push(saturation);
  }

  const sortedLuma = [...lumaValues].sort((left, right) => left - right);
  const sortedWhiteReference = [...whiteReferenceLumaValues].sort((left, right) => left - right);
  const sortedLowerBand = [...lowerBandLumaValues].sort((left, right) => left - right);
  const p02Luma = percentile(sortedLuma, 0.02);
  const p10Luma = percentile(sortedLuma, 0.10);
  const p50Luma = percentile(sortedLuma, 0.50);
  const p90Luma = percentile(sortedLuma, 0.90);
  const p98Luma = percentile(sortedLuma, 0.98);
  const lumaSpread = p98Luma - p02Luma;
  const lowerBandMeanLuma = average(lowerBandLumaValues);
  const lowerBandDarkFraction = lowerBandLumaValues.length > 0
    ? lowerBandDarkCount / lowerBandLumaValues.length
    : 0;
  const lowerBandShadowFraction = lowerBandLumaValues.length > 0
    ? lowerBandShadowCount / lowerBandLumaValues.length
    : 0;

  const vehicleForegroundScore = Math.max(
    Math.min(
      scoreAbove(lowerBandDarkFraction, 0.30, 0.26),
      scoreBelow(lowerBandMeanLuma, 0.32, 0.16),
    ),
    Math.min(
      scoreAbove(lowerBandShadowFraction, 0.46, 0.28),
      scoreBelow(lowerBandMeanLuma, p50Luma - 0.12, 0.16),
    ),
    Math.min(
      scoreBelow(percentile(sortedLowerBand, 0.50), 0.26, 0.14),
      scoreAbove(lowerBandShadowFraction, 0.58, 0.22),
    ),
  );
  const brightFraction = brightCount / pixelCount;
  const clippedBrightFraction = clippedBrightCount / pixelCount;
  const whiteReferenceP50Luma = percentile(sortedWhiteReference, 0.50);
  const whiteReferenceP90Luma = percentile(sortedWhiteReference, 0.90);
  const whiteReferenceP98Luma = percentile(sortedWhiteReference, 0.98);
  const whiteReferenceCandidateFraction = whiteReferenceLumaValues.length / pixelCount;
  const grayCompressionScore = Math.max(
    Math.min(
      scoreAbove(whiteReferenceCandidateFraction, 0.18, 0.20),
      scoreBelow(whiteReferenceP90Luma, 0.78, 0.16),
      scoreBelow(whiteReferenceP98Luma, 0.86, 0.16),
      scoreBelow(brightFraction, 0.08, 0.08),
    ),
    Math.min(
      scoreBelow(p98Luma, 0.82, 0.18),
      scoreBelow(p90Luma, 0.76, 0.16),
      scoreBelow(brightFraction, 0.05, 0.06),
    ),
  );
  const daylightScore = Math.min(
    scoreAbove(p50Luma, 0.32, 0.18),
    scoreAbove(average(lumaValues), 0.34, 0.18),
    scoreBelow(clippedBrightFraction, 0.03, 0.03),
  );
  const hazeScore = Math.min(
    vehicleForegroundScore,
    grayCompressionScore,
    daylightScore,
    scoreBelow(lumaSpread, 0.78, 0.24),
  );
  const windshieldHaze = hazeScore >= 0.58;

  return {
    windshieldHaze,
    confidence: windshieldHaze ? clamp(0.56 + (hazeScore * 0.38), 0.56, 0.96) : clamp(hazeScore, 0, 0.55),
    ...(windshieldHaze ? { windshieldHazeReason: 'compressed-gray-driving-through-windshield' } : {}),
    meanLuma: average(lumaValues),
    p02Luma,
    p10Luma,
    p50Luma,
    p90Luma,
    p98Luma,
    brightFraction,
    clippedBrightFraction,
    lumaSpread,
    meanSaturation: average(saturationValues),
    whiteReferenceCandidateFraction,
    whiteReferenceP50Luma,
    whiteReferenceP90Luma,
    whiteReferenceP98Luma,
    lowerBandMeanLuma,
    lowerBandDarkFraction,
    lowerBandShadowFraction,
    vehicleForegroundScore,
    grayCompressionScore,
    daylightScore,
    hazeScore,
  };
}

function classifyWindshieldHazeFrames(
  frames: IColorWindshieldHazeFrameMetrics[],
): IColorWindshieldHazeClassification {
  if (frames.length === 0) {
    return buildUnknownClassification(frames);
  }
  const positiveFrames = frames.filter(frame => frame.windshieldHaze);
  const positiveFrameRatio = positiveFrames.length / frames.length;
  const positiveMeanConfidence = positiveFrames.length > 0
    ? average(positiveFrames.map(frame => frame.confidence))
    : 0;
  const peakConfidence = Math.max(...frames.map(frame => frame.confidence));
  const windshieldHaze = (
    positiveFrameRatio >= 0.5
    || (positiveFrames.length > 0 && peakConfidence >= 0.78)
  );
  const confidence = windshieldHaze
    ? clamp((positiveMeanConfidence * 0.78) + (positiveFrameRatio * 0.22), 0.56, 0.96)
    : clamp(peakConfidence, 0, 0.55);
  return {
    windshieldHaze,
    windshieldHazeConfidence: confidence,
    windshieldHazeMetrics: {
      frameCount: frames.length,
      classifiedFrameCount: frames.length,
      positiveFrameCount: positiveFrames.length,
      positiveFrameRatio,
      meanConfidence: average(frames.map(frame => frame.confidence)),
      frames,
    },
  };
}

async function extractWindshieldHazeFrames(
  filePath: string,
  tools?: Pick<IMediaToolConfig, 'ffmpegPath'>,
  options: {
    durationMs?: number | null;
    lutPath?: string;
  } = {},
): Promise<IColorWindshieldHazeFrameMetrics[]> {
  const ffmpeg = tools?.ffmpegPath?.trim() || 'ffmpeg';
  const positions = resolveSampleSeconds(options.durationMs);
  const frames: IColorWindshieldHazeFrameMetrics[] = [];
  for (const seconds of positions) {
    const buffer = await extractRgbFrame(filePath, ffmpeg, seconds, options.lutPath).catch(() => null);
    if (!buffer) continue;
    frames.push(classifyRgbFrameWindshieldHaze({
      buffer,
      width: CWINDOW_HAZE_PROXY_WIDTH,
      height: CWINDOW_HAZE_PROXY_HEIGHT,
    }));
  }
  if (frames.length > 0) return frames;
  throw new Error(`ffmpeg returned no windshield-haze sample frames for ${filePath}`);
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
    `scale=${CWINDOW_HAZE_PROXY_WIDTH}:${CWINDOW_HAZE_PROXY_HEIGHT}:flags=area`,
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
    maxBuffer: 8 * 1024 * 1024,
  } satisfies ExecFileOptionsWithBufferEncoding);
  const buffer = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
  if (buffer.length < 3) {
    throw new Error(`ffmpeg returned no windshield-haze sample pixels for ${filePath}`);
  }
  return buffer;
}

function resolveSampleSeconds(durationMs?: number | null): Array<number | undefined> {
  if (!durationMs || durationMs <= 0) return [undefined];
  const durationSeconds = durationMs / 1000;
  return CWINDOW_HAZE_SAMPLE_POSITIONS.map(position => Math.min(
    Math.max(0, durationSeconds * position),
    Math.max(0, durationSeconds - 0.25),
  ));
}

function buildUnknownClassification(frames: IColorWindshieldHazeFrameMetrics[]): IColorWindshieldHazeClassification {
  return {
    windshieldHaze: false,
    windshieldHazeConfidence: 0,
    windshieldHazeMetrics: {
      frameCount: frames.length,
      classifiedFrameCount: 0,
      positiveFrameCount: 0,
      positiveFrameRatio: 0,
      meanConfidence: 0,
      frames,
    },
  };
}

function buildEmptyFrameMetrics(): IColorWindshieldHazeFrameMetrics {
  return {
    windshieldHaze: false,
    confidence: 0,
    meanLuma: 0,
    p02Luma: 0,
    p10Luma: 0,
    p50Luma: 0,
    p90Luma: 0,
    p98Luma: 0,
    brightFraction: 0,
    clippedBrightFraction: 0,
    lumaSpread: 0,
    meanSaturation: 0,
    whiteReferenceCandidateFraction: 0,
    whiteReferenceP50Luma: 0,
    whiteReferenceP90Luma: 0,
    whiteReferenceP98Luma: 0,
    lowerBandMeanLuma: 0,
    lowerBandDarkFraction: 0,
    lowerBandShadowFraction: 0,
    vehicleForegroundScore: 0,
    grayCompressionScore: 0,
    daylightScore: 0,
    hazeScore: 0,
  };
}

function quoteFfmpegFilterValue(value: string): string {
  return value.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(sortedValues: number[], ratio: number): number {
  if (sortedValues.length === 0) return 0;
  const clamped = Math.min(1, Math.max(0, ratio));
  const index = Math.min(sortedValues.length - 1, Math.max(0, Math.round((sortedValues.length - 1) * clamped)));
  return sortedValues[index] ?? 0;
}

function scoreAbove(value: number, threshold: number, range: number): number {
  return clamp((value - threshold) / range, 0, 1);
}

function scoreBelow(value: number, threshold: number, range: number): number {
  return clamp((threshold - value) / range, 0, 1);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
