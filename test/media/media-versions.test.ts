import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm, rename, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initWorkspaceProject, saveProjectBriefConfig, loadAssets, loadIngestRoots } from '../../src/store/index.js';
import { ingestWorkspaceProjectMedia } from '../../src/modules/media/project-ingest.js';
import { resolveAssetLocalPath } from '../../src/modules/media/root-resolver.js';
import { fingerprintMediaFile } from '../../src/modules/media/media-versions.js';
import { prepareAnalysisInputs } from '../../src/modules/media/analysis-input.js';
import { resolveProtectionAudioLocalPath } from '../../src/modules/media/protection-audio.js';
import { findUnreportedAssets } from '../../src/store/analysis.js';
import * as probe from '../../src/modules/media/probe.js';
import { testProbeResult } from './fixtures/ingest-probe.js';
import type { IAssetCoarseReport, IMediaRoot } from '../../src/protocol/schema.js';

const dirs: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture() {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'kairos-versions-')); dirs.push(workspaceRoot);
  const projectId = 'versions'; const projectRoot = await initWorkspaceProject(workspaceRoot, projectId, 'Versions');
  const target = join(workspaceRoot, 'target'); const raw = join(workspaceRoot, 'raw');
  await mkdir(target); await mkdir(raw);
  const root: IMediaRoot = { id: 'camera', rootCode: 'camera', path: target, rawPath: raw, enabled: true, color: { colorSpaceProfile: 'rec709' } };
  await saveProjectBriefConfig(projectRoot, { name: 'Versions', materialPatternPhrases: [], mappings: [{ ...root, rootId: root.id }] });
  vi.spyOn(probe, 'probe').mockResolvedValue(testProbeResult());
  const ingest = () => ingestWorkspaceProjectMedia({ workspaceRoot, projectId });
  return { workspaceRoot, projectRoot, raw, target, root: (await loadIngestRoots(projectRoot)).roots[0]!, ingest };
}

describe('two-version incremental pipeline', () => {
  it('pairs raw then target under one ID; invalidates only the selected content, not raw/mtime-only updates', async () => {
    const f = await fixture(); await writeFile(join(f.raw, 'C001.MOV'), 'raw-one');
    let a = (await f.ingest()).merge.assets[0]!; const id = a.id;
    expect(a.analysisInput?.role).toBe('raw'); expect(resolveAssetLocalPath(a, [f.root])).toBe(join(f.raw, 'C001.MOV'));
    const rawInput = a.analysisInput!;
    await writeFile(join(f.target, 'C001.mp4'), 'target-one');
    a = (await f.ingest()).merge.assets[0]!;
    expect(a.id).toBe(id); expect(a.analysisInput?.role).toBe('target'); expect(a.analysisInput?.fingerprint).not.toBe(rawInput.fingerprint);
    expect(Object.keys(a.mediaVersions!)).toEqual(['target', 'raw']);
    const targetInput = a.analysisInput!;
    const report = { assetId: id, analysisInput: targetInput } as IAssetCoarseReport;
    await writeFile(join(f.raw, 'C001.MOV'), 'raw-two');
    a = (await f.ingest()).merge.assets[0]!;
    expect(a.analysisInput!.fingerprint).toBe(targetInput.fingerprint); expect(findUnreportedAssets([a], [report])).toEqual([]);
    await utimes(join(f.target, 'C001.mp4'), new Date(), new Date(Date.now() + 2000));
    a = (await f.ingest()).merge.assets[0]!; expect(a.analysisInput!.fingerprint).toBe(targetInput.fingerprint);
    await writeFile(join(f.target, 'C001.mp4'), 'target-two');
    a = (await f.ingest()).merge.assets[0]!; expect(a.id).toBe(id); expect(findUnreportedAssets([a], [report])).toEqual([a]);
    expect((await loadAssets(f.projectRoot))).toHaveLength(1);
  });
  it('keeps offline raw registration and uses raw-only roots; role collisions fail before index writes', async () => {
    const f = await fixture(); await writeFile(join(f.raw, 'C001.MP4'), 'raw'); await writeFile(join(f.target, 'C001.mp4'), 'target');
    const before = (await f.ingest()).merge.assets[0]!;
    await rename(f.raw, f.raw + '-offline');
    const offline = (await f.ingest()).merge.assets[0]!;
    expect(offline.mediaVersions?.raw).toMatchObject({ available: false, contentHash: before.mediaVersions?.raw?.contentHash });
    await rename(f.raw + '-offline', f.raw); await rename(f.target, f.target + '-offline');
    const rawOnly = (await f.ingest()).merge.assets[0]!;
    expect(rawOnly.id).toBe(before.id); expect(rawOnly.analysisInput?.role).toBe('raw');
    await writeFile(join(f.raw, 'C001.mov'), 'duplicate');
    await expect(f.ingest()).rejects.toThrow('重名冲突'); expect((await loadAssets(f.projectRoot))[0]?.id).toBe(before.id);
  });
  it('honors per-file Rec709 over LOG default, does not apply a LOG LUT to target, and blocks unknown raw', async () => {
    const f = await fixture(); f.root.color = { colorSpaceProfile: 'slog3', transformPresetKey: 'Sony/absent.cube' };
    await saveProjectBriefConfig(f.projectRoot, { name: 'Versions', materialPatternPhrases: [], mappings: [{ ...f.root, rootId: f.root.id }] });
    await writeFile(join(f.raw, 'C001.MP4'), 'raw');
    await writeFile(join(f.raw, 'C001M01.XML'), '<Item name="CaptureGammaEquation" value="Rec.709"/>');
    let a = (await f.ingest()).merge.assets[0]!;
    expect(a.mediaVersions?.raw?.sourceProfile).toBe('rec709'); expect(a.analysisInput?.lutPath).toBeUndefined(); expect(a.analysisInput?.blocker).toBeUndefined();
    await writeFile(join(f.raw, 'C001M01.XML'), '<Item name="CaptureGammaEquation" value="S-Log3"/>');
    a = (await f.ingest()).merge.assets[0]!; expect(a.analysisInput?.blocker).toContain('LUT');
    await writeFile(join(f.target, 'C001.mp4'), 'target'); a = (await f.ingest()).merge.assets[0]!;
    expect(a.analysisInput?.role).toBe('target'); expect(a.analysisInput?.blocker).toBeUndefined(); expect(a.analysisInput?.lutPath).toBeUndefined();
  });
  it('does not delete unmigrated legacy target records while only the raw directory is online', async () => {
    const f = await fixture(); await writeFile(join(f.target, 'C001.mp4'), 'target');
    const a = (await f.ingest()).merge.assets[0]!;
    const { mediaVersions: _versions, analysisInput: _input, ...legacy } = a;
    await writeFile(join(f.projectRoot, 'store/assets.json'), JSON.stringify([legacy]));
    await rename(f.target, f.target + '-offline');
    expect((await f.ingest()).merge.assets.map(asset => asset.id)).toEqual([a.id]);
    await rename(f.target + '-offline', f.target);
    const migrated = (await f.ingest()).merge.assets[0]!;
    expect(migrated.id).toBe(a.id); expect(migrated.mediaVersions?.target?.available).toBe(true);
  });
  it('archives changed-input checkpoints before resume, preserves same-input checkpoints, and rejects un-ingested replacement', async () => {
    const f = await fixture(); await writeFile(join(f.target, 'C001.mp4'), 'target');
    let a = (await f.ingest()).merge.assets[0]!;
    const checkpointDir = join(f.projectRoot, 'analysis/audio-checkpoints'); await mkdir(checkpointDir, { recursive: true });
    const checkpoint = join(checkpointDir, a.id + '.json'); await writeFile(checkpoint, 'old');
    await prepareAnalysisInputs(f.workspaceRoot, f.projectRoot, [a], [f.root]); await expect(readFile(checkpoint)).rejects.toThrow();
    await writeFile(checkpoint, 'current'); await prepareAnalysisInputs(f.workspaceRoot, f.projectRoot, [a], [f.root]); expect(await readFile(checkpoint, 'utf8')).toBe('current');
    await writeFile(join(f.target, 'C001.mp4'), 'replacement');
    await expect(prepareAnalysisInputs(f.workspaceRoot, f.projectRoot, [a], [f.root])).rejects.toThrow('先 Ingest');
    a = (await f.ingest()).merge.assets[0]!; await prepareAnalysisInputs(f.workspaceRoot, f.projectRoot, [a], [f.root]); await expect(readFile(checkpoint)).rejects.toThrow();
  });
  it('binds protection audio to the selected raw/target role and fingerprints audio content independently', async () => {
    const f = await fixture(); await writeFile(join(f.raw, 'C001.MP4'), 'raw-video');
    await writeFile(join(f.raw, 'C001.wav'), 'raw-audio');
    let a = (await f.ingest()).merge.assets[0]!;
    expect(a.protectionAudio?.sourceRole).toBe('raw');
    expect(resolveProtectionAudioLocalPath(a, [f.root])).toBe(join(f.raw, 'C001.wav'));
    const rawInput = a.analysisInput!.fingerprint;
    await utimes(join(f.raw, 'C001.wav'), new Date(), new Date(Date.now() + 2000));
    a = (await f.ingest()).merge.assets[0]!; expect(a.analysisInput!.fingerprint).toBe(rawInput);
    await writeFile(join(f.raw, 'C001.wav'), 'updated-audio');
    await expect(prepareAnalysisInputs(f.workspaceRoot, f.projectRoot, [a], [f.root])).rejects.toThrow('保护音轨');
    a = (await f.ingest()).merge.assets[0]!; expect(a.analysisInput!.fingerprint).not.toBe(rawInput);
    await writeFile(join(f.target, 'C001.mp4'), 'target-video'); await writeFile(join(f.target, 'C001.wav'), 'target-audio');
    a = (await f.ingest()).merge.assets[0]!;
    expect(a.protectionAudio?.sourceRole).toBe('target');
    expect(resolveProtectionAudioLocalPath(a, [f.root])).toBe(join(f.target, 'C001.wav'));
  });
});
