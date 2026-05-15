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
      pharosSpatial: {
        locationCandidates: [
          {
            role: 'start',
            lat: 39.909187,
            lng: 116.397463,
          },
          {
            role: 'end',
            lat: 31.230416,
            lng: 121.473701,
          },
        ],
      },
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

  it('uses embedded GPS coordinate ahead of Pharos candidates', async () => {
    const result = await resolveAnalyzeLocationText({
      clipType: 'broll',
      manualSpatial: {
        placeHints: [],
        decisionReasons: ['embedded-gps'],
        inferredGps: {
          source: 'embedded',
          embeddedOriginType: 'sidecar-srt',
          confidence: 0.98,
          lat: 29.6101,
          lng: 101.7832,
        },
      },
      pharosSpatial: {
        locationCandidates: [{
          role: 'point',
          lat: 30.0500,
          lng: 102.0300,
        }],
      },
      reverseGeocodeService: createReverseGeocodeService({
        '29.6101,101.7832': {
          locationText: '四川省，甘孜藏族自治州，康定市 · 子梅垭口',
          province: '四川省',
          city: '甘孜藏族自治州',
          district: '康定市',
        },
        '30.05,102.03': {
          locationText: '四川省，甘孜藏族自治州，泸定县 · 其他点',
          province: '四川省',
          city: '甘孜藏族自治州',
          district: '泸定县',
        },
      }),
    });

    expect(result.locationText).toBe('四川省，甘孜藏族自治州，康定市 · 子梅垭口');
    expect(result.locationText).not.toContain('其他点');
  });
});
