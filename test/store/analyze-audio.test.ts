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
  it('roundtrips selected transcript and protection-audio assessment', async () => {
    const projectRoot = await createWorkspace();

    await writeAudioAnalysisCheckpoint(projectRoot, {
      assetId: 'asset-1',
      selectedTranscript: {
        transcript: 'backup hello world',
        segments: [{
          startMs: 0,
          endMs: 1500,
          text: 'backup hello world',
        }],
        evidence: [],
        speechCoverage: 0.38,
        speechWindows: [{
          startMs: 0,
          endMs: 1800,
          semanticKind: 'speech',
          reason: 'speech-window',
        }],
      },
      selectedTranscriptSource: 'protection',
      embeddedHealth: {
        meanVolumeDb: -38,
        score: 0.45,
      },
      protectionHealth: {
        meanVolumeDb: -22,
        speechCoverage: 0.38,
        score: 0.78,
      },
      protectedAudio: {
        recommendedSource: 'protection',
        comparedProtectionTranscript: false,
      },
      decisionHints: {
        protectionRecommendation: 'recommended:protection',
        protectionTranscriptExcerpt: 'backup hello world',
      },
    });

    const loaded = await loadAudioAnalysisCheckpoint(projectRoot, 'asset-1');
    expect(loaded).toMatchObject({
      assetId: 'asset-1',
      schemaVersion: 2,
      selectedTranscript: {
        transcript: 'backup hello world',
        speechCoverage: 0.38,
      },
      selectedTranscriptSource: 'protection',
      embeddedHealth: {
        score: 0.45,
      },
      protectionHealth: {
        score: 0.78,
      },
      protectedAudio: {
        recommendedSource: 'protection',
      },
      decisionHints: {
        protectionRecommendation: 'recommended:protection',
      },
    });

    await removeAudioAnalysisCheckpoint(projectRoot, 'asset-1');
    await expect(loadAudioAnalysisCheckpoint(projectRoot, 'asset-1')).resolves.toBeNull();
  });
});
