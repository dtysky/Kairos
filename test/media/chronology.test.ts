import { describe, expect, it } from 'vitest';
import { buildMediaChronology } from '../../src/modules/media/chronology.js';

describe('buildMediaChronology', () => {
  it('uses inferredGps.source to classify embedded GPS evidence', () => {
    const chronology = buildMediaChronology(
      [{
        id: 'asset-1',
        kind: 'video',
        sourcePath: 'clip.mp4',
        displayName: 'clip.mp4',
        capturedAt: '2026-03-31T08:15:30.000Z',
        createdAt: '2026-03-31T08:15:30.000Z',
      }],
      [{
        assetId: 'asset-1',
        clipTypeGuess: 'broll',
        densityScore: 0.2,
        gpsSummary: 'embedded 39.123456,116.654321',
        inferredGps: {
          source: 'embedded',
          confidence: 0.98,
          lat: 39.123456,
          lng: 116.654321,
        },
        labels: [],
        placeHints: [],
        rootNotes: [],
        sampleFrames: [],
        interestingWindows: [],
        shouldFineScan: false,
        fineScanMode: 'skip',
        fineScanReasons: [],
        createdAt: '2026-03-31T08:15:30.000Z',
        updatedAt: '2026-03-31T08:15:30.000Z',
      }],
      [],
    );

    expect(chronology[0]?.evidence[0]).toEqual({
      source: 'gps',
      value: 'embedded 39.123456,116.654321',
      confidence: 0.95,
    });
  });

  it('uses inferredGps.source to classify derived-track evidence', () => {
    const chronology = buildMediaChronology(
      [{
        id: 'asset-1',
        kind: 'video',
        sourcePath: 'clip.mp4',
        displayName: 'clip.mp4',
        capturedAt: '2026-03-31T08:15:30.000Z',
        createdAt: '2026-03-31T08:15:30.000Z',
      }],
      [{
        assetId: 'asset-1',
        clipTypeGuess: 'broll',
        densityScore: 0.2,
        gpsSummary: 'derived-track manual-itinerary-derived 2026-03-31 07:15:00Z-08:45:00Z 北京市天安门',
        inferredGps: {
          source: 'derived-track',
          derivedOriginType: 'manual-itinerary-derived',
          confidence: 0.45,
          lat: 39.909187,
          lng: 116.397463,
        },
        labels: [],
        placeHints: [],
        rootNotes: [],
        sampleFrames: [],
        interestingWindows: [],
        shouldFineScan: false,
        fineScanMode: 'skip',
        fineScanReasons: [],
        createdAt: '2026-03-31T08:15:30.000Z',
        updatedAt: '2026-03-31T08:15:30.000Z',
      }],
      [],
    );

    expect(chronology[0]?.evidence[0]).toEqual({
      source: 'derived-track',
      value: 'derived-track manual-itinerary-derived 2026-03-31 07:15:00Z-08:45:00Z 北京市天安门',
      confidence: 0.45,
    });
  });
});
