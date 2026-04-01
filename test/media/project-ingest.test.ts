import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  initWorkspaceProject,
  loadAssets,
  saveDeviceProjectMap,
  writeJson,
} from '../../src/store/index.js';
import { ingestWorkspaceProjectMedia } from '../../src/modules/media/project-ingest.js';

const workspaces: string[] = [];

afterEach(async () => {
  await Promise.all(
    workspaces.splice(0).map(path => rm(path, { recursive: true, force: true })),
  );
});

async function createWorkspace(): Promise<string> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'kairos-ingest-test-'));
  workspaces.push(workspaceRoot);
  return workspaceRoot;
}

describe('ingestWorkspaceProjectMedia', () => {
  it('does not persist timezone-derived metadata during ingest', async () => {
    const workspaceRoot = await createWorkspace();
    const projectId = 'project-a';
    const projectRoot = await initWorkspaceProject(workspaceRoot, projectId, 'Test Project');
    const mediaRoot = join(workspaceRoot, 'media-root');
    const deviceMapPath = join(workspaceRoot, 'device-media-maps.json');

    await mkdir(mediaRoot, { recursive: true });
    await writeFile(join(mediaRoot, '20260331_081530.mp4'), '');

    await writeJson(join(projectRoot, 'config/ingest-roots.json'), {
      roots: [{
        id: 'root-1',
        enabled: true,
        label: 'camera-a',
        defaultTimezone: 'Pacific/Auckland',
      }],
    });

    await saveDeviceProjectMap(projectId, {
      roots: [{
        rootId: 'root-1',
        localPath: mediaRoot,
      }],
    }, deviceMapPath);

    await ingestWorkspaceProjectMedia({
      workspaceRoot,
      projectId,
      deviceMapPath,
    });

    const assets = await loadAssets(projectRoot);
    expect(assets).toHaveLength(1);

    const metadata = (assets[0]?.metadata ?? {}) as Record<string, unknown>;
    expect(metadata['effectiveTimezone']).toBeUndefined();
    expect(metadata['effectiveTimezoneSource']).toBeUndefined();
    expect(metadata['effectiveTimezonePathPrefix']).toBeUndefined();
    expect(metadata['captureOriginalTimezone']).toBeUndefined();
  });
});
