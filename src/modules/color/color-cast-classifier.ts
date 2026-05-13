import { execFile } from 'node:child_process';
import type { ExecFileOptionsWithBufferEncoding } from 'node:child_process';
import { promisify } from 'node:util';
import { toExecutableInputPath } from '../media/tool-path.js';
import type { IMediaToolConfig } from '../media/probe.js';

const execFileBuffer = promisify(execFile);
const CCOLOR_CAST_PROXY_WIDTH = 180;
const CCOLOR_CAST_PROXY_HEIGHT = 102;
const CCOLOR_CAST_SAMPLE_POSITION = 0.50;
const CCOLOR_CAST_MIN_CANDIDATE_RATIO = 0.03;
const CCOLOR_CAST_GROUP_CONFIDENCE = 0.65;

export type TColorCastClass = 'neutral' | 'cool-cyan' | 'green-cyan' | 'green' | 'warm' | 'mixed' | 'unknown';

export interface IColorCastFrameMetrics {
  colorCastClass: TColorCastClass;
  confidence: number;
  medianA: number;
  medianB: number;
  candidatePixelRatio: number;
  exposureOkRatio: number;
  skyMaskRatio: number;
  yellowMaskRatio: number;
  lowSaturationThreshold: number;
}

export interface IColorCastMetrics extends Record<string, unknown> {
  frameCount: number;
  classifiedFrameCount: number;
  candidatePixelRatio: number;
  medianA: number;
  medianB: number;
  frames: IColorCastFrameMetrics[];
}

export interface IColorCastClassification {
  colorCastClass: TColorCastClass;
  colorCastConfidence: number;
  colorCastMetrics: IColorCastMetrics;
}

export async function classifyColorCast(
  filePath: string,
  tools?: Pick<IMediaToolConfig, 'ffmpegPath'>,
  options: {
    durationMs?: number | null;
    lutPath?: string;
  } = {},
): Promise<IColorCastClassification> {
  const frames = await extractColorCastFrames(filePath, tools, {
    durationMs: options.durationMs,
    lutPath: options.lutPath,
  });
  return classifyColorCastFrames(frames);
}

export function classifyRgbFrameColorCast(input: {
  buffer: Buffer | Uint8Array;
  width: number;
  height: number;
}): IColorCastFrameMetrics {
  const pixelCount = Math.min(
    Math.floor(input.buffer.length / 3),
    Math.max(0, Math.floor(input.width) * Math.floor(input.height)),
  );
  if (pixelCount <= 0 || input.width <= 0 || input.height <= 0) {
    return buildUnknownFrameMetrics();
  }

  const preliminary: Array<{
    red: number;
    green: number;
    blue: number;
    saturation: number;
  }> = [];
  const exposurePixels: Array<{
    pixelIndex: number;
    red: number;
    green: number;
    blue: number;
    saturation: number;
    hue: number;
    value: number;
    y: number;
  }> = [];
  const saturations: number[] = [];
  let exposureOkCount = 0;
  let skyMaskCount = 0;
  let yellowMaskCount = 0;

  for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex += 1) {
    const offset = pixelIndex * 3;
    const red = input.buffer[offset] / 255;
    const green = input.buffer[offset + 1] / 255;
    const blue = input.buffer[offset + 2] / 255;
    const y = Math.floor(pixelIndex / input.width);
    const features = buildRgbFeatures(red, green, blue);
    const exposureOk = features.luma > 0.08
      && features.luma < 0.90
      && features.maximum < 0.98
      && features.minimum > 0.02;
    if (!exposureOk) continue;
    exposureOkCount += 1;
    exposurePixels.push({
      pixelIndex,
      red,
      green,
      blue,
      saturation: features.saturation,
      hue: features.hue,
      value: features.value,
      y,
    });
  }

  const skyMask = buildConnectedSkyMask(exposurePixels, input.width, input.height);
  for (const pixel of exposurePixels) {
    if (skyMask.has(pixel.pixelIndex)) {
      skyMaskCount += 1;
      continue;
    }
    const yellowHoodLike = isBottomYellowLike({
      hue: pixel.hue,
      saturation: pixel.saturation,
      value: pixel.value,
      y: pixel.y,
      height: input.height,
    });
    if (yellowHoodLike) {
      yellowMaskCount += 1;
      continue;
    }
    preliminary.push({
      red: pixel.red,
      green: pixel.green,
      blue: pixel.blue,
      saturation: pixel.saturation,
    });
    saturations.push(pixel.saturation);
  }

  if (preliminary.length === 0) {
    return {
      ...buildUnknownFrameMetrics(),
      exposureOkRatio: exposureOkCount / pixelCount,
      skyMaskRatio: skyMaskCount / pixelCount,
      yellowMaskRatio: yellowMaskCount / pixelCount,
    };
  }

  const lowSaturationThreshold = Math.min(0.45, percentile([...saturations].sort((left, right) => left - right), 0.35));
  const aValues: number[] = [];
  const bValues: number[] = [];
  for (const pixel of preliminary) {
    if (pixel.saturation > lowSaturationThreshold + 0.000001) continue;
    const lab = rgbToLab(pixel.red, pixel.green, pixel.blue);
    aValues.push(lab.a);
    bValues.push(lab.b);
  }

  const candidatePixelRatio = aValues.length / pixelCount;
  if (candidatePixelRatio < CCOLOR_CAST_MIN_CANDIDATE_RATIO || aValues.length === 0) {
    return {
      colorCastClass: 'unknown',
      confidence: 0,
      medianA: 0,
      medianB: 0,
      candidatePixelRatio,
      exposureOkRatio: exposureOkCount / pixelCount,
      skyMaskRatio: skyMaskCount / pixelCount,
      yellowMaskRatio: yellowMaskCount / pixelCount,
      lowSaturationThreshold,
    };
  }

  const medianA = median(aValues);
  const medianB = median(bValues);
  const { colorCastClass, confidence } = classifyLabCast(medianA, medianB, candidatePixelRatio);
  return {
    colorCastClass,
    confidence,
    medianA,
    medianB,
    candidatePixelRatio,
    exposureOkRatio: exposureOkCount / pixelCount,
    skyMaskRatio: skyMaskCount / pixelCount,
    yellowMaskRatio: yellowMaskCount / pixelCount,
    lowSaturationThreshold,
  };
}

export function isColorCastGroupClass(value: TColorCastClass | string | undefined): boolean {
  return value === 'cool-cyan' || value === 'green-cyan' || value === 'green' || value === 'warm' || value === 'mixed';
}

export function shouldSplitColorCastGroup(
  colorCastClass: TColorCastClass | string | undefined,
  confidence: number | undefined,
): boolean {
  return isColorCastGroupClass(colorCastClass) && (confidence ?? 0) >= CCOLOR_CAST_GROUP_CONFIDENCE;
}

function classifyColorCastFrames(frames: IColorCastFrameMetrics[]): IColorCastClassification {
  const classified = frames.filter(frame => frame.colorCastClass !== 'unknown');
  if (classified.length === 0) {
    return buildUnknownClassification(frames);
  }
  const nonNeutral = classified.filter(frame => frame.colorCastClass !== 'neutral');
  if (nonNeutral.length === 0) {
    return buildClassification('neutral', average(classified.map(frame => frame.confidence)), classified, frames);
  }

  const counts = new Map<TColorCastClass, { count: number; confidence: number }>();
  for (const frame of nonNeutral) {
    const entry = counts.get(frame.colorCastClass) ?? { count: 0, confidence: 0 };
    entry.count += 1;
    entry.confidence += frame.confidence;
    counts.set(frame.colorCastClass, entry);
  }
  const ranked = [...counts.entries()]
    .sort((left, right) => (right[1].count - left[1].count) || (right[1].confidence - left[1].confidence));
  const topEntry = ranked[0];
  if (!topEntry) {
    return buildUnknownClassification(frames);
  }
  const [topClass, top] = topEntry;
  if (ranked.length > 1 && top.count < nonNeutral.length) {
    return buildClassification('mixed', Math.min(0.95, average(nonNeutral.map(frame => frame.confidence)) * 0.88), classified, frames);
  }
  return buildClassification(topClass, top.confidence / Math.max(1, top.count), classified, frames);
}

async function extractColorCastFrames(
  filePath: string,
  tools?: Pick<IMediaToolConfig, 'ffmpegPath'>,
  options: {
    durationMs?: number | null;
    lutPath?: string;
  } = {},
): Promise<IColorCastFrameMetrics[]> {
  const ffmpeg = tools?.ffmpegPath?.trim() || 'ffmpeg';
  const positions = resolveSampleSeconds(options.durationMs);
  const frames: IColorCastFrameMetrics[] = [];
  for (const seconds of positions) {
    const buffer = await extractRgbFrame(filePath, ffmpeg, seconds, options.lutPath).catch(() => null);
    if (!buffer) continue;
    frames.push(classifyRgbFrameColorCast({
      buffer,
      width: CCOLOR_CAST_PROXY_WIDTH,
      height: CCOLOR_CAST_PROXY_HEIGHT,
    }));
  }
  if (frames.length > 0) return frames;
  throw new Error(`ffmpeg returned no color-cast sample frames for ${filePath}`);
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
    `scale=${CCOLOR_CAST_PROXY_WIDTH}:${CCOLOR_CAST_PROXY_HEIGHT}:force_original_aspect_ratio=decrease`,
    ...(lutPath ? [`lut3d=file=${quoteFfmpegFilterValue(lutPath)}:interp=tetrahedral`] : []),
    `pad=${CCOLOR_CAST_PROXY_WIDTH}:${CCOLOR_CAST_PROXY_HEIGHT}:(ow-iw)/2:(oh-ih)/2:color=black`,
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
  if (buffer.length < CCOLOR_CAST_PROXY_WIDTH * CCOLOR_CAST_PROXY_HEIGHT * 3) {
    throw new Error(`ffmpeg returned an incomplete color-cast frame for ${filePath}`);
  }
  return buffer;
}

function resolveSampleSeconds(durationMs?: number | null): Array<number | undefined> {
  if (!durationMs || durationMs <= 0) return [undefined];
  const durationSeconds = durationMs / 1000;
  return [Math.min(
    Math.max(0, durationSeconds * CCOLOR_CAST_SAMPLE_POSITION),
    Math.max(0, durationSeconds - 0.25),
  )];
}

function quoteFfmpegFilterValue(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function classifyLabCast(
  medianA: number,
  medianB: number,
  candidatePixelRatio: number,
): { colorCastClass: TColorCastClass; confidence: number } {
  const magnitude = Math.hypot(medianA, medianB);
  if (magnitude < 4.5) {
    return {
      colorCastClass: 'neutral',
      confidence: clamp(1 - (magnitude / 6), 0.35, 0.98),
    };
  }
  if (medianB <= -6 && medianA <= 4) {
    return {
      colorCastClass: 'cool-cyan',
      confidence: castConfidence(Math.max(-medianB, -medianA * 0.65), 6, candidatePixelRatio),
    };
  }
  if (medianA <= -5.0 && medianB > -6 && medianB <= -2.0) {
    return {
      colorCastClass: 'green-cyan',
      confidence: greenCyanCastConfidence(medianA, medianB, candidatePixelRatio),
    };
  }
  if (medianA <= -5.5 && medianB > -2.0 && medianB < 8) {
    return {
      colorCastClass: 'green',
      confidence: greenCastConfidence(-medianA, candidatePixelRatio),
    };
  }
  if (medianB <= -4 && medianA <= 1.5 && candidatePixelRatio >= 0.08) {
    return {
      colorCastClass: 'cool-cyan',
      confidence: weakCoolCastConfidence(medianA, medianB, candidatePixelRatio),
    };
  }
  if (medianB >= 6) {
    return {
      colorCastClass: 'warm',
      confidence: castConfidence(medianB, 6, candidatePixelRatio),
    };
  }
  return {
    colorCastClass: 'mixed',
    confidence: castConfidence(magnitude, 8, candidatePixelRatio) * 0.85,
  };
}

function castConfidence(strength: number, threshold: number, candidatePixelRatio: number): number {
  return clamp(0.45 + ((strength - threshold) / 24) + Math.min(0.12, candidatePixelRatio), 0.35, 0.98);
}

function greenCastConfidence(strength: number, candidatePixelRatio: number): number {
  return clamp(0.52 + ((strength - 5.5) / 12) + Math.min(0.12, candidatePixelRatio), 0.35, 0.98);
}

function greenCyanCastConfidence(medianA: number, medianB: number, candidatePixelRatio: number): number {
  return clamp(
    0.51
    + (((-medianA) - 5.0) / 12)
    + (((-medianB) - 2.0) / 16)
    + Math.min(0.08, candidatePixelRatio),
    0.35,
    0.98,
  );
}

function weakCoolCastConfidence(medianA: number, medianB: number, candidatePixelRatio: number): number {
  return clamp(
    0.64
    + (((-medianB) - 4) / 10)
    + Math.min(0.08, candidatePixelRatio * 0.5)
    - (Math.max(0, medianA) / 20),
    0.35,
    0.86,
  );
}

function buildClassification(
  colorCastClass: TColorCastClass,
  confidence: number,
  classifiedFrames: IColorCastFrameMetrics[],
  frames: IColorCastFrameMetrics[],
): IColorCastClassification {
  return {
    colorCastClass,
    colorCastConfidence: clamp(confidence, 0, 0.98),
    colorCastMetrics: {
      frameCount: frames.length,
      classifiedFrameCount: classifiedFrames.length,
      candidatePixelRatio: average(classifiedFrames.map(frame => frame.candidatePixelRatio)),
      medianA: median(classifiedFrames.map(frame => frame.medianA)),
      medianB: median(classifiedFrames.map(frame => frame.medianB)),
      frames,
    },
  };
}

function buildUnknownClassification(frames: IColorCastFrameMetrics[]): IColorCastClassification {
  return {
    colorCastClass: 'unknown',
    colorCastConfidence: 0,
    colorCastMetrics: {
      frameCount: frames.length,
      classifiedFrameCount: 0,
      candidatePixelRatio: average(frames.map(frame => frame.candidatePixelRatio)),
      medianA: 0,
      medianB: 0,
      frames,
    },
  };
}

function buildUnknownFrameMetrics(): IColorCastFrameMetrics {
  return {
    colorCastClass: 'unknown',
    confidence: 0,
    medianA: 0,
    medianB: 0,
    candidatePixelRatio: 0,
    exposureOkRatio: 0,
    skyMaskRatio: 0,
    yellowMaskRatio: 0,
    lowSaturationThreshold: 0,
  };
}

function buildRgbFeatures(red: number, green: number, blue: number): {
  luma: number;
  maximum: number;
  minimum: number;
  saturation: number;
  hue: number;
  value: number;
} {
  const maximum = Math.max(red, green, blue);
  const minimum = Math.min(red, green, blue);
  const delta = maximum - minimum;
  const saturation = maximum <= 0 ? 0 : delta / maximum;
  let hue = 0;
  if (delta > 0) {
    if (maximum === red) hue = 60 * (((green - blue) / delta) % 6);
    else if (maximum === green) hue = 60 * (((blue - red) / delta) + 2);
    else hue = 60 * (((red - green) / delta) + 4);
    if (hue < 0) hue += 360;
  }
  return {
    luma: (0.2126 * red) + (0.7152 * green) + (0.0722 * blue),
    maximum,
    minimum,
    saturation,
    hue,
    value: maximum,
  };
}

function isSkyLike(input: {
  red: number;
  green: number;
  blue: number;
  hue: number;
  saturation: number;
  value: number;
  y: number;
  height: number;
}): boolean {
  const yRatio = input.y / Math.max(1, input.height);
  return yRatio < 0.65
    && input.hue >= 170
    && input.hue <= 250
    && input.saturation > 0.12
    && input.value > 0.35
    && input.blue > input.red + 0.05
    && input.green > input.red - 0.03;
}

function buildConnectedSkyMask(
  pixels: Array<{
    pixelIndex: number;
    red: number;
    green: number;
    blue: number;
    hue: number;
    saturation: number;
    value: number;
    y: number;
  }>,
  width: number,
  height: number,
): Set<number> {
  const skyCandidates = new Set<number>();
  const seeds: number[] = [];
  for (const pixel of pixels) {
    if (!isSkyLike({ ...pixel, height })) continue;
    skyCandidates.add(pixel.pixelIndex);
    if (pixel.y / Math.max(1, height) < 0.12) {
      seeds.push(pixel.pixelIndex);
    }
  }

  const connected = new Set<number>();
  const queue = [...seeds];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current == null || connected.has(current) || !skyCandidates.has(current)) continue;
    connected.add(current);
    const x = current % width;
    const neighbours = [
      current - width,
      current + width,
      x > 0 ? current - 1 : -1,
      x < width - 1 ? current + 1 : -1,
    ];
    for (const neighbour of neighbours) {
      if (skyCandidates.has(neighbour) && !connected.has(neighbour)) {
        queue.push(neighbour);
      }
    }
  }
  return connected;
}

function isBottomYellowLike(input: {
  hue: number;
  saturation: number;
  value: number;
  y: number;
  height: number;
}): boolean {
  const yRatio = input.y / Math.max(1, input.height);
  return yRatio > 0.70
    && input.hue >= 25
    && input.hue <= 75
    && input.saturation > 0.25
    && input.value > 0.35;
}

function rgbToLab(red: number, green: number, blue: number): { a: number; b: number } {
  const linearRed = srgbToLinear(red);
  const linearGreen = srgbToLinear(green);
  const linearBlue = srgbToLinear(blue);
  const x = (linearRed * 0.4124564) + (linearGreen * 0.3575761) + (linearBlue * 0.1804375);
  const y = (linearRed * 0.2126729) + (linearGreen * 0.7151522) + (linearBlue * 0.0721750);
  const z = (linearRed * 0.0193339) + (linearGreen * 0.1191920) + (linearBlue * 0.9503041);
  const fx = labPivot(x / 0.95047);
  const fy = labPivot(y);
  const fz = labPivot(z / 1.08883);
  return {
    a: 500 * (fx - fy),
    b: 200 * (fy - fz),
  };
}

function srgbToLinear(value: number): number {
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function labPivot(value: number): number {
  return value > 0.008856 ? Math.cbrt(value) : (7.787 * value) + (16 / 116);
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  return percentile([...values].sort((left, right) => left - right), 0.50);
}

function percentile(sortedValues: number[], ratio: number): number {
  if (sortedValues.length === 0) return 0;
  const clamped = Math.min(1, Math.max(0, ratio));
  const index = Math.min(sortedValues.length - 1, Math.max(0, Math.round((sortedValues.length - 1) * clamped)));
  return sortedValues[index] ?? 0;
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
