import type {
  IKtepEvidence,
  IInterestingWindow,
  ITranscriptSegment,
} from '../../protocol/schema.js';

export interface ITranscriptContext {
  transcript: string;
  segments: ITranscriptSegment[];
  evidence: IKtepEvidence[];
  speechCoverage: number;
  speechWindows: IInterestingWindow[];
}

export const CMIN_CREDIBLE_SPEECH_COVERAGE = 0.05;

export function normalizeTranscriptContext(
  transcript?: ITranscriptContext | null,
): ITranscriptContext | null {
  if (!transcript) return null;

  const segments = transcript.segments
    .map(segment => ({
      startMs: segment.startMs,
      endMs: segment.endMs,
      text: segment.text.trim(),
    }))
    .filter(segment => segment.endMs > segment.startMs && segment.text.length > 0);
  const normalizedTranscript = transcript.transcript.trim()
    || segments.map(segment => segment.text).join(' ').trim();
  const speechWindows = transcript.speechWindows
    .filter(window => window.endMs > window.startMs)
    .map(normalizeInterestingWindow)
    .filter((window): window is IInterestingWindow => window != null);
  const speechCoverage = Math.max(0, Math.min(1, transcript.speechCoverage));

  if (!normalizedTranscript && segments.length === 0) return null;
  if (speechCoverage < CMIN_CREDIBLE_SPEECH_COVERAGE) return null;

  return {
    transcript: normalizedTranscript,
    segments,
    evidence: [...transcript.evidence],
    speechCoverage,
    speechWindows,
  };
}

export function hasMeaningfulSpeech(
  transcript?: ITranscriptContext | null,
): boolean {
  if (!transcript) return false;

  const compactTranscript = transcript.transcript.replace(/\s+/g, '');
  if (compactTranscript.length >= 20) return true;
  if (transcript.segments.length >= 2 && transcript.speechCoverage >= 0.08) return true;
  return transcript.speechCoverage >= 0.18;
}

function normalizeInterestingWindow(
  window: IInterestingWindow,
): IInterestingWindow | null {
  if (window.endMs <= window.startMs) return null;

  const editStartMs = typeof window.editStartMs === 'number' ? window.editStartMs : undefined;
  const editEndMs = typeof window.editEndMs === 'number' ? window.editEndMs : undefined;
  const suggestedSpeeds = window.speedCandidate
    ? [...window.speedCandidate.suggestedSpeeds]
      .filter(speed => Number.isFinite(speed) && speed > 0)
    : [];

  return {
    ...window,
    ...(editStartMs != null && editEndMs != null && editEndMs > editStartMs
      ? {
        editStartMs,
        editEndMs,
      }
      : {}),
    ...(window.speedCandidate && suggestedSpeeds.length > 0
      ? {
        speedCandidate: {
          ...window.speedCandidate,
          suggestedSpeeds,
        },
      }
      : {}),
  };
}
