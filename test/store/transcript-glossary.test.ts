import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  loadTranscriptGlossary,
  loadEffectiveTranscriptGlossary,
  loadTranscriptDomainGlossary,
  normalizeTranscriptGlossary,
  saveTranscriptGlossary,
} from '../../src/store/transcript-glossary.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('transcript glossary', () => {
  it('loads the shipped photography glossary as a validated domain resource', async () => {
    const glossary = await loadTranscriptDomainGlossary(process.cwd());
    expect(glossary.entries.length).toBeGreaterThanOrEqual(100);
    expect(glossary.entries).toContainEqual({
      canonical: '丁达尔现象',
      context: '谈论云雾、洞穴、树林或逆光环境中可见光束时',
    });
  });

  it('round-trips a normalized workspace glossary', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'kairos-transcript-glossary-'));
    roots.push(workspaceRoot);
    expect(await loadTranscriptGlossary(workspaceRoot)).toEqual({ schemaVersion: '3.0', entries: [] });

    await saveTranscriptGlossary(workspaceRoot, {
      schemaVersion: '3.0',
      entries: [{
        canonical: ' 野猪嶂 ',
        context: ' 行程、路线或地点介绍时 ',
      }],
    });

    expect(await loadTranscriptGlossary(workspaceRoot)).toEqual({
      schemaVersion: '3.0',
      entries: [{ canonical: '野猪嶂', context: '行程、路线或地点介绍时' }],
    });
  });

  it('rejects duplicate canonicals and empty usage context', () => {
    expect(() => normalizeTranscriptGlossary({
      schemaVersion: '3.0',
      entries: [
        { canonical: '野猪嶂', context: '地点介绍时' },
        { canonical: '野猪嶂', context: '路线介绍时' },
      ],
    })).toThrow(/canonical must be unique/u);

    expect(() => normalizeTranscriptGlossary({
      schemaVersion: '3.0',
      entries: [{ canonical: '野猪嶂', context: '   ' }],
    })).toThrow(/context must not be empty/u);
  });

  it('migrates legacy notes into context without treating aliases as pronunciation', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'kairos-transcript-glossary-'));
    roots.push(workspaceRoot);
    await mkdir(join(workspaceRoot, 'config'), { recursive: true });
    await writeFile(join(workspaceRoot, 'config', 'transcript-glossary.json'), JSON.stringify({
      schemaVersion: '1.0',
      entries: [{ canonical: '瞬光', aliases: ['顺光'], category: 'person', note: '自我介绍、人物介绍时' }],
    }), 'utf-8');

    expect(await loadTranscriptGlossary(workspaceRoot)).toEqual({
      schemaVersion: '3.0',
      entries: [{ canonical: '瞬光', context: '自我介绍、人物介绍时' }],
    });
  });

  it('migrates v2 pronunciation away on read', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'kairos-transcript-glossary-'));
    roots.push(workspaceRoot);
    await mkdir(join(workspaceRoot, 'config'), { recursive: true });
    await writeFile(join(workspaceRoot, 'config', 'transcript-glossary.json'), JSON.stringify({
      schemaVersion: '2.0',
      entries: [{ canonical: '瞬光', pronunciation: 'shunguang', context: '自我介绍时' }],
    }), 'utf-8');

    expect(await loadTranscriptGlossary(workspaceRoot)).toEqual({
      schemaVersion: '3.0',
      entries: [{ canonical: '瞬光', context: '自我介绍时' }],
    });
  });

  it('merges read-only domain terms with workspace overrides', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'kairos-transcript-glossary-'));
    roots.push(workspaceRoot);
    await mkdir(join(workspaceRoot, 'resources', 'transcript-glossaries'), { recursive: true });
    await writeFile(join(workspaceRoot, 'resources', 'transcript-glossaries', 'photography.zh-CN.json'), JSON.stringify({
      schemaVersion: '3.0',
      entries: [
        { canonical: '丁达尔现象', context: '谈论可见光束时' },
        { canonical: '星芒', context: '谈论点光源时' },
      ],
    }), 'utf-8');
    await saveTranscriptGlossary(workspaceRoot, {
      schemaVersion: '3.0',
      entries: [
        { canonical: '丁达尔现象', context: '用户自定义的云雾拍摄语境' },
        { canonical: '桑拿鸡', context: '介绍广东菜时' },
      ],
    });

    expect((await loadTranscriptDomainGlossary(workspaceRoot)).entries).toHaveLength(2);
    expect(await loadEffectiveTranscriptGlossary(workspaceRoot)).toEqual({
      schemaVersion: '3.0',
      entries: [
        { canonical: '丁达尔现象', context: '用户自定义的云雾拍摄语境' },
        { canonical: '星芒', context: '谈论点光源时' },
        { canonical: '桑拿鸡', context: '介绍广东菜时' },
      ],
    });
  });
});
