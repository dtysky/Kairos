import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
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
    const sourcePath = join(projectRoot, 'source.mp4');
    await writeFile(sourcePath, 'source-v1', 'utf-8');
    const sourceStat = await stat(sourcePath);

    await writePreparedAssetCheckpoint(projectRoot, {
      schemaVersion: 3,
      assetId: 'asset-1',
      sourceFingerprint: {
        sizeBytes: sourceStat.size,
        mtimeMs: Math.round(sourceStat.mtimeMs),
      },
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

    const loaded = await loadPreparedAssetCheckpoint(projectRoot, 'asset-1', {
      sourcePath,
      requireSampleFrames: true,
    });
    expect(loaded).toMatchObject({
      schemaVersion: 3,
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

  it('invalidates a prepared checkpoint when its source file is replaced', async () => {
    const projectRoot = await createWorkspace();
    const sourcePath = join(projectRoot, 'source.jpg');
    await writeFile(sourcePath, 'first-version', 'utf-8');
    const sourceStat = await stat(sourcePath);

    await writePreparedAssetCheckpoint(projectRoot, {
      schemaVersion: 3,
      assetId: 'asset-replaced',
      sourceFingerprint: {
        sizeBytes: sourceStat.size,
        mtimeMs: Math.round(sourceStat.mtimeMs),
      },
      shotBoundaries: [],
      shotBoundariesResolved: true,
      sampleFrames: [{ timeMs: 0, path: join(projectRoot, 'proxy.jpg') }],
      coarseSampleTimestamps: [0],
      hasAudioTrack: false,
      sourceContext: { rootNotes: [] },
    });

    await writeFile(sourcePath, 'replacement-with-a-different-size', 'utf-8');

    await expect(loadPreparedAssetCheckpoint(projectRoot, 'asset-replaced', {
      sourcePath,
      requireSampleFrames: true,
    })).resolves.toBeNull();
  });

  it('invalidates an empty prepared checkpoint before resume', async () => {
    const projectRoot = await createWorkspace();
    const sourcePath = join(projectRoot, 'source.jpg');
    await writeFile(sourcePath, 'source', 'utf-8');
    const sourceStat = await stat(sourcePath);

    await writePreparedAssetCheckpoint(projectRoot, {
      schemaVersion: 3,
      assetId: 'asset-empty',
      sourceFingerprint: {
        sizeBytes: sourceStat.size,
        mtimeMs: Math.round(sourceStat.mtimeMs),
      },
      shotBoundaries: [],
      shotBoundariesResolved: true,
      sampleFrames: [],
      coarseSampleTimestamps: [0],
      hasAudioTrack: false,
      sourceContext: { rootNotes: [] },
    });

    await expect(loadPreparedAssetCheckpoint(projectRoot, 'asset-empty', {
      sourcePath,
      requireSampleFrames: true,
    })).resolves.toBeNull();
  });

  it('invalidates a legacy v2 checkpoint when the source is newer', async () => {
    const projectRoot = await createWorkspace();
    const sourcePath = join(projectRoot, 'source.jpg');
    const checkpointPath = getPreparedAssetCheckpointPath(projectRoot, 'asset-v2-stale');
    await mkdir(join(projectRoot, 'analysis', 'prepared-assets'), { recursive: true });
    await writeFile(sourcePath, 'replacement', 'utf-8');
    await writeFile(checkpointPath, JSON.stringify({
      schemaVersion: 2,
      assetId: 'asset-v2-stale',
      shotBoundaries: [],
      shotBoundariesResolved: true,
      sampleFrames: [{ timeMs: 0, path: join(projectRoot, 'old-proxy.jpg') }],
      coarseSampleTimestamps: [0],
      hasAudioTrack: false,
      sourceContext: { rootNotes: [] },
      updatedAt: '2026-01-01T00:00:00.000Z',
    }), 'utf-8');

    await expect(loadPreparedAssetCheckpoint(projectRoot, 'asset-v2-stale', {
      sourcePath,
      requireSampleFrames: true,
    })).resolves.toBeNull();
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
