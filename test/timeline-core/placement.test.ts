import { describe, expect, it } from 'vitest';
import type { IKtepAsset, IKtepScript, IKtepSlice } from '../../src/protocol/schema.js';
import { placeClips } from '../../src/modules/timeline-core/placement.js';

describe('placeClips', () => {
  it('keeps serial video selections on a single primary track', () => {
    const assets: IKtepAsset[] = [
      {
        id: 'asset-broll',
        kind: 'video',
        sourcePath: 'broll.mp4',
        displayName: 'broll.mp4',
      },
      {
        id: 'asset-drive',
        kind: 'video',
        sourcePath: 'drive.mp4',
        displayName: 'drive.mp4',
      },
    ];
    const slices: IKtepSlice[] = [
      {
        id: 'slice-broll',
        assetId: 'asset-broll',
        type: 'broll',
        sourceInMs: 0,
        sourceOutMs: 4000,
        labels: [],
        placeHints: [],
      },
      {
        id: 'slice-drive',
        assetId: 'asset-drive',
        type: 'drive',
        sourceInMs: 1000,
        sourceOutMs: 5000,
        labels: [],
        placeHints: [],
      },
    ];
    const script: IKtepScript[] = [{
      id: 'segment-1',
      role: 'intro',
      narration: 'test',
      targetDurationMs: 8000,
      linkedSliceIds: ['slice-broll', 'slice-drive'],
      beats: [
        {
          id: 'beat-1',
          text: 'opening',
          targetDurationMs: 4000,
          selections: [{
            assetId: 'asset-broll',
            sliceId: 'slice-broll',
            sourceInMs: 0,
            sourceOutMs: 4000,
          }],
          linkedSliceIds: ['slice-broll'],
        },
        {
          id: 'beat-2',
          text: 'follow',
          targetDurationMs: 4000,
          selections: [{
            assetId: 'asset-drive',
            sliceId: 'slice-drive',
            sourceInMs: 1000,
            sourceOutMs: 5000,
          }],
          linkedSliceIds: ['slice-drive'],
        },
      ],
    }];

    const { tracks, clips } = placeClips(script, slices, assets);

    expect(tracks).toHaveLength(1);
    expect(tracks[0]).toMatchObject({
      kind: 'video',
      role: 'primary',
      index: 0,
    });
    expect(clips).toHaveLength(2);
    expect(new Set(clips.map(clip => clip.trackId))).toEqual(new Set([tracks[0]!.id]));
    expect(clips.map(clip => [clip.timelineInMs, clip.timelineOutMs])).toEqual([
      [0, 4000],
      [4000, 8000],
    ]);
  });

  it('keeps legacy stretching when no edit bounds are available', () => {
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
        sourceInMs: 2000,
        sourceOutMs: 3000,
        labels: [],
        placeHints: [],
      },
    ];
    const script: IKtepScript[] = [{
      id: 'segment-1',
      role: 'scene',
      narration: 'test',
      targetDurationMs: 4800,
      linkedSliceIds: ['slice-drive'],
      beats: [
        {
          id: 'beat-1',
          text: '这是一段更长的旁白，需要比素材窗口更久。',
          targetDurationMs: 4800,
          actions: {
            muteSource: true,
          },
          selections: [{
            assetId: 'asset-drive',
            sliceId: 'slice-drive',
            sourceInMs: 2000,
            sourceOutMs: 3000,
          }],
          linkedSliceIds: ['slice-drive'],
        },
      ],
    }];

    const { clips } = placeClips(script, slices, assets);

    expect(clips).toHaveLength(1);
    expect(clips[0]).toMatchObject({
      sourceInMs: 2000,
      sourceOutMs: 3000,
      timelineInMs: 0,
      timelineOutMs: 4800,
    });
  });

  it('prefers edit-friendly slice bounds before stretching to the beat budget', () => {
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
        sourceInMs: 2000,
        sourceOutMs: 3000,
        editSourceInMs: 0,
        editSourceOutMs: 6000,
        labels: [],
        placeHints: [],
      },
    ];
    const script: IKtepScript[] = [{
      id: 'segment-1',
      role: 'scene',
      narration: 'test',
      targetDurationMs: 8000,
      linkedSliceIds: ['slice-drive'],
      beats: [
        {
          id: 'beat-1',
          text: '这段旁白更长，但不该再靠默认慢放去填满。',
          targetDurationMs: 8000,
          actions: {
            muteSource: true,
          },
          selections: [{
            assetId: 'asset-drive',
            sliceId: 'slice-drive',
          }],
          linkedSliceIds: ['slice-drive'],
        },
      ],
    }];

    const { clips } = placeClips(script, slices, assets);

    expect(clips).toHaveLength(1);
    expect(clips[0]).toMatchObject({
      sourceInMs: 0,
      sourceOutMs: 6000,
      timelineInMs: 0,
      timelineOutMs: 8000,
    });
    expect(clips[0]?.speed).toBeUndefined();
  });

  it('uses explicit speed instead of implicit retiming', () => {
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
        sourceOutMs: 10_000,
        editSourceInMs: 0,
        editSourceOutMs: 10_000,
        labels: [],
        placeHints: [],
      },
    ];
    const script: IKtepScript[] = [{
      id: 'segment-1',
      role: 'scene',
      narration: 'test',
      targetDurationMs: 10_000,
      linkedSliceIds: ['slice-drive'],
      beats: [
        {
          id: 'beat-1',
          text: '开快一点。',
          targetDurationMs: 10_000,
          actions: {
            muteSource: true,
            speed: 5,
          },
          selections: [{
            assetId: 'asset-drive',
            sliceId: 'slice-drive',
          }],
          linkedSliceIds: ['slice-drive'],
        },
      ],
    }];

    const { clips } = placeClips(script, slices, assets);

    expect(clips).toHaveLength(1);
    expect(clips[0]).toMatchObject({
      sourceInMs: 0,
      sourceOutMs: 10_000,
      speed: 5,
      timelineInMs: 0,
      timelineOutMs: 2000,
    });
  });

  it('only applies speed to drive clips inside a mixed beat', () => {
    const assets: IKtepAsset[] = [
      {
        id: 'asset-drive',
        kind: 'video',
        sourcePath: 'drive.mp4',
        displayName: 'drive.mp4',
      },
      {
        id: 'asset-broll',
        kind: 'video',
        sourcePath: 'broll.mp4',
        displayName: 'broll.mp4',
      },
    ];
    const slices: IKtepSlice[] = [
      {
        id: 'slice-drive',
        assetId: 'asset-drive',
        type: 'drive',
        sourceInMs: 0,
        sourceOutMs: 10_000,
        labels: [],
        placeHints: [],
      },
      {
        id: 'slice-broll',
        assetId: 'asset-broll',
        type: 'broll',
        sourceInMs: 0,
        sourceOutMs: 4_000,
        labels: [],
        placeHints: [],
      },
    ];
    const script: IKtepScript[] = [{
      id: 'segment-1',
      role: 'scene',
      narration: 'test',
      targetDurationMs: 5_000,
      linkedSliceIds: ['slice-drive', 'slice-broll'],
      beats: [
        {
          id: 'beat-1',
          text: '混合加速段。',
          targetDurationMs: 5_000,
          actions: {
            muteSource: true,
            speed: 5,
          },
          selections: [
            {
              assetId: 'asset-drive',
              sliceId: 'slice-drive',
              sourceInMs: 0,
              sourceOutMs: 10_000,
            },
            {
              assetId: 'asset-broll',
              sliceId: 'slice-broll',
              sourceInMs: 0,
              sourceOutMs: 4_000,
            },
          ],
          linkedSliceIds: ['slice-drive', 'slice-broll'],
        },
      ],
    }];

    const { clips } = placeClips(script, slices, assets);

    expect(clips).toHaveLength(2);
    expect(clips[0]).toMatchObject({
      assetId: 'asset-drive',
      speed: 5,
      timelineInMs: 0,
      timelineOutMs: 1667,
    });
    expect(clips[1]).toMatchObject({
      assetId: 'asset-broll',
      sourceInMs: 0,
      sourceOutMs: 3333,
      timelineInMs: 1667,
      timelineOutMs: 5000,
    });
    expect(clips[1]?.speed).toBeUndefined();
  });

  it('keeps non-drive-or-aerial speed requests at 1x', () => {
    const assets: IKtepAsset[] = [
      {
        id: 'asset-timelapse',
        kind: 'video',
        sourcePath: 'timelapse.mp4',
        displayName: 'timelapse.mp4',
      },
    ];
    const slices: IKtepSlice[] = [
      {
        id: 'slice-timelapse',
        assetId: 'asset-timelapse',
        type: 'timelapse',
        sourceInMs: 0,
        sourceOutMs: 4_000,
        labels: [],
        placeHints: [],
      },
    ];
    const script: IKtepScript[] = [{
      id: 'segment-1',
      role: 'highlight',
      narration: 'test',
      targetDurationMs: 4_000,
      linkedSliceIds: ['slice-timelapse'],
      beats: [
        {
          id: 'beat-1',
          text: '延时素材不应再次加速。',
          targetDurationMs: 4_000,
          actions: {
            muteSource: true,
            speed: 8,
          },
          selections: [{
            assetId: 'asset-timelapse',
            sliceId: 'slice-timelapse',
            sourceInMs: 0,
            sourceOutMs: 4_000,
          }],
          linkedSliceIds: ['slice-timelapse'],
        },
      ],
    }];

    const { clips } = placeClips(script, slices, assets);

    expect(clips).toHaveLength(1);
    expect(clips[0]).toMatchObject({
      sourceInMs: 0,
      sourceOutMs: 4_000,
      timelineInMs: 0,
      timelineOutMs: 4_000,
    });
    expect(clips[0]?.speed).toBeUndefined();
  });

  it('expands legal aerial speed clips within bounds to better match the beat budget', () => {
    const assets: IKtepAsset[] = [
      {
        id: 'asset-aerial',
        kind: 'video',
        sourcePath: 'aerial.mp4',
        displayName: 'aerial.mp4',
      },
    ];
    const slices: IKtepSlice[] = [
      {
        id: 'slice-aerial',
        assetId: 'asset-aerial',
        type: 'aerial',
        sourceInMs: 0,
        sourceOutMs: 8_000,
        editSourceInMs: 0,
        editSourceOutMs: 24_000,
        labels: [],
        placeHints: [],
      },
    ];
    const script: IKtepScript[] = [{
      id: 'segment-1',
      role: 'intro',
      narration: 'test',
      targetDurationMs: 6_000,
      linkedSliceIds: ['slice-aerial'],
      beats: [
        {
          id: 'beat-1',
          text: '航拍加速建场。',
          targetDurationMs: 6_000,
          actions: {
            muteSource: true,
            speed: 4,
          },
          selections: [{
            assetId: 'asset-aerial',
            sliceId: 'slice-aerial',
            sourceInMs: 0,
            sourceOutMs: 8_000,
          }],
          linkedSliceIds: ['slice-aerial'],
        },
      ],
    }];

    const { clips } = placeClips(script, slices, assets);

    expect(clips).toHaveLength(1);
    expect(clips[0]).toMatchObject({
      sourceInMs: 0,
      sourceOutMs: 24_000,
      speed: 4,
      timelineInMs: 0,
      timelineOutMs: 6_000,
    });
  });

  it('mutes embedded video audio for narration-driven beats', () => {
    const assets: IKtepAsset[] = [
      {
        id: 'asset-drive',
        kind: 'video',
        sourcePath: 'drive.mp4',
        displayName: 'drive.mp4',
        metadata: {
          hasAudioStream: true,
          audioStreamCount: 1,
        },
      },
    ];
    const slices: IKtepSlice[] = [
      {
        id: 'slice-drive',
        assetId: 'asset-drive',
        type: 'drive',
        sourceInMs: 0,
        sourceOutMs: 1200,
        labels: [],
        placeHints: [],
      },
    ];
    const script: IKtepScript[] = [{
      id: 'segment-1',
      role: 'scene',
      narration: 'test',
      targetDurationMs: 1200,
      linkedSliceIds: ['slice-drive'],
      beats: [
        {
          id: 'beat-1',
          text: '旁白覆盖这段镜头。',
          actions: {
            muteSource: true,
          },
          selections: [{
            assetId: 'asset-drive',
            sliceId: 'slice-drive',
            sourceInMs: 0,
            sourceOutMs: 1200,
          }],
          linkedSliceIds: ['slice-drive'],
        },
      ],
    }];

    const { clips } = placeClips(script, slices, assets);

    expect(clips[0]?.muteAudio).toBe(true);
  });

  it('keeps embedded video audio when a beat preserves natural sound', () => {
    const assets: IKtepAsset[] = [
      {
        id: 'asset-talk',
        kind: 'video',
        sourcePath: 'talk.mp4',
        displayName: 'talk.mp4',
        metadata: {
          hasAudioStream: true,
          audioStreamCount: 1,
        },
      },
    ];
    const slices: IKtepSlice[] = [
      {
        id: 'slice-talk',
        assetId: 'asset-talk',
        type: 'talking-head',
        sourceInMs: 0,
        sourceOutMs: 1200,
        transcriptSegments: [{
          startMs: 0,
          endMs: 1200,
          text: '这是现场原话',
        }],
        labels: [],
        placeHints: [],
      },
    ];
    const script: IKtepScript[] = [{
      id: 'segment-1',
      role: 'scene',
      narration: 'test',
      targetDurationMs: 1200,
      linkedSliceIds: ['slice-talk'],
      beats: [
        {
          id: 'beat-1',
          text: '这是现场原话',
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

    const { clips } = placeClips(script, slices, assets);

    expect(clips[0]?.muteAudio).toBeUndefined();
  });

  it('routes protected sidecar audio onto a nat track when report prefers fallback', () => {
    const assets: IKtepAsset[] = [
      {
        id: 'asset-talk',
        kind: 'video',
        sourcePath: 'talk.mp4',
        displayName: 'talk.mp4',
        protectionAudio: {
          sourcePath: 'talk.wav',
          displayName: 'talk.wav',
          alignment: 'exact',
        },
        metadata: {
          hasAudioStream: true,
          audioStreamCount: 1,
        },
      },
    ];
    const slices: IKtepSlice[] = [
      {
        id: 'slice-talk',
        assetId: 'asset-talk',
        type: 'talking-head',
        sourceInMs: 0,
        sourceOutMs: 1800,
        transcriptSegments: [{
          startMs: 0,
          endMs: 1800,
          text: '这是现场原话',
        }],
        labels: [],
        placeHints: [],
      },
    ];
    const script: IKtepScript[] = [{
      id: 'segment-1',
      role: 'scene',
      narration: 'test',
      targetDurationMs: 1800,
      linkedSliceIds: ['slice-talk'],
      beats: [
        {
          id: 'beat-1',
          text: '这是现场原话',
          actions: {
            preserveNatSound: true,
          },
          selections: [{
            assetId: 'asset-talk',
            sliceId: 'slice-talk',
            sourceInMs: 0,
            sourceOutMs: 1800,
          }],
          linkedSliceIds: ['slice-talk'],
        },
      ],
    }];

    const { tracks, clips } = placeClips(script, slices, assets, {}, [{
      assetId: 'asset-talk',
      clipTypeGuess: 'talking-head',
      densityScore: 0.4,
      labels: ['speech'],
      placeHints: [],
      rootNotes: [],
      sampleFrames: [],
      interestingWindows: [],
      shouldFineScan: false,
      fineScanMode: 'skip',
      fineScanReasons: [],
      createdAt: '2026-04-03T00:00:00.000Z',
      updatedAt: '2026-04-03T00:00:00.000Z',
      protectedAudio: {
        recommendedSource: 'protection',
        reason: '保护音轨更稳。',
      },
    }]);

    expect(tracks).toHaveLength(2);
    expect(tracks[1]).toMatchObject({
      kind: 'audio',
      role: 'nat',
    });
    expect(clips).toHaveLength(2);
    expect(clips[0]).toMatchObject({
      assetId: 'asset-talk',
      muteAudio: true,
      timelineInMs: 0,
      timelineOutMs: 1800,
    });
    expect(clips[1]).toMatchObject({
      assetId: 'asset-talk',
      trackId: tracks[1]!.id,
      timelineInMs: 0,
      timelineOutMs: 1800,
      sourceInMs: 0,
      sourceOutMs: 1800,
    });
  });
});
