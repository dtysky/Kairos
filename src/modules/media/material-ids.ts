import { createHash } from 'node:crypto';
import type { IKtepAsset, IKtepSlice, IMediaRoot } from '../../protocol/schema.js';

export const CMATERIAL_ID_POLICY_VERSION = 'human-source-v1' as const;

const CMAX_ID_LENGTH = 180;
const CUUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CRESERVED_FILENAME_CHARS_RE = /[<>:"/\\|?*\u0000-\u001f]/gu;

export function isUuidLikeMaterialId(value: string | undefined): boolean {
  return typeof value === 'string' && CUUID_RE.test(value);
}

export function normalizeRootCode(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const normalized = String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, '-')
    .replace(/-+/gu, '-')
    .replace(/^[.-]+|[.-]+$/gu, '');
  return normalized || undefined;
}

export function assertValidRootCode(value: unknown, label = 'rootCode'): string {
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new Error(`${label} must be a non-empty string`);
  }
  const raw = String(value).trim();
  const normalized = normalizeRootCode(raw);
  if (!normalized) {
    throw new Error(`${label} must be a non-empty string`);
  }
  if (raw !== normalized) {
    throw new Error(`${label} "${raw}" is invalid; use lowercase letters, numbers, dot, underscore, or dash only`);
  }
  return normalized;
}

export function assertUniqueRootCodes(roots: Pick<IMediaRoot, 'id' | 'rootCode' | 'label'>[]): void {
  const seen = new Map<string, string>();
  const errors: string[] = [];
  for (const root of roots) {
    let code: string;
    try {
      code = assertValidRootCode(root.rootCode, `root ${root.id || root.label || '(unknown)'} rootCode`);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
      continue;
    }
    const existing = seen.get(code);
    if (existing) {
      errors.push(`rootCode "${code}" is duplicated by ${existing} and ${root.id || root.label || '(unknown)'}`);
      continue;
    }
    seen.set(code, root.id || root.label || code);
  }
  if (errors.length > 0) {
    throw new Error(`material human source id rootCode validation failed:\n${errors.join('\n')}`);
  }
}

export function buildEncodedSourcePath(sourcePath: string): string {
  return buildSourcePathParts(sourcePath).tokens.join('_') || 'source';
}

export function buildMaterialAssetId(input: {
  rootCode: string;
  sourcePath: string;
}): string {
  return buildMaterialAssetIdCandidates(input).base;
}

export function buildMaterialAssetIdForRoot(input: {
  root: Pick<IMediaRoot, 'id' | 'rootCode'>;
  sourcePath: string;
}): string {
  const rootCode = assertValidRootCode(input.root.rootCode, `media root ${input.root.id} rootCode`);
  return buildMaterialAssetId({ rootCode, sourcePath: input.sourcePath });
}

export function assignUniqueMaterialAssetIds<T extends {
  id?: string;
  sourcePath?: string;
  displayName?: string;
}>(
  assets: T[],
  resolveRootCode: (asset: T) => string | undefined,
): T[] {
  const used = new Set<string>();
  return assets.map((asset, index) => {
    const rootCode = resolveRootCode(asset);
    if (!rootCode) {
      throw new Error(`material asset id requires rootCode for asset ${asset.id ?? asset.sourcePath ?? index}`);
    }
    const sourcePath = asset.sourcePath || asset.displayName || asset.id || `asset-${index + 1}`;
    const candidates = buildMaterialAssetIdCandidates({ rootCode, sourcePath });
    let id = candidates.base;
    if (used.has(id) && candidates.withExtension) {
      id = candidates.withExtension;
    }
    if (used.has(id)) {
      id = appendIdSuffix(candidates.base, `_h${hashString(`${sourcePath}:${rootCode}:${asset.id ?? index}`).slice(0, 10)}`);
    }
    if (used.has(id)) {
      id = appendIdSuffix(candidates.base, `_n${index + 1}`);
    }
    used.add(id);
    return { ...asset, id };
  });
}

export function buildMaterialSpanBaseId(input: {
  assetId: string;
  assetKind?: IKtepAsset['kind'];
  type?: IKtepSlice['type'];
  semanticKind?: IKtepSlice['semanticKind'];
  sourceInMs?: number;
  sourceOutMs?: number;
}): string {
  if (input.assetKind === 'photo' || input.type === 'photo') {
    return shortenId(joinIdTokens([input.assetId, 'photo']), `${input.assetId}:photo`);
  }

  const type = sanitizeIdToken(input.type ?? 'unknown');
  const semanticKind = input.semanticKind ? sanitizeIdToken(input.semanticKind) : undefined;
  const startSec = floorSecond(input.sourceInMs);
  const endSec = ceilSecond(input.sourceOutMs);
  const range = endSec >= startSec ? `${startSec}-${endSec}` : `${startSec}-${startSec}`;
  return shortenId(
    joinIdTokens([input.assetId, type, semanticKind, `s${range}`]),
    `${input.assetId}:${type}:${semanticKind ?? ''}:${input.sourceInMs ?? ''}:${input.sourceOutMs ?? ''}`,
  );
}

export function assignUniqueMaterialSpanIds<T extends Pick<IKtepSlice, 'assetId' | 'type'> & Partial<IKtepSlice>>(
  spans: T[],
  assets?: Map<string, Pick<IKtepAsset, 'kind'>>,
): T[] {
  const used = new Set<string>();
  return spans.map((span, index) => {
    const assetKind = assets?.get(span.assetId)?.kind;
    const base = buildMaterialSpanBaseId({
      assetId: span.assetId,
      assetKind,
      type: span.type,
      semanticKind: span.semanticKind,
      sourceInMs: span.sourceInMs,
      sourceOutMs: span.sourceOutMs,
    });
    let id = base;
    if (used.has(id)) {
      id = appendIdSuffix(base, `_ms${msToken(span.sourceInMs)}-${msToken(span.sourceOutMs)}`);
    }
    if (used.has(id)) {
      id = appendIdSuffix(base, `_h${hashString(`${base}:${span.id ?? ''}:${index}`).slice(0, 10)}`);
    }
    if (used.has(id)) {
      id = appendIdSuffix(base, `_n${index + 1}`);
    }
    used.add(id);
    return { ...span, id };
  });
}

export function buildMaterialSpanId(input: Parameters<typeof buildMaterialSpanBaseId>[0]): string {
  return buildMaterialSpanBaseId(input);
}

function buildMaterialAssetIdCandidates(input: {
  rootCode: string;
  sourcePath: string;
}): { base: string; withExtension?: string } {
  const rootCode = assertValidRootCode(input.rootCode, 'material asset id rootCode');
  const parts = buildSourcePathParts(input.sourcePath);
  const base = shortenId(
    joinIdTokens([parts.stem, rootCode, ...parts.dirTokens]),
    `${rootCode}:${input.sourcePath}`,
  );
  const withExtension = parts.extensionToken
    ? shortenId(
      joinIdTokens([parts.stem, parts.extensionToken, rootCode, ...parts.dirTokens]),
      `${rootCode}:${input.sourcePath}:ext`,
    )
    : undefined;
  return { base, withExtension: withExtension && withExtension !== base ? withExtension : undefined };
}

function buildSourcePathParts(sourcePath: string): {
  stem: string;
  extensionToken?: string;
  dirTokens: string[];
  tokens: string[];
} {
  const normalized = sourcePath
    .trim()
    .replace(/\\/gu, '/')
    .replace(/^\/+/gu, '')
    .replace(/\/+/gu, '/');
  const segments = normalized.split('/').filter(Boolean);
  const fileName = segments.at(-1) ?? 'source';
  const dirTokens = segments.slice(0, -1).map(sanitizeIdSegment).filter(Boolean);
  const { stem, extensionToken } = splitFileName(fileName);
  const tokens = [stem, ...dirTokens].filter(Boolean);
  return { stem, extensionToken, dirTokens, tokens };
}

function splitFileName(fileName: string): { stem: string; extensionToken?: string } {
  const safeName = sanitizeIdSegment(fileName);
  const dotIndex = safeName.lastIndexOf('.');
  if (dotIndex <= 0 || dotIndex === safeName.length - 1) {
    return { stem: safeName || 'source' };
  }
  const stem = sanitizeIdSegment(safeName.slice(0, dotIndex)) || 'source';
  const extensionToken = sanitizeIdToken(safeName.slice(dotIndex + 1));
  return { stem, extensionToken };
}

function sanitizeIdSegment(value: string): string {
  const normalized = value
    .normalize('NFC')
    .trim()
    .replace(CRESERVED_FILENAME_CHARS_RE, '_')
    .replace(/\s+/gu, '_')
    .replace(/[^\p{L}\p{N}._-]+/gu, '_')
    .replace(/_+/gu, '_')
    .replace(/^[ ._-]+|[ ._-]+$/gu, '');
  if (!normalized || normalized === '.' || normalized === '..') return '_';
  return normalized;
}

function sanitizeIdToken(value: string): string {
  return sanitizeIdSegment(value.toLowerCase()) || 'unknown';
}

function joinIdTokens(tokens: Array<string | undefined>): string {
  return tokens
    .map(token => token?.trim())
    .filter((token): token is string => Boolean(token))
    .join('_')
    .replace(/_+/gu, '_')
    .replace(/^_+|_+$/gu, '');
}

function floorSecond(value: number | undefined): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor((value as number) / 1000));
}

function ceilSecond(value: number | undefined): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.ceil((value as number) / 1000));
}

function msToken(value: number | undefined): string {
  return Number.isFinite(value) ? String(Math.max(0, Math.round(value as number))) : '0';
}

function shortenId(id: string, salt: string): string {
  if (id.length <= CMAX_ID_LENGTH) return id;
  const hash = hashString(salt).slice(0, 12);
  const head = id.slice(0, CMAX_ID_LENGTH - hash.length - 2).replace(/[._-]+$/gu, '');
  return `${head}_h${hash}`;
}

function appendIdSuffix(id: string, suffix: string): string {
  if (id.length + suffix.length <= CMAX_ID_LENGTH) return `${id}${suffix}`;
  const head = id.slice(0, CMAX_ID_LENGTH - suffix.length).replace(/[._-]+$/gu, '');
  return `${head}${suffix}`;
}

function hashString(value: string): string {
  return createHash('sha1').update(value).digest('hex');
}
