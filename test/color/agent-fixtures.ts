import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRuntimeConfig, saveIngestRoots } from '../../src/store/project.js';
import { writeJson } from '../../src/store/writer.js';
import { writeAssetReport } from '../../src/store/analysis.js';
import { refreshColorInputs } from '../../src/store/color-inputs.js';
import { buildAnalysisInput, fingerprintMediaFile } from '../../src/modules/media/media-versions.js';
import { COLOR_MEASUREMENT_VERSION, COLOR_THRESHOLDS, emptyTechnical } from '../../src/modules/color/technical-measurement.js';
import { buildColorAgentPacket, colorFingerprint, stageColorAgentBatch, COLOR_AGENT_POLICY_FINGERPRINT,
  type ColorAgentPacket, type ColorAgentResult } from '../../src/modules/color/agent-classification.js';
import type { IKtepAsset, IAssetCoarseReport } from '../../src/protocol/schema.js';
export async function fixture(count = 1) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'kairos-agent-color-'));
  const projectRoot = join(workspaceRoot, 'projects/demo');
  await mkdir(join(projectRoot, 'store'), { recursive: true });
  let root: import('../../src/protocol/schema.js').IMediaRoot = { id: 'camera', rootCode: 'camera', enabled: true, path: workspaceRoot, rawPath: workspaceRoot };
  root = (await saveIngestRoots(projectRoot, { roots: [root] })).roots[0];
  const transforms = { profiles: {}, discoveredPresets: {} };
  const runtime = await loadRuntimeConfig(workspaceRoot);
  const tools = { ffmpegPath: runtime.ffmpegPath, ffprobePath: runtime.ffprobePath, ffmpegHwaccel: runtime.ffmpegHwaccel };
  const assets: IKtepAsset[] = [], reports: IAssetCoarseReport[] = [];
  for (let i = 0; i < count; i++) {
    const name = `C00${i}.mp4`, sourcePath = join(workspaceRoot, name);
    await writeFile(sourcePath, `raw-${i}`);
    const raw = { ...await fingerprintMediaFile(sourcePath), relativePath: name, available: true, sourceProfile: 'rec709' as const };
    const asset: IKtepAsset = { id: `C00${i}_camera`, sourcePath: name, displayName: name, ingestRootId: root.id,
      kind: 'video', durationMs: 10000, width: 3840, height: 2160, mediaVersions: { raw } };
    asset.analysisInput = await buildAnalysisInput(asset, root, workspaceRoot, transforms);
    assets.push(asset);
    reports.push({ assetId: asset.id, analysisInput: asset.analysisInput, summary: '普通照明室内，人物讲解桌上物品。', clipTypeGuess: 'broll',
      transcript: '今天讲解物品。', transcriptSegments: [{ startMs: 100, endMs: 1200, text: '今天讲解物品。' }],
      keepDecision: 'keep', densityScore: 0.5, labels: [], placeHints: [], rootNotes: [], sampleFrames: [], interestingWindows: [],
      fineScanWindows: [], fineScanReasons: [], pharosMatches: [], createdAt: 'now', updatedAt: 'now' });
  }
  await writeFile(join(projectRoot, 'store/assets.json'), JSON.stringify(assets));
  for (const report of reports) await writeAssetReport(projectRoot, report);
  const store = await refreshColorInputs(projectRoot);
  const requests = assets.map(asset => ({ workspaceRoot, projectRoot, asset, root, sourcePath: join(workspaceRoot, asset.sourcePath),
    transforms, colorInput: store.assets[asset.id]! }));
  const packets: ColorAgentPacket[] = [];
  for (const request of requests) {
    const source = { role: 'raw' as const, contentHash: request.asset.mediaVersions!.raw!.contentHash, profile: 'rec709' };
    const technical = emptyTechnical(source, 10000);
    technical.probe = { width: 3840, height: 2160, displayWidth: 3840, displayHeight: 2160, rotationDegrees: 0, fps: 30, durationMs: 10000 };
    const technicalFingerprint = colorFingerprint([COLOR_MEASUREMENT_VERSION, COLOR_THRESHOLDS, source, undefined, undefined, undefined, tools]);
    const measurement = { schemaVersion: 1, assetId: request.asset.id, technicalFingerprint, technical };
    await writeJson(join(projectRoot, 'store/color-measurements', `${request.asset.id}.json`), { ...measurement, fingerprint: colorFingerprint(measurement) });
    packets.push(await buildColorAgentPacket({ ...request, technical, technicalFingerprint }));
  }
  return { workspaceRoot, projectRoot, assets, reports, root, packets, requests };
}
export function result(packet: ColorAgentPacket, overrides: Partial<ColorAgentResult> = {}): ColorAgentResult {
  return { assetId: packet.assetId, packetFingerprint: packet.packetFingerprint, status: 'classified', category: 'day',
    reason: '根据完整画面描述判为正常照明室内。', semantic: { presenter: 'no', viewpoint: '室内物品视角', lighting: 'day', nightContext: 'non-night', dominantScene: '正常照明室内' },
    evidence: [{ source: 'report.summary', quoteOrValue: packet.report.summary, supports: '完整场景证据' }],
    supplementalIssues: [], uncertainties: ['噪声未知，仅记录检测局限'], technicalOverrides: [], ...overrides };
}
export function resign(packet: ColorAgentPacket): ColorAgentPacket {
  const { packetFingerprint: _hash, ...payload } = packet;
  return { ...payload, packetFingerprint: colorFingerprint(payload) };
}
export async function submission(projectRoot: string, rootId: string, packets: ColorAgentPacket[]) {
  const pending = await stageColorAgentBatch(projectRoot, rootId, packets);
  return { schemaVersion: 1 as const, batchFingerprint: pending.state.batchFingerprint, policyVersion: 'color-agent-v1' as const,
    policyFingerprint: COLOR_AGENT_POLICY_FINGERPRINT, model: 'gpt-6.1-sol' as const, reasoningEffort: 'high' as const, results: packets.map(p => result(p)) };
}
