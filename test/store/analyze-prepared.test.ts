import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
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
      schemaVersion: 2,
      assetId: 'asset-1',
      shotBoundaries: [],
      shotBoundariesResolved: false,
      sampleFrames: [{
        timeMs: 0,
        path: 'H:/tmp/frame-0001.jpg',
      }],
      coarseSampleTimestamps: [0, 1000, 2000],
      hasAudioTrack: true,
      sourceContext: {
        ingestRootId: 'root-1',
        rootLabel: 'camera-a',
        rootDescription: 'Main travel footage root',
        rootNotes: ['contains road-trip clips'],
      },
    });

    const loaded = await loadPreparedAssetCheckpoint(projectRoot, 'asset-1');
    expect(loaded).toMatchObject({
      schemaVersion: 2,
      assetId: 'asset-1',
      coarseSampleTimestamps: [0, 1000, 2000],
      hasAudioTrack: true,
      sourceContext: {
        ingestRootId: 'root-1',
        rootLabel: 'camera-a',
      },
    });
    expect(loaded?.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    await removePreparedAssetCheckpoint(projectRoot, 'asset-1');

    await expect(loadPreparedAssetCheckpoint(projectRoot, 'asset-1')).resolves.toBeNull();
    await expect(removePreparedAssetCheckpoint(projectRoot, 'asset-1')).resolves.toBeUndefined();
    expect(getPreparedAssetCheckpointPath(projectRoot, 'asset-1')).toContain('analysis');
  });

  it('treats old prepared checkpoint schema as stale', async () => {
    const projectRoot = await createWorkspace();
    const checkpointPath = getPreparedAssetCheckpointPath(projectRoot, 'asset-stale');
    await mkdir(join(projectRoot, 'analysis', 'prepared-assets'), { recursive: true });

    await writeFile(checkpointPath, JSON.stringify({
      assetId: 'asset-stale',
      shotBoundaries: [],
      shotBoundariesResolved: false,
      sampleFrames: [],
      coarseSampleTimestamps: [0],
      visualSummary: null,
      initialClipTypeGuess: 'broll',
      hasAudioTrack: false,
      updatedAt: '2026-04-07T00:00:00.000Z',
    }), 'utf-8');

    await expect(loadPreparedAssetCheckpoint(projectRoot, 'asset-stale')).resolves.toBeNull();
  });
});
