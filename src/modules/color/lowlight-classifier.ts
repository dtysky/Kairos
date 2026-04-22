import { execFile } from 'node:child_process';
import type { ExecFileOptionsWithBufferEncoding } from 'node:child_process';
import { promisify } from 'node:util';
import { toExecutableInputPath } from '../media/tool-path.js';
import type { IMediaToolConfig } from '../media/probe.js';

const execFileBuffer = promisify(execFile);
const CLOWLIGHT_PROXY_WIDTH = 160;

export interface IColorLowlightClassification {
  lowlight: boolean;
  metrics: {
    meanLuma: number;
    p10Luma: number;
    p50Luma: number;
    p90Luma: number;
    darkFraction: number;
    brightFraction: number;
    meanSaturation: number;
  };
}

export async function classifyFirstFrameLowlight(
  filePath: string,
  tools?: Pick<IMediaToolConfig, 'ffmpegPath'>,
): Promise<IColorLowlightClassification> {
  const ffmpeg = tools?.ffmpegPath?.trim() || 'ffmpeg';
  const inputPath = toExecutableInputPath(filePath, ffmpeg);
  const { stdout } = await execFileBuffer(ffmpeg, [
    '-v', 'error',
    '-i', inputPath,
    '-vf', `select=eq(n\\,0),scale=${CLOWLIGHT_PROXY_WIDTH}:-1:flags=area,format=rgb24`,
    '-frames:v', '1',
    '-f', 'rawvideo',
    'pipe:1',
  ], {
    encoding: 'buffer',
    maxBuffer: 8 * 1024 * 1024,
  } satisfies ExecFileOptionsWithBufferEncoding);

  const buffer = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
  if (buffer.length < 3) {
    throw new Error(`ffmpeg returned no first-frame pixels for ${filePath}`);
  }

  const lumaValues: number[] = [];
  let darkCount = 0;
  let brightCount = 0;
  let saturationTotal = 0;
  for (let index = 0; index <= buffer.length - 3; index += 3) {
    const red = buffer[index] / 255;
    const green = buffer[index + 1] / 255;
    const blue = buffer[index + 2] / 255;
    const luma = (0.2126 * red) + (0.7152 * green) + (0.0722 * blue);
    const maximum = Math.max(red, green, blue);
    const minimum = Math.min(red, green, blue);
    const saturation = maximum <= 0 ? 0 : (maximum - minimum) / maximum;
    if (luma < 0.18) darkCount += 1;
    if (luma > 0.78) brightCount += 1;
    saturationTotal += saturation;
    lumaValues.push(luma);
  }
  if (lumaValues.length === 0) {
    throw new Error(`ffmpeg returned an empty first-frame sample for ${filePath}`);
  }

  const sortedLuma = [...lumaValues].sort((left, right) => left - right);
  const metrics = {
    meanLuma: average(lumaValues),
    p10Luma: percentile(sortedLuma, 0.10),
    p50Luma: percentile(sortedLuma, 0.50),
    p90Luma: percentile(sortedLuma, 0.90),
    darkFraction: darkCount / lumaValues.length,
    brightFraction: brightCount / lumaValues.length,
    meanSaturation: saturationTotal / lumaValues.length,
  };

  const lowlight = (
    (metrics.meanLuma < 0.30 && metrics.darkFraction > 0.42 && metrics.brightFraction < 0.16)
    || (metrics.meanLuma < 0.26 && metrics.p50Luma < 0.24 && metrics.meanSaturation < 0.34)
    || (metrics.p90Luma < 0.62 && metrics.darkFraction > 0.58 && metrics.meanSaturation < 0.28)
  );

  return {
    lowlight,
    metrics,
  };
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(sortedValues: number[], ratio: number): number {
  if (sortedValues.length === 0) return 0;
  const clamped = Math.min(1, Math.max(0, ratio));
  const index = Math.min(sortedValues.length - 1, Math.max(0, Math.round((sortedValues.length - 1) * clamped)));
  return sortedValues[index] ?? 0;
}
