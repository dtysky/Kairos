import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { IKtepAsset, IMediaRoot, IMediaVersion, IAnalysisInput, IColorTransformPresetsConfig } from '../../protocol/schema.js';
import { getWorkspaceResolveLutsRoot } from '../../store/workspace-config.js';
import { extractColorSourceTruth } from '../color/source-truth.js';
import { resolveEffectiveColorProfile, resolveClipTransformSeeds, detectResolveDefaultLutRoot } from '../color/transform-presets.js';

export type MediaRole = 'raw' | 'target';

export { materialVersionKey } from '../../protocol/media-version-key.js';

export async function fingerprintMediaFile(path: string, previous?: IMediaVersion): Promise<Pick<IMediaVersion, 'sizeBytes' | 'mtimeMs' | 'ctimeMs' | 'contentHash'>> {
  const before = await stat(path);
  if (!before.isFile()) throw new Error(`素材不是文件：${path}`);
  const sameStat = previous?.sizeBytes === before.size && previous.mtimeMs === before.mtimeMs && previous.ctimeMs === before.ctimeMs;
  let contentHash = sameStat ? previous.contentHash : undefined;
  if (!contentHash) {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    contentHash = hash.digest('hex');
  }
  const after = await stat(path);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
    throw new Error(`素材在读取期间变化，请复制完成后重新 Ingest：${path}`);
  }
  return { sizeBytes: after.size, mtimeMs: after.mtimeMs, ctimeMs: after.ctimeMs, contentHash };
}

export async function registerMediaVersion(path: string, relativePath: string, role: MediaRole, root: IMediaRoot, previous?: IMediaVersion): Promise<IMediaVersion> {
  const fingerprint = await fingerprintMediaFile(path, previous);
  const truth = role === 'raw' ? await extractColorSourceTruth(path) : undefined;
  const profile = role === 'raw' ? resolveEffectiveColorProfile(truth?.logProfile, root.color?.colorSpaceProfile) : undefined;
  return { relativePath, available: true, ...fingerprint,
    ...(truth?.colorPrimaries ? { colorPrimaries: truth.colorPrimaries } : {}),
    ...(truth?.transferFunction ? { transferFunction: truth.transferFunction } : {}),
    ...(profile ? { sourceProfile: profile.effectiveProfile, profileSource: profile.profileSource } : {}) };
}

export async function buildAnalysisInput(asset: IKtepAsset, root: IMediaRoot, workspaceRoot: string, transforms: IColorTransformPresetsConfig): Promise<IAnalysisInput | undefined> {
  const versions = asset.mediaVersions;
  const role: MediaRole | undefined = versions?.target?.available ? 'target' : versions?.raw?.available ? 'raw' : undefined;
  if (!role) return undefined;
  const version = versions![role]!;
  let lutPath: string | undefined;
  let lutHash: string | undefined;
  let blocker: string | undefined;
  if (role === 'raw' && asset.kind === 'video') {
    if (!version.sourceProfile) blocker = '原片色彩模式未知，请配置 root 色彩模式或补齐 sidecar';
    else if (version.sourceProfile !== 'rec709') {
      const result = resolveClipTransformSeeds([{ rawRelativePath: version.relativePath, effectiveProfile: version.sourceProfile, profileSource: version.profileSource ?? 'unknown' }], transforms, root.color?.transformPresetKey);
      const relativeLut = result.clips[0]?.resolvedLutRelativePath;
      if (result.blockers.length) blocker = result.blockers.join('；');
      else if (!relativeLut) blocker = `原片 ${version.sourceProfile} 尚未配置分析 LUT`;
      else {
        for (const base of [getWorkspaceResolveLutsRoot(workspaceRoot), detectResolveDefaultLutRoot()]) {
          const path = resolve(join(base, relativeLut));
          if (!(await stat(path).catch(() => null))?.isFile()) continue;
          lutPath = path;
          lutHash = (await fingerprintMediaFile(path)).contentHash;
          break;
        }
        if (!lutHash) blocker = `分析 LUT 不可读：${relativeLut}`;
      }
    }
  }
  const sourceProfile = role === 'raw' ? version.sourceProfile : undefined;
  const fingerprint = createHash('sha256').update(JSON.stringify([
    'target-first-v1', role, version.contentHash, sourceProfile ?? null, lutHash ?? null, blocker ?? null,
    asset.capturedAt, asset.durationMs, asset.embeddedGps, protectionAudioDependency(asset), root.label, root.description, root.notes,
  ])).digest('hex');
  return { policyVersion: 'target-first-v1', role, relativePath: version.relativePath, contentHash: version.contentHash, sourceProfile, lutPath, lutHash, blocker, fingerprint };
}

/** Technical raw updates must not invalidate an unchanged target analysis. */
export function assetAnalysisDependency(asset: IKtepAsset): string {
  return JSON.stringify([asset.id, asset.analysisInput?.fingerprint ?? null, asset.capturedAt, asset.durationMs,
    asset.width, asset.height, asset.fps, asset.embeddedGps, protectionAudioDependency(asset)]);
}

function protectionAudioDependency(asset: IKtepAsset): unknown {
  if (!asset.protectionAudio) return null;
  const { mtimeMs: _mtime, ctimeMs: _ctime, ...binding } = asset.protectionAudio;
  return binding;
}
