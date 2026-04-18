import { describe, expect, it } from 'vitest';
import type {
  IKtepAsset,
  IKtepClip,
  IKtepProject,
  IKtepScript,
  IKtepSlice,
} from '../../src/protocol/schema.js';
import { buildTimeline } from '../../src/modules/timeline-core/timeline-builder.js';
import {
  estimateNarrationBeatDurationMs,
  estimateNarrationDurationMs,
} from '../../src/modules/timeline-core/pacing.js';
import { planSubtitles } from '../../src/modules/timeline-core/subtitle.js';
import { createTestScript } from '../helpers/script-fixtures.js';

const CPROJECT: IKtepProject = {
  id: 'project-1',
  name: 'Speech Pacing Test',
  createdAt: '2026-04-02T00:00:00.000Z',
  updatedAt: '2026-04-02T00:00:00.000Z',
};

describe('speech-paced subtitles', () => {
  it('assigns more time to longer narration and punctuation pauses', () => {
    const shortDurationMs = estimateNarrationBeatDurationMs('出发。');
    const longDurationMs = estimateNarrationBeatDurationMs(
      '今天沿着海边慢慢往前走，我们还会停下来看看远处的灯塔。',
    );
    const plainDurationMs = estimateNarrationDurationMs('今天沿着海边慢慢往前走');
    const punctuatedDurationMs = estimateNarrationDurationMs('今天沿着海边慢慢往前走，停一下。');

    expect(longDurationMs).toBeGreaterThan(shortDurationMs);
    expect(punctuatedDurationMs).toBeGreaterThan(plainDurationMs);
  });

  it('creates voiced islands for explicit head, middle, and tail pauses', () => {
    const script: IKtepScript[] = createTestScript([{
      id: 'segment-1',
      role: 'scene',
      narration: '先看海。再看天。',
      linkedSliceIds: ['slice-drive'],
      beats: [{
        id: 'beat-1',
        text: '先看海。再看天。',
        utterances: [
          {
            text: '先看海。',
            pauseBeforeMs: 500,
            pauseAfterMs: 300,
          },
          {
            text: '再看天。',
            pauseBeforeMs: 200,
            pauseAfterMs: 700,
          },
        ],
        selections: [{
          assetId: 'asset-drive',
          sliceId: 'slice-drive',
          sourceInMs: 0,
          sourceOutMs: 5_000,
        }],
        linkedSliceIds: ['slice-drive'],
      }],
    }]);
    const slices: IKtepSlice[] = [{
      id: 'slice-drive',
      assetId: 'asset-drive',
      type: 'drive',
      sourceInMs: 0,
      sourceOutMs: 5_000,
      labels: [],
      placeHints: [],
    }];
    const clips: IKtepClip[] = [{
      id: 'clip-1',
      trackId: 'track-1',
      assetId: 'asset-drive',
      sliceId: 'slice-drive',
      sourceInMs: 0,
      sourceOutMs: 5_000,
      timelineInMs: 0,
      timelineOutMs: 5_000,
      linkedScriptSegmentId: 'segment-1',
      linkedScriptBeatId: 'beat-1',
    }];

    const subtitles = planSubtitles(script, clips, slices);

    expect(subtitles).toHaveLength(2);
    expect(subtitles[0]).toMatchObject({
      text: '先看海',
      startMs: 500,
    });
    expect(subtitles[1]).toMatchObject({
      text: '再看天',
    });
    expect(subtitles[0]!.endMs).toBeGreaterThan(subtitles[0]!.startMs);
    expect(subtitles[1]!.startMs - subtitles[0]!.endMs).toBe(500);
    expect(subtitles[1]!.endMs).toBeLessThan(clips[0]!.timelineOutMs);
    expect(clips[0]!.timelineOutMs - subtitles[1]!.endMs).toBeGreaterThanOrEqual(700);
  });

  it('never lets narration subtitles cross clip boundaries', () => {
    const script: IKtepScript[] = createTestScript([{
      id: 'segment-1',
      role: 'scene',
      narration: 'ignored',
      linkedSliceIds: ['slice-1', 'slice-2', 'slice-3'],
      beats: [{
        id: 'beat-1',
        text: '等米尔福德方向真的露出来',
        selections: [
          { assetId: 'asset-1', sliceId: 'slice-1', sourceInMs: 0, sourceOutMs: 1_000 },
          { assetId: 'asset-2', sliceId: 'slice-2', sourceInMs: 0, sourceOutMs: 1_000 },
          { assetId: 'asset-3', sliceId: 'slice-3', sourceInMs: 0, sourceOutMs: 5_000 },
        ],
        linkedSliceIds: ['slice-1', 'slice-2', 'slice-3'],
      }],
    }]);
    const slices: IKtepSlice[] = [
      {
        id: 'slice-1',
        assetId: 'asset-1',
        type: 'photo',
        sourceInMs: 0,
        sourceOutMs: 1_000,
        labels: [],
        placeHints: [],
      },
      {
        id: 'slice-2',
        assetId: 'asset-2',
        type: 'photo',
        sourceInMs: 0,
        sourceOutMs: 1_000,
        labels: [],
        placeHints: [],
      },
      {
        id: 'slice-3',
        assetId: 'asset-3',
        type: 'broll',
        sourceInMs: 0,
        sourceOutMs: 5_000,
        labels: [],
        placeHints: [],
      },
    ];
    const clips: IKtepClip[] = [
      {
        id: 'clip-1',
        trackId: 'track-1',
        assetId: 'asset-1',
        sliceId: 'slice-1',
        sourceInMs: 0,
        sourceOutMs: 1_000,
        timelineInMs: 0,
        timelineOutMs: 1_000,
        linkedScriptSegmentId: 'segment-1',
        linkedScriptBeatId: 'beat-1',
      },
      {
        id: 'clip-2',
        trackId: 'track-1',
        assetId: 'asset-2',
        sliceId: 'slice-2',
        sourceInMs: 0,
        sourceOutMs: 1_000,
        timelineInMs: 1_000,
        timelineOutMs: 2_000,
        linkedScriptSegmentId: 'segment-1',
        linkedScriptBeatId: 'beat-1',
      },
      {
        id: 'clip-3',
        trackId: 'track-1',
        assetId: 'asset-3',
        sliceId: 'slice-3',
        sourceInMs: 0,
        sourceOutMs: 5_000,
        timelineInMs: 2_000,
        timelineOutMs: 7_000,
        linkedScriptSegmentId: 'segment-1',
        linkedScriptBeatId: 'beat-1',
      },
    ];

    const subtitles = planSubtitles(script, clips, slices);
    const windows = clips.map(clip => ({ startMs: clip.timelineInMs, endMs: clip.timelineOutMs }));

    expect(subtitles.length).toBeGreaterThan(1);
    expect(subtitles.map(subtitle => subtitle.text).join('')).toBe('等米尔福德方向真的露出来');
    for (const subtitle of subtitles) {
      const touched = windows.filter(window => window.endMs > subtitle.startMs && window.startMs < subtitle.endMs);
      expect(touched).toHaveLength(1);
    }
  });

  it('keeps preserveNatSound beats on source transcript timing from dialogue clips', () => {
    const script: IKtepScript[] = createTestScript([{
      id: 'segment-1',
      role: 'scene',
      narration: 'ignored',
      linkedSliceIds: ['slice-talk'],
      beats: [{
        id: 'beat-1',
        text: '这句旁白不应该被用作字幕',
        actions: {
          preserveNatSound: true,
        },
        selections: [{
          assetId: 'asset-talk',
          sliceId: 'slice-talk',
          sourceInMs: 0,
          sourceOutMs: 1_200,
        }],
        linkedSliceIds: ['slice-talk'],
      }],
    }]);
    const slices: IKtepSlice[] = [{
      id: 'slice-talk',
      assetId: 'asset-talk',
      type: 'talking-head',
      sourceInMs: 0,
      sourceOutMs: 1_200,
      transcriptSegments: [{
        startMs: 0,
        endMs: 1_200,
        text: '这是现场原话',
      }],
      labels: [],
      placeHints: [],
    }];
    const clips: IKtepClip[] = [{
      id: 'clip-1',
      trackId: 'track-dialogue',
      assetId: 'asset-talk',
      sliceId: 'slice-talk',
      sourceInMs: 0,
      sourceOutMs: 1_200,
      timelineInMs: 0,
      timelineOutMs: 1_200,
      audioSource: 'embedded',
      linkedScriptSegmentId: 'segment-1',
      linkedScriptBeatId: 'beat-1',
    }];

    const subtitles = planSubtitles(script, clips, slices);

    expect(subtitles).toHaveLength(1);
    expect(subtitles[0]).toMatchObject({
      text: '这是现场原话',
      startMs: 0,
      endMs: 1_200,
      linkedScriptBeatId: 'beat-1',
    });
  });

  it('keeps preserveNatSound beats silent when source-speech transcript looks too noisy', () => {
    const script: IKtepScript[] = createTestScript([{
      id: 'segment-1',
      role: 'scene',
      narration: 'ignored',
      linkedSliceIds: ['slice-talk'],
      beats: [{
        id: 'beat-1',
        text: '先把今天要拍什么说清楚。',
        actions: {
          preserveNatSound: true,
        },
        selections: [{
          assetId: 'asset-talk',
          sliceId: 'slice-talk',
          sourceInMs: 0,
          sourceOutMs: 2_400,
        }],
        linkedSliceIds: ['slice-talk'],
      }],
    }]);
    const slices: IKtepSlice[] = [{
      id: 'slice-talk',
      assetId: 'asset-talk',
      type: 'talking-head',
      sourceInMs: 0,
      sourceOutMs: 2_400,
      transcriptSegments: [{
        startMs: 0,
        endMs: 2_400,
        text: '导航导航导航导航导航导航',
      }],
      labels: [],
      placeHints: [],
    }];
    const clips: IKtepClip[] = [{
      id: 'clip-1',
      trackId: 'track-dialogue',
      assetId: 'asset-talk',
      sliceId: 'slice-talk',
      sourceInMs: 0,
      sourceOutMs: 2_400,
      timelineInMs: 0,
      timelineOutMs: 2_400,
      audioSource: 'embedded',
      linkedScriptSegmentId: 'segment-1',
      linkedScriptBeatId: 'beat-1',
    }];

    const subtitles = planSubtitles(script, clips, slices, {
      maxCharsPerCue: 10,
    });

    expect(subtitles).toEqual([]);
  });

  it('keeps long but readable source-speech subtitles instead of silencing the whole beat', () => {
    const script: IKtepScript[] = createTestScript([{
      id: 'segment-1',
      role: 'scene',
      narration: 'ignored',
      linkedSliceIds: ['slice-drive'],
      beats: [{
        id: 'beat-1',
        text: 'ignored',
        actions: {
          preserveNatSound: true,
        },
        selections: [{
          assetId: 'asset-drive',
          sliceId: 'slice-drive',
          sourceInMs: 0,
          sourceOutMs: 4_800,
        }],
        linkedSliceIds: ['slice-drive'],
      }],
    }]);
    const readableText = '今天先从这个入口慢慢往里走等朋友到了以后我们再开始拍第一轮照片';
    const slices: IKtepSlice[] = [{
      id: 'slice-drive',
      assetId: 'asset-drive',
      type: 'drive',
      sourceInMs: 0,
      sourceOutMs: 4_800,
      transcriptSegments: [{
        startMs: 0,
        endMs: 4_800,
        text: readableText,
      }],
      labels: [],
      placeHints: [],
    }];
    const clips: IKtepClip[] = [{
      id: 'clip-1',
      trackId: 'track-dialogue',
      assetId: 'asset-drive',
      sliceId: 'slice-drive',
      sourceInMs: 0,
      sourceOutMs: 4_800,
      timelineInMs: 0,
      timelineOutMs: 4_800,
      audioSource: 'embedded',
      linkedScriptSegmentId: 'segment-1',
      linkedScriptBeatId: 'beat-1',
    }];

    const subtitles = planSubtitles(script, clips, slices, {
      maxCharsPerCue: 6,
    });

    expect(subtitles.length).toBeGreaterThan(4);
    expect(subtitles.map(subtitle => subtitle.text).join('')).toBe(readableText);
    expect(subtitles[0]?.startMs).toBe(0);
    expect(subtitles.at(-1)?.endMs).toBe(4_800);
  });

  it('weights split source-speech cues by cue length instead of evenly dividing the segment', () => {
    const script: IKtepScript[] = createTestScript([{
      id: 'segment-1',
      role: 'scene',
      narration: 'ignored',
      linkedSliceIds: ['slice-drive'],
      beats: [{
        id: 'beat-1',
        text: 'ignored',
        actions: {
          preserveNatSound: true,
        },
        selections: [{
          assetId: 'asset-drive',
          sliceId: 'slice-drive',
          sourceInMs: 0,
          sourceOutMs: 4_000,
        }],
        linkedSliceIds: ['slice-drive'],
      }],
    }]);
    const slices: IKtepSlice[] = [{
      id: 'slice-drive',
      assetId: 'asset-drive',
      type: 'drive',
      sourceInMs: 0,
      sourceOutMs: 4_000,
      transcriptSegments: [{
        startMs: 0,
        endMs: 4_000,
        text: '短句，后面这一句明显更长一些。',
      }],
      labels: [],
      placeHints: [],
    }];
    const clips: IKtepClip[] = [{
      id: 'clip-1',
      trackId: 'track-dialogue',
      assetId: 'asset-drive',
      sliceId: 'slice-drive',
      sourceInMs: 0,
      sourceOutMs: 4_000,
      timelineInMs: 0,
      timelineOutMs: 4_000,
      audioSource: 'embedded',
      linkedScriptSegmentId: 'segment-1',
      linkedScriptBeatId: 'beat-1',
    }];

    const subtitles = planSubtitles(script, clips, slices, {
      maxCharsPerCue: 8,
    });

    expect(subtitles).toHaveLength(2);
    expect(subtitles[0]).toMatchObject({
      text: '短句',
      startMs: 0,
    });
    expect(subtitles[1]).toMatchObject({
      text: '后面这一句明显更长一些',
      endMs: 4_000,
    });
    expect(subtitles[0]!.endMs - subtitles[0]!.startMs)
      .toBeLessThan(subtitles[1]!.endMs - subtitles[1]!.startMs);
  });

  it('keeps companion visuals but still subtitles only from the audio anchor', () => {
    const assets: IKtepAsset[] = [
      {
        id: 'asset-cutaway',
        kind: 'video',
        sourcePath: 'cutaway.mp4',
        displayName: 'cutaway.mp4',
      },
      {
        id: 'asset-talk',
        kind: 'video',
        sourcePath: 'talk.mp4',
        displayName: 'talk.mp4',
      },
    ];
    const slices: IKtepSlice[] = [
      {
        id: 'slice-cutaway',
        assetId: 'asset-cutaway',
        type: 'broll',
        sourceInMs: 0,
        sourceOutMs: 4_000,
        labels: [],
        placeHints: [],
      },
      {
        id: 'slice-talk',
        assetId: 'asset-talk',
        type: 'talking-head',
        sourceInMs: 0,
        sourceOutMs: 1_200,
        transcriptSegments: [{
          startMs: 0,
          endMs: 1_200,
          text: '这是现场原话',
        }],
        labels: [],
        placeHints: [],
      },
    ];
    const script: IKtepScript[] = createTestScript([{
      id: 'segment-1',
      role: 'scene',
      narration: 'ignored',
      targetDurationMs: 5_200,
      linkedSliceIds: ['slice-cutaway', 'slice-talk'],
      beats: [{
        id: 'beat-1',
        text: '这是现场原话',
        targetDurationMs: 5_200,
        actions: {
          preserveNatSound: true,
        },
        audioSelections: [{
          assetId: 'asset-talk',
          sliceId: 'slice-talk',
          sourceInMs: 0,
          sourceOutMs: 1_200,
        }],
        visualSelections: [
          {
            assetId: 'asset-cutaway',
            sliceId: 'slice-cutaway',
            sourceInMs: 0,
            sourceOutMs: 4_000,
          },
          {
            assetId: 'asset-talk',
            sliceId: 'slice-talk',
            sourceInMs: 0,
            sourceOutMs: 1_200,
          },
        ],
        linkedSliceIds: ['slice-cutaway', 'slice-talk'],
      }],
    }]);

    const doc = buildTimeline(CPROJECT, assets, slices, script);
    const beat = doc.script?.[0]?.beats[0];

    expect(beat?.audioSelections).toEqual([{
      assetId: 'asset-talk',
      sliceId: 'slice-talk',
      sourceInMs: 0,
      sourceOutMs: 1_200,
    }]);
    expect(beat?.visualSelections).toEqual([
      {
        assetId: 'asset-cutaway',
        sliceId: 'slice-cutaway',
        sourceInMs: 0,
        sourceOutMs: 4_000,
      },
      {
        assetId: 'asset-talk',
        sliceId: 'slice-talk',
        sourceInMs: 0,
        sourceOutMs: 1_200,
      },
    ]);
    expect(doc.timeline.clips).toHaveLength(3);
    expect(doc.timeline.clips.filter(clip => clip.audioSource == null)).toHaveLength(2);
    expect(doc.timeline.clips.filter(clip => clip.audioSource != null)).toHaveLength(1);
    expect(doc.subtitles).toHaveLength(1);
    expect(doc.subtitles?.[0]).toMatchObject({
      text: '这是现场原话',
      startMs: 0,
      endMs: 1_200,
    });
  });

  it('skips subtitles entirely for photo-only beats', () => {
    const script: IKtepScript[] = createTestScript([{
      id: 'segment-1',
      role: 'scene',
      narration: 'ignored',
      linkedSliceIds: ['slice-photo'],
      beats: [{
        id: 'beat-1',
        text: '这张照片只是静默停留。',
        selections: [{
          assetId: 'asset-photo',
          sliceId: 'slice-photo',
        }],
        linkedSliceIds: ['slice-photo'],
      }],
    }]);
    const slices: IKtepSlice[] = [{
      id: 'slice-photo',
      assetId: 'asset-photo',
      type: 'photo',
      labels: [],
      placeHints: [],
    }];
    const clips: IKtepClip[] = [{
      id: 'clip-1',
      trackId: 'track-1',
      assetId: 'asset-photo',
      sliceId: 'slice-photo',
      timelineInMs: 0,
      timelineOutMs: 1_000,
      linkedScriptSegmentId: 'segment-1',
      linkedScriptBeatId: 'beat-1',
    }];

    const subtitles = planSubtitles(script, clips, slices);

    expect(subtitles).toEqual([]);
  });
});
