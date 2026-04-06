import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadAudioAnalysisCheckpoint,
  removeAudioAnalysisCheckpoint,
  writeAudioAnalysisCheckpoint,
} from '../../src/store/index.js';

const workspaces: string[] = [];

afterEach(async () => {
  await Promise.all(
    workspaces.splice(0).map(path => rm(path, { recursive: true, force: true })),
  );
});

async function createWorkspace(): Promise<string> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'kairos-analyze-audio-test-'));
  workspaces.push(workspaceRoot);
  return workspaceRoot;
}

describe('audio analysis checkpoints', () => {
  it('roundtrips transcript and protection-audio assessment', async () => {
    const projectRoot = await createWorkspace();

    await writeAudioAnalysisCheckpoint(projectRoot, {
      assetId: 'asset-1',
      transcript: {
        transcript: 'hello world',
        segments: [{
          startMs: 0,
          endMs: 1200,
          text: 'hello world',
        }],
        evidence: [],
        speechCoverage: 0.42,
        speechWindows: [{
          startMs: 0,
          endMs: 1800,
          semanticKind: 'speech',
          reason: 'speech-window',
        }],
      },
      protectionTranscript: {
        transcript: 'backup hello world',
        segments: [{
          startMs: 0,
          endMs: 1500,
          text: 'backup hello world',
        }],
        evidence: [],
        speechCoverage: 0.38,
        speechWindows: [],
      },
      protectedAudio: {
        recommendedSource: 'embedded',
        comparedProtectionTranscript: false,
      },
      decisionHints: {
        protectionRecommendation: 'recommended:embedded',
        protectionTranscriptExcerpt: 'backup hello world',
      },
    });

    const loaded = await loadAudioAnalysisCheckpoint(projectRoot, 'asset-1');
    expect(loaded).toMatchObject({
      assetId: 'asset-1',
      transcript: {
        transcript: 'hello world',
        speechCoverage: 0.42,
      },
      protectionTranscript: {
        transcript: 'backup hello world',
      },
      protectedAudio: {
        recommendedSource: 'embedded',
      },
      decisionHints: {
        protectionRecommendation: 'recommended:embedded',
      },
    });

    await removeAudioAnalysisCheckpoint(projectRoot, 'asset-1');
    await expect(loadAudioAnalysisCheckpoint(projectRoot, 'asset-1')).resolves.toBeNull();
  });
});
