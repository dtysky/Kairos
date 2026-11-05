import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadOrBuildProjectPharosContext, buildProjectPharosAssetStatus } from '../src/modules/pharos/context.js';
import { loadProjectBriefConfig, saveProjectBriefConfig } from '../src/store/workspace-config.js';
import { parseProjectBrief } from '../src/store/project-brief.js';

const workspaces: string[] = [];
afterEach(async () => {
  await Promise.all(workspaces.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const workspace = await mkdtemp(join(tmpdir(), 'kairos-pharos-link-'));
  workspaces.push(workspace);
  const projectRoot = join(workspace, 'kairos');
  const sourcePath = join(workspace, 'pharos', 'trip-1');
  await mkdir(join(projectRoot, 'config'), { recursive: true });
  await mkdir(join(sourcePath, 'gpx'), { recursive: true });
  const plan = { $schema: 'pharos/plan/3.0', trip_id: 'trip-1', title: 'Linked trip', days: [] };
  await writeFile(join(sourcePath, 'plan.json'), JSON.stringify(plan));
  await writeFile(join(sourcePath, 'gpx', 'day1.gpx'), '<gpx><trk><trkseg><trkpt lat="23" lon="117"><time>2026-09-25T00:00:00Z</time></trkpt></trkseg></trk></gpx>');
  await saveProjectBriefConfig(projectRoot, { name: 'Test', mappings: [], pharos: { sourcePath, includedTripIds: ['trip-1'] }, materialPatternPhrases: [] });
  return { projectRoot, sourcePath, plan };
}

describe('linked Pharos directory', () => {
  it('reads a direct trip and GPS, exposes research location and preserves source files', async () => {
    const { projectRoot, sourcePath } = await fixture();
    const before = await readFile(join(sourcePath, 'plan.json'), 'utf8');
    const context = await loadOrBuildProjectPharosContext({ projectRoot, includedTripIds: ['trip-1'] });
    expect(context.status).toBe('success');
    expect(context.trips[0]?.sourcePath).toBe(sourcePath);
    expect(context.gpxFiles[0]?.path).toBe(join(sourcePath, 'gpx', 'day1.gpx'));
    expect(buildProjectPharosAssetStatus(context, projectRoot).rootPath).toBe(sourcePath);
    expect(await readFile(join(sourcePath, 'plan.json'), 'utf8')).toBe(before);
    expect((await readdir(sourcePath)).sort()).toEqual(['gpx', 'plan.json']);
    await expect(readdir(join(projectRoot, 'pharos'))).rejects.toMatchObject({ code: 'ENOENT' });
    await writeFile(join(sourcePath, 'field-guide.json'), '{"revision":1}');
    const cached = await loadOrBuildProjectPharosContext({ projectRoot, includedTripIds: ['trip-1'] });
    expect(cached.sourceFingerprint).toBe(context.sourceFingerprint);
    expect(JSON.parse(await readFile(join(cached.trips[0]!.sourcePath!, 'field-guide.json'), 'utf8'))).toEqual({ revision: 1 });
  });

  it('refreshes canonical data on file changes and directory changes', async () => {
    const { projectRoot, sourcePath, plan } = await fixture();
    const first = await loadOrBuildProjectPharosContext({ projectRoot });
    await writeFile(join(sourcePath, 'plan.json'), JSON.stringify({ ...plan, title: 'Updated linked trip' }));
    const second = await loadOrBuildProjectPharosContext({ projectRoot });
    expect(second.trips[0]?.title).toBe('Updated linked trip');
    expect(second.sourceFingerprint).not.toBe(first.sourceFingerprint);
    const otherPath = join(sourcePath, '..', 'trip-copy');
    await mkdir(otherPath);
    await writeFile(join(otherPath, 'plan.json'), JSON.stringify(plan));
    const config = await loadProjectBriefConfig(projectRoot);
    await saveProjectBriefConfig(projectRoot, { ...config, pharos: { ...config.pharos!, sourcePath: otherPath } });
    const third = await loadOrBuildProjectPharosContext({ projectRoot });
    expect(third.trips[0]?.sourcePath).toBe(otherPath);
    expect(third.sourceFingerprint).not.toBe(second.sourceFingerprint);
  });

  it('supports a collection and enforces included trip selection', async () => {
    const { projectRoot, sourcePath } = await fixture();
    const config = await loadProjectBriefConfig(projectRoot);
    await saveProjectBriefConfig(projectRoot, { ...config, pharos: { sourcePath: join(sourcePath, '..'), includedTripIds: ['trip-1'] } });
    expect((await loadOrBuildProjectPharosContext({ projectRoot, includedTripIds: ['trip-1'] })).status).toBe('success');
    expect((await loadOrBuildProjectPharosContext({ projectRoot, includedTripIds: ['missing-trip'] })).status).toBe('failure');
  });

  it('reports an unavailable explicit source without creating it or using a local mirror', async () => {
    const { projectRoot, sourcePath } = await fixture();
    const missing = join(sourcePath, 'unavailable');
    const config = await loadProjectBriefConfig(projectRoot);
    await saveProjectBriefConfig(projectRoot, { ...config, pharos: { sourcePath: missing, includedTripIds: [] } });
    const result = await loadOrBuildProjectPharosContext({ projectRoot });
    expect(result.status).toBe('failure');
    expect(result.errors[0]).toContain(missing);
    await expect(readdir(missing)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('round-trips sourcePath through JSON and markdown with an empty trip filter', async () => {
    const { projectRoot, sourcePath } = await fixture();
    const config = await loadProjectBriefConfig(projectRoot);
    await saveProjectBriefConfig(projectRoot, { ...config, pharos: { sourcePath, includedTripIds: [] } });
    expect((await loadProjectBriefConfig(projectRoot)).pharos).toEqual({ sourcePath, includedTripIds: [] });
    const markdown = await readFile(join(projectRoot, 'config', 'project-brief.md'), 'utf8');
    expect(parseProjectBrief(markdown).pharos).toEqual({ sourcePath, includedTripIds: [] });
  });
});
