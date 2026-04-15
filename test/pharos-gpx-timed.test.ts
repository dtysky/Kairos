import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type {
  IPharosMatch,
  IProjectPharosContext,
  IProjectPharosShot,
  IProjectPharosTripSummary,
} from '../src/protocol/schema.js';
import { resolvePharosTimedSpatialContext } from '../src/modules/pharos/gpx-timed.js';
import { createEmptySliceSemantics, decorateSliceWithSemanticTags } from '../src/modules/media/semantic-slice.js';

function makeTripSummary(overrides: Partial<IProjectPharosTripSummary> = {}): IProjectPharosTripSummary {
  return {
    tripId: 'trip-1',
    title: 'Trip 1',
    mustCount: 0,
    optionalCount: 0,
    pendingCount: 0,
    expectedCount: 0,
    unexpectedCount: 0,
    abandonedCount: 0,
    gpxCount: 1,
    warnings: [],
    ...overrides,
  };
}

function makeShot(overrides: Partial<IProjectPharosShot> = {}): IProjectPharosShot {
  return {
    ref: {
      tripId: 'trip-1',
      shotId: 'shot-1',
    },
    tripTitle: 'Trip 1',
    dayTitle: 'Day 1',
    location: '陌上花公园',
    description: '园内人像和路程记录',
    type: 'continuous',
    devices: [],
    rolls: [],
    isExtraShot: false,
    gps: [0, 0],
    gpsStart: [0, 0],
    gpsEnd: [0, 0],
    actualGpsStart: [9, 9],
    actualGpsEnd: [9, 9],
    ...overrides,
  };
}

function makeMatch(ref: IPharosMatch['ref']): IPharosMatch {
  return {
    ref,
    confidence: 0.82,
    matchReasons: ['planned-time:within-window'],
  };
}

function makeContext(gpxPath: string, shots: IProjectPharosShot[]): IProjectPharosContext {
  return {
    schemaVersion: '1.0',
    generatedAt: '2026-04-16T00:00:00.000Z',
    status: 'success',
    rootPath: '/tmp/pharos',
    discoveredTripIds: ['trip-1'],
    includedTripIds: ['trip-1'],
    warnings: [],
    errors: [],
    trips: [makeTripSummary()],
    shots,
    gpxFiles: [{
      tripId: 'trip-1',
      path: gpxPath,
      pointCount: 3,
      startTime: '2026-04-12T00:00:00.000Z',
      endTime: '2026-04-12T00:02:00.000Z',
    }],
  };
}

describe('Pharos GPX timed spatial resolver', () => {
  it('uses trip GPX midpoint for non-drive and start/end for drive', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'kairos-pharos-gpx-'));
    try {
      const gpxRoot = join(tempRoot, 'trip-1', 'gpx');
      await mkdir(gpxRoot, { recursive: true });
      const gpxPath = join(gpxRoot, 'track.gpx');
      await writeFile(gpxPath, [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<gpx version="1.1">',
        '  <trk><trkseg>',
        '    <trkpt lat="22.500000" lon="113.900000"><time>2026-04-12T00:00:00.000Z</time></trkpt>',
        '    <trkpt lat="22.501000" lon="113.901000"><time>2026-04-12T00:01:00.000Z</time></trkpt>',
        '    <trkpt lat="22.502000" lon="113.902000"><time>2026-04-12T00:02:00.000Z</time></trkpt>',
        '  </trkseg></trk>',
        '</gpx>',
      ].join('\n'));

      const shot = makeShot({
        plannedTimeStart: '2026-04-12T00:00:00.000Z',
        plannedTimeEnd: '2026-04-12T00:20:00.000Z',
      });
      const context = makeContext(gpxPath, [shot]);
      const match = makeMatch(shot.ref);

      const nonDrive = await resolvePharosTimedSpatialContext({
        asset: {
          capturedAt: '2026-04-12T00:00:30.000Z',
          durationMs: 60_000,
        },
        clipType: 'broll',
        pharosContext: context,
        pharosMatches: [match],
      });
      expect(nonDrive?.locationCandidates).toHaveLength(1);
      expect(nonDrive?.locationCandidates[0]?.role).toBe('point');
      expect(nonDrive?.locationCandidates[0]?.lng).toBeCloseTo(113.901, 6);
      expect(nonDrive?.inferredGps?.lng).toBeCloseTo(113.901, 6);

      const drive = await resolvePharosTimedSpatialContext({
        asset: {
          capturedAt: '2026-04-12T00:00:00.000Z',
          durationMs: 120_000,
        },
        clipType: 'drive',
        pharosContext: context,
        pharosMatches: [match],
      });
      expect(drive?.locationCandidates.map(candidate => candidate.role)).toEqual(['start', 'end']);
      expect(drive?.locationCandidates[0]?.lng).toBeCloseTo(113.9, 6);
      expect(drive?.locationCandidates[1]?.lng).toBeCloseTo(113.902, 6);
      expect(drive?.inferredGps?.lng).toBeCloseTo(113.901, 6);
      expect(drive?.gpsSummary).toContain('pharos-gpx');
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('keeps the pharos ref but produces no pharos spatial result when GPX has no timed point', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'kairos-pharos-gpx-miss-'));
    try {
      const gpxRoot = join(tempRoot, 'trip-1', 'gpx');
      await mkdir(gpxRoot, { recursive: true });
      const gpxPath = join(gpxRoot, 'track.gpx');
      await writeFile(gpxPath, [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<gpx version="1.1">',
        '  <trk><trkseg>',
        '    <trkpt lat="22.500000" lon="113.900000"><time>2026-04-12T00:00:00.000Z</time></trkpt>',
        '  </trkseg></trk>',
        '</gpx>',
      ].join('\n'));

      const shot = makeShot({
        plannedTimeStart: '2026-04-12T01:00:00.000Z',
        plannedTimeEnd: '2026-04-12T01:10:00.000Z',
      });
      const context = makeContext(gpxPath, [shot]);
      const match = makeMatch(shot.ref);

      const resolved = await resolvePharosTimedSpatialContext({
        asset: {
          capturedAt: '2026-04-12T00:30:00.000Z',
          durationMs: 60_000,
        },
        clipType: 'broll',
        pharosContext: context,
        pharosMatches: [match],
      });

      expect(resolved).toBeNull();
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('injects GPX-timed route evidence into span grounding', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'kairos-pharos-grounding-'));
    try {
      const gpxRoot = join(tempRoot, 'trip-1', 'gpx');
      await mkdir(gpxRoot, { recursive: true });
      const gpxPath = join(gpxRoot, 'track.gpx');
      await writeFile(gpxPath, [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<gpx version="1.1">',
        '  <trk><trkseg>',
        '    <trkpt lat="22.500000" lon="113.900000"><time>2026-04-12T00:00:00.000Z</time></trkpt>',
        '    <trkpt lat="22.501000" lon="113.901000"><time>2026-04-12T00:01:00.000Z</time></trkpt>',
        '    <trkpt lat="22.502000" lon="113.902000"><time>2026-04-12T00:02:00.000Z</time></trkpt>',
        '  </trkseg></trk>',
        '</gpx>',
      ].join('\n'));

      const shot = makeShot({
        plannedTimeStart: '2026-04-12T00:00:00.000Z',
        plannedTimeEnd: '2026-04-12T00:20:00.000Z',
      });
      const context = makeContext(gpxPath, [shot]);
      const match = makeMatch(shot.ref);

      const decorated = await decorateSliceWithSemanticTags({
        slice: {
          id: 'span-1',
          assetId: 'asset-1',
          type: 'drive',
          sourceInMs: 0,
          sourceOutMs: 120_000,
          ...createEmptySliceSemantics(),
        },
        asset: {
          capturedAt: '2026-04-12T00:00:00.000Z',
          durationMs: 120_000,
        },
        clipType: 'drive',
        report: {
          pharosMatches: [match],
        },
        pharosContext: context,
      });

      expect(decorated.grounding.spatialEvidence.some(evidence => evidence.routeRole === 'route-start')).toBe(true);
      expect(decorated.grounding.spatialEvidence.some(evidence => evidence.routeRole === 'route-end')).toBe(true);
      expect(decorated.grounding.pharosRefs).toEqual([shot.ref]);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
