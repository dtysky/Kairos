import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { listEditUnitConfigs, saveEditUnitConfig } from '../../src/store/index.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture() { const root = await mkdtemp(join(tmpdir(), 'kairos-edit-units-')); roots.push(root); return root; }

describe('saved edit unit discovery', () => {
  it('lists saved episodes in order, without exposing main placeholders or shared Resolve archives', async () => {
    const root = await fixture();
    for (const editId of ['ep3-return-to-wild', 'ep1-minnan-coast', 'ep2-mountains-villages-craft']) {
      await saveEditUnitConfig(root, { editId, editRuleCategory: 'travel-vlog' });
    }
    await mkdir(join(root, 'edits/main/script'), { recursive: true });
    await mkdir(join(root, 'edits/resolve-projects/shared-archive'), { recursive: true });
    await writeFile(join(root, 'edits/main/script/script-brief.md'), 'Legacy placeholder');
    const before = await readFile(join(root, 'edits/ep1-minnan-coast/config/edit-unit.json'), 'utf8');
    expect((await listEditUnitConfigs(root)).map(unit => [unit.editId, unit.editRuleCategory])).toEqual([
      ['ep1-minnan-coast', 'travel-vlog'], ['ep2-mountains-villages-craft', 'travel-vlog'], ['ep3-return-to-wild', 'travel-vlog'],
    ]);
    expect(await readFile(join(root, 'edits/ep1-minnan-coast/config/edit-unit.json'), 'utf8')).toBe(before);
    expect(await readdir(join(root, 'edits/main'))).toEqual(['script']);
  });
  it('keeps an initialized legacy main and tolerates an absent edits directory', async () => {
    const root = await fixture();
    expect(await listEditUnitConfigs(root)).toEqual([]);
    await saveEditUnitConfig(root, { editId: 'main', editRuleCategory: 'travel-documentary' });
    expect((await listEditUnitConfigs(root))[0].editId).toBe('main');
  });
  it('surfaces identity errors rather than selecting the wrong existing unit', async () => {
    const root = await fixture();
    const unit = await saveEditUnitConfig(root, { editId: 'ep1', editRuleCategory: 'travel-vlog' });
    await writeFile(join(root, 'edits/ep1/config/edit-unit.json'), JSON.stringify({ ...unit, editId: 'ep2' }));
    await expect(listEditUnitConfigs(root)).rejects.toThrow('identity mismatch');
  });
});
