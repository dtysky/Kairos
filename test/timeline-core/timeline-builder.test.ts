import { describe, expect, it } from 'vitest';
import type { IKtepAsset, IKtepProject, IKtepScript, IKtepSlice } from '../../src/protocol/schema.js';
import { buildTimeline, resolveTimelineBuildConfig } from '../../src/modules/timeline-core/timeline-builder.js';

const CPROJECT: IKtepProject = {
  id: 'project-1',
  name: 'Timeline Build Test',
  createdAt: '2026-04-02T00:00:00.000Z',
  updatedAt: '2026-04-02T00:00:00.000Z',
};

const CASSETS: IKtepAsset[] = [{
  id: 'asset-1',
  kind: 'video',
  sourcePath: 'drive.mp4',
  displayName: 'drive.mp4',
}];

const CSLICES: IKtepSlice[] = [{
  id: 'slice-1',
  assetId: 'asset-1',
  type: 'drive',
  sourceInMs: 0,
  sourceOutMs: 1000,
  labels: [],
  placeHints: [],
}];

const CSCRIPT: IKtepScript[] = [{
  id: 'segment-1',
  role: 'scene',
  narration: '短句。',
  targetDurationMs: 1000,
  linkedSliceIds: ['slice-1'],
  beats: [{
    id: 'beat-1',
    text: '短句。',
    actions: {
      muteSource: true,
    },
    selections: [{
      assetId: 'asset-1',
      sliceId: 'slice-1',
      sourceInMs: 0,
      sourceOutMs: 1000,
    }],
    linkedSliceIds: ['slice-1'],
  }],
}];

describe('buildTimeline output spec', () => {
  it('defaults to 4K 30fps', () => {
    const doc = buildTimeline(CPROJECT, CASSETS, CSLICES, CSCRIPT, {
      name: 'Default Output',
    });

    expect(doc.timeline.resolution).toEqual({
      width: 3840,
      height: 2160,
    });
    expect(doc.timeline.fps).toBe(30);
  });

  it('applies runtime-configured output spec overrides', () => {
    const config = resolveTimelineBuildConfig({
      timelineWidth: 1920,
      timelineHeight: 1080,
      timelineFps: 24,
    }, {
      name: 'Configured Output',
    });
    const doc = buildTimeline(CPROJECT, CASSETS, CSLICES, CSCRIPT, config);

    expect(doc.timeline.resolution).toEqual({
      width: 1920,
      height: 1080,
    });
    expect(doc.timeline.fps).toBe(24);
  });
});
