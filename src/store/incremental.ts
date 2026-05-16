import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { IKtepAsset, IKtepSlice, IKtepSpan, ISpansMeta } from '../protocol/schema.js';
import { readJsonOrNull, writeJson } from './writer.js';

export interface IMergeResult {
  assets: IKtepAsset[];
  added: IKtepAsset[];
  pruned: IKtepAsset[];
  duplicateCount: number;
}

export interface IAssetMergeOptions {
  replaceRootIds?: string[];
}

export function getAssetsPath(projectRoot: string): string {
  return join(projectRoot, 'store/assets.json');
}

export function getSlicesPath(projectRoot: string): string {
  return getSpansPath(projectRoot);
}

export function getSpansPath(projectRoot: string): string {
  return join(projectRoot, 'store/spans.json');
}

export function getSpansMetaPath(projectRoot: string): string {
  return join(projectRoot, 'store/spans.meta.json');
}

export async function loadAssets(projectRoot: string): Promise<IKtepAsset[]> {
  return (await readJsonOrNull(getAssetsPath(projectRoot), z.array(IKtepAsset)) as IKtepAsset[] | null) ?? [];
}

export async function loadSlices(projectRoot: string): Promise<IKtepSlice[]> {
  return loadSpans(projectRoot);
}

export async function loadSpans(projectRoot: string): Promise<IKtepSpan[]> {
  const path = getSpansPath(projectRoot);
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (error) {
    if (getErrorCode(error) === 'ENOENT') return [];
    throw error;
  }
  try {
    const parsed = JSON.parse(raw);
    try {
      return z.array(IKtepSpan).parse(parsed);
    } catch {
      return z.array(IKtepSpan).parse(normalizeLegacySpansForRead(parsed));
    }
  } catch (error) {
    throw new Error(`store/spans.json uses an unsupported span protocol; rerun /chronology span-rebuild to regenerate it. ${formatParseError(error)}`);
  }
}

export async function loadSpansMeta(projectRoot: string): Promise<ISpansMeta | null> {
  return (await readJsonOrNull(getSpansMetaPath(projectRoot), ISpansMeta) as ISpansMeta | null) ?? null;
}

export async function writeSpansMeta(projectRoot: string, meta: ISpansMeta): Promise<void> {
  await writeJson(getSpansMetaPath(projectRoot), ISpansMeta.parse(meta));
}

export async function markSpansStale(projectRoot: string, reason?: string): Promise<ISpansMeta | null> {
  const existing = await loadSpansMeta(projectRoot);
  if (!existing) return null;
  const warning = reason?.trim();
  const warnings = warning
    ? [...existing.warnings, warning]
    : existing.warnings;
  const updated: ISpansMeta = {
    ...existing,
    status: 'stale',
    warnings: [...new Set(warnings)].slice(-50),
  };
  await writeSpansMeta(projectRoot, updated);
  return updated;
}

export async function assertFreshSpans(projectRoot: string): Promise<{ spans: IKtepSpan[]; meta: ISpansMeta }> {
  const [spans, meta] = await Promise.all([
    loadSpans(projectRoot),
    loadSpansMeta(projectRoot),
  ]);
  if (spans.length === 0) {
    throw new Error('Script/Timeline requires fresh spans: store/spans.json is missing or empty. Run /chronology span-rebuild first.');
  }
  if (!meta) {
    throw new Error('Script/Timeline requires fresh spans: store/spans.meta.json is missing. Run /chronology span-rebuild first.');
  }
  if (meta.status !== 'fresh') {
    throw new Error(`Script/Timeline requires fresh spans: store/spans.meta.json status is ${meta.status}. Run /chronology span-rebuild first.`);
  }
  if (meta.spanCount !== spans.length) {
    throw new Error(`Script/Timeline requires fresh spans: meta spanCount ${meta.spanCount} does not match store/spans.json count ${spans.length}. Run /chronology span-rebuild first.`);
  }
  return { spans, meta };
}

function formatParseError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }
  return 'unknown parse error';
}

function getErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const code = Reflect.get(error, 'code');
  return typeof code === 'string' ? code : undefined;
}

function normalizeLegacySpansForRead(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.map(normalizeLegacySpanForRead);
}

function normalizeLegacySpanForRead(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const raw = value as Record<string, unknown>;
  const span: Record<string, unknown> = {};
  for (const key of [
    'id',
    'assetId',
    'type',
    'semanticKind',
    'sourceInMs',
    'sourceOutMs',
    'editSourceInMs',
    'editSourceOutMs',
    'transcript',
    'transcriptSegments',
    'visualObservation',
    'grounding',
    'pharosRefs',
    'speechCoverage',
    'speedCandidate',
  ]) {
    if (raw[key] !== undefined) span[key] = raw[key];
  }
  span.materialPatterns = normalizeLegacyMaterialPatterns(raw.materialPatterns);
  return span;
}

function normalizeLegacyMaterialPatterns(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const patterns: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const phrase = typeof item === 'string'
      ? item
      : item && typeof item === 'object'
        ? Reflect.get(item, 'phrase')
        : undefined;
    const trimmed = typeof phrase === 'string' ? phrase.trim() : '';
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    patterns.push(trimmed);
  }
  return patterns;
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
  options: IAssetMergeOptions = {},
): IMergeResult {
  const existingByKey = new Map(existing.map(asset => [buildAssetMergeKey(asset), asset]));
  const incomingKeys = new Set<string>();
  const added: IKtepAsset[] = [];
  let duplicateCount = 0;

  const now = new Date().toISOString();

  for (const asset of incoming) {
    const key = buildAssetMergeKey(asset);
    incomingKeys.add(key);
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

  const replaceRootIds = new Set((options.replaceRootIds ?? []).filter(Boolean));
  const pruned: IKtepAsset[] = [];
  const assets = [...existingByKey.values()].filter(asset => {
    if (
      asset.ingestRootId
      && replaceRootIds.has(asset.ingestRootId)
      && !incomingKeys.has(buildAssetMergeKey(asset))
    ) {
      pruned.push(asset);
      return false;
    }
    return true;
  });

  return {
    assets,
    added,
    pruned,
    duplicateCount,
  };
}

/**
 * Find assets that have no corresponding slices (not yet analyzed).
 */
export function findUnanalyzedAssets(
  assets: IKtepAsset[],
  slices: IKtepSpan[],
): IKtepAsset[] {
  const analyzedAssetIds = new Set(slices.map(s => s.assetId));
  return assets.filter(a => !analyzedAssetIds.has(a.id));
}

/**
 * Merge new slices into existing slice list. Replaces slices for the same
 * assetId (re-analysis) or appends new ones.
 */
export function mergeSlices(
  existing: IKtepSpan[],
  incoming: IKtepSpan[],
): IKtepSpan[] {
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
  options: IAssetMergeOptions = {},
): Promise<IMergeResult> {
  const assetsPath = getAssetsPath(projectRoot);
  const existing = await loadAssets(projectRoot);
  const result = mergeAssets(existing, incoming, options);
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

export const mergeSpans = mergeSlices;
