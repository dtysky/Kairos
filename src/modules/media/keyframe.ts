import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { IMediaToolConfig } from './probe.js';
import type { IShotBoundary } from './shot-detect.js';
import { toExecutableInputPath } from './tool-path.js';

const exec = promisify(execFile);
const CDEFAULT_KEYFRAME_EXTRACT_CONCURRENCY = 3;
const CMAX_KEYFRAME_EXTRACT_CONCURRENCY = 6;

export interface IKeyframeResult {
  timeMs: number;
  path: string;
}

export interface IExtractKeyframesOptions {
  concurrencyOverride?: number;
}

export interface IShotWindow {
  id: string;
  startMs: number;
  endMs: number;
  score?: number;
}

export interface IShotKeyframePlan {
  shotId: string;
  startMs: number;
  endMs: number;
  timestampsMs: number[];
}

export interface IShotKeyframeGroup {
  shotId: string;
  startMs: number;
  endMs: number;
  frames: IKeyframeResult[];
}

export async function extractImageProxy(
  filePath: string,
  outputDir: string,
  tools?: IMediaToolConfig,
): Promise<IKeyframeResult | null> {
  await mkdir(outputDir, { recursive: true });
  const ffmpeg = tools?.ffmpegPath?.trim() || 'ffmpeg';
  const inputPath = toExecutableInputPath(filePath, ffmpeg);
  const outPath = join(outputDir, 'image_proxy.jpg');
  const existingProxy = await resolveExistingKeyframe(outPath, 0);
  if (existingProxy) return existingProxy;
  const outputPathForTool = toExecutableInputPath(outPath, ffmpeg);
  const vf = buildAnalysisProxyFilter(tools);

  try {
    await exec(ffmpeg, [
      '-i', inputPath,
      '-vf', vf,
      '-frames:v', '1',
      '-q:v', '2',
      '-y',
      outputPathForTool,
    ]);
    await access(outPath);
    return { timeMs: 0, path: outPath };
  } catch {
    return null;
  }
}

/**
 * Extract keyframes at specific timestamps.
 * Falls back to uniform sampling if no timestamps given.
 */
export async function extractKeyframes(
  filePath: string,
  outputDir: string,
  timestampsMs: number[],
  tools?: IMediaToolConfig,
  options?: IExtractKeyframesOptions,
): Promise<IKeyframeResult[]> {
  await mkdir(outputDir, { recursive: true });
  const ffmpeg = tools?.ffmpegPath?.trim() || 'ffmpeg';
  const inputPath = toExecutableInputPath(filePath, ffmpeg);
  const vf = buildAnalysisProxyFilter(tools);
  const concurrency = resolveKeyframeExtractConcurrency(
    timestampsMs.length,
    tools?.keyframeExtractConcurrency,
    options?.concurrencyOverride,
  );

  const results = await mapWithConcurrencyLimit(
    timestampsMs,
    concurrency,
    async (ts) => extractSingleKeyframeAtTimestamp(ts, {
      ffmpeg,
      inputPath,
      outputDir,
      vf,
    }),
  );
  return results.filter((result): result is IKeyframeResult => result !== null);
}

async function extractSingleKeyframeAtTimestamp(
  timeMs: number,
  input: {
    ffmpeg: string;
    inputPath: string;
    outputDir: string;
    vf: string;
  },
): Promise<IKeyframeResult | null> {
  const sec = timeMs / 1000;
  const outPath = join(input.outputDir, `kf_${timeMs}.jpg`);
  const existingKeyframe = await resolveExistingKeyframe(outPath, timeMs);
  if (existingKeyframe) return existingKeyframe;
  const outputPathForTool = toExecutableInputPath(outPath, input.ffmpeg);

  try {
    await exec(input.ffmpeg, [
      '-ss', sec.toFixed(3),
      '-i', input.inputPath,
      '-vf', input.vf,
      '-frames:v', '1',
      '-q:v', '2',
      '-y',
      outputPathForTool,
    ]);
    await access(outPath);
    return { timeMs, path: outPath };
  } catch {
    return null;
  }
}

async function resolveExistingKeyframe(
  outPath: string,
  timeMs: number,
): Promise<IKeyframeResult | null> {
  try {
    await access(outPath);
    return { timeMs, path: outPath };
  } catch {
    return null;
  }
}

async function mapWithConcurrencyLimit<T, TResult>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<TResult>,
): Promise<TResult[]> {
  const results = new Array<TResult>(items.length);
  let nextIndex = 0;

  const workerCount = Math.min(Math.max(1, concurrency), items.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        results[currentIndex] = await worker(items[currentIndex]!, currentIndex);
      }
    }),
  );

  return results;
}

function resolveKeyframeExtractConcurrency(
  taskCount: number,
  configured?: number,
  override?: number,
): number {
  if (taskCount <= 0) return 1;

  const preferred = Number.isFinite(override)
    ? Math.floor(override!)
    : Number.isFinite(configured)
      ? Math.floor(configured!)
    : CDEFAULT_KEYFRAME_EXTRACT_CONCURRENCY;
  return Math.min(taskCount, Math.max(1, Math.min(CMAX_KEYFRAME_EXTRACT_CONCURRENCY, preferred)));
}

function buildAnalysisProxyFilter(tools?: IMediaToolConfig): string {
  const analysisWidth = tools?.analysisProxyWidth && tools.analysisProxyWidth > 0
    ? Math.round(tools.analysisProxyWidth)
    : 1024;
  const pixelFormat = tools?.analysisProxyPixelFormat?.trim() || 'yuv420p';

  return [
    `scale=w='min(iw,${analysisWidth})':h=-2:flags=fast_bilinear`,
    `format=pix_fmts=${pixelFormat}`,
  ].join(',');
}

/**
 * Generate uniform sample timestamps.
 */
export function uniformTimestamps(durationMs: number, intervalMs: number): number[] {
  const stamps: number[] = [0];
  let t = intervalMs;
  while (t < durationMs) {
    stamps.push(t);
    t += intervalMs;
  }
  return stamps;
}

/**
 * Convert shot boundaries into contiguous shot windows.
 */
export function buildShotWindows(
  shots: IShotBoundary[],
  totalDurationMs: number,
): IShotWindow[] {
  if (totalDurationMs <= 0) return [];

  const sorted = [...shots]
    .map(shot => Math.max(0, Math.min(totalDurationMs, Math.round(shot.timeMs))))
    .filter(timeMs => timeMs > 0 && timeMs < totalDurationMs)
    .sort((a, b) => a - b);

  const uniqueBoundaries = [...new Set(sorted)];
  const windows: IShotWindow[] = [];
  let startMs = 0;

  for (const boundary of uniqueBoundaries) {
    if (boundary <= startMs) continue;
    windows.push({
      id: `shot-${String(windows.length + 1).padStart(3, '0')}`,
      startMs,
      endMs: boundary,
    });
    startMs = boundary;
  }

  if (startMs < totalDurationMs) {
    windows.push({
      id: `shot-${String(windows.length + 1).padStart(3, '0')}`,
      startMs,
      endMs: totalDurationMs,
    });
  }

  return windows;
}

/**
 * Sample representative timestamps for each shot.
 * Default is start / middle / end, matching the style-analysis workflow.
 */
export function planShotKeyframes(
  shots: IShotBoundary[],
  totalDurationMs: number,
  framesPerShot = 3,
): IShotKeyframePlan[] {
  const windows = buildShotWindows(shots, totalDurationMs);
  return windows.map(window => ({
    shotId: window.id,
    startMs: window.startMs,
    endMs: window.endMs,
    timestampsMs: sampleRangeTimestamps(window.startMs, window.endMs, framesPerShot),
  }));
}

export function flattenShotKeyframePlans(plans: IShotKeyframePlan[]): number[] {
  return plans.flatMap(plan => plan.timestampsMs);
}

export function groupKeyframesByShot(
  plans: IShotKeyframePlan[],
  keyframes: IKeyframeResult[],
): IShotKeyframeGroup[] {
  const frameMap = new Map<number, IKeyframeResult[]>();
  for (const frame of keyframes) {
    const existing = frameMap.get(frame.timeMs);
    if (existing) existing.push(frame);
    else frameMap.set(frame.timeMs, [frame]);
  }

  return plans.map(plan => ({
    shotId: plan.shotId,
    startMs: plan.startMs,
    endMs: plan.endMs,
    frames: plan.timestampsMs
      .flatMap(timeMs => frameMap.get(timeMs) ?? [])
      .sort((a, b) => a.timeMs - b.timeMs),
  }));
}

export function sampleRangeTimestamps(
  startMs: number,
  endMs: number,
  framesPerShot: number,
): number[] {
  const count = Math.max(1, Math.round(framesPerShot));
  if (count === 1) {
    return [Math.max(0, Math.round((startMs + endMs) / 2))];
  }

  const lastMs = Math.max(startMs, endMs - 1);
  const span = Math.max(0, lastMs - startMs);
  const samples: number[] = [];

  for (let i = 0; i < count; i++) {
    const ratio = count === 1 ? 0 : i / (count - 1);
    samples.push(Math.round(startMs + span * ratio));
  }

  // Preserve ordering and avoid accidental collapse when the shot is long enough.
  for (let i = 1; i < samples.length; i++) {
    if (samples[i] <= samples[i - 1] && samples[i - 1] < lastMs) {
      samples[i] = samples[i - 1] + 1;
    }
  }
  for (let i = samples.length - 2; i >= 0; i--) {
    if (samples[i] >= samples[i + 1] && samples[i + 1] > startMs) {
      samples[i] = samples[i + 1] - 1;
    }
  }

  return samples.map(timeMs => Math.max(startMs, Math.min(lastMs, timeMs)));
}
