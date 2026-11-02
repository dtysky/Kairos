import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { readJsonOrNull, writeJson } from '../../store/writer.js';
import { probe, type IMediaToolConfig, type IProbeResult } from './probe.js';

const nullableNumber = z.number().finite().nullable();
const nullableString = z.string().nullable();
const ProbeResultSchema: z.ZodType<IProbeResult> = z.object({
  durationMs: nullableNumber,
  width: nullableNumber,
  height: nullableNumber,
  displayWidth: nullableNumber,
  displayHeight: nullableNumber,
  rotationDegrees: nullableNumber,
  fps: nullableNumber,
  codec: nullableString,
  codecProfile: nullableString.optional(),
  pixelFormat: nullableString.optional(),
  bitDepth: nullableNumber.optional(),
  hasAudioStream: z.boolean(),
  audioStreamCount: z.number().int().nonnegative(),
  audioCodec: nullableString,
  audioSampleRate: nullableNumber,
  audioChannels: nullableNumber,
  audioBitRate: nullableNumber,
  creationTime: nullableString,
  rawTags: z.record(z.string()),
});
const CacheSchema = z.object({
  version: z.literal(1),
  fingerprint: z.string(),
  result: ProbeResultSchema,
});

export interface IIngestMetadataStats {
  /** Main media and bound protection audio; independent of asset merge counts. */
  probedFileCount: number;
  reusedFileCount: number;
  failedFileCount: number;
}

/** Cache raw metadata only: time corrections and sidecar bindings are derived every run. */
export function createIngestProbeCache(
  projectRoot: string,
  tools: IMediaToolConfig,
  onWarning: (message: string) => void,
): { probe: typeof probe; stats: IIngestMetadataStats } {
  const stats: IIngestMetadataStats = { probedFileCount: 0, reusedFileCount: 0, failedFileCount: 0 };
  const toolIdentity = JSON.stringify([
    tools.ffprobePath?.trim() || 'ffprobe',
    tools.exiftoolPath?.trim() || 'exiftool',
    process.env.PATH ?? '',
  ]);
  return {
    stats,
    probe: async filePath => {
      const absolutePath = resolve(filePath);
      const normalizedPath = process.platform === 'win32' ? absolutePath.toLowerCase() : absolutePath;
      const key = createHash('sha256').update(`${hostname()}\0${process.platform}\0${normalizedPath}`).digest('hex');
      const cachePath = join(projectRoot, '.tmp', 'ingest', 'metadata', `${key}.json`);
      const before = await fileFingerprint(absolutePath, toolIdentity);
      if (before) {
        const cached = await readJsonOrNull(cachePath, CacheSchema);
        if (cached?.fingerprint === before) {
          stats.reusedFileCount++;
          return cached.result;
        }
      }

      let result: IProbeResult;
      try {
        result = await probe(absolutePath, tools);
        stats.probedFileCount++;
      } catch (error) {
        stats.failedFileCount++;
        throw error;
      }
      // A file still being copied must not seed a reusable metadata entry.
      if (before && before === await fileFingerprint(absolutePath, toolIdentity)) {
        try {
          await writeJson(cachePath, { version: 1, fingerprint: before, result });
        } catch (error) {
          onWarning(`元数据缓存写入失败，下次将重新读取 ${filePath}：${error instanceof Error ? error.message : String(error)}`);
        }
      }
      return result;
    },
  };
}

async function fileFingerprint(filePath: string, toolIdentity: string): Promise<string | null> {
  try {
    const info = await stat(filePath);
    return JSON.stringify([info.size, info.mtimeMs, info.ctimeMs, toolIdentity]);
  } catch {
    return null;
  }
}
