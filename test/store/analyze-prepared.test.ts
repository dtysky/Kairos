import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getPreparedAssetCheckpointPath,
  loadPreparedAssetCheckpoint,
  removePreparedAssetCheckpoint,
  writePreparedAssetCheckpoint,
} from '../../src/store/index.js';

const workspaces: string[] = [];

afterEach(async () => {
  await Promise.all(
    workspaces.splice(0).map(path => rm(path, { recursive: true, force: true })),
  );
});

async function createWorkspace(): Promise<string> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'kairos-analyze-prepared-test-'));
  workspaces.push(workspaceRoot);
  return workspaceRoot;
}

describe('prepared asset checkpoints', () => {
  it('roundtrips a prepared coarse checkpoint and removes it cleanly', async () => {
    const projectRoot = await createWorkspace();

    await writePreparedAssetCheckpoint(projectRoot, {
      assetId: 'asset-1',
      shotBoundaries: [],
      shotBoundariesResolved: false,
      sampleFrames: [{
        timeMs: 0,
        path: 'H:/tmp/frame-0001.jpg',
      }],
      coarseSampleTimestamps: [0, 1000, 2000],
      visualSummary: {
        sceneType: 'landscape',
        subjects: ['mountain'],
        mood: 'calm',
        placeHints: ['new zealand'],
        narrativeRole: 'establishing',
        description: 'A wide scenic view.',
        evidence: [],
      },
      initialClipTypeGuess: 'broll',
      hasAudioTrack: true,
    });

    const loaded = await loadPreparedAssetCheckpoint(projectRoot, 'asset-1');
    expect(loaded).toMatchObject({
      assetId: 'asset-1',
      coarseSampleTimestamps: [0, 1000, 2000],
      initialClipTypeGuess: 'broll',
      hasAudioTrack: true,
    });
    expect(loaded?.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    await removePreparedAssetCheckpoint(projectRoot, 'asset-1');

    await expect(loadPreparedAssetCheckpoint(projectRoot, 'asset-1')).resolves.toBeNull();
    await expect(removePreparedAssetCheckpoint(projectRoot, 'asset-1')).resolves.toBeUndefined();
    expect(getPreparedAssetCheckpointPath(projectRoot, 'asset-1')).toContain('analysis');
  });
});
