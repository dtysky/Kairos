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
        keepDecision: 'keep',
        materializationPath: 'direct',
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
        keepDecision: 'keep',
        materializationPath: 'direct',
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

  it('applies ingest-root clock offsets to sortCapturedAt', () => {
    const chronology = buildMediaChronology(
      [{
        id: 'asset-1',
        kind: 'photo',
        sourcePath: 'photo.jpg',
        displayName: 'photo.jpg',
        ingestRootId: 'root-photo',
        capturedAt: '2026-04-12T08:09:46.000Z',
        createdAt: '2026-04-12T08:09:46.000Z',
      }],
      [],
      [],
      [{
        id: 'root-photo',
        enabled: true,
        clockOffsetMs: -611_000,
      }],
    );

    expect(chronology[0]?.capturedAt).toBe('2026-04-12T08:09:46.000Z');
    expect(chronology[0]?.sortCapturedAt).toBe('2026-04-12T07:59:35.000Z');
  });

  it('keeps asset-level capturedAtOverride above root clock offsets', () => {
    const chronology = buildMediaChronology(
      [{
        id: 'asset-1',
        kind: 'photo',
        sourcePath: 'photo.jpg',
        displayName: 'photo.jpg',
        ingestRootId: 'root-photo',
        capturedAt: '2026-04-12T08:09:46.000Z',
        createdAt: '2026-04-12T08:09:46.000Z',
      }],
      [],
      [{
        id: 'chrono-1',
        assetId: 'asset-1',
        ingestRootId: 'root-photo',
        capturedAt: '2026-04-12T08:09:46.000Z',
        sortCapturedAt: '2026-04-12T08:09:46.000Z',
        labels: [],
        placeHints: [],
        evidence: [],
        pharosMatches: [],
        correction: {
          capturedAtOverride: '2026-04-12T08:00:01.000Z',
        },
      }],
      [{
        id: 'root-photo',
        enabled: true,
        clockOffsetMs: -611_000,
      }],
    );

    expect(chronology[0]?.sortCapturedAt).toBe('2026-04-12T08:00:01.000Z');
  });
});
