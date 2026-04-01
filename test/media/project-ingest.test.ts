import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  initWorkspaceProject,
  loadAssets,
  loadIngestRoots,
  loadProjectDeviceMediaMaps,
  loadProjectDerivedTrack,
  saveDeviceProjectMap,
  writeJson,
  writeWorkspaceProjectBrief,
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
  it('refreshes project-derived-track cache during ingest', async () => {
    const workspaceRoot = await createWorkspace();
    const projectId = 'project-derived-track';
    const projectRoot = await initWorkspaceProject(workspaceRoot, projectId, 'Test Project');

    await writeFile(
      join(projectRoot, 'config/manual-itinerary.md'),
      '2026.03.31，下午四点，在北京市天安门拍摄\n',
      'utf-8',
    );

    await ingestWorkspaceProjectMedia({
      workspaceRoot,
      projectId,
      resolveTimezoneFromLocation: async location => (
        location === '北京市天安门' ? 'Asia/Shanghai' : null
      ),
      geocodeLocation: async location => (
        location === '北京市天安门'
          ? { lat: 39.909187, lng: 116.397463 }
          : null
      ),
    });

    const derivedTrack = await loadProjectDerivedTrack(projectRoot);
    expect(derivedTrack).toEqual(expect.objectContaining({
      entryCount: 1,
    }));
    expect(derivedTrack?.entries[0]).toEqual(expect.objectContaining({
      originType: 'manual-itinerary-derived',
      matchedItinerarySegmentId: 'manual-itinerary-1',
    }));
  });

  it('syncs project brief into project-local mappings before ingest', async () => {
    const workspaceRoot = await createWorkspace();
    const projectId = 'project-brief-driven';
    const projectRoot = await initWorkspaceProject(workspaceRoot, projectId, 'Test Project');
    const mediaRoot = join(workspaceRoot, 'media-root');

    await mkdir(mediaRoot, { recursive: true });
    await writeFile(join(mediaRoot, 'clip.mp4'), '');
    await writeWorkspaceProjectBrief(workspaceRoot, projectId, [
      {
        path: mediaRoot,
        description: '主机位素材',
      },
    ]);

    const result = await ingestWorkspaceProjectMedia({
      workspaceRoot,
      projectId,
    });

    expect(result.missingRoots).toEqual([]);
    expect(result.scannedRoots).toHaveLength(1);
    expect(result.scannedRoots[0]).toMatchObject({
      localPath: mediaRoot,
      scannedFileCount: 1,
    });

    const ingestRoots = await loadIngestRoots(projectRoot);
    expect(ingestRoots.roots).toHaveLength(1);

    const deviceMaps = await loadProjectDeviceMediaMaps(projectRoot);
    expect(deviceMaps.projects[projectId]?.roots).toEqual([
      {
        rootId: ingestRoots.roots[0]!.id,
        localPath: mediaRoot,
      },
    ]);

    const assets = await loadAssets(projectRoot);
    expect(assets).toHaveLength(1);
    expect(assets[0]?.ingestRootId).toBe(ingestRoots.roots[0]!.id);
  });

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
