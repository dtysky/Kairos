import { describe, expect, it } from 'vitest';
import { alignVoiceoverSubtitles, type IVoiceoverWord } from '../../src/modules/voiceover/subtitle-alignment.js';

const word = (text: string, startTime: number, endTime: number): IVoiceoverWord => ({ word: text, startTime, endTime });

describe('voiceover subtitle alignment', () => {
  it('maps repeated lines by ordered character coverage and shares only silence', () => {
    const result = alignVoiceoverSubtitles(['你好。', '你好！'], [word('你', 0.2, 0.4), word('好。', 0.4, 0.8), word('你好！', 0.86, 1.4)], 1500);
    expect(result[0]).toMatchObject({ status: 'aligned', sourceStartMs: 150, sourceEndMs: 830 });
    expect(result[1]).toMatchObject({ status: 'aligned', sourceStartMs: 830, sourceEndMs: 1500 });
  });

  it('preserves the audible release through the sentence pause and the final audio tail', () => {
    const result = alignVoiceoverSubtitles(['穿过沿溪的古村', '我开始看见'], [
      word('穿过沿溪的古村', 8.640125, 10.015125),
      word('我开始看见', 10.325125, 11.315125),
    ], 11600);
    expect(result[0]?.sourceEndMs).toBeCloseTo(10170.125);
    expect(result[1]?.sourceStartMs).toBeCloseTo(10275.125);
    expect(result[1]?.sourceEndMs).toBe(11600);
  });

  it('keeps original digits, English and Unicode characters across provider sentence boundaries', () => {
    const result = alignVoiceoverSubtitles(['２０２６年', 'Hello world 🙂'], [word('2026', 0, 0.4), word('年，', 0.4, 0.8), word('Hello', 1, 1.5), word('world', 1.5, 2), word('🙂', 2, 2.2)], 2300);
    expect(result.every(row => row.status === 'aligned')).toBe(true);
    expect(result[1]?.speechEndMs).toBe(2200);
  });

  it('never splits a provider word proportionally across two source subtitles', () => {
    const result = alignVoiceoverSubtitles(['你', '好', '再见'], [word('你好', 0, 1), word('再见', 1.5, 2)], 2100);
    expect(result.map(row => row.status)).toEqual(['blocked', 'blocked', 'aligned']);
    expect(result[0]?.reason).toBe('word_crosses_subtitle_boundary');
  });

  it.each([
    ['missing', []],
    ['missing characters', [word('你好', 0, 1)]],
    ['extra characters', [word('你好你好再见多了', 0, 1)]],
    ['spoken-number mismatch', [word('二零二六', 0, 1)]],
  ])('rejects %s rather than estimating timing', (_, words) => {
    expect(alignVoiceoverSubtitles(['你好', '再见'], words as IVoiceoverWord[], 2000).every(row => row.status === 'blocked')).toBe(true);
  });

  it.each([NaN, -1, 3])('isolates invalid time %s without dropping other sentences', (start) => {
    const result = alignVoiceoverSubtitles(['甲', '乙', '丙'], [word('甲', 0.1, 0.4), word('乙', start, 1), word('丙', 1.5, 1.8)], 2000);
    expect(result[1]?.status).toBe('blocked');
    expect(result[2]?.status).toBe('aligned');
  });

  it('blocks both sides of an overlapping or reversed token interval', () => {
    expect(alignVoiceoverSubtitles(['甲', '乙'], [word('甲', 0.1, 0.7), word('乙', 0.6, 1)], 1500).map(row => row.status)).toEqual(['blocked', 'blocked']);
  });

  it('requires measured audio duration and refuses timestamps beyond the audio', () => {
    expect(alignVoiceoverSubtitles(['甲'], [word('甲', 0, 1)], null)[0]?.reason).toBe('audio_duration_unknown');
    expect(alignVoiceoverSubtitles(['甲'], [word('甲', 0, 1.1)], 1000)[0]?.reason).toBe('timestamp_range_invalid');
  });
});
