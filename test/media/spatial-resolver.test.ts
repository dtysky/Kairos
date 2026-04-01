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
  it('uses embedded GPS before GPX and manual-itinerary fallback', async () => {
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
      itinerary: {
        warnings: [],
        segments: [{
          id: 'manual-1',
          date: '2026-03-31',
          startLocalTime: '16:00',
          endLocalTime: '17:00',
          location: '北京市天安门',
        }],
      },
      gpxPaths: [gpxPath],
      resolveTimezoneFromLocation: async () => 'Asia/Shanghai',
      geocodeLocation: async () => ({ lat: 39.909187, lng: 116.397463 }),
    });

    expect(result?.inferredGps).toEqual(expect.objectContaining({
      source: 'embedded',
      lat: 39.555555,
      lng: 116.666666,
    }));
    expect(result?.decisionReasons).toContain('embedded-gps');
  });

  it('uses GPX match before manual-itinerary fallback', async () => {
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
      itinerary: {
        warnings: [],
        segments: [{
          id: 'manual-1',
          date: '2026-03-31',
          startLocalTime: '16:00',
          endLocalTime: '17:00',
          location: '北京市天安门',
        }],
      },
      gpxPaths: [gpxPath],
      resolveTimezoneFromLocation: async () => 'Asia/Shanghai',
      geocodeLocation: async () => ({ lat: 39.909187, lng: 116.397463 }),
    });

    expect(result?.inferredGps).toEqual(expect.objectContaining({
      source: 'gpx',
      lat: 39.111111,
      lng: 116.222222,
    }));
    expect(result?.gpsSummary).toContain('gpx');
  });

  it('matches merged project GPX cache before manual-itinerary fallback', async () => {
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
      itinerary: {
        warnings: [],
        segments: [{
          id: 'manual-1',
          date: '2026-03-31',
          startLocalTime: '16:00',
          endLocalTime: '17:00',
          location: '北京市天安门',
        }],
      },
      gpxPaths: [mergedPath],
      resolveTimezoneFromLocation: async () => 'Asia/Shanghai',
      geocodeLocation: async () => ({ lat: 39.909187, lng: 116.397463 }),
    });

    expect(result?.inferredGps).toEqual(expect.objectContaining({
      source: 'gpx',
      lat: 39.111111,
      lng: 116.222222,
    }));
    expect(result?.gpsSummary).toContain('gpx');
  });

  it('falls back to manual-itinerary when GPX has no match', async () => {
    const gpxPath = await writeTempGpx([
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<gpx version="1.1" creator="test">',
      '  <trk><trkseg>',
      '    <trkpt lat="39.111111" lon="116.222222"><time>2026-03-31T04:00:00Z</time></trkpt>',
      '  </trkseg></trk>',
      '</gpx>',
    ].join('\n'));

    const result = await resolveAssetSpatialContext({
      asset: {
        capturedAt: '2026-03-31T08:15:30.000Z',
        sourcePath: 'travel/day1/clip.mp4',
      },
      itinerary: {
        warnings: [],
        segments: [{
          id: 'manual-1',
          date: '2026-03-31',
          startLocalTime: '16:00',
          endLocalTime: '17:00',
          location: '北京市天安门',
        }],
      },
      gpxPaths: [gpxPath],
      resolveTimezoneFromLocation: async () => 'Asia/Shanghai',
      geocodeLocation: async () => ({ lat: 39.909187, lng: 116.397463 }),
    });

    expect(result?.inferredGps).toEqual(expect.objectContaining({
      source: 'manual-itinerary',
      lat: 39.909187,
      lng: 116.397463,
      matchedItinerarySegmentId: 'manual-1',
    }));
    expect(result?.gpsSummary).toContain('manual-itinerary');
  });
});
