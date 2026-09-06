import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, rename, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { loadAssets, loadIngestRoots, loadRuntimeConfig } from '../../store/index.js';
import { resolveAssetLocalPath } from './root-resolver.js';
import { toExecutableInputPath } from './tool-path.js';

const execFileAsync = promisify(execFile);
const CMAX_REVIEW_AUDIO_DURATION_MS = 10 * 60 * 1000;

export interface ISpeechReviewAudioClip {
  path: string;
  contentType: 'audio/mp4';
  startMs: number;
  endMs: number;
}

export async function prepareProjectSpeechReviewAudio(input: {
  workspaceRoot: string;
  projectRoot: string;
  assetId: string;
  startMs: number;
  endMs: number;
}): Promise<ISpeechReviewAudioClip> {
  const [assets, ingestRoots, runtimeConfig] = await Promise.all([
    loadAssets(input.projectRoot),
    loadIngestRoots(input.projectRoot),
    loadRuntimeConfig(input.workspaceRoot),
  ]);
  const asset = assets.find(candidate => candidate.id === input.assetId);
  if (!asset) throw new Error(`speech review audio asset not found: ${input.assetId}`);
  if (asset.kind === 'photo') throw new Error(`speech review audio asset is not playable: ${input.assetId}`);
  const range = normalizeSpeechReviewAudioRange(input.startMs, input.endMs, asset.durationMs);
  const sourcePath = resolveAssetLocalPath(asset, ingestRoots.roots);
  if (!sourcePath) throw new Error(`speech review audio source is unavailable: ${input.assetId}`);
  const sourceStat = await stat(sourcePath);
  if (!sourceStat.isFile()) throw new Error(`speech review audio source is not a file: ${input.assetId}`);

  const cacheRoot = join(input.projectRoot, '.tmp', 'chronology', 'speech-review-audio');
  await mkdir(cacheRoot, { recursive: true });
  const cacheKey = createHash('sha256').update(JSON.stringify({
    assetId: asset.id,
    sourcePath,
    sourceSize: sourceStat.size,
    sourceMtimeMs: sourceStat.mtimeMs,
    startMs: range.startMs,
    endMs: range.endMs,
  })).digest('hex').slice(0, 24);
  const outputPath = join(cacheRoot, `${asset.id}-${range.startMs}-${range.endMs}-${cacheKey}.m4a`);
  const existing = await stat(outputPath).catch(() => null);
  if (!existing?.isFile() || existing.size === 0) {
    const tempPath = join(cacheRoot, `.tmp-${randomUUID()}.m4a`);
    const ffmpegPath = runtimeConfig.ffmpegPath?.trim() || 'ffmpeg';
    try {
      await execFileAsync(ffmpegPath, [
        '-nostdin',
        '-hide_banner',
        '-loglevel', 'error',
        '-ss', formatSeconds(range.startMs),
        '-i', toExecutableInputPath(sourcePath, ffmpegPath),
        '-t', formatSeconds(range.endMs - range.startMs),
        '-map', '0:a:0',
        '-vn',
        '-ac', '1',
        '-ar', '24000',
        '-c:a', 'aac',
        '-b:a', '96k',
        '-movflags', '+faststart',
        '-y',
        tempPath,
      ], { windowsHide: true, timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
      const generated = await stat(tempPath);
      if (!generated.isFile() || generated.size === 0) throw new Error('ffmpeg generated an empty review audio clip');
      await rename(tempPath, outputPath).catch(async error => {
        const raced = await stat(outputPath).catch(() => null);
        if (!raced?.isFile() || raced.size === 0) throw error;
      });
    } finally {
      await unlink(tempPath).catch(() => undefined);
    }
  }
  return { path: outputPath, contentType: 'audio/mp4', ...range };
}

export function normalizeSpeechReviewAudioRange(
  rawStartMs: number,
  rawEndMs: number,
  assetDurationMs?: number,
): { startMs: number; endMs: number } {
  if (!Number.isFinite(rawStartMs) || !Number.isFinite(rawEndMs)) {
    throw new Error('speech review audio range must be finite');
  }
  const startMs = Math.max(0, Math.floor(rawStartMs));
  const durationLimit = Number.isFinite(assetDurationMs) && Number(assetDurationMs) > 0
    ? Math.floor(Number(assetDurationMs))
    : Number.POSITIVE_INFINITY;
  const endMs = Math.min(Math.ceil(rawEndMs), durationLimit);
  if (endMs <= startMs) throw new Error('speech review audio range must have positive duration');
  if (endMs - startMs > CMAX_REVIEW_AUDIO_DURATION_MS) {
    throw new Error('speech review audio range exceeds 10 minutes');
  }
  return { startMs, endMs };
}

function formatSeconds(valueMs: number): string {
  return (valueMs / 1000).toFixed(3);
}
