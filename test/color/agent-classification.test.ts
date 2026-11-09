import { afterEach, describe, expect, it } from 'vitest';
import { readFile, writeFile, rm, mkdir, utimes, stat, realpath } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { saveIngestRoots } from '../../src/store/project.js';
import { buildAnalysisInput } from '../../src/modules/media/media-versions.js';
import { writeAssetReport } from '../../src/store/analysis.js';
import { acceptedColorAgentDecision, buildColorAgentPacket, submitColorAgentClassification, validateColorAgentResult,
  verifyColorAgentPacketSources, colorFingerprint } from '../../src/modules/color/agent-classification.js';
import { refreshColorInputs } from '../../src/store/color-inputs.js';
import { fixture, result, resign, submission } from './agent-fixtures.js';
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true }))); });
async function setup(n = 1) { const f = await fixture(n); dirs.push(f.workspaceRoot); return f; }

describe('formal Color Agent contract', () => {
  it('stages independently signed evidence and atomically accepts the complete batch', async () => {
    const f = await setup(2), value = await submission(f.projectRoot, f.root.id, f.packets);
    expect(f.packets[0].report.transcriptSegments![0].text).toBe('今天讲解物品。');
    expect(JSON.stringify(f.packets)).not.toContain('scene-v7');
    const path = join(f.projectRoot, 'store/color-classifications.json');
    const missing = { ...value, results: value.results.slice(0, 1) };
    await expect(submitColorAgentClassification(f.projectRoot, f.root.id, missing)).rejects.toThrow('完整、唯一');
    await expect(readFile(path)).rejects.toThrow();
    const wrong = structuredClone(value); wrong.results[1].evidence[0].quoteOrValue = 'invented quote';
    await expect(submitColorAgentClassification(f.projectRoot, f.root.id, wrong)).rejects.toThrow('不精确');
    await expect(readFile(path)).rejects.toThrow();
    await expect(submitColorAgentClassification(f.projectRoot, f.root.id, { ...value, results: [value.results[0], value.results[0]] })).rejects.toThrow('唯一');
    await expect(submitColorAgentClassification(f.projectRoot, f.root.id, { ...value, model: 'gpt-6-luna' })).rejects.toThrow();
    expect(await submitColorAgentClassification(f.projectRoot, f.root.id, value)).toMatchObject({ status: 'accepted', acceptedCount: 2 });
    const bytes = await readFile(path, 'utf8');
    await expect(submitColorAgentClassification(f.projectRoot, f.root.id, wrong)).rejects.toThrow();
    expect(await readFile(path, 'utf8')).toBe(bytes);
    expect(await acceptedColorAgentDecision(f.projectRoot, f.packets[0])).toMatchObject({ ruleVersion: 'color-agent-v1', category: 'day' });
    await rm(join(f.projectRoot, 'store/color-agent'), { recursive: true });
    expect((await acceptedColorAgentDecision(f.projectRoot, f.packets[0]))!.category).toBe('day');
    const store = JSON.parse(bytes); store.records[f.assets[0].id].result.category = 'night'; await writeFile(path, JSON.stringify(store));
    expect(await acceptedColorAgentDecision(f.projectRoot, f.packets[0])).toBeNull();
  });
  it('rejects transcript text edits before submission even when speech ranges and projected facts are unchanged', async () => {
    const f = await setup(), value = await submission(f.projectRoot, f.root.id, f.packets);
    const report = { ...f.reports[0], transcript: '说了不同内容。', transcriptSegments: [{ startMs: 100, endMs: 1200, text: '说了不同内容。' }] };
    await writeFile(join(f.projectRoot, `analysis/asset-reports/${report.assetId}.json`), JSON.stringify(report));
    await expect(submitColorAgentClassification(f.projectRoot, f.root.id, value)).rejects.toThrow('过期');
    expect((await refreshColorInputs(f.projectRoot)).assets[report.assetId].fingerprint).toBe(f.packets[0].inputFingerprint);
  });
  it('serializes real concurrent CLI-process submissions without losing another root records', async () => {
    const f = await setup(2);
    const roots = (await saveIngestRoots(f.projectRoot, { roots: [f.root, { ...f.root, id: 'other', rootCode: 'other' }] })).roots;
    f.assets[1].ingestRootId = 'other';
    f.assets[1].analysisInput = await buildAnalysisInput(f.assets[1], roots[1], f.workspaceRoot, f.requests[1].transforms);
    await writeFile(join(f.projectRoot, 'store/assets.json'), JSON.stringify(f.assets));
    await writeAssetReport(f.projectRoot, { ...f.reports[1], analysisInput: f.assets[1].analysisInput });
    const inputs = await refreshColorInputs(f.projectRoot);
    const scriptPath = join(f.workspaceRoot, 'submit-agent.ts');
    await writeFile(scriptPath, `
      import { readFile } from 'node:fs/promises';
      import { buildColorAgentPacket, stageColorAgentBatch, submitColorAgentClassification, COLOR_AGENT_POLICY_FINGERPRINT } from ${JSON.stringify(join(process.cwd(), 'src/modules/color/agent-classification.ts'))};
      const input = JSON.parse(await readFile(process.env.COLOR_AGENT_TEST_INPUT, 'utf8'));
      const packet = await buildColorAgentPacket(input.request);
      const pending = await stageColorAgentBatch(input.request.projectRoot, input.request.root.id, [packet]);
      input.result.packetFingerprint = packet.packetFingerprint;
      await submitColorAgentClassification(input.request.projectRoot, input.request.root.id, {
        schemaVersion:1, batchFingerprint:pending.state.batchFingerprint, policyVersion:'color-agent-v1',
        policyFingerprint:COLOR_AGENT_POLICY_FINGERPRINT, model:'gpt-6.1-sol', reasoningEffort:'high', results:[input.result]
      });
    `);
    const paths = await Promise.all(f.requests.map(async (request, i) => {
      const path = join(f.workspaceRoot, `submit-${i}.json`);
      await writeFile(path, JSON.stringify({ request: { ...request, root: roots[i], colorInput: inputs.assets[request.asset.id],
        technical: f.packets[i].technical, technicalFingerprint: f.packets[i].technicalFingerprint }, result: result(f.packets[i]) }));
      return path;
    }));
    const child = promisify(execFile);
    const testRequire = createRequire(await realpath(resolve('node_modules/vitest/package.json')));
    const viteNode = resolve(dirname(testRequire.resolve('vite-node')), '../vite-node.mjs');
    await Promise.all(paths.map(path => child(process.execPath, [viteNode, scriptPath], { timeout: 15000, env: { ...process.env, COLOR_AGENT_TEST_INPUT: path } })));
    const accepted = JSON.parse(await readFile(join(f.projectRoot, 'store/color-classifications.json'), 'utf8'));
    expect(Object.keys(accepted.records).sort()).toEqual(f.assets.map(a => a.id).sort());
  });
  it('rejects changed reports, registered metadata, raw bytes and independent user context before accepting', async () => {
    const f = await setup(), packet = f.packets[0];
    await mkdir(join(f.projectRoot, 'config'), { recursive: true });
    await writeFile(join(f.projectRoot, 'config/color-agent-context.json'), JSON.stringify({ schemaVersion: 1, assets: {
      [packet.assetId]: [{ source: 'user', statement: '用户明确这是低照度室内', recordedAt: 'now' }] } }));
    await expect(verifyColorAgentPacketSources(f.projectRoot, packet)).rejects.toThrow('过期');
    const contextual = await buildColorAgentPacket({ ...f.requests[0], technical: packet.technical, technicalFingerprint: packet.technicalFingerprint });
    expect(contextual.packetFingerprint).not.toBe(packet.packetFingerprint);
    await rm(join(f.projectRoot, 'config/color-agent-context.json'));
    const source = f.requests[0].sourcePath, before = await stat(source);
    await utimes(source, before.atime, new Date(before.mtimeMs + 2000));
    await expect(verifyColorAgentPacketSources(f.projectRoot, packet)).resolves.toBeUndefined();
    f.assets[0].width = 1920; await writeFile(join(f.projectRoot, 'store/assets.json'), JSON.stringify(f.assets));
    await expect(verifyColorAgentPacketSources(f.projectRoot, packet)).rejects.toThrow('过期');
    f.assets[0].width = 3840; await writeFile(join(f.projectRoot, 'store/assets.json'), JSON.stringify(f.assets));
    await writeFile(source, 'changed-raw');
    await expect(verifyColorAgentPacketSources(f.projectRoot, packet)).rejects.toThrow('过期');
  });
  it('rejects copied packet hashes and arbitrary evidence or invented source intervals', async () => {
    const f = await setup(), packet = f.packets[0];
    const corrupted = structuredClone(packet); corrupted.report.summary = 'changed';
    expect(() => validateColorAgentResult(corrupted, result(corrupted))).toThrow('签名');
    const oldPolicy = resign({ ...packet, policyFingerprint: '0'.repeat(64) });
    expect(() => validateColorAgentResult(oldPolicy, result(oldPolicy))).toThrow('策略');
    expect(() => validateColorAgentResult(packet, result(packet, { evidence: [{ source: 'report.__proto__', quoteOrValue: 'x', supports: 'x' }] }))).toThrow('不存在');
    expect(() => validateColorAgentResult(packet, result(packet, { supplementalIssues: [{ kind: 'scene', detail: '变化', intervals: [{ startMs: 2000, endMs: 3000 }] }] }))).toThrow('已有范围');
    expect(() => validateColorAgentResult(packet, result(packet, { supplementalIssues: [{ kind: 'scene', detail: '已有语音区间', intervals: [{ startMs: 100, endMs: 1200 }] }] }))).not.toThrow();
  });
  it('rejects a pending packet when a newer measured result has replaced its technical cache', async () => {
    const f = await setup(), value = await submission(f.projectRoot, f.root.id, f.packets);
    const path = join(f.projectRoot, 'store/color-measurements', `${f.assets[0].id}.json`);
    const cached = JSON.parse(await readFile(path, 'utf8'));
    cached.technical.noise.state = 'detected';
    const { fingerprint: _hash, ...payload } = cached;
    await writeFile(path, JSON.stringify({ ...payload, fingerprint: colorFingerprint(payload) }));
    await expect(submitColorAgentClassification(f.projectRoot, f.root.id, value)).rejects.toThrow('技术缓存');
    await expect(readFile(join(f.projectRoot, 'store/color-classifications.json'))).rejects.toThrow();
  });
  it('requires physical support for technical classes but allows a supported class with unknown measurements', async () => {
    const f = await setup(), packet = f.packets[0];
    expect(() => validateColorAgentResult(packet, result(packet))).not.toThrow();
    for (const category of ['noisy', 'overexposed', 'high-contrast'] as const) expect(() => validateColorAgentResult(packet, result(packet, { category }))).toThrow();
    for (const [category, key] of [['noisy', 'noise'], ['overexposed', 'exposure'], ['high-contrast', 'highContrast']] as const) {
      const positive = structuredClone(packet); positive.technical[key].state = 'detected';
      const signed = resign(positive), decision = result(signed, { category });
      expect(() => validateColorAgentResult(signed, decision)).toThrow('精确引用');
      decision.evidence.push({ source: `technical.${key}.state`, quoteOrValue: 'detected', supports: '技术阳性' });
      expect(() => validateColorAgentResult(signed, decision)).not.toThrow();
    }
  });
  it('keeps actual night exclusion independent of the merged low-light category and mixed lighting label', async () => {
    const f = await setup(), packet = structuredClone(f.packets[0]); packet.technical.highContrast.state = 'detected';
    const signed = resign(packet), decision = result(signed, { category: 'high-contrast' });
    decision.evidence.push({ source: 'technical.highContrast.state', quoteOrValue: 'detected', supports: '反差阳性' });
    decision.semantic.lighting = 'mixed'; decision.semantic.nightContext = 'night';
    expect(() => validateColorAgentResult(signed, decision)).toThrow('非夜景');
    decision.semantic.nightContext = 'unknown'; expect(() => validateColorAgentResult(signed, decision)).toThrow();
    decision.semantic.nightContext = 'non-night'; decision.semantic.lighting = 'low-light';
    expect(() => validateColorAgentResult(signed, decision)).not.toThrow();
    decision.category = 'night'; expect(() => validateColorAgentResult(signed, decision)).not.toThrow();
    decision.semantic.lighting = 'night'; expect(() => validateColorAgentResult(signed, decision)).toThrow('nightContext');
  });
  it('uses raw portrait exclusivity and requires real timed speech for presenter without interpreting words', async () => {
    const f = await setup(), packet = structuredClone(f.packets[0]);
    for (const rotation of [90, -90]) {
      Object.assign(packet.technical.probe!, { displayWidth: 2160, displayHeight: 3840, rotationDegrees: rotation });
      const signed = resign(packet);
      expect(() => validateColorAgentResult(signed, result(signed))).toThrow('排他');
      expect(() => validateColorAgentResult(signed, result(signed, { category: 'portrait' }))).not.toThrow();
    }
    packet.technical.probe!.rotationDegrees = 0;
    let signed = resign(packet); expect(() => validateColorAgentResult(signed, result(signed, { category: 'portrait' }))).toThrow();
    expect(() => validateColorAgentResult(signed, result(signed, { category: null, status: 'needs-review', uncertainties: ['raw尺寸与旋转矛盾'] }))).not.toThrow();
    Object.assign(packet.technical.probe!, { displayWidth: 3840, displayHeight: 2160 });
    signed = resign(packet); const presenter = result(signed, { category: 'presenter' }); presenter.semantic.presenter = 'yes';
    expect(() => validateColorAgentResult(signed, presenter)).not.toThrow();
    packet.report.transcriptSegments = []; packet.report.transcript = ''; packet.colorInput.facts!.speech = {hasTranscript:false,ranges:[]}; signed = resign(packet); presenter.packetFingerprint = signed.packetFingerprint;
    expect(() => validateColorAgentResult(signed, presenter)).toThrow('语音证据');
  });
});
