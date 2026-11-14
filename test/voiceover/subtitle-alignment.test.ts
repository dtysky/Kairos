import { describe, expect, it } from 'vitest';
import { alignVoiceoverSubtitles, refineVoiceoverTails, type IVoiceoverWord } from '../../src/modules/voiceover/subtitle-alignment.js';

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

describe('voiceover post-word quiet pauses', () => {
  const envelope = (spans: Array<[number, number, number]>, durationMs = 1800) => {
    const levelsDbfs = Array.from({ length: durationMs / 10 }, () => -75);
    for (const [start, end, db] of spans) levelsDbfs.fill(db, start / 10, end / 10);
    return { frameMs: 10, durationMs, levelsDbfs };
  };
  const alignment = () => alignVoiceoverSubtitles(['古村', '再见'], [word('古村', 0.1, 1), word('再见', 1.6, 1.7)], 1800);

  it('keeps a release beyond the word timestamp and cuts in the following pause before a breath', () => {
    const rows = alignment();
    const audio = envelope([[100, 1000, -22], [1000, 1120, -34], [1220, 1300, -46], [1600, 1720, -24]]);
    const result = refineVoiceoverTails(rows, audio);
    expect(result[0]).toMatchObject({ speechEndMs: 1000, sourceStartMs: 50, sourceEndMs: 1140,
      tailAdjustment: { reason: 'quiet_pause', originalEndMs: 1300 } });
    expect(result[1]?.sourceEndMs).toBe(1740);
    expect(rows[0]?.sourceEndMs).toBe(1300);
  });

  it('does not shave off sustained quiet consonants when there is no separate quiet pause', () => {
    const rows = alignment();
    const result = refineVoiceoverTails(rows, envelope([[100, 1000, -22], [1000, 1300, -40]]));
    expect(result[0]?.sourceEndMs).toBe(1300);
    expect(result[0]?.tailAdjustment?.reason).toBe('no_stable_pause');
  });

  it('ignores a short dip inside a release and waits for a sustained quiet interval', () => {
    const result = refineVoiceoverTails(alignment(), envelope([
      [100, 1020, -22], [1050, 1130, -32], [1230, 1300, -45],
    ]));
    expect(result[0]?.sourceEndMs).toBe(1150);
  });

  it('uses relative levels so gain changes do not move the cut', () => {
    const audio = envelope([[100, 1100, -22], [1220, 1300, -44]]);
    const quieter = { ...audio, levelsDbfs: audio.levelsDbfs.map(db => db - 15) };
    expect(refineVoiceoverTails(alignment(), audio)[0]?.sourceEndMs)
      .toBe(refineVoiceoverTails(alignment(), quieter)[0]?.sourceEndMs);
  });

  it('retains the safe bound for short gaps or missing speech energy', () => {
    const rows = alignVoiceoverSubtitles(['甲', '乙'], [word('甲', 0.1, 1), word('乙', 1.06, 1.4)], 1800);
    expect(refineVoiceoverTails(rows, envelope([[100, 1000, -20]]))[0]?.sourceEndMs).toBe(1030);
    expect(refineVoiceoverTails(alignment(), envelope([]))[0]?.sourceEndMs).toBe(1300);
  });

  it('refuses invalid or truncated decoded audio and preserves blocked rows', () => {
    expect(() => refineVoiceoverTails(alignment(), envelope([], 1000))).toThrow(/cover/);
    const bad = envelope([]); bad.levelsDbfs[0] = NaN;
    expect(() => refineVoiceoverTails(alignment(), bad)).toThrow(/cover/);
    const rows = [{ status: 'blocked' as const, reason: 'timestamps_missing' }];
    expect(refineVoiceoverTails(rows, envelope([]))).toEqual(rows);
  });
});
