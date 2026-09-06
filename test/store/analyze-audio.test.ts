import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
  it('invalidates legacy v2 checkpoints so ASR is rerun', async () => {
    const projectRoot = await createWorkspace();
    const checkpointRoot = join(projectRoot, 'analysis', 'audio-checkpoints');
    await mkdir(checkpointRoot, { recursive: true });
    await writeFile(join(checkpointRoot, 'asset-v2.json'), JSON.stringify({
      schemaVersion: 2,
      assetId: 'asset-v2',
      selectedTranscript: {
        transcript: '旧结果',
        segments: [],
        evidence: [{ source: 'asr', value: '旧结果', confidence: 0.8 }],
        speechCoverage: 0,
        speechWindows: [],
      },
      updatedAt: new Date().toISOString(),
    }));

    await expect(loadAudioAnalysisCheckpoint(projectRoot, 'asset-v2')).resolves.toBeNull();
  });

  it('invalidates schema v3 checkpoints without the current alignment contract', async () => {
    const projectRoot = await createWorkspace();
    const checkpointRoot = join(projectRoot, 'analysis', 'audio-checkpoints');
    await mkdir(checkpointRoot, { recursive: true });
    await writeFile(join(checkpointRoot, 'asset-old-v3.json'), JSON.stringify({
      schemaVersion: 3,
      assetId: 'asset-old-v3',
      selectedTranscript: null,
      updatedAt: new Date().toISOString(),
    }));

    await expect(loadAudioAnalysisCheckpoint(projectRoot, 'asset-old-v3')).resolves.toBeNull();
  });

  it('roundtrips selected transcript and protection-audio assessment', async () => {
    const projectRoot = await createWorkspace();

    await writeAudioAnalysisCheckpoint(projectRoot, {
      assetId: 'asset-1',
      selectedTranscript: {
        rawText: 'backup hello world',
        alignedTokens: [{
          index: 0,
          startMs: 0,
          endMs: 1500,
          gapAfterMs: 0,
          text: 'backup hello world',
        }],
        segmentation: {
          status: 'completed',
          promptVersion: 'test-v1',
          attempts: 1,
        },
        transcript: 'backup hello world',
        segments: [{
          startMs: 0,
          endMs: 1500,
          text: 'backup hello world',
        }],
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
      schemaVersion: 3,
      alignmentContractVersion: 'qwen3-character-alignment-v2',
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
