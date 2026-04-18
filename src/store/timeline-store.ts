import { join } from 'node:path';
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
import { readJsonOrNull, writeJson } from './writer.js';

export function getTimelineCurrentPath(projectRoot: string): string {
  return join(projectRoot, 'timeline', 'current.json');
}

export function getTimelineRoughCutBasePath(projectRoot: string): string {
  return join(projectRoot, 'timeline', 'rough-cut-base.json');
}

export function getTimelineSegmentCutsRoot(projectRoot: string): string {
  return join(projectRoot, 'timeline', 'segment-cuts');
}

export function getTimelineSegmentCutPath(projectRoot: string, segmentId: string): string {
  return join(getTimelineSegmentCutsRoot(projectRoot), `${segmentId}.json`);
}

export function getTimelineAgentPacketsRoot(projectRoot: string): string {
  return join(projectRoot, 'timeline', 'agent-packets');
}

export function getTimelineAgentPacketPath(projectRoot: string, segmentId: string): string {
  return join(getTimelineAgentPacketsRoot(projectRoot), `${segmentId}.json`);
}

export function getTimelineReviewsRoot(projectRoot: string): string {
  return join(projectRoot, 'timeline', 'reviews');
}

export function getTimelineReviewPath(projectRoot: string, segmentId: string): string {
  return join(getTimelineReviewsRoot(projectRoot), `${segmentId}.json`);
}

export function getTimelineAgentPipelinePath(projectRoot: string): string {
  return join(projectRoot, 'timeline', 'agent-pipeline.json');
}

export async function loadTimelineRoughCutBase(
  projectRoot: string,
): Promise<ITimelineRoughCutBase | null> {
  return readJsonOrNull(
    getTimelineRoughCutBasePath(projectRoot),
    ZTimelineRoughCutBase,
  ) as Promise<ITimelineRoughCutBase | null>;
}

export async function writeTimelineRoughCutBase(
  projectRoot: string,
  roughCutBase: ITimelineRoughCutBase,
): Promise<void> {
  await writeJson(getTimelineRoughCutBasePath(projectRoot), roughCutBase);
}

export async function loadTimelineSegmentCut(
  projectRoot: string,
  segmentId: string,
): Promise<ISegmentRoughCutPlan | null> {
  return readJsonOrNull(
    getTimelineSegmentCutPath(projectRoot, segmentId),
    ZSegmentRoughCutPlan,
  ) as Promise<ISegmentRoughCutPlan | null>;
}

export async function writeTimelineSegmentCut(
  projectRoot: string,
  segmentCut: ISegmentRoughCutPlan,
): Promise<void> {
  await writeJson(getTimelineSegmentCutPath(projectRoot, segmentCut.segmentId), segmentCut);
}

export async function loadTimelineAgentPacket(
  projectRoot: string,
  segmentId: string,
): Promise<IAgentPacket | null> {
  return readJsonOrNull(
    getTimelineAgentPacketPath(projectRoot, segmentId),
    ZAgentPacket,
  ) as Promise<IAgentPacket | null>;
}

export async function writeTimelineAgentPacket(
  projectRoot: string,
  segmentId: string,
  packet: IAgentPacket,
): Promise<void> {
  await writeJson(getTimelineAgentPacketPath(projectRoot, segmentId), packet);
}

export async function loadTimelineStageReview(
  projectRoot: string,
  segmentId: string,
): Promise<ISegmentCutReview | null> {
  return readJsonOrNull(
    getTimelineReviewPath(projectRoot, segmentId),
    ZSegmentCutReview,
  ) as Promise<ISegmentCutReview | null>;
}

export async function writeTimelineStageReview(
  projectRoot: string,
  review: ISegmentCutReview,
): Promise<void> {
  await writeJson(getTimelineReviewPath(projectRoot, review.segmentId), review);
}

export async function loadTimelineAgentPipeline(
  projectRoot: string,
): Promise<IAgentPipelineState | null> {
  return readJsonOrNull(
    getTimelineAgentPipelinePath(projectRoot),
    ZAgentPipelineState,
  ) as Promise<IAgentPipelineState | null>;
}

export async function writeTimelineAgentPipeline(
  projectRoot: string,
  pipeline: IAgentPipelineState,
): Promise<void> {
  await writeJson(getTimelineAgentPipelinePath(projectRoot), pipeline);
}
