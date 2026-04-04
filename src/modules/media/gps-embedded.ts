import type { IEmbeddedGpsBinding, IInferredGps, IKtepAsset } from '../../protocol/schema.js';

export interface IEmbeddedGpsContext {
  gpsSummary: string;
  inferredGps: IInferredGps;
  placeHints: string[];
  decisionReasons: string[];
}

export function resolveEmbeddedGpsContext(
  asset: Pick<IKtepAsset, 'capturedAt' | 'metadata' | 'embeddedGps'>,
): IEmbeddedGpsContext | null {
  const binding = asset.embeddedGps;
  if (binding) {
    return buildEmbeddedContext(
      binding.representativeLat,
      binding.representativeLng,
      binding.sourcePath ?? binding.originType,
      binding.originType,
      binding.originType,
      binding.confidence,
    );
  }

  const candidate = resolveEmbeddedGpsCandidate(asset.metadata);
  if (!candidate) return null;
  return buildEmbeddedContext(
    candidate.lat,
    candidate.lng,
    candidate.originalValue,
    candidate.sourceKey,
    candidate.originType,
    candidate.confidence,
  );
}

export function resolveEmbeddedGpsBinding(
  asset: Pick<IKtepAsset, 'capturedAt' | 'metadata' | 'embeddedGps'>,
): IEmbeddedGpsBinding | null {
  if (asset.embeddedGps) {
    return asset.embeddedGps;
  }
  if (!asset.capturedAt) return null;

  const candidate = resolveEmbeddedGpsCandidate(asset.metadata);
  if (!candidate) return null;

  return {
    originType: candidate.originType,
    confidence: candidate.confidence,
    representativeTime: asset.capturedAt,
    representativeLat: candidate.lat,
    representativeLng: candidate.lng,
    pointCount: 1,
    startTime: asset.capturedAt,
    endTime: asset.capturedAt,
  };
}

function buildEmbeddedContext(
  lat: number,
  lng: number,
  originalValue: string,
  sourceKey: string,
  originType: NonNullable<IInferredGps['embeddedOriginType']>,
  confidence: number,
): IEmbeddedGpsContext {
  const gpsSummary = `embedded ${lat.toFixed(6)},${lng.toFixed(6)}`;
  return {
    gpsSummary,
    inferredGps: {
      source: 'embedded',
      confidence,
      lat,
      lng,
      embeddedOriginType: originType,
      summary: gpsSummary,
    },
    placeHints: [],
    decisionReasons: [
      'embedded-gps',
      `embedded-gps:${sourceKey}`,
      `embedded-gps-original:${originalValue}`,
    ],
  };
}

function readMetadataRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function resolveEmbeddedGpsCandidate(
  metadataValue: unknown,
): {
  lat: number;
  lng: number;
  originalValue: string;
  sourceKey: string;
  originType: NonNullable<IInferredGps['embeddedOriginType']>;
  confidence: number;
} | null {
  const metadata = readMetadataRecord(metadataValue);
  if (!metadata) return null;

  const rawTags = readMetadataRecord(metadata['rawTags']);
  const iso6709 = firstString(
    rawTags?.['location'],
    rawTags?.['location-eng'],
    rawTags?.['location_eng'],
    rawTags?.['com.apple.quicktime.location.iso6709'],
    rawTags?.['com.apple.quicktime.location_iso6709'],
    metadata['location'],
    metadata['location-eng'],
    metadata['location_eng'],
    metadata['com.apple.quicktime.location.iso6709'],
    metadata['com.apple.quicktime.location_iso6709'],
  );
  const parsedIso = parseIso6709(iso6709);
  if (parsedIso) {
    return {
      lat: parsedIso.lat,
      lng: parsedIso.lng,
      originalValue: iso6709!,
      sourceKey: 'iso6709',
      originType: 'metadata',
      confidence: 0.98,
    };
  }

  const lat = parseCoordinateValue(
    firstString(
      metadata['GPSLatitude'],
      metadata['gpslatitude'],
      metadata['gpsLatitude'],
      metadata['latitude'],
      metadata['lat'],
      rawTags?.['gpslatitude'],
      rawTags?.['latitude'],
    ),
    firstString(
      metadata['GPSLatitudeRef'],
      metadata['gpslatituderef'],
      metadata['gpsLatitudeRef'],
      rawTags?.['gpslatituderef'],
    ),
  );
  const lng = parseCoordinateValue(
    firstString(
      metadata['GPSLongitude'],
      metadata['gpslongitude'],
      metadata['gpsLongitude'],
      metadata['longitude'],
      metadata['lng'],
      metadata['lon'],
      rawTags?.['gpslongitude'],
      rawTags?.['longitude'],
      rawTags?.['lon'],
    ),
    firstString(
      metadata['GPSLongitudeRef'],
      metadata['gpslongituderef'],
      metadata['gpsLongitudeRef'],
      rawTags?.['gpslongituderef'],
    ),
  );

  if (lat == null || lng == null) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return {
    lat,
    lng,
    originalValue: `${lat},${lng}`,
    sourceKey: 'lat-lng',
    originType: 'metadata',
    confidence: 0.98,
  };
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function parseIso6709(value?: string): { lat: number; lng: number } | null {
  if (!value) return null;
  const match = value.trim().match(/^([+-]\d{1,2}(?:\.\d+)?)([+-]\d{1,3}(?:\.\d+)?)(?:[+-]\d+(?:\.\d+)?)?\/?$/u);
  if (!match?.[1] || !match[2]) return null;

  const lat = Number(match[1]);
  const lng = Number(match[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

function parseCoordinateValue(value?: string, ref?: string): number | null {
  if (!value) return null;
  const components = value
    .trim()
    .split(/[\s,]+/u)
    .map(parseCoordinatePart)
    .filter((item): item is number => item != null);
  if (components.length === 0) return null;

  const base = components.length === 1
    ? components[0]
    : Math.abs(components[0]) + ((components[1] ?? 0) / 60) + ((components[2] ?? 0) / 3600);
  if (!Number.isFinite(base)) return null;

  const explicitSign = components[0] != null && components[0] < 0 ? -1 : 1;
  const normalizedRef = ref?.trim().toUpperCase();
  const refSign = normalizedRef === 'S' || normalizedRef === 'W'
    ? -1
    : normalizedRef === 'N' || normalizedRef === 'E'
      ? 1
      : undefined;
  return Math.abs(base) * (refSign ?? explicitSign);
}

function parseCoordinatePart(value: string): number | null {
  if (!value) return null;
  const rational = value.match(/^([+-]?\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/u);
  if (rational?.[1] && rational[2]) {
    const numerator = Number(rational[1]);
    const denominator = Number(rational[2]);
    if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return null;
    return numerator / denominator;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
