import { resolve } from 'node:path';
import { loadIngestRoots, loadColorTransformPresetsConfig } from '../../store/index.js';
import { verifyAnalysisInput } from '../media/analysis-input.js';
import { createHash } from 'node:crypto';
import type { IColorClassification } from '../../protocol/schema.js';
import { loadAssets } from '../../store/incremental.js';
import { refreshColorInputs, isColorInputAssetCurrent } from '../../store/color-inputs.js';
import { fingerprintMediaFile } from '../media/media-versions.js';
import { CRCM_POLICY, resolveRcmInput } from './rcm-input.js';
import { extractColorSourceTruth } from './source-truth.js';
import { COLOR_CATEGORY_LABELS } from './classification.js';
import { assessColor, type AssessColorOptions } from './assessment.js';

export interface IAnalyzedColorSource {
  rawRelativePath: string;
  sourceAbsolutePath: string;
  assetId?: string;
  sourceContentHash?: string;
  analysisInputFingerprint?: string;
  sceneCategory?: IColorClassification['category'];
  sceneGroupName?: string;
  classificationFingerprint?: string;
  reviewFlags?: string[];
  classificationStatus?: 'classified' | 'needs-review';
  classificationReasons?: string[];
  colorManagementPolicy?: typeof CRCM_POLICY;
  inputColorSpace?: string;
  inputColorSource?: string;
}

/** Resolve prep consumes current semantic Analyze truth, never legacy VLM technical judgments. */
export async function bindColorAnalysis(projectRoot: string, rootId: string, inventory: IAnalyzedColorSource[], options: AssessColorOptions = {}): Promise<IAnalyzedColorSource[]> {
  const workspaceRoot = resolve(projectRoot, '../..');
  const transforms = await loadColorTransformPresetsConfig(workspaceRoot);
  const [assets, { roots }] = await Promise.all([loadAssets(projectRoot), loadIngestRoots(projectRoot)]);
  const assetsByRawPath = new Map(assets.filter(asset => asset.ingestRootId === rootId && asset.mediaVersions?.raw)
    .map(asset => [asset.mediaVersions!.raw!.relativePath, asset]));
  const colorInputs = await refreshColorInputs(projectRoot, { assetIds: inventory.flatMap(item => {
    const asset = assetsByRawPath.get(item.rawRelativePath);
    return asset ? [asset.id] : [];
  }) });
  const blockers: string[] = [];
  const bound: IAnalyzedColorSource[] = [];
  const pending: Array<{
    item: IAnalyzedColorSource; asset: (typeof assets)[number]; root: (typeof roots)[number];
    colorInput: (typeof colorInputs.assets)[string]; input: ReturnType<typeof resolveRcmInput>; sourceContentHash: string;
  }> = [];
  for (const item of inventory) {
    const asset = assetsByRawPath.get(item.rawRelativePath);
    const version = asset?.mediaVersions?.raw;
    if (!asset || !version) { blockers.push(`${item.rawRelativePath} 尚未登记 raw/target，请先 Ingest`); continue; }
    const actual = await fingerprintMediaFile(item.sourceAbsolutePath, version);
    if (actual.contentHash !== version.contentHash) { blockers.push(`${asset.id} 原片内容已改变，请先 Ingest`); continue; }
    const currentSource = await extractColorSourceTruth(item.sourceAbsolutePath);
    const root = roots.find(root => root.id === rootId)!;
    if (currentSource.colorPrimaries !== version.colorPrimaries || currentSource.transferFunction !== version.transferFunction
      || (currentSource.logProfile && currentSource.logProfile !== version.sourceProfile)
      || (version.profileSource === 'root-fallback' && root.color?.colorSpaceProfile !== version.sourceProfile)) {
      blockers.push(`${asset.id} 原片色彩元数据已改变，请先 Ingest`); continue;
    }
    const colorInput = colorInputs.assets[asset.id];
    if (!colorInput || colorInput.analysisStatus !== 'current' || !colorInput.facts || !colorInput.analysisInput
      || !isColorInputAssetCurrent(colorInput, asset, root)) {
      blockers.push(`${asset.id} 缺少当前版本的 Analyze 语义报告或调色输入已过期，请先 Analyze（${colorInput?.reasons.join('；') || '来源签名不匹配'}）`); continue;
    }
    await verifyAnalysisInput(workspaceRoot, asset, roots, transforms);
    let input;
    try { input = resolveRcmInput(version, root); }
    catch (error) { blockers.push(`${asset.id}：${error instanceof Error ? error.message : String(error)}`); continue; }
    pending.push({ item, asset, root, colorInput, input, sourceContentHash: actual.contentHash });
  }
  // Validate the entire requested scope before spending time decoding any eligible clip.
  if (blockers.length) throw new Error(`调色前置分析未就绪（${blockers.length} 条）：${blockers.slice(0, 20).join('；')}`);
  for (const { item, asset, root, colorInput, input, sourceContentHash } of pending) {
    const assessment = await assessColor({ workspaceRoot, projectRoot, asset, root, colorInput, sourcePath: item.sourceAbsolutePath, transforms }, options);
    const classification = assessment.decision;
    bound.push({ ...item, ...input, colorManagementPolicy: CRCM_POLICY, assetId: asset.id, sourceContentHash,
      analysisInputFingerprint: colorInput.analysisInput!.fingerprint, sceneCategory: classification.category ?? undefined,
      sceneGroupName: classification.category ? COLOR_CATEGORY_LABELS[classification.category] : undefined,
      classificationStatus: classification.status, classificationReasons: classification.reasons, reviewFlags: classification.reviewFlags,
      classificationFingerprint: createHash('sha256').update(JSON.stringify([CRCM_POLICY, sourceContentHash, input, assessment.fingerprint])).digest('hex'),
    });
  }
  return bound;
}
