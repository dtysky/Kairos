import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveAssetSpatialContext } from '../../src/modules/media/spatial-resolver.js';

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map(path => rm(path, { recursive: true, force: true })),
  );
});

async function writeTempGpx(content: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'kairos-gpx-test-'));
  tempRoots.push(root);
  const filePath = join(root, 'track.gpx');
  await writeFile(filePath, content, 'utf-8');
  return filePath;
}

async function writeTempJson(content: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'kairos-gpx-json-test-'));
  tempRoots.push(root);
  const filePath = join(root, 'merged.json');
  await writeFile(filePath, content, 'utf-8');
  return filePath;
}

describe('resolveAssetSpatialContext', () => {
  it('uses embedded GPS before GPX and project-derived-track', async () => {
    const gpxPath = await writeTempGpx([
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<gpx version="1.1" creator="test">',
      '  <trk><trkseg>',
      '    <trkpt lat="39.111111" lon="116.222222"><time>2026-03-31T08:15:00Z</time></trkpt>',
      '  </trkseg></trk>',
      '</gpx>',
    ].join('\n'));

    const result = await resolveAssetSpatialContext({
      asset: {
        capturedAt: '2026-03-31T08:15:30.000Z',
        sourcePath: 'travel/day1/clip.mp4',
        metadata: {
          rawTags: {
            location: '+39.555555+116.666666+100.000/',
          },
        },
      } as any,
      derivedTrack: {
        schemaVersion: '1.0',
        updatedAt: '2026-03-31T08:16:00.000Z',
        entryCount: 1,
        entries: [{
          id: 'derived-1',
          originType: 'embedded-derived',
          matchKind: 'point',
          confidence: 0.72,
          lat: 39.111111,
          lng: 116.222222,
          time: '2026-03-31T08:15:00Z',
          sourceAssetId: 'asset-dji',
          sourcePath: 'gps-anchor.mp4',
        }],
      },
      gpxPaths: [gpxPath],
    });

    expect(result?.inferredGps).toEqual(expect.objectContaining({
      source: 'embedded',
      lat: 39.555555,
      lng: 116.666666,
    }));
    expect(result?.decisionReasons).toContain('embedded-gps');
  });

  it('uses GPX match before project-derived-track', async () => {
    const gpxPath = await writeTempGpx([
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<gpx version="1.1" creator="test">',
      '  <trk><trkseg>',
      '    <trkpt lat="39.111111" lon="116.222222"><time>2026-03-31T08:15:00Z</time></trkpt>',
      '  </trkseg></trk>',
      '</gpx>',
    ].join('\n'));

    const result = await resolveAssetSpatialContext({
      asset: {
        capturedAt: '2026-03-31T08:15:30.000Z',
        sourcePath: 'travel/day1/clip.mp4',
      },
      derivedTrack: {
        schemaVersion: '1.0',
        updatedAt: '2026-03-31T08:16:00.000Z',
        entryCount: 1,
        entries: [{
          id: 'derived-1',
          originType: 'embedded-derived',
          matchKind: 'point',
          confidence: 0.72,
          lat: 39.909187,
          lng: 116.397463,
          time: '2026-03-31T08:15:20Z',
          sourceAssetId: 'asset-dji',
          sourcePath: 'gps-anchor.mp4',
        }],
      },
      gpxPaths: [gpxPath],
    });

    expect(result?.inferredGps).toEqual(expect.objectContaining({
      source: 'gpx',
      lat: 39.111111,
      lng: 116.222222,
    }));
    expect(result?.gpsSummary).toContain('gpx');
  });

  it('matches merged project GPX cache before project-derived-track', async () => {
    const mergedPath = await writeTempJson(JSON.stringify({
      schemaVersion: '1.0',
      updatedAt: '2026-03-31T08:16:00.000Z',
      trackCount: 1,
      pointCount: 1,
      tracks: [{
        relativePath: 'gps/tracks/route-a.gpx',
        pointCount: 1,
      }],
      points: [{
        lat: 39.111111,
        lng: 116.222222,
        time: '2026-03-31T08:15:00Z',
        sourcePath: 'gps/tracks/route-a.gpx',
      }],
    }, null, 2));

    const result = await resolveAssetSpatialContext({
      asset: {
        capturedAt: '2026-03-31T08:15:30.000Z',
        sourcePath: 'travel/day1/clip.mp4',
      },
      derivedTrack: {
        schemaVersion: '1.0',
        updatedAt: '2026-03-31T08:16:00.000Z',
        entryCount: 1,
        entries: [{
          id: 'derived-1',
          originType: 'manual-itinerary-derived',
          matchKind: 'window',
          confidence: 0.45,
          lat: 39.909187,
          lng: 116.397463,
          startTime: '2026-03-31T08:00:00Z',
          endTime: '2026-03-31T09:00:00Z',
          matchedItinerarySegmentId: 'manual-itinerary-1',
          locationText: '北京市天安门',
          timezone: 'Asia/Shanghai',
        }],
      },
      gpxPaths: [mergedPath],
    });

    expect(result?.inferredGps).toEqual(expect.objectContaining({
      source: 'gpx',
      lat: 39.111111,
      lng: 116.222222,
    }));
    expect(result?.gpsSummary).toContain('gpx');
  });

  it('uses project-derived-track when GPX has no match', async () => {
    const result = await resolveAssetSpatialContext({
      asset: {
        capturedAt: '2026-03-31T08:15:30.000Z',
        sourcePath: 'travel/day1/clip.mp4',
      },
      derivedTrack: {
        schemaVersion: '1.0',
        updatedAt: '2026-03-31T08:16:00.000Z',
        entryCount: 1,
        entries: [{
          id: 'derived-1',
          originType: 'embedded-derived',
          matchKind: 'point',
          confidence: 0.72,
          lat: 39.111111,
          lng: 116.222222,
          time: '2026-03-31T08:15:00Z',
          sourceAssetId: 'asset-dji',
          sourcePath: 'gps-anchor.mp4',
        }],
      },
      gpxPaths: [],
    });

    expect(result?.inferredGps).toEqual(expect.objectContaining({
      source: 'derived-track',
      derivedOriginType: 'embedded-derived',
      lat: 39.111111,
      lng: 116.222222,
      sourceAssetId: 'asset-dji',
    }));
    expect(result?.gpsSummary).toContain('derived-track');
  });

  it('keeps manual-itinerary provenance inside project-derived-track matches', async () => {
    const result = await resolveAssetSpatialContext({
      asset: {
        capturedAt: '2026-03-31T08:15:30.000Z',
        sourcePath: 'travel/day1/clip.mp4',
      },
      root: {
        id: 'root-1',
        label: 'camera-a',
      },
      derivedTrack: {
        schemaVersion: '1.0',
        updatedAt: '2026-03-31T08:16:00.000Z',
        entryCount: 1,
        entries: [{
          id: 'derived-1',
          originType: 'manual-itinerary-derived',
          matchKind: 'window',
          confidence: 0.45,
          lat: 39.909187,
          lng: 116.397463,
          startTime: '2026-03-31T08:00:00Z',
          endTime: '2026-03-31T09:00:00Z',
          matchedItinerarySegmentId: 'manual-itinerary-1',
          locationText: '北京市天安门',
          timezone: 'Asia/Shanghai',
          rootRef: 'camera-a',
        }],
      },
    });

    expect(result?.inferredGps).toEqual(expect.objectContaining({
      source: 'derived-track',
      derivedOriginType: 'manual-itinerary-derived',
      lat: 39.909187,
      lng: 116.397463,
      matchedItinerarySegmentId: 'manual-itinerary-1',
    }));
    expect(result?.gpsSummary).toContain('manual-itinerary-derived');
    expect(result?.locationCandidates).toEqual([{
      role: 'point',
      lat: 39.909187,
      lng: 116.397463,
    }]);
  });

  it('does not interpolate between sparse derived-track points', async () => {
    const result = await resolveAssetSpatialContext({
      asset: {
        capturedAt: '2026-03-31T08:30:00.000Z',
        sourcePath: 'travel/day1/clip.mp4',
      },
      derivedTrack: {
        schemaVersion: '1.0',
        updatedAt: '2026-03-31T08:16:00.000Z',
        entryCount: 2,
        entries: [
          {
            id: 'derived-1',
            originType: 'embedded-derived',
            matchKind: 'point',
            confidence: 0.72,
            lat: 39.111111,
            lng: 116.222222,
            time: '2026-03-31T08:00:00Z',
            sourceAssetId: 'asset-a',
            sourcePath: 'gps-anchor-a.mp4',
          },
          {
            id: 'derived-2',
            originType: 'embedded-derived',
            matchKind: 'point',
            confidence: 0.72,
            lat: 39.222222,
            lng: 116.333333,
            time: '2026-03-31T09:00:00Z',
            sourceAssetId: 'asset-b',
            sourcePath: 'gps-anchor-b.mp4',
          },
        ],
      },
    });

    expect(result).toBeNull();
  });
});
