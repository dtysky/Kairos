import { describe, expect, it } from 'vitest';
import {
  buildDeterministicTimeline,
  buildTimelineSourceSpeechSubtitles,
} from '../../src/modules/timeline-core/project-timeline.js';
import type {
  IChronologyEvent,
  IKtepAsset,
  IKtepProject,
  IKtepSpan,
  IMaterialSlotsDocument,
} from '../../src/protocol/schema.js';

describe('timeline speech source handles', () => {
  it('expands audible speech clips without stretching source-speech subtitles', () => {
    const build = buildDeterministicTimeline({
      project: PROJECT,
      editId: 'main',
      assets: ASSETS,
      spans: SPANS,
      materialSlots: MATERIAL_SLOTS,
      chronologyEvents: EVENTS,
      cfg: {
        fps: 30,
        width: 1920,
        height: 1080,
        name: 'Speech Handle Timeline',
        stillDurationMs: 1000,
      },
      ingestRoots: [],
    });

    const speechClip = build.doc.timeline.clips[0];
    expect(speechClip).toMatchObject({
      spanId: 'span-speech',
      sourceInMs: 760,
      sourceOutMs: 3500,
      timelineInMs: 0,
      timelineOutMs: 2740,
    });
    expect(build.resolveClips[0]).toMatchObject({
      spanId: 'span-speech',
      sourceInMs: 760,
      sourceOutMs: 3500,
    });

    const visualClip = build.doc.timeline.clips[1];
    expect(visualClip).toMatchObject({
      spanId: 'span-visual',
      sourceInMs: 500,
      sourceOutMs: 1500,
      timelineInMs: 2740,
      timelineOutMs: 3740,
    });

    const subtitles = buildTimelineSourceSpeechSubtitles({
      clips: build.doc.timeline.clips,
      spans: build.doc.spans,
    });
    expect(subtitles).toEqual([{
      id: 'subtitle-source-speech-00001',
      startMs: 340,
      endMs: 2240,
      text: '句尾要留住',
      language: undefined,
      linkedScriptSegmentId: 'fw-1',
      linkedScriptBeatId: 'slot-1',
    }]);
  });

  it('packs selected photos at the tail of their chronology event', () => {
    const assets: IKtepAsset[] = [
      ...ASSETS,
      {
        id: 'asset-photo',
        kind: 'photo',
        sourcePath: '/tmp/kairos-event-photo.jpg',
        displayName: 'event-photo.jpg',
      },
    ];
    const spans: IKtepSpan[] = [
      ...SPANS,
      {
        id: 'span-photo',
        assetId: 'asset-photo',
        type: 'photo',
        sourceInMs: 0,
        sourceOutMs: 0,
        visualObservation: 'A still photo from the same event.',
        materialPatterns: ['固定机位观察', '现场环境', '阴天', '无口播语音'],
      },
    ];
    const materialSlots: IMaterialSlotsDocument = {
      id: 'slots-photo-tail',
      projectId: 'project-1',
      generatedAt: '2026-05-27T00:00:00.000Z',
      segments: [{
        segmentId: 'fw-photo-tail',
        slots: [{
          id: 'slot-photo-tail',
          query: '同事件照片后置',
          requirement: 'required',
          targetBundles: [],
          chosenSpanIds: ['span-photo', 'span-speech', 'span-visual'],
          treatments: {
            'span-photo': { audio: -100 },
          },
        }],
      }],
    };
    const events: IChronologyEvent[] = [{
      id: 'event-photo-tail',
      kind: 'event',
      reviewStatus: 'confirmed',
      title: '照片后置事件',
      startAt: '2026-05-27T00:00:00.000Z',
      spanIds: ['span-speech', 'span-visual', 'span-photo'],
    }];

    const build = buildDeterministicTimeline({
      project: PROJECT,
      editId: 'main',
      assets,
      spans,
      materialSlots,
      chronologyEvents: events,
      cfg: {
        fps: 30,
        width: 1920,
        height: 1080,
        name: 'Photo Tail Timeline',
        stillDurationMs: 1000,
      },
      ingestRoots: [],
    });

    expect(build.doc.timeline.clips.map(clip => clip.spanId)).toEqual([
      'span-speech',
      'span-visual',
      'span-photo',
    ]);
    const photoClip = build.doc.timeline.clips[2];
    expect(photoClip).toMatchObject({
      spanId: 'span-photo',
      timelineInMs: 3740,
      timelineOutMs: 4740,
      sourceInMs: 0,
      sourceOutMs: 1000,
      muteAudio: true,
    });
    expect(build.resolveClips.map(clip => clip.spanId)).toEqual([
      'span-speech',
      'span-visual',
      'span-photo',
    ]);
    expect(build.resolveClips[2]).toMatchObject({
      assetKind: 'photo',
      muteAudio: true,
      sourceInMs: 0,
      sourceOutMs: 1000,
    });
  });
});

const PROJECT: IKtepProject = {
  id: 'project-1',
  name: 'Timeline Speech Handle Fixture',
  createdAt: '2026-05-27T00:00:00.000Z',
  updatedAt: '2026-05-27T00:00:00.000Z',
};

const ASSETS: IKtepAsset[] = [
  {
    id: 'asset-speech',
    kind: 'video',
    sourcePath: '/tmp/kairos-speech-handle.mp4',
    displayName: 'speech.mp4',
    durationMs: 3500,
    fps: 30,
  },
  {
    id: 'asset-visual',
    kind: 'video',
    sourcePath: '/tmp/kairos-visual-no-handle.mp4',
    displayName: 'visual.mp4',
    durationMs: 5000,
    fps: 30,
  },
];

const SPANS: IKtepSpan[] = [
  {
    id: 'span-speech',
    assetId: 'asset-speech',
    type: 'broll',
    semanticKind: 'speech',
    sourceInMs: 1000,
    sourceOutMs: 3000,
    transcript: '句尾要留住',
    transcriptSegments: [{ startMs: 1100, endMs: 3000, text: '句尾要留住' }],
    materialPatterns: ['固定机位观察', '现场环境', '阴天', '有口播语音'],
  },
  {
    id: 'span-visual',
    assetId: 'asset-visual',
    type: 'broll',
    semanticKind: 'visual',
    sourceInMs: 500,
    sourceOutMs: 1500,
    visualObservation: 'A short silent cutaway.',
    materialPatterns: ['固定机位观察', '现场环境', '阴天', '无口播语音'],
  },
];

const MATERIAL_SLOTS: IMaterialSlotsDocument = {
  id: 'slots-1',
  projectId: 'project-1',
  generatedAt: '2026-05-27T00:00:00.000Z',
  segments: [{
    segmentId: 'fw-1',
    slots: [{
      id: 'slot-1',
      query: '口播尾部需要余量',
      requirement: 'required',
      targetBundles: [],
      chosenSpanIds: ['span-speech', 'span-visual'],
      treatments: {},
    }],
  }],
};

const EVENTS: IChronologyEvent[] = [{
  id: 'event-1',
  kind: 'event',
  reviewStatus: 'confirmed',
  title: '口播余量',
  startAt: '2026-05-27T00:00:00.000Z',
  spanIds: ['span-speech', 'span-visual'],
}];
