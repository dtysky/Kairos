import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  IChronologyEvent,
  IMaterialSlotsDocument,
} from '../src/protocol/index.js';
import {
  buildDeterministicTimeline,
  buildProjectTimeline,
} from '../src/modules/timeline-core/project-timeline.js';
import type { IBuildConfig } from '../src/modules/timeline-core/timeline-builder.js';
import {
  getAssetsPath,
  getEditPlanningArtifactPath,
  getMaterialSlotsPath,
  getSpansMetaPath,
  getSpansPath,
  initProject,
  loadProject,
  writeChronology,
  writeJson,
} from '../src/store/index.js';
import {
  createChronology,
  createProjectChronology,
  createSlice,
  createVideoAsset,
} from './helpers/fixtures.js';

const cTempRoots: string[] = [];
const CNOW = '2026-04-18T00:00:00.000Z';

afterEach(async () => {
  await Promise.all(cTempRoots.splice(0).map(root =>
    rm(root, { recursive: true, force: true })));
});

describe('project timeline generation', () => {
  it('blocks legacy chronology before building timeline', async () => {
    const { projectRoot } = await createTimelineProjectFixture({ legacyChronology: true });

    await expect(buildProjectTimeline({ projectRoot })).rejects.toThrow(/legacy v1.*Chronology V2/u);
  });

  it('assembles a Resolve rough-cut manifest from material-slots sparse treatments', async () => {
    const fixture = await createTimelineProjectFixture();
    const project = await loadProject(fixture.projectRoot);

    const result = buildDeterministicTimeline({
      project,
      editId: 'main',
      assets: fixture.assets,
      spans: fixture.spans,
      materialSlots: fixture.materialSlots,
      chronologyEvents: fixture.events,
      ingestRoots: [],
      cfg: createTimelineConfig(),
    });

    const driveClip = result.resolveClips.find(clip => clip.spanId === 'slice-drive');
    const speechClip = result.resolveClips.find(clip => clip.spanId === 'slice-talk');

    expect(result.timelineName).toBe('Main [main]');
    expect(result.resolveProjectName).toBe('Timeline Fixture [Edit]');
    expect(driveClip).toMatchObject({
      spanId: 'slice-drive',
      audioGainDb: 0,
      muteAudio: false,
      requestedSpeed: 1,
      speed: 1,
    });
    expect(speechClip).toMatchObject({
      spanId: 'slice-talk',
      audioGainDb: 0,
      muteAudio: false,
      requestedSpeed: 1,
    });
    expect(result.doc.timeline.clips.map(clip => clip.spanId)).toEqual(['slice-drive', 'slice-talk']);
  });

  it('keeps speech-backed non-photo spans from being silently muted', async () => {
    const fixture = await createTimelineProjectFixture({
      materialSlotsOverride: createMaterialSlots({
        'slice-talk': { audio: -100 },
      }),
    });
    const project = await loadProject(fixture.projectRoot);

    expect(() => buildDeterministicTimeline({
      project,
      editId: 'main',
      assets: fixture.assets,
      spans: fixture.spans,
      materialSlots: fixture.materialSlots,
      chronologyEvents: fixture.events,
      ingestRoots: [],
      cfg: createTimelineConfig(),
    })).toThrow(/muted speech span/u);
  });
});

async function createTimelineProjectFixture(
  options: {
    legacyChronology?: boolean;
    materialSlotsOverride?: IMaterialSlotsDocument;
  } = {},
) {
  const projectRoot = await mkdtemp(join(tmpdir(), 'kairos-project-timeline-'));
  cTempRoots.push(projectRoot);
  await initProject(projectRoot, 'Timeline Fixture');

  const assets = [
    createVideoAsset({
      id: 'asset-drive',
      displayName: 'Drive Asset',
      durationMs: 8_000,
      sourcePath: '/tmp/kairos-test-media/drive.mp4',
    }),
    createVideoAsset({
      id: 'asset-talk',
      displayName: 'Talk Asset',
      durationMs: 8_000,
      sourcePath: '/tmp/kairos-test-media/talk.mp4',
    }),
  ];
  const spans = [
    createSlice({
      id: 'slice-drive',
      assetId: 'asset-drive',
      type: 'drive',
      semanticKind: 'visual',
      sourceInMs: 0,
      sourceOutMs: 5_000,
      editSourceInMs: 500,
      editSourceOutMs: 4_500,
    }),
    createSlice({
      id: 'slice-talk',
      assetId: 'asset-talk',
      type: 'talking-head',
      semanticKind: 'speech',
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
      speechCoverage: 0.85,
      materialPatterns: ['拍摄视角：固定机位', '当前环境：车内', '天气光线：自然光', '有口播语音'],
    }),
  ];
  const chronologyAssetIndex = [
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
  const events: IChronologyEvent[] = [{
    id: 'event-1',
    kind: 'event',
    reviewStatus: 'confirmed',
    title: 'Segment 1',
    startAt: '2026-04-18T00:00:00.000Z',
    endAt: '2026-04-18T00:02:00.000Z',
    spanIds: ['slice-drive', 'slice-talk'],
  }];
  const materialSlots = options.materialSlotsOverride ?? createMaterialSlots();

  await Promise.all([
    writeJson(getAssetsPath(projectRoot), assets),
    writeJson(getSpansPath(projectRoot), spans),
    writeJson(getSpansMetaPath(projectRoot), {
      schemaVersion: '1.0',
      status: 'fresh',
      generatedAt: CNOW,
      inputsHash: 'test-spans',
      assetCount: assets.length,
      reportCount: 0,
      spanCount: spans.length,
      warnings: [],
    }),
    options.legacyChronology
      ? writeJson(join(projectRoot, 'media', 'chronology.json'), chronologyAssetIndex)
      : writeChronology(projectRoot, createProjectChronology(chronologyAssetIndex, { events })),
    writeJson(getMaterialSlotsPath(projectRoot), materialSlots),
    writeFile(getEditPlanningArtifactPath(projectRoot, 'edit-framework.md'), '## 分段操作稿\n\n- FW-001 Segment 1\n', 'utf-8'),
  ]);

  return {
    projectRoot,
    assets,
    spans,
    events,
    materialSlots,
  };
}

function createMaterialSlots(
  treatments: IMaterialSlotsDocument['segments'][number]['slots'][number]['treatments'] = {},
): IMaterialSlotsDocument {
  return {
    id: 'slots-main',
    projectId: 'project-test',
    generatedAt: CNOW,
    status: 'current',
    segments: [{
      segmentId: 'segment-1',
      slots: [{
        id: 'FW-001',
        query: 'Segment 1',
        requirement: 'required',
        targetBundles: [],
        chosenSpanIds: ['slice-drive', 'slice-talk'],
        treatments,
      }],
    }],
  };
}

function createTimelineConfig(): IBuildConfig {
  return {
    fps: 30,
    width: 3840,
    height: 2160,
    name: 'Main [main]',
    stillDurationMs: 5000,
  };
}
