import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildSpeechReviewAudioUrl,
  fetchTranscriptGlossary,
  commitSpeechTranscriptReview,
  fetchWorkspaceAsrConfig,
  resolveProjectReview,
  saveProjectSection,
  saveSpeechTranscriptReviewDraft,
  saveTranscriptGlossary,
  saveWorkspaceAsrConfig,
  startJob,
} from '../api';

afterEach(() => vi.unstubAllGlobals());

describe('Supervisor API compatibility', () => {
  it('builds a path-only speech review audio URL', () => {
    expect(buildSpeechReviewAudioUrl('trip one', 'C3289/zve1', 1020.8, 8740.2)).toBe(
      '/api/projects/trip%20one/speech-transcript-review/audio/C3289%2Fzve1?startMs=20&endMs=9741',
    );
  });

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

  it('round-trips the workspace transcript glossary endpoint', async () => {
    const glossary = { schemaVersion: '3.0', entries: [] };
    const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify(glossary), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await fetchTranscriptGlossary();
    await saveTranscriptGlossary(glossary);
    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/workspace/config/transcript-glossary');
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/workspace/config/transcript-glossary', expect.objectContaining({
      method: 'PUT',
      body: JSON.stringify(glossary),
    }));
  });

  it('submits the unified speech and transcript review in one batch', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: 'completed' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const payload = { inputsHash: 'hash', resolutions: [{ itemId: 'item-1', selection: 'rejected' }] };
    await commitSpeechTranscriptReview('trip', payload);
    expect(fetchMock).toHaveBeenCalledWith('/api/projects/trip/speech-transcript-review/commit', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify(payload),
    }));
  });

  it('persists speech review draft choices before final submission', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: 'pending-human' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const payload = { inputsHash: 'hash', resolutions: [{ itemId: 'item-1', selection: 'rejected' }] };
    await saveSpeechTranscriptReviewDraft('trip', payload);
    expect(fetchMock).toHaveBeenCalledWith('/api/projects/trip/speech-transcript-review/draft', expect.objectContaining({
      method: 'PUT',
      body: JSON.stringify(payload),
    }));
  });

  it('sends transcript finalText and glossary promotion through the existing resolve API', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 'r1' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await resolveProjectReview('trip', 'r1', { finalText: '野猪嶂', promoteToGlossary: true });
    expect(fetchMock).toHaveBeenCalledWith('/api/projects/trip/reviews/r1/resolve', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ finalText: '野猪嶂', promoteToGlossary: true }),
    }));
  });

  it('round-trips the workspace ASR backend config without changing its payload', async () => {
    const config = { backend: 'qwen3' };
    const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify(config), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await fetchWorkspaceAsrConfig();
    await saveWorkspaceAsrConfig(config);
    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/workspace/config/asr');
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/workspace/config/asr', expect.objectContaining({
      method: 'PUT',
      body: JSON.stringify(config),
    }));
  });
});
