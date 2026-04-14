import { describe, expect, it } from 'vitest';
import type { IKtepAsset, IKtepScript, IKtepSlice } from '../../src/protocol/schema.js';
import { placeClips } from '../../src/modules/timeline-core/placement.js';

describe('placeClips', () => {
  it('keeps a single photo at the 1s rough-cut default', () => {
    const assets: IKtepAsset[] = [
      {
        id: 'asset-photo',
        kind: 'photo',
        sourcePath: 'photo.jpg',
        displayName: 'photo.jpg',
      },
    ];
    const slices: IKtepSlice[] = [
      {
        id: 'slice-photo',
        assetId: 'asset-photo',
        type: 'photo',
        labels: [],
        placeHints: [],
      },
    ];
    const script: IKtepScript[] = [{
      id: 'segment-1',
      role: 'scene',
      narration: 'test',
      targetDurationMs: 9_000,
      linkedSliceIds: ['slice-photo'],
      beats: [
        {
          id: 'beat-1',
          text: '单张照片不该被拉到九秒。',
          targetDurationMs: 9_000,
          selections: [{
            assetId: 'asset-photo',
            sliceId: 'slice-photo',
          }],
          linkedSliceIds: ['slice-photo'],
        },
      ],
    }];

    const { clips } = placeClips(script, slices, assets);

    expect(clips).toHaveLength(1);
    expect(clips[0]?.timelineInMs).toBe(0);
    expect(clips[0]?.timelineOutMs).toBe(1_000);
  });

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

  it('keeps narration-driven video on its natural source duration when no edit bounds are available', () => {
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
      timelineOutMs: 1000,
    });
  });

  it('prefers edit-friendly slice bounds without stretching to a beat budget', () => {
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
      timelineOutMs: 6000,
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

  it('auto-applies 2x speed for silent drive rough cuts when speedCandidate is present', () => {
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
        speedCandidate: {
          sourceWindow: { startMs: 0, endMs: 10_000 },
          suggestedSpeeds: [2, 5],
        },
        labels: [],
        placeHints: [],
      },
    ];
    const script: IKtepScript[] = [{
      id: 'segment-1',
      role: 'scene',
      narration: 'test',
      linkedSliceIds: ['slice-drive'],
      beats: [
        {
          id: 'beat-1',
          text: '静默行车素材默认加到 2x。',
          actions: {
            muteSource: true,
          },
          selections: [{
            assetId: 'asset-drive',
            sliceId: 'slice-drive',
            sourceInMs: 0,
            sourceOutMs: 10_000,
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
      speed: 2,
      timelineInMs: 0,
      timelineOutMs: 5000,
    });
  });

  it('does not auto-apply speed when a drive beat preserves source speech', () => {
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
        sourceOutMs: 4_000,
        speedCandidate: {
          sourceWindow: { startMs: 0, endMs: 4_000 },
          suggestedSpeeds: [2, 5],
        },
        transcriptSegments: [{
          startMs: 0,
          endMs: 2_000,
          text: '先沿着这条路进去。',
        }],
        labels: [],
        placeHints: [],
      },
    ];
    const script: IKtepScript[] = [{
      id: 'segment-1',
      role: 'scene',
      narration: 'test',
      linkedSliceIds: ['slice-drive'],
      beats: [
        {
          id: 'beat-1',
          text: '先沿着这条路进去。',
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
        },
      ],
    }];

    const { clips } = placeClips(script, slices, assets);

    expect(clips).toHaveLength(1);
    expect(clips[0]).toMatchObject({
      sourceInMs: 0,
      sourceOutMs: 2_000,
      timelineInMs: 0,
      timelineOutMs: 2_000,
    });
    expect(clips[0]?.speed).toBeUndefined();
  });

  it('anchors clean source-speech clips directly to transcript boundaries without fixed padding', () => {
    const assets: IKtepAsset[] = [
      {
        id: 'asset-drive',
        kind: 'video',
        sourcePath: 'C0218.MP4',
        displayName: 'C0218.MP4',
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
        sourceOutMs: 8_512,
        transcriptSegments: [
          {
            startMs: 0,
            endMs: 2_000,
            text: '鲜鱼没有戴长脚',
          },
          {
            startMs: 2_000,
            endMs: 4_000,
            text: '所以只能在镜面拍',
          },
        ],
        labels: [],
        placeHints: [],
      },
    ];
    const script: IKtepScript[] = [{
      id: 'segment-1',
      role: 'scene',
      narration: 'test',
      linkedSliceIds: ['slice-drive'],
      beats: [
        {
          id: 'beat-1',
          text: '鲜鱼没有戴长脚 所以只能在镜面拍',
          actions: {
            preserveNatSound: true,
          },
          selections: [{
            assetId: 'asset-drive',
            sliceId: 'slice-drive',
            sourceInMs: 0,
            sourceOutMs: 8_512,
          }],
          linkedSliceIds: ['slice-drive'],
        },
      ],
    }];

    const { clips } = placeClips(script, slices, assets);

    expect(clips).toHaveLength(1);
    expect(clips[0]).toMatchObject({
      assetId: 'asset-drive',
      sourceInMs: 0,
      sourceOutMs: 4_000,
      timelineInMs: 0,
      timelineOutMs: 4_000,
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
      timelineOutMs: 2000,
    });
    expect(clips[1]).toMatchObject({
      assetId: 'asset-broll',
      sourceInMs: 0,
      sourceOutMs: 4_000,
      timelineInMs: 2000,
      timelineOutMs: 6000,
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

  it('keeps legal aerial speed clips on their natural accelerated duration', () => {
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
      sourceOutMs: 8_000,
      speed: 4,
      timelineInMs: 0,
      timelineOutMs: 2_000,
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

  it('drops non-transcript cutaways from preserveNatSound beats before placement', () => {
    const assets: IKtepAsset[] = [
      {
        id: 'asset-cutaway',
        kind: 'video',
        sourcePath: 'cutaway.mp4',
        displayName: 'cutaway.mp4',
        metadata: {
          hasAudioStream: false,
          audioStreamCount: 0,
        },
      },
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

    const { clips } = placeClips(script, slices, assets);

    expect(clips).toHaveLength(1);
    expect(clips[0]).toMatchObject({
      assetId: 'asset-talk',
      sliceId: 'slice-talk',
      sourceInMs: 0,
      sourceOutMs: 1200,
      timelineInMs: 0,
      timelineOutMs: 1200,
    });
    expect(clips[0]?.muteAudio).toBeUndefined();
  });

  it('keeps original selections when preserveNatSound beats have no transcript overlap', () => {
    const assets: IKtepAsset[] = [
      {
        id: 'asset-ambient',
        kind: 'video',
        sourcePath: 'ambient.mp4',
        displayName: 'ambient.mp4',
        metadata: {
          hasAudioStream: true,
          audioStreamCount: 1,
        },
      },
    ];
    const slices: IKtepSlice[] = [
      {
        id: 'slice-ambient',
        assetId: 'asset-ambient',
        type: 'broll',
        sourceInMs: 1000,
        sourceOutMs: 3600,
        labels: [],
        placeHints: [],
      },
    ];
    const script: IKtepScript[] = [{
      id: 'segment-1',
      role: 'scene',
      narration: 'test',
      targetDurationMs: 2600,
      linkedSliceIds: ['slice-ambient'],
      beats: [
        {
          id: 'beat-1',
          text: '风声和路噪就够了。',
          targetDurationMs: 2600,
          actions: {
            preserveNatSound: true,
          },
          selections: [{
            assetId: 'asset-ambient',
            sliceId: 'slice-ambient',
            sourceInMs: 1000,
            sourceOutMs: 3600,
          }],
          linkedSliceIds: ['slice-ambient'],
        },
      ],
    }];

    const { clips } = placeClips(script, slices, assets);

    expect(clips).toHaveLength(1);
    expect(clips[0]).toMatchObject({
      assetId: 'asset-ambient',
      sliceId: 'slice-ambient',
      sourceInMs: 1000,
      sourceOutMs: 3600,
      timelineInMs: 0,
      timelineOutMs: 2600,
    });
    expect(clips[0]?.muteAudio).toBeUndefined();
  });

  it('splits source-speech drive beats into speech islands and removes long silent gaps', () => {
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
        sourceOutMs: 10_000,
        transcriptSegments: [
          {
            startMs: 0,
            endMs: 1_000,
            text: '先直走。',
          },
          {
            startMs: 1_500,
            endMs: 2_500,
            text: '看到路口再右转。',
          },
          {
            startMs: 5_500,
            endMs: 6_500,
            text: '现在已经快到了。',
          },
        ],
        labels: [],
        placeHints: [],
      },
    ];
    const script: IKtepScript[] = [{
      id: 'segment-1',
      role: 'scene',
      narration: 'test',
      linkedSliceIds: ['slice-drive'],
      beats: [
        {
          id: 'beat-1',
          text: '先直走，看到路口再右转，现在已经快到了。',
          actions: {
            preserveNatSound: true,
          },
          selections: [{
            assetId: 'asset-drive',
            sliceId: 'slice-drive',
            sourceInMs: 0,
            sourceOutMs: 10_000,
          }],
          linkedSliceIds: ['slice-drive'],
        },
      ],
    }];

    const { clips } = placeClips(script, slices, assets);

    expect(clips).toHaveLength(2);
    expect(clips[0]).toMatchObject({
      assetId: 'asset-drive',
      sourceInMs: 0,
      sourceOutMs: 2_500,
      timelineInMs: 0,
      timelineOutMs: 2_500,
    });
    expect(clips[1]).toMatchObject({
      assetId: 'asset-drive',
      sourceInMs: 5_500,
      sourceOutMs: 6_500,
      timelineInMs: 2_500,
      timelineOutMs: 3_500,
    });
    expect(clips.every(clip => clip.speed == null)).toBe(true);
  });

  it('filters navigation and device-command transcript tails out of source-speech windows', () => {
    const assets: IKtepAsset[] = [
      {
        id: 'asset-drive',
        kind: 'video',
        sourcePath: 'C0195.MP4',
        displayName: 'C0195.MP4',
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
        sourceInMs: 17_500,
        sourceOutMs: 64_576,
        transcriptSegments: [
          {
            startMs: 18_000,
            endMs: 36_700,
            text: '刚刚这边已经开始堵了',
          },
          {
            startMs: 38_700,
            endMs: 51_000,
            text: '沿S33南光高速继续行驶9.1公里',
          },
          {
            startMs: 51_500,
            endMs: 52_000,
            text: '请集中注意力',
          },
          {
            startMs: 53_000,
            endMs: 53_500,
            text: '拍摄启动',
          },
          {
            startMs: 62_000,
            endMs: 64_000,
            text: '停止录像',
          },
        ],
        labels: [],
        placeHints: [],
      },
    ];
    const script: IKtepScript[] = [{
      id: 'segment-1',
      role: 'scene',
      narration: 'test',
      linkedSliceIds: ['slice-drive'],
      beats: [
        {
          id: 'beat-1',
          text: '刚刚这边已经开始堵了',
          actions: {
            preserveNatSound: true,
          },
          selections: [{
            assetId: 'asset-drive',
            sliceId: 'slice-drive',
            sourceInMs: 17_500,
            sourceOutMs: 64_576,
          }],
          linkedSliceIds: ['slice-drive'],
        },
      ],
    }];

    const { clips } = placeClips(script, slices, assets);

    expect(clips).toHaveLength(1);
    expect(clips[0]).toMatchObject({
      assetId: 'asset-drive',
      sourceInMs: 18_000,
      sourceOutMs: 36_700,
      timelineInMs: 0,
      timelineOutMs: 18_700,
    });
    expect(clips[0]?.speed).toBeUndefined();
  });

  it('removes source-speech-owned windows from silent drive montage on the same asset', () => {
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
        sourceOutMs: 8_000,
        speedCandidate: {
          sourceWindow: { startMs: 0, endMs: 8_000 },
          suggestedSpeeds: [2, 5],
        },
        transcriptSegments: [
          {
            startMs: 1_000,
            endMs: 3_000,
            text: '现在先从这边进去',
          },
        ],
        labels: [],
        placeHints: [],
      },
    ];
    const script: IKtepScript[] = [{
      id: 'segment-1',
      role: 'scene',
      narration: 'test',
      linkedSliceIds: ['slice-drive'],
      beats: [
        {
          id: 'beat-speech',
          text: '现在先从这边进去',
          actions: {
            preserveNatSound: true,
          },
          selections: [{
            assetId: 'asset-drive',
            sliceId: 'slice-drive',
            sourceInMs: 0,
            sourceOutMs: 5_000,
          }],
          linkedSliceIds: ['slice-drive'],
        },
        {
          id: 'beat-silent',
          text: '静默行车',
          actions: {
            muteSource: true,
          },
          selections: [{
            assetId: 'asset-drive',
            sliceId: 'slice-drive',
            sourceInMs: 0,
            sourceOutMs: 5_000,
          }],
          linkedSliceIds: ['slice-drive'],
        },
      ],
    }];

    const { clips } = placeClips(script, slices, assets);

    expect(clips).toHaveLength(2);
    expect(clips[0]).toMatchObject({
      linkedScriptBeatId: 'beat-speech',
      sourceInMs: 1_000,
      sourceOutMs: 3_000,
      timelineInMs: 0,
      timelineOutMs: 2_000,
    });
    expect(clips[1]).toMatchObject({
      linkedScriptBeatId: 'beat-silent',
      sourceInMs: 3_000,
      sourceOutMs: 5_000,
      speed: 2,
      timelineInMs: 2_000,
      timelineOutMs: 3_000,
    });
  });

  it('removes already-used silent drive windows from later beats on the same asset', () => {
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
        id: 'slice-drive-1',
        assetId: 'asset-drive',
        type: 'drive',
        sourceInMs: 13_450,
        sourceOutMs: 51_125,
        speedCandidate: {
          sourceWindow: { startMs: 13_450, endMs: 51_125 },
          suggestedSpeeds: [2, 5],
        },
        labels: [],
        placeHints: [],
      },
      {
        id: 'slice-drive-2',
        assetId: 'asset-drive',
        type: 'drive',
        sourceInMs: 17_500,
        sourceOutMs: 64_576,
        speedCandidate: {
          sourceWindow: { startMs: 17_500, endMs: 64_576 },
          suggestedSpeeds: [2, 5],
        },
        labels: [],
        placeHints: [],
      },
    ];
    const script: IKtepScript[] = [{
      id: 'segment-1',
      role: 'scene',
      narration: 'test',
      linkedSliceIds: ['slice-drive-1', 'slice-drive-2'],
      beats: [
        {
          id: 'beat-silent-1',
          text: '',
          actions: {
            muteSource: true,
          },
          selections: [{
            assetId: 'asset-drive',
            sliceId: 'slice-drive-1',
            sourceInMs: 13_450,
            sourceOutMs: 51_125,
          }],
          linkedSliceIds: ['slice-drive-1'],
        },
        {
          id: 'beat-silent-2',
          text: '',
          actions: {
            muteSource: true,
          },
          selections: [{
            assetId: 'asset-drive',
            sliceId: 'slice-drive-2',
            sourceInMs: 17_500,
            sourceOutMs: 64_576,
          }],
          linkedSliceIds: ['slice-drive-2'],
        },
      ],
    }];

    const { clips } = placeClips(script, slices, assets);

    expect(clips).toHaveLength(2);
    expect(clips[0]).toMatchObject({
      linkedScriptBeatId: 'beat-silent-1',
      sourceInMs: 13_450,
      sourceOutMs: 51_125,
      speed: 2,
    });
    expect(clips[1]).toMatchObject({
      linkedScriptBeatId: 'beat-silent-2',
      sourceInMs: 51_125,
      sourceOutMs: 64_576,
      speed: 2,
    });
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
      keepDecision: 'keep',
      materializationPath: 'direct',
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

  it('extends photo clips only when holdMs is explicitly requested', () => {
    const assets: IKtepAsset[] = [
      {
        id: 'asset-photo',
        kind: 'photo',
        sourcePath: 'photo.jpg',
        displayName: 'photo.jpg',
      },
    ];
    const slices: IKtepSlice[] = [
      {
        id: 'slice-photo',
        assetId: 'asset-photo',
        type: 'photo',
        labels: [],
        placeHints: [],
      },
    ];
    const script: IKtepScript[] = [{
      id: 'segment-1',
      role: 'scene',
      narration: 'test',
      linkedSliceIds: ['slice-photo'],
      beats: [
        {
          id: 'beat-1',
          text: '这张照片要多停一会。',
          actions: {
            holdMs: 3200,
          },
          selections: [{
            assetId: 'asset-photo',
            sliceId: 'slice-photo',
          }],
          linkedSliceIds: ['slice-photo'],
        },
      ],
    }];

    const { clips } = placeClips(script, slices, assets);

    expect(clips).toHaveLength(1);
    expect(clips[0]).toMatchObject({
      timelineInMs: 0,
      timelineOutMs: 3200,
    });
  });

  it('reorders beats within the same segment when chronology guard is enabled', () => {
    const assets: IKtepAsset[] = [
      {
        id: 'asset-late',
        kind: 'video',
        sourcePath: 'late.mp4',
        displayName: 'late.mp4',
        capturedAt: '2026-04-10T10:00:00.000Z',
      },
      {
        id: 'asset-early',
        kind: 'video',
        sourcePath: 'early.mp4',
        displayName: 'early.mp4',
        capturedAt: '2026-04-10T08:00:00.000Z',
      },
    ];
    const slices: IKtepSlice[] = [
      {
        id: 'slice-late',
        assetId: 'asset-late',
        type: 'broll',
        sourceInMs: 0,
        sourceOutMs: 2_000,
        labels: [],
        placeHints: [],
      },
      {
        id: 'slice-early',
        assetId: 'asset-early',
        type: 'broll',
        sourceInMs: 0,
        sourceOutMs: 2_000,
        labels: [],
        placeHints: [],
      },
    ];
    const script: IKtepScript[] = [{
      id: 'segment-1',
      role: 'scene',
      narration: 'test',
      targetDurationMs: 4_000,
      linkedSliceIds: ['slice-late', 'slice-early'],
      beats: [
        {
          id: 'beat-late',
          text: '先错放晚一点的镜头。',
          targetDurationMs: 2_000,
          selections: [{ assetId: 'asset-late', sliceId: 'slice-late', sourceInMs: 0, sourceOutMs: 2_000 }],
          linkedSliceIds: ['slice-late'],
        },
        {
          id: 'beat-early',
          text: '再放更早的镜头。',
          targetDurationMs: 2_000,
          selections: [{ assetId: 'asset-early', sliceId: 'slice-early', sourceInMs: 0, sourceOutMs: 2_000 }],
          linkedSliceIds: ['slice-early'],
        },
      ],
    }];

    const { clips } = placeClips(script, slices, assets, {
      arrangementSignals: {
        primaryAxisKind: 'time',
        chronologyStrength: 0.8,
        routeContinuityStrength: 0.6,
        processContinuityStrength: 0.6,
        spaceStrength: 0.1,
        emotionStrength: 0.1,
        payoffStrength: 0.1,
        enforceChronology: true,
        materialRoleBias: {},
      },
    });

    expect(clips.map(clip => clip.assetId)).toEqual(['asset-early', 'asset-late']);
    expect(clips.map(clip => [clip.timelineInMs, clip.timelineOutMs])).toEqual([
      [0, 2000],
      [2000, 4000],
    ]);
  });

  it('uses chronology.sortCapturedAt instead of raw asset capturedAt for chronology ordering', () => {
    const assets: IKtepAsset[] = [
      {
        id: 'asset-video',
        kind: 'video',
        sourcePath: 'C0251.MP4',
        displayName: 'C0251.MP4',
        capturedAt: '2026-04-12T07:59:35.000Z',
      },
      {
        id: 'asset-photo',
        kind: 'photo',
        sourcePath: 'DSC06876.jpg',
        displayName: 'DSC06876.jpg',
        capturedAt: '2026-04-12T08:09:46.000Z',
      },
    ];
    const slices: IKtepSlice[] = [
      {
        id: 'slice-photo',
        assetId: 'asset-photo',
        type: 'photo',
        labels: [],
        placeHints: [],
      },
      {
        id: 'slice-video',
        assetId: 'asset-video',
        type: 'broll',
        sourceInMs: 0,
        sourceOutMs: 2_000,
        labels: [],
        placeHints: [],
      },
    ];
    const script: IKtepScript[] = [{
      id: 'segment-1',
      role: 'scene',
      narration: 'test',
      linkedSliceIds: ['slice-photo', 'slice-video'],
      beats: [
        {
          id: 'beat-photo',
          text: '',
          selections: [{ assetId: 'asset-photo', sliceId: 'slice-photo' }],
          linkedSliceIds: ['slice-photo'],
        },
        {
          id: 'beat-video',
          text: '',
          selections: [{ assetId: 'asset-video', sliceId: 'slice-video', sourceInMs: 0, sourceOutMs: 2_000 }],
          linkedSliceIds: ['slice-video'],
        },
      ],
    }];

    const { clips } = placeClips(script, slices, assets, {
      chronology: [
        {
          id: 'chrono-video',
          assetId: 'asset-video',
          capturedAt: '2026-04-12T07:59:35.000Z',
          sortCapturedAt: '2026-04-12T07:59:35.000Z',
          labels: [],
          placeHints: [],
          evidence: [],
          pharosMatches: [],
        },
        {
          id: 'chrono-photo',
          assetId: 'asset-photo',
          capturedAt: '2026-04-12T08:09:46.000Z',
          sortCapturedAt: '2026-04-12T07:59:35.500Z',
          labels: [],
          placeHints: [],
          evidence: [],
          pharosMatches: [],
        },
      ],
      arrangementSignals: {
        primaryAxisKind: 'time',
        chronologyStrength: 0.8,
        routeContinuityStrength: 0.6,
        processContinuityStrength: 0.6,
        spaceStrength: 0.1,
        emotionStrength: 0.1,
        payoffStrength: 0.1,
        enforceChronology: true,
        materialRoleBias: {},
      },
    });

    expect(clips.map(clip => clip.assetId)).toEqual(['asset-video', 'asset-photo']);
  });

  it('throws when chronology guard still detects backwards beats across segments', () => {
    const assets: IKtepAsset[] = [
      {
        id: 'asset-late',
        kind: 'video',
        sourcePath: 'late.mp4',
        displayName: 'late.mp4',
        capturedAt: '2026-04-10T10:00:00.000Z',
      },
      {
        id: 'asset-early',
        kind: 'video',
        sourcePath: 'early.mp4',
        displayName: 'early.mp4',
        capturedAt: '2026-04-10T08:00:00.000Z',
      },
    ];
    const slices: IKtepSlice[] = [
      {
        id: 'slice-late',
        assetId: 'asset-late',
        type: 'broll',
        sourceInMs: 0,
        sourceOutMs: 2_000,
        labels: [],
        placeHints: [],
      },
      {
        id: 'slice-early',
        assetId: 'asset-early',
        type: 'broll',
        sourceInMs: 0,
        sourceOutMs: 2_000,
        labels: [],
        placeHints: [],
      },
    ];
    const script: IKtepScript[] = [
      {
        id: 'segment-1',
        role: 'scene',
        narration: 'test',
        targetDurationMs: 2_000,
        linkedSliceIds: ['slice-late'],
        beats: [
          {
            id: 'beat-late',
            text: '后拍的段落被放在前面。',
            targetDurationMs: 2_000,
            selections: [{ assetId: 'asset-late', sliceId: 'slice-late', sourceInMs: 0, sourceOutMs: 2_000 }],
            linkedSliceIds: ['slice-late'],
          },
        ],
      },
      {
        id: 'segment-2',
        role: 'scene',
        narration: 'test',
        targetDurationMs: 2_000,
        linkedSliceIds: ['slice-early'],
        beats: [
          {
            id: 'beat-early',
            text: '更早的段落还排在后面。',
            targetDurationMs: 2_000,
            selections: [{ assetId: 'asset-early', sliceId: 'slice-early', sourceInMs: 0, sourceOutMs: 2_000 }],
            linkedSliceIds: ['slice-early'],
          },
        ],
      },
    ];

    expect(() => placeClips(script, slices, assets, {
      arrangementSignals: {
        primaryAxisKind: 'time',
        chronologyStrength: 0.8,
        routeContinuityStrength: 0.6,
        processContinuityStrength: 0.6,
        spaceStrength: 0.1,
        emotionStrength: 0.1,
        payoffStrength: 0.1,
        enforceChronology: true,
        materialRoleBias: {},
      },
    })).toThrow(/Chronology guard failed/u);
  });
});
