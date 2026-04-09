import { describe, expect, it } from 'vitest';
import { buildAssetCoarseReport } from '../../src/modules/media/asset-report.js';

describe('buildAssetCoarseReport', () => {
  it('writes explicit direct-path decisions for directly materialized assets', () => {
    const report = buildAssetCoarseReport({
      asset: {
        id: 'asset-photo',
        kind: 'photo',
        sourcePath: 'photo.jpg',
        displayName: 'photo.jpg',
      },
      plan: {
        assetId: 'asset-photo',
        clipType: 'broll',
        densityScore: 0.1,
        samplingProfile: 'sparse',
        coarseSampleCount: 0,
        baseSampleIntervalMs: 0,
        interestingWindows: [],
        vlmMode: 'none',
        targetBudget: 'coarse',
        shouldFineScan: false,
        fineScanMode: 'skip',
      },
      keepDecision: 'keep',
      materializationPath: 'direct',
      summary: '海边照片',
      labels: ['photo'],
      placeHints: ['Auckland'],
    });

    expect(report.keepDecision).toBe('keep');
    expect(report.materializationPath).toBe('direct');
    expect(report.fineScanMode).toBeUndefined();
  });

  it('writes explicit fine-scan decisions for retained video assets', () => {
    const report = buildAssetCoarseReport({
      asset: {
        id: 'asset-video',
        kind: 'video',
        sourcePath: 'clip.mp4',
        displayName: 'clip.mp4',
      },
      plan: {
        assetId: 'asset-video',
        clipType: 'drive',
        densityScore: 0.7,
        samplingProfile: 'balanced',
        coarseSampleCount: 4,
        baseSampleIntervalMs: 2_000,
        interestingWindows: [{
          startMs: 0,
          endMs: 8_000,
          reason: 'speech-window',
        }],
        vlmMode: 'multi-image',
        targetBudget: 'standard',
        shouldFineScan: true,
        fineScanMode: 'windowed',
      },
      keepDecision: 'keep',
      materializationPath: 'fine-scan',
      fineScanMode: 'windowed',
      summary: '车内行进镜头',
      labels: ['drive'],
      placeHints: ['Route'],
    });

    expect(report.keepDecision).toBe('keep');
    expect(report.materializationPath).toBe('fine-scan');
    expect(report.fineScanMode).toBe('windowed');
  });

  it('marks audio assets as dropped from visual materialization', () => {
    const report = buildAssetCoarseReport({
      asset: {
        id: 'asset-audio',
        kind: 'audio',
        sourcePath: 'track.wav',
        displayName: 'track.wav',
      },
      plan: {
        assetId: 'asset-audio',
        clipType: 'unknown',
        densityScore: 0,
        samplingProfile: 'sparse',
        coarseSampleCount: 0,
        baseSampleIntervalMs: 0,
        interestingWindows: [],
        vlmMode: 'none',
        targetBudget: 'coarse',
        shouldFineScan: false,
        fineScanMode: 'skip',
      },
      keepDecision: 'drop',
      summary: '外录音频',
      labels: ['audio'],
    });

    expect(report.keepDecision).toBe('drop');
    expect(report.materializationPath).toBeUndefined();
    expect(report.fineScanMode).toBeUndefined();
  });
});
