import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { IKtepAsset, IMediaRoot, IColorTransformPresetsConfig } from '../../protocol/schema.js';
import type { IColorInput } from '../../store/color-inputs.js';
import { loadRuntimeConfig } from '../../store/project.js';
import { readJsonOrNull, writeJson } from '../../store/writer.js';
import { buildAnalysisInput, fingerprintMediaFile } from '../media/media-versions.js';
import { type ColorDecision } from './classification.js';
import { colorFingerprint, buildColorAgentPacket, acceptedColorAgentDecision, ColorAgentAssetPendingError, verifyColorAgentPacketSources } from './agent-classification.js';
export { colorFingerprint } from './agent-classification.js';
import { COLOR_MEASUREMENT_VERSION, COLOR_THRESHOLDS, IColorTechnicalReport, measureColorTechnical, summarizeTechnical } from './technical-measurement.js';

const IAssessment = z.object({ schemaVersion: z.literal(1), assetId: z.string(), inputFingerprint: z.string(),
  technicalFingerprint: z.string(), technical: IColorTechnicalReport, decision: z.record(z.unknown()),
  fingerprint: z.string(), updatedAt: z.string() });
export interface ColorAssessment {
  schemaVersion: 1; assetId: string; inputFingerprint: string; technicalFingerprint: string;
  technical: z.infer<typeof IColorTechnicalReport>; decision: ColorDecision; fingerprint: string; updatedAt: string;
}
export function colorAssessmentPath(projectRoot: string, assetId: string): string {
  return join(projectRoot, 'store/color-assessments', `${assetId}.json`);
}
export interface AssessColorOptions { mode?: 'prepare' | 'verify'; force?: boolean; onProgress?: (detail: string) => void }

/** Prepare may measure; export verification is cache-only and never invents new grading decisions. */
export async function assessColor(input: {
  workspaceRoot: string; projectRoot: string; asset: IKtepAsset; root: IMediaRoot;
  colorInput: IColorInput; sourcePath: string; transforms: IColorTransformPresetsConfig;
}, options: AssessColorOptions = {}): Promise<ColorAssessment> {
  const { workspaceRoot, projectRoot, asset, root, colorInput, sourcePath, transforms } = input;
  const version = asset.mediaVersions?.raw;
  if (!version) throw new Error(`${asset.id} 缺少待调原片版本`);
  const runtime = await loadRuntimeConfig(workspaceRoot);
  const tools = { ffmpegPath: runtime.ffmpegPath, ffprobePath: runtime.ffprobePath, ffmpegHwaccel: runtime.ffmpegHwaccel };
  const decoderIdentity = await promisify(execFile)(tools.ffmpegPath?.trim() || 'ffmpeg', ['-version'], { timeout: 10000 })
    .then(r => r.stdout.split('\n')[0]).catch(() => 'unavailable');
  // Independent diagnostic display view of raw, even when semantic Analyze used target.
  const rawInput = await buildAnalysisInput({ ...asset, mediaVersions: { raw: version } }, root, workspaceRoot, transforms);
  const source = { role: 'raw' as const, contentHash: version.contentHash, profile: version.sourceProfile,
    lutPath: rawInput?.lutPath, lutHash: rawInput?.lutHash, blocker: rawInput?.blocker };
  const technicalFingerprint = colorFingerprint([COLOR_MEASUREMENT_VERSION, COLOR_THRESHOLDS, source,
    version.colorPrimaries, version.transferFunction, root.color?.inputColorSpace, tools]);
  // v4 originally mixed aggregation policy into the pixel fingerprint. Its spatial
  // measurements are identical; accept only that exact known signature for reuse.
  const legacyV4Fingerprint = colorFingerprint([COLOR_MEASUREMENT_VERSION, { ...COLOR_THRESHOLDS,
    highContrast: { ...COLOR_THRESHOLDS.highContrast, minIntervalMs: 3000, wholeClipFraction: 0.8,
      coverageBasis: 'positive-time-union-with-sustained-run-v1' } }, source,
    version.colorPrimaries, version.transferFunction, root.color?.inputColorSpace, tools]);
  const path = colorAssessmentPath(projectRoot, asset.id);
  const measurementPath = join(projectRoot, 'store/color-measurements', `${asset.id}.json`);
  const measurement = await readJsonOrNull(measurementPath, z.object({ schemaVersion: z.literal(1), assetId: z.string(), technicalFingerprint: z.string(), technical: IColorTechnicalReport, fingerprint: z.string() }));
  const measurementIntact = measurement && measurement.fingerprint === colorFingerprint({ schemaVersion: measurement.schemaVersion, assetId: measurement.assetId, technicalFingerprint: measurement.technicalFingerprint, technical: measurement.technical });
  const old = await readJsonOrNull(path, IAssessment);
  const intact = old && old.fingerprint === colorFingerprint({ schemaVersion: old.schemaVersion, assetId: old.assetId,
    inputFingerprint: old.inputFingerprint, technicalFingerprint: old.technicalFingerprint, technical: old.technical, decision: old.decision });
  const candidate = measurementIntact ? measurement : intact ? old : null;
  const reusable = candidate && candidate.assetId === asset.id
    && [technicalFingerprint, legacyV4Fingerprint].includes(candidate.technicalFingerprint)
    && (!candidate.technical.decoder || candidate.technical.decoder === decoderIdentity);
  if (options.mode === 'verify' && (!reusable || !intact || old!.inputFingerprint !== colorInput.fingerprint
    || old!.decision.ruleVersion !== 'color-agent-v1')) {
    throw new Error(`${asset.id} 调色检测/Agent 分类缓存缺失或过期，请先重新 prepare_root`);
  }
  const reuseMeasurement = reusable && (options.mode === 'verify' || !options.force);
  const technical = structuredClone(reuseMeasurement ? candidate!.technical : await measureColorTechnical(sourcePath, source, tools,
    detail => options.onProgress?.(`${asset.id}：${detail}`)));
  if (technical.overview.length) summarizeTechnical(technical);
  const after = await fingerprintMediaFile(sourcePath, version);
  if (after.contentHash !== version.contentHash) throw new Error(`${asset.id} 检测期间原片已改变，请先 Ingest`);
  if (options.mode !== 'verify') {
    const measurementPayload = { schemaVersion: 1 as const, assetId: asset.id, technicalFingerprint, technical };
    const fingerprint = colorFingerprint(measurementPayload);
    if (!measurementIntact || measurement.fingerprint !== fingerprint) await writeJson(measurementPath, { ...measurementPayload, fingerprint });
  }
  const packet = await buildColorAgentPacket({ projectRoot, asset, root, colorInput, sourcePath, technical, technicalFingerprint });
  await verifyColorAgentPacketSources(projectRoot, packet);
  const decision = await acceptedColorAgentDecision(projectRoot, packet);
  if (!decision) {
    if (options.mode === 'verify') throw new Error(`${asset.id} Agent 分类缺失或过期，请先重新 prepare_root`);
    throw new ColorAgentAssetPendingError(packet);
  }
  const payload = { schemaVersion: 1 as const, assetId: asset.id, inputFingerprint: colorInput.fingerprint,
    technicalFingerprint, technical, decision };
  const fingerprint = colorFingerprint(payload);
  if (options.mode === 'verify' && fingerprint !== old!.fingerprint) throw new Error(`${asset.id} Agent 分类缓存已改变，请先重新 prepare_root`);
  if (intact && fingerprint === old!.fingerprint) return { ...payload, fingerprint, updatedAt: old!.updatedAt };
  const result = { ...payload, fingerprint, updatedAt: new Date().toISOString() };
  await writeJson(path, result);
  return result;
}
