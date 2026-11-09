import { afterEach, expect, it } from 'vitest';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { buildColorAgentInputView } from '../../src/modules/color/agent-input-view.js';
import { colorAgentContract, refreshColorAgentInputView, submitColorAgentClassification } from '../../src/modules/color/agent-classification.js';
import { fixture, submission } from './agent-fixtures.js';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true }))); });
async function setup() { const f = await fixture(2); dirs.push(f.workspaceRoot); return f; }
function expand(value: any, texts: string[]): any {
  if (Array.isArray(value)) return value.map(v => expand(v, texts));
  if (value && typeof value === 'object') return '$text' in value ? texts[value.$text]
    : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expand(item, texts)]));
  return value;
}

it('deduplicates exact text without losing window indexes, different descriptions, speech timing or raw orientation', async () => {
  const f = await setup();
  const text = '人物在画面中讲述桌上的食物，窗外是白天的街道。'.repeat(3);
  const p = f.packets[0]!;
  p.report.summary = text;
  p.report.transcript = text;
  p.report.transcriptSegments = [{ startMs: 200, endMs: 1800, text }];
  p.report.visualWindows = [{ status: 'recognized', sourceInMs: 100, sourceOutMs: 2000,
    semanticKind: 'speech', visualObservation: text, transcriptSegments: p.report.transcriptSegments },
  { status: 'dropped', sourceInMs: 2500, sourceOutMs: 4000, semanticKind: 'visual', visualObservation: text + '之后转向窗外。' }] as typeof p.report.visualWindows;
  p.colorInput.media.rotationDegrees = 90;
  // Pure view building does not need to stage or re-sign material facts.
  const batch = { rootId: f.root.id, batchFingerprint: 'b'.repeat(64), policyVersion: 'color-agent-v1', policyFingerprint: 'p', model: 'gpt-6.1-sol', reasoningEffort: 'high' };
  const view = buildColorAgentInputView(f.packets, batch, colorAgentContract());
  const rows = expand(view.rows, view.texts);
  const first = Object.fromEntries(view.input.columns.map((column, i) => [column, rows[0][i]]));
  expect(view.texts.filter(t => t === text)).toHaveLength(1);
  expect(first['report.summary']).toBe(text);
  expect(first['report.transcriptSegments']).toEqual([[200, 1800, text]]);
  const windows = first['report.visualWindows'].map((row: unknown[]) => Object.fromEntries(view.input.tables['report.visualWindows'].map((key, i) => [key, row[i]])));
  expect(windows[0].visualObservation).toBe(text);
  expect(windows[0].transcriptSegments).toEqual([[200, 1800, text]]);
  expect(windows[1]).toMatchObject({ status: 'dropped', sourceInMs: 2500, sourceOutMs: 4000, visualObservation: text + '之后转向窗外。' });
  expect(first['technical.probe'].rotationDegrees).toBe(0);
  expect(view.input.columns).not.toContain('colorInput.media.rotationDegrees');
  expect(JSON.stringify(view)).not.toContain(p.sourcePath);
  expect(first['technical.noise'].state).toBe('unknown');
});

it('keeps exact numeric evidence and original indexes while deferring large frame arrays', async () => {
  const f = await setup(); const p = f.packets[0]!;
  const medians = [0.2, 0.01, 0.3, 0.4, 0.5, 0.9, 0.4];
  p.technical.overview = medians.map((median, i) => ({ startMs: i * 1000, endMs: (i + 1) * 1000,
    source: { median }, display: { median, darkFraction: 1 - median, brightFraction: median } })) as typeof p.technical.overview;
  const batch = { rootId: f.root.id, batchFingerprint: 'b'.repeat(64), policyVersion: 'color-agent-v1', policyFingerprint: 'p', model: 'gpt-6.1-sol', reasoningEffort: 'high' };
  const view = buildColorAgentInputView([p], batch, colorAgentContract());
  const row = expand(view.rows[0], view.texts);
  const samples = row[view.input.columns.indexOf('overviewSamples')];
  expect(samples.map((s: number[]) => s[0])).toEqual([0, 1, 3, 5, 6]);
  for (const s of samples) expect(s.slice(1, 4)).toEqual([p.technical.overview[s[0]]!.startMs, p.technical.overview[s[0]]!.endMs, medians[s[0]]]);
  expect(view.input.columns).not.toContain('technical.overview');
  expect(row[view.input.columns.indexOf('technical.highContrast')]).toEqual(p.technical.highContrast);
});

it('stages the default reading view and refreshes it without changing accepted decisions, packet or policy', async () => {
  const f = await setup(); const value = await submission(f.projectRoot, f.root.id, f.packets);
  await submitColorAgentClassification(f.projectRoot, f.root.id, value);
  const dir = join(f.projectRoot, 'store/color-agent/batches', value.batchFingerprint);
  const acceptedPath = join(f.projectRoot, 'store/color-classifications.json');
  const before = await readFile(acceptedPath, 'utf8');
  const packetPath = join(f.projectRoot, 'store/color-agent/packets', `${f.packets[0]!.packetFingerprint}.json`);
  const packet = await readFile(packetPath, 'utf8');
  const originalView = await readFile(join(dir, 'agent-input-v2.json'), 'utf8');
  const view = await refreshColorAgentInputView(f.projectRoot, f.root.id, value.batchFingerprint);
  expect(view.count).toBe(2);
  expect(await readFile(view.inputPath, 'utf8')).toBe(originalView);
  expect(await readFile(acceptedPath, 'utf8')).toBe(before);
  expect(await readFile(packetPath, 'utf8')).toBe(packet);
  expect(await readFile(view.handoffPath, 'utf8')).toContain('默认只读');
  await expect(refreshColorAgentInputView(f.projectRoot, 'other', value.batchFingerprint)).rejects.toThrow('batch');
});
