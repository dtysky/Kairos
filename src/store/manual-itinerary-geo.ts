import { join } from 'node:path';
import { z } from 'zod';
import { readJsonOrNull, writeJson } from './writer.js';

export const IManualItineraryGeoCacheEntry = z.object({
  query: z.string(),
  lat: z.number(),
  lng: z.number(),
  timezone: z.string(),
  aliases: z.array(z.string()).optional(),
  source: z.string().optional(),
});
export type IManualItineraryGeoCacheEntry = z.infer<typeof IManualItineraryGeoCacheEntry>;

export const IManualItineraryGeoCache = z.object({
  schemaVersion: z.literal('1.0'),
  updatedAt: z.string(),
  entries: z.array(IManualItineraryGeoCacheEntry),
});
export type IManualItineraryGeoCache = z.infer<typeof IManualItineraryGeoCache>;

export function getManualItineraryGeoCachePath(projectRoot: string): string {
  return join(projectRoot, 'config', 'manual-itinerary-geo-cache.json');
}

export async function loadManualItineraryGeoCache(
  projectRoot: string,
): Promise<IManualItineraryGeoCache | null> {
  return readJsonOrNull(
    getManualItineraryGeoCachePath(projectRoot),
    IManualItineraryGeoCache,
  );
}

export async function writeManualItineraryGeoCache(
  projectRoot: string,
  entries: IManualItineraryGeoCacheEntry[],
): Promise<IManualItineraryGeoCache> {
  const cache: IManualItineraryGeoCache = {
    schemaVersion: '1.0',
    updatedAt: new Date().toISOString(),
    entries: dedupeGeoCacheEntries(entries),
  };
  await writeJson(getManualItineraryGeoCachePath(projectRoot), cache);
  return cache;
}

export function findManualItineraryGeoCacheEntry(
  cache: IManualItineraryGeoCache | null | undefined,
  query: string,
): IManualItineraryGeoCacheEntry | null {
  const normalizedQuery = normalizeManualItineraryGeoQuery(query);
  if (!normalizedQuery) return null;

  for (const entry of cache?.entries ?? []) {
    const candidates = [entry.query, ...(entry.aliases ?? [])];
    if (candidates.some(candidate => normalizeManualItineraryGeoQuery(candidate) === normalizedQuery)) {
      return entry;
    }
  }

  return null;
}

export function normalizeManualItineraryGeoQuery(value: string): string {
  return value
    .trim()
    .replace(/[–—]/gu, '-')
    .replace(/[\\/|]+/gu, ' ')
    .replace(/\s*-\s*/gu, ' ')
    .replace(/\s+/gu, ' ')
    .toLowerCase();
}

function dedupeGeoCacheEntries(
  entries: IManualItineraryGeoCacheEntry[],
): IManualItineraryGeoCacheEntry[] {
  const deduped = new Map<string, IManualItineraryGeoCacheEntry>();

  for (const entry of entries) {
    const key = normalizeManualItineraryGeoQuery(entry.query);
    if (!key) continue;
    deduped.set(key, {
      ...entry,
      aliases: entry.aliases?.filter(Boolean),
    });
  }

  return [...deduped.values()].sort((left, right) => left.query.localeCompare(right.query));
}
