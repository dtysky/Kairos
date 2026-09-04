import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getWorkspaceAsrConfigPath,
  loadWorkspaceAsrConfig,
  saveWorkspaceAsrConfig,
} from '../../src/store/asr-config.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('workspace ASR config', () => {
  it('defaults to Whisper for workspaces without an explicit config', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kairos-asr-config-'));
    roots.push(root);
    await expect(loadWorkspaceAsrConfig(root)).resolves.toMatchObject({ backend: 'whisper' });
  });

  it('stores the backend inside runtime.json without changing sibling runtime settings', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kairos-asr-config-'));
    roots.push(root);
    await mkdir(join(root, 'config'), { recursive: true });
    await writeFile(getWorkspaceAsrConfigPath(root), JSON.stringify({
      mlServerUrl: 'http://127.0.0.1:8910',
      timelineWidth: 3840,
    }));

    const saved = await saveWorkspaceAsrConfig(root, { backend: 'qwen3' });
    expect(saved).toEqual({ backend: 'qwen3' });
    await expect(loadWorkspaceAsrConfig(root)).resolves.toEqual(saved);
    const runtime = JSON.parse(await readFile(getWorkspaceAsrConfigPath(root), 'utf-8'));
    expect(runtime).toEqual({
      mlServerUrl: 'http://127.0.0.1:8910',
      timelineWidth: 3840,
      asr: { backend: 'qwen3' },
    });
  });

  it('rejects implementation fields in the user-facing ASR config', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kairos-asr-config-'));
    roots.push(root);
    await expect(saveWorkspaceAsrConfig(root, {
      backend: 'qwen3',
      language: 'Chinese',
    } as never)).rejects.toThrow();
  });
});
