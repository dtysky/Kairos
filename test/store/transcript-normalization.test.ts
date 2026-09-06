import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyTranscriptNormalizations,
  loadTranscriptNormalization,
  normalizeTranscriptNormalization,
  saveTranscriptNormalization,
} from '../../src/store/transcript-normalization.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('transcript normalization', () => {
  it('round-trips workspace rules and applies simultaneous longest-first replacements', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'kairos-transcript-normalization-'));
    roots.push(workspaceRoot);
    expect(await loadTranscriptNormalization(workspaceRoot)).toEqual({ schemaVersion: '1.0', rules: [] });
    const saved = await saveTranscriptNormalization(workspaceRoot, {
      schemaVersion: '1.0',
      rules: [
        { from: '我操', to: '卧槽' },
        { from: '卧槽天', to: '天啊' },
      ],
    });
    expect(await loadTranscriptNormalization(workspaceRoot)).toEqual(saved);
    expect(applyTranscriptNormalizations('我操，卧槽天！', saved)).toEqual({
      text: '卧槽，天啊！',
      appliedRules: ['我操→卧槽', '卧槽天→天啊'],
    });
  });

  it('does not cascade replacement output into another rule', () => {
    const config = normalizeTranscriptNormalization({
      schemaVersion: '1.0',
      rules: [
        { from: '我操', to: '卧槽' },
        { from: '卧槽', to: '天啊' },
      ],
    });
    expect(applyTranscriptNormalizations('我操', config).text).toBe('卧槽');
  });

  it('rejects duplicate and empty rules', () => {
    expect(() => normalizeTranscriptNormalization({
      schemaVersion: '1.0',
      rules: [{ from: '我操', to: '卧槽' }, { from: '我操', to: '天啊' }],
    })).toThrow(/source must be unique/u);
    expect(() => normalizeTranscriptNormalization({
      schemaVersion: '1.0',
      rules: [{ from: ' ', to: '卧槽' }],
    })).toThrow(/source must not be empty/u);
  });
});
