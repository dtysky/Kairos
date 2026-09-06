import { describe, expect, it } from 'vitest';
import {
  rebaseDeterministicTimelineToResolvePlacements,
  selectDeterministicTimelineSuffix,
  type IDeterministicTimelineBuild,
} from '../../src/modules/timeline-core/project-timeline.js';
import type { IResolveRoughCutTimelineResult } from '../../src/modules/timeline-core/resolve-rough-cut.js';

function createBuild(): IDeterministicTimelineBuild {
  return {
    timelineName: 'Main [main]',
    resolveProjectName: 'Project [Edit]',
    resolveClips: [
      {
        clipId: 'clip-00001',
        assetId: 'asset-1',
        assetKind: 'video',
        sourceAbsolutePath: 'H:/media/one.mp4',
        sourceStem: 'one',
        timelineInMs: 0,
        timelineOutMs: 267,
        audioGainDb: 0,
        muteAudio: false,
        speed: 1,
      },
      {
        clipId: 'clip-00002',
        assetId: 'asset-2',
        assetKind: 'video',
        sourceAbsolutePath: 'H:/media/two.mp4',
        sourceStem: 'two',
        timelineInMs: 267,
        timelineOutMs: 12_800,
        audioGainDb: 0,
        muteAudio: false,
        speed: 1,
      },
    ],
    doc: {
      protocol: 'ktep',
      version: '1.0',
      project: {
        id: 'project',
        name: 'Project',
        createdAt: '2026-09-06T00:00:00.000Z',
        updatedAt: '2026-09-06T00:00:00.000Z',
      },
      assets: [],
      spans: [],
      slices: [],
      timeline: {
        id: 'timeline',
        name: 'Main [main]',
        fps: 30,
        resolution: { width: 3840, height: 2160 },
        tracks: [{ id: 'v1', kind: 'video', role: 'primary', index: 1 }],
        clips: [
          {
            id: 'clip-00001',
            trackId: 'v1',
            assetId: 'asset-1',
            sourceInMs: 0,
            sourceOutMs: 250,
            timelineInMs: 0,
            timelineOutMs: 267,
            audioGainDb: 0,
          },
          {
            id: 'clip-00002',
            trackId: 'v1',
            assetId: 'asset-2',
            sourceInMs: 0,
            sourceOutMs: 12_523,
            timelineInMs: 267,
            timelineOutMs: 12_800,
            audioGainDb: 0,
          },
        ],
      },
      subtitles: [],
    },
  } as IDeterministicTimelineBuild;
}

function createResolveResult(
  placements: Array<{ clipId: string; actualStartFrame: number; actualEndFrame: number }>,
  subtitleImport?: Record<string, unknown>,
): IResolveRoughCutTimelineResult {
  return {
    resolveProjectName: 'Project [Edit]',
    timelineName: 'Main [main]',
    createdAt: '2026-09-06T00:00:00.000Z',
    clipCount: placements.length,
    hostSummary: {
      clips: placements,
      ...(subtitleImport ? { subtitleImport } : {}),
    },
  };
}

describe('Resolve actual-frame timeline reconciliation', () => {
  it('selects only host-confirmed suffix clips after the preserved playhead anchor', () => {
    const build = createBuild();
    const selected = selectDeterministicTimelineSuffix(build, {
      ...createResolveResult([{ clipId: 'clip-00002', actualStartFrame: 2444, actualEndFrame: 2818 }]),
      hostSummary: {
        clips: [{ clipId: 'clip-00002', actualStartFrame: 2444, actualEndFrame: 2818 }],
        resume: {
          anchorClipId: 'clip-00001',
          currentTimecode: '00:01:16:04',
          playheadFrame: 2284,
          preserveThroughFrame: 2444,
          deletedItemCount: 3,
          appendedClipIds: ['clip-00002'],
        },
      },
    });

    expect(selected.doc.timeline.clips.map(clip => clip.id)).toEqual(['clip-00002']);
    expect(selected.resolveClips.map(clip => clip.clipId)).toEqual(['clip-00002']);
  });

  it('rebases KTEP and Resolve requests to actual returned frames', () => {
    const result = rebaseDeterministicTimelineToResolvePlacements({
      build: createBuild(),
      resolveTimeline: createResolveResult([
        { clipId: 'clip-00001', actualStartFrame: 0, actualEndFrame: 7 },
        { clipId: 'clip-00002', actualStartFrame: 7, actualEndFrame: 381 },
      ]),
      fps: 30,
    });

    expect(result.build.doc.timeline.clips.map(clip => [clip.timelineInMs, clip.timelineOutMs])).toEqual([
      [0, 233],
      [233, 12_700],
    ]);
    expect(result.build.resolveClips.map(clip => [clip.timelineInMs, clip.timelineOutMs])).toEqual([
      [0, 233],
      [233, 12_700],
    ]);
    expect(result).toMatchObject({
      plannedDurationMs: 12_800,
      actualDurationMs: 12_700,
      durationDeltaMs: -100,
    });
  });

});
