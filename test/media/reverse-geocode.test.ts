import { describe, expect, it } from 'vitest';
import { resolveAnalyzeLocationText } from '../../src/modules/media/reverse-geocode.js';

function createReverseGeocodeService(locations: Record<string, {
  locationText?: string;
  country?: string;
  province?: string;
  city?: string;
  district?: string;
}>) {
  return {
    prewarm: async () => undefined,
    reverseGeocode: async (lat: number, lng: number) => {
      const entry = locations[`${lat},${lng}`];
      if (!entry) return null;
      return {
        locationKey: `${lng.toFixed(6)},${lat.toFixed(6)}`,
        lat,
        lng,
        provider: 'test',
        status: 'ok' as const,
        fetchedAt: '2026-04-15T00:00:00.000Z',
        ...entry,
      };
    },
  };
}

describe('resolveAnalyzeLocationText', () => {
  it('builds drive locationText from matched Pharos start/end GPS', async () => {
    const result = await resolveAnalyzeLocationText({
      clipType: 'drive',
      pharosContext: {
        schemaVersion: '1.0',
        generatedAt: '2026-04-15T00:00:00.000Z',
        status: 'success',
        rootPath: 'H:/Pharos',
        discoveredTripIds: ['trip-1'],
        includedTripIds: ['trip-1'],
        warnings: [],
        errors: [],
        trips: [],
        gpxFiles: [],
        shots: [{
          ref: { tripId: 'trip-1', shotId: 'shot-1' },
          location: 'ignored',
          description: 'drive shot',
          type: 'continuous',
          gpsStart: [116.397463, 39.909187],
          gpsEnd: [121.473701, 31.230416],
          devices: [],
          rolls: [],
          isExtraShot: false,
        }],
      },
      pharosMatches: [{
        ref: { tripId: 'trip-1', shotId: 'shot-1' },
        confidence: 0.82,
        tripTitle: 'trip',
        dayTitle: 'day',
        matchReasons: [],
      }],
      reverseGeocodeService: createReverseGeocodeService({
        '39.909187,116.397463': {
          locationText: '北京市，北京市，东城区 · 天安门',
          province: '北京市',
          city: '北京市',
          district: '东城区',
        },
        '31.230416,121.473701': {
          locationText: '上海市，上海市，黄浦区 · 外滩',
          province: '上海市',
          city: '上海市',
          district: '黄浦区',
        },
      }),
    });

    expect(result.locationText).toBe('北京市，北京市，东城区 · 天安门 -> 上海市，上海市，黄浦区 · 外滩');
    expect(result.placeHints).toContain('北京市，北京市，东城区 · 天安门');
    expect(result.placeHints).toContain('上海市，上海市，黄浦区 · 外滩');
  });

  it('uses selected manual spatial coordinate when Pharos match is absent', async () => {
    const result = await resolveAnalyzeLocationText({
      clipType: 'broll',
      manualSpatial: {
        placeHints: [],
        decisionReasons: [],
        locationCandidates: [{
          role: 'point',
          lat: 22.2802,
          lng: 114.1595,
        }],
      },
      reverseGeocodeService: createReverseGeocodeService({
        '22.2802,114.1595': {
          locationText: '中国，香港，香港岛 · 中环',
          country: '中国',
          city: '香港',
          district: '香港岛',
        },
      }),
    });

    expect(result.locationText).toBe('中国，香港，香港岛 · 中环');
    expect(result.placeHints).toContain('香港');
    expect(result.placeHints).toContain('香港岛');
  });
});
