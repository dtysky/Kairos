import { describe, expect, it } from 'vitest';
import type { IKtepDoc } from '../../src/protocol/schema.js';
import { validateKtepDoc } from '../../src/protocol/validator.js';

function buildDoc(sliceType: 'broll' | 'aerial', withSpeed: boolean): IKtepDoc {
  return {
    protocol: 'kairos.timeline',
    version: '1.0',
    project: {
      id: 'project-1',
      name: 'Validator Test',
      createdAt: '2026-04-06T00:00:00.000Z',
      updatedAt: '2026-04-06T00:00:00.000Z',
    },
    assets: [{
      id: 'asset-1',
      kind: 'video',
      sourcePath: 'clip.mp4',
      displayName: 'clip.mp4',
    }],
    slices: [{
      id: 'slice-1',
      assetId: 'asset-1',
      type: sliceType,
      sourceInMs: 0,
      sourceOutMs: 1000,
      labels: [],
      placeHints: [],
    }],
    script: [],
    timeline: {
      id: 'timeline-1',
      name: 'Validator Test',
      fps: 30,
      resolution: { width: 3840, height: 2160 },
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
        sliceId: 'slice-1',
        sourceInMs: 0,
        sourceOutMs: 1000,
        ...(withSpeed && { speed: 4 }),
        timelineInMs: 0,
        timelineOutMs: 1000,
      }],
    },
    subtitles: [],
  };
}

describe('validateKtepDoc speed whitelist', () => {
  it('rejects speed on non-drive-or-aerial clips', () => {
    const result = validateKtepDoc(buildDoc('broll', true));

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({
        rule: 'clip-speed-type',
      }),
    ]));
  });

  it('allows speed on aerial clips', () => {
    const result = validateKtepDoc(buildDoc('aerial', true));

    expect(result.ok).toBe(true);
  });
});
