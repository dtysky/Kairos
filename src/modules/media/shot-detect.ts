import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const FFMPEG = process.env['FFMPEG_PATH'] ?? 'ffmpeg';

export interface IShotBoundary {
  timeMs: number;
  score: number;
}

/**
 * FFmpeg scene detection — returns timestamps where scene changes occur.
 * threshold: 0.0–1.0, lower = more sensitive (default 0.3)
 */
export async function detectShots(
  filePath: string,
  threshold = 0.3,
): Promise<IShotBoundary[]> {
  const { stderr } = await exec(FFMPEG, [
    '-i', filePath,
    '-vf', `select='gt(scene,${threshold})',showinfo`,
    '-vsync', 'vfr',
    '-f', 'null',
    '-',
  ], { maxBuffer: 50 * 1024 * 1024 });

  return parseShowinfo(stderr);
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
