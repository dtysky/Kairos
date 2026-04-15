import { join } from 'node:path';
import { z } from 'zod';
import { readJsonOrNull, writeJson } from './writer.js';

export const EReverseGeocodeStatus = z.enum(['ok', 'empty', 'error']);
export type EReverseGeocodeStatus = z.infer<typeof EReverseGeocodeStatus>;

export const IReverseGeocodeCacheEntry = z.object({
  locationKey: z.string(),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  provider: z.string(),
  status: EReverseGeocodeStatus,
  locationText: z.string().optional(),
  country: z.string().optional(),
  province: z.string().optional(),
  city: z.string().optional(),
  district: z.string().optional(),
  fetchedAt: z.string(),
  lastError: z.string().optional(),
});
export type IReverseGeocodeCacheEntry = z.infer<typeof IReverseGeocodeCacheEntry>;

export const IReverseGeocodeCache = z.object({
  schemaVersion: z.literal('1.0'),
  updatedAt: z.string(),
  entries: z.array(IReverseGeocodeCacheEntry),
});
export type IReverseGeocodeCache = z.infer<typeof IReverseGeocodeCache>;

export function formatReverseGeocodeLocationKey(lng: number, lat: number): string {
  return `${normalizeCoordinate(lng)},${normalizeCoordinate(lat)}`;
}

export function getReverseGeocodeCachePath(projectRoot: string): string {
  return join(projectRoot, 'gps', 'reverse-geocode-cache.json');
}

export async function loadReverseGeocodeCache(
  projectRoot: string,
): Promise<IReverseGeocodeCache | null> {
  return readJsonOrNull(getReverseGeocodeCachePath(projectRoot), IReverseGeocodeCache);
}

export async function writeReverseGeocodeCache(
  projectRoot: string,
  entries: IReverseGeocodeCacheEntry[],
): Promise<IReverseGeocodeCache> {
  const cache: IReverseGeocodeCache = {
    schemaVersion: '1.0',
    updatedAt: new Date().toISOString(),
    entries: dedupeReverseGeocodeEntries(entries),
  };
  await writeJson(getReverseGeocodeCachePath(projectRoot), cache);
  return cache;
}

export function findReverseGeocodeCacheEntry(
  cache: IReverseGeocodeCache | null | undefined,
  lng: number,
  lat: number,
): IReverseGeocodeCacheEntry | null {
  const key = formatReverseGeocodeLocationKey(lng, lat);
  return cache?.entries.find(entry => entry.locationKey === key) ?? null;
}

function dedupeReverseGeocodeEntries(
  entries: IReverseGeocodeCacheEntry[],
): IReverseGeocodeCacheEntry[] {
  const byKey = new Map<string, IReverseGeocodeCacheEntry>();
  for (const entry of entries) {
    byKey.set(entry.locationKey, {
      ...entry,
      locationText: entry.locationText?.trim() || undefined,
      country: entry.country?.trim() || undefined,
      province: entry.province?.trim() || undefined,
      city: entry.city?.trim() || undefined,
      district: entry.district?.trim() || undefined,
      lastError: entry.lastError?.trim() || undefined,
    });
  }
  return [...byKey.values()].sort((left, right) => left.locationKey.localeCompare(right.locationKey));
}

function normalizeCoordinate(value: number): string {
  return value.toFixed(6);
}
