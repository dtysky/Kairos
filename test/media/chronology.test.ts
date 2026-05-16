import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildMediaChronology } from '../../src/modules/media/chronology.js';
import { buildProjectChronology } from '../../src/modules/media/chronology-build.js';
import {
  assertConfirmedProjectChronology,
  getAssetsPath,
  getSpansMetaPath,
  getSpansPath,
  initWorkspaceProject,
  loadChronology,
  writeJson,
} from '../../src/store/index.js';
import type { IKtepAsset, IKtepSlice } from '../../src/protocol/index.js';

describe('buildMediaChronology', () => {
  it('writes Chronology V2 assetIndex with root clock offsets', () => {
    const chronology = buildMediaChronology(
      [{
        id: 'asset-1',
        kind: 'photo',
        sourcePath: 'photo.jpg',
        displayName: 'photo.jpg',
        ingestRootId: 'root-photo',
        capturedAt: '2026-04-12T08:09:46.000Z',
        createdAt: '2026-04-12T08:09:46.000Z',
      }],
      [],
      null,
      [{
        id: 'root-photo',
        enabled: true,
        clockOffsetMs: -611_000,
      }],
      { now: '2026-04-12T09:00:00.000Z' },
    );

    expect(chronology.schemaVersion).toBe('2.0');
    expect(chronology.status).toBe('draft');
    expect(chronology.assetIndex[0]).toEqual({
      assetId: 'asset-1',
      sortCapturedAt: '2026-04-12T07:59:35.000Z',
    });
  });

  it('does not expose Pharos/source/origin fields in formal events', () => {
    const chronology = buildMediaChronology(
      [asset('asset-1')],
      [],
      null,
      [],
      {
        now: '2026-04-12T09:00:00.000Z',
        spans: [span({
          id: 'span-1',
          assetId: 'asset-1',
          type: 'shot',
          materialPatterns: ['雪山垭口'],
          grounding: {
            speechMode: 'none',
            speechValue: 'none',
            pharosRefs: [{ tripId: 'trip-1', shotId: 'shot-1' }],
            spatialEvidence: [{
              tier: 'strong',
              confidence: 0.9,
              sourceKinds: ['pharos'],
              locationText: '子梅垭口',
              pharosRef: { tripId: 'trip-1', shotId: 'shot-1' },
            }],
          },
          pharosRefs: [{ tripId: 'trip-1', shotId: 'shot-1' }],
        })],
      },
    );

    const event = chronology.events[0] as Record<string, unknown>;
    expect(event).toMatchObject({
      kind: 'event',
      title: '雪山垭口',
      location: '子梅垭口',
      spanIds: ['span-1'],
    });
    for (const forbidden of ['pharosRefs', 'origin', 'source', 'confidence', 'assetIds', 'materialChannels', 'speechAnchors']) {
      expect(event).not.toHaveProperty(forbidden);
    }
  });

  it('keeps in-car speech inside a route by default', () => {
    const chronology = buildMediaChronology(
      [asset('asset-1')],
      [],
      null,
      [],
      {
        now: '2026-04-12T09:00:00.000Z',
        spans: [
          span({ id: 'drive-1', assetId: 'asset-1', type: 'drive', sourceInMs: 0, sourceOutMs: 10_000 }),
          span({
            id: 'speech-1',
            assetId: 'asset-1',
            type: 'shot',
            sourceInMs: 11_000,
            sourceOutMs: 16_000,
            transcript: '现在还在路上，前面风景很好。',
            visualObservation: '车内自拍口播',
            materialPatterns: ['车内口播', '行车'],
            grounding: {
              speechMode: 'preferred',
              speechValue: 'informative',
              spatialEvidence: [],
              pharosRefs: [],
            },
          }),
          span({ id: 'drive-2', assetId: 'asset-1', type: 'drive', sourceInMs: 17_000, sourceOutMs: 25_000 }),
        ],
      },
    );

    expect(chronology.events).toHaveLength(1);
    expect(chronology.events[0]).toMatchObject({
      kind: 'route',
      spanIds: ['drive-1', 'speech-1', 'drive-2'],
    });
  });

  it('splits semantic route-state speech into an event', () => {
    const chronology = buildMediaChronology(
      [asset('asset-1')],
      [],
      null,
      [],
      {
        now: '2026-04-12T09:00:00.000Z',
        spans: [
          span({ id: 'drive-1', assetId: 'asset-1', type: 'drive', sourceInMs: 0, sourceOutMs: 10_000 }),
          span({
            id: 'speech-1',
            assetId: 'asset-1',
            type: 'shot',
            sourceInMs: 11_000,
            sourceOutMs: 16_000,
            transcript: '前面封路了，我们现在改线绕路去住宿点。',
            visualObservation: '车内自拍口播',
            materialPatterns: ['车内口播', '行车'],
            grounding: {
              speechMode: 'preferred',
              speechValue: 'informative',
              spatialEvidence: [],
              pharosRefs: [],
            },
          }),
          span({ id: 'drive-2', assetId: 'asset-1', type: 'drive', sourceInMs: 17_000, sourceOutMs: 25_000 }),
        ],
      },
    );

    expect(chronology.events.map(event => event.kind)).toEqual(['route', 'event', 'route']);
    expect(chronology.events[1]?.spanIds).toEqual(['speech-1']);
  });

  it('blocks legacy v1 chronology arrays on strict load', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'kairos-chronology-v1-'));
    try {
      await mkdir(join(projectRoot, 'media'), { recursive: true });
      await writeJson(join(projectRoot, 'media', 'chronology.json'), [{
        id: 'legacy-1',
        assetId: 'asset-1',
        labels: [],
        placeHints: [],
        evidence: [],
        pharosMatches: [],
      }]);

      await expect(loadChronology(projectRoot)).rejects.toThrow(/legacy v1.*Chronology V2/u);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('requires confirmed Chronology V2 for downstream gates', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'kairos-chronology-draft-'));
    try {
      await mkdir(join(projectRoot, 'media'), { recursive: true });
      await writeJson(join(projectRoot, 'media', 'chronology.json'), {
        schemaVersion: '2.0',
        status: 'draft',
        generatedAt: '2026-04-12T09:00:00.000Z',
        inputsHash: 'draft-inputs',
        assetIndex: [],
        events: [],
      });

      await expect(assertConfirmedProjectChronology(projectRoot)).rejects.toThrow(/requires confirmed Chronology V2/u);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('blocks project chronology rebuild when spans are missing or stale', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'kairos-chronology-build-'));
    try {
      const projectId = 'project-chronology-build';
      const projectRoot = await initWorkspaceProject(workspaceRoot, projectId, 'Chronology Build');
      await writeJson(getAssetsPath(projectRoot), [asset('asset-1')]);

      await expect(buildProjectChronology({ workspaceRoot, projectId }))
        .rejects.toThrow(/requires fresh spans.*span-rebuild/u);

      await writeJson(getSpansPath(projectRoot), [span({ id: 'span-1', assetId: 'asset-1' })]);
      await writeJson(getSpansMetaPath(projectRoot), {
        schemaVersion: '1.0',
        status: 'stale',
        generatedAt: '2026-04-12T09:00:00.000Z',
        inputsHash: 'stale-inputs',
        assetCount: 1,
        reportCount: 0,
        spanCount: 1,
        warnings: [],
      });

      await expect(buildProjectChronology({ workspaceRoot, projectId }))
        .rejects.toThrow(/status is stale.*span-rebuild/u);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});

function asset(id: string): IKtepAsset {
  return {
    id,
    kind: 'video',
    sourcePath: `${id}.mp4`,
    displayName: `${id}.mp4`,
    capturedAt: '2026-04-12T08:00:00.000Z',
    createdAt: '2026-04-12T08:00:00.000Z',
  };
}

function span(overrides: Partial<IKtepSlice> & Pick<IKtepSlice, 'id' | 'assetId'>): IKtepSlice {
  return {
    id: overrides.id,
    assetId: overrides.assetId,
    type: overrides.type ?? 'shot',
    semanticKind: overrides.semanticKind,
    sourceInMs: overrides.sourceInMs ?? 0,
    sourceOutMs: overrides.sourceOutMs ?? 5_000,
    transcript: overrides.transcript,
    transcriptSegments: overrides.transcriptSegments,
    visualObservation: overrides.visualObservation,
    materialPatterns: overrides.materialPatterns ?? [],
    grounding: overrides.grounding ?? {
      speechMode: 'none',
      speechValue: 'none',
      spatialEvidence: [],
      pharosRefs: [],
    },
    pharosRefs: overrides.pharosRefs,
    speechCoverage: overrides.speechCoverage,
    speedCandidate: overrides.speedCandidate,
  };
}
