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
    expect(style?.styleProfileVersion).toBe('legacy');
  });

  it('parses layered-v1 profiles with required literary, artistic, and editing technical layers', async () => {
    const workspaceRoot = await createWorkspace();
    const stylesDir = join(workspaceRoot, 'config', 'styles');

    await saveStyleSourcesConfig(workspaceRoot, {
      defaultCategory: 'layered-doc',
      categories: [{
        categoryId: 'layered-doc',
        displayName: 'Layered Doc',
        overwriteExisting: false,
        profilePath: 'layered-doc.md',
        sources: [],
      }],
    });
    await writeFile(join(stylesDir, 'layered-doc.md'), [
      '---',
      'name: Layered Doc',
      'category: layered-doc',
      'styleProfileVersion: layered-v1',
      '---',
      '# Layered Doc',
      '',
      '## 文学风格',
      '',
      'summary: 克制第一人称旁白。',
      'confidence: 0.8',
      '',
      '## 艺术风格',
      '',
      'summary: 空间辽阔，情绪克制。',
      'confidence: 0.7',
      '',
      '## 技术分析（剪辑技法）',
      '',
      'summary: 用行车镜头承担地理推进。',
      'confidence: 0.75',
      '',
    ].join('\n'), 'utf-8');

    const style = await loadStyleByCategory(stylesDir, 'layered-doc');

    expect(style.styleProfileVersion).toBe('layered-v1');
    expect(style.layers?.literary.summary).toBe('克制第一人称旁白。');
    expect(style.layers?.artistic.confidence).toBe(0.7);
    expect(style.layers?.editingTechnical.parameters.summary).toBe('用行车镜头承担地理推进。');
  });

  it('rejects incomplete layered-v1 profiles', async () => {
    const workspaceRoot = await createWorkspace();
    const stylesDir = join(workspaceRoot, 'config', 'styles');

    await saveStyleSourcesConfig(workspaceRoot, {
      defaultCategory: 'broken-doc',
      categories: [{
        categoryId: 'broken-doc',
        displayName: 'Broken Doc',
        overwriteExisting: false,
        profilePath: 'broken-doc.md',
        sources: [],
      }],
    });
    await writeFile(join(stylesDir, 'broken-doc.md'), [
      '---',
      'name: Broken Doc',
      'category: broken-doc',
      'styleProfileVersion: layered-v1',
      '---',
      '# Broken Doc',
      '',
      '## 文学风格',
      '',
      'summary: 只有文学层。',
      '',
    ].join('\n'), 'utf-8');

    await expect(loadStyleByCategory(stylesDir, 'broken-doc')).rejects.toThrow('missing required section');
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
