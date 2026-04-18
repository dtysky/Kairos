import { describe, expect, it } from 'vitest';
import type { IKtepScript } from '../src/protocol/index.js';
import { buildDeterministicRoughCutBase } from '../src/modules/timeline-core/segment-cuts.js';
import { createChronology, createSelection, createSlice } from './helpers/fixtures.js';

describe('buildDeterministicRoughCutBase', () => {
  it('keeps silent drive beats at the default 2x speed suggestion', () => {
    const driveSelection = createSelection({
      assetId: 'asset-drive',
      spanId: 'slice-drive',
      sourceInMs: 500,
      sourceOutMs: 4_500,
    });
    const driveSlice = createSlice({
      id: 'slice-drive',
      assetId: 'asset-drive',
      type: 'drive',
      sourceInMs: 0,
      sourceOutMs: 5_000,
      editSourceInMs: 0,
      editSourceOutMs: 5_000,
      speedCandidate: {
        suggestedSpeeds: [2, 5],
        rationale: 'continuous-drive-window',
      },
    });
    const script: IKtepScript[] = [{
      id: 'segment-1',
      role: 'scene',
      title: 'Drive Segment',
      linkedSpanIds: ['slice-drive'],
      linkedSliceIds: ['slice-drive'],
      beats: [{
        id: 'drive-beat',
        text: 'Drive montage',
        audioSelections: [],
        visualSelections: [driveSelection],
        linkedSpanIds: ['slice-drive'],
        linkedSliceIds: ['slice-drive'],
      }],
    }];

    const roughCutBase = buildDeterministicRoughCutBase({
      projectId: 'project-1',
      script,
      slices: [driveSlice],
      chronology: [createChronology({
        id: 'chrono-drive',
        assetId: 'asset-drive',
        sortCapturedAt: '2026-04-18T00:00:00.000Z',
      })],
    });

    expect(roughCutBase.segments[0]?.lockedSpanIds).toEqual(['slice-drive']);
    expect(roughCutBase.segments[0]?.beats[0]?.speedSuggestion).toBe(2);
  });

  it('derives source-speech units and cue drafts from the locked speech window', () => {
    const speechSelection = createSelection({
      assetId: 'asset-talk',
      spanId: 'slice-talk',
      sourceInMs: 1_500,
      sourceOutMs: 3_500,
    });
    const speechSlice = createSlice({
      id: 'slice-talk',
      assetId: 'asset-talk',
      type: 'talking-head',
      sourceInMs: 1_000,
      sourceOutMs: 4_000,
      editSourceInMs: 1_000,
      editSourceOutMs: 4_000,
      transcript: 'Hello reviewed world',
      transcriptSegments: [{
        startMs: 1_500,
        endMs: 3_500,
        text: 'Hello reviewed world',
      }],
      grounding: {
        speechMode: 'available',
        speechValue: 'informative',
        spatialEvidence: [],
        pharosRefs: [],
      },
      speechCoverage: 0.8,
    });
    const script: IKtepScript[] = [{
      id: 'segment-1',
      role: 'scene',
      title: 'Speech Segment',
      linkedSpanIds: ['slice-talk'],
      linkedSliceIds: ['slice-talk'],
      beats: [{
        id: 'speech-beat',
        text: 'Narration fallback',
        audioSelections: [speechSelection],
        visualSelections: [speechSelection],
        linkedSpanIds: ['slice-talk'],
        linkedSliceIds: ['slice-talk'],
      }],
    }];

    const roughCutBase = buildDeterministicRoughCutBase({
      projectId: 'project-1',
      script,
      slices: [speechSlice],
      chronology: [createChronology({
        id: 'chrono-talk',
        assetId: 'asset-talk',
        sortCapturedAt: '2026-04-18T00:01:00.000Z',
      })],
    });

    const beat = roughCutBase.segments[0]?.beats[0];
    expect(beat?.sourceSpeechUnits).toEqual([{
      assetId: 'asset-talk',
      spanId: 'slice-talk',
      sliceId: 'slice-talk',
      sourceInMs: 1_500,
      sourceOutMs: 3_500,
      transcriptText: 'Hello reviewed world',
    }]);
    expect(beat?.subtitleCueDrafts[0]?.text).toBe('Hello reviewed world');
  });
});
