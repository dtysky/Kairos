import { describe, expect, it } from 'vitest';
import { detectProjectTimelineBlockers } from '../../src/modules/media/timeline-consistency.js';

describe('timeline consistency blocking', () => {
  it('does not flag weak timestamps that are still inside the itinerary date range', () => {
    const blockers = detectProjectTimelineBlockers({
      assets: [{
        id: 'asset-1',
        kind: 'video',
        sourcePath: 'C1363.mp4',
        displayName: 'C1363.mp4',
        ingestRootId: 'root-1',
        capturedAt: '2026-02-10T08:15:30.000Z',
        captureTimeSource: 'container',
      }],
      roots: [{
        id: 'root-1',
        enabled: true,
      }],
      itinerary: {
        segments: [
          { id: 'seg-1', date: '2026-02-07', location: '广州' },
          { id: 'seg-2', date: '2026-02-21', location: '基督城机场' },
        ],
        warnings: [],
      },
      geoCache: null,
    });

    expect(blockers).toEqual([]);
  });

  it('compares weak timestamps against itinerary dates in the suggested local timezone', () => {
    const blockers = detectProjectTimelineBlockers({
      assets: [{
        id: 'asset-1',
        kind: 'video',
        sourcePath: 'DJI_0001.mp4',
        displayName: 'DJI_0001.mp4',
        ingestRootId: 'root-1',
        capturedAt: '2026-02-07T13:30:00.000Z',
        captureTimeSource: 'container',
      }],
      roots: [{
        id: 'root-1',
        enabled: true,
      }],
      itinerary: {
        segments: [
          { id: 'seg-1', date: '2026-02-08', location: '奥克兰' },
        ],
        warnings: [],
      },
      geoCache: {
        schemaVersion: '1.0',
        updatedAt: '2026-04-05T00:00:00.000Z',
        entries: [{
          query: '奥克兰',
          lat: -36.848461,
          lng: 174.763336,
          timezone: 'Pacific/Auckland',
          aliases: [],
        }],
      },
    });

    expect(blockers).toEqual([]);
  });

  it('does not flag exif assets only because filename date disagrees', () => {
    const blockers = detectProjectTimelineBlockers({
      assets: [{
        id: 'asset-photo',
        kind: 'photo',
        sourcePath: 'DJI_20250718175332_0002_D-HDR.jpg',
        displayName: 'DJI_20250718175332_0002_D-HDR.jpg',
        ingestRootId: 'root-photo',
        capturedAt: '2026-04-12T09:53:32.000Z',
        captureTimeSource: 'exif',
        captureTimeConfidence: 0.98,
      }],
      roots: [{
        id: 'root-photo',
        enabled: true,
      }],
      itinerary: {
        segments: [
          { id: 'seg-1', date: '2026-04-12', location: '深圳' },
        ],
        warnings: [],
      },
      geoCache: null,
    });

    expect(blockers).toEqual([]);
  });

  it('flags weak videos when filename timestamp drift exceeds the residual threshold', () => {
    const blockers = detectProjectTimelineBlockers({
      assets: [{
        id: 'asset-video',
        kind: 'video',
        sourcePath: 'DJI_20260412145254_0001_D.mp4',
        displayName: 'DJI_20260412145254_0001_D.mp4',
        ingestRootId: 'root-drone',
        capturedAt: '2026-04-12T15:06:42.000Z',
        durationMs: 18_000,
        captureTimeSource: 'container',
      }],
      roots: [{
        id: 'root-drone',
        enabled: true,
      }],
      itinerary: {
        segments: [
          { id: 'seg-1', date: '2026-04-12', location: '深圳' },
        ],
        warnings: [],
      },
      geoCache: null,
    });

    expect(blockers).toHaveLength(1);
    expect(blockers[0]?.note).toContain('残余漂移 13m48s');
  });

  it('ignores filename drift that is only a whole-hour timezone offset', () => {
    const blockers = detectProjectTimelineBlockers({
      assets: [{
        id: 'asset-video',
        kind: 'video',
        sourcePath: 'DJI_20260412145254_0001_D.mp4',
        displayName: 'DJI_20260412145254_0001_D.mp4',
        ingestRootId: 'root-drone',
        capturedAt: '2026-04-12T06:52:54.000Z',
        durationMs: 18_000,
        captureTimeSource: 'container',
      }],
      roots: [{
        id: 'root-drone',
        enabled: true,
      }],
      itinerary: {
        segments: [
          { id: 'seg-1', date: '2026-04-12', location: '深圳' },
        ],
        warnings: [],
      },
      geoCache: {
        schemaVersion: '1.0',
        updatedAt: '2026-04-05T00:00:00.000Z',
        entries: [{
          query: '深圳',
          lat: 22.543096,
          lng: 114.057865,
          timezone: 'Asia/Shanghai',
          aliases: [],
        }],
      },
    });

    expect(blockers).toEqual([]);
  });

  it('flags weak photos when filename timestamp drift exceeds five minutes', () => {
    const blockers = detectProjectTimelineBlockers({
      assets: [{
        id: 'asset-photo',
        kind: 'photo',
        sourcePath: 'IMG_20260412_100000.JPG',
        displayName: 'IMG_20260412_100000.JPG',
        ingestRootId: 'root-photo',
        capturedAt: '2026-04-12T10:10:00.000Z',
        captureTimeSource: 'container',
      }],
      roots: [{
        id: 'root-photo',
        enabled: true,
      }],
      itinerary: {
        segments: [
          { id: 'seg-1', date: '2026-04-12', location: '深圳' },
        ],
        warnings: [],
      },
      geoCache: null,
    });

    expect(blockers).toHaveLength(1);
    expect(blockers[0]?.note).toContain('10m00s');
  });

  it('blocks weak timestamps that clearly fall outside included pharos trip dates', () => {
    const blockers = detectProjectTimelineBlockers({
      assets: [{
        id: 'asset-pharos',
        kind: 'video',
        sourcePath: '20260420_081530.mp4',
        displayName: '20260420_081530.mp4',
        ingestRootId: 'root-1',
        capturedAt: '2026-04-20T08:15:30.000Z',
        captureTimeSource: 'filename',
      }],
      roots: [{
        id: 'root-1',
        enabled: true,
      }],
      itinerary: {
        segments: [],
        warnings: [],
      },
      geoCache: null,
      pharosContext: {
        schemaVersion: '1.0',
        generatedAt: '2026-04-13T00:00:00.000Z',
        status: 'success',
        rootPath: 'projects/project-a/pharos',
        discoveredTripIds: ['trip-a'],
        includedTripIds: [],
        warnings: [],
        errors: [],
        trips: [{
          tripId: 'trip-a',
          title: 'Trip A',
          timezone: 'Asia/Shanghai',
          dateStart: '2026-04-12',
          dateEnd: '2026-04-12',
          mustCount: 0,
          optionalCount: 0,
          pendingCount: 0,
          expectedCount: 0,
          unexpectedCount: 0,
          abandonedCount: 0,
          gpxCount: 0,
          warnings: [],
        }],
        shots: [],
        gpxFiles: [],
      },
    });

    expect(blockers).toHaveLength(1);
    expect(blockers[0]?.note).toContain('Pharos trip Trip A');
  });

  it('does not block weak timestamps that still fall inside a pharos trip boundary', () => {
    const blockers = detectProjectTimelineBlockers({
      assets: [{
        id: 'asset-pharos',
        kind: 'video',
        sourcePath: '20260412_081530.mp4',
        displayName: '20260412_081530.mp4',
        ingestRootId: 'root-1',
        capturedAt: '2026-04-12T08:15:30.000Z',
        captureTimeSource: 'filename',
      }],
      roots: [{
        id: 'root-1',
        enabled: true,
      }],
      itinerary: {
        segments: [],
        warnings: [],
      },
      geoCache: null,
      pharosContext: {
        schemaVersion: '1.0',
        generatedAt: '2026-04-13T00:00:00.000Z',
        status: 'success',
        rootPath: 'projects/project-a/pharos',
        discoveredTripIds: ['trip-a'],
        includedTripIds: [],
        warnings: [],
        errors: [],
        trips: [{
          tripId: 'trip-a',
          title: 'Trip A',
          timezone: 'Asia/Shanghai',
          dateStart: '2026-04-12',
          dateEnd: '2026-04-12',
          mustCount: 0,
          optionalCount: 0,
          pendingCount: 0,
          expectedCount: 0,
          unexpectedCount: 0,
          abandonedCount: 0,
          gpxCount: 0,
          warnings: [],
        }],
        shots: [],
        gpxFiles: [],
      },
    });

    expect(blockers).toEqual([]);
  });
});
