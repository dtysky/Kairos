import type { IVoiceoverAudioEnvelope } from './audio-envelope.js';

/** Provider words use seconds relative to the complete synthesized audio. */
export interface IVoiceoverWord {
  word: string;
  startTime: number;
  endTime: number;
}

export interface IVoiceoverAlignment {
  status: 'aligned' | 'blocked';
  reason?: string;
  sourceStartMs?: number;
  sourceEndMs?: number;
  speechStartMs?: number;
  speechEndMs?: number;
  tailAdjustment?: {
    version: string;
    originalEndMs: number;
    reason: 'quiet_pause' | 'no_stable_pause' | 'insufficient_reference';
    thresholdDbfs?: number;
  };
}

export const CVOICEOVER_ALIGNMENT_VERSION = 'subtitle-alignment-v1';
export const CVOICEOVER_TAIL_VERSION = 'quiet-pause-v1';

// Matching only: neither source subtitle text nor the provider transcript is rewritten.
export function voiceoverMatchText(text: string): string {
  return text.normalize('NFKC').replace(/[\p{P}\p{Z}\s]/gu, '');
}

/** Tighten only the post-word pause. Never move provider speech bounds or the head. */
export function refineVoiceoverTails(
  alignments: IVoiceoverAlignment[],
  envelope: IVoiceoverAudioEnvelope,
): IVoiceoverAlignment[] {
  const { frameMs, levelsDbfs, durationMs } = envelope;
  const aligned = alignments.filter(row => row.status === 'aligned');
  if (!Number.isFinite(frameMs) || frameMs <= 0 || !Number.isFinite(durationMs) || durationMs <= 0
    || !levelsDbfs.length || levelsDbfs.some(db => !Number.isFinite(db))
    || Math.abs(levelsDbfs.length * frameMs - durationMs) > frameMs + 0.001
    || aligned.some(row => row.speechEndMs! > durationMs)) {
    throw new Error('Voiceover audio envelope does not cover the aligned speech');
  }
  const percentile = (values: number[], ratio: number) => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor((sorted.length - 1) * ratio)]!;
  };
  return alignments.map(row => {
    if (row.status !== 'aligned') return row;
    const speechEnd = row.speechEndMs!;
    const originalEnd = row.sourceEndMs!;
    const audit: NonNullable<IVoiceoverAlignment['tailAdjustment']> = {
      version: CVOICEOVER_TAIL_VERSION, originalEndMs: originalEnd, reason: 'no_stable_pause',
    };
    // Whole bins only: a bin containing the last word cannot become a cut point.
    const first = Math.ceil(speechEnd / frameMs);
    const limit = Math.floor(Math.min(originalEnd, durationMs) / frameMs);
    const reference = levelsDbfs.slice(Math.ceil(Math.max(row.speechStartMs!, speechEnd - 300) / frameMs), Math.floor(speechEnd / frameMs));
    const pause = levelsDbfs.slice(first, limit);
    const holdFrames = Math.ceil(60 / frameMs);
    if (reference.length < 3 || pause.length < holdFrames || percentile(reference, 0.8) <= -90) {
      audit.reason = 'insufficient_reference';
      return { ...row, tailAdjustment: audit };
    }
    // Require both a substantial drop from speech and proximity to the local floor.
    const threshold = Math.min(percentile(reference, 0.8) - 24, percentile(pause, 0.2) + 6);
    audit.thresholdDbfs = threshold;
    let quietFrames = 0;
    for (let i = first; i < limit; i++) {
      quietFrames = levelsDbfs[i]! <= threshold ? quietFrames + 1 : 0;
      if (quietFrames < holdFrames) continue;
      // Keep 20ms after the release; the remaining >=40ms protects ceil-to-frame placement.
      const end = (i - quietFrames + 1) * frameMs + 20;
      if (end >= speechEnd && originalEnd - end >= 40) {
        audit.reason = 'quiet_pause';
        return { ...row, sourceEndMs: end, tailAdjustment: audit };
      }
    }
    return { ...row, tailAdjustment: audit };
  });
}

export function alignVoiceoverSubtitles(
  texts: string[],
  words: IVoiceoverWord[],
  audioDurationMs: number | null | undefined,
): IVoiceoverAlignment[] {
  const blocked = (reason: string): IVoiceoverAlignment => ({ status: 'blocked', reason });
  const failAll = (reason: string) => texts.map(() => blocked(reason));
  if (!Number.isFinite(audioDurationMs) || audioDurationMs! <= 0) return failAll('audio_duration_unknown');
  const normalized = texts.map(voiceoverMatchText);
  if (normalized.some(text => !text)) return failAll('subtitle_text_empty');
  const tokens = words.filter(word => typeof word?.word === 'string' && voiceoverMatchText(word.word));
  if (!tokens.length) return failAll('timestamps_missing');
  if (tokens.map(token => voiceoverMatchText(token.word)).join('') !== normalized.join('')) {
    return failAll('timestamp_text_mismatch');
  }
  let cursor = 0;
  const tokenRanges = tokens.map(token => {
    const start = cursor;
    cursor += Array.from(voiceoverMatchText(token.word)).length;
    return { start, end: cursor };
  });
  const valid = tokens.map((token, index) => {
    const previous = tokens[index - 1];
    const next = tokens[index + 1];
    return Number.isFinite(token.startTime) && Number.isFinite(token.endTime)
      && token.startTime >= 0 && token.endTime > token.startTime
      && token.endTime * 1000 <= audioDurationMs!
      && (!previous || !Number.isFinite(previous.endTime) || token.startTime >= previous.endTime)
      && (!next || !Number.isFinite(next.startTime) || token.endTime <= next.startTime);
  });
  cursor = 0;
  return normalized.map(text => {
    const start = cursor;
    cursor += Array.from(text).length;
    const end = cursor;
    const first = tokenRanges.findIndex(range => range.end > start);
    const last = tokenRanges.findIndex(range => range.end >= end);
    if (first < 0 || last < 0 || tokenRanges[first]!.start !== start || tokenRanges[last]!.end !== end) {
      return blocked('word_crosses_subtitle_boundary');
    }
    if (valid.slice(first, last + 1).some(value => !value)) return blocked('timestamp_range_invalid');
    const speechStartMs = tokens[first]!.startTime * 1000;
    const speechEndMs = tokens[last]!.endTime * 1000;
    // Word timestamps can stop before the audible release. Keep the trailing pause
    // through its midpoint instead of shaving every sentence down to a 50ms tail.
    const previousEnd = first > 0 && valid[first - 1] ? tokens[first - 1]!.endTime * 1000 : speechStartMs;
    const nextStart = last + 1 < tokens.length && valid[last + 1] ? tokens[last + 1]!.startTime * 1000 : speechEndMs;
    const head = first === 0 ? Math.min(50, speechStartMs) : Math.min(50, (speechStartMs - previousEnd) / 2);
    const tail = last === tokens.length - 1 ? audioDurationMs! - speechEndMs : (nextStart - speechEndMs) / 2;
    return {
      status: 'aligned',
      sourceStartMs: speechStartMs - head,
      sourceEndMs: speechEndMs + tail,
      speechStartMs,
      speechEndMs,
    };
  });
}
