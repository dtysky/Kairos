import { describe, expect, it } from 'vitest';
import { resolveAnalyzePrimarySpatial } from '../../src/modules/media/spatial-priority.js';

describe('resolveAnalyzePrimarySpatial', () => {
  it('keeps embedded GPS ahead of matched Pharos GPX', () => {
    const result = resolveAnalyzePrimarySpatial({
      manualSpatial: {
        gpsSummary: 'embedded 30.000000,100.000000',
        inferredGps: {
          source: 'embedded',
          embeddedOriginType: 'sidecar-srt',
          confidence: 0.98,
          lat: 30,
          lng: 100,
        },
      },
      pharosSpatial: {
        gpsSummary: 'pharos-gpx 31.000000,101.000000',
        inferredGps: {
          source: 'pharos',
          confidence: 0.8,
          lat: 31,
          lng: 101,
        },
      },
    });

    expect(result.inferredGps?.source).toBe('embedded');
    expect(result.inferredGps?.lat).toBe(30);
    expect(result.gpsSummary).toContain('embedded');
  });

  it('uses Pharos GPX ahead of generic GPX when embedded GPS is absent', () => {
    const result = resolveAnalyzePrimarySpatial({
      manualSpatial: {
        gpsSummary: 'gpx 30.000000,100.000000',
        inferredGps: {
          source: 'gpx',
          confidence: 0.95,
          lat: 30,
          lng: 100,
        },
      },
      pharosSpatial: {
        gpsSummary: 'pharos-gpx 31.000000,101.000000',
        inferredGps: {
          source: 'pharos',
          confidence: 0.8,
          lat: 31,
          lng: 101,
        },
      },
    });

    expect(result.inferredGps?.source).toBe('pharos');
    expect(result.inferredGps?.lat).toBe(31);
    expect(result.gpsSummary).toContain('pharos-gpx');
  });
});
