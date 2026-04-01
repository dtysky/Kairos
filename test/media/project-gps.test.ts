import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getProjectGpsMergedPath,
  getProjectGpsTracksRoot,
  initWorkspaceProject,
  listProjectGpsTrackPaths,
  loadProjectGpsMerged,
} from '../../src/store/index.js';
import {
  getDefaultProjectGpxPaths,
  importProjectGpxTracks,
  resolveProjectGpxPaths,
} from '../../src/modules/media/project-gps.js';

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map(path => rm(path, { recursive: true, force: true })),
  );
});

async function createWorkspace(): Promise<string> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'kairos-project-gps-test-'));
  tempRoots.push(workspaceRoot);
  return workspaceRoot;
}

async function writeExternalGpx(name: string, content: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'kairos-external-gpx-'));
  tempRoots.push(root);
  const filePath = join(root, name);
  await writeFile(filePath, content, 'utf-8');
  return filePath;
}

describe('project GPS management', () => {
  it('imports GPX tracks into project store and builds merged cache', async () => {
    const workspaceRoot = await createWorkspace();
    const projectRoot = await initWorkspaceProject(workspaceRoot, 'project-a', 'Test Project');
    const externalGpxPath = await writeExternalGpx('route-a.gpx', [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<gpx version="1.1" creator="test">',
      '  <trk><trkseg>',
      '    <trkpt lat="39.111111" lon="116.222222"><time>2026-03-31T08:15:00Z</time></trkpt>',
      '    <trkpt lat="39.222222" lon="116.333333"><time>2026-03-31T08:16:00Z</time></trkpt>',
      '  </trkseg></trk>',
      '</gpx>',
    ].join('\n'));

    await importProjectGpxTracks({
      projectRoot,
      sourcePaths: [externalGpxPath],
    });

    const trackPaths = await listProjectGpsTrackPaths(projectRoot);
    const merged = await loadProjectGpsMerged(projectRoot);

    expect(trackPaths).toHaveLength(1);
    expect(trackPaths[0]).toBe(join(getProjectGpsTracksRoot(projectRoot), 'route-a.gpx'));
    expect(merged).toEqual(expect.objectContaining({
      schemaVersion: '1.0',
      trackCount: 1,
      pointCount: 2,
    }));
    expect(merged?.tracks).toEqual([
      expect.objectContaining({
        relativePath: 'gps/tracks/route-a.gpx',
        pointCount: 2,
      }),
    ]);
    expect(merged?.points[0]).toEqual(expect.objectContaining({
      lat: 39.111111,
      lng: 116.222222,
      time: '2026-03-31T08:15:00Z',
      sourcePath: 'gps/tracks/route-a.gpx',
    }));
    expect(await getDefaultProjectGpxPaths(projectRoot)).toEqual([
      getProjectGpsMergedPath(projectRoot),
    ]);
  });

  it('falls back to raw project tracks when merged cache is missing', async () => {
    const workspaceRoot = await createWorkspace();
    const projectRoot = await initWorkspaceProject(workspaceRoot, 'project-b', 'Test Project');
    const trackPath = join(getProjectGpsTracksRoot(projectRoot), 'route-b.gpx');

    await writeFile(trackPath, [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<gpx version="1.1" creator="test">',
      '  <trk><trkseg>',
      '    <trkpt lat="39.111111" lon="116.222222"><time>2026-03-31T08:15:00Z</time></trkpt>',
      '  </trkseg></trk>',
      '</gpx>',
    ].join('\n'), 'utf-8');

    expect(await getDefaultProjectGpxPaths(projectRoot)).toEqual([trackPath]);
  });

  it('uses explicit gpx paths instead of project defaults when provided', async () => {
    const workspaceRoot = await createWorkspace();
    const projectRoot = await initWorkspaceProject(workspaceRoot, 'project-c', 'Test Project');
    const explicitPath = await writeExternalGpx('override.gpx', [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<gpx version="1.1" creator="test"></gpx>',
    ].join('\n'));

    expect(await resolveProjectGpxPaths({
      projectRoot,
      gpxPaths: [explicitPath],
    })).toEqual([explicitPath]);
  });
});
