import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listStyleCategories, loadStyleByCategory } from '../../src/modules/script/style-loader.js';
import { saveStyleSourcesConfig } from '../../src/store/index.js';

const workspaces: string[] = [];

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function createWorkspace(): Promise<string> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'kairos-style-loader-test-'));
  workspaces.push(workspaceRoot);
  return workspaceRoot;
}

describe('style-loader', () => {
  it('loads style profiles by resolving metadata from style-sources.json', async () => {
    const workspaceRoot = await createWorkspace();
    const stylesDir = join(workspaceRoot, 'config', 'styles');

    await saveStyleSourcesConfig(workspaceRoot, {
      defaultCategory: 'travel-doc',
      categories: [{
        categoryId: 'travel-doc',
        displayName: 'Travel Doc',
        guidancePrompt: '重点关注旅行纪录片的叙事推进。',
        overwriteExisting: false,
        profilePath: 'travel-doc.md',
        sources: [],
      }],
    });
    await writeFile(join(stylesDir, 'travel-doc.md'), [
      '---',
      'name: Travel Doc',
      'category: travel-doc',
      'guidancePrompt: 重点关注旅行纪录片的叙事推进。',
      '---',
      '# Travel Doc',
      '',
      '## 节奏阶段',
      '',
      '稳步推进。',
      '',
    ].join('\n'), 'utf-8');

    const style = await loadStyleByCategory(stylesDir, 'travel-doc');

    expect(style?.name).toBe('Travel Doc');
    expect(style?.category).toBe('travel-doc');
    expect(style?.guidancePrompt).toBe('重点关注旅行纪录片的叙事推进。');
  });

  it('fails when the requested category is not registered in style-sources.json', async () => {
    const workspaceRoot = await createWorkspace();
    const stylesDir = join(workspaceRoot, 'config', 'styles');

    await saveStyleSourcesConfig(workspaceRoot, {
      defaultCategory: 'travel-doc',
      categories: [{
        categoryId: 'travel-doc',
        displayName: 'Travel Doc',
        overwriteExisting: false,
        profilePath: 'travel-doc.md',
        sources: [],
      }],
    });
    await writeFile(join(stylesDir, 'rogue.md'), '# Rogue\n', 'utf-8');

    const categories = await listStyleCategories(stylesDir);

    await expect(loadStyleByCategory(stylesDir, 'rogue')).rejects.toThrow('not defined in');
    expect(categories.map(item => item.categoryId)).toEqual(['travel-doc']);
  });

  it('fails immediately when style-sources.json is missing', async () => {
    const workspaceRoot = await createWorkspace();
    const stylesDir = join(workspaceRoot, 'config', 'styles');

    await expect(listStyleCategories(stylesDir)).rejects.toThrow('style-sources.json');
  });
});
