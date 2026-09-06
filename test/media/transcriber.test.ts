import { describe, expect, it, vi } from 'vitest';
import { transcribe } from '../../src/modules/media/transcriber.js';

describe('transcribe', () => {
  it('passes zh to ASR and normalizes Han text to simplified Chinese', async () => {
    const asrDetailed = vi.fn(async () => ({
      rawText: '體驗一下A7',
      segments: [{
        start: 0,
        end: 1,
        text: '體驗一下',
      }],
      words: [
        { start: 0, end: 0.4, text: '體驗' },
        { start: 0.41, end: 0.7, text: '一下' },
        { start: 0.71, end: 1, text: 'A7' },
      ],
    }));

    const result = await transcribe(
      { asrDetailed } as any,
      'H:/audio.wav',
      'zh',
    );

    expect(asrDetailed).toHaveBeenCalledWith('H:/audio.wav', 'zh', undefined);
    expect(result.segments).toEqual([]);
    expect(result.words?.map(word => word.text)).toEqual(['体验', '一下', 'A7']);
    expect(result.fullText).toBe('体验一下A7');
    expect(result.alignedTokens).toEqual([
      { index: 0, startMs: 0, endMs: 200, gapAfterMs: 0, text: '体' },
      { index: 1, startMs: 200, endMs: 400, gapAfterMs: 10, text: '验' },
      { index: 2, startMs: 410, endMs: 555, gapAfterMs: 0, text: '一' },
      { index: 3, startMs: 555, endMs: 700, gapAfterMs: 10, text: '下' },
      { index: 4, startMs: 710, endMs: 855, gapAfterMs: 0, text: 'A' },
      { index: 5, startMs: 855, endMs: 1000, gapAfterMs: 0, text: '7' },
    ]);
  });

  it('expands zero-duration Latin aligner tokens into character tokens without inventing time', async () => {
    const asrDetailed = vi.fn(async () => ({
      rawText: 'Good好',
      segments: [],
      words: [
        { start: 1, end: 1, text: 'Good' },
        { start: 1.2, end: 1.4, text: '好' },
      ],
    }));

    const result = await transcribe({ asrDetailed } as any, 'H:/audio.wav', 'zh');
    expect(result.alignedTokens).toEqual([
      { index: 0, startMs: 1000, endMs: 1000, gapAfterMs: 0, text: 'G' },
      { index: 1, startMs: 1000, endMs: 1000, gapAfterMs: 0, text: 'o' },
      { index: 2, startMs: 1000, endMs: 1000, gapAfterMs: 0, text: 'o' },
      { index: 3, startMs: 1000, endMs: 1000, gapAfterMs: 200, text: 'd' },
      { index: 4, startMs: 1200, endMs: 1400, gapAfterMs: 0, text: '好' },
    ]);
  });

  it('preserves zero-duration aligned characters when the full alignment is usable', async () => {
    const asrDetailed = vi.fn(async () => ({
      rawText: '星空',
      segments: [],
      words: [
        { start: 0, end: 0.2, text: '星' },
        { start: 0.2, end: 0.2, text: '空' },
      ],
    }));

    const result = await transcribe({ asrDetailed } as any, 'H:/audio.wav', 'zh');
    expect(result.alignedTokens).toEqual([
      { index: 0, startMs: 0, endMs: 200, gapAfterMs: 0, text: '星' },
      { index: 1, startMs: 200, endMs: 200, gapAfterMs: 0, text: '空' },
    ]);
  });

  it('rejects partial ForcedAligner character coverage', async () => {
    const asrDetailed = vi.fn(async () => ({
      rawText: '满天星空',
      segments: [],
      words: [
        { start: 0, end: 0.2, text: '满' },
        { start: 0.2, end: 0.4, text: '天' },
      ],
    }));

    await expect(transcribe({ asrDetailed } as any, 'H:/audio.wav', 'zh'))
      .rejects.toThrow(/字符覆盖不完整/);
  });

  it('applies contextual simplified conversion consistently to raw text and tokens', async () => {
    const asrDetailed = vi.fn(async () => ({
      rawText: '智慧巡航已激活',
      segments: [],
      words: Array.from('智慧巡航已激活').map((text, index) => ({
        start: index * 0.1,
        end: (index + 1) * 0.1,
        text,
      })),
    }));

    const result = await transcribe({ asrDetailed } as any, 'H:/audio.wav', 'zh');
    expect(result.alignedTokens.map(token => token.text).join('')).toBe(
      result.fullText.replace(/[\s\p{P}]+/gu, ''),
    );
  });

  it('normalizes adjacent ForcedAligner overlaps to one shared midpoint boundary', async () => {
    const asrDetailed = vi.fn(async () => ({
      rawText: '长路',
      segments: [],
      words: [
        { start: 1, end: 1.3, text: '长' },
        { start: 1.2, end: 1.5, text: '路' },
      ],
    }));

    const result = await transcribe({ asrDetailed } as any, 'H:/audio.wav', 'zh');
    expect(result.alignedTokens).toEqual([
      { index: 0, startMs: 1000, endMs: 1250, gapAfterMs: 0, text: '长' },
      { index: 1, startMs: 1250, endMs: 1500, gapAfterMs: 0, text: '路' },
    ]);
  });
});
