import { afterEach, describe, expect, it, vi } from 'vitest';
import { saveProjectSection, startJob } from '../api';

afterEach(() => vi.unstubAllGlobals());

describe('Supervisor API compatibility', () => {
  it('keeps the existing job payload shape', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ jobId: 'j1' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await startJob('trip', 'ingest', { force: true });
    expect(fetchMock).toHaveBeenCalledWith('/api/jobs', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ jobType: 'ingest', projectId: 'trip', args: { force: true } }),
    }));
  });

  it('keeps section save URLs and JSON untouched', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await saveProjectSection('trip', 'project-brief', { mappings: [] });
    expect(fetchMock).toHaveBeenCalledWith('/api/projects/trip/config/project-brief', expect.objectContaining({
      method: 'PUT',
      body: JSON.stringify({ mappings: [] }),
    }));
  });
});
