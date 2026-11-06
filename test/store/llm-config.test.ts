import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadWorkspaceLlmConfig, loadWorkspaceLlmConfigView, saveWorkspaceLlmConfig, resolveOpenAiApiKey } from '../../src/store/llm-config.js';
import { createAnalyzeVisionClient } from '../../src/modules/media/openai-vision-client.js';

const roots: string[] = [];
async function workspace() {
  const root = await mkdtemp(join(tmpdir(), 'kairos-llm-'));
  roots.push(root);
  return root;
}
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('workspace LLM config', () => {
  it('keeps local as the default and ignores project-local LLM overrides', async () => {
    const root = await workspace();
    const project = join(root, 'projects/demo');
    await mkdir(join(project, 'config'), { recursive: true });
    await writeFile(join(project, 'config/runtime.json'), JSON.stringify({ llm: { backend: 'openai' } }));
    expect(await createAnalyzeVisionClient(root, project)).toBeUndefined();
    expect(await loadWorkspaceLlmConfigView(root)).toMatchObject({ backend: 'local', openai: { model: 'gpt-6-luna', reasoningEffort: 'high' } });
  });

  it('preserves unrelated runtime fields and never returns the saved key', async () => {
    const root = await workspace();
    await mkdir(join(root, 'config'));
    await writeFile(join(root, 'config/runtime.json'), JSON.stringify({ asr: { backend: 'qwen3' }, otherSecret: 'other-private' }));
    const saved = await saveWorkspaceLlmConfig(root, { backend: 'openai', openai: { apiKey: 'test-private-key' } });
    expect(saved.openai.apiKeySource).toBe('config');
    expect(JSON.stringify(saved)).not.toContain('test-private-key');
    expect(JSON.stringify(await loadWorkspaceLlmConfigView(root))).not.toContain('private');
    const raw = JSON.parse(await readFile(join(root, 'config/runtime.json'), 'utf8'));
    expect(raw).toMatchObject({ asr: { backend: 'qwen3' }, otherSecret: 'other-private', llm: { openai: { apiKey: 'test-private-key' } } });
    if (process.platform !== 'win32') expect((await stat(join(root, 'config/runtime.json'))).mode & 0o777).toBe(0o600);
    expect(raw.llm.openai).not.toHaveProperty('apiKeyConfigured');
  });

  it('retains empty/omitted keys, replaces explicit values, clears with null and exposes environment status only', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-env-key');
    const root = await workspace();
    await saveWorkspaceLlmConfig(root, { openai: { apiKey: 'saved-one' } });
    await saveWorkspaceLlmConfig(root, { backend: 'openai', openai: { apiKey: '' } });
    expect(resolveOpenAiApiKey(await loadWorkspaceLlmConfig(root))).toBe('saved-one');
    await saveWorkspaceLlmConfig(root, { openai: { reasoningEffort: 'medium' } });
    expect(resolveOpenAiApiKey(await loadWorkspaceLlmConfig(root))).toBe('saved-one');
    await saveWorkspaceLlmConfig(root, { openai: { apiKey: 'saved-two' } });
    expect(resolveOpenAiApiKey(await loadWorkspaceLlmConfig(root))).toBe('saved-two');
    const cleared = await saveWorkspaceLlmConfig(root, { openai: { apiKey: null } });
    expect(cleared.openai).toMatchObject({ apiKeyConfigured: true, apiKeySource: 'environment', reasoningEffort: 'medium' });
    expect(resolveOpenAiApiKey(await loadWorkspaceLlmConfig(root))).toBe('test-env-key');
    expect(await readFile(join(root, 'config/runtime.json'), 'utf8')).not.toContain('test-env-key');
  });

  it('fails before creating a cloud adapter when no credential is configured', async () => {
    vi.stubEnv('OPENAI_API_KEY', '');
    const root = await workspace();
    await saveWorkspaceLlmConfig(root, { backend: 'openai' });
    await expect(createAnalyzeVisionClient(root, join(root, 'projects/demo'))).rejects.toThrow('OpenAI API Key 未配置');
  });

  it.each(['http://example.com/v1', 'https://user:private-secret@api.openai.com/v1', 'https://api.openai.com/v1?key=private-secret', 'file:///private-secret'])(
    'rejects unsafe endpoints without echoing credentials: %s', async baseUrl => {
      const root = await workspace();
      await expect(saveWorkspaceLlmConfig(root, { openai: { baseUrl } })).rejects.toThrow('LLM 配置无效');
      try { await saveWorkspaceLlmConfig(root, { openai: { baseUrl } }); }
      catch (error) { expect(String(error)).not.toContain('private-secret'); }
    },
  );

  it('redacts malformed runtime JSON errors', async () => {
    const root = await workspace();
    await mkdir(join(root, 'config'));
    await writeFile(join(root, 'config/runtime.json'), '{"llm": "private-secret');
    try { await loadWorkspaceLlmConfig(root); throw new Error('expected rejection'); }
    catch (error) { expect(String(error)).toContain('不是有效 JSON'); expect(String(error)).not.toContain('private-secret'); }
  });
});
