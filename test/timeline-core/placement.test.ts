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
});
