import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import {
  IAudioHealthSummary,
  IAlignedTranscriptToken,
  IInterestingWindow,
  IProtectedAudioAssessment,
  ITranscriptSegmentation,
  ITranscriptSegment,
} from '../protocol/schema.js';
import { readJsonOrNull, writeJson } from './writer.js';

export const CAUDIO_ALIGNMENT_CONTRACT_VERSION = 'qwen3-character-alignment-v2';

const ITranscriptCheckpoint = z.object({
  rawText: z.string(),
  alignedTokens: z.array(IAlignedTranscriptToken),
  segmentation: ITranscriptSegmentation,
  transcript: z.string(),
  segments: z.array(ITranscriptSegment),
  speechCoverage: z.number().min(0).max(1),
  speechWindows: z.array(IInterestingWindow),
});

const IAudioDecisionHints = z.object({
  protectionRecommendation: z.string().optional(),
  protectionTranscriptExcerpt: z.string().optional(),
});

const EAudioTranscriptSource = z.enum(['embedded', 'protection']);
export type EAudioTranscriptSource = z.infer<typeof EAudioTranscriptSource>;

const IAudioAnalysisCheckpoint = z.object({
  schemaVersion: z.literal(3),
  alignmentContractVersion: z.literal(CAUDIO_ALIGNMENT_CONTRACT_VERSION),
  assetId: z.string(),
  selectedTranscript: ITranscriptCheckpoint.nullable().optional(),
  selectedTranscriptSource: EAudioTranscriptSource.optional(),
  embeddedHealth: IAudioHealthSummary.optional(),
  protectionHealth: IAudioHealthSummary.optional(),
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
  checkpoint: Omit<IAudioAnalysisCheckpoint, 'updatedAt' | 'schemaVersion' | 'alignmentContractVersion'> & { updatedAt?: string },
): Promise<void> {
  await writeJson(getAudioAnalysisCheckpointPath(projectRoot, checkpoint.assetId), {
    schemaVersion: 3,
    alignmentContractVersion: CAUDIO_ALIGNMENT_CONTRACT_VERSION,
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
