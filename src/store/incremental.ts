import { join } from 'node:path';
import { z } from 'zod';
import { IKtepAsset, IKtepSlice } from '../protocol/schema.js';
import { readJsonOrNull, writeJson } from './writer.js';

export interface IMergeResult {
  assets: IKtepAsset[];
  added: IKtepAsset[];
  duplicateCount: number;
}

export function getAssetsPath(projectRoot: string): string {
  return join(projectRoot, 'store/assets.json');
}

export function getSlicesPath(projectRoot: string): string {
  return join(projectRoot, 'store/slices.json');
}

export async function loadAssets(projectRoot: string): Promise<IKtepAsset[]> {
  return await readJsonOrNull(getAssetsPath(projectRoot), z.array(IKtepAsset)) ?? [];
}

export async function loadSlices(projectRoot: string): Promise<IKtepSlice[]> {
  return await readJsonOrNull(getSlicesPath(projectRoot), z.array(IKtepSlice)) ?? [];
}

export function buildAssetMergeKey(
  asset: Pick<IKtepAsset, 'ingestRootId' | 'sourcePath'>,
): string {
  return `${asset.ingestRootId ?? ''}:${asset.sourcePath}`;
}

/**
 * Merge new assets into an existing asset list, deduplicating by sourcePath.
 * Existing assets keep their identity but refresh scanned ingest fields when
 * the same source file is seen again; new assets get `ingestedAt` stamped.
 */
export function mergeAssets(
  existing: IKtepAsset[],
  incoming: IKtepAsset[],
): IMergeResult {
  const existingByKey = new Map(existing.map(asset => [buildAssetMergeKey(asset), asset]));
  const added: IKtepAsset[] = [];
  let duplicateCount = 0;

  const now = new Date().toISOString();

  for (const asset of incoming) {
    const key = buildAssetMergeKey(asset);
    const current = existingByKey.get(key);
    if (current) {
      duplicateCount++;
      existingByKey.set(key, mergeAssetRecord(current, asset, now));
      continue;
    }
    const stamped = { ...asset, ingestedAt: asset.ingestedAt ?? now };
    existingByKey.set(key, stamped);
    added.push(stamped);
  }

  return {
    assets: [...existingByKey.values()],
    added,
    duplicateCount,
  };
}

/**
 * Find assets that have no corresponding slices (not yet analyzed).
 */
export function findUnanalyzedAssets(
  assets: IKtepAsset[],
  slices: IKtepSlice[],
): IKtepAsset[] {
  const analyzedAssetIds = new Set(slices.map(s => s.assetId));
  return assets.filter(a => !analyzedAssetIds.has(a.id));
}

/**
 * Merge new slices into existing slice list. Replaces slices for the same
 * assetId (re-analysis) or appends new ones.
 */
export function mergeSlices(
  existing: IKtepSlice[],
  incoming: IKtepSlice[],
): IKtepSlice[] {
  const incomingAssetIds = new Set(incoming.map(s => s.assetId));
  const kept = existing.filter(s => !incomingAssetIds.has(s.assetId));
  return [...kept, ...incoming];
}

/**
 * High-level: load existing assets, merge incoming, save.
 * Returns the merge result for reporting.
 */
export async function appendAssets(
  projectRoot: string,
  incoming: IKtepAsset[],
): Promise<IMergeResult> {
  const assetsPath = getAssetsPath(projectRoot);
  const existing = await loadAssets(projectRoot);
  const result = mergeAssets(existing, incoming);
  await writeJson(assetsPath, result.assets);
  return result;
}

function mergeAssetRecord(
  existing: IKtepAsset,
  incoming: IKtepAsset,
  now: string,
): IKtepAsset {
  return {
    ...existing,
    ...incoming,
    id: existing.id,
    ingestedAt: existing.ingestedAt ?? incoming.ingestedAt ?? now,
  };
}

/**
 * High-level: load existing slices, merge incoming, save.
 */
export async function appendSlices(
  projectRoot: string,
  incoming: IKtepSlice[],
): Promise<void> {
  const slicesPath = getSlicesPath(projectRoot);
  const existing = await loadSlices(projectRoot);
  const merged = mergeSlices(existing, incoming);
  await writeJson(slicesPath, merged);
}
