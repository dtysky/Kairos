import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { IKtepSlice } from '../protocol/schema.js';
import { readJsonOrNull, writeJson } from './writer.js';

export const EFineScanCheckpointStatus = z.enum([
  'frame-plan-ready',
  'prefetching',
  'frames-ready',
  'recognizing',
  'persisted',
]);
export type EFineScanCheckpointStatus = z.infer<typeof EFineScanCheckpointStatus>;

const IFineScanKeyframePlan = z.object({
  shotId: z.string(),
  startMs: z.number(),
  endMs: z.number(),
  timestampsMs: z.array(z.number()),
});

export const IFineScanCheckpoint = z.object({
  assetId: z.string(),
  status: EFineScanCheckpointStatus,
  effectiveSlices: z.array(IKtepSlice),
  keyframePlans: z.array(IFineScanKeyframePlan),
  timestampsMs: z.array(z.number()),
  expectedFramePaths: z.array(z.string()),
  readyFrameCount: z.number().int().nonnegative(),
  readyFrameBytes: z.number().int().nonnegative(),
  droppedInvalidSliceCount: z.number().int().nonnegative(),
  updatedAt: z.string(),
});
export type IFineScanCheckpoint = z.infer<typeof IFineScanCheckpoint>;

export function getFineScanCheckpointRoot(projectRoot: string): string {
  return join(projectRoot, 'analysis', 'fine-scan-checkpoints');
}

export function getFineScanCheckpointPath(projectRoot: string, assetId: string): string {
  return join(getFineScanCheckpointRoot(projectRoot), `${assetId}.json`);
}

export async function loadFineScanCheckpoint(
  projectRoot: string,
  assetId: string,
): Promise<IFineScanCheckpoint | null> {
  return readJsonOrNull(
    getFineScanCheckpointPath(projectRoot, assetId),
    IFineScanCheckpoint,
  ) as Promise<IFineScanCheckpoint | null>;
}

export async function writeFineScanCheckpoint(
  projectRoot: string,
  checkpoint: Omit<IFineScanCheckpoint, 'updatedAt'> & { updatedAt?: string },
): Promise<void> {
  await writeJson(getFineScanCheckpointPath(projectRoot, checkpoint.assetId), {
    ...checkpoint,
    effectiveSlices: checkpoint.effectiveSlices.map(normalizeCheckpointSlice),
    updatedAt: checkpoint.updatedAt ?? new Date().toISOString(),
  });
}

export async function removeFineScanCheckpoint(
  projectRoot: string,
  assetId: string,
): Promise<void> {
  await unlink(getFineScanCheckpointPath(projectRoot, assetId)).catch(() => undefined);
}

function normalizeCheckpointSlice(slice: IKtepSlice): IKtepSlice {
  return {
    ...slice,
    narrativeFunctions: {
      core: slice.narrativeFunctions?.core ?? [],
      extra: slice.narrativeFunctions?.extra ?? [],
      evidence: slice.narrativeFunctions?.evidence ?? [],
    },
    shotGrammar: {
      core: slice.shotGrammar?.core ?? [],
      extra: slice.shotGrammar?.extra ?? [],
      evidence: slice.shotGrammar?.evidence ?? [],
    },
    viewpointRoles: {
      core: slice.viewpointRoles?.core ?? [],
      extra: slice.viewpointRoles?.extra ?? [],
      evidence: slice.viewpointRoles?.evidence ?? [],
    },
    subjectStates: {
      core: slice.subjectStates?.core ?? [],
      extra: slice.subjectStates?.extra ?? [],
      evidence: slice.subjectStates?.evidence ?? [],
    },
    grounding: {
      speechMode: slice.grounding?.speechMode ?? 'none',
      speechValue: slice.grounding?.speechValue ?? 'none',
      spatialEvidence: slice.grounding?.spatialEvidence ?? [],
      pharosRefs: slice.grounding?.pharosRefs ?? [],
    },
  };
}
