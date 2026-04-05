import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getFineScanCheckpointPath,
  loadFineScanCheckpoint,
  removeFineScanCheckpoint,
  writeFineScanCheckpoint,
} from '../../src/store/index.js';

const workspaces: string[] = [];

afterEach(async () => {
  await Promise.all(
    workspaces.splice(0).map(path => rm(path, { recursive: true, force: true })),
  );
});

async function createWorkspace(): Promise<string> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'kairos-analyze-fine-scan-test-'));
  workspaces.push(workspaceRoot);
  return workspaceRoot;
}

describe('fine-scan checkpoints', () => {
  it('roundtrips fine-scan prefetch state and removes it cleanly', async () => {
    const projectRoot = await createWorkspace();

    await writeFineScanCheckpoint(projectRoot, {
      assetId: 'asset-1',
      status: 'frames-ready',
      effectiveSlices: [{
        id: 'slice-1',
        assetId: 'asset-1',
        type: 'broll',
        sourceInMs: 0,
        sourceOutMs: 3000,
        labels: ['broll'],
        placeHints: ['lake'],
      }],
      keyframePlans: [{
        shotId: 'slice-1',
        startMs: 0,
        endMs: 3000,
        timestampsMs: [0, 1500, 2999],
      }],
      timestampsMs: [0, 1500, 2999],
      expectedFramePaths: [
        'H:/tmp/kf_0.jpg',
        'H:/tmp/kf_1500.jpg',
        'H:/tmp/kf_2999.jpg',
      ],
      readyFrameCount: 3,
      readyFrameBytes: 8192,
      droppedInvalidSliceCount: 0,
    });

    const loaded = await loadFineScanCheckpoint(projectRoot, 'asset-1');
    expect(loaded).toMatchObject({
      assetId: 'asset-1',
      status: 'frames-ready',
      readyFrameCount: 3,
      readyFrameBytes: 8192,
      timestampsMs: [0, 1500, 2999],
    });
    expect(loaded?.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u);

    await removeFineScanCheckpoint(projectRoot, 'asset-1');
    await expect(loadFineScanCheckpoint(projectRoot, 'asset-1')).resolves.toBeNull();
    await expect(removeFineScanCheckpoint(projectRoot, 'asset-1')).resolves.toBeUndefined();
    expect(getFineScanCheckpointPath(projectRoot, 'asset-1')).toContain('fine-scan-checkpoints');
  });
});
