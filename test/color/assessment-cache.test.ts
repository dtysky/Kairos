import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assessColor, colorAssessmentPath, colorFingerprint } from '../../src/modules/color/assessment.js';
import { emptyTechnical, measureColorTechnical } from '../../src/modules/color/technical-measurement.js';
import { fingerprintMediaFile } from '../../src/modules/media/media-versions.js';
import type { IColorInput } from '../../src/store/color-inputs.js';
import type { IKtepAsset, IMediaRoot } from '../../src/protocol/schema.js';
vi.mock('../../src/modules/color/technical-measurement.js', async () => {
  const actual = await vi.importActual<any>('../../src/modules/color/technical-measurement.js');
  return { ...actual, measureColorTechnical: vi.fn(async (_path, source) => ({ ...actual.emptyTechnical(source, 10000), status: 'partial',
    highContrast: { state: 'not-observed', reasons: ['tested scan'], intervals: [] },
    exposure: { state: 'not-observed', reasons: ['tested scan'], intervals: [] } })) };
});
const dirs: string[] = [];
afterEach(async () => { vi.clearAllMocks(); await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true }))); });
it('reuses measurements for semantic/GPS edits, verifies export without decode and rejects corrupted caches', async () => {
  const w = await mkdtemp(join(tmpdir(), 'kairos-color-cache-')); dirs.push(w);
  const p = join(w, 'projects/demo'), sourcePath = join(w, 'C001.MP4'); await mkdir(p, { recursive: true }); await writeFile(sourcePath, 'media-one');
  const raw = { ...await fingerprintMediaFile(sourcePath), relativePath: 'C001.MP4', available: true, sourceProfile: 'rec709' as const };
  const asset: IKtepAsset = { id: 'C001_camera', kind: 'video', sourcePath: 'C001.MP4', displayName: 'C001', durationMs: 10000, mediaVersions: { raw } };
  const root: IMediaRoot = { id: 'camera', enabled: true, rootCode: 'camera', path: w, rawPath: w };
  const colorInput: IColorInput = { assetId: asset.id, analysisStatus: 'current', reasons: [], fingerprint: 'one', updatedAt: 'now',
    media: { kind: 'video', width: 3840, height: 2160, versions: { raw } },
    facts: { type: 'broll', summary: '白天户外街道。', speech: { hasTranscript: false, ranges: [] }, visualWindows: [] },
    sources: { assetFingerprint: 'a', reportPath: 'report' } };
  const request = { workspaceRoot: w, projectRoot: p, asset, root, sourcePath, colorInput, transforms: { profiles: {}, discoveredPresets: {} } };
  const first = await assessColor(request); expect(first.decision.category).toBe('day');
  const path = colorAssessmentPath(p, asset.id); const time = (await stat(path)).mtimeMs;
  expect(await assessColor(request)).toEqual(first); expect((await stat(path)).mtimeMs).toBe(time);
  await assessColor(request, { mode: 'verify', force: true }); expect(measureColorTechnical).toHaveBeenCalledTimes(1);
  colorInput.fingerprint = 'gps-changed'; colorInput.facts!.gps = { source: 'pharos', confidence: 1, lat: 30, lng: 120 };
  await expect(assessColor(request, { mode: 'verify' })).rejects.toThrow('过期');
  const second = await assessColor(request); expect(second.fingerprint).not.toBe(first.fingerprint); expect(measureColorTechnical).toHaveBeenCalledTimes(1);
  const tampered = JSON.parse(await readFile(path, 'utf8')); tampered.technical.exposure.state = 'detected'; await writeFile(path, JSON.stringify(tampered));
  await expect(assessColor(request, { mode: 'verify' })).rejects.toThrow('过期');
  expect((await assessColor(request)).technical.exposure.state).toBe('not-observed'); expect(measureColorTechnical).toHaveBeenCalledTimes(2);
  await writeFile(sourcePath, 'media-two'); asset.mediaVersions!.raw = { ...raw, ...await fingerprintMediaFile(sourcePath) };
  await expect(assessColor(request, { mode: 'verify' })).rejects.toThrow('过期');
  await assessColor(request); expect(measureColorTechnical).toHaveBeenCalledTimes(3);
  const legacy = JSON.parse(await readFile(path, 'utf8'));
  legacy.technical.version = 'color-measurement-v2'; legacy.technical.thresholdVersion = 'real-samples-v2';
  delete legacy.technical.contrastOverview; delete legacy.technical.highContrast;
  const { fingerprint: _fingerprint, updatedAt: _updatedAt, ...payload } = legacy;
  legacy.fingerprint = colorFingerprint(payload); await writeFile(path, JSON.stringify(legacy));
  await expect(assessColor(request, { mode: 'verify' })).rejects.toThrow('过期');
  expect(measureColorTechnical).toHaveBeenCalledTimes(3);
  expect((await assessColor(request)).technical.version).toBe('color-measurement-v3');
  expect(measureColorTechnical).toHaveBeenCalledTimes(4);
});
