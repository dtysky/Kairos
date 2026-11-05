import { resolve } from 'node:path';
import { loadIngestRoots, loadColorTransformPresetsConfig } from '../../store/index.js';
import { verifyAnalysisInput } from '../media/analysis-input.js';
import { createHash } from 'node:crypto';
import type { IColorClassification } from '../../protocol/schema.js';
import { loadAssets } from '../../store/incremental.js';
import { loadAssetReports } from '../../store/analysis.js';
import { fingerprintMediaFile } from '../media/media-versions.js';
import { CRCM_POLICY, resolveRcmInput } from './rcm-input.js';
import { extractColorSourceTruth } from './source-truth.js';
import { COLOR_CATEGORY_LABELS, classifyAnalyzedColor } from './classification.js';

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
  colorManagementPolicy?: typeof CRCM_POLICY;
  inputColorSpace?: string;
  inputColorSource?: string;
}

/** Resolve prep consumes current Analyze truth; it must never invent an independent visual classification. */
export async function bindColorAnalysis(projectRoot: string, rootId: string, inventory: IAnalyzedColorSource[]): Promise<IAnalyzedColorSource[]> {
  const workspaceRoot = resolve(projectRoot, '../..');
  const transforms = await loadColorTransformPresetsConfig(workspaceRoot);
  const [assets, reports, { roots }] = await Promise.all([loadAssets(projectRoot), loadAssetReports(projectRoot), loadIngestRoots(projectRoot)]);
  const assetsByRawPath = new Map(assets.filter(asset => asset.ingestRootId === rootId && asset.mediaVersions?.raw)
    .map(asset => [asset.mediaVersions!.raw!.relativePath, asset]));
  const reportsById = new Map(reports.map(report => [report.assetId, report]));
  const blockers: string[] = [];
  const bound: IAnalyzedColorSource[] = [];
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
    const report = reportsById.get(asset.id);
    if (!report?.analysisInput || !asset.analysisInput || !report.colorEvidence) {
      blockers.push(`${asset.id} 缺少当前版本的 Analyze 调色证据，请先 Analyze`); continue;
    }
    await verifyAnalysisInput(workspaceRoot, asset, roots, transforms);
    let input;
    try { input = resolveRcmInput(version, root); }
    catch (error) { blockers.push(`${asset.id}：${error instanceof Error ? error.message : String(error)}`); continue; }
    const classification = classifyAnalyzedColor(asset, report.clipTypeGuess, report.colorEvidence);
    bound.push({ ...item, ...input, colorManagementPolicy: CRCM_POLICY, assetId: asset.id, sourceContentHash: actual.contentHash,
      analysisInputFingerprint: report.analysisInput.fingerprint, sceneCategory: classification.category,
      sceneGroupName: COLOR_CATEGORY_LABELS[classification.category], reviewFlags: classification.reviewFlags,
      classificationFingerprint: createHash('sha256').update(JSON.stringify([CRCM_POLICY, actual.contentHash, input, report.analysisInput.fingerprint, classification])).digest('hex'),
    });
  }
  if (blockers.length) throw new Error(`调色前置分析未就绪（${blockers.length} 条）：${blockers.slice(0, 20).join('；')}`);
  return bound;
}
