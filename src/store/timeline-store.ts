import { join } from 'node:path';
import { z } from 'zod';
import type {
  IAgentPacket,
  IAgentPipelineState,
  ISegmentCutReview,
  ISegmentRoughCutPlan,
  ITimelineRoughCutBase,
} from '../protocol/schema.js';
import {
  IAgentPacket as ZAgentPacket,
  IAgentPipelineState as ZAgentPipelineState,
  ISegmentCutReview as ZSegmentCutReview,
  ISegmentRoughCutPlan as ZSegmentRoughCutPlan,
  ITimelineRoughCutBase as ZTimelineRoughCutBase,
} from '../protocol/schema.js';
import {
  getLegacyTimelineRoot,
  getProjectEditTimelineRoot,
  normalizeEditId,
  shouldReadLegacyEditPath,
} from './edit-store.js';
import { readJsonOrNull, writeJson } from './writer.js';

export function getTimelineCurrentPath(projectRoot: string, editId?: string | null): string {
  return join(projectRoot, '.tmp', 'edit-flow', normalizeEditId(editId), 'timeline', 'current.json');
}

export function getTimelineSubtitleSrtPath(projectRoot: string, editId?: string | null): string {
  return join(projectRoot, '.tmp', 'edit-flow', normalizeEditId(editId), 'timeline', 'current.srt');
}

export function getTimelineRemainingPath(projectRoot: string, editId?: string | null): string {
  return join(projectRoot, '.tmp', 'edit-flow', normalizeEditId(editId), 'timeline', 'remaining.json');
}

export function getTimelineRemainingSrtPath(projectRoot: string, editId?: string | null): string {
  return join(projectRoot, '.tmp', 'edit-flow', normalizeEditId(editId), 'timeline', 'remaining.srt');
}

export function getTimelineRoughCutBasePath(projectRoot: string, editId?: string | null): string {
  return join(getProjectEditTimelineRoot(projectRoot, editId), 'rough-cut-base.json');
}

export function getTimelineSegmentCutsRoot(projectRoot: string, editId?: string | null): string {
  return join(getProjectEditTimelineRoot(projectRoot, editId), 'segment-cuts');
}

export function getTimelineSegmentCutPath(projectRoot: string, segmentId: string, editId?: string | null): string {
  return join(getTimelineSegmentCutsRoot(projectRoot, editId), `${segmentId}.json`);
}

export function getTimelineAgentPacketsRoot(projectRoot: string, editId?: string | null): string {
  return join(getProjectEditTimelineRoot(projectRoot, editId), 'agent-packets');
}

export function getTimelineAgentPacketPath(projectRoot: string, segmentId: string, editId?: string | null): string {
  return join(getTimelineAgentPacketsRoot(projectRoot, editId), `${segmentId}.json`);
}

export function getTimelineReviewsRoot(projectRoot: string, editId?: string | null): string {
  return join(getProjectEditTimelineRoot(projectRoot, editId), 'reviews');
}

export function getTimelineReviewPath(projectRoot: string, segmentId: string, editId?: string | null): string {
  return join(getTimelineReviewsRoot(projectRoot, editId), `${segmentId}.json`);
}

export function getTimelineAgentPipelinePath(projectRoot: string, editId?: string | null): string {
  return join(getProjectEditTimelineRoot(projectRoot, editId), 'agent-pipeline.json');
}

export function getTimelineLockedRoughCutPath(projectRoot: string, editId?: string | null): string {
  return join(getProjectEditTimelineRoot(projectRoot, editId), 'locked-rough-cut.json');
}

async function readTimelineJsonOrLegacy<T>(
  projectRoot: string,
  editId: string | null | undefined,
  primaryPath: string,
  legacyPath: string,
  schema: z.ZodTypeAny,
): Promise<T | null> {
  const primary = await readJsonOrNull(primaryPath, schema) as T | null;
  if (primary || !shouldReadLegacyEditPath(editId)) return primary as T | null;
  return readJsonOrNull(legacyPath, schema) as Promise<T | null>;
}

export async function loadTimelineRoughCutBase(
  projectRoot: string,
  editId?: string | null,
): Promise<ITimelineRoughCutBase | null> {
  return readTimelineJsonOrLegacy(
    projectRoot,
    editId,
    getTimelineRoughCutBasePath(projectRoot, editId),
    join(getLegacyTimelineRoot(projectRoot), 'rough-cut-base.json'),
    ZTimelineRoughCutBase,
  );
}

export async function writeTimelineRoughCutBase(
  projectRoot: string,
  roughCutBase: ITimelineRoughCutBase,
  editId?: string | null,
): Promise<void> {
  await writeJson(getTimelineRoughCutBasePath(projectRoot, editId), roughCutBase);
}

export async function loadTimelineSegmentCut(
  projectRoot: string,
  segmentId: string,
  editId?: string | null,
): Promise<ISegmentRoughCutPlan | null> {
  return readTimelineJsonOrLegacy(
    projectRoot,
    editId,
    getTimelineSegmentCutPath(projectRoot, segmentId, editId),
    join(getLegacyTimelineRoot(projectRoot), 'segment-cuts', `${segmentId}.json`),
    ZSegmentRoughCutPlan,
  );
}

export async function writeTimelineSegmentCut(
  projectRoot: string,
  segmentCut: ISegmentRoughCutPlan,
  editId?: string | null,
): Promise<void> {
  await writeJson(getTimelineSegmentCutPath(projectRoot, segmentCut.segmentId, editId), segmentCut);
}

export async function loadTimelineAgentPacket(
  projectRoot: string,
  segmentId: string,
  editId?: string | null,
): Promise<IAgentPacket | null> {
  return readTimelineJsonOrLegacy(
    projectRoot,
    editId,
    getTimelineAgentPacketPath(projectRoot, segmentId, editId),
    join(getLegacyTimelineRoot(projectRoot), 'agent-packets', `${segmentId}.json`),
    ZAgentPacket,
  );
}

export async function writeTimelineAgentPacket(
  projectRoot: string,
  segmentId: string,
  packet: IAgentPacket,
  editId?: string | null,
): Promise<void> {
  await writeJson(getTimelineAgentPacketPath(projectRoot, segmentId, editId), packet);
}

export async function loadTimelineStageReview(
  projectRoot: string,
  segmentId: string,
  editId?: string | null,
): Promise<ISegmentCutReview | null> {
  return readTimelineJsonOrLegacy(
    projectRoot,
    editId,
    getTimelineReviewPath(projectRoot, segmentId, editId),
    join(getLegacyTimelineRoot(projectRoot), 'reviews', `${segmentId}.json`),
    ZSegmentCutReview,
  );
}

export async function writeTimelineStageReview(
  projectRoot: string,
  review: ISegmentCutReview,
  editId?: string | null,
): Promise<void> {
  await writeJson(getTimelineReviewPath(projectRoot, review.segmentId, editId), review);
}

export async function loadTimelineAgentPipeline(
  projectRoot: string,
  editId?: string | null,
): Promise<IAgentPipelineState | null> {
  return readTimelineJsonOrLegacy(
    projectRoot,
    editId,
    getTimelineAgentPipelinePath(projectRoot, editId),
    join(getLegacyTimelineRoot(projectRoot), 'agent-pipeline.json'),
    ZAgentPipelineState,
  );
}

export async function writeTimelineAgentPipeline(
  projectRoot: string,
  pipeline: IAgentPipelineState,
  editId?: string | null,
): Promise<void> {
  await writeJson(getTimelineAgentPipelinePath(projectRoot, editId), pipeline);
}
