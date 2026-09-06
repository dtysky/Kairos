import { describe, expect, it } from 'vitest';
import {
  CTRANSCRIPT_SEGMENTATION_MERGE_GAP_MS,
  CTRANSCRIPT_SEGMENTATION_POLICY_VERSION,
  segmentAlignedTranscript,
} from '../../src/modules/media/transcript-segmentation.js';

function makeTokens(
  text: string,
  gapsAfter: Record<number, number> = {},
  durationMs = 100,
) {
  let cursorMs = 0;
  return Array.from(text).map((character, index, characters) => {
    const startMs = cursorMs;
    const endMs = startMs + durationMs;
    const gapAfterMs = index === characters.length - 1 ? 0 : gapsAfter[index] ?? 0;
    cursorMs = endMs + gapAfterMs;
    return { index, startMs, endMs, gapAfterMs, text: character };
  });
}

describe('deterministic transcript segmentation', () => {
  it('treats commas as soft and every other punctuation mark as a sentence end', () => {
    const rawText = '甲，乙：丙；丁…戊！己？庚。辛,壬';
    const tokens = makeTokens(rawText.replace(/[\p{P}\s]/gu, ''), {
      1: 2000,
      2: 2000,
      3: 2000,
      4: 2000,
      5: 2000,
      6: 2000,
    });
    const result = segmentAlignedTranscript({ assetId: 'punctuation', rawText, tokens });
    expect(result.segments.map(segment => segment.text)).toEqual([
      '甲，乙：',
      '丙；',
      '丁…',
      '戊！',
      '己？',
      '庚。',
      '辛,壬',
    ]);
  });

  it('merges ended sentences only below 1500ms and within 36 characters', () => {
    const rawText = '第一句。第二句！第三句？';
    const body = rawText.replace(/\p{P}/gu, '');
    const tokens = makeTokens(body, { 2: 1499, 5: CTRANSCRIPT_SEGMENTATION_MERGE_GAP_MS });
    const result = segmentAlignedTranscript({ assetId: 'merge', rawText, tokens });
    expect(result.segments.map(segment => segment.text)).toEqual([
      '第一句。第二句！',
      '第三句？',
    ]);
  });

  it('splits long sentences only at balanced existing commas and projects them to periods', () => {
    const pieces = ['甲'.repeat(18), '乙'.repeat(18), '丙'.repeat(18)];
    const rawText = `${pieces[0]}，${pieces[1]}，${pieces[2]}。`;
    const tokens = makeTokens(pieces.join(''));
    const result = segmentAlignedTranscript({ assetId: 'long', rawText, tokens });
    expect(result.segments).toHaveLength(2);
    expect(result.segments[0]?.text).toBe(`${pieces[0]}。`);
    expect(result.segments[1]?.text).toBe(`${pieces[1]}，${pieces[2]}。`);
    expect(result.segments.every(segment => segment.text.replace(/\p{P}/gu, '').length <= 36)).toBe(true);
  });

  it('does not invent a split when an overlong sentence has no comma', () => {
    const body = '长'.repeat(40);
    const result = segmentAlignedTranscript({
      assetId: 'no-comma',
      rawText: `${body}。`,
      tokens: makeTokens(body),
    });
    expect(result.segments).toEqual([{ startMs: 0, endMs: 4000, text: `${body}。` }]);
  });

  it('repairs a token that absorbed long silence and records an audit row', () => {
    const tokens = makeTokens('前向后');
    tokens[1] = { index: 1, startMs: 100, endMs: 70100, gapAfterMs: 0, text: '向' };
    tokens[2] = { index: 2, startMs: 70100, endMs: 70200, gapAfterMs: 0, text: '后' };
    const result = segmentAlignedTranscript({
      assetId: 'timing-outlier',
      rawText: '前，向后。',
      tokens,
    });
    expect(result.alignedTokens[1]).toMatchObject({ startMs: 69780, endMs: 70100, text: '向' });
    expect(result.alignedTokens[0]?.gapAfterMs).toBe(69680);
    expect(result.segmentation.timingValidation).toMatchObject({
      status: 'repaired',
      originalMaxTokenDurationMs: 70000,
      repairedMaxTokenDurationMs: 320,
      normalizedGapCount: 1,
      repairs: [{
        index: 1,
        anchor: 'right',
        originalStartMs: 100,
        originalEndMs: 70100,
        repairedStartMs: 69780,
        repairedEndMs: 70100,
      }],
    });
  });

  it('keeps text and token coverage unchanged after timing repair', () => {
    const rawText = '但是下车以后，我们看见满天的星空。';
    const body = rawText.replace(/\p{P}/gu, '');
    const tokens = makeTokens(body);
    tokens[6] = {
      ...tokens[6]!,
      endMs: 10000,
      gapAfterMs: 0,
    };
    for (let index = 7; index < tokens.length; index += 1) {
      tokens[index] = {
        ...tokens[index]!,
        startMs: tokens[index]!.startMs + 9300,
        endMs: tokens[index]!.endMs + 9300,
      };
    }
    const result = segmentAlignedTranscript({ assetId: 'coverage', rawText, tokens });
    expect(result.alignedTokens.map(token => token.text).join('')).toBe(body);
    expect(result.segments.map(segment => segment.text).join('').replace(/\p{P}/gu, '')).toBe(body);
    expect(result.segmentation.policyVersion).toBe(CTRANSCRIPT_SEGMENTATION_POLICY_VERSION);
    expect(result.segmentation.attempts).toBe(0);
  });

  it('rejects overlapping aligned tokens', () => {
    expect(() => segmentAlignedTranscript({
      assetId: 'overlap',
      rawText: '重叠。',
      tokens: [
        { index: 0, startMs: 0, endMs: 200, gapAfterMs: 0, text: '重' },
        { index: 1, startMs: 180, endMs: 320, gapAfterMs: 0, text: '叠' },
      ],
    })).toThrow(/时间重叠/);
  });
});
