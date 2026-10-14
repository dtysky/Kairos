import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadEditUnitConfig, loadIngestRoots, loadProjectBriefConfig } from '../../src/store/index.js';
import { relinkResolveEditMedia } from '../../src/modules/timeline-core/resolve-rough-cut.js';
import { relinkProjectEditMedia } from '../../src/modules/timeline-core/edit-resolve-relink.js';

vi.mock('../../src/store/index.js', () => ({
  loadProject: vi.fn(async () => ({ id: 'trip', name: 'Trip' })),
  loadIngestRoots: vi.fn(async () => ({ roots: [{ id: 'camera', enabled: true, path: '/camera' }] })),
  loadProjectBriefConfig: vi.fn(async () => ({})),
  loadEditUnitConfig: vi.fn(() => { throw new Error('Project relink must not load an Edit Unit'); }),
  resolveWorkspaceProjectRoot: vi.fn(),
}));
vi.mock('../../src/modules/media/root-resolver.js', () => ({
  resolveMediaRoot: (root: { path: string }) => ({ localPath: root.path, localPathResolution: {} }),
  buildRootPathCandidates: (root: { path: string }) => [{ path: `/old${root.path}` }],
}));
vi.mock('../../src/modules/timeline-core/resolve-rough-cut.js', () => ({
  relinkResolveEditMedia: vi.fn(async () => ({
    scope: 'project', resolveProjectName: 'Trip [Edit]', createdAt: '2026-10-14T00:00:00Z',
    hostSummary: { rootSummaries: { voiceover: { relinked: 2 }, audio: { relinked: 3 } } },
  })),
}));

describe('project relink request boundary', () => {
  beforeEach(() => vi.clearAllMocks());

  it('combines all project roots in one request without edit or timeline selectors', async () => {
    vi.mocked(loadProjectBriefConfig).mockResolvedValue({
      voiceoverMedia: { path: '/voiceover' }, audioMedia: { path: '/audio' },
    } as Awaited<ReturnType<typeof loadProjectBriefConfig>>);
    const result = await relinkProjectEditMedia({ projectRoot: '/trip' });
    expect(loadEditUnitConfig).not.toHaveBeenCalled();
    expect(relinkResolveEditMedia).toHaveBeenCalledTimes(1);
    expect(vi.mocked(relinkResolveEditMedia).mock.calls[0]![0]).toEqual({
      projectId: 'trip', resolveProjectName: 'Trip [Edit]',
      roots: [
        { rootId: 'camera', localPath: '/camera', candidates: ['/camera', '/old/camera'] },
        { rootId: 'voiceover', label: '配音', localPath: '/voiceover', candidates: ['/voiceover', '/old/voiceover'] },
        { rootId: 'audio', label: '音频', localPath: '/audio', candidates: ['/audio', '/old/audio'] },
      ],
    });
    expect(result).not.toHaveProperty('editId');
    expect(result).toMatchObject({ scope: 'project', rootMappingCount: 3, hostSummary: {
      voiceover: { configured: true, skipped: false, relinked: 2 },
      audio: { configured: true, skipped: false, relinked: 3 },
    } });
  });

  it('relinks without any Edit Unit or optional external audio configuration', async () => {
    vi.mocked(loadProjectBriefConfig).mockResolvedValue({} as Awaited<ReturnType<typeof loadProjectBriefConfig>>);
    const result = await relinkProjectEditMedia({ projectRoot: '/trip' });
    expect(loadEditUnitConfig).not.toHaveBeenCalled();
    expect(result).toMatchObject({ rootMappingCount: 1, hostSummary: {
      voiceover: { configured: false, skipped: true }, audio: { configured: false, skipped: true },
    } });
  });

  it('supports an audio-only project without an ingest root or Edit Unit', async () => {
    vi.mocked(loadIngestRoots).mockResolvedValueOnce({ roots: [] } as Awaited<ReturnType<typeof loadIngestRoots>>);
    vi.mocked(loadProjectBriefConfig).mockResolvedValue({ audioMedia: { path: '/audio' } } as Awaited<ReturnType<typeof loadProjectBriefConfig>>);
    const result = await relinkProjectEditMedia({ projectRoot: '/trip' });
    expect(loadEditUnitConfig).not.toHaveBeenCalled();
    expect(result.rootMappingCount).toBe(1);
    expect(result.audioRootMappingCount).toBe(1);
  });
});
