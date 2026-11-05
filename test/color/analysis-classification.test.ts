import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IKtepAsset, IColorAnalysisEvidence, IAssetCoarseReport } from '../../src/protocol/schema.js';
import { classifyAnalyzedColor } from '../../src/modules/color/classification.js';
import { bindColorAnalysis } from '../../src/modules/color/analysis-classification.js';
import { loadIngestRoots, saveIngestRoots, saveColorTransformPresetsConfig } from '../../src/store/index.js';
import { buildAnalysisInput, fingerprintMediaFile } from '../../src/modules/media/media-versions.js';
import { writeAssetReport } from '../../src/store/analysis.js';
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const asset: IKtepAsset = { id: 'C001_camera', sourcePath: 'C001.mp4', displayName: 'C001', kind: 'video', width: 3840, height: 2160 };
const evidence: IColorAnalysisEvidence = { timeOfDay: 'day', visiblePresenter: false, windshieldCast: false, highContrast: false, veryDarkNoisy: false, overexposed: false, lightChange: false, flicker: 'unknown', observation: '白天道路' };

describe('Analyze color classification', () => {
  it('uses one exclusive category and prioritizes portrait over every scene/technical mode', () => {
    expect(classifyAnalyzedColor({ ...asset, metadata: { displayWidth: 2160, displayHeight: 3840 } }, 'talking-head', { ...evidence, visiblePresenter: true, overexposed: true }).category).toBe('portrait');
    expect(classifyAnalyzedColor(asset, 'drive', { ...evidence, visiblePresenter: true, overexposed: true }).category).toBe('presenter');
    expect(classifyAnalyzedColor(asset, 'broll', { ...evidence, overexposed: true, highContrast: true }).category).toBe('overexposed');
  });
  it('shares night/HDR between drive and normal scenes; windshield category requires both day and drive', () => {
    for (const type of ['drive', 'broll'] as const) {
      expect(classifyAnalyzedColor(asset, type, { ...evidence, timeOfDay: 'night' }).category).toBe('night');
      expect(classifyAnalyzedColor(asset, type, { ...evidence, highContrast: true }).category).toBe('high-contrast');
      expect(classifyAnalyzedColor(asset, type, { ...evidence, veryDarkNoisy: true }).category).toBe('dark-noisy');
    }
    expect(classifyAnalyzedColor(asset, 'drive', { ...evidence, windshieldCast: true }).category).toBe('day-drive-cast');
    expect(classifyAnalyzedColor(asset, 'broll', { ...evidence, windshieldCast: true }).category).toBe('day');
    expect(classifyAnalyzedColor(asset, 'drive', { ...evidence, timeOfDay: 'twilight', windshieldCast: true }).category).toBe('twilight');
    expect(classifyAnalyzedColor(asset, 'drive', { ...evidence, timeOfDay: 'unknown', windshieldCast: true }).category).toBe('review');
  });
  it('retains change/flicker as review flags without crossing categories or pretending sparse frames prove flicker', () => {
    const result = classifyAnalyzedColor(asset, 'drive', { ...evidence, lightChange: true, flicker: 'suspected' });
    expect(result.category).toBe('day'); expect(result.reviewFlags).toHaveLength(2);
    expect(classifyAnalyzedColor(asset, 'drive').category).toBe('review');
    expect(classifyAnalyzedColor({ ...asset, width: undefined }, 'drive', evidence).category).toBe('review');
  });
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
    const report: IAssetCoarseReport = { assetId: a.id, analysisInput: input, colorEvidence: evidence, clipTypeGuess: 'drive', keepDecision: 'keep', densityScore: 0.5, labels: [], placeHints: [], rootNotes: [], sampleFrames: [], interestingWindows: [], fineScanWindows: [], fineScanReasons: [], pharosMatches: [], createdAt: '2026-11-05', updatedAt: '2026-11-05' };
    await writeAssetReport(project, report);
    expect((await bindColorAnalysis(project, 'camera', inventory))[0]).toMatchObject({ assetId: a.id, sceneCategory: 'day', sceneGroupName: '普通白天', sourceContentHash: fingerprint.contentHash });
    // Target analysis no longer depends on a Resolve technical LUT. RCM input changes do require preparation.
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
    expect((await bindColorAnalysis(project, 'camera', inventory))[0]!.classificationFingerprint).toBe(oldLutProof);
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
