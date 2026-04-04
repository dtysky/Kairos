import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  initWorkspaceProject,
  loadProjectDerivedTrack,
  writeManualItineraryGeoCache,
  writeJson,
} from '../../src/store/index.js';
import { refreshProjectDerivedTrackCache } from '../../src/modules/media/project-derived-track.js';

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map(path => rm(path, { recursive: true, force: true })),
  );
});

async function createWorkspace(): Promise<string> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'kairos-project-derived-track-test-'));
  tempRoots.push(workspaceRoot);
  return workspaceRoot;
}

describe('project derived track cache', () => {
  it('builds sparse derived entries from embedded GPS assets', async () => {
    const workspaceRoot = await createWorkspace();
    const projectRoot = await initWorkspaceProject(workspaceRoot, 'project-a', 'Test Project');

    await writeJson(join(projectRoot, 'store/assets.json'), [
      {
        id: 'asset-1',
        kind: 'video',
        sourcePath: 'drone/clip.mp4',
        displayName: 'clip.mp4',
        capturedAt: '2026-03-31T08:15:30.000Z',
        metadata: {
          rawTags: {
            location: '+39.555555+116.666666+100.000/',
          },
        },
      },
      {
        id: 'asset-2',
        kind: 'video',
        sourcePath: 'camera/clip.mp4',
        displayName: 'clip.mp4',
        metadata: {
          rawTags: {
            location: '+39.111111+116.222222+100.000/',
          },
        },
      },
    ]);

    const cache = await refreshProjectDerivedTrackCache({ projectRoot });

    expect(cache.entryCount).toBe(1);
    expect(cache.entries[0]).toEqual(expect.objectContaining({
      originType: 'embedded-derived',
      matchKind: 'point',
      sourceAssetId: 'asset-1',
      sourcePath: 'drone/clip.mp4',
      time: '2026-03-31T08:15:30.000Z',
      lat: 39.555555,
      lng: 116.666666,
    }));

    const stored = await loadProjectDerivedTrack(projectRoot);
    expect(stored).toEqual(expect.objectContaining({
      entryCount: 1,
    }));
  });

  it('compiles manual-itinerary into derived window entries when resolvers are available', async () => {
    const workspaceRoot = await createWorkspace();
    const projectRoot = await initWorkspaceProject(workspaceRoot, 'project-b', 'Test Project');

    await writeFile(
      join(projectRoot, 'config/manual-itinerary.md'),
      '2026.03.31，下午四点，在北京市天安门拍摄\n',
      'utf-8',
    );

    const cache = await refreshProjectDerivedTrackCache({
      projectRoot,
      resolveTimezoneFromLocation: async location => (
        location === '北京市天安门' ? 'Asia/Shanghai' : null
      ),
      geocodeLocation: async location => (
        location === '北京市天安门'
          ? { lat: 39.909187, lng: 116.397463 }
          : null
      ),
    });

    expect(cache.entryCount).toBe(1);
    expect(cache.entries[0]).toEqual(expect.objectContaining({
      originType: 'manual-itinerary-derived',
      matchKind: 'window',
      matchedItinerarySegmentId: 'manual-itinerary-1',
      locationText: '北京市天安门',
      timezone: 'Asia/Shanghai',
      lat: 39.909187,
      lng: 116.397463,
      startTime: '2026-03-31T07:15:00.000Z',
      endTime: '2026-03-31T08:45:00.000Z',
    }));
  });

  it('compiles manual-itinerary from project geo cache without live resolvers', async () => {
    const workspaceRoot = await createWorkspace();
    const projectRoot = await initWorkspaceProject(workspaceRoot, 'project-c', 'Test Project');

    await writeFile(
      join(projectRoot, 'config/manual-itinerary.md'),
      '2026.03.31，下午四点，从北京市朝阳区前往北京市天安门拍摄\n',
      'utf-8',
    );
    await writeManualItineraryGeoCache(projectRoot, [
      {
        query: '北京市天安门',
        lat: 39.909187,
        lng: 116.397463,
        timezone: 'Asia/Shanghai',
        aliases: ['北京市朝阳区 / 北京市天安门'],
      },
    ]);

    const cache = await refreshProjectDerivedTrackCache({ projectRoot });

    expect(cache.entryCount).toBe(1);
    expect(cache.entries[0]).toEqual(expect.objectContaining({
      originType: 'manual-itinerary-derived',
      matchKind: 'window',
      matchedItinerarySegmentId: 'manual-itinerary-1',
      locationText: '北京市朝阳区 / 北京市天安门',
      timezone: 'Asia/Shanghai',
      lat: 39.909187,
      lng: 116.397463,
      startTime: '2026-03-31T07:15:00.000Z',
      endTime: '2026-03-31T08:45:00.000Z',
    }));
  });
});
