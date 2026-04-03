import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { EClipType } from '../../protocol/schema.js';
import type { IMediaToolConfig } from './probe.js';
import { toExecutableInputPath } from './tool-path.js';

const exec = promisify(execFile);
const DEFAULT_ANALYSIS_PROXY_WIDTH = 1024;
const DEFAULT_ANALYSIS_PROXY_PIXEL_FORMAT = 'yuv420p';
const DEFAULT_NON_DRIVE_SCENE_DETECT_FPS = 2;
const DRIVE_SCENE_DETECT_TARGET_FRAMES = 60;
const DRIVE_SCENE_DETECT_MIN_FPS = 0.5;
const DRIVE_SCENE_DETECT_MAX_FPS = 2;
const HW_SURFACE_OUTPUT_FORMATS: Record<string, string> = {
  cuda: 'cuda',
  qsv: 'qsv',
  vaapi: 'vaapi',
  videotoolbox: 'videotoolbox',
};
const HW_DOWNLOAD_FILTERS: Record<string, string> = {
  qsv: 'hwdownload,format=p010le',
};

export interface IShotBoundary {
  timeMs: number;
  score: number;
}

export interface ISceneDetectContext {
  clipType?: EClipType;
  durationMs?: number;
}

export function resolveEffectiveSceneDetectFps(input: {
  tools?: Pick<IMediaToolConfig, 'sceneDetectFps'>;
  context?: ISceneDetectContext;
}): number {
  const configuredFps = normalizePositiveFps(input.tools?.sceneDetectFps);
  if (configuredFps != null) return configuredFps;

  if (input.context?.clipType !== 'drive') {
    return DEFAULT_NON_DRIVE_SCENE_DETECT_FPS;
  }

  const durationMs = input.context?.durationMs ?? 0;
  if (durationMs <= 0) {
    return DEFAULT_NON_DRIVE_SCENE_DETECT_FPS;
  }

  // Longer drive clips intentionally lower fps so FFmpeg compares frames farther apart.
  const driveFps = DRIVE_SCENE_DETECT_TARGET_FRAMES / Math.max(durationMs / 1000, 1);
  return roundFps(Math.max(DRIVE_SCENE_DETECT_MIN_FPS, Math.min(DRIVE_SCENE_DETECT_MAX_FPS, driveFps)));
}

/**
 * FFmpeg scene detection — returns timestamps where scene changes occur.
 * threshold: 0.0–1.0, lower = more sensitive (default 0.3)
 */
export async function detectShots(
  filePath: string,
  threshold = 0.3,
  tools?: IMediaToolConfig,
  context: ISceneDetectContext = {},
): Promise<IShotBoundary[]> {
  const ffmpeg = tools?.ffmpegPath?.trim() || 'ffmpeg';
  const inputPath = toExecutableInputPath(filePath, ffmpeg);
  const hwaccel = tools?.ffmpegHwaccel?.trim();
  const scaleWidth = tools?.analysisProxyWidth ?? tools?.sceneDetectScaleWidth ?? DEFAULT_ANALYSIS_PROXY_WIDTH;
  const pixelFormat = tools?.analysisProxyPixelFormat?.trim() || DEFAULT_ANALYSIS_PROXY_PIXEL_FORMAT;
  const sceneDetectFps = resolveEffectiveSceneDetectFps({ tools, context });
  const args: string[] = [];
  const hwDownloadFilter = hwaccel ? HW_DOWNLOAD_FILTERS[hwaccel] : undefined;

  if (hwaccel && hwaccel !== 'none') {
    args.push('-hwaccel', hwaccel);
    const hwOutput = HW_SURFACE_OUTPUT_FORMATS[hwaccel];
    if (hwOutput && hwDownloadFilter) {
      args.push('-hwaccel_output_format', hwOutput);
    }
  }

  args.push(
    '-i', inputPath,
    '-an',
    '-sn',
    '-dn',
    '-vf', buildSceneDetectFilter(threshold, scaleWidth, pixelFormat, sceneDetectFps, hwaccel),
    '-fps_mode', 'vfr',
    '-f', 'null',
    '-',
  );

  const { stderr } = await exec(ffmpeg, args, { maxBuffer: 50 * 1024 * 1024 });

  return parseShowinfo(stderr);
}

function buildSceneDetectFilter(
  threshold: number,
  scaleWidth: number,
  pixelFormat: string,
  sceneDetectFps: number,
  hwaccel?: string,
): string {
  const filters: string[] = [];
  const hwDownloadFilter = hwaccel ? HW_DOWNLOAD_FILTERS[hwaccel] : undefined;
  if (hwDownloadFilter) {
    filters.push(hwDownloadFilter);
  }
  if (scaleWidth > 0) {
    filters.push(`scale=w='min(iw,${scaleWidth})':h=-2:flags=fast_bilinear`);
  }
  filters.push(`format=pix_fmts=${pixelFormat}`);
  if (sceneDetectFps > 0) {
    filters.push(`fps=${sceneDetectFps}`);
  }
  filters.push(`select='gt(scene,${threshold})'`);
  filters.push('showinfo');
  return filters.join(',');
}

export interface IRhythmStats {
  shotCount: number;
  cutsPerMinute: number;
  shotDurationMs: {
    min: number;
    max: number;
    median: number;
    mean: number;
  };
  introRhythm: number;
  bodyRhythm: number;
  outroRhythm: number;
}

/**
 * Compute editing rhythm statistics from shot boundaries.
 * Splits the video into thirds (intro/body/outro) and measures cut density in each.
 */
export function computeRhythmStats(
  shots: IShotBoundary[],
  totalDurationMs: number,
): IRhythmStats {
  if (totalDurationMs <= 0 || shots.length === 0) {
    return {
      shotCount: shots.length,
      cutsPerMinute: 0,
      shotDurationMs: { min: 0, max: 0, median: 0, mean: 0 },
      introRhythm: 0,
      bodyRhythm: 0,
      outroRhythm: 0,
    };
  }

  const sorted = [...shots].sort((a, b) => a.timeMs - b.timeMs);
  const boundaries = [0, ...sorted.map(s => s.timeMs), totalDurationMs];
  const durations: number[] = [];
  for (let i = 1; i < boundaries.length; i++) {
    durations.push(boundaries[i] - boundaries[i - 1]);
  }

  durations.sort((a, b) => a - b);
  const median = durations[Math.floor(durations.length / 2)];
  const mean = durations.reduce((a, b) => a + b, 0) / durations.length;

  const cutRateInRegion = (startMs: number, endMs: number): number => {
    const durMin = (endMs - startMs) / 60000;
    if (durMin <= 0) return 0;
    const cuts = sorted.filter(s => s.timeMs >= startMs && s.timeMs < endMs).length;
    return cuts / durMin;
  };

  const third = totalDurationMs / 3;

  return {
    shotCount: sorted.length,
    cutsPerMinute: sorted.length / (totalDurationMs / 60000),
    shotDurationMs: {
      min: durations[0],
      max: durations[durations.length - 1],
      median,
      mean: Math.round(mean),
    },
    introRhythm: cutRateInRegion(0, third),
    bodyRhythm: cutRateInRegion(third, third * 2),
    outroRhythm: cutRateInRegion(third * 2, totalDurationMs),
  };
}

const CPTS_RE = /pts_time:(\d+\.?\d*)/;
const CSCORE_RE = /scene_score=\s*(\d+\.?\d*)/;

function parseShowinfo(output: string): IShotBoundary[] {
  const boundaries: IShotBoundary[] = [];
  for (const line of output.split('\n')) {
    if (!line.includes('showinfo')) continue;
    const ptsMatch = line.match(CPTS_RE);
    const scoreMatch = line.match(CSCORE_RE);
    if (ptsMatch) {
      boundaries.push({
        timeMs: Math.round(parseFloat(ptsMatch[1]) * 1000),
        score: scoreMatch ? parseFloat(scoreMatch[1]) : 1,
      });
    }
  }
  return boundaries;
}

function normalizePositiveFps(fps?: number): number | undefined {
  if (typeof fps !== 'number' || !Number.isFinite(fps) || fps <= 0) {
    return undefined;
  }
  return roundFps(fps);
}

function roundFps(fps: number): number {
  return Math.round(fps * 100) / 100;
}
