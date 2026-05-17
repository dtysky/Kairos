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
import type { IProjectPharosContext, IKtepAsset, IKtepSlice } from '../../src/protocol/index.js';

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

  it('keeps transcript route-state phrases as auxiliary evidence only', () => {
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

    expect(chronology.events.map(event => event.kind)).toEqual(['route']);
    expect(chronology.events[0]?.spanIds).toEqual(['drive-1', 'speech-1', 'drive-2']);
  });

  it('assigns any span type directly to a Pharos point event when most of the span overlaps its actual window', () => {
    const chronology = buildMediaChronology(
      [
        asset('asset-drive'),
        asset('asset-aerial'),
        asset('asset-photo', { kind: 'photo' }),
      ],
      [],
      null,
      [],
      {
        now: '2026-04-12T09:00:00.000Z',
        pharosContext: pharosContext([
          pharosShot({
            shotId: 'yak-road-wait',
            type: 'event',
            location: '牦牛过路等待点',
            description: '车队和航拍都在同一个临时等待点附近记录。',
            actualTimeStart: '2026-04-12T08:00:30.000Z',
            actualTimeEnd: '2026-04-12T08:03:30.000Z',
          }),
        ]),
        spans: [
          span({
            id: 'drive-inside-point',
            assetId: 'asset-drive',
            type: 'drive',
            sourceInMs: 0,
            sourceOutMs: 120_000,
          }),
          span({
            id: 'aerial-inside-point',
            assetId: 'asset-aerial',
            type: 'aerial',
            sourceInMs: 30_000,
            sourceOutMs: 150_000,
          }),
          span({
            id: 'photo-inside-point',
            assetId: 'asset-photo',
            type: 'photo',
            sourceInMs: 90_000,
            sourceOutMs: 90_000,
          }),
        ],
      },
    );

    expect(chronology.events).toHaveLength(1);
    expect(chronology.events[0]).toMatchObject({
      kind: 'event',
      title: '牦牛过路等待点',
      location: '牦牛过路等待点',
      spanIds: ['drive-inside-point', 'aerial-inside-point', 'photo-inside-point'],
    });
    expect(chronology.events[0]?.id).toMatch(/^event-pharos-/u);
    expect(chronology.events[0] as Record<string, unknown>).not.toHaveProperty('pharosRefs');
  });

  it('does not directly assign spans to Pharos continuous shots before GPS/type aggregation', () => {
    const chronology = buildMediaChronology(
      [asset('asset-drive')],
      [],
      null,
      [],
      {
        now: '2026-04-12T09:00:00.000Z',
        pharosContext: pharosContext([
          pharosShot({
            shotId: 'continuous-road',
            type: 'continuous',
            location: '连续山路',
            description: '一段连续行车记录。',
            actualTimeStart: '2026-04-12T08:00:00.000Z',
            actualTimeEnd: '2026-04-12T08:10:00.000Z',
          }),
        ]),
        projectGpsPoints: [
          point('2026-04-12T08:00:00.000Z', 30.0000, 100.0000),
          point('2026-04-12T08:01:00.000Z', 30.0100, 100.0000),
        ],
        spans: [
          span({
            id: 'drive-continuous',
            assetId: 'asset-drive',
            type: 'drive',
            sourceInMs: 0,
            sourceOutMs: 60_000,
          }),
        ],
      },
    );

    expect(chronology.events).toHaveLength(1);
    expect(chronology.events[0]).toMatchObject({
      kind: 'route',
      spanIds: ['drive-continuous'],
    });
    expect(chronology.events[0]?.id).toMatch(/^route-/u);
  });

  it('merges only consecutive stationary spans by 200m single-span and 400m neighbor distance rules', () => {
    const chronology = buildMediaChronology(
      [
        asset('asset-drive'),
        asset('asset-aerial', { capturedAt: '2026-04-12T12:00:00.000Z' }),
      ],
      [],
      null,
      [],
      {
        now: '2026-04-12T13:00:00.000Z',
        projectGpsPoints: [
          point('2026-04-12T08:00:00.000Z', 30.0000, 100.0000),
          point('2026-04-12T08:00:30.000Z', 30.0005, 100.0000),
          point('2026-04-12T08:01:00.000Z', 30.0008, 100.0000),
          point('2026-04-12T12:00:00.000Z', 30.0027, 100.0000),
        ],
        spans: [
          span({
            id: 'stationary-drive',
            assetId: 'asset-drive',
            type: 'drive',
            sourceInMs: 0,
            sourceOutMs: 60_000,
          }),
          span({
            id: 'nearby-aerial',
            assetId: 'asset-aerial',
            type: 'aerial',
            sourceInMs: 0,
            sourceOutMs: 0,
          }),
        ],
      },
    );

    expect(chronology.events).toHaveLength(1);
    expect(chronology.events[0]).toMatchObject({
      kind: 'event',
      spanIds: ['stationary-drive', 'nearby-aerial'],
    });
  });

  it('splits consecutive stationary event candidates when neighbor GPS distance exceeds 400m', () => {
    const chronology = buildMediaChronology(
      [
        asset('asset-photo-a', { kind: 'photo' }),
        asset('asset-photo-b', { kind: 'photo', capturedAt: '2026-04-12T12:00:00.000Z' }),
      ],
      [],
      null,
      [],
      {
        now: '2026-04-12T13:00:00.000Z',
        projectGpsPoints: [
          point('2026-04-12T08:00:00.000Z', 30.0000, 100.0000),
          point('2026-04-12T12:00:00.000Z', 30.0060, 100.0000),
        ],
        spans: [
          span({ id: 'photo-a', assetId: 'asset-photo-a', type: 'photo', sourceInMs: 0, sourceOutMs: 0 }),
          span({ id: 'photo-b', assetId: 'asset-photo-b', type: 'photo', sourceInMs: 0, sourceOutMs: 0 }),
        ],
      },
    );

    expect(chronology.events.map(event => event.kind)).toEqual(['event', 'event']);
    expect(chronology.events.map(event => event.spanIds)).toEqual([['photo-a'], ['photo-b']]);
  });

  it('splits stationary clusters around a moving drive span', () => {
    const chronology = buildMediaChronology(
      [
        asset('asset-before'),
        asset('asset-drive', { capturedAt: '2026-04-12T08:01:00.000Z' }),
        asset('asset-after', { kind: 'photo', capturedAt: '2026-04-12T08:03:00.000Z' }),
      ],
      [],
      null,
      [],
      {
        now: '2026-04-12T09:00:00.000Z',
        projectGpsPoints: [
          point('2026-04-12T08:00:00.000Z', 30.0000, 100.0000),
          point('2026-04-12T08:01:00.000Z', 30.0000, 100.0000),
          point('2026-04-12T08:01:30.000Z', 30.0030, 100.0000),
          point('2026-04-12T08:02:00.000Z', 30.0060, 100.0000),
          point('2026-04-12T08:03:00.000Z', 30.0060, 100.0000),
        ],
        spans: [
          span({ id: 'before-stop', assetId: 'asset-before', type: 'broll', sourceInMs: 0, sourceOutMs: 0 }),
          span({ id: 'moving-drive', assetId: 'asset-drive', type: 'drive', sourceInMs: 0, sourceOutMs: 60_000 }),
          span({ id: 'after-stop', assetId: 'asset-after', type: 'photo', sourceInMs: 0, sourceOutMs: 0 }),
        ],
      },
    );

    expect(chronology.events.map(event => event.kind)).toEqual(['event', 'route', 'event']);
    expect(chronology.events.map(event => event.spanIds)).toEqual([['before-stop'], ['moving-drive'], ['after-stop']]);
  });

  it('prefers project GPX over embedded GPS when grouping aerial/static material', () => {
    const chronology = buildMediaChronology(
      [
        asset('asset-aerial-a', {
          embeddedGps: embeddedGps('2026-04-12T08:00:00.000Z', 31.0000, 101.0000),
        }),
        asset('asset-aerial-b', {
          capturedAt: '2026-04-12T08:01:00.000Z',
          embeddedGps: embeddedGps('2026-04-12T08:01:00.000Z', 32.0000, 102.0000),
        }),
      ],
      [],
      null,
      [],
      {
        now: '2026-04-12T09:00:00.000Z',
        projectGpsPoints: [
          point('2026-04-12T08:00:00.000Z', 30.0000, 100.0000),
          point('2026-04-12T08:01:00.000Z', 30.0020, 100.0000),
        ],
        spans: [
          span({ id: 'aerial-a', assetId: 'asset-aerial-a', type: 'aerial', sourceInMs: 0, sourceOutMs: 0 }),
          span({ id: 'aerial-b', assetId: 'asset-aerial-b', type: 'aerial', sourceInMs: 0, sourceOutMs: 0 }),
        ],
      },
    );

    expect(chronology.events).toHaveLength(1);
    expect(chronology.events[0]).toMatchObject({
      kind: 'event',
      spanIds: ['aerial-a', 'aerial-b'],
    });
  });

  it('prefers Pharos GPX over embedded GPS even when there is no direct point-event assignment', () => {
    const chronology = buildMediaChronology(
      [
        asset('asset-aerial-a', {
          embeddedGps: embeddedGps('2026-04-12T08:00:00.000Z', 31.0000, 101.0000),
        }),
        asset('asset-aerial-b', {
          capturedAt: '2026-04-12T08:01:00.000Z',
          embeddedGps: embeddedGps('2026-04-12T08:01:00.000Z', 32.0000, 102.0000),
        }),
      ],
      [],
      null,
      [],
      {
        now: '2026-04-12T09:00:00.000Z',
        pharosGpsPoints: [
          { ...point('2026-04-12T08:00:00.000Z', 30.0000, 100.0000), tripId: 'trip-1' },
          { ...point('2026-04-12T08:01:00.000Z', 30.0020, 100.0000), tripId: 'trip-1' },
        ],
        spans: [
          span({ id: 'pharos-aerial-a', assetId: 'asset-aerial-a', type: 'aerial', sourceInMs: 0, sourceOutMs: 0 }),
          span({ id: 'pharos-aerial-b', assetId: 'asset-aerial-b', type: 'aerial', sourceInMs: 0, sourceOutMs: 0 }),
        ],
      },
    );

    expect(chronology.events).toHaveLength(1);
    expect(chronology.events[0]).toMatchObject({
      kind: 'event',
      spanIds: ['pharos-aerial-a', 'pharos-aerial-b'],
    });
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

function asset(id: string, overrides: Partial<IKtepAsset> = {}): IKtepAsset {
  return {
    id,
    kind: overrides.kind ?? 'video',
    sourcePath: `${id}.mp4`,
    displayName: `${id}.mp4`,
    capturedAt: overrides.capturedAt ?? '2026-04-12T08:00:00.000Z',
    createdAt: overrides.createdAt ?? '2026-04-12T08:00:00.000Z',
    ingestRootId: overrides.ingestRootId,
    durationMs: overrides.durationMs,
    embeddedGps: overrides.embeddedGps,
    metadata: overrides.metadata,
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

function pharosContext(shots: IProjectPharosContext['shots']): IProjectPharosContext {
  return {
    schemaVersion: '1.0',
    generatedAt: '2026-04-12T09:00:00.000Z',
    status: 'success',
    rootPath: 'pharos',
    discoveredTripIds: ['trip-1'],
    includedTripIds: ['trip-1'],
    warnings: [],
    errors: [],
    trips: [{
      tripId: 'trip-1',
      title: 'Trip 1',
      mustCount: 0,
      optionalCount: 0,
      pendingCount: 0,
      expectedCount: shots.filter(shot => shot.status === 'expected').length,
      unexpectedCount: shots.filter(shot => shot.status === 'unexpected').length,
      abandonedCount: 0,
      gpxCount: 0,
      warnings: [],
    }],
    shots,
    gpxFiles: [],
  };
}

function pharosShot(
  overrides: Partial<IProjectPharosContext['shots'][number]> & {
    shotId: string;
    type: string;
    actualTimeStart: string;
    actualTimeEnd: string;
  },
): IProjectPharosContext['shots'][number] {
  return {
    ref: {
      tripId: overrides.ref?.tripId ?? 'trip-1',
      shotId: overrides.shotId,
    },
    tripTitle: overrides.tripTitle ?? 'Trip 1',
    dayTitle: overrides.dayTitle ?? 'Day 1',
    location: overrides.location ?? '地点',
    description: overrides.description ?? '',
    type: overrides.type,
    devices: overrides.devices ?? [],
    rolls: overrides.rolls ?? [],
    actualTimeStart: overrides.actualTimeStart,
    actualTimeEnd: overrides.actualTimeEnd,
    status: overrides.status ?? 'expected',
    isExtraShot: overrides.isExtraShot ?? false,
  };
}

function point(time: string, lat: number, lng: number): { time: string; lat: number; lng: number } {
  return { time, lat, lng };
}

function embeddedGps(
  representativeTime: string,
  representativeLat: number,
  representativeLng: number,
): IKtepAsset['embeddedGps'] {
  return {
    originType: 'sidecar-srt',
    confidence: 0.95,
    representativeTime,
    representativeLat,
    representativeLng,
  };
}
