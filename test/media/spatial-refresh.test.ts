import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  IAssetCoarseReport,
  IInferredGps,
  IMediaAnalysisPlan,
} from '../../src/protocol/schema.js';
import { refreshAnalyzeSpatialResults } from '../../src/modules/media/spatial-refresh.js';
import {
  getAssetReportPath,
  getAssetsPath,
  getSpansPath,
  initWorkspaceProject,
  loadAssetReports,
  loadChronology,
  loadSlices,
  saveIngestRoots,
  writeJson,
} from '../../src/store/index.js';
import {
  createSlice,
  createVideoAsset,
} from '../helpers/fixtures.js';
import type { IReverseGeocodeService } from '../../src/modules/media/reverse-geocode.js';

const workspaces: string[] = [];

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe('refreshAnalyzeSpatialResults', () => {
  it('refreshes existing report GPS priority, chronology, and span grounding without re-analysis', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'kairos-spatial-refresh-'));
    workspaces.push(workspaceRoot);
    const projectRoot = await initWorkspaceProject(workspaceRoot, 'project-spatial-refresh', 'Spatial Refresh');
    const rootPath = join(projectRoot, 'media-root');
    await mkdir(rootPath, { recursive: true });
    await saveIngestRoots(projectRoot, {
      roots: [{
        id: 'root-a',
        path: rootPath,
        label: 'Root A',
        enabled: true,
      }],
    });

    await seedProjectGps(projectRoot);
    await seedProjectPharos(projectRoot);

    const embeddedAsset = createVideoAsset({
      id: 'asset-embedded',
      ingestRootId: 'root-a',
      capturedAt: '2026-04-12T00:02:00.000Z',
      embeddedGps: {
        originType: 'sidecar-srt',
        confidence: 0.98,
        representativeTime: '2026-04-12T00:02:00.000Z',
        representativeLat: 30,
        representativeLng: 100,
        pointCount: 3,
        startTime: '2026-04-12T00:01:00.000Z',
        endTime: '2026-04-12T00:03:00.000Z',
      },
    });
    const pharosAsset = createVideoAsset({
      id: 'asset-pharos',
      ingestRootId: 'root-a',
      capturedAt: '2026-04-12T00:04:00.000Z',
    });
    const gpxAsset = createVideoAsset({
      id: 'asset-gpx',
      ingestRootId: 'root-a',
      capturedAt: '2026-04-12T01:00:00.000Z',
    });
    await writeJson(getAssetsPath(projectRoot), [embeddedAsset, pharosAsset, gpxAsset]);

    await writeJson(getAssetReportPath(projectRoot, embeddedAsset.id), makeReport({
      assetId: embeddedAsset.id,
      ingestRootId: 'root-a',
      inferredGps: {
        source: 'pharos',
        confidence: 0.7,
        lat: 31,
        lng: 101,
        summary: 'old pharos',
      },
      gpsSummary: 'old pharos',
      pharosMatches: [],
    }));
    await writeJson(getAssetReportPath(projectRoot, pharosAsset.id), makeReport({
      assetId: pharosAsset.id,
      ingestRootId: 'root-a',
      gpsSummary: undefined,
      inferredGps: undefined,
    }));
    await writeJson(getAssetReportPath(projectRoot, gpxAsset.id), makeReport({
      assetId: gpxAsset.id,
      ingestRootId: 'root-a',
      gpsSummary: undefined,
      inferredGps: undefined,
    }));
    await writeJson(getSpansPath(projectRoot), [
      createSlice({
        id: 'slice-embedded',
        assetId: embeddedAsset.id,
        materialPatterns: [{ phrase: '保留的语义', confidence: 0.9, evidenceRefs: [] }],
        grounding: {
          speechMode: 'available',
          speechValue: 'informative',
          spatialEvidence: [{
            tier: 'strong-inference',
            confidence: 0.2,
            sourceKinds: ['old-pharos'],
            reasons: ['stale'],
            lat: 31,
            lng: 101,
          }],
          pharosRefs: [],
        },
      }),
    ]);

    const result = await refreshAnalyzeSpatialResults({
      workspaceRoot,
      projectId: 'project-spatial-refresh',
      reverseGeocodeService: createTestReverseGeocodeService(),
    });

    const reports = new Map((await loadAssetReports(projectRoot)).map(report => [report.assetId, report]));
    expect(result.updatedReportCount).toBe(3);
    expect(reports.get(embeddedAsset.id)?.inferredGps).toEqual(expect.objectContaining({
      source: 'embedded',
      embeddedOriginType: 'sidecar-srt',
      lat: 30,
      lng: 100,
      locationText: 'loc 30.000000,100.000000',
    }));
    expect(reports.get(embeddedAsset.id)?.gpsSummary).toContain('embedded');
    expect(reports.get(embeddedAsset.id)?.pharosMatches.length).toBeGreaterThan(0);
    expect(reports.get(embeddedAsset.id)?.pharosMatches.some(match => match.ref.shotId === 'abandoned-1')).toBe(false);
    expect(reports.get(embeddedAsset.id)?.pharosMatches[0]?.shotKind).toBe('continuous');
    expect(reports.get(pharosAsset.id)?.inferredGps).toEqual(expect.objectContaining({
      source: 'pharos',
      lat: 31.1,
      lng: 101.1,
    }));
    expect(reports.get(pharosAsset.id)?.pharosMatches.map(match => match.ref.shotId)).toEqual(['drive-1']);
    expect(reports.get(gpxAsset.id)?.inferredGps).toEqual(expect.objectContaining({
      source: 'gpx',
      lat: 40,
      lng: 110,
    }));

    const chronology = await loadChronology(projectRoot);
    expect(chronology.find(item => item.assetId === embeddedAsset.id)?.evidence.some(item =>
      item.source === 'gps' && item.value.includes('embedded'))).toBe(true);

    const slices = await loadSlices(projectRoot);
    const refreshedSlice = slices.find(slice => slice.id === 'slice-embedded');
    expect(refreshedSlice?.materialPatterns?.[0]?.phrase).toBe('保留的语义');
    expect(refreshedSlice?.grounding.spatialEvidence.some(item => item.sourceKinds.includes('old-pharos'))).toBe(false);
    expect(refreshedSlice?.grounding.spatialEvidence.some(item => item.sourceKinds.includes('embedded'))).toBe(true);
    expect(refreshedSlice?.grounding.pharosRefs.length).toBeGreaterThan(0);
  });
});

async function seedProjectGps(projectRoot: string): Promise<void> {
  const gpsRoot = join(projectRoot, 'gps', 'tracks');
  await mkdir(gpsRoot, { recursive: true });
  await writeFile(join(gpsRoot, 'project-track.gpx'), [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx version="1.1">',
    '  <trk><trkseg>',
    '    <trkpt lat="40.000000" lon="110.000000"><time>2026-04-12T01:02:00.000Z</time></trkpt>',
    '  </trkseg></trk>',
    '</gpx>',
  ].join('\n'));
}

async function seedProjectPharos(projectRoot: string): Promise<void> {
  const tripRoot = join(projectRoot, 'pharos', 'trip-1');
  await mkdir(join(tripRoot, 'gpx'), { recursive: true });
  await writeFile(join(tripRoot, 'plan.json'), JSON.stringify({
    $schema: 'pharos/plan/1.0',
    trip_id: 'trip-1',
    title: 'Trip 1',
    timezone: 'UTC',
    days: [{
      day: 1,
      date: '2026-04-12',
      title: 'Day 1',
      shots: [{
        id: 'drive-1',
        location: 'Pharos Road',
        description: 'continuous drive',
        kind: 'continuous',
        priority: 'must',
      }, {
        id: 'abandoned-1',
        location: 'Old Plan',
        description: 'abandoned planned shot covering the same time',
        kind: 'event',
        time_window: ['00:00', '00:10'],
        priority: 'must',
      }],
    }],
  }, null, 2));
  await writeFile(join(tripRoot, 'record.json'), JSON.stringify({
    $schema: 'pharos/record/1.0',
    trip_id: 'trip-1',
    records: [{
      shot_id: 'drive-1',
      status: 'expected',
      actual_time: {
        start: '2026-04-12T00:00:00.000Z',
        end: '2026-04-12T00:10:00.000Z',
      },
    }, {
      shot_id: 'abandoned-1',
      status: 'abandoned',
      actual_time: null,
      abandon_reason: 'changed route',
    }],
  }, null, 2));
  await writeFile(join(tripRoot, 'gpx', 'pharos-track.gpx'), [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx version="1.1">',
    '  <trk><trkseg>',
    '    <trkpt lat="31.000000" lon="101.000000"><time>2026-04-12T00:02:00.000Z</time></trkpt>',
    '    <trkpt lat="31.100000" lon="101.100000"><time>2026-04-12T00:04:00.000Z</time></trkpt>',
    '    <trkpt lat="31.200000" lon="101.200000"><time>2026-04-12T00:06:00.000Z</time></trkpt>',
    '    <trkpt lat="35.000000" lon="105.000000"><time>2026-04-12T01:00:00.000Z</time></trkpt>',
    '  </trkseg></trk>',
    '</gpx>',
  ].join('\n'));
}

function makeReport(input: {
  assetId: string;
  ingestRootId: string;
  gpsSummary?: string;
  inferredGps?: IInferredGps;
  pharosMatches?: IAssetCoarseReport['pharosMatches'];
}): IAssetCoarseReport {
  return {
    assetId: input.assetId,
    ingestRootId: input.ingestRootId,
    durationMs: 120_000,
    clipTypeGuess: 'drive',
    keepDecision: 'keep',
    materializationPath: 'direct',
    densityScore: 0.5,
    gpsSummary: input.gpsSummary,
    inferredGps: input.inferredGps,
    summary: 'Pharos Road continuous drive',
    pharosMatches: input.pharosMatches ?? [],
    labels: ['drive'],
    placeHints: [],
    rootNotes: [],
    sampleFrames: [],
    interestingWindows: [makeWindow()],
    fineScanReasons: [],
    createdAt: '2026-04-12T00:00:00.000Z',
    updatedAt: '2026-04-12T00:00:00.000Z',
  };
}

function makeWindow(): IMediaAnalysisPlan['interestingWindows'][number] {
  return {
    startMs: 0,
    endMs: 120_000,
    reason: 'test-window',
  };
}

function createTestReverseGeocodeService(): IReverseGeocodeService {
  return {
    prewarm: async () => undefined,
    reverseGeocode: async (lat, lng) => ({
      locationKey: `${lng.toFixed(6)},${lat.toFixed(6)}`,
      provider: 'test',
      status: 'ok',
      fetchedAt: '2026-04-12T00:00:00.000Z',
      lat,
      lng,
      locationText: `loc ${lat.toFixed(6)},${lng.toFixed(6)}`,
    }),
  };
}
