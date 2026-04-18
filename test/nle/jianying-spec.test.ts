import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import type { IKtepDoc } from '../../src/protocol/schema.js';
import { buildJianyingDraftSpec } from '../../src/modules/nle/jianying.js';

const fixtureProjectRoot = fileURLToPath(
  new URL('../../projects/tmp-current-flow-test-20260401-160735', import.meta.url),
);
const fixtureTimelinePath = join(fixtureProjectRoot, 'timeline', 'current.json');

async function loadFixtureDoc(): Promise<IKtepDoc> {
  return JSON.parse(await readFile(fixtureTimelinePath, 'utf-8')) as IKtepDoc;
}

describe('buildJianyingDraftSpec', () => {
  it('resolves relative asset paths and emits a generated subtitle track', async () => {
    const doc = await loadFixtureDoc();
    const { spec, warnings } = await buildJianyingDraftSpec(doc, {
      projectRoot: fixtureProjectRoot,
    });

    expect(spec.project.name).toBe(doc.project.name);
    expect(spec.clips).toHaveLength(doc.timeline.clips.length);
    expect(spec.subtitles).toHaveLength(doc.subtitles?.length ?? 0);
    expect(spec.tracks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'text',
        name: 'subtitles',
        relativeIndex: 999,
      }),
    ]));

    expect(spec.clips[0]?.materialPath).toMatch(/^\/Users\/dtysky\/Downloads\/kairos-test\//u);

    const dissolveClip = spec.clips.find(clip => clip.transitionOut?.type === 'cross-dissolve');
    expect(dissolveClip?.transitionOut).toEqual({
      type: 'cross-dissolve',
      name: '叠化',
      durationMs: 800,
    });

    const kenBurnsClip = spec.clips.find(clip => clip.id === '5f520886-2cef-448c-9618-e5fd331ed87d');
    expect(kenBurnsClip?.clipSettings).toBeUndefined();
    expect(warnings.some(warning => /kenBurns/iu.test(warning))).toBe(true);
  });

  it('maps muted KTEP clips to zero-volume Jianying segments', async () => {
    const doc: IKtepDoc = {
      protocol: 'kairos.timeline',
      version: '2.0',
      project: {
        id: 'project-1',
        name: 'Muted Spec Test',
        createdAt: '2026-04-02T00:00:00.000Z',
        updatedAt: '2026-04-02T00:00:00.000Z',
      },
      assets: [{
        id: 'asset-1',
        kind: 'video',
        sourcePath: '/tmp/muted-spec-test.mp4',
        displayName: 'muted-spec-test.mp4',
      }],
      slices: [],
      script: [],
      timeline: {
        id: 'timeline-1',
        name: 'Muted Timeline',
        fps: 30,
        resolution: {
          width: 3840,
          height: 2160,
        },
        tracks: [{
          id: 'track-1',
          kind: 'video',
          role: 'primary',
          index: 0,
        }],
        clips: [{
          id: 'clip-1',
          trackId: 'track-1',
          assetId: 'asset-1',
          timelineInMs: 0,
          timelineOutMs: 1000,
          muteAudio: true,
        }],
      },
      subtitles: [],
    };

    const { spec } = await buildJianyingDraftSpec(doc);

    expect(spec.clips[0]).toMatchObject({
      volume: 0,
    });
  });

  it('maps clip-level audioGainDb to Jianying linear volume', async () => {
    const doc: IKtepDoc = {
      protocol: 'kairos.timeline',
      version: '2.0',
      project: {
        id: 'project-audio',
        name: 'Audio Gain Spec Test',
        createdAt: '2026-04-18T00:00:00.000Z',
        updatedAt: '2026-04-18T00:00:00.000Z',
      },
      assets: [{
        id: 'asset-audio',
        kind: 'audio',
        sourcePath: '/tmp/dialogue.wav',
        displayName: 'dialogue.wav',
      }],
      slices: [],
      script: [],
      timeline: {
        id: 'timeline-audio',
        name: 'Audio Gain Timeline',
        fps: 30,
        resolution: {
          width: 3840,
          height: 2160,
        },
        tracks: [{
          id: 'track-dialogue',
          kind: 'audio',
          role: 'dialogue',
          index: 0,
        }],
        clips: [{
          id: 'clip-dialogue',
          trackId: 'track-dialogue',
          assetId: 'asset-audio',
          timelineInMs: 0,
          timelineOutMs: 1000,
          sourceInMs: 0,
          sourceOutMs: 1000,
          audioGainDb: -6,
        }],
      },
      subtitles: [],
    };

    const { spec } = await buildJianyingDraftSpec(doc);

    expect(spec.clips[0]).toMatchObject({
      kind: 'audio',
      materialPath: '/tmp/dialogue.wav',
      volume: 0.5012,
    });
  });

  it('passes explicit clip speed through to Jianying specs', async () => {
    const doc: IKtepDoc = {
      protocol: 'kairos.timeline',
      version: '2.0',
      project: {
        id: 'project-2',
        name: 'Speed Spec Test',
        createdAt: '2026-04-02T00:00:00.000Z',
        updatedAt: '2026-04-02T00:00:00.000Z',
      },
      assets: [{
        id: 'asset-1',
        kind: 'video',
        sourcePath: '/tmp/speed-spec-test.mp4',
        displayName: 'speed-spec-test.mp4',
      }],
      slices: [{
        id: 'slice-drive-1',
        assetId: 'asset-1',
        type: 'drive',
        sourceInMs: 0,
        sourceOutMs: 10_000,
        narrativeFunctions: {
          core: ['route-advance'],
          extra: [],
          evidence: [],
        },
        shotGrammar: {
          core: ['windshield-drive'],
          extra: [],
          evidence: [],
        },
        viewpointRoles: {
          core: ['driving-selfie'],
          extra: [],
          evidence: [],
        },
        subjectStates: {
          core: ['en-route'],
          extra: [],
          evidence: [],
        },
        grounding: {
          speechMode: 'none',
          speechValue: 'none',
          spatialEvidence: [],
          pharosRefs: [],
        },
      }],
      script: [],
      timeline: {
        id: 'timeline-2',
        name: 'Speed Timeline',
        fps: 30,
        resolution: {
          width: 3840,
          height: 2160,
        },
        tracks: [{
          id: 'track-1',
          kind: 'video',
          role: 'primary',
          index: 0,
        }],
        clips: [{
          id: 'clip-1',
          trackId: 'track-1',
          assetId: 'asset-1',
          sliceId: 'slice-drive-1',
          sourceInMs: 0,
          sourceOutMs: 10_000,
          speed: 5,
          timelineInMs: 0,
          timelineOutMs: 2_000,
        }],
      },
      subtitles: [],
    };

    const { spec } = await buildJianyingDraftSpec(doc);

    expect(spec.clips[0]).toMatchObject({
      sourceInMs: 0,
      sourceOutMs: 10_000,
      speed: 5,
      targetStartMs: 0,
      targetEndMs: 2_000,
    });
  });

  it('splits overlapping subtitles across multiple generated text tracks', async () => {
    const doc: IKtepDoc = {
      protocol: 'kairos.timeline',
      version: '2.0',
      project: {
        id: 'project-subtitles',
        name: 'Subtitle Lane Spec Test',
        createdAt: '2026-04-14T00:00:00.000Z',
        updatedAt: '2026-04-14T00:00:00.000Z',
      },
      assets: [],
      slices: [],
      script: [],
      timeline: {
        id: 'timeline-subtitles',
        name: 'Subtitle Lane Timeline',
        fps: 30,
        resolution: {
          width: 3840,
          height: 2160,
        },
        tracks: [],
        clips: [],
      },
      subtitles: [
        {
          id: 'subtitle-1',
          startMs: 0,
          endMs: 1_500,
          text: 'first',
        },
        {
          id: 'subtitle-2',
          startMs: 500,
          endMs: 1_000,
          text: 'second',
        },
        {
          id: 'subtitle-3',
          startMs: 1_500,
          endMs: 2_000,
          text: 'third',
        },
      ],
    };

    const { spec } = await buildJianyingDraftSpec(doc);
    const textTracks = spec.tracks.filter(track => track.kind === 'text');

    expect(textTracks).toHaveLength(2);
    expect(textTracks.map(track => track.name)).toEqual(['subtitles', 'subtitles-1']);
    expect(spec.subtitles).toEqual([
      expect.objectContaining({
        id: 'subtitle-1',
        trackName: 'subtitles',
        startMs: 0,
        endMs: 1_500,
      }),
      expect.objectContaining({
        id: 'subtitle-3',
        trackName: 'subtitles',
        startMs: 1_500,
        endMs: 2_000,
      }),
      expect.objectContaining({
        id: 'subtitle-2',
        trackName: 'subtitles-1',
        startMs: 500,
        endMs: 1_000,
      }),
    ]);
  });

  it('exports protected nat audio clips from a bound video asset', async () => {
    const doc: IKtepDoc = {
      protocol: 'kairos.timeline',
      version: '2.0',
      project: {
        id: 'project-3',
        name: 'Protected Audio Spec Test',
        createdAt: '2026-04-03T00:00:00.000Z',
        updatedAt: '2026-04-03T00:00:00.000Z',
      },
      assets: [{
        id: 'asset-video',
        kind: 'video',
        sourcePath: '/tmp/protected-audio-video.mp4',
        displayName: 'protected-audio-video.mp4',
        protectionAudio: {
          sourcePath: '/tmp/protected-audio-video.wav',
          displayName: 'protected-audio-video.wav',
          alignment: 'exact',
        },
      }],
      slices: [],
      script: [],
      timeline: {
        id: 'timeline-3',
        name: 'Protected Audio Timeline',
        fps: 30,
        resolution: {
          width: 3840,
          height: 2160,
        },
        tracks: [
          {
            id: 'track-video',
            kind: 'video',
            role: 'primary',
            index: 0,
          },
          {
            id: 'track-audio',
            kind: 'audio',
            role: 'nat',
            index: 0,
          },
        ],
        clips: [
          {
            id: 'clip-video',
            trackId: 'track-video',
            assetId: 'asset-video',
            timelineInMs: 0,
            timelineOutMs: 1500,
            sourceInMs: 0,
            sourceOutMs: 1500,
            muteAudio: true,
          },
          {
            id: 'clip-audio',
            trackId: 'track-audio',
            assetId: 'asset-video',
            timelineInMs: 0,
            timelineOutMs: 1500,
            sourceInMs: 0,
            sourceOutMs: 1500,
            audioSource: 'protection',
          },
        ],
      },
      subtitles: [],
    };

    const { spec } = await buildJianyingDraftSpec(doc);
    const audioClip = spec.clips.find(clip => clip.id === 'clip-audio');
    const videoClip = spec.clips.find(clip => clip.id === 'clip-video');

    expect(videoClip).toMatchObject({
      kind: 'video',
      materialPath: '/tmp/protected-audio-video.mp4',
      volume: 0,
    });
    expect(audioClip).toMatchObject({
      kind: 'audio',
      materialPath: '/tmp/protected-audio-video.wav',
      targetStartMs: 0,
      targetEndMs: 1500,
    });
  });
});
