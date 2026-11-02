import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initWorkspaceProject, saveProjectBriefConfig, loadProjectBriefConfig, loadIngestRoots, saveIngestRoots } from '../../src/store/index.js';
import { projectBriefAffectsAnalysis } from '../../src/store/project-root-truth.js';
import { syncProjectExtraMedia } from '../../src/modules/timeline-core/extra-media.js';
import { syncResolveRoughCutMedia } from '../../src/modules/timeline-core/resolve-rough-cut.js';
import { scanDirectory } from '../../src/modules/media/scanner.js';

vi.mock('../../src/modules/timeline-core/resolve-rough-cut.js', () => ({ syncResolveRoughCutMedia: vi.fn(async input => ({
  resolveProjectName: input.resolveProjectName, namespace: input.namespace, createdAt: new Date().toISOString(),
  hostSummary: { imported: input.clips.length, reused: 0 },
})) }));
const workspaces: string[] = [];
afterEach(async () => { vi.clearAllMocks(); await Promise.all(workspaces.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

async function setup() {
  const workspace = await mkdtemp(join(tmpdir(), 'extra-media-test-')); workspaces.push(workspace);
  const projectRoot = await initWorkspaceProject(workspace, 'trip', 'Trip');
  const media = join(workspace, 'extra'); await mkdir(join(media, 'day1'), { recursive: true });
  return { workspace, projectRoot, media };
}

describe('extra manual media', () => {
  it('roundtrips mappings without treating extra-only changes as analysis inputs', async () => {
    const { projectRoot, media } = await setup();
    const before = await loadProjectBriefConfig(projectRoot);
    await saveProjectBriefConfig(projectRoot, { ...before, extraMedia: { path: '/other-device/extra', alternatePaths: [{ path: media }] } });
    await saveIngestRoots(projectRoot, await loadIngestRoots(projectRoot));
    const after = await loadProjectBriefConfig(projectRoot);
    expect(after.extraMedia).toMatchObject({ rootId: 'extra', path: '/other-device/extra', alternatePaths: [{ path: media }] });
    expect(projectBriefAffectsAnalysis(before, after)).toBe(false);
    expect(projectBriefAffectsAnalysis(after, { ...after, name: 'Changed' })).toBe(true);
    expect(projectBriefAffectsAnalysis(after, { ...after, extraMedia: undefined })).toBe(false);
    expect(await readFile(join(projectRoot, 'config/project-brief.md'), 'utf8')).toContain('## 额外素材（仅供手动剪辑）');
  });

  it('imports mixed files via readable alternate paths without analyzed indexes or modifying review artifacts', async () => {
    const { projectRoot, media } = await setup();
    for (const file of ['video.mp4', 'photo.jpg', 'sound.wav', 'notes.txt']) await writeFile(join(media, 'day1', file), 'fixture');
    await saveProjectBriefConfig(projectRoot, { name: 'Trip', mappings: [], materialPatternPhrases: [], extraMedia: { path: '/missing-device/extra', alternatePaths: [{ path: media }] } });
    const sentinel = join(projectRoot, 'store/spans.meta.json'); await writeFile(sentinel, '{"status":"pending-speech-review"}');
    await syncProjectExtraMedia({ projectRoot, jobId: 'extra-1' });
    const request = vi.mocked(syncResolveRoughCutMedia).mock.calls[0]![0];
    expect(request).toMatchObject({ namespace: '额外素材', mode: 'extra-media', resolveProjectName: 'Trip [Edit]' });
    expect(request.clips.map(clip => clip.assetKind).sort()).toEqual(['audio', 'photo', 'video']);
    expect(request.clips.every(clip => clip.sourceAbsolutePath.startsWith(media) && clip.rawRelativePath.startsWith('day1/'))).toBe(true);
    expect(await readFile(sentinel, 'utf8')).toBe('{"status":"pending-speech-review"}');
    expect(JSON.parse(await readFile(join(projectRoot, '.tmp/resolve-extra-media-sync/progress.json'), 'utf8'))).toMatchObject({
      status: 'succeeded', current: 3, total: 3, extra: { jobId: 'extra-1', imported: 3 },
    });
  });

  it('excludes nested extra directories, including when the scan root itself is extra', async () => {
    const { media } = await setup();
    await writeFile(join(media, 'regular.mp4'), ''); await writeFile(join(media, 'day1', 'extra.mp4'), '');
    expect((await scanDirectory(media, { excludeSubtrees: [join(media, 'day1')] })).map(f => f.path)).toEqual([join(media, 'regular.mp4')]);
    expect(await scanDirectory(media, { excludeSubtrees: [media] })).toEqual([]);
  });

  it('fails before touching Resolve when the configured root is unavailable', async () => {
    const { projectRoot } = await setup();
    await saveProjectBriefConfig(projectRoot, { name: 'Trip', mappings: [], materialPatternPhrases: [], extraMedia: { path: '/missing-device/extra' } });
    await expect(syncProjectExtraMedia({ projectRoot })).rejects.toThrow('额外素材目录不可读');
    expect(syncResolveRoughCutMedia).not.toHaveBeenCalled();
  });
});
