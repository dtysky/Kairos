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
      sourceInMs: 850,
      sourceOutMs: 3250,
      timelineInMs: 0,
      timelineOutMs: 2400,
    });
    expect(build.resolveClips[0]).toMatchObject({
      spanId: 'span-speech',
      sourceInMs: 850,
      sourceOutMs: 3250,
    });

    const visualClip = build.doc.timeline.clips[1];
    expect(visualClip).toMatchObject({
      spanId: 'span-visual',
      sourceInMs: 500,
      sourceOutMs: 1500,
      timelineInMs: 2400,
      timelineOutMs: 3400,
    });

    const subtitles = buildTimelineSourceSpeechSubtitles({
      clips: build.doc.timeline.clips,
      spans: build.doc.spans,
    });
    expect(subtitles).toEqual([{
      id: 'subtitle-source-speech-00001',
      startMs: 250,
      endMs: 2150,
      text: '句尾要留住',
      language: undefined,
      linkedScriptSegmentId: 'fw-1',
      linkedScriptBeatId: 'slot-1',
    }]);
  });

  it('uses aligned transcript timing ahead of wide edit and legacy loudness ranges', () => {
    const assets: IKtepAsset[] = [{
      id: 'C3239_zve1',
      kind: 'video',
      sourcePath: '/tmp/C3239.mp4',
      displayName: 'C3239.mp4',
      durationMs: 12_032,
      fps: 59.94,
    }];
    const spans: IKtepSpan[] = [{
      id: 'C3239_zve1_drive_speech_s1-6',
      assetId: 'C3239_zve1',
      type: 'drive',
      semanticKind: 'speech',
      sourceInMs: 1_260,
      sourceOutMs: 5_380,
      editSourceInMs: 0,
      editSourceOutMs: 6_130,
      effectiveSpeechStartMs: 0,
      effectiveSpeechEndMs: 6_130,
      transcript: '把金色的电线，金色信号塔。',
      transcriptSegments: [{
        startMs: 1_760,
        endMs: 4_480,
        text: '把金色的电线，金色信号塔。',
      }],
      materialPatterns: ['行车视角', '高速公路', '晴天', '有口播语音'],
    }];
    const materialSlots: IMaterialSlotsDocument = {
      id: 'slots-c3239',
      projectId: 'project-1',
      generatedAt: '2026-09-06T00:00:00.000Z',
      segments: [{
        segmentId: 'fw-c3239',
        slots: [{
          id: 'slot-c3239',
          query: '行车口播',
          requirement: 'required',
          targetBundles: [],
          chosenSpanIds: [spans[0]!.id],
          treatments: {},
        }],
      }],
    };
    const chronologyEvents: IChronologyEvent[] = [{
      id: 'event-c3239',
      kind: 'event',
      reviewStatus: 'confirmed',
      title: '行车口播',
      startAt: '2026-08-19T10:10:00.000Z',
      spanIds: [spans[0]!.id],
    }];

    const build = buildDeterministicTimeline({
      project: PROJECT,
      editId: 'main',
      assets,
      spans,
      materialSlots,
      chronologyEvents,
      cfg: {
        fps: 30,
        width: 1920,
        height: 1080,
        name: 'Aligned Speech Timing',
        stillDurationMs: 1000,
      },
      ingestRoots: [],
    });

    expect(build.doc.timeline.clips[0]).toMatchObject({
      sourceInMs: 1_510,
      sourceOutMs: 4_730,
    });
  });

  it('forces aerial clips to disable audio and excludes them from source-speech subtitles', () => {
    const assets: IKtepAsset[] = [
      {
        id: 'asset-aerial',
        kind: 'video',
        sourcePath: '/tmp/kairos-aerial.mp4',
        displayName: 'aerial.mp4',
        durationMs: 4000,
        fps: 30,
      },
    ];
    const spans: IKtepSpan[] = [{
      id: 'span-aerial',
      assetId: 'asset-aerial',
      type: 'aerial',
      semanticKind: 'speech',
      sourceInMs: 1000,
      sourceOutMs: 3000,
      transcript: '航拍风噪误识别',
      transcriptSegments: [{ startMs: 1100, endMs: 2200, text: '航拍风噪误识别' }],
      materialPatterns: ['航拍运动', '山谷', '晴天', '有口播语音'],
    }];
    const materialSlots: IMaterialSlotsDocument = {
      id: 'slots-aerial',
      projectId: 'project-1',
      generatedAt: '2026-05-27T00:00:00.000Z',
      segments: [{
        segmentId: 'fw-aerial',
        slots: [{
          id: 'slot-aerial',
          query: '航拍素材',
          requirement: 'required',
          targetBundles: [],
          chosenSpanIds: ['span-aerial'],
          treatments: {},
        }],
      }],
    };
    const events: IChronologyEvent[] = [{
      id: 'event-aerial',
      kind: 'event',
      reviewStatus: 'confirmed',
      title: '航拍段落',
      startAt: '2026-05-27T00:00:00.000Z',
      spanIds: ['span-aerial'],
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
        name: 'Aerial Audio Disabled Timeline',
        stillDurationMs: 1000,
      },
      ingestRoots: [],
    });

    expect(build.doc.timeline.clips[0]).toMatchObject({
      spanId: 'span-aerial',
      sourceInMs: 1000,
      sourceOutMs: 3000,
      audioGainDb: -100,
      muteAudio: true,
    });
    expect(build.resolveClips[0]).toMatchObject({
      spanId: 'span-aerial',
      spanType: 'aerial',
      audioGainDb: -100,
      muteAudio: true,
    });
    expect(buildTimelineSourceSpeechSubtitles({
      clips: build.doc.timeline.clips,
      spans: build.doc.spans,
    })).toEqual([]);
  });

  it('subtracts selected speech from legacy visual clips while preserving base clip numbering', () => {
    const assets: IKtepAsset[] = [{
      id: 'asset-overlap',
      kind: 'video',
      sourcePath: '/tmp/kairos-overlap.mp4',
      displayName: 'overlap.mp4',
      durationMs: 70_000,
      fps: 30,
    }];
    const spans: IKtepSpan[] = [
      {
        id: 'span-overlap-visual',
        assetId: 'asset-overlap',
        type: 'drive',
        semanticKind: 'visual',
        sourceInMs: 0,
        sourceOutMs: 70_000,
        visualObservation: '连续行车画面。',
        materialPatterns: ['第一人称行车', '公路', '自然光', '无口播语音'],
      },
      {
        id: 'span-overlap-speech',
        assetId: 'asset-overlap',
        type: 'drive',
        semanticKind: 'speech',
        sourceInMs: 15_000,
        sourceOutMs: 55_000,
        transcript: '中间是一段口播。',
        transcriptSegments: [{ startMs: 15_250, endMs: 54_750, text: '中间是一段口播。' }],
        materialPatterns: ['第一人称行车', '公路', '自然光', '有口播语音'],
      },
    ];
    const materialSlots: IMaterialSlotsDocument = {
      id: 'slots-overlap',
      projectId: 'project-1',
      generatedAt: '2026-09-06T00:00:00.000Z',
      segments: [{
        segmentId: 'fw-overlap',
        slots: [{
          id: 'slot-overlap',
          query: '同源口播与视觉窗口',
          requirement: 'required',
          targetBundles: [],
          chosenSpanIds: spans.map(span => span.id),
          treatments: {},
        }],
      }],
    };
    const events: IChronologyEvent[] = [{
      id: 'event-overlap',
      kind: 'event',
      reviewStatus: 'confirmed',
      title: '同源窗口',
      startAt: '2026-09-06T00:00:00.000Z',
      spanIds: spans.map(span => span.id),
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
        name: 'Overlap Compatibility Timeline',
        stillDurationMs: 1000,
      },
      ingestRoots: [],
    });

    expect(build.resolveClips.map(clip => ({
      clipId: clip.clipId,
      spanId: clip.spanId,
      sourceInMs: clip.sourceInMs,
      sourceOutMs: clip.sourceOutMs,
    }))).toEqual([
      {
        clipId: 'clip-00001-r01',
        spanId: 'span-overlap-visual',
        sourceInMs: 0,
        sourceOutMs: 15_000,
      },
      {
        clipId: 'clip-00001-r02',
        spanId: 'span-overlap-visual',
        sourceInMs: 55_000,
        sourceOutMs: 70_000,
      },
      {
        clipId: 'clip-00002',
        spanId: 'span-overlap-speech',
        sourceInMs: 15_000,
        sourceOutMs: 55_000,
      },
    ]);
  });

  it('does not renumber later clips when a legacy visual clip is fully removed', () => {
    const assets: IKtepAsset[] = [{
      id: 'asset-covered',
      kind: 'video',
      sourcePath: '/tmp/kairos-covered.mp4',
      displayName: 'covered.mp4',
      durationMs: 20_000,
      fps: 30,
    }];
    const spans: IKtepSpan[] = [
      {
        id: 'span-covered-visual',
        assetId: 'asset-covered',
        type: 'broll',
        semanticKind: 'visual',
        sourceInMs: 0,
        sourceOutMs: 20_000,
        visualObservation: '与口播完全重合的画面。',
        materialPatterns: ['固定机位', '车内', '自然光', '无口播语音'],
      },
      {
        id: 'span-covering-speech',
        assetId: 'asset-covered',
        type: 'broll',
        semanticKind: 'speech',
        sourceInMs: 0,
        sourceOutMs: 20_000,
        transcript: '整段口播。',
        transcriptSegments: [{ startMs: 250, endMs: 19_750, text: '整段口播。' }],
        materialPatterns: ['固定机位', '车内', '自然光', '有口播语音'],
      },
    ];
    const materialSlots: IMaterialSlotsDocument = {
      id: 'slots-covered',
      projectId: 'project-1',
      generatedAt: '2026-09-06T00:00:00.000Z',
      segments: [{
        segmentId: 'fw-covered',
        slots: [{
          id: 'slot-covered',
          query: '完全重合',
          requirement: 'required',
          targetBundles: [],
          chosenSpanIds: spans.map(span => span.id),
          treatments: {},
        }],
      }],
    };
    const events: IChronologyEvent[] = [{
      id: 'event-covered',
      kind: 'event',
      reviewStatus: 'confirmed',
      title: '完全重合',
      startAt: '2026-09-06T00:00:00.000Z',
      spanIds: spans.map(span => span.id),
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
        name: 'Covered Visual Timeline',
        stillDurationMs: 1000,
      },
      ingestRoots: [],
    });

    expect(build.resolveClips).toHaveLength(1);
    expect(build.resolveClips[0]).toMatchObject({
      clipId: 'clip-00002',
      spanId: 'span-covering-speech',
      sourceInMs: 0,
      sourceOutMs: 20_000,
    });
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
      timelineInMs: 3400,
      timelineOutMs: 4400,
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
