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

    const dissolveClip = spec.clips.find(clip => clip.transitionOut?.type === 'cross-dissolve');
    expect(dissolveClip?.transitionOut).toEqual({
      type: 'cross-dissolve',
      name: '叠化',
      durationMs: 800,
    });

    const kenBurnsClip = spec.clips.find(clip => clip.id === '5f520886-2cef-448c-9618-e5fd331ed87d');
    expect(kenBurnsClip?.clipSettings).toBeUndefined();
    expect(warnings.some(warning => /kenBurns/iu.test(warning))).toBe(true);
  });

  it('maps muted KTEP clips to zero-volume Jianying segments', async () => {
    const doc: IKtepDoc = {
      protocol: 'kairos.timeline',
      version: '1.0',
      project: {
        id: 'project-1',
        name: 'Muted Spec Test',
        createdAt: '2026-04-02T00:00:00.000Z',
        updatedAt: '2026-04-02T00:00:00.000Z',
      },
      assets: [{
        id: 'asset-1',
        kind: 'video',
        sourcePath: '/tmp/muted-spec-test.mp4',
        displayName: 'muted-spec-test.mp4',
      }],
      slices: [],
      script: [],
      timeline: {
        id: 'timeline-1',
        name: 'Muted Timeline',
        fps: 30,
        resolution: {
          width: 3840,
          height: 2160,
        },
        tracks: [{
          id: 'track-1',
          kind: 'video',
          role: 'primary',
          index: 0,
        }],
        clips: [{
          id: 'clip-1',
          trackId: 'track-1',
          assetId: 'asset-1',
          timelineInMs: 0,
          timelineOutMs: 1000,
          muteAudio: true,
        }],
      },
      subtitles: [],
    };

    const { spec } = await buildJianyingDraftSpec(doc);

    expect(spec.clips[0]).toMatchObject({
      volume: 0,
    });
  });
});
