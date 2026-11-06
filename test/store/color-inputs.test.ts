import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { IAssetCoarseReport, type IKtepAsset } from '../../src/protocol/schema.js';
import { writeJson } from '../../src/store/writer.js';
import { saveIngestRoots } from '../../src/store/project.js';
import { writeAssetReport } from '../../src/store/analysis.js';
import { getColorInputsPath, loadColorInputs, refreshColorInputs } from '../../src/store/color-inputs.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

function asset(id = 'C001_camera'): IKtepAsset {
  return { id, kind: 'video', sourcePath: `${id}.mp4`, displayName: id, ingestRootId: 'camera',
    durationMs: 120000, width: 3840, height: 2160, capturedAt: '2026-11-06T08:00:00Z',
    metadata: { displayWidth: 2160, displayHeight: 3840, rotationDegrees: 90 },
    mediaVersions: {
      raw: { relativePath: `${id}.MP4`, available: true, contentHash: 'raw-content', sizeBytes: 100, mtimeMs: 1, ctimeMs: 1,
        sourceProfile: 'slog3', colorPrimaries: 's-gamut3-cine', transferFunction: 's-log3', profileSource: 'detected' },
      target: { relativePath: `${id}.mp4`, available: true, contentHash: 'target-content', sizeBytes: 50, mtimeMs: 1, ctimeMs: 1 },
    },
    analysisInput: { role: 'target', relativePath: `${id}.mp4`, contentHash: 'target-content', fingerprint: 'analysis-v1', policyVersion: 'target-first-v1' },
  };
}
function report(a: IKtepAsset): IAssetCoarseReport {
  return IAssetCoarseReport.parse({ assetId: a.id, analysisInput: a.analysisInput, clipTypeGuess: 'drive',
    summary: '白天前挡视角，随后进入隧道。', densityScore: 0.5, labels: [], placeHints: [], rootNotes: [], sampleFrames: [],
    interestingWindows: [], fineScanReasons: [], transcript: '测试口播', speechCoverage: 0.2,
    transcriptSegments: [{ startMs: 1000, endMs: 2000, text: '测试口播' }],
    fineScanWindows: [
      { windowId: 'visual', sourceInMs: 5000, sourceOutMs: 25000, semanticKind: 'visual', visualObservation: '驶入隧道。', status: 'recognized' },
      { windowId: 'speech', sourceInMs: 1000, sourceOutMs: 2000, semanticKind: 'speech', visualObservation: '前方道路。', status: 'recognized',
        transcript: '测试口播', transcriptSegments: [{ startMs: 1000, endMs: 2000, text: '测试口播' }] },
      { windowId: 'dropped', status: 'dropped', visualObservation: '不能作为已识别事实。' },
    ], createdAt: '2026-11-06', updatedAt: '2026-11-06',
    colorEvidence: { timeOfDay: 'night', visiblePresenter: true, windshieldCast: true, highContrast: true, veryDarkNoisy: true,
      overexposed: true, lightChange: true, flicker: 'suspected', observation: '旧模型技术结论' },
    colorClassification: { ruleVersion: 'scene-v1', category: 'overexposed', reasons: [], reviewFlags: [] },
  });
}
async function setup(assets = [asset()]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'kairos-color-inputs-')); directories.push(root);
  await writeJson(join(root, 'store/assets.json'), assets);
  await saveIngestRoots(root, { roots: [{ id: 'camera', rootCode: 'camera', enabled: true,
    path: join(root, 'target'), rawPath: join(root, 'raw'), color: { inputColorSpace: 'S-Gamut3.Cine/S-Log3' } }] });
  return root;
}

describe('material color input store', () => {
  it('persists existing facts after report writes without interpreting text or borrowing window speech', async () => {
    const a = asset(); const root = await setup([a]);
    await writeAssetReport(root, report(a));
    const entry = (await loadColorInputs(root))!.assets[a.id];
    expect(entry).toMatchObject({ analysisStatus: 'current', analysisInput: { role: 'target' },
      media: { displayWidth: 2160, displayHeight: 3840, rotationDegrees: 90,
        versions: { raw: { sourceProfile: 'slog3', contentHash: 'raw-content' } }, rootColor: { inputColorSpace: 'S-Gamut3.Cine/S-Log3' } },
      facts: { type: 'drive', summary: report(a).summary, speech: { hasTranscript: true, ranges: [{ startMs: 1000, endMs: 2000 }] } } });
    expect(entry.facts!.visualWindows).toHaveLength(2);
    expect(entry.facts!.visualWindows[0]).toMatchObject({ windowId: 'visual', speech: { hasTranscript: false, ranges: [] } });
    expect(entry.facts!.visualWindows[1].speech.ranges).toHaveLength(1);
    const text = await readFile(getColorInputsPath(root), 'utf8');
    expect(text).not.toMatch(/colorEvidence|colorClassification|overexposed|flicker|测试口播|alignedTokens|materialPatterns/u);
    expect(entry.sources.reportPath).toBe(`analysis/asset-reports/${a.id}.json`);
  });

  it('does not rewrite unchanged entries or invalidate for stat-only, GPS, or obsolete technical fields', async () => {
    const a = asset(); const root = await setup([a]); const r = report(a);
    await writeAssetReport(root, r);
    const before = await readFile(getColorInputsPath(root), 'utf8');
    a.mediaVersions!.raw!.mtimeMs = 999; a.mediaVersions!.target!.ctimeMs = 999;
    a.metadata!.unrelatedGps = 'changed';
    await writeJson(join(root, 'store/assets.json'), [a]);
    await writeAssetReport(root, { ...r, gpsSummary: '新地点', updatedAt: 'later', colorEvidence: undefined, colorClassification: undefined });
    await refreshColorInputs(root);
    expect(await readFile(getColorInputsPath(root), 'utf8')).toBe(before);
  });

  it('updates raw metadata independently while an unchanged target report remains current', async () => {
    const a = asset(); const root = await setup([a]); await writeAssetReport(root, report(a));
    const before = (await loadColorInputs(root))!.assets[a.id];
    a.mediaVersions!.raw!.contentHash = 'raw-v2'; a.mediaVersions!.raw!.sourceProfile = 'rec709';
    await writeJson(join(root, 'store/assets.json'), [a]);
    const after = (await refreshColorInputs(root)).assets[a.id];
    expect(after.analysisStatus).toBe('current');
    expect(after.facts).toEqual(before.facts);
    expect(after.sources.reportFactsFingerprint).toBe(before.sources.reportFactsFingerprint);
    expect(after.fingerprint).not.toBe(before.fingerprint);
    expect(after.media.versions.raw!.contentHash).toBe('raw-v2');
  });

  it('withholds stale or missing facts and recovers only after the matching report arrives', async () => {
    const a = asset(); const root = await setup([a]); await writeAssetReport(root, report(a));
    a.mediaVersions!.target!.contentHash = 'target-v2';
    a.analysisInput = { ...a.analysisInput!, contentHash: 'target-v2', fingerprint: 'analysis-v2' };
    await writeJson(join(root, 'store/assets.json'), [a]);
    let entry = (await refreshColorInputs(root)).assets[a.id];
    expect(entry.analysisStatus).toBe('stale'); expect(entry.facts).toBeUndefined();
    await writeAssetReport(root, report(a));
    expect((await loadColorInputs(root))!.assets[a.id].analysisStatus).toBe('current');
    await rm(join(root, 'analysis/asset-reports', `${a.id}.json`));
    entry = (await refreshColorInputs(root)).assets[a.id];
    expect(entry.analysisStatus).toBe('missing'); expect(entry.facts).toBeUndefined();
    a.analysisInput.blocker = 'LUT missing'; await writeJson(join(root, 'store/assets.json'), [a]);
    expect((await refreshColorInputs(root)).assets[a.id]).toMatchObject({ analysisStatus: 'blocked', reasons: ['LUT missing'] });
  });

  it('rebuilds corrupt or edited projections from source reports, preserving the source bytes', async () => {
    const a = asset(); const root = await setup([a]); await writeAssetReport(root, report(a));
    const sourcePath = join(root, 'analysis/asset-reports', `${a.id}.json`);
    const source = await readFile(sourcePath, 'utf8');
    const stored = (await loadColorInputs(root))!;
    stored.assets[a.id].facts!.type = 'talking-head'; // Retain the old fingerprint to try to hide the edit.
    await writeJson(getColorInputsPath(root), stored);
    expect((await refreshColorInputs(root)).assets[a.id].facts!.type).toBe('drive');
    await writeJson(getColorInputsPath(root), { schemaVersion: -1 });
    expect((await refreshColorInputs(root)).assets[a.id].facts!.type).toBe('drive');
    expect(await readFile(sourcePath, 'utf8')).toBe(source);
  });

  it('rejects a report for a different asset or inconsistent input fields even if its fingerprint string matches', async () => {
    const a = asset(); const root = await setup([a]); const r = report(a);
    const path = join(root, 'analysis/asset-reports', `${a.id}.json`);
    await writeJson(path, { ...r, assetId: 'different_asset' });
    let entry = (await refreshColorInputs(root)).assets[a.id];
    expect(entry.analysisStatus).toBe('stale'); expect(entry.facts).toBeUndefined();
    await writeJson(path, { ...r, analysisInput: { ...r.analysisInput, role: 'raw' } });
    entry = (await refreshColorInputs(root)).assets[a.id];
    expect(entry.analysisStatus).toBe('stale'); expect(entry.facts).toBeUndefined();
  });

  it('serializes concurrent report updates and preserves unrelated entries across append/prune', async () => {
    const assets = Array.from({ length: 6 }, (_, index) => asset(`C00${index}_camera`));
    const root = await setup(assets);
    await Promise.all(assets.map(a => writeAssetReport(root, report(a))));
    const first = (await loadColorInputs(root))!;
    expect(Object.values(first.assets).every(entry => entry.analysisStatus === 'current')).toBe(true);
    expect(Object.keys(first.assets)).toHaveLength(6);
    const newAsset = asset('C999_camera');
    await writeJson(join(root, 'store/assets.json'), [...assets.slice(1), newAsset]);
    await writeAssetReport(root, report(newAsset));
    const next = (await loadColorInputs(root))!;
    expect(next.assets[assets[0].id]).toBeUndefined();
    expect(next.assets[newAsset.id].analysisStatus).toBe('current');
    expect(next.assets[assets[1].id]).toEqual(first.assets[assets[1].id]);
  });

  it('keeps a successfully written source report recoverable when projection persistence fails', async () => {
    const a = asset(); const root = await setup([a]);
    await mkdir(getColorInputsPath(root));
    await expect(writeAssetReport(root, report(a))).rejects.toThrow();
    expect(JSON.parse(await readFile(join(root, 'analysis/asset-reports', `${a.id}.json`), 'utf8')).assetId).toBe(a.id);
    await rm(getColorInputsPath(root), { recursive: true });
    expect((await refreshColorInputs(root)).assets[a.id].analysisStatus).toBe('current');
  });

  it('keeps unversioned reports explicit, does not invent rotation, and excludes audio assets', async () => {
    const a = asset(); delete a.mediaVersions; delete a.analysisInput; a.metadata = { rotationDegrees: null };
    const audio = { ...asset('A001'), kind: 'audio' as const };
    const root = await setup([a, audio]); await writeAssetReport(root, report(a));
    const store = (await loadColorInputs(root))!;
    expect(Object.keys(store.assets)).toEqual([a.id]);
    expect(store.assets[a.id]).toMatchObject({ analysisStatus: 'unversioned', media: { rotationDegrees: null } });
    expect(store.assets[a.id].media.displayWidth).toBeUndefined();
  });
});

it('projects GPS geometry with provenance and invalidates solar inputs without copying place prose', async () => {
  const a = asset(); const root = await setup([a]); const r = report(a);
  r.inferredGps = { source: 'pharos', lat: 28, lng: 118, confidence: 0.9, timezone: 'Asia/Shanghai', locationText: '地点不能成为太阳几何输入' };
  await writeAssetReport(root, r);
  const first = (await loadColorInputs(root))!.assets[a.id];
  expect(first.facts!.gps).toEqual({ source: 'pharos', lat: 28, lng: 118, confidence: 0.9, timezone: 'Asia/Shanghai' });
  await writeAssetReport(root, { ...r, inferredGps: { ...r.inferredGps, locationText: '另一段无关地点文字' } });
  expect((await loadColorInputs(root))!.assets[a.id].fingerprint).toBe(first.fingerprint);
  await writeAssetReport(root, { ...r, inferredGps: { ...r.inferredGps, lng: 119 } });
  expect((await loadColorInputs(root))!.assets[a.id].fingerprint).not.toBe(first.fingerprint);
});
