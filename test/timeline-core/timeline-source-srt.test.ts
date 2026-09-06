import { describe, expect, it } from 'vitest';
import { formatSrt } from '../../src/modules/nle/export-srt.js';
import { buildTimelineSourceSpeechSubtitles } from '../../src/modules/timeline-core/project-timeline.js';
import { estimateTranscriptTextUnits } from '../../src/modules/media/refined-transcript.js';
import type { IKtepClip, IKtepSpan } from '../../src/protocol/schema.js';

describe('timeline source-speech SRT generation', () => {
  it('maps audible transcript segments from source time into timeline time', () => {
    const subtitles = buildTimelineSourceSpeechSubtitles({
      clips: [{
        id: 'clip-1',
        trackId: 'v1',
        assetId: 'asset-talk',
        spanId: 'span-talk',
        sourceInMs: 1000,
        sourceOutMs: 4000,
        timelineInMs: 10000,
        timelineOutMs: 13000,
        audioGainDb: 0,
        linkedScriptSegmentId: 'fw-1',
        linkedScriptBeatId: 'slot-1',
      }],
      spans: [createSpeechSpan({
        id: 'span-talk',
        transcriptSegments: [
          { startMs: 900, endMs: 1500, text: ' 出发 ' },
          { startMs: 2200, endMs: 3200, text: '看见雪山' },
        ],
      })],
      language: 'zh',
    });

    expect(subtitles).toEqual([{
      id: 'subtitle-source-speech-00001',
      startMs: 10000,
      endMs: 12200,
      text: '出发看见雪山',
      language: 'zh',
      linkedScriptSegmentId: 'fw-1',
      linkedScriptBeatId: 'slot-1',
    }]);
    expect(formatSrt(subtitles.slice(0, 1))).toContain('00:00:10,000 --> 00:00:12,200');
  });

  it('formats SRT without terminal periods while preserving question and exclamation marks', () => {
    const srt = formatSrt([
      { id: 'a', startMs: 0, endMs: 1000, text: '这里停一下。', language: 'zh' },
      { id: 'b', startMs: 1000, endMs: 2000, text: '真的要走吗？', language: 'zh' },
      { id: 'c', startMs: 2000, endMs: 3000, text: '继续出发！', language: 'zh' },
      { id: 'd', startMs: 3000, endMs: 4000, text: '他说“过了这个弯。”', language: 'zh' },
      { id: 'e', startMs: 4000, endMs: 5000, text: 'Version 2.0 is ready.', language: 'en' },
    ]);

    expect(srt).toContain('这里停一下\n');
    expect(srt).toContain('真的要走吗？\n');
    expect(srt).toContain('继续出发！\n');
    expect(srt).toContain('他说“过了这个弯”\n');
    expect(srt).toContain('Version 2.0 is ready\n');
    expect(formatSrt([
      { id: 'period', startMs: 0, endMs: 1000, text: '边界句号。', language: 'zh' },
    ], { preserveTerminalPeriods: true })).toContain('边界句号。\n');
  });

  it('skips muted speech clips and falls back to transcript only without timed segments', () => {
    const clips: IKtepClip[] = [
      {
        id: 'clip-muted',
        trackId: 'v1',
        assetId: 'asset-muted',
        spanId: 'span-muted',
        sourceInMs: 0,
        sourceOutMs: 1000,
        timelineInMs: 0,
        timelineOutMs: 1000,
        muteAudio: true,
      },
      {
        id: 'clip-fallback',
        trackId: 'v1',
        assetId: 'asset-fallback',
        spanId: 'span-fallback',
        sourceInMs: 0,
        sourceOutMs: 2000,
        timelineInMs: 2000,
        timelineOutMs: 4000,
        audioGainDb: 0,
      },
    ];

    const subtitles = buildTimelineSourceSpeechSubtitles({
      clips,
      spans: [
        createSpeechSpan({ id: 'span-muted', transcript: '这句被静音。' }),
        createSpeechSpan({ id: 'span-fallback', transcript: '没有分段时使用整段口播。' }),
      ],
    });

    expect(subtitles).toEqual([{
      id: 'subtitle-source-speech-00001',
      startMs: 2000,
      endMs: 4000,
      text: '没有分段时使用整段口播。',
      language: undefined,
      linkedScriptSegmentId: undefined,
      linkedScriptBeatId: undefined,
    }]);
  });

  it('splits an oversized upstream transcript segment at balanced commas under the 36-unit cap', () => {
    const subtitles = buildTimelineSourceSpeechSubtitles({
      clips: [{
        id: 'clip-long',
        trackId: 'v1',
        assetId: 'asset-long',
        spanId: 'span-long',
        sourceInMs: 0,
        sourceOutMs: 5000,
        timelineInMs: 10000,
        timelineOutMs: 15000,
        audioGainDb: 0,
      }],
      spans: [createSpeechSpan({
        id: 'span-long',
        transcriptSegments: [{
          startMs: 0,
          endMs: 4000,
          text: '大家好，我是瞬光，今天是八月十九号，明天就是我生日了，所以前两天假紧急的从深圳开到一个山顶去看生日的第一次银河和日出，希望一切顺利。',
        }],
      })],
    });

    expect(subtitles.map(cue => cue.text)).toEqual([
      '大家好，我是瞬光，今天是八月十九号，明天就是我生日了。',
      '所以前两天假紧急的从深圳开到一个山顶去看生日的第一次银河和日出。',
      '希望一切顺利。',
    ]);
    expect(subtitles[0]?.startMs).toBe(10000);
    expect(subtitles.at(-1)?.endMs).toBe(14000);
    expect(subtitles.every(cue => estimateTranscriptTextUnits(cue.text) <= 36)).toBe(true);
    for (let index = 1; index < subtitles.length; index += 1) {
      expect(subtitles[index]?.startMs).toBe(subtitles[index - 1]?.endMs);
    }
  });

  it('merges nearby comma-ended transcript segments and promotes the remaining boundary comma', () => {
    const subtitles = buildTimelineSourceSpeechSubtitles({
      clips: [{
        id: 'clip-merge',
        trackId: 'v1',
        assetId: 'asset-merge',
        spanId: 'span-merge',
        sourceInMs: 0,
        sourceOutMs: 5000,
        timelineInMs: 0,
        timelineOutMs: 5000,
        audioGainDb: 0,
      }],
      spans: [createSpeechSpan({
        id: 'span-merge',
        transcriptSegments: [
          { startMs: 0, endMs: 800, text: '大家好，我是瞬光，' },
          { startMs: 1000, endMs: 2000, text: '今天是八月十九号，' },
          { startMs: 2080, endMs: 3500, text: '明天就是我的三十三岁生日，' },
          { startMs: 3900, endMs: 5000, text: '所以现在赶紧从深圳出发。' },
        ],
      })],
    });

    expect(subtitles).toHaveLength(2);
    expect(subtitles[0]).toMatchObject({
      startMs: 0,
      endMs: 3500,
      text: '大家好，我是瞬光，今天是八月十九号，明天就是我的三十三岁生日。',
    });
    expect(subtitles[1]).toMatchObject({
      startMs: 3900,
      endMs: 5000,
      text: '所以现在赶紧从深圳出发。',
    });
  });
});

function createSpeechSpan(input: {
  id: string;
  transcript?: string;
  transcriptSegments?: IKtepSpan['transcriptSegments'];
}): IKtepSpan {
  return {
    id: input.id,
    assetId: input.id.replace('span', 'asset'),
    type: 'talking-head',
    semanticKind: 'speech',
    sourceInMs: 0,
    sourceOutMs: 5000,
    transcript: input.transcript,
    transcriptSegments: input.transcriptSegments,
    materialPatterns: ['车内口播', '道路', '晴天', '有口播语音'],
  };
}
