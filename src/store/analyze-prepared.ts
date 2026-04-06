import { unlink } from 'node:fs/promises';
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

const IPreparedAssetCheckpoint = z.object({
  schemaVersion: z.literal(2),
  assetId: z.string(),
  shotBoundaries: z.array(IShotBoundary),
  shotBoundariesResolved: z.boolean(),
  sampleFrames: z.array(ICoarseFrame),
  coarseSampleTimestamps: z.array(z.number()),
  hasAudioTrack: z.boolean(),
  sourceContext: IPreparedSourceContext,
  updatedAt: z.string(),
});

export type IPreparedAssetCheckpoint = z.infer<typeof IPreparedAssetCheckpoint>;

export function getPreparedAssetCheckpointRoot(projectRoot: string): string {
  return join(projectRoot, 'analysis', 'prepared-assets');
}

export function getPreparedAssetCheckpointPath(projectRoot: string, assetId: string): string {
  return join(getPreparedAssetCheckpointRoot(projectRoot), `${assetId}.json`);
}

export async function loadPreparedAssetCheckpoint(
  projectRoot: string,
  assetId: string,
): Promise<IPreparedAssetCheckpoint | null> {
  return readJsonOrNull(
    getPreparedAssetCheckpointPath(projectRoot, assetId),
    IPreparedAssetCheckpoint,
  );
}

export async function writePreparedAssetCheckpoint(
  projectRoot: string,
  checkpoint: Omit<IPreparedAssetCheckpoint, 'updatedAt'> & { updatedAt?: string },
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
