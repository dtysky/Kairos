import { describe, expect, it } from 'vitest';
import { resolveEmbeddedGpsContext } from '../../src/modules/media/gps-embedded.js';

describe('resolveEmbeddedGpsContext', () => {
  it('parses DJI quicktime ISO6709 location from rawTags', () => {
    const result = resolveEmbeddedGpsContext({
      capturedAt: '2026-03-31T08:15:30.000Z',
      metadata: {
        rawTags: {
          location: '+39.123456+116.654321+120.000/',
        },
      },
    } as any);

    expect(result?.inferredGps).toEqual(expect.objectContaining({
      source: 'embedded',
      lat: 39.123456,
      lng: 116.654321,
    }));
    expect(result?.gpsSummary).toContain('embedded');
  });

  it('parses QuickTime location-eng ISO6709 variant', () => {
    const result = resolveEmbeddedGpsContext({
      metadata: {
        rawTags: {
          'location-eng': '+39.555555+116.666666+100.000/',
        },
      },
    } as any);

    expect(result?.inferredGps).toEqual(expect.objectContaining({
      source: 'embedded',
      lat: 39.555555,
      lng: 116.666666,
    }));
  });

  it('parses top-level com.apple.quicktime.location_iso6709 variant', () => {
    const result = resolveEmbeddedGpsContext({
      metadata: {
        'com.apple.quicktime.location_iso6709': '+39.777777+116.888888/',
      },
    } as any);

    expect(result?.inferredGps).toEqual(expect.objectContaining({
      source: 'embedded',
      lat: 39.777777,
      lng: 116.888888,
    }));
  });

  it('parses EXIF gpslatitude/gpslongitude from metadata', () => {
    const result = resolveEmbeddedGpsContext({
      metadata: {
        gpslatitude: '39.909187',
        gpslongitude: '116.397463',
      },
    } as any);

    expect(result?.inferredGps).toEqual(expect.objectContaining({
      source: 'embedded',
      lat: 39.909187,
      lng: 116.397463,
    }));
  });

  it('parses EXIF GPS latitude/longitude rationals with refs', () => {
    const result = resolveEmbeddedGpsContext({
      metadata: {
        GPSLatitude: '39/1 54/1 331/100',
        GPSLatitudeRef: 'N',
        GPSLongitude: '116/1 23/1 5087/100',
        GPSLongitudeRef: 'E',
      },
    } as any);

    expect(result?.inferredGps).toEqual(expect.objectContaining({
      source: 'embedded',
      lat: 39.90091944444444,
      lng: 116.3974638888889,
    }));
  });

  it('returns null when embedded gps metadata is invalid', () => {
    const result = resolveEmbeddedGpsContext({
      metadata: {
        rawTags: {
          location: 'not-a-coordinate',
        },
      },
    } as any);

    expect(result).toBeNull();
  });

  it('prefers asset-bound same-source GPS over raw metadata parsing', () => {
    const result = resolveEmbeddedGpsContext({
      embeddedGps: {
        originType: 'sidecar-srt',
        confidence: 0.96,
        representativeTime: '2026-02-17T03:20:14.000Z',
        representativeLat: -45.03022,
        representativeLng: 168.6627,
        startTime: '2026-02-17T03:20:12.000Z',
        endTime: '2026-02-17T03:20:14.000Z',
        sourcePath: 'DJI_0001.SRT',
        points: [{
          time: '2026-02-17T03:20:14.000Z',
          lat: -45.03022,
          lng: 168.6627,
        }],
      },
      metadata: {
        rawTags: {
          location: '+39.123456+116.654321+120.000/',
        },
      },
    } as any);

    expect(result?.inferredGps).toEqual(expect.objectContaining({
      source: 'embedded',
      embeddedOriginType: 'sidecar-srt',
      confidence: 0.96,
      lat: -45.03022,
      lng: 168.6627,
    }));
  });
});
