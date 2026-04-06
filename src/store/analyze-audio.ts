import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import {
  IInterestingWindow,
  IKtepEvidence,
  IProtectedAudioAssessment,
  ITranscriptSegment,
} from '../protocol/schema.js';
import { readJsonOrNull, writeJson } from './writer.js';

const ITranscriptCheckpoint = z.object({
  transcript: z.string(),
  segments: z.array(ITranscriptSegment),
  evidence: z.array(IKtepEvidence),
  speechCoverage: z.number().min(0).max(1),
  speechWindows: z.array(IInterestingWindow),
});

const IAudioDecisionHints = z.object({
  protectionRecommendation: z.string().optional(),
  protectionTranscriptExcerpt: z.string().optional(),
});

const IAudioAnalysisCheckpoint = z.object({
  assetId: z.string(),
  transcript: ITranscriptCheckpoint.nullable().optional(),
  protectionTranscript: ITranscriptCheckpoint.nullable().optional(),
  protectedAudio: IProtectedAudioAssessment.optional(),
  decisionHints: IAudioDecisionHints.optional(),
  updatedAt: z.string(),
});

export type IAudioAnalysisCheckpoint = z.infer<typeof IAudioAnalysisCheckpoint>;

export function getAudioAnalysisCheckpointRoot(projectRoot: string): string {
  return join(projectRoot, 'analysis', 'audio-checkpoints');
}

export function getAudioAnalysisCheckpointPath(projectRoot: string, assetId: string): string {
  return join(getAudioAnalysisCheckpointRoot(projectRoot), `${assetId}.json`);
}

export async function loadAudioAnalysisCheckpoint(
  projectRoot: string,
  assetId: string,
): Promise<IAudioAnalysisCheckpoint | null> {
  return readJsonOrNull(
    getAudioAnalysisCheckpointPath(projectRoot, assetId),
    IAudioAnalysisCheckpoint,
  );
}

export async function writeAudioAnalysisCheckpoint(
  projectRoot: string,
  checkpoint: Omit<IAudioAnalysisCheckpoint, 'updatedAt'> & { updatedAt?: string },
): Promise<void> {
  await writeJson(getAudioAnalysisCheckpointPath(projectRoot, checkpoint.assetId), {
    ...checkpoint,
    updatedAt: checkpoint.updatedAt ?? new Date().toISOString(),
  });
}

export async function removeAudioAnalysisCheckpoint(
  projectRoot: string,
  assetId: string,
): Promise<void> {
  await unlink(getAudioAnalysisCheckpointPath(projectRoot, assetId)).catch(() => undefined);
}
