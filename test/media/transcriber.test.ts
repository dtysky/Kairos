import { describe, expect, it, vi } from 'vitest';
import { transcribe } from '../../src/modules/media/transcriber.js';

describe('transcribe', () => {
  it('passes zh to ASR and normalizes Han text to simplified Chinese', async () => {
    const asrDetailed = vi.fn(async () => ({
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
    expect(result.segments[0]?.text).toBe('体验一下A7');
    expect(result.words?.map(word => word.text)).toEqual(['体验', '一下', 'A7']);
    expect(result.fullText).toContain('体验');
    expect(result.fullText).toContain('A7');
  });
});
