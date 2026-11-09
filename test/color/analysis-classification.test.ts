import { afterEach, expect, it, vi } from 'vitest';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { bindColorAnalysis } from '../../src/modules/color/analysis-classification.js';
import { ColorAgentBatchPendingError, submitColorAgentClassification, COLOR_AGENT_POLICY_FINGERPRINT } from '../../src/modules/color/agent-classification.js';
import { measureColorTechnical } from '../../src/modules/color/technical-measurement.js';
import { fixture, result } from './agent-fixtures.js';
vi.mock('../../src/modules/color/technical-measurement.js', async () => {
  const actual = await vi.importActual<any>('../../src/modules/color/technical-measurement.js');
  return { ...actual, measureColorTechnical: vi.fn(async (_path, source) => ({ ...actual.emptyTechnical(source, 10000), status: 'partial',
    probe: { width: 3840, height: 2160, displayWidth: 3840, displayHeight: 2160, rotationDegrees: 0, fps: 30, durationMs: 10000 } })) };
});
const dirs: string[] = [];
afterEach(async () => { vi.clearAllMocks(); await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true }))); });
it('validates all inputs first, stages all missing classifications, then reuses accepted results without measurement', async () => {
  const f = await fixture(2); dirs.push(f.workspaceRoot); await rm(join(f.projectRoot, 'store/color-measurements'), {recursive:true});
  const inventory = f.requests.map(r => ({ rawRelativePath: r.asset.mediaVersions!.raw!.relativePath, sourceAbsolutePath: r.sourcePath }));
  const missingReportPath = join(f.projectRoot, `analysis/asset-reports/${f.assets[1].id}.json`);
  await rm(missingReportPath);
  await expect(bindColorAnalysis(f.projectRoot, f.root.id, inventory)).rejects.toThrow('先 Analyze');
  expect(measureColorTechnical).not.toHaveBeenCalled();
  await writeFile(missingReportPath, JSON.stringify(f.reports[1]));
  let pending: ColorAgentBatchPendingError;
  try { await bindColorAnalysis(f.projectRoot, f.root.id, inventory); throw new Error('expected pending'); }
  catch (error) { expect(error).toBeInstanceOf(ColorAgentBatchPendingError); pending = error as ColorAgentBatchPendingError; }
  expect(pending.state).toMatchObject({ pendingCount: 2, model: 'gpt-6.1-sol', reasoningEffort: 'high' });
  expect(measureColorTechnical).toHaveBeenCalledTimes(2);
  await expect(bindColorAnalysis(f.projectRoot, f.root.id, inventory)).rejects.toBeInstanceOf(ColorAgentBatchPendingError);
  expect(measureColorTechnical).toHaveBeenCalledTimes(2);
  const batch = JSON.parse(await readFile(join(f.projectRoot, 'store/color-agent/batches', pending.state.batchFingerprint, 'batch.json'), 'utf8'));
  const packets = await Promise.all(batch.packets.map((p: any) => readFile(join(f.projectRoot, 'store/color-agent/packets', `${p.packetFingerprint}.json`), 'utf8').then(JSON.parse)));
  await submitColorAgentClassification(f.projectRoot, f.root.id, { schemaVersion: 1, batchFingerprint: pending.state.batchFingerprint,
    policyVersion: 'color-agent-v1', policyFingerprint: COLOR_AGENT_POLICY_FINGERPRINT, model: 'gpt-6.1-sol', reasoningEffort: 'high', results: packets.map(p => result(p)) });
  const bound = await bindColorAnalysis(f.projectRoot, f.root.id, inventory);
  expect(bound).toHaveLength(2); expect(bound.every(b => b.sceneCategory === 'day' && b.classificationStatus === 'classified')).toBe(true);
  expect(await bindColorAnalysis(f.projectRoot, f.root.id, inventory, { mode: 'verify' })).toEqual(bound);
  expect(measureColorTechnical).toHaveBeenCalledTimes(2);
  const legacyFields = { ...f.reports[0], colorEvidence: { timeOfDay:'day', visiblePresenter:true, windshieldCast:false, highContrast:true, veryDarkNoisy:false, overexposed:false, lightChange:false, flicker:'unknown', observation:'旧模型技术判断' }, colorClassification: { ruleVersion: 'scene-v1', category: 'portrait', reasons:['old'], reviewFlags:[] } };
  await writeFile(join(f.projectRoot, `analysis/asset-reports/${f.assets[0].id}.json`), JSON.stringify(legacyFields));
  expect(await bindColorAnalysis(f.projectRoot, f.root.id, inventory)).toEqual(bound);
  await writeFile(f.requests[0].sourcePath, 'changed raw');
  await expect(bindColorAnalysis(f.projectRoot, f.root.id, inventory)).rejects.toThrow('先 Ingest');
});
