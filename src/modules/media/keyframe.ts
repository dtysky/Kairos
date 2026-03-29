import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { IMediaToolConfig } from './probe.js';

const exec = promisify(execFile);

export interface IKeyframeResult {
  timeMs: number;
  path: string;
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
): Promise<IKeyframeResult[]> {
  await mkdir(outputDir, { recursive: true });
  const ffmpeg = tools?.ffmpegPath?.trim() || 'ffmpeg';

  const results: IKeyframeResult[] = [];
  for (const ts of timestampsMs) {
    const sec = ts / 1000;
    const outPath = join(outputDir, `kf_${ts}.jpg`);
    try {
      await exec(ffmpeg, [
        '-ss', sec.toFixed(3),
        '-i', filePath,
        '-frames:v', '1',
        '-q:v', '2',
        '-y',
        outPath,
      ]);
      results.push({ timeMs: ts, path: outPath });
    } catch {
      // skip frames that fail to extract
    }
  }
  return results;
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
