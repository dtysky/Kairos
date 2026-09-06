import { stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { readJsonOrNull, writeJson } from './writer.js';

const IShotBoundary = z.object({
  timeMs: z.number(),
  score: z.number(),
});

const ICoarseFrame = z.object({
  timeMs: z.number(),
  path: z.string(),
});

const IPreparedSourceContext = z.object({
  ingestRootId: z.string().optional(),
  rootLabel: z.string().optional(),
  rootDescription: z.string().optional(),
  rootNotes: z.array(z.string()),
});

const IPreparedAssetCheckpointBase = {
  assetId: z.string(),
  shotBoundaries: z.array(IShotBoundary),
  shotBoundariesResolved: z.boolean(),
  sampleFrames: z.array(ICoarseFrame),
  coarseSampleTimestamps: z.array(z.number()),
  hasAudioTrack: z.boolean(),
  sourceContext: IPreparedSourceContext,
  updatedAt: z.string(),
};

const IPreparedAssetSourceFingerprint = z.object({
  sizeBytes: z.number().int().nonnegative(),
  mtimeMs: z.number().int().nonnegative(),
});

const IPreparedAssetCheckpointV2 = z.object({
  schemaVersion: z.literal(2),
  ...IPreparedAssetCheckpointBase,
});

const IPreparedAssetCheckpointV3 = z.object({
  schemaVersion: z.literal(3),
  ...IPreparedAssetCheckpointBase,
  sourceFingerprint: IPreparedAssetSourceFingerprint,
});

const IPreparedAssetCheckpoint = z.discriminatedUnion('schemaVersion', [
  IPreparedAssetCheckpointV2,
  IPreparedAssetCheckpointV3,
]);

export type IPreparedAssetCheckpoint = z.infer<typeof IPreparedAssetCheckpoint>;
export type IPreparedAssetCheckpointV3 = z.infer<typeof IPreparedAssetCheckpointV3>;

export interface ILoadPreparedAssetCheckpointOptions {
  sourcePath?: string;
  requireSampleFrames?: boolean;
}

export function getPreparedAssetCheckpointRoot(projectRoot: string): string {
  return join(projectRoot, 'analysis', 'prepared-assets');
}

export function getPreparedAssetCheckpointPath(projectRoot: string, assetId: string): string {
  return join(getPreparedAssetCheckpointRoot(projectRoot), `${assetId}.json`);
}

export async function loadPreparedAssetCheckpoint(
  projectRoot: string,
  assetId: string,
  options?: ILoadPreparedAssetCheckpointOptions,
): Promise<IPreparedAssetCheckpoint | null> {
  const checkpoint = await readJsonOrNull(
    getPreparedAssetCheckpointPath(projectRoot, assetId),
    IPreparedAssetCheckpoint,
  );
  if (!checkpoint) return null;
  if (options?.requireSampleFrames && checkpoint.sampleFrames.length === 0) return null;
  if (!options?.sourcePath) return checkpoint;

  let sourceStat;
  try {
    sourceStat = await stat(options.sourcePath);
  } catch {
    return null;
  }
  if (!sourceStat.isFile()) return null;

  const sourceFingerprint = {
    sizeBytes: sourceStat.size,
    mtimeMs: Math.round(sourceStat.mtimeMs),
  };
  if (checkpoint.schemaVersion === 3) {
    return checkpoint.sourceFingerprint.sizeBytes === sourceFingerprint.sizeBytes
      && checkpoint.sourceFingerprint.mtimeMs === sourceFingerprint.mtimeMs
      ? checkpoint
      : null;
  }

  const checkpointUpdatedAtMs = Date.parse(checkpoint.updatedAt);
  return Number.isFinite(checkpointUpdatedAtMs)
    && sourceFingerprint.mtimeMs <= checkpointUpdatedAtMs
    ? checkpoint
    : null;
}

export async function writePreparedAssetCheckpoint(
  projectRoot: string,
  checkpoint: Omit<IPreparedAssetCheckpointV3, 'updatedAt'> & { updatedAt?: string },
): Promise<void> {
  await writeJson(getPreparedAssetCheckpointPath(projectRoot, checkpoint.assetId), {
    ...checkpoint,
    updatedAt: checkpoint.updatedAt ?? new Date().toISOString(),
  });
}

export async function removePreparedAssetCheckpoint(
  projectRoot: string,
  assetId: string,
): Promise<void> {
  await unlink(getPreparedAssetCheckpointPath(projectRoot, assetId)).catch(() => undefined);
}
