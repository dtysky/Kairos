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
