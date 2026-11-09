import { afterEach, expect, it, vi } from 'vitest';
import { readFile, writeFile, rm, readdir, stat, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { assessColor, colorAssessmentPath, colorFingerprint } from '../../src/modules/color/assessment.js';
import { ColorAgentAssetPendingError, submitColorAgentClassification } from '../../src/modules/color/agent-classification.js';
import { COLOR_MEASUREMENT_VERSION, COLOR_THRESHOLDS, measureColorTechnical } from '../../src/modules/color/technical-measurement.js';
import { loadRuntimeConfig } from '../../src/store/project.js';
import { fixture, submission } from './agent-fixtures.js';
vi.mock('../../src/modules/color/technical-measurement.js', async () => {
  const actual = await vi.importActual<any>('../../src/modules/color/technical-measurement.js');
  return { ...actual, measureColorTechnical: vi.fn(async (_path, source) => ({ ...actual.emptyTechnical(source, 10000), status: 'partial',
    probe: { width: 3840, height: 2160, displayWidth: 3840, displayHeight: 2160, rotationDegrees: 0, fps: 30, durationMs: 10000 },
    highContrast: { state: 'not-observed', reasons: ['tested scan'], intervals: [] },
    exposure: { state: 'not-observed', reasons: ['tested scan'], intervals: [] } })) };
});
const dirs: string[] = [];
afterEach(async () => { vi.clearAllMocks(); await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true }))); });
async function pending(request: Parameters<typeof assessColor>[0]) {
  try { await assessColor(request); throw new Error('expected pending'); }
  catch (error) { expect(error).toBeInstanceOf(ColorAgentAssetPendingError); return (error as ColorAgentAssetPendingError).packet; }
}
async function snapshot(path: string): Promise<unknown> {
  const s = await stat(path);
  if (s.isDirectory()) return Object.fromEntries(await Promise.all((await readdir(path)).sort().map(async n => [n, await snapshot(join(path, n))])));
  return { bytes: await readFile(path, 'utf8'), mtime: s.mtimeMs };
}
it('caches pending measurement, accepts only formal decisions, and makes export verification strictly read-only', async () => {
  const f = await fixture(); dirs.push(f.workspaceRoot); await rm(join(f.projectRoot, 'store/color-measurements'), {recursive:true}); const request = f.requests[0];
  const first = await pending(request);
  expect(await pending(request)).toEqual(first); expect(measureColorTechnical).toHaveBeenCalledTimes(1);
  await expect(assessColor(request, { mode: 'verify' })).rejects.toThrow('过期');
  const value = await submission(f.projectRoot, f.root.id, [first]);
  await submitColorAgentClassification(f.projectRoot, f.root.id, value);
  const accepted = await assessColor(request); expect(accepted.decision).toMatchObject({ category: 'day', ruleVersion: 'color-agent-v1' });
  expect(await assessColor(request)).toEqual(accepted); expect(measureColorTechnical).toHaveBeenCalledTimes(1);
  const before = await snapshot(f.projectRoot);
  expect(await assessColor(request, { mode: 'verify', force: true })).toEqual(accepted);
  expect(await snapshot(f.projectRoot)).toEqual(before); expect(measureColorTechnical).toHaveBeenCalledTimes(1);
  const reportPath = join(f.projectRoot, `analysis/asset-reports/${request.asset.id}.json`);
  const report = JSON.parse(await readFile(reportPath, 'utf8')); report.transcriptSegments[0].text = '文本改变但时间未改。'; await writeFile(reportPath, JSON.stringify(report));
  const changedBefore = await snapshot(f.projectRoot);
  await expect(assessColor(request, { mode: 'verify' })).rejects.toThrow('过期');
  expect(await snapshot(f.projectRoot)).toEqual(changedBefore);
  const second = await pending(request); expect(second.packetFingerprint).not.toBe(first.packetFingerprint);
  expect(measureColorTechnical).toHaveBeenCalledTimes(1);
});
it('reuses only intact measurement-v4 pixels from old assessments and never falls back to their semantic decisions', async () => {
  const f = await fixture(); dirs.push(f.workspaceRoot); await rm(join(f.projectRoot, 'store/color-measurements'), {recursive:true}); const request = f.requests[0];
  const first = await pending(request), measurementPath = join(f.projectRoot, `store/color-measurements/${request.asset.id}.json`);
  const runtime = await loadRuntimeConfig(f.workspaceRoot);
  const legacyTechnicalFingerprint = colorFingerprint([COLOR_MEASUREMENT_VERSION, { ...COLOR_THRESHOLDS,
    highContrast: { ...COLOR_THRESHOLDS.highContrast, minIntervalMs: 3000, wholeClipFraction: 0.8,
      coverageBasis: 'positive-time-union-with-sustained-run-v1' } }, first.technical.source,
    request.asset.mediaVersions!.raw!.colorPrimaries, request.asset.mediaVersions!.raw!.transferFunction, request.root.color?.inputColorSpace,
    { ffmpegPath: runtime.ffmpegPath, ffprobePath: runtime.ffprobePath, ffmpegHwaccel: runtime.ffmpegHwaccel }]);
  const payload = { schemaVersion: 1, assetId: request.asset.id, inputFingerprint: request.colorInput.fingerprint,
    technicalFingerprint: legacyTechnicalFingerprint, technical: first.technical, decision: { ruleVersion: 'scene-v7', category: 'noisy', status: 'classified', reasons: ['OLD REGEX'] } };
  const path = colorAssessmentPath(f.projectRoot, request.asset.id);
  await mkdir(join(f.projectRoot, 'store/color-assessments'), {recursive:true});
  await writeFile(path, JSON.stringify({ ...payload, fingerprint: colorFingerprint(payload), updatedAt: 'old' }));
  await rm(measurementPath);
  await expect(assessColor(request, { mode: 'verify' })).rejects.toThrow('过期');
  expect(await pending(request)).toEqual(first); expect(measureColorTechnical).toHaveBeenCalledTimes(1);
  const corrupt = JSON.parse(await readFile(path, 'utf8')); corrupt.technical.exposure.state = 'detected'; await writeFile(path, JSON.stringify(corrupt));
  await rm(measurementPath);
  await pending(request); expect(measureColorTechnical).toHaveBeenCalledTimes(2);
});
