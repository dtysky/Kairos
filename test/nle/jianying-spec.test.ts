import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import type { IKtepDoc } from '../../src/protocol/schema.js';
import { buildJianyingDraftSpec } from '../../src/modules/nle/jianying.js';

const fixtureProjectRoot = fileURLToPath(
  new URL('../../projects/tmp-current-flow-test-20260401-160735', import.meta.url),
);
const fixtureTimelinePath = join(fixtureProjectRoot, 'timeline', 'current.json');

async function loadFixtureDoc(): Promise<IKtepDoc> {
  return JSON.parse(await readFile(fixtureTimelinePath, 'utf-8')) as IKtepDoc;
}

describe('buildJianyingDraftSpec', () => {
  it('resolves relative asset paths and emits a generated subtitle track', async () => {
    const doc = await loadFixtureDoc();
    const { spec, warnings } = await buildJianyingDraftSpec(doc, {
      projectRoot: fixtureProjectRoot,
    });

    expect(spec.project.name).toBe(doc.project.name);
    expect(spec.clips).toHaveLength(doc.timeline.clips.length);
    expect(spec.subtitles).toHaveLength(doc.subtitles?.length ?? 0);
    expect(spec.tracks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'text',
        name: 'subtitles',
        relativeIndex: 999,
      }),
    ]));

    expect(spec.clips[0]?.materialPath).toMatch(/^\/Users\/dtysky\/Downloads\/kairos-test\//u);

    const dissolveClip = spec.clips.find(clip => clip.id === 'ee3b2662-9371-43d1-85e7-17aec50d9f06');
    expect(dissolveClip?.transitionOut).toEqual({
      type: 'cross-dissolve',
      name: '叠化',
      durationMs: 800,
    });

    const kenBurnsClip = spec.clips.find(clip => clip.id === '5f520886-2cef-448c-9618-e5fd331ed87d');
    expect(kenBurnsClip?.clipSettings).toBeUndefined();
    expect(warnings.some(warning => /kenBurns/iu.test(warning))).toBe(true);
  });
});
