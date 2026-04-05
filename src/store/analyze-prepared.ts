import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { EClipType, IKtepEvidence } from '../protocol/schema.js';
import { readJsonOrNull, writeJson } from './writer.js';

const IShotBoundary = z.object({
  timeMs: z.number(),
  score: z.number(),
});

const ICoarseFrame = z.object({
  timeMs: z.number(),
  path: z.string(),
});

const IMlVlmTiming = z.object({
  backend: z.string().optional(),
  modelRef: z.string().optional(),
  totalMs: z.number().optional(),
  loadMs: z.number().optional(),
  imageOpenMs: z.number().optional(),
  processorMs: z.number().optional(),
  h2dMs: z.number().optional(),
  generateMs: z.number().optional(),
  decodeMs: z.number().optional(),
});

const IRecognitionCheckpoint = z.object({
  sceneType: z.string(),
  subjects: z.array(z.string()),
  mood: z.string(),
  placeHints: z.array(z.string()),
  narrativeRole: z.string(),
  description: z.string(),
  evidence: z.array(IKtepEvidence),
  timing: IMlVlmTiming.optional(),
  roundTripMs: z.number().optional(),
  imageCount: z.number().optional(),
});

const IPreparedAssetCheckpoint = z.object({
  assetId: z.string(),
  shotBoundaries: z.array(IShotBoundary),
  shotBoundariesResolved: z.boolean(),
  sampleFrames: z.array(ICoarseFrame),
  coarseSampleTimestamps: z.array(z.number()),
  visualSummary: IRecognitionCheckpoint.nullable(),
  initialClipTypeGuess: EClipType,
  hasAudioTrack: z.boolean(),
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
