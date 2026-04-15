import type { IKtepEvidence } from '../../protocol/schema.js';
import type {
  MlClient,
  IAsrSegment,
  IAsrWord,
  IMlAsrTiming,
  IMlRequestOptions,
} from './ml-client.js';
import {
  buildTranscriptText,
  normalizeAsrWords,
  refineAsrSegments,
} from './refined-transcript.js';
import {
  normalizeHanTextToSimplified,
  normalizeTranscriptSegmentsToSimplified,
  normalizeTranscriptWordsToSimplified,
} from './chinese-transcript.js';

export interface ITranscription {
  segments: IAsrSegment[];
  words?: IAsrWord[];
  fullText: string;
  evidence: IKtepEvidence[];
  timing?: IMlAsrTiming;
  roundTripMs?: number;
}

export interface ITranscribeOptions extends IMlRequestOptions {}

export async function transcribe(
  client: MlClient,
  audioPath: string,
  language?: string,
  options?: ITranscribeOptions,
): Promise<ITranscription> {
  const startedAt = Date.now();
  const result = await client.asrDetailed(audioPath, language, options);
  const roundTripMs = Date.now() - startedAt;
  const words = normalizeTranscriptWordsToSimplified(normalizeAsrWords(result.words ?? []));
  const segments = refineAsrSegments({
    segments: normalizeTranscriptSegmentsToSimplified(result.segments),
    words,
  });
  const simplifiedSegments = normalizeTranscriptSegmentsToSimplified(segments);
  const fullText = normalizeHanTextToSimplified(buildTranscriptText({
    segments: simplifiedSegments,
    words,
  }));
  const evidence: IKtepEvidence[] = simplifiedSegments
    .filter(s => s.text.trim().length > 0)
    .map(s => ({
      source: 'asr' as const,
      value: s.text.trim(),
      confidence: 0.8,
    }));

  return {
    segments: simplifiedSegments,
    ...(words.length > 0 ? { words } : {}),
    fullText,
    evidence,
    timing: result.timing,
    roundTripMs,
  };
}
