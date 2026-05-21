import { describe, expect, it } from 'vitest';
import { buildDeterministicTimeline } from '../../src/modules/timeline-core/project-timeline.js';
import type {
  IChronologyEvent,
  IKtepAsset,
  IKtepProject,
  IKtepSpan,
  IMaterialSlotsDocument,
} from '../../src/protocol/schema.js';

describe('timeline material slot treatments', () => {
  it('applies default audio and speed when treatment entries are omitted', () => {
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
        name: 'Sparse Treatment Timeline',
        stillDurationMs: 5000,
      },
      ingestRoots: [],
    });

    const clip = build.doc.timeline.clips[0];
    expect(clip).toMatchObject({
      spanId: 'span-talk',
      audioGainDb: 0,
    });
    expect(clip?.muteAudio).toBeUndefined();
    expect(build.resolveClips[0]).toMatchObject({
      spanId: 'span-talk',
      audioGainDb: 0,
      muteAudio: false,
      requestedSpeed: 1,
    });
  });
});

const PROJECT: IKtepProject = {
  id: 'project-1',
  name: 'Timeline Sparse Treatment Fixture',
  createdAt: '2026-05-21T00:00:00.000Z',
  updatedAt: '2026-05-21T00:00:00.000Z',
};

const ASSETS: IKtepAsset[] = [{
  id: 'asset-talk',
  kind: 'video',
  sourcePath: '/tmp/kairos-sparse-treatment-talk.mp4',
  displayName: 'talk.mp4',
  durationMs: 5000,
  fps: 30,
}];

const SPANS: IKtepSpan[] = [{
  id: 'span-talk',
  assetId: 'asset-talk',
  type: 'talking-head',
  semanticKind: 'speech',
  sourceInMs: 0,
  sourceOutMs: 2000,
  transcript: '默认音量保留。',
  transcriptSegments: [{ startMs: 0, endMs: 1200, text: '默认音量保留。' }],
  materialPatterns: ['车内口播', '道路', '晴天', '有口播语音'],
}];

const MATERIAL_SLOTS: IMaterialSlotsDocument = {
  id: 'slots-1',
  projectId: 'project-1',
  generatedAt: '2026-05-21T00:00:00.000Z',
  segments: [{
    segmentId: 'fw-1',
    slots: [{
      id: 'slot-1',
      query: '默认保留原声',
      requirement: 'required',
      targetBundles: [],
      chosenSpanIds: ['span-talk'],
      treatments: {},
    }],
  }],
};

const EVENTS: IChronologyEvent[] = [{
  id: 'event-1',
  kind: 'event',
  reviewStatus: 'confirmed',
  title: '默认原声',
  startAt: '2026-05-21T00:00:00.000Z',
  spanIds: ['span-talk'],
}];
