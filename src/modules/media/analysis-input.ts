import { resolveProtectionAudioLocalPath } from './protection-audio.js';
import { mkdir, readFile, rename } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { IKtepAsset, IMediaRoot, IColorTransformPresetsConfig } from '../../protocol/schema.js';
import { writeJson } from '../../store/writer.js';
import { loadColorTransformPresetsConfig } from '../../store/workspace-config.js';
import { buildAnalysisInput, fingerprintMediaFile } from './media-versions.js';
import { buildRootPathCandidates, resolveAssetLocalPath } from './root-resolver.js';

/** Validate once before any resume path can read a checkpoint. Archive only this asset's derived caches. */
export async function prepareAnalysisInputs(workspaceRoot: string, projectRoot: string, assets: IKtepAsset[], roots: IMediaRoot[]): Promise<void> {
  const transforms = await loadColorTransformPresetsConfig(workspaceRoot);
  for (const asset of assets) {
    if (!asset.mediaVersions) continue;
    await verifyAnalysisInput(workspaceRoot, asset, roots, transforms);
    const input = asset.analysisInput!;
    const manifestPath = join(projectRoot, 'analysis', 'input-manifests', `${asset.id}.json`);
    const previous = await readFile(manifestPath, 'utf8').then(text => JSON.parse(text)).catch(() => null);
    if (previous?.fingerprint === input.fingerprint) continue;
    const archiveRoot = join(projectRoot, '.tmp', 'analysis-invalidated', asset.id, `${Date.now()}-${input.fingerprint.slice(0, 12)}`);
    const paths = [
      ['analysis', 'prepared-assets', `${asset.id}.json`],
      ['analysis', 'audio-checkpoints', `${asset.id}.json`],
      ['analysis', 'fine-scan-checkpoints', `${asset.id}.json`],
      ['analysis', 'asset-reports', `${asset.id}.json`],
      ['.tmp', 'media-analyze', asset.id],
    ];
    for (const parts of paths) {
      const source = join(projectRoot, ...parts);
      const destination = join(archiveRoot, ...parts);
      await mkdir(dirname(destination), { recursive: true });
      await rename(source, destination).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
    await writeJson(manifestPath, input);
  }
}

export async function verifyAnalysisInput(workspaceRoot: string, asset: IKtepAsset, roots: IMediaRoot[], transforms?: IColorTransformPresetsConfig): Promise<void> {
  if (!asset.mediaVersions) throw new Error(`素材 ${asset.id} 未登记版本，请先 Ingest`);
  const root = roots.find(root => root.id === asset.ingestRootId);
  const input = asset.analysisInput;
  if (!root || !input) throw new Error(`素材 ${asset.id} 没有可用版本，请先 Ingest`);
  if (input.blocker) throw new Error(`素材 ${asset.id}：${input.blocker}`);
  const localPath = resolveAssetLocalPath(asset, roots);
  if (!localPath || !buildRootPathCandidates(root, input.role === 'target' ? 'path' : 'rawPath')
    .some(candidate => resolve(candidate.path, input.relativePath) === resolve(localPath))) {
    throw new Error(`素材 ${asset.id} 的可用版本已改变，请先 Ingest`);
  }
  const actual = await fingerprintMediaFile(localPath, asset.mediaVersions[input.role]);
  if (actual.contentHash !== input.contentHash) throw new Error(`素材 ${asset.id} 内容已更新，请先 Ingest`);
  const currentInput = await buildAnalysisInput(asset, root, workspaceRoot, transforms ?? await loadColorTransformPresetsConfig(workspaceRoot));
  if (currentInput?.fingerprint !== input.fingerprint) throw new Error(`素材 ${asset.id} 的分析 LUT/配置已改变，请先 Ingest`);
  if (asset.protectionAudio?.contentHash) {
    const protectionPath = resolveProtectionAudioLocalPath(asset, roots);
    if (!protectionPath || (await fingerprintMediaFile(protectionPath)).contentHash !== asset.protectionAudio.contentHash) {
      throw new Error(`素材 ${asset.id} 保护音轨已改变，请先 Ingest`);
    }
  }
}
