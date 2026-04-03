import type { IKtepEvidence } from '../../protocol/schema.js';
import type {
  MlClient,
  IAsrSegment,
  IMlAsrTiming,
} from './ml-client.js';

export interface ITranscription {
  segments: IAsrSegment[];
  fullText: string;
  evidence: IKtepEvidence[];
  timing?: IMlAsrTiming;
  roundTripMs?: number;
}

export async function transcribe(
  client: MlClient,
  audioPath: string,
  language?: string,
): Promise<ITranscription> {
  const startedAt = Date.now();
  const result = await client.asrDetailed(audioPath, language);
  const roundTripMs = Date.now() - startedAt;
  const segments = result.segments;
  const fullText = segments.map(s => s.text).join(' ').trim();
  const evidence: IKtepEvidence[] = segments
    .filter(s => s.text.trim().length > 0)
    .map(s => ({
      source: 'asr' as const,
      value: s.text.trim(),
      confidence: 0.8,
    }));

  return {
    segments,
    fullText,
    evidence,
    timing: result.timing,
    roundTripMs,
  };
}
