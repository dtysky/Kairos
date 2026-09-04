import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  loadTranscriptGlossary,
  normalizeTranscriptGlossary,
  saveTranscriptGlossary,
} from '../../src/store/transcript-glossary.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('transcript glossary', () => {
  it('round-trips a normalized workspace glossary', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'kairos-transcript-glossary-'));
    roots.push(workspaceRoot);
    expect(await loadTranscriptGlossary(workspaceRoot)).toEqual({ schemaVersion: '2.0', entries: [] });

    await saveTranscriptGlossary(workspaceRoot, {
      schemaVersion: '2.0',
      entries: [{
        canonical: ' 野猪嶂 ',
        pronunciation: ' yě zhū zhàng ',
        context: ' 行程、路线或地点介绍时 ',
      }],
    });

    expect(await loadTranscriptGlossary(workspaceRoot)).toEqual({
      schemaVersion: '2.0',
      entries: [{ canonical: '野猪嶂', pronunciation: 'yě zhū zhàng', context: '行程、路线或地点介绍时' }],
    });
  });

  it('rejects duplicate canonicals and empty usage context', () => {
    expect(() => normalizeTranscriptGlossary({
      schemaVersion: '2.0',
      entries: [
        { canonical: '野猪嶂', context: '地点介绍时' },
        { canonical: '野猪嶂', context: '路线介绍时' },
      ],
    })).toThrow(/canonical must be unique/u);

    expect(() => normalizeTranscriptGlossary({
      schemaVersion: '2.0',
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
      schemaVersion: '2.0',
      entries: [{ canonical: '瞬光', context: '自我介绍、人物介绍时' }],
    });
  });
});
