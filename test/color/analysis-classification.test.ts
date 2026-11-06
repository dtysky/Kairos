import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { IKtepAsset, IColorAnalysisEvidence, IAssetCoarseReport } from '../../src/protocol/schema.js';
import { bindColorAnalysis } from '../../src/modules/color/analysis-classification.js';
import { loadIngestRoots, saveIngestRoots, saveColorTransformPresetsConfig } from '../../src/store/index.js';
import { buildAnalysisInput, fingerprintMediaFile } from '../../src/modules/media/media-versions.js';
import { writeAssetReport } from '../../src/store/analysis.js';
import { getColorInputsPath, loadColorInputs } from '../../src/store/color-inputs.js';
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const asset: IKtepAsset = { id: 'C001_camera', sourcePath: 'C001.mp4', displayName: 'C001', kind: 'video', width: 3840, height: 2160 };
const evidence: IColorAnalysisEvidence = { timeOfDay: 'day', visiblePresenter: false, windshieldCast: false, highContrast: false, veryDarkNoisy: false, overexposed: false, lightChange: false, flicker: 'unknown', observation: '白天道路' };

describe('Analyze color classification', () => {
  it('blocks missing/stale reports and changed raw bytes before handing clips to Resolve', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'kairos-color-evidence-')); dirs.push(workspace);
    const project = join(workspace, 'projects/test'); await mkdir(project, { recursive: true });
    await mkdir(join(project, 'store')); await mkdir(join(project, 'raw')); await mkdir(join(project, 'target')); const source = join(project, 'raw/C001.MP4'); await writeFile(source, 'raw');
    const fingerprint = await fingerprintMediaFile(source);
    await writeFile(join(project, 'target/C001.mp4'), 'target');
    const targetFingerprint = await fingerprintMediaFile(join(project, 'target/C001.mp4'));
    const root = { id: 'camera', rootCode: 'camera', path: join(project, 'target'), rawPath: join(project, 'raw'), enabled: true };
    await saveIngestRoots(project, { roots: [root] });
    const a: IKtepAsset = { ...asset, ingestRootId: 'camera', mediaVersions: { raw: { ...fingerprint, relativePath: 'C001.MP4', available: true, sourceProfile: 'rec709' }, target: { ...targetFingerprint, relativePath: 'C001.mp4', available: true } } };
    const input = (await buildAnalysisInput(a, (await loadIngestRoots(project)).roots[0]!, project, { profiles: {}, discoveredPresets: {} }))!;
    a.analysisInput = input;
    await writeFile(join(project, 'store/assets.json'), JSON.stringify([a]));
    const inventory = [{ rawRelativePath: 'C001.MP4', sourceAbsolutePath: source }];
    await expect(bindColorAnalysis(project, 'camera', inventory)).rejects.toThrow('先 Analyze');
    const report: IAssetCoarseReport = { assetId: a.id, analysisInput: input, clipTypeGuess: 'drive', keepDecision: 'keep', densityScore: 0.5, labels: [], placeHints: [], rootNotes: [], sampleFrames: [], interestingWindows: [], fineScanWindows: [], fineScanReasons: [], pharosMatches: [], createdAt: '2026-11-05', updatedAt: '2026-11-05' };
    await writeAssetReport(project, report);
    const current = (await bindColorAnalysis(project, 'camera', inventory))[0]!;
    expect(current).toMatchObject({ assetId: a.id, classificationStatus: 'needs-review', sourceContentHash: fingerprint.contentHash });
    const stored = (await loadColorInputs(project))!;
    expect(stored.assets[a.id]).toMatchObject({ analysisStatus: 'current', facts: { type: 'drive' } });
    stored.assets[a.id].facts!.type = 'talking-head';
    await writeFile(getColorInputsPath(project), JSON.stringify(stored));
    expect((await bindColorAnalysis(project, 'camera', inventory))[0]).toEqual(current);
    await rm(getColorInputsPath(project));
    expect((await bindColorAnalysis(project, 'camera', inventory))[0]).toEqual(current);
    const legacyClassification = { ruleVersion: 'scene-v1' as const, category: 'high-contrast' as const, reasons: ['主体与背景大光比'], reviewFlags: [] };
    await writeAssetReport(project, { ...report, summary: '明显过曝，高噪点，前挡偏色',
      colorEvidence: { ...evidence, highContrast: true, overexposed: true, veryDarkNoisy: true, windshieldCast: true, lightChange: true, flicker: 'suspected' },
      colorClassification: legacyClassification });
    const changedFacts = (await bindColorAnalysis(project, 'camera', inventory))[0]!;
    expect(changedFacts.sceneCategory).toBeUndefined();
    expect(changedFacts.classificationFingerprint).not.toBe(current.classificationFingerprint);
    const legacyFingerprint = createHash('sha256').update(JSON.stringify([current.colorManagementPolicy, fingerprint.contentHash,
      { inputColorSpace: current.inputColorSpace, inputColorSource: current.inputColorSource }, input.fingerprint, legacyClassification])).digest('hex');
    expect(current.classificationFingerprint).not.toBe(legacyFingerprint);
    // Raw diagnostic views depend on LUT content, independently of unchanged target Analyze.
    await mkdir(join(workspace, 'config/luts/test'), { recursive: true });
    await writeFile(join(workspace, 'config/luts/test/log.cube'), 'lut-one');
    await saveColorTransformPresetsConfig(workspace, { profiles: { slog3: { default: 'test/log.cube' } } });
    a.mediaVersions!.raw!.sourceProfile = 'slog3';
    a.mediaVersions!.raw!.colorPrimaries = 's-gamut3-cine';
    a.mediaVersions!.raw!.transferFunction = 's-log3-cine';
    await writeFile(join(project, 'raw/C001M01.XML'), '<Item name="CaptureGammaEquation" value="s-log3-cine"/><Item name="CaptureColorPrimaries" value="s-gamut3-cine"/>');
    await writeFile(join(project, 'store/assets.json'), JSON.stringify([a]));
    const oldLutProof = (await bindColorAnalysis(project, 'camera', inventory))[0]!.classificationFingerprint;
    await writeFile(join(workspace, 'config/luts/test/log.cube'), 'lut-two');
    expect((await bindColorAnalysis(project, 'camera', inventory))[0]!.classificationFingerprint).not.toBe(oldLutProof);
    await writeFile(join(project, 'raw/C001M01.XML'), '<Item name="CaptureGammaEquation" value="s-log3-cine"/><Item name="CaptureColorPrimaries" value="s-gamut3"/>');
    await expect(bindColorAnalysis(project, 'camera', inventory)).rejects.toThrow('先 Ingest');
    a.mediaVersions!.raw!.colorPrimaries = 's-gamut3';
    await writeFile(join(project, 'store/assets.json'), JSON.stringify([a]));
    expect((await bindColorAnalysis(project, 'camera', inventory))[0]!.classificationFingerprint).not.toBe(oldLutProof);
    await writeAssetReport(project, { ...report, analysisInput: { ...input, fingerprint: 'old' } });
    await expect(bindColorAnalysis(project, 'camera', inventory)).rejects.toThrow('先 Analyze');
    await writeFile(source, 'changed'); await expect(bindColorAnalysis(project, 'camera', inventory)).rejects.toThrow('先 Ingest');
  });
});
