import nodeFetch from 'node-fetch';
import type {
  EClipType,
} from '../../protocol/schema.js';
import {
  formatReverseGeocodeLocationKey,
  loadReverseGeocodeCache,
  type IReverseGeocodeCacheEntry,
  writeReverseGeocodeCache,
} from '../../store/reverse-geocode-cache.js';
import type { IRuntimeConfig } from '../../store/project.js';
import type { IManualSpatialContext, ISpatialLocationCandidate } from './manual-spatial.js';
import type { IPharosTimedSpatialContext } from '../pharos/gpx-timed.js';

const CDEFAULT_AMAP_REVERSE_GEOCODE_URL = 'https://restapi.amap.com/v3/geocode/regeo';
const CDEFAULT_AMAP_NEARBY_SEARCH_URL = 'https://restapi.amap.com/v3/place/around';
const CDEFAULT_GEOAPIFY_REVERSE_GEOCODE_URL = 'https://api.geoapify.com/v1/geocode/reverse';
const CDEFAULT_GEOAPIFY_PLACES_URL = 'https://api.geoapify.com/v2/places';
const CREVERSE_GEOCODE_TIMEOUT_MS = 20_000;

const fetchCompat: typeof fetch = typeof globalThis.fetch === 'function'
  ? globalThis.fetch.bind(globalThis)
  : ((
    input: Parameters<typeof nodeFetch>[0],
    init?: Parameters<typeof nodeFetch>[1],
  ) => nodeFetch(input, init)) as typeof fetch;

interface IAmapRegeoResponse {
  status?: string;
  info?: string;
  infocode?: string;
  regeocode?: {
    formatted_address?: string;
    addressComponent?: {
      country?: string | string[];
      province?: string | string[];
      city?: string | string[];
      district?: string | string[];
      township?: string | string[];
      streetNumber?: {
        street?: string;
        number?: string;
      };
      building?: {
        name?: string | string[];
      };
      neighborhood?: {
        name?: string | string[];
      };
    };
    aois?: Array<{ name?: string; distance?: string }>;
    pois?: Array<{ name?: string; distance?: string }>;
  };
}

interface IAmapAroundPoi {
  name?: string | string[];
  distance?: string | number;
  pname?: string | string[];
  cityname?: string | string[];
  adname?: string | string[];
  address?: string | string[];
}

interface IAmapAroundResponse {
  status?: string;
  info?: string;
  infocode?: string;
  pois?: IAmapAroundPoi[];
}

interface IGeoapifyReverseResult {
  formatted?: string;
  country?: string;
  state?: string;
  county?: string;
  city?: string;
  suburb?: string;
  district?: string;
  street?: string;
  housenumber?: string;
  name?: string;
  address_line1?: string;
  address_line2?: string;
}

interface IGeoapifyReverseResponse {
  results?: IGeoapifyReverseResult[];
}

interface IGeoapifyPlaceProperties {
  name?: string;
  formatted?: string;
  address_line1?: string;
  address_line2?: string;
  country?: string;
  state?: string;
  county?: string;
  city?: string;
  suburb?: string;
  district?: string;
}

interface IGeoapifyPlacesFeature {
  properties?: IGeoapifyPlaceProperties;
}

interface IGeoapifyPlacesResponse {
  features?: IGeoapifyPlacesFeature[];
}

interface IPartialReverseGeocode {
  locationText?: string;
  country?: string;
  province?: string;
  city?: string;
  district?: string;
}

export interface IReverseGeocodeService {
  reverseGeocode(lat: number, lng: number): Promise<IReverseGeocodeCacheEntry | null>;
  prewarm(points: Array<{ lat: number; lng: number }>): Promise<void>;
}

export interface IResolvedAnalyzeLocationText {
  locationText?: string;
  placeHints: string[];
}

export async function createProjectReverseGeocodeService(input: {
  projectRoot: string;
  runtimeConfig: Pick<IRuntimeConfig, 'amapWebServiceKey' | 'geoapifyApiKey'>;
}): Promise<IReverseGeocodeService> {
  const cache = await loadReverseGeocodeCache(input.projectRoot);
  return new ProjectReverseGeocodeService(
    input.projectRoot,
    input.runtimeConfig,
    cache?.entries ?? [],
  );
}

export function isLikelyChinaCoordinate(lat: number, lng: number): boolean {
  return lat >= 18 && lat <= 54 && lng >= 73 && lng <= 136;
}

export async function resolveAnalyzeLocationText(input: {
  clipType: EClipType;
  manualSpatial?: IManualSpatialContext | null;
  pharosSpatial?: Pick<IPharosTimedSpatialContext, 'locationCandidates'> | null;
  reverseGeocodeService?: IReverseGeocodeService | null;
}): Promise<IResolvedAnalyzeLocationText> {
  const candidates = selectPreferredLocationCandidates(input);
  if (!input.reverseGeocodeService || candidates.length === 0) {
    return { placeHints: [] };
  }

  const resolvedByKey = new Map<string, IReverseGeocodeCacheEntry>();
  for (const candidate of dedupeLocationCandidates(candidates)) {
    const resolved = await input.reverseGeocodeService.reverseGeocode(candidate.lat, candidate.lng);
    if (!resolved) continue;
    resolvedByKey.set(formatReverseGeocodeLocationKey(candidate.lng, candidate.lat), resolved);
  }

  const locationText = input.clipType === 'drive'
    ? resolveDriveLocationText(candidates, resolvedByKey)
    : resolvePointLocationText(candidates, resolvedByKey);
  const placeHints = dedupeStrings([
    locationText,
    ...[...resolvedByKey.values()].flatMap(entry => buildReverseGeocodePlaceHints(entry)),
  ]);

  return {
    locationText,
    placeHints,
  };
}

class ProjectReverseGeocodeService implements IReverseGeocodeService {
  private readonly cache = new Map<string, IReverseGeocodeCacheEntry>();

  constructor(
    private readonly projectRoot: string,
    private readonly runtimeConfig: Pick<IRuntimeConfig, 'amapWebServiceKey' | 'geoapifyApiKey'>,
    entries: IReverseGeocodeCacheEntry[],
  ) {
    for (const entry of entries) {
      this.cache.set(entry.locationKey, entry);
    }
  }

  async reverseGeocode(lat: number, lng: number): Promise<IReverseGeocodeCacheEntry | null> {
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    const key = formatReverseGeocodeLocationKey(lng, lat);
    const cached = this.cache.get(key);
    if (cached) return cached;

    const amapKey = this.runtimeConfig.amapWebServiceKey?.trim() || null;
    const geoapifyKey = this.runtimeConfig.geoapifyApiKey?.trim() || null;
    if (!amapKey && !geoapifyKey) {
      return null;
    }

    const fetched = await fetchBestReverseGeocodeForCoordinate(lng, lat, {
      amapKey,
      geoapifyKey,
    });
    this.cache.set(key, fetched);
    await writeReverseGeocodeCache(this.projectRoot, [...this.cache.values()]);
    return fetched;
  }

  async prewarm(points: Array<{ lat: number; lng: number }>): Promise<void> {
    for (const point of dedupeCoordinatePoints(points)) {
      await this.reverseGeocode(point.lat, point.lng);
    }
  }
}

async function fetchBestReverseGeocodeForCoordinate(
  lng: number,
  lat: number,
  keys: {
    amapKey: string | null;
    geoapifyKey: string | null;
  },
): Promise<IReverseGeocodeCacheEntry> {
  const inChina = isLikelyChinaCoordinate(lat, lng);
  const providerOrder = inChina
    ? [
      { provider: 'amap', key: keys.amapKey },
      { provider: 'geoapify', key: keys.geoapifyKey },
    ]
    : [
      { provider: 'geoapify', key: keys.geoapifyKey },
      { provider: 'amap', key: keys.amapKey },
    ];

  let lastResult: IReverseGeocodeCacheEntry | null = null;
  for (const entry of providerOrder) {
    if (!entry.key) continue;
    const result = entry.provider === 'amap'
      ? await fetchAmapReverseGeocode(lng, lat, entry.key)
      : await fetchGeoapifyReverseGeocode(lng, lat, entry.key);
    if (result.status === 'ok' && result.locationText) {
      return result;
    }
    lastResult = result;
  }

  return lastResult ?? buildReverseGeocodeErrorRow(lng, lat, 'none', 'No geocode provider key configured');
}

async function fetchAmapReverseGeocode(
  lng: number,
  lat: number,
  apiKey: string,
): Promise<IReverseGeocodeCacheEntry> {
  const params = new URLSearchParams({
    key: apiKey,
    location: formatReverseGeocodeLocationKey(lng, lat),
    output: 'json',
    extensions: 'all',
    radius: '500',
  });

  const response = await fetchJson(`${CDEFAULT_AMAP_REVERSE_GEOCODE_URL}?${params.toString()}`);
  if (!response.ok) {
    return buildReverseGeocodeErrorRow(lng, lat, 'amap-webservice', response.error ?? `HTTP ${response.status}`);
  }

  const payload = response.json as IAmapRegeoResponse;
  if (payload.status !== '1') {
    return buildReverseGeocodeErrorRow(
      lng,
      lat,
      'amap-webservice',
      [payload.info, payload.infocode].filter(Boolean).join(' / ') || 'AMap reverse geocode failed',
    );
  }

  const location = buildLocationTextFromAmap(payload);
  if (location.locationText) {
    return buildReverseGeocodeRow(lng, lat, 'amap-webservice', 'ok', location);
  }

  const nearby = await fetchAmapNearestPoi(lng, lat, apiKey, location);
  if (nearby.status === 'ok' && nearby.locationText) {
    return buildReverseGeocodeRow(lng, lat, nearby.provider, 'ok', nearby);
  }
  if (nearby.status === 'error') {
    return buildReverseGeocodeErrorRow(lng, lat, nearby.provider, nearby.lastError ?? 'AMap nearby POI failed');
  }
  return buildReverseGeocodeRow(lng, lat, 'amap-webservice', 'empty', location);
}

async function fetchGeoapifyReverseGeocode(
  lng: number,
  lat: number,
  apiKey: string,
): Promise<IReverseGeocodeCacheEntry> {
  const params = new URLSearchParams({
    lat: String(lat),
    lon: String(lng),
    format: 'json',
    lang: 'zh',
    apiKey,
  });

  const response = await fetchJson(`${CDEFAULT_GEOAPIFY_REVERSE_GEOCODE_URL}?${params.toString()}`);
  if (!response.ok) {
    return buildReverseGeocodeErrorRow(lng, lat, 'geoapify-geocode', response.error ?? `HTTP ${response.status}`);
  }

  const payload = response.json as IGeoapifyReverseResponse;
  const location = buildLocationTextFromGeoapifyReverse(payload);
  if (location.locationText) {
    return buildReverseGeocodeRow(lng, lat, 'geoapify-geocode', 'ok', location);
  }

  const nearby = await fetchGeoapifyNearestPoi(lng, lat, apiKey, location);
  if (nearby.status === 'ok' && nearby.locationText) {
    return buildReverseGeocodeRow(lng, lat, nearby.provider, 'ok', nearby);
  }
  if (nearby.status === 'error') {
    return buildReverseGeocodeErrorRow(lng, lat, nearby.provider, nearby.lastError ?? 'Geoapify nearby POI failed');
  }
  return buildReverseGeocodeRow(lng, lat, 'geoapify-geocode', 'empty', location);
}

async function fetchAmapNearestPoi(
  lng: number,
  lat: number,
  apiKey: string,
  fallback: IPartialReverseGeocode,
): Promise<IPartialReverseGeocode & {
  provider: string;
  status: 'ok' | 'empty' | 'error';
  lastError?: string;
}> {
  const params = new URLSearchParams({
    key: apiKey,
    location: formatReverseGeocodeLocationKey(lng, lat),
    output: 'json',
    sortrule: 'distance',
    offset: '1',
    page: '1',
    radius: '1000',
  });
  const response = await fetchJson(`${CDEFAULT_AMAP_NEARBY_SEARCH_URL}?${params.toString()}`);
  if (!response.ok) {
    return {
      provider: 'amap-webservice-around',
      status: 'error',
      lastError: response.error ?? `HTTP ${response.status}`,
      ...fallback,
    };
  }

  const payload = response.json as IAmapAroundResponse;
  if (payload.status !== '1') {
    return {
      provider: 'amap-webservice-around',
      status: 'error',
      lastError: [payload.info, payload.infocode].filter(Boolean).join(' / ') || 'AMap nearby POI search failed',
      ...fallback,
    };
  }

  const resolved = buildLocationTextFromAmapNearbyPoi(payload, fallback);
  return {
    provider: 'amap-webservice-around',
    status: resolved.locationText ? 'ok' : 'empty',
    ...resolved,
  };
}

async function fetchGeoapifyNearestPoi(
  lng: number,
  lat: number,
  apiKey: string,
  fallback: IPartialReverseGeocode,
): Promise<IPartialReverseGeocode & {
  provider: string;
  status: 'ok' | 'empty' | 'error';
  lastError?: string;
}> {
  const params = new URLSearchParams({
    categories: 'accommodation,catering,commercial,education,entertainment,healthcare,heritage,leisure,natural,public_transport,religion,service,sport,tourism',
    filter: `circle:${lng},${lat},1000`,
    bias: `proximity:${lng},${lat}`,
    limit: '1',
    lang: 'zh',
    apiKey,
  });
  const response = await fetchJson(`${CDEFAULT_GEOAPIFY_PLACES_URL}?${params.toString()}`);
  if (!response.ok) {
    return {
      provider: 'geoapify-places',
      status: 'error',
      lastError: response.error ?? `HTTP ${response.status}`,
      ...fallback,
    };
  }

  const resolved = buildLocationTextFromGeoapifyPlaces(response.json as IGeoapifyPlacesResponse, fallback);
  return {
    provider: 'geoapify-places',
    status: resolved.locationText ? 'ok' : 'empty',
    ...resolved,
  };
}

async function fetchJson(
  url: string,
): Promise<{ ok: boolean; status: number; json?: unknown; error?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CREVERSE_GEOCODE_TIMEOUT_MS);
  try {
    const response = await fetchCompat(url, {
      method: 'GET',
      signal: controller.signal,
    });
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        error: `HTTP ${response.status}`,
      };
    }
    return {
      ok: true,
      status: response.status,
      json: await response.json(),
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

function buildLocationTextFromAmap(response: IAmapRegeoResponse): IPartialReverseGeocode {
  const component = response.regeocode?.addressComponent;
  const country = extractAmapText(component?.country);
  const province = extractAmapText(component?.province);
  const city = extractAmapText(component?.city);
  const district = extractAmapText(component?.district);
  const township = extractAmapText(component?.township);
  const street = extractAmapText(component?.streetNumber?.street);
  const building = extractAmapText(component?.building?.name);
  const neighborhood = extractAmapText(component?.neighborhood?.name);
  const aoi = firstNearbyPlaceName(response.regeocode?.aois);
  const poi = firstNearbyPlaceName(response.regeocode?.pois);
  const formatted = extractAmapText(response.regeocode?.formatted_address);
  const area = composeLocationText([province, city, district]);
  const locationText = composeBalancedGeocodeLocation(
    area,
    township,
    aoi || poi || neighborhood || building,
    street,
  ) || composeLocationText([country, province, city, district]) || formatted;

  return {
    locationText,
    country,
    province,
    city,
    district,
  };
}

function buildLocationTextFromAmapNearbyPoi(
  response: IAmapAroundResponse,
  fallback: IPartialReverseGeocode,
): IPartialReverseGeocode {
  const poi = firstNearbyPoi(response.pois);
  const province = poi?.province || fallback.province;
  const city = poi?.city || fallback.city;
  const district = poi?.district || fallback.district;
  const area = composeLocationText([province, city, district]);
  const point = poi?.name || poi?.address || null;
  return {
    locationText: composeBalancedGeocodeLocation(area, null, point, poi?.address || null)
      || composeLocationText([fallback.country, province, city, district])
      || point
      || undefined,
    country: fallback.country,
    province,
    city,
    district,
  };
}

function buildLocationTextFromGeoapifyReverse(
  response: IGeoapifyReverseResponse,
): IPartialReverseGeocode {
  const result = response.results?.[0];
  const country = normalizeText(result?.country);
  const province = normalizeText(result?.state);
  const city = normalizeText(result?.city) || normalizeText(result?.county);
  const district = normalizeText(result?.district) || normalizeText(result?.suburb);
  const point = normalizeText(result?.name) || normalizeText(result?.address_line1);
  const formatted = normalizeText(result?.address_line2) || normalizeText(result?.formatted);
  const area = composeLocationText([country, province, city, district]);

  return {
    locationText: composeBalancedGeocodeLocation(area, null, point, formatted) || area || formatted,
    country,
    province,
    city,
    district,
  };
}

function buildLocationTextFromGeoapifyPlaces(
  response: IGeoapifyPlacesResponse,
  fallback: IPartialReverseGeocode,
): IPartialReverseGeocode {
  const place = response.features?.[0]?.properties;
  const country = normalizeText(place?.country) || fallback.country;
  const province = normalizeText(place?.state) || fallback.province;
  const city = normalizeText(place?.city) || normalizeText(place?.county) || fallback.city;
  const district = normalizeText(place?.district) || normalizeText(place?.suburb) || fallback.district;
  const point = normalizeText(place?.name) || normalizeText(place?.address_line1);
  const formatted = normalizeText(place?.address_line2)
    || normalizeText(place?.formatted)
    || normalizeText(place?.address_line1);
  const area = composeLocationText([country, province, city, district]);

  return {
    locationText: composeBalancedGeocodeLocation(area, null, point, formatted) || area || formatted || point,
    country,
    province,
    city,
    district,
  };
}

function buildReverseGeocodePlaceHints(entry: IReverseGeocodeCacheEntry): string[] {
  return dedupeStrings([
    entry.locationText,
    composeLocationText([entry.province, entry.city, entry.district]),
    entry.city,
    entry.district,
  ]);
}

function selectPreferredLocationCandidates(input: {
  clipType: EClipType;
  manualSpatial?: IManualSpatialContext | null;
  pharosSpatial?: Pick<IPharosTimedSpatialContext, 'locationCandidates'> | null;
}): ISpatialLocationCandidate[] {
  if (input.pharosSpatial?.locationCandidates?.length) {
    return input.pharosSpatial.locationCandidates.map(candidate => ({
      role: candidate.role,
      lat: candidate.lat,
      lng: candidate.lng,
    }));
  }

  if (input.manualSpatial?.locationCandidates?.length) {
    return input.manualSpatial.locationCandidates;
  }
  if (input.manualSpatial?.inferredGps) {
    return [{
      role: 'point',
      lat: input.manualSpatial.inferredGps.lat,
      lng: input.manualSpatial.inferredGps.lng,
    }];
  }
  return [];
}

function resolveDriveLocationText(
  candidates: ISpatialLocationCandidate[],
  resolvedByKey: Map<string, IReverseGeocodeCacheEntry>,
): string | undefined {
  const start = resolveCandidateLocationText(
    candidates.find(candidate => candidate.role === 'start') ?? candidates[0],
    resolvedByKey,
  );
  const end = resolveCandidateLocationText(
    candidates.find(candidate => candidate.role === 'end') ?? candidates[candidates.length - 1],
    resolvedByKey,
  );
  if (start && end) {
    return normalizeLocationIdentity(start) === normalizeLocationIdentity(end)
      ? start
      : `${start} -> ${end}`;
  }
  return start || end || undefined;
}

function resolvePointLocationText(
  candidates: ISpatialLocationCandidate[],
  resolvedByKey: Map<string, IReverseGeocodeCacheEntry>,
): string | undefined {
  return resolveCandidateLocationText(candidates[0], resolvedByKey);
}

function resolveCandidateLocationText(
  candidate: ISpatialLocationCandidate | undefined,
  resolvedByKey: Map<string, IReverseGeocodeCacheEntry>,
): string | undefined {
  if (!candidate) return undefined;
  return resolvedByKey.get(formatReverseGeocodeLocationKey(candidate.lng, candidate.lat))
    ?.locationText;
}

function buildReverseGeocodeRow(
  lng: number,
  lat: number,
  provider: string,
  status: 'ok' | 'empty' | 'error',
  location: IPartialReverseGeocode,
): IReverseGeocodeCacheEntry {
  return {
    locationKey: formatReverseGeocodeLocationKey(lng, lat),
    lat,
    lng,
    provider,
    status,
    locationText: location.locationText?.trim() || undefined,
    country: location.country?.trim() || undefined,
    province: location.province?.trim() || undefined,
    city: location.city?.trim() || undefined,
    district: location.district?.trim() || undefined,
    fetchedAt: new Date().toISOString(),
  };
}

function buildReverseGeocodeErrorRow(
  lng: number,
  lat: number,
  provider: string,
  error: string,
): IReverseGeocodeCacheEntry {
  return {
    locationKey: formatReverseGeocodeLocationKey(lng, lat),
    lat,
    lng,
    provider,
    status: 'error',
    fetchedAt: new Date().toISOString(),
    lastError: error,
  };
}

function extractAmapText(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return normalizeText(value) ?? undefined;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const text = extractAmapText(item);
      if (text) return text;
    }
  }
  return undefined;
}

function composeLocationText(parts: Array<string | undefined | null>): string | undefined {
  const values: string[] = [];
  for (const part of parts) {
    const normalized = normalizeText(part);
    if (!normalized || values.includes(normalized)) continue;
    values.push(normalized);
  }
  return values.length > 0 ? values.join('，') : undefined;
}

function composeBalancedGeocodeLocation(
  area: string | undefined,
  township: string | undefined | null,
  poiName: string | undefined | null,
  fallbackStreet: string | undefined | null,
): string | undefined {
  const region = composeLocationText([area, township]);
  const point = normalizeText(poiName) || normalizeText(fallbackStreet);
  if (region && point && !region.includes(point)) {
    return `${region} · ${point}`;
  }
  return region || point || undefined;
}

function firstNearbyPlaceName(items: Array<{ name?: string; distance?: string }> | undefined): string | undefined {
  if (!items || items.length === 0) return undefined;
  const ranked = items
    .map(item => ({
      name: extractAmapText(item.name),
      distance: item.distance == null ? Number.POSITIVE_INFINITY : Number.parseFloat(item.distance),
    }))
    .filter((item): item is { name: string; distance: number } => Boolean(item.name));
  ranked.sort((left, right) => left.distance - right.distance);
  return ranked[0]?.name;
}

function firstNearbyPoi(items: IAmapAroundPoi[] | undefined): {
  name?: string;
  province?: string;
  city?: string;
  district?: string;
  address?: string;
} | null {
  if (!items || items.length === 0) return null;
  const ranked = items
    .map(item => ({
      name: extractAmapText(item.name),
      distance: item.distance == null ? Number.POSITIVE_INFINITY : Number.parseFloat(String(item.distance)),
      province: extractAmapText(item.pname),
      city: extractAmapText(item.cityname),
      district: extractAmapText(item.adname),
      address: extractAmapText(item.address),
    }))
    .filter(item => item.name || item.address);
  ranked.sort((left, right) => left.distance - right.distance);
  return ranked[0] ?? null;
}

function normalizeText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function normalizeLocationIdentity(value: string): string {
  return value.replace(/[\s，、,.·\-–—>]+/gu, '').toLowerCase();
}

function dedupeLocationCandidates(candidates: ISpatialLocationCandidate[]): ISpatialLocationCandidate[] {
  const seen = new Set<string>();
  const deduped: ISpatialLocationCandidate[] = [];
  for (const candidate of candidates) {
    const key = `${candidate.role}:${formatReverseGeocodeLocationKey(candidate.lng, candidate.lat)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(candidate);
  }
  return deduped;
}

function dedupeCoordinatePoints(points: Array<{ lat: number; lng: number }>): Array<{ lat: number; lng: number }> {
  const seen = new Set<string>();
  const deduped: Array<{ lat: number; lng: number }> = [];
  for (const point of points) {
    const key = formatReverseGeocodeLocationKey(point.lng, point.lat);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(point);
  }
  return deduped;
}

function dedupeStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.map(value => value?.trim()).filter(Boolean) as string[])];
}
