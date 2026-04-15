import { describe, expect, it } from 'vitest';
import {
  buildTranscriptText,
  estimateTranscriptTextUnits,
  refineAsrSegments,
} from '../../src/modules/media/refined-transcript.js';

describe('refined transcript segmentation', () => {
  it('splits continuous Chinese speech on pauses', () => {
    const segments = refineAsrSegments({
      words: [
        { start: 0.0, end: 0.16, text: '今天' },
        { start: 0.17, end: 0.34, text: '我们' },
        { start: 0.35, end: 0.58, text: '出发' },
        { start: 0.95, end: 1.18, text: '先去' },
        { start: 1.2, end: 1.46, text: '码头' },
      ],
    });

    expect(segments.map(segment => segment.text)).toEqual([
      '今天我们出发',
      '先去码头',
    ]);
  });

  it('estimates mixed CJK latin numeric units conservatively', () => {
    expect(estimateTranscriptTextUnits('到 Queenstown 2026')).toBe(3);
    expect(estimateTranscriptTextUnits('今天去 Lake Hayes')).toBe(5);
  });

  it('suppresses short repeated hallucinations without dropping normal repeated phrases', () => {
    const hallucinatedText = buildTranscriptText({
      words: [
        { start: 0.0, end: 0.08, text: '导航' },
        { start: 0.09, end: 0.16, text: '导航' },
        { start: 0.17, end: 0.24, text: '导航' },
        { start: 0.25, end: 0.32, text: '导航' },
        { start: 0.33, end: 0.4, text: '导航' },
      ],
    });
    expect(hallucinatedText).toBe('导航导航');

    const keptSegments = refineAsrSegments({
      words: [
        { start: 0.0, end: 0.3, text: '再来一次' },
        { start: 0.42, end: 0.76, text: '再来一次' },
      ],
    });
    expect(keptSegments.map(segment => segment.text)).toEqual(['再来一次再来一次']);
  });
});
