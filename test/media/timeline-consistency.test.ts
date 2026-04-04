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
});
