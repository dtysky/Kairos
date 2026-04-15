import { describe, expect, it } from 'vitest';
import { planSubtitles } from '../../src/modules/timeline-core/subtitle.js';
import type {
  IKtepClip,
  IKtepScript,
  IKtepSlice,
} from '../../src/protocol/schema.js';

describe('source-speech subtitle planning', () => {
  it('keeps a refined source-speech cue intact when it is already subtitle-sized', () => {
    const script: IKtepScript[] = [{
      id: 'seg-1',
      role: 'scene',
      narration: undefined,
      beats: [{
        id: 'beat-1',
        text: '',
        selections: [],
        linkedSpanIds: [],
        linkedSliceIds: ['slice-1'],
      }],
      linkedSpanIds: [],
      linkedSliceIds: ['slice-1'],
    }];
    const clips: IKtepClip[] = [{
      id: 'clip-1',
      trackId: 'video-1',
      assetId: 'asset-1',
      sliceId: 'slice-1',
      sourceInMs: 0,
      sourceOutMs: 2200,
      timelineInMs: 0,
      timelineOutMs: 2200,
      linkedScriptSegmentId: 'seg-1',
      linkedScriptBeatId: 'beat-1',
    }];
    const slices: IKtepSlice[] = [{
      id: 'slice-1',
      assetId: 'asset-1',
      type: 'talking-head',
      sourceInMs: 0,
      sourceOutMs: 2200,
      transcriptSegments: [{
        startMs: 0,
        endMs: 2200,
        text: '我们先去码头。然后上船',
      }],
      materialPatterns: [],
      grounding: {
        speechMode: 'none',
        speechValue: 'none',
        spatialEvidence: [],
        pharosRefs: [],
      },
      narrativeFunctions: { core: [], extra: [], evidence: [] },
      shotGrammar: { core: [], extra: [], evidence: [] },
      viewpointRoles: { core: [], extra: [], evidence: [] },
      subjectStates: { core: [], extra: [], evidence: [] },
    }];

    const subtitles = planSubtitles(script, clips, slices, { maxCharsPerCue: 20 });
    expect(subtitles).toHaveLength(1);
    expect(subtitles[0]?.text).toBe('我们先去码头。然后上船');
    expect(subtitles[0]?.startMs).toBe(0);
    expect(subtitles[0]?.endMs).toBe(2200);
  });

  it('uses refined transcript segment boundaries instead of averaging across the whole beat', () => {
    const script: IKtepScript[] = [{
      id: 'seg-2',
      role: 'scene',
      narration: undefined,
      beats: [{
        id: 'beat-2',
        text: '',
        selections: [],
        linkedSpanIds: [],
        linkedSliceIds: ['slice-2'],
      }],
      linkedSpanIds: [],
      linkedSliceIds: ['slice-2'],
    }];
    const clips: IKtepClip[] = [{
      id: 'clip-2',
      trackId: 'video-1',
      assetId: 'asset-2',
      sliceId: 'slice-2',
      sourceInMs: 0,
      sourceOutMs: 3200,
      timelineInMs: 1000,
      timelineOutMs: 4200,
      linkedScriptSegmentId: 'seg-2',
      linkedScriptBeatId: 'beat-2',
    }];
    const slices: IKtepSlice[] = [{
      id: 'slice-2',
      assetId: 'asset-2',
      type: 'talking-head',
      sourceInMs: 0,
      sourceOutMs: 3200,
      transcriptSegments: [
        { startMs: 0, endMs: 1200, text: '先看码头' },
        { startMs: 1600, endMs: 3000, text: '然后上船' },
      ],
      materialPatterns: [],
      grounding: {
        speechMode: 'none',
        speechValue: 'none',
        spatialEvidence: [],
        pharosRefs: [],
      },
      narrativeFunctions: { core: [], extra: [], evidence: [] },
      shotGrammar: { core: [], extra: [], evidence: [] },
      viewpointRoles: { core: [], extra: [], evidence: [] },
      subjectStates: { core: [], extra: [], evidence: [] },
    }];

    const subtitles = planSubtitles(script, clips, slices, { maxCharsPerCue: 20 });
    expect(subtitles.map(subtitle => ({
      text: subtitle.text,
      startMs: subtitle.startMs,
      endMs: subtitle.endMs,
    }))).toEqual([
      { text: '先看码头', startMs: 1000, endMs: 2200 },
      { text: '然后上船', startMs: 2600, endMs: 4000 },
    ]);
  });
});
