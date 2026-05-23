import { describe, expect, it } from 'vitest';
import { formatSrt } from '../../src/modules/nle/export-srt.js';
import { buildTimelineSourceSpeechSubtitles } from '../../src/modules/timeline-core/project-timeline.js';
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

    expect(subtitles).toEqual([
      {
        id: 'subtitle-source-speech-00001',
        startMs: 10000,
        endMs: 10500,
        text: '出发',
        language: 'zh',
        linkedScriptSegmentId: 'fw-1',
        linkedScriptBeatId: 'slot-1',
      },
      {
        id: 'subtitle-source-speech-00002',
        startMs: 11200,
        endMs: 12200,
        text: '看见雪山',
        language: 'zh',
        linkedScriptSegmentId: 'fw-1',
        linkedScriptBeatId: 'slot-1',
      },
    ]);
    expect(formatSrt(subtitles.slice(0, 1))).toContain('00:00:10,000 --> 00:00:10,500');
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
