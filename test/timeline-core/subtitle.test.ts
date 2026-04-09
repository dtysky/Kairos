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
    const script: IKtepScript[] = [{
      id: 'segment-1',
      role: 'scene',
      narration: '先看海。再看天。',
      linkedSliceIds: ['slice-drive'],
      beats: [
        {
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
            sourceOutMs: 5000,
          }],
          linkedSliceIds: ['slice-drive'],
        },
      ],
    }];
    const slices: IKtepSlice[] = [
      {
        id: 'slice-drive',
        assetId: 'asset-drive',
        type: 'drive',
        sourceInMs: 0,
        sourceOutMs: 5000,
        labels: [],
        placeHints: [],
      },
    ];
    const clips: IKtepClip[] = [
      {
        id: 'clip-1',
        trackId: 'track-1',
        assetId: 'asset-drive',
        sliceId: 'slice-drive',
        sourceInMs: 0,
        sourceOutMs: 5000,
        timelineInMs: 0,
        timelineOutMs: 5000,
        linkedScriptSegmentId: 'segment-1',
        linkedScriptBeatId: 'beat-1',
      },
    ];

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
    const script: IKtepScript[] = [{
      id: 'segment-1',
      role: 'scene',
      narration: 'ignored',
      linkedSliceIds: ['slice-1', 'slice-2', 'slice-3'],
      beats: [
        {
          id: 'beat-1',
          text: '等米尔福德方向真的露出来',
          selections: [
            { assetId: 'asset-1', sliceId: 'slice-1', sourceInMs: 0, sourceOutMs: 1000 },
            { assetId: 'asset-2', sliceId: 'slice-2', sourceInMs: 0, sourceOutMs: 1000 },
            { assetId: 'asset-3', sliceId: 'slice-3', sourceInMs: 0, sourceOutMs: 5000 },
          ],
          linkedSliceIds: ['slice-1', 'slice-2', 'slice-3'],
        },
      ],
    }];
    const slices: IKtepSlice[] = [
      {
        id: 'slice-1',
        assetId: 'asset-1',
        type: 'photo',
        sourceInMs: 0,
        sourceOutMs: 1000,
        labels: [],
        placeHints: [],
      },
      {
        id: 'slice-2',
        assetId: 'asset-2',
        type: 'photo',
        sourceInMs: 0,
        sourceOutMs: 1000,
        labels: [],
        placeHints: [],
      },
      {
        id: 'slice-3',
        assetId: 'asset-3',
        type: 'broll',
        sourceInMs: 0,
        sourceOutMs: 5000,
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
        sourceOutMs: 1000,
        timelineInMs: 0,
        timelineOutMs: 1000,
        linkedScriptSegmentId: 'segment-1',
        linkedScriptBeatId: 'beat-1',
      },
      {
        id: 'clip-2',
        trackId: 'track-1',
        assetId: 'asset-2',
        sliceId: 'slice-2',
        sourceInMs: 0,
        sourceOutMs: 1000,
        timelineInMs: 1000,
        timelineOutMs: 2000,
        linkedScriptSegmentId: 'segment-1',
        linkedScriptBeatId: 'beat-1',
      },
      {
        id: 'clip-3',
        trackId: 'track-1',
        assetId: 'asset-3',
        sliceId: 'slice-3',
        sourceInMs: 0,
        sourceOutMs: 5000,
        timelineInMs: 2000,
        timelineOutMs: 7000,
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

  it('keeps preserveNatSound beats on source transcript timing', () => {
    const script: IKtepScript[] = [{
      id: 'segment-1',
      role: 'scene',
      narration: 'ignored',
      linkedSliceIds: ['slice-talk'],
      beats: [
        {
          id: 'beat-1',
          text: '这句旁白不应该被用作字幕',
          actions: {
            preserveNatSound: true,
          },
          selections: [{
            assetId: 'asset-talk',
            sliceId: 'slice-talk',
            sourceInMs: 0,
            sourceOutMs: 1200,
          }],
          linkedSliceIds: ['slice-talk'],
        },
      ],
    }];
    const slices: IKtepSlice[] = [
      {
        id: 'slice-talk',
        assetId: 'asset-talk',
        type: 'talking-head',
        sourceInMs: 0,
        sourceOutMs: 1200,
        transcriptSegments: [
          {
            startMs: 0,
            endMs: 1200,
            text: '这是现场原话',
          },
        ],
        labels: [],
        placeHints: [],
      },
    ];
    const clips: IKtepClip[] = [
      {
        id: 'clip-1',
        trackId: 'track-1',
        assetId: 'asset-talk',
        sliceId: 'slice-talk',
        sourceInMs: 0,
        sourceOutMs: 1200,
        timelineInMs: 0,
        timelineOutMs: 1200,
        linkedScriptSegmentId: 'segment-1',
        linkedScriptBeatId: 'beat-1',
      },
    ];

    const subtitles = planSubtitles(script, clips, slices);

    expect(subtitles).toHaveLength(1);
    expect(subtitles[0]).toMatchObject({
      text: '这是现场原话',
      startMs: 0,
      endMs: 1200,
      linkedScriptBeatId: 'beat-1',
    });
  });

  it('expands preserveNatSound beats to a full spoken sentence before placement and subtitles', () => {
    const assets: IKtepAsset[] = [
      {
        id: 'asset-talk',
        kind: 'video',
        sourcePath: 'talk.mp4',
        displayName: 'talk.mp4',
      },
    ];
    const slices: IKtepSlice[] = [
      {
        id: 'slice-talk',
        assetId: 'asset-talk',
        type: 'talking-head',
        sourceInMs: 0,
        sourceOutMs: 3_000,
        transcriptSegments: [
          {
            startMs: 0,
            endMs: 1_800,
            text: '这是完整的一句话。',
          },
        ],
        labels: [],
        placeHints: [],
      },
    ];
    const script: IKtepScript[] = [{
      id: 'segment-1',
      role: 'scene',
      narration: 'ignored',
      targetDurationMs: 600,
      linkedSliceIds: ['slice-talk'],
      beats: [
        {
          id: 'beat-1',
          text: '这是完整的一句话。',
          targetDurationMs: 600,
          actions: {
            preserveNatSound: true,
          },
          selections: [{
            assetId: 'asset-talk',
            sliceId: 'slice-talk',
            sourceInMs: 300,
            sourceOutMs: 900,
          }],
          linkedSliceIds: ['slice-talk'],
        },
      ],
    }];

    const doc = buildTimeline(CPROJECT, assets, slices, script);

    expect(doc.script?.[0]?.beats[0]).toMatchObject({
      targetDurationMs: 1800,
      selections: [{
        assetId: 'asset-talk',
        sliceId: 'slice-talk',
        sourceInMs: 0,
        sourceOutMs: 1800,
      }],
    });
    expect(doc.timeline.clips[0]).toMatchObject({
      assetId: 'asset-talk',
      sourceInMs: 0,
      sourceOutMs: 1800,
      timelineInMs: 0,
      timelineOutMs: 1800,
    });
    expect(doc.subtitles).toHaveLength(1);
    expect(doc.subtitles?.[0]).toMatchObject({
      text: '这是完整的一句话',
      startMs: 0,
      endMs: 1800,
    });
  });

  it('filters non-transcript cutaways out of preserveNatSound beats before subtitle planning', () => {
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
        sourceOutMs: 4000,
        labels: [],
        placeHints: [],
      },
      {
        id: 'slice-talk',
        assetId: 'asset-talk',
        type: 'talking-head',
        sourceInMs: 0,
        sourceOutMs: 1200,
        transcriptSegments: [
          {
            startMs: 0,
            endMs: 1200,
            text: '这是现场原话',
          },
        ],
        labels: [],
        placeHints: [],
      },
    ];
    const script: IKtepScript[] = [{
      id: 'segment-1',
      role: 'scene',
      narration: 'ignored',
      targetDurationMs: 5200,
      linkedSliceIds: ['slice-cutaway', 'slice-talk'],
      beats: [
        {
          id: 'beat-1',
          text: '这是现场原话',
          targetDurationMs: 5200,
          actions: {
            preserveNatSound: true,
          },
          selections: [
            {
              assetId: 'asset-cutaway',
              sliceId: 'slice-cutaway',
              sourceInMs: 0,
              sourceOutMs: 4000,
            },
            {
              assetId: 'asset-talk',
              sliceId: 'slice-talk',
              sourceInMs: 0,
              sourceOutMs: 1200,
            },
          ],
          linkedSliceIds: ['slice-cutaway', 'slice-talk'],
        },
      ],
    }];

    const doc = buildTimeline(CPROJECT, assets, slices, script);

    expect(doc.script?.[0]?.beats[0]).toMatchObject({
      targetDurationMs: 1200,
      selections: [{
        assetId: 'asset-talk',
        sliceId: 'slice-talk',
        sourceInMs: 0,
        sourceOutMs: 1200,
      }],
    });
    expect(doc.timeline.clips).toHaveLength(1);
    expect(doc.timeline.clips[0]).toMatchObject({
      assetId: 'asset-talk',
      sourceInMs: 0,
      sourceOutMs: 1200,
      timelineInMs: 0,
      timelineOutMs: 1200,
    });
    expect(doc.subtitles).toHaveLength(1);
    expect(doc.subtitles?.[0]).toMatchObject({
      text: '这是现场原话',
      startMs: 0,
      endMs: 1200,
    });
  });

  it('expands narration beats when the estimated speech exceeds the source window', () => {
    const assets: IKtepAsset[] = [
      {
        id: 'asset-drive',
        kind: 'video',
        sourcePath: 'drive.mp4',
        displayName: 'drive.mp4',
      },
    ];
    const slices: IKtepSlice[] = [
      {
        id: 'slice-drive',
        assetId: 'asset-drive',
        type: 'drive',
        sourceInMs: 0,
        sourceOutMs: 1000,
        labels: [],
        placeHints: [],
      },
    ];
    const script: IKtepScript[] = [{
      id: 'segment-1',
      role: 'scene',
      narration: '旁白',
      targetDurationMs: 1000,
      linkedSliceIds: ['slice-drive'],
      beats: [
        {
          id: 'beat-1',
          text: '今天沿着海边慢慢往前走，我们还要把整段旁白说完整。',
          targetDurationMs: 1000,
          actions: {
            muteSource: true,
          },
          selections: [{
            assetId: 'asset-drive',
            sliceId: 'slice-drive',
            sourceInMs: 0,
            sourceOutMs: 1000,
          }],
          linkedSliceIds: ['slice-drive'],
        },
      ],
    }];

    const doc = buildTimeline(CPROJECT, assets, slices, script, {
      subtitle: {
        maxCharsPerCue: 12,
      },
    });

    expect(doc.script).toBeDefined();
    expect(doc.script?.[0]?.beats[0]?.targetDurationMs).toBeGreaterThan(1000);
    expect(doc.script?.[0]?.targetDurationMs).toBeGreaterThan(1000);
    expect(doc.timeline.clips).toHaveLength(1);
    expect(doc.timeline.clips[0]).toMatchObject({
      sourceInMs: 0,
      sourceOutMs: 1000,
      timelineInMs: 0,
    });
    expect(doc.timeline.clips[0]!.timelineOutMs - doc.timeline.clips[0]!.timelineInMs)
      .toBe(doc.script?.[0]?.beats[0]?.targetDurationMs);
    expect(doc.subtitles?.[0]?.startMs).toBe(0);
    expect(doc.subtitles?.at(-1)?.endMs).toBeLessThanOrEqual(doc.timeline.clips[0]!.timelineOutMs);
  });
});
