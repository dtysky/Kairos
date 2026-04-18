import { describe, expect, it } from 'vitest';
import type { IKtepAsset, IKtepClip, IKtepScript, IKtepSlice } from '../../src/protocol/schema.js';
import { placeClips } from '../../src/modules/timeline-core/placement.js';
import { createTestScript } from '../helpers/script-fixtures.js';

describe('placeClips', () => {
  it('keeps a single photo at the 1s rough-cut default', () => {
    const assets: IKtepAsset[] = [{
      id: 'asset-photo',
      kind: 'photo',
      sourcePath: 'photo.jpg',
      displayName: 'photo.jpg',
    }];
    const slices: IKtepSlice[] = [{
      id: 'slice-photo',
      assetId: 'asset-photo',
      type: 'photo',
      labels: [],
      placeHints: [],
    }];
    const script: IKtepScript[] = createTestScript([{
      id: 'segment-1',
      role: 'scene',
      narration: 'test',
      targetDurationMs: 9_000,
      linkedSliceIds: ['slice-photo'],
      beats: [{
        id: 'beat-1',
        text: '单张照片不该被拉到九秒。',
        targetDurationMs: 9_000,
        selections: [{
          assetId: 'asset-photo',
          sliceId: 'slice-photo',
        }],
        linkedSliceIds: ['slice-photo'],
      }],
    }]);

    const { clips } = placeClips(script, slices, assets);

    expect(clips).toHaveLength(1);
    expect(clips[0]?.timelineInMs).toBe(0);
    expect(clips[0]?.timelineOutMs).toBe(1_000);
  });

  it('keeps narration-driven video selections on a single primary track', () => {
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
        sourceOutMs: 4_000,
        labels: [],
        placeHints: [],
      },
      {
        id: 'slice-drive',
        assetId: 'asset-drive',
        type: 'drive',
        sourceInMs: 1_000,
        sourceOutMs: 5_000,
        labels: [],
        placeHints: [],
      },
    ];
    const script: IKtepScript[] = createTestScript([{
      id: 'segment-1',
      role: 'intro',
      narration: 'test',
      targetDurationMs: 8_000,
      linkedSliceIds: ['slice-broll', 'slice-drive'],
      beats: [
        {
          id: 'beat-1',
          text: 'opening',
          targetDurationMs: 4_000,
          selections: [{
            assetId: 'asset-broll',
            sliceId: 'slice-broll',
            sourceInMs: 0,
            sourceOutMs: 4_000,
          }],
          linkedSliceIds: ['slice-broll'],
        },
        {
          id: 'beat-2',
          text: 'follow',
          targetDurationMs: 4_000,
          selections: [{
            assetId: 'asset-drive',
            sliceId: 'slice-drive',
            sourceInMs: 1_000,
            sourceOutMs: 5_000,
          }],
          linkedSliceIds: ['slice-drive'],
        },
      ],
    }]);

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
      [0, 4_000],
      [4_000, 8_000],
    ]);
  });

  it('auto-applies 2x speed for silent drive rough cuts when speedCandidate is present', () => {
    const assets: IKtepAsset[] = [{
      id: 'asset-drive',
      kind: 'video',
      sourcePath: 'drive.mp4',
      displayName: 'drive.mp4',
    }];
    const slices: IKtepSlice[] = [{
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
    }];
    const script: IKtepScript[] = createTestScript([{
      id: 'segment-1',
      role: 'scene',
      narration: 'test',
      linkedSliceIds: ['slice-drive'],
      beats: [{
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
      }],
    }]);

    const { clips } = placeClips(script, slices, assets);

    expect(clips).toHaveLength(1);
    expect(clips[0]).toMatchObject({
      sourceInMs: 0,
      sourceOutMs: 10_000,
      speed: 2,
      timelineInMs: 0,
      timelineOutMs: 5_000,
    });
  });

  it('creates a dialogue track for embedded source speech while keeping video on the primary track', () => {
    const assets: IKtepAsset[] = [{
      id: 'asset-talk',
      kind: 'video',
      sourcePath: 'talk.mp4',
      displayName: 'talk.mp4',
      metadata: {
        hasAudioStream: true,
        audioStreamCount: 1,
      },
    }];
    const slices: IKtepSlice[] = [{
      id: 'slice-talk',
      assetId: 'asset-talk',
      type: 'talking-head',
      sourceInMs: 0,
      sourceOutMs: 1_800,
      transcriptSegments: [{
        startMs: 0,
        endMs: 1_800,
        text: '这是现场原话。',
      }],
      labels: [],
      placeHints: [],
    }];
    const script: IKtepScript[] = createTestScript([{
      id: 'segment-1',
      role: 'scene',
      narration: 'ignored',
      linkedSliceIds: ['slice-talk'],
      beats: [{
        id: 'beat-1',
        text: '这是现场原话。',
        actions: {
          preserveNatSound: true,
        },
        selections: [{
          assetId: 'asset-talk',
          sliceId: 'slice-talk',
          sourceInMs: 0,
          sourceOutMs: 1_800,
        }],
        linkedSliceIds: ['slice-talk'],
      }],
    }]);

    const { tracks, clips } = placeClips(script, slices, assets);
    const primaryTrack = tracks.find(track => track.role === 'primary');
    const dialogueTrack = tracks.find(track => track.role === 'dialogue');

    expect(tracks.map(track => [track.kind, track.role])).toEqual([
      ['video', 'primary'],
      ['audio', 'dialogue'],
    ]);
    expect(primaryTrack).toBeDefined();
    expect(dialogueTrack).toBeDefined();

    const videoClip = clips.find(clip => clip.trackId === primaryTrack!.id);
    const audioClip = clips.find(clip => clip.trackId === dialogueTrack!.id);
    expect(videoClip).toMatchObject({
      assetId: 'asset-talk',
      muteAudio: true,
      timelineInMs: 0,
      timelineOutMs: 1_800,
    });
    expect(audioClip).toMatchObject({
      assetId: 'asset-talk',
      audioSource: 'embedded',
      timelineInMs: 0,
      timelineOutMs: 1_800,
      sourceInMs: 0,
      sourceOutMs: 1_800,
    });
  });

  it('keeps companion visuals on the primary track instead of deleting them from source-speech beats', () => {
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

    const { tracks, clips } = placeClips(script, slices, assets);
    const primaryTrack = tracks.find(track => track.role === 'primary');
    const dialogueTrack = tracks.find(track => track.role === 'dialogue');
    const primaryClips = clips.filter(clip => clip.trackId === primaryTrack?.id);
    const dialogueClips = clips.filter(clip => clip.trackId === dialogueTrack?.id);

    expect(tracks.map(track => track.role)).toEqual(['primary', 'dialogue']);
    expect(primaryClips).toHaveLength(2);
    expect(primaryClips.map(clip => clip.assetId)).toEqual(['asset-cutaway', 'asset-talk']);
    expect(primaryClips.every(clip => clip.muteAudio === true)).toBe(true);
    expect(dialogueClips).toHaveLength(1);
    expect(dialogueClips[0]).toMatchObject({
      assetId: 'asset-talk',
      audioSource: 'embedded',
      sourceInMs: 0,
      sourceOutMs: 1_200,
    });
    expect(primaryClips.at(-1)?.timelineOutMs).toBe(dialogueClips[0]?.timelineOutMs);
  });

  it('merges nearby speech windows within 3000ms, adds breathing, and splits on strong sentence boundaries', () => {
    const assets: IKtepAsset[] = [{
      id: 'asset-drive',
      kind: 'video',
      sourcePath: 'drive.mp4',
      displayName: 'drive.mp4',
      metadata: {
        hasAudioStream: true,
        audioStreamCount: 1,
      },
    }];
    const slices: IKtepSlice[] = [{
      id: 'slice-drive',
      assetId: 'asset-drive',
      type: 'drive',
      sourceInMs: 0,
      sourceOutMs: 8_000,
      transcriptSegments: [
        {
          startMs: 1_000,
          endMs: 2_000,
          text: '先直走，',
        },
        {
          startMs: 2_300,
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
    }];
    const script: IKtepScript[] = createTestScript([{
      id: 'segment-1',
      role: 'scene',
      narration: 'ignored',
      linkedSliceIds: ['slice-drive'],
      beats: [{
        id: 'beat-1',
        text: '先直走，看到路口再右转，现在已经快到了。',
        actions: {
          preserveNatSound: true,
        },
        selections: [{
          assetId: 'asset-drive',
          sliceId: 'slice-drive',
          sourceInMs: 0,
          sourceOutMs: 8_000,
        }],
        linkedSliceIds: ['slice-drive'],
      }],
    }]);

    const { tracks, clips } = placeClips(script, slices, assets);
    const dialogueTrack = tracks.find(track => track.role === 'dialogue');
    const dialogueClips = clips.filter(clip => clip.trackId === dialogueTrack?.id);

    expect(dialogueClips).toHaveLength(2);
    expect(dialogueClips[0]).toMatchObject({
      sourceInMs: 880,
      sourceOutMs: 2_680,
      timelineInMs: 0,
      timelineOutMs: 1_800,
      audioSource: 'embedded',
    });
    expect(dialogueClips[1]).toMatchObject({
      sourceInMs: 5_380,
      sourceOutMs: 6_680,
      timelineInMs: 1_800,
      timelineOutMs: 3_100,
      audioSource: 'embedded',
    });
  });

  it('keeps the original source window when preserveNatSound beats have no transcript overlap', () => {
    const assets: IKtepAsset[] = [{
      id: 'asset-ambient',
      kind: 'video',
      sourcePath: 'ambient.mp4',
      displayName: 'ambient.mp4',
      metadata: {
        hasAudioStream: true,
        audioStreamCount: 1,
      },
    }];
    const slices: IKtepSlice[] = [{
      id: 'slice-ambient',
      assetId: 'asset-ambient',
      type: 'broll',
      sourceInMs: 1_000,
      sourceOutMs: 3_600,
      labels: [],
      placeHints: [],
    }];
    const script: IKtepScript[] = createTestScript([{
      id: 'segment-1',
      role: 'scene',
      narration: 'ignored',
      targetDurationMs: 2_600,
      linkedSliceIds: ['slice-ambient'],
      beats: [{
        id: 'beat-1',
        text: '风声和路噪就够了。',
        targetDurationMs: 2_600,
        actions: {
          preserveNatSound: true,
        },
        selections: [{
          assetId: 'asset-ambient',
          sliceId: 'slice-ambient',
          sourceInMs: 1_000,
          sourceOutMs: 3_600,
        }],
        linkedSliceIds: ['slice-ambient'],
      }],
    }]);

    const { tracks, clips } = placeClips(script, slices, assets);
    const primaryTrack = tracks.find(track => track.role === 'primary');
    const dialogueTrack = tracks.find(track => track.role === 'dialogue');
    const videoClip = clips.find(clip => clip.trackId === primaryTrack?.id);
    const audioClip = dialogueTrack
      ? clips.find(clip => clip.trackId === dialogueTrack.id)
      : undefined;

    expect(videoClip).toMatchObject({
      sourceInMs: 1_000,
      sourceOutMs: 3_600,
      timelineInMs: 0,
      timelineOutMs: 2_600,
    });
    expect(videoClip?.muteAudio).toBeUndefined();
    expect(audioClip).toBeUndefined();
  });

  it('routes protected sidecar audio onto a nat track when report prefers fallback', () => {
    const assets: IKtepAsset[] = [{
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
    }];
    const slices: IKtepSlice[] = [{
      id: 'slice-talk',
      assetId: 'asset-talk',
      type: 'talking-head',
      sourceInMs: 0,
      sourceOutMs: 1_800,
      transcriptSegments: [{
        startMs: 0,
        endMs: 1_800,
        text: '这是现场原话',
      }],
      labels: [],
      placeHints: [],
    }];
    const script: IKtepScript[] = createTestScript([{
      id: 'segment-1',
      role: 'scene',
      narration: 'ignored',
      targetDurationMs: 1_800,
      linkedSliceIds: ['slice-talk'],
      beats: [{
        id: 'beat-1',
        text: '这是现场原话',
        actions: {
          preserveNatSound: true,
        },
        selections: [{
          assetId: 'asset-talk',
          sliceId: 'slice-talk',
          sourceInMs: 0,
          sourceOutMs: 1_800,
        }],
        linkedSliceIds: ['slice-talk'],
      }],
    }]);

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

    const natTrack = tracks.find(track => track.role === 'nat');
    const dialogueTrack = tracks.find(track => track.role === 'dialogue');
    const natClip = clips.find(clip => clip.trackId === natTrack?.id);
    const videoClip = clips.find(clip => clip.trackId !== natTrack?.id);

    expect(dialogueTrack).toBeUndefined();
    expect(natTrack).toBeDefined();
    expect(videoClip).toMatchObject({
      assetId: 'asset-talk',
      muteAudio: true,
      timelineInMs: 0,
      timelineOutMs: 1_800,
    });
    expect(natClip).toMatchObject({
      assetId: 'asset-talk',
      audioSource: 'protection',
      timelineInMs: 0,
      timelineOutMs: 1_800,
      sourceInMs: 0,
      sourceOutMs: 1_800,
    });
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
    const script: IKtepScript[] = createTestScript([{
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
    }]);

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

    expect(clips.filter((clip: IKtepClip) => clip.audioSource == null).map(clip => clip.assetId))
      .toEqual(['asset-video', 'asset-photo']);
  });
});
