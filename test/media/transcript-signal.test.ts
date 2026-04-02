import { describe, expect, it } from 'vitest';
import {
  hasMeaningfulSpeech,
  normalizeTranscriptContext,
} from '../../src/modules/media/transcript-signal.js';

describe('transcript signal filtering', () => {
  it('drops sparse transcript context below the credibility threshold', () => {
    const transcript = normalizeTranscriptContext({
      transcript: 'can can can can',
      segments: [{
        startMs: 0,
        endMs: 520,
        text: 'can can can can',
      }],
      evidence: [],
      speechCoverage: 0.03,
      speechWindows: [{
        startMs: 0,
        endMs: 1420,
        reason: 'speech-window',
      }],
    });

    expect(transcript).toBeNull();
    expect(hasMeaningfulSpeech(transcript)).toBe(false);
  });

  it('keeps simple but high-coverage speech from the source clip', () => {
    const transcript = normalizeTranscriptContext({
      transcript: 'Thank you. Thank you.',
      segments: [
        {
          startMs: 0,
          endMs: 29_980,
          text: 'Thank you.',
        },
        {
          startMs: 30_000,
          endMs: 59_980,
          text: 'Thank you.',
        },
      ],
      evidence: [],
      speechCoverage: 1,
      speechWindows: [{
        startMs: 0,
        endMs: 54_555,
        reason: 'speech-window',
      }],
    });

    expect(transcript).not.toBeNull();
    expect(transcript?.transcript).toBe('Thank you. Thank you.');
    expect(transcript?.speechCoverage).toBe(1);
    expect(hasMeaningfulSpeech(transcript)).toBe(true);
  });
});
