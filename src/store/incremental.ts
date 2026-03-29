import { join } from 'node:path';
import { z } from 'zod';
import { IKtepAsset, IKtepSlice } from '../protocol/schema.js';
import { readJsonOrNull, writeJson } from './writer.js';

export interface IMergeResult {
  assets: IKtepAsset[];
  added: IKtepAsset[];
  duplicateCount: number;
}

/**
 * Merge new assets into an existing asset list, deduplicating by sourcePath.
 * Existing assets are preserved unchanged; new assets get `ingestedAt` stamped.
 */
export function mergeAssets(
  existing: IKtepAsset[],
  incoming: IKtepAsset[],
): IMergeResult {
  const pathSet = new Set(existing.map(a => a.sourcePath));
  const added: IKtepAsset[] = [];
  let duplicateCount = 0;

  const now = new Date().toISOString();

  for (const asset of incoming) {
    if (pathSet.has(asset.sourcePath)) {
      duplicateCount++;
      continue;
    }
    pathSet.add(asset.sourcePath);
    added.push({ ...asset, ingestedAt: asset.ingestedAt ?? now });
  }

  return {
    assets: [...existing, ...added],
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
  const assetsPath = join(projectRoot, 'store/assets.json');
  const existing = await readJsonOrNull(assetsPath, z.array(IKtepAsset)) ?? [];
  const result = mergeAssets(existing, incoming);
  await writeJson(assetsPath, result.assets);
  return result;
}

/**
 * High-level: load existing slices, merge incoming, save.
 */
export async function appendSlices(
  projectRoot: string,
  incoming: IKtepSlice[],
): Promise<void> {
  const slicesPath = join(projectRoot, 'store/slices.json');
  const existing = await readJsonOrNull(slicesPath, z.array(IKtepSlice)) ?? [];
  const merged = mergeSlices(existing, incoming);
  await writeJson(slicesPath, merged);
}
