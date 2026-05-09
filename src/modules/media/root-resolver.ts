import { accessSync, constants, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type {
  IKtepAsset,
  IMediaRoot,
} from '../../protocol/schema.js';

export type TMediaRootPathKind = 'path' | 'rawPath';

export interface IMediaRootPathCandidate {
  path: string;
  source: 'primary' | 'alternate';
  alternateIndex?: number;
}

export interface IMediaRootPathCandidateCheck extends IMediaRootPathCandidate {
  readable: boolean;
  reason?: string;
}

export interface IMediaRootPathResolution {
  selectedPath?: string;
  candidates: IMediaRootPathCandidateCheck[];
  blocker?: string;
}

export interface IResolvedMediaRoot {
  root: IMediaRoot;
  localPath: string;
  rawLocalPath?: string;
  flightRecordPath?: string;
  localPathResolution: IMediaRootPathResolution;
  rawPathResolution: IMediaRootPathResolution;
}

export interface IMediaRootResolution {
  resolved: IResolvedMediaRoot[];
  missing: IMediaRoot[];
}

export function resolveMediaRoots(roots: IMediaRoot[]): IMediaRootResolution {
  const resolved: IResolvedMediaRoot[] = [];
  const missing: IMediaRoot[] = [];

  for (const root of roots) {
    if (!root.enabled) continue;
    const resolution = resolveMediaRoot(root);
    if (resolution.localPath) {
      resolved.push(resolution as IResolvedMediaRoot);
    } else {
      missing.push(root);
    }
  }

  return { resolved, missing };
}

export function resolveMediaRoot(root: IMediaRoot): IResolvedMediaRoot | (Omit<IResolvedMediaRoot, 'localPath'> & { localPath?: string }) {
  const localPathResolution = resolveRootPath(root, 'path');
  const rawPathResolution = resolveRootPath(root, 'rawPath');
  const localPath = localPathResolution.selectedPath;
  const rawLocalPath = rawPathResolution.selectedPath;
  const flightRecordPath = resolveFlightRecordPath(root.flightRecordPath, localPath);

  return {
    root,
    ...(localPath ? { localPath } : {}),
    ...(rawLocalPath ? { rawLocalPath } : {}),
    ...(flightRecordPath ? { flightRecordPath } : {}),
    localPathResolution,
    rawPathResolution,
  };
}

export function resolveRootPath(
  root: IMediaRoot,
  kind: TMediaRootPathKind,
): IMediaRootPathResolution {
  const candidates = buildRootPathCandidates(root, kind).map(candidate => inspectPathCandidate(candidate));
  const selected = candidates.find(candidate => candidate.readable);

  return {
    ...(selected ? { selectedPath: selected.path } : {}),
    candidates,
    ...(!selected ? { blocker: describePathBlocker(kind, candidates) } : {}),
  };
}

export function buildRootPathCandidates(
  root: IMediaRoot,
  kind: TMediaRootPathKind,
): IMediaRootPathCandidate[] {
  const primary = trimPath(kind === 'path' ? root.path : root.rawPath);
  const candidates: IMediaRootPathCandidate[] = primary
    ? [{ path: primary, source: 'primary' }]
    : [];
  for (const [index, alternate] of (root.alternatePaths ?? []).entries()) {
    const alternatePath = trimPath(kind === 'path' ? alternate.path : alternate.rawPath);
    if (!alternatePath) continue;
    candidates.push({
      path: alternatePath,
      source: 'alternate',
      alternateIndex: index + 1,
    });
  }
  return candidates;
}

export function toPortableRelativePath(
  rootPath: string,
  filePath: string,
): string {
  return relative(rootPath, filePath).replace(/\\/g, '/');
}

export function resolveAssetLocalPath(
  asset: Pick<IKtepAsset, 'ingestRootId' | 'sourcePath'>,
  roots: IMediaRoot[],
): string | null {
  if (isAbsolute(asset.sourcePath)) {
    return asset.sourcePath;
  }

  if (!asset.ingestRootId) return null;

  const root = roots.find(item => item.id === asset.ingestRootId && item.enabled);
  if (!root) return null;

  const resolvedRoot = resolveMediaRoot(root);
  if (!resolvedRoot.localPath) return null;

  const segments = asset.sourcePath.split(/[\\/]+/).filter(Boolean);
  return join(resolvedRoot.localPath, ...segments);
}

function inspectPathCandidate(candidate: IMediaRootPathCandidate): IMediaRootPathCandidateCheck {
  try {
    const stat = statSync(candidate.path);
    if (!stat.isDirectory()) {
      return {
        ...candidate,
        readable: false,
        reason: '不是目录',
      };
    }
    accessSync(candidate.path, constants.R_OK);
    return {
      ...candidate,
      readable: true,
    };
  } catch (error) {
    return {
      ...candidate,
      readable: false,
      reason: error instanceof Error ? error.message : '不可读',
    };
  }
}

function describePathBlocker(
  kind: TMediaRootPathKind,
  candidates: IMediaRootPathCandidateCheck[],
): string {
  const label = kind === 'path' ? '素材路径' : '原始素材路径';
  if (candidates.length === 0) {
    return `未配置${label}候选。`;
  }
  return `${label}候选均不可读。`;
}

function resolveFlightRecordPath(path: string | undefined, localPath: string | undefined): string | undefined {
  const trimmed = trimPath(path);
  if (!trimmed) return undefined;
  if (isAbsolute(trimmed) || !localPath) return trimmed;
  return resolve(localPath, trimmed);
}

function trimPath(path: string | undefined): string | undefined {
  const trimmed = path?.trim();
  return trimmed || undefined;
}
