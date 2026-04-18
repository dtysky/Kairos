import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ISegmentRoughCutPlan, IKtepScript } from '../src/protocol/index.js';
import type { IJsonPacketAgentRunner, IJsonPacketAgentInvocation } from '../src/modules/agents/runtime.js';
import { buildProjectTimeline } from '../src/modules/timeline-core/project-timeline.js';
import {
  getAssetsPath,
  getSpansPath,
  initProject,
  loadTimelineAgentPipeline,
  loadTimelineRoughCutBase,
  loadTimelineSegmentCut,
  loadTimelineStageReview,
  writeChronology,
  writeCurrentScript,
  writeJson,
} from '../src/store/index.js';
import {
  createChronology,
  createSelection,
  createSlice,
  createVideoAsset,
} from './helpers/fixtures.js';

const cTempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(cTempRoots.splice(0).map(root =>
    rm(root, { recursive: true, force: true })));
});

describe('buildProjectTimeline', () => {
  it('writes the reviewed segment-cut pipeline artifacts and assembles timeline/current from them', async () => {
    const { projectRoot } = await createTimelineProjectFixture();
    const agentRunner: IJsonPacketAgentRunner = {
      async run<T>(input: IJsonPacketAgentInvocation): Promise<T> {
        if (input.promptId === 'timeline/segment-cut-refiner') {
          const base = input.packet.inputArtifacts
            .find(artifact => artifact.label === 'segment-rough-cut-base')
            ?.content as ISegmentRoughCutPlan | undefined;
          if (!base) {
            throw new Error('missing segment rough-cut base');
          }

          return {
            segmentId: base.segmentId,
            beats: base.beats.map(beat => beat.beatId === 'drive-beat'
              ? {
                beatId: beat.beatId,
                text: beat.text,
                notes: 'reviewed drive beat',
                speedSuggestion: 2,
                visualSelections: beat.visualSelections.map(selection => ({
                  ...selection,
                  sourceInMs: 1_000,
                  sourceOutMs: 3_000,
                })),
              }
              : {
                beatId: beat.beatId,
                text: beat.text,
                notes: 'reviewed speech beat',
                audioSelections: beat.audioSelections.map(selection => ({
                  ...selection,
                  sourceInMs: 2_400,
                  sourceOutMs: 4_200,
                })),
                visualSelections: beat.visualSelections.map(selection => ({
                  ...selection,
                  sourceInMs: 2_400,
                  sourceOutMs: 4_200,
                })),
                subtitleCueDrafts: [{
                  id: 'cue-reviewed',
                  text: 'Reviewed cue',
                  sourceInMs: 2_600,
                  sourceOutMs: 3_800,
                }],
              }),
          } as T;
        }
        if (input.promptId === 'timeline/segment-cut-reviewer') {
          return {
            verdict: 'pass',
            issues: [],
            revisionBrief: [],
          } as T;
        }
        throw new Error(`Unexpected promptId: ${input.promptId}`);
      },
    };

    const result = await buildProjectTimeline({
      projectRoot,
      agentRunner,
    });

    const roughCutBase = await loadTimelineRoughCutBase(projectRoot);
    const segmentCut = await loadTimelineSegmentCut(projectRoot, 'segment-1');
    const review = await loadTimelineStageReview(projectRoot, 'segment-1');
    const pipeline = await loadTimelineAgentPipeline(projectRoot);

    expect(roughCutBase?.segments).toHaveLength(1);
    expect(segmentCut?.beats).toHaveLength(2);
    expect(segmentCut?.beats[1]?.subtitleCueDrafts[0]?.text).toBe('Reviewed cue');
    expect(review?.verdict).toBe('pass');
    expect(pipeline?.stageStatus).toBe('completed');

    const driveClip = result.doc.timeline.clips.find(clip =>
      clip.linkedScriptBeatId === 'drive-beat' && clip.audioSource == null);
    const speechDialogueClip = result.doc.timeline.clips.find(clip =>
      clip.linkedScriptBeatId === 'speech-beat' && clip.audioSource === 'embedded');

    expect(driveClip?.speed).toBe(2);
    expect(driveClip?.sourceInMs).toBe(1_000);
    expect(driveClip?.sourceOutMs).toBe(3_000);
    expect(speechDialogueClip?.sourceInMs).toBe(2_400);
    expect(speechDialogueClip?.sourceOutMs).toBe(4_200);
    expect(result.doc.subtitles.map(subtitle => subtitle.text)).toContain('Reviewed cue');
  });

  it('records a blocking pipeline state when no formal packet runner is available', async () => {
    const { projectRoot } = await createTimelineProjectFixture();

    await expect(buildProjectTimeline({ projectRoot })).rejects.toThrow(
      /formal stage execution requires a host packet runner/i,
    );

    const roughCutBase = await loadTimelineRoughCutBase(projectRoot);
    const pipeline = await loadTimelineAgentPipeline(projectRoot);

    expect(roughCutBase?.segments).toHaveLength(1);
    expect(pipeline).toMatchObject({
      currentStage: 'segment-cut-init',
      stageStatus: 'awaiting_user',
      latestReviewResult: 'runner_unavailable',
    });
    expect(pipeline?.blockerSummary[0]).toMatch(/formal stage execution requires a host packet runner/i);
  });
});

async function createTimelineProjectFixture(): Promise<{ projectRoot: string; script: IKtepScript[] }> {
  const projectRoot = await mkdtemp(join(tmpdir(), 'kairos-project-timeline-'));
  cTempRoots.push(projectRoot);
  await initProject(projectRoot, 'Timeline Fixture');

  const driveSelection = createSelection({
    assetId: 'asset-drive',
    spanId: 'slice-drive',
    sourceInMs: 1_500,
    sourceOutMs: 3_500,
  });
  const speechSelection = createSelection({
    assetId: 'asset-talk',
    spanId: 'slice-talk',
    sourceInMs: 2_200,
    sourceOutMs: 4_400,
  });

  const assets = [
    createVideoAsset({ id: 'asset-drive', displayName: 'Drive Asset', durationMs: 8_000 }),
    createVideoAsset({ id: 'asset-talk', displayName: 'Talk Asset', durationMs: 8_000 }),
  ];
  const slices = [
    createSlice({
      id: 'slice-drive',
      assetId: 'asset-drive',
      type: 'drive',
      sourceInMs: 0,
      sourceOutMs: 5_000,
      editSourceInMs: 500,
      editSourceOutMs: 4_500,
      speedCandidate: {
        suggestedSpeeds: [2, 5],
        rationale: 'continuous-drive-window',
      },
    }),
    createSlice({
      id: 'slice-talk',
      assetId: 'asset-talk',
      type: 'talking-head',
      sourceInMs: 2_000,
      sourceOutMs: 4_800,
      editSourceInMs: 2_000,
      editSourceOutMs: 4_800,
      transcript: 'Original cue text',
      transcriptSegments: [{
        startMs: 2_200,
        endMs: 4_400,
        text: 'Original cue text',
      }],
      grounding: {
        speechMode: 'available',
        speechValue: 'informative',
        spatialEvidence: [],
        pharosRefs: [],
      },
      speechCoverage: 0.85,
    }),
  ];
  const chronology = [
    createChronology({
      id: 'chrono-drive',
      assetId: 'asset-drive',
      sortCapturedAt: '2026-04-18T00:00:00.000Z',
    }),
    createChronology({
      id: 'chrono-talk',
      assetId: 'asset-talk',
      sortCapturedAt: '2026-04-18T00:01:00.000Z',
    }),
  ];
  const script: IKtepScript[] = [{
    id: 'segment-1',
    role: 'scene',
    title: 'Segment 1',
    linkedSpanIds: ['slice-drive', 'slice-talk'],
    linkedSliceIds: ['slice-drive', 'slice-talk'],
    beats: [{
      id: 'drive-beat',
      text: 'Drive montage',
      audioSelections: [],
      visualSelections: [driveSelection],
      linkedSpanIds: ['slice-drive'],
      linkedSliceIds: ['slice-drive'],
    }, {
      id: 'speech-beat',
      text: 'Speech beat',
      audioSelections: [speechSelection],
      visualSelections: [speechSelection],
      linkedSpanIds: ['slice-talk'],
      linkedSliceIds: ['slice-talk'],
    }],
  }];

  await Promise.all([
    writeJson(getAssetsPath(projectRoot), assets),
    writeJson(getSpansPath(projectRoot), slices),
    writeChronology(projectRoot, chronology),
    writeCurrentScript(projectRoot, script),
  ]);

  return { projectRoot, script };
}
