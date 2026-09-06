import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildMediaChronology, buildMediaChronologyWithProgress } from '../../src/modules/media/chronology.js';
import { buildProjectChronology } from '../../src/modules/media/chronology-build.js';
import type { IReverseGeocodeService } from '../../src/modules/media/reverse-geocode.js';
import {
  formatReverseGeocodeLocationKey,
  type IReverseGeocodeCacheEntry,
} from '../../src/store/reverse-geocode-cache.js';
import {
  assertConfirmedProjectChronology,
  getAssetsPath,
  getSpansMetaPath,
  getSpansPath,
  initWorkspaceProject,
  loadChronology,
  writeJson,
} from '../../src/store/index.js';
import type { IAssetCoarseReport, IProjectPharosContext, IKtepAsset, IKtepSlice } from '../../src/protocol/index.js';

describe('buildMediaChronology', () => {
  it('writes Chronology V2 assetIndex from already-normalized asset capturedAt', () => {
    const chronology = buildMediaChronology(
      [{
        id: 'asset-1',
        kind: 'photo',
        sourcePath: 'photo.jpg',
        displayName: 'photo.jpg',
        ingestRootId: 'root-photo',
        capturedAt: '2026-04-12T07:59:35.000Z',
        rawCapturedAt: '2026-04-12T08:09:46.000Z',
        appliedClockOffsetMs: -611_000,
        createdAt: '2026-04-12T07:59:35.000Z',
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
      title: '子梅垭口',
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

  it('does not use the controlled material-pattern view slot as an event title', () => {
    const chronology = buildMediaChronology(
      [asset('asset-1')],
      [],
      null,
      [],
      {
        now: '2026-04-12T09:00:00.000Z',
        spans: [
          span({
            id: 'broll-1',
            assetId: 'asset-1',
            type: 'broll',
            materialPatterns: ['固定机位观察', '服务区停车场', '阴天', '无口播语音', '停车观察建筑'],
          }),
        ],
      },
    );

    expect(chronology.events).toHaveLength(1);
    expect(chronology.events[0]).toMatchObject({
      kind: 'event',
      title: '停车观察建筑',
    });
  });

  it('does not text-merge same-place airport material without spatial continuity or promote the controlled view slot to route', () => {
    const assets = [
      asset('airport-video-a', { capturedAt: '2026-05-05T10:56:55.000Z' }),
      asset('airport-photo', { kind: 'photo', capturedAt: '2026-05-05T10:58:28.000Z' }),
      asset('airport-video-b', { capturedAt: '2026-05-05T10:59:28.000Z' }),
      asset('airport-video-c', { capturedAt: '2026-05-05T11:00:09.000Z' }),
    ];
    const chronology = buildMediaChronology(
      assets,
      [
        report('airport-video-a', 'airport terminal'),
        report('airport-photo', 'airport terminal'),
        report('airport-video-b', 'airport'),
        report('airport-video-c', 'airport'),
      ],
      null,
      [],
      {
        now: '2026-05-05T11:10:00.000Z',
        spans: [
          span({
            id: 'airport-window',
            assetId: 'airport-video-a',
            type: 'broll',
            sourceOutMs: 2_582,
            materialPatterns: ['固定机位观察', '机场大厅', '晴天', '有口播语音', '机场候机'],
          }),
          span({
            id: 'airport-photo',
            assetId: 'airport-photo',
            type: 'photo',
            sourceOutMs: 0,
            materialPatterns: ['固定机位观察', '机场航站楼', '晴天', '无口播语音', '机场候机'],
          }),
          span({
            id: 'airport-ticket',
            assetId: 'airport-video-b',
            type: 'broll',
            sourceOutMs: 5_078,
            materialPatterns: ['第一人称行车', '机场大厅', '室内灯光', '无口播语音', '机场取票'],
          }),
          span({
            id: 'airport-card',
            assetId: 'airport-video-c',
            type: 'broll',
            sourceOutMs: 4_075,
            materialPatterns: ['车窗外观察', '飞机客舱', '室内灯光', '无口播语音', '查看安全须知'],
          }),
        ],
      },
    );

    expect(chronology.events).toHaveLength(3);
    expect(chronology.events.map(event => event.kind)).toEqual(['event', 'event', 'event']);
    expect(chronology.events.map(event => event.spanIds)).toEqual([
      ['airport-window'],
      ['airport-ticket', 'airport-photo'],
      ['airport-card'],
    ]);
  });

  it('keeps aerial road material as event unless it has structured drive type', () => {
    const chronology = buildMediaChronology(
      [asset('drone-car', { capturedAt: '2026-05-03T00:00:38.000Z' })],
      [],
      null,
      [],
      {
        now: '2026-05-03T01:00:00.000Z',
        spans: [
          span({
            id: 'drone-car-span',
            assetId: 'drone-car',
            type: 'aerial',
            sourceOutMs: 9_771,
            visualObservation: 'Aerial view of a winding road through a village with snow-capped mountains in the background.',
            materialPatterns: ['航拍俯瞰', '山路', '晴天', '无口播语音', '山村行车', '蜿蜒道路', '雪山背景'],
          }),
        ],
      },
    );

    expect(chronology.events).toHaveLength(1);
    expect(chronology.events[0]).toMatchObject({
      kind: 'event',
      spanIds: ['drone-car-span'],
    });
  });

  it('keeps scenic aerial road establishes as ordinary events without vehicle movement evidence', () => {
    const chronology = buildMediaChronology(
      [asset('drone-road', { capturedAt: '2026-05-03T00:00:38.000Z' })],
      [],
      null,
      [],
      {
        now: '2026-05-03T01:00:00.000Z',
        spans: [
          span({
            id: 'drone-road-span',
            assetId: 'drone-road',
            type: 'aerial',
            sourceOutMs: 9_771,
            visualObservation: 'Aerial view of a winding road through a village with snow-capped mountains in the background.',
            materialPatterns: ['航拍俯瞰', '山路', '晴天', '无口播语音', '航拍村庄道路', '蜿蜒道路', '雪山背景'],
          }),
        ],
      },
    );

    expect(chronology.events).toHaveLength(1);
    expect(chronology.events[0]).toMatchObject({
      kind: 'event',
      title: '航拍村庄道路',
      spanIds: ['drone-road-span'],
    });
  });

  it('regenerates pending route titles instead of preserving stale generated labels', () => {
    const options = {
      now: '2026-04-12T09:00:00.000Z',
      spans: [
        span({ id: 'drive-1', assetId: 'asset-1', type: 'drive' }),
      ],
    };
    const initial = buildMediaChronology(
      [asset('asset-1')],
      [],
      null,
      [],
      options,
    );
    const existing = {
      ...initial,
      events: initial.events.map(event => ({
        ...event,
        reviewStatus: 'pending' as const,
        title: 'Route near residential area',
      })),
    };

    const rebuilt = buildMediaChronology(
      [asset('asset-1')],
      [],
      existing,
      [],
      options,
    );

    expect(rebuilt.events).toHaveLength(1);
    expect(rebuilt.events[0]).toMatchObject({
      kind: 'route',
      title: '行车段',
      spanIds: ['drive-1'],
    });
  });

  it('defaults Pharos point events to confirmed even when an old generated draft was pending', () => {
    const options = {
      now: '2026-04-12T09:00:00.000Z',
      pharosContext: pharosContext([
        pharosShot({
          shotId: 'pharos-stop',
          type: 'event',
          location: 'Pharos 停留点',
          description: 'Pharos 记录的正式停留事件。',
          actualTimeStart: '2026-04-12T08:00:10.000Z',
          actualTimeEnd: '2026-04-12T08:00:20.000Z',
        }),
      ]),
      spans: [
        span({ id: 'pharos-span', assetId: 'asset-1', type: 'drive', sourceInMs: 10_000, sourceOutMs: 20_000 }),
      ],
    };
    const initial = buildMediaChronology(
      [asset('asset-1')],
      [],
      null,
      [],
      options,
    );
    const existing = {
      ...initial,
      events: initial.events.map(event => ({
        ...event,
        reviewStatus: 'pending' as const,
      })),
    };

    const rebuilt = buildMediaChronology(
      [asset('asset-1')],
      [],
      existing,
      [],
      options,
    );

    expect(rebuilt.events).toHaveLength(1);
    expect(rebuilt.events[0]).toMatchObject({
      kind: 'event',
      reviewStatus: 'confirmed',
      title: 'Pharos 停留点',
      spanIds: ['pharos-span'],
    });
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
      reviewStatus: 'confirmed',
      title: '牦牛过路等待点',
      location: '牦牛过路等待点',
      spanIds: ['drive-inside-point', 'aerial-inside-point', 'photo-inside-point'],
    });
    expect(chronology.events[0]?.id).toMatch(/^event-pharos-/u);
    expect(chronology.events[0] as Record<string, unknown>).not.toHaveProperty('pharosRefs');
  });

  it('uses explicit actual capture types to disambiguate overlapping Pharos point events', () => {
    const chronology = buildMediaChronology(
      [
        asset('asset-ground'),
        asset('asset-mavic'),
      ],
      [],
      null,
      [],
      {
        now: '2026-04-12T09:00:00.000Z',
        pharosContext: pharosContext([
          pharosShot({
            shotId: 'ground-village',
            type: 'event',
            location: '纳灰村',
            description: '地面走拍记录。',
            actualTimeStart: '2026-04-12T08:00:00.000Z',
            actualTimeEnd: '2026-04-12T08:02:00.000Z',
            actualCaptures: [{ type: 'video', camera: 'ZV-E1', lens: '17-28mm F2.8' }],
          }),
          pharosShot({
            shotId: 'aerial-village',
            type: 'event',
            location: '上纳灰村',
            description: '空中航拍记录。',
            actualTimeStart: '2026-04-12T08:00:00.000Z',
            actualTimeEnd: '2026-04-12T08:02:00.000Z',
            actualCaptures: [{ type: 'aerial', camera: 'Mavic 4 Pro', lens: null }],
          }),
        ]),
        spans: [
          span({
            id: 'ground-broll',
            assetId: 'asset-ground',
            type: 'broll',
            sourceInMs: 0,
            sourceOutMs: 60_000,
          }),
          span({
            id: 'mavic-aerial',
            assetId: 'asset-mavic',
            type: 'aerial',
            sourceInMs: 0,
            sourceOutMs: 60_000,
          }),
        ],
      },
    );

    const byTitle = new Map(chronology.events.map(event => [event.title, event]));
    expect(byTitle.get('纳灰村')).toMatchObject({
      kind: 'event',
      reviewStatus: 'confirmed',
      spanIds: ['ground-broll'],
    });
    expect(byTitle.get('上纳灰村')).toMatchObject({
      kind: 'event',
      reviewStatus: 'confirmed',
      spanIds: ['mavic-aerial'],
    });
    expect(chronology.events.some(event => event.kind === 'gap')).toBe(false);
  });

  it('assigns a span to a Pharos point when it has meaningful partial overlap', () => {
    const chronology = buildMediaChronology(
      [asset('asset-departure', { capturedAt: '2026-04-12T08:59:10.000Z' })],
      [],
      null,
      [],
      {
        now: '2026-04-12T10:00:00.000Z',
        pharosContext: pharosContext([
          pharosShot({
            shotId: 'departure',
            type: 'event',
            location: '深圳出发点',
            description: '装车出发',
            actualTimeStart: '2026-04-12T09:00:00.000Z',
            actualTimeEnd: '2026-04-12T09:15:00.000Z',
            actualCaptures: [{ type: 'video', camera: 'ZV-E1', lens: '17-28mm F2.8' }],
          }),
        ]),
        spans: [
          span({
            id: 'departure-tail-overlap',
            assetId: 'asset-departure',
            type: 'drive',
            sourceInMs: 0,
            sourceOutMs: 60_000,
          }),
        ],
      },
    );

    expect(chronology.events).toHaveLength(1);
    expect(chronology.events[0]).toMatchObject({
      kind: 'event',
      reviewStatus: 'confirmed',
      title: '深圳出发点',
      spanIds: ['departure-tail-overlap'],
    });
  });

  it('prefers the more specific Pharos point window when explicit capture semantics tie', () => {
    const chronology = buildMediaChronology(
      [
        asset('asset-ground'),
        asset('asset-mavic'),
      ],
      [],
      null,
      [],
      {
        now: '2026-04-12T10:00:00.000Z',
        pharosContext: pharosContext([
          pharosShot({
            shotId: 'broad-stop',
            type: 'event',
            location: '察隅县',
            description: '途中一段森林路段跟车',
            actualTimeStart: '2026-04-12T08:00:00.000Z',
            actualTimeEnd: '2026-04-12T09:00:00.000Z',
            actualCaptures: [
              { type: 'video', camera: 'ZV-E1', lens: '17-28mm F2.8' },
              { type: 'aerial', camera: 'Mavic 4 Pro', lens: null },
            ],
          }),
          pharosShot({
            shotId: 'specific-aerial',
            type: 'event',
            location: '雄珠拉垭口上空',
            description: '航拍盘山公路和雪山全景',
            actualTimeStart: '2026-04-12T08:10:00.000Z',
            actualTimeEnd: '2026-04-12T08:25:00.000Z',
            actualCaptures: [{ type: 'aerial', camera: 'Mavic 4 Pro', lens: null }],
          }),
        ]),
        spans: [
          span({
            id: 'ground-drive',
            assetId: 'asset-ground',
            type: 'drive',
            sourceInMs: 5 * 60_000,
            sourceOutMs: 6 * 60_000,
          }),
          span({
            id: 'mavic-aerial-specific',
            assetId: 'asset-mavic',
            type: 'aerial',
            sourceInMs: 12 * 60_000,
            sourceOutMs: 13 * 60_000,
          }),
        ],
      },
    );

    const byTitle = new Map(chronology.events.map(event => [event.title, event]));
    expect(byTitle.get('察隅县')).toMatchObject({
      kind: 'event',
      reviewStatus: 'confirmed',
      spanIds: ['ground-drive'],
    });
    expect(byTitle.get('雄珠拉垭口上空')).toMatchObject({
      kind: 'event',
      reviewStatus: 'confirmed',
      spanIds: ['mavic-aerial-specific'],
    });
    expect(chronology.events.some(event => event.kind === 'gap')).toBe(false);
  });

  it('groups interleaved rows for the same direct Pharos point shot into one event', async () => {
    const chronology = await buildMediaChronologyWithProgress(
      [
        asset('asset-ground'),
        asset('asset-mavic'),
      ],
      [],
      null,
      [],
      {
        now: '2026-04-12T09:00:00.000Z',
        pharosContext: pharosContext([
          pharosShot({
            shotId: 'ground-village',
            type: 'event',
            location: '纳灰村',
            description: '地面走拍记录。',
            actualTimeStart: '2026-04-12T08:00:00.000Z',
            actualTimeEnd: '2026-04-12T08:03:00.000Z',
            actualCaptures: [{ type: 'video', camera: 'ZV-E1', lens: '17-28mm F2.8' }],
          }),
          pharosShot({
            shotId: 'aerial-village',
            type: 'event',
            location: '上纳灰村',
            description: '空中航拍记录。',
            actualTimeStart: '2026-04-12T08:00:00.000Z',
            actualTimeEnd: '2026-04-12T08:03:00.000Z',
            actualCaptures: [{ type: 'aerial', camera: 'Mavic 4 Pro', lens: null }],
          }),
        ]),
        spans: [
          span({ id: 'ground-1', assetId: 'asset-ground', type: 'broll', sourceInMs: 0, sourceOutMs: 20_000 }),
          span({ id: 'mavic-1', assetId: 'asset-mavic', type: 'aerial', sourceInMs: 10_000, sourceOutMs: 30_000 }),
          span({ id: 'ground-2', assetId: 'asset-ground', type: 'drive', sourceInMs: 40_000, sourceOutMs: 60_000 }),
          span({ id: 'mavic-2', assetId: 'asset-mavic', type: 'aerial', sourceInMs: 50_000, sourceOutMs: 70_000 }),
        ],
      },
    );

    const ids = chronology.events.map(event => event.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(chronology.events).toHaveLength(2);
    expect(new Map(chronology.events.map(event => [event.title, event])).get('纳灰村')).toMatchObject({
      kind: 'event',
      reviewStatus: 'confirmed',
      spanIds: ['ground-1', 'ground-2'],
    });
    expect(new Map(chronology.events.map(event => [event.title, event])).get('上纳灰村')).toMatchObject({
      kind: 'event',
      reviewStatus: 'confirmed',
      spanIds: ['mavic-1', 'mavic-2'],
    });
  });

  it('keeps Pharos point events as hard route boundaries', () => {
    const chronology = buildMediaChronology(
      [asset('asset-1')],
      [],
      null,
      [],
      {
        now: '2026-04-12T09:00:00.000Z',
        pharosContext: pharosContext([
          pharosShot({
            shotId: 'service-stop',
            type: 'event',
            location: '赤坎服务区',
            description: '服务区短暂停留。',
            actualTimeStart: '2026-04-12T08:01:10.000Z',
            actualTimeEnd: '2026-04-12T08:01:20.000Z',
          }),
        ]),
        spans: [
          span({ id: 'drive-before', assetId: 'asset-1', type: 'drive', sourceInMs: 0, sourceOutMs: 50_000 }),
          span({ id: 'point-span', assetId: 'asset-1', type: 'drive', sourceInMs: 70_000, sourceOutMs: 80_000 }),
          span({ id: 'drive-after', assetId: 'asset-1', type: 'drive', sourceInMs: 120_000, sourceOutMs: 170_000 }),
        ],
      },
    );

    expect(chronology.events.map(event => event.kind)).toEqual(['route', 'event', 'route']);
    expect(chronology.events.map(event => event.spanIds)).toEqual([
      ['drive-before'],
      ['point-span'],
      ['drive-after'],
    ]);
    expect(chronology.events[1]).toMatchObject({
      reviewStatus: 'confirmed',
      title: '赤坎服务区',
      location: '赤坎服务区',
    });
  });

  it('keeps no-span Pharos point gaps as route boundaries', () => {
    const chronology = buildMediaChronology(
      [asset('asset-1')],
      [],
      null,
      [],
      {
        now: '2026-04-12T09:00:00.000Z',
        pharosContext: pharosContext([
          pharosShot({
            shotId: 'missing-stop',
            type: 'event',
            location: '计划服务区',
            description: '计划中应停留但没有素材命中。',
            actualTimeStart: '2026-04-12T08:01:10.000Z',
            actualTimeEnd: '2026-04-12T08:01:20.000Z',
          }),
        ]),
        spans: [
          span({ id: 'drive-before-gap', assetId: 'asset-1', type: 'drive', sourceInMs: 0, sourceOutMs: 50_000 }),
          span({ id: 'drive-after-gap', assetId: 'asset-1', type: 'drive', sourceInMs: 120_000, sourceOutMs: 170_000 }),
        ],
      },
    );

    expect(chronology.events.map(event => event.kind)).toEqual(['route', 'gap', 'route']);
    expect(chronology.events[1]).toMatchObject({
      reviewStatus: 'pending',
      title: 'Missing: 计划服务区',
      location: '计划服务区',
      spanIds: [],
    });
  });

  it('does not generate gaps for abandoned or continuous Pharos shots without spans', () => {
    const chronology = buildMediaChronology(
      [],
      [],
      null,
      [],
      {
        now: '2026-04-12T09:00:00.000Z',
        pharosContext: pharosContext([
          pharosShot({
            shotId: 'abandoned-stop',
            type: 'event',
            status: 'abandoned',
            location: '取消停留点',
            actualTimeStart: '2026-04-12T08:01:10.000Z',
            actualTimeEnd: '2026-04-12T08:01:20.000Z',
          }),
          pharosShot({
            shotId: 'continuous-road',
            type: 'continuous',
            status: 'expected',
            location: '连续行车窗口',
            actualTimeStart: '2026-04-12T08:10:00.000Z',
            actualTimeEnd: '2026-04-12T08:40:00.000Z',
          }),
        ]),
      },
    );

    expect(chronology.events).toEqual([]);
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

  it('keeps short stationary drive spans in route instead of splitting drive-only events', () => {
    const chronology = buildMediaChronology(
      [asset('asset-1')],
      [],
      null,
      [],
      {
        now: '2026-04-12T09:00:00.000Z',
        projectGpsPoints: [
          point('2026-04-12T08:00:00.000Z', 30.0000, 100.0000),
          point('2026-04-12T08:00:05.000Z', 30.0001, 100.0000),
          point('2026-04-12T08:00:10.000Z', 30.0001, 100.0000),
          point('2026-04-12T08:00:15.000Z', 30.0002, 100.0000),
          point('2026-04-12T08:00:20.000Z', 30.0002, 100.0000),
          point('2026-04-12T08:00:25.000Z', 30.0003, 100.0000),
        ],
        spans: [
          span({ id: 'drive-1', assetId: 'asset-1', type: 'drive', sourceInMs: 0, sourceOutMs: 5_000 }),
          span({ id: 'drive-2', assetId: 'asset-1', type: 'drive', sourceInMs: 10_000, sourceOutMs: 15_000 }),
          span({ id: 'drive-3', assetId: 'asset-1', type: 'drive', sourceInMs: 20_000, sourceOutMs: 25_000 }),
        ],
      },
    );

    expect(chronology.events).toHaveLength(1);
    expect(chronology.events[0]).toMatchObject({
      kind: 'route',
      spanIds: ['drive-1', 'drive-2', 'drive-3'],
    });
  });

  it('keeps static aerial road photos in same nearby event instead of route', () => {
    const chronology = buildMediaChronology(
      [
        asset('asset-aerial-video', { capturedAt: '2026-04-12T08:00:00.000Z' }),
        asset('asset-aerial-photo', { kind: 'photo', capturedAt: '2026-04-12T08:00:30.000Z' }),
        asset('asset-aerial-video-2', { capturedAt: '2026-04-12T08:01:00.000Z' }),
      ],
      [],
      null,
      [],
      {
        now: '2026-04-12T09:00:00.000Z',
        projectGpsPoints: [
          point('2026-04-12T08:00:00.000Z', 30.0000, 100.0000),
          point('2026-04-12T08:00:15.000Z', 30.0000, 100.0000),
          point('2026-04-12T08:00:30.000Z', 30.0001, 100.0000),
          point('2026-04-12T08:01:00.000Z', 30.0002, 100.0000),
          point('2026-04-12T08:01:15.000Z', 30.0002, 100.0000),
        ],
        spans: [
          span({
            id: 'aerial-road-video',
            assetId: 'asset-aerial-video',
            type: 'aerial',
            sourceInMs: 0,
            sourceOutMs: 15_000,
            visualObservation: 'Aerial view of a multi-lane highway and service area surrounded by forest.',
            materialPatterns: ['航拍俯瞰', '高速公路服务区', '晴天', '无口播语音', '航拍公路与服务区'],
          }),
          span({
            id: 'aerial-road-photo',
            assetId: 'asset-aerial-photo',
            type: 'photo',
            sourceInMs: 0,
            sourceOutMs: 0,
            visualObservation: 'An aerial view of a highway winding through lush green forests.',
            materialPatterns: ['航拍俯瞰', '森林公路', '晴天', '无口播语音', '多车道公路航拍'],
          }),
          span({
            id: 'aerial-road-video-2',
            assetId: 'asset-aerial-video-2',
            type: 'aerial',
            sourceInMs: 0,
            sourceOutMs: 15_000,
            visualObservation: 'Aerial view of the same highway service area with forested hills nearby.',
            materialPatterns: ['航拍俯瞰', '高速公路服务区', '晴天', '无口播语音', '服务区航拍'],
          }),
        ],
      },
    );

    expect(chronology.events).toHaveLength(1);
    expect(chronology.events[0]).toMatchObject({
      kind: 'event',
      spanIds: ['aerial-road-video', 'aerial-road-video-2', 'aerial-road-photo'],
    });
    expect(chronology.events[0]?.title).not.toMatch(/^行车/u);
  });

  it('merges moving non-route observations by time and GPS trajectory continuity', () => {
    const chronology = buildMediaChronology(
      [
        asset('butterfly-video-a', { capturedAt: '2026-04-25T06:22:49.000Z' }),
        asset('butterfly-photo', { kind: 'photo', capturedAt: '2026-04-25T06:24:04.000Z' }),
        asset('butterfly-video-b', { capturedAt: '2026-04-25T06:26:52.000Z' }),
        asset('butterfly-video-c', { capturedAt: '2026-04-25T06:27:25.000Z' }),
      ],
      [],
      null,
      [],
      {
        now: '2026-04-25T07:00:00.000Z',
        projectGpsPoints: [
          point('2026-04-25T06:22:49.000Z', 24.393533, 106.122191),
          point('2026-04-25T06:24:04.000Z', 24.400110, 106.108524),
          point('2026-04-25T06:26:52.000Z', 24.422452, 106.084413),
          point('2026-04-25T06:27:25.000Z', 24.427428, 106.079219),
        ],
        spans: [
          span({
            id: 'butterfly-video-a',
            assetId: 'butterfly-video-a',
            type: 'broll',
            sourceInMs: 0,
            sourceOutMs: 14_592,
            materialPatterns: ['细节特写', '车旁静止', '天气光线不明', '无口播语音', '蝴蝶停驻车漆'],
          }),
          span({
            id: 'butterfly-photo',
            assetId: 'butterfly-photo',
            type: 'photo',
            sourceInMs: 0,
            sourceOutMs: 0,
            materialPatterns: ['细节特写', '特写镜头', '天气光线不明', '无口播语音', '蝴蝶停驻特写'],
          }),
          span({
            id: 'butterfly-video-b',
            assetId: 'butterfly-video-b',
            type: 'broll',
            sourceInMs: 0,
            sourceOutMs: 9_579,
            materialPatterns: ['细节特写', '户外特写', '晴天', '无口播语音', '车旁互动'],
          }),
          span({
            id: 'butterfly-video-c',
            assetId: 'butterfly-video-c',
            type: 'broll',
            sourceInMs: 0,
            sourceOutMs: 21_099,
            materialPatterns: ['细节特写', '车旁特写', '天气光线不明', '无口播语音', '车旁观察'],
          }),
        ],
      },
    );

    expect(chronology.events).toHaveLength(1);
    expect(chronology.events[0]).toMatchObject({
      kind: 'event',
      spanIds: ['butterfly-video-a', 'butterfly-video-b', 'butterfly-video-c', 'butterfly-photo'],
    });
  });

  it('splits non-route event candidates when the time gap exceeds the continuity window', () => {
    const chronology = buildMediaChronology(
      [
        asset('asset-broll'),
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
            id: 'stationary-broll',
            assetId: 'asset-broll',
            type: 'broll',
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

    expect(chronology.events).toHaveLength(2);
    expect(chronology.events.map(event => event.kind)).toEqual(['event', 'event']);
    expect(chronology.events.map(event => event.spanIds)).toEqual([['stationary-broll'], ['nearby-aerial']]);
  });

  it('does not create ordinary events from photo-only non-Pharos material', () => {
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

    expect(chronology.events).toEqual([]);
  });

  it('attaches remaining photos to the nearest ordinary event by time', () => {
    const chronology = buildMediaChronology(
      [
        asset('event-before', { capturedAt: '2026-04-12T08:00:00.000Z' }),
        asset('loose-photo', { kind: 'photo', capturedAt: '2026-04-12T08:20:00.000Z' }),
        asset('event-after', { capturedAt: '2026-04-12T09:00:00.000Z' }),
      ],
      [],
      null,
      [],
      {
        now: '2026-04-12T10:00:00.000Z',
        spans: [
          span({ id: 'event-before-span', assetId: 'event-before', type: 'broll', sourceInMs: 0, sourceOutMs: 5_000 }),
          span({ id: 'loose-photo-span', assetId: 'loose-photo', type: 'photo', sourceInMs: 0, sourceOutMs: 0 }),
          span({ id: 'event-after-span', assetId: 'event-after', type: 'broll', sourceInMs: 0, sourceOutMs: 5_000 }),
        ],
      },
    );

    expect(chronology.events.map(event => event.spanIds)).toEqual([
      ['event-before-span', 'loose-photo-span'],
      ['event-after-span'],
    ]);
  });

  it('lets routes attach nearby photos without letting photos become route boundaries', () => {
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
        spans: [
          span({ id: 'before-stop', assetId: 'asset-before', type: 'broll', sourceInMs: 0, sourceOutMs: 0 }),
          span({ id: 'moving-drive', assetId: 'asset-drive', type: 'drive', sourceInMs: 0, sourceOutMs: 60_000 }),
          span({ id: 'after-stop', assetId: 'asset-after', type: 'photo', sourceInMs: 0, sourceOutMs: 0 }),
        ],
      },
    );

    expect(chronology.events.map(event => event.kind)).toEqual(['event', 'route']);
    expect(chronology.events.map(event => event.spanIds)).toEqual([['before-stop'], ['moving-drive', 'after-stop']]);
  });

  it('merges drive rows before attaching interleaved photos', () => {
    const chronology = buildMediaChronology(
      [
        asset('asset-drive-a', { capturedAt: '2026-04-12T08:00:00.000Z' }),
        asset('asset-photo', { kind: 'photo', capturedAt: '2026-04-12T08:00:05.000Z' }),
        asset('asset-drive-b', { capturedAt: '2026-04-12T08:00:10.000Z' }),
      ],
      [],
      null,
      [],
      {
        now: '2026-04-12T09:00:00.000Z',
        projectGpsPoints: [
          point('2026-04-12T08:00:00.000Z', 30.0000, 100.0000),
          point('2026-04-12T08:00:05.000Z', 30.0001, 100.0000),
          point('2026-04-12T08:00:10.000Z', 30.0002, 100.0000),
          point('2026-04-12T08:00:20.000Z', 30.0004, 100.0000),
        ],
        spans: [
          span({ id: 'drive-before-photo', assetId: 'asset-drive-a', type: 'drive', sourceInMs: 0, sourceOutMs: 5_000 }),
          span({ id: 'drive-photo', assetId: 'asset-photo', type: 'photo', sourceInMs: 0, sourceOutMs: 0 }),
          span({ id: 'drive-after-photo', assetId: 'asset-drive-b', type: 'drive', sourceInMs: 0, sourceOutMs: 10_000 }),
        ],
      },
    );

    expect(chronology.events).toHaveLength(1);
    expect(chronology.events[0]).toMatchObject({
      kind: 'route',
      spanIds: ['drive-before-photo', 'drive-after-photo', 'drive-photo'],
    });
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

  it('reverse-geocodes route endpoints from the route start and end time instead of Pharos continuous prose', async () => {
    const calls: string[] = [];
    const chronology = await buildMediaChronologyWithProgress(
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
            location: '深圳 → 南宁 全程',
            actualTimeStart: '2026-04-12T08:00:00.000Z',
            actualTimeEnd: '2026-04-12T08:10:00.000Z',
            gpsStart: [110, 20],
            gpsEnd: [111, 21],
          }),
        ]),
        pharosGpsPoints: [
          { ...point('2026-04-12T08:01:00.000Z', 22.111111, 113.111111), tripId: 'trip-1' },
          { ...point('2026-04-12T08:03:00.000Z', 22.222222, 113.222222), tripId: 'trip-1' },
        ],
        spans: [
          span({ id: 'drive-continuous', assetId: 'asset-drive', type: 'drive', sourceInMs: 60_000, sourceOutMs: 180_000 }),
        ],
        reverseGeocodeService: fakeReverseGeocodeService({
          [formatReverseGeocodeLocationKey(113.111111, 22.111111)]: '深圳出发地',
          [formatReverseGeocodeLocationKey(113.222222, 22.222222)]: '赤坎服务区',
        }, calls),
      },
    );

    expect(calls).toEqual([
      formatReverseGeocodeLocationKey(113.111111, 22.111111),
      formatReverseGeocodeLocationKey(113.222222, 22.222222),
    ]);
    expect(chronology.events).toHaveLength(1);
    expect(chronology.events[0]).toMatchObject({
      kind: 'route',
      title: '行车：深圳出发地 → 赤坎服务区',
      route: {
        from: '深圳出发地',
        to: '赤坎服务区',
      },
    });
    expect(JSON.stringify(chronology.events[0])).not.toContain('深圳 → 南宁 全程');
  });

  it('reverse-geocodes ordinary non-Pharos event location from the event midpoint GPS', async () => {
    const chronology = await buildMediaChronologyWithProgress(
      [asset('asset-broll')],
      [],
      null,
      [],
      {
        now: '2026-04-12T09:00:00.000Z',
        projectGpsPoints: [
          point('2026-04-12T08:00:30.000Z', 22.333333, 113.333333),
        ],
        spans: [
          span({
            id: 'broll-stop',
            assetId: 'asset-broll',
            type: 'broll',
            sourceInMs: 0,
            sourceOutMs: 60_000,
            materialPatterns: ['手持记录', '服务区', '晴天', '无口播语音', '停车观察服务区'],
          }),
        ],
        reverseGeocodeService: fakeReverseGeocodeService({
          [formatReverseGeocodeLocationKey(113.333333, 22.333333)]: '阳春服务区',
        }),
      },
    );

    expect(chronology.events).toHaveLength(1);
    expect(chronology.events[0]).toMatchObject({
      kind: 'event',
      title: '停车观察服务区',
      location: '阳春服务区',
    });
  });

  it('does not fall back to route prose when reverse geocode is unavailable', async () => {
    const chronology = await buildMediaChronologyWithProgress(
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
            location: '深圳 → 南宁 全程',
            actualTimeStart: '2026-04-12T08:00:00.000Z',
            actualTimeEnd: '2026-04-12T08:10:00.000Z',
          }),
        ]),
        pharosGpsPoints: [
          { ...point('2026-04-12T08:00:00.000Z', 22.111111, 113.111111), tripId: 'trip-1' },
          { ...point('2026-04-12T08:01:00.000Z', 22.222222, 113.222222), tripId: 'trip-1' },
        ],
        spans: [
          span({ id: 'drive-no-geocode', assetId: 'asset-drive', type: 'drive', sourceInMs: 0, sourceOutMs: 60_000 }),
        ],
        reverseGeocodeService: null,
      },
    );

    expect(chronology.events[0]).toMatchObject({
      kind: 'route',
      title: '行车段',
    });
    expect(chronology.events[0]?.location).toBeUndefined();
    expect(chronology.events[0]?.route).toBeUndefined();
    expect(JSON.stringify(chronology.events[0])).not.toContain('深圳 → 南宁 全程');
  });

  it('repairs bad confirmed route prose during review-state merge', async () => {
    const options = {
      now: '2026-04-12T09:00:00.000Z',
      projectGpsPoints: [
        point('2026-04-12T08:00:00.000Z', 22.111111, 113.111111),
        point('2026-04-12T08:01:00.000Z', 22.222222, 113.222222),
      ],
      spans: [
        span({ id: 'drive-repair', assetId: 'asset-drive', type: 'drive', sourceInMs: 0, sourceOutMs: 60_000 }),
      ],
      reverseGeocodeService: fakeReverseGeocodeService({
        [formatReverseGeocodeLocationKey(113.111111, 22.111111)]: '深圳出发地',
        [formatReverseGeocodeLocationKey(113.222222, 22.222222)]: '赤坎服务区',
      }),
    };
    const initial = await buildMediaChronologyWithProgress([asset('asset-drive')], [], null, [], options);
    const existing = {
      ...initial,
      status: 'confirmed' as const,
      confirmedAt: '2026-04-12T09:30:00.000Z',
      events: initial.events.map(event => ({
        ...event,
        reviewStatus: 'confirmed' as const,
        title: '行车：深圳 → 南宁 全程',
        location: '深圳 → 南宁 全程',
        route: {
          from: '深圳 → 南宁 全程',
          to: '深圳 → 南宁 全程',
        },
      })),
    };

    const rebuilt = await buildMediaChronologyWithProgress([asset('asset-drive')], [], existing, [], options);

    expect(rebuilt.status).toBe('confirmed');
    expect(rebuilt.events[0]).toMatchObject({
      reviewStatus: 'confirmed',
      title: '行车：深圳出发地 → 赤坎服务区',
      route: {
        from: '深圳出发地',
        to: '赤坎服务区',
      },
    });
    expect(JSON.stringify(rebuilt.events[0])).not.toContain('全程');
  });

  it('dedupes reverse-geocode requests by rounded coordinate', async () => {
    const calls: string[] = [];
    const chronology = await buildMediaChronologyWithProgress(
      [asset('asset-drive')],
      [],
      null,
      [],
      {
        now: '2026-04-12T09:00:00.000Z',
        projectGpsPoints: [
          point('2026-04-12T08:00:00.000Z', 22.1111114, 113.1111114),
          point('2026-04-12T08:01:00.000Z', 22.1111113, 113.1111113),
        ],
        spans: [
          span({ id: 'drive-same-place', assetId: 'asset-drive', type: 'drive', sourceInMs: 0, sourceOutMs: 60_000 }),
        ],
        reverseGeocodeService: fakeReverseGeocodeService({
          [formatReverseGeocodeLocationKey(113.1111114, 22.1111114)]: '同一服务区',
        }, calls),
      },
    );

    expect(calls).toEqual([formatReverseGeocodeLocationKey(113.1111114, 22.1111114)]);
    expect(chronology.events[0]).toMatchObject({
      kind: 'route',
      title: '行车：同一服务区',
      location: '同一服务区',
      route: {
        from: '同一服务区',
        to: '同一服务区',
      },
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

      await writeJson(getSpansPath(projectRoot), [span({
        id: 'span-1',
        assetId: 'asset-1',
        materialPatterns: ['环境远景', '道路环境', '晴天', '无口播语音', '道路环境观察', '道路延伸', '周边景观'],
      })]);
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

      await writeJson(getSpansMetaPath(projectRoot), {
        schemaVersion: '1.0',
        status: 'pending-speech-review',
        generatedAt: '2026-04-12T09:10:00.000Z',
        inputsHash: 'pending-inputs',
        assetCount: 1,
        reportCount: 0,
        spanCount: 1,
        speechReview: {
          status: 'pending',
          candidateCount: 1,
          handoffPath: 'projects/project-chronology-build/.tmp/chronology/speech-window-agent-handoff.md',
        },
        warnings: [],
      });

      await expect(buildProjectChronology({ workspaceRoot, projectId }))
        .rejects.toThrow(/pending-speech-review.*Codex Agent speech-window review/u);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('blocks project chronology writes when reverse geocode service is explicitly unavailable', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'kairos-chronology-geocode-null-'));
    try {
      const projectId = 'project-chronology-geocode-null';
      const projectRoot = await initWorkspaceProject(workspaceRoot, projectId, 'Chronology Geocode Null');
      await writeJson(getAssetsPath(projectRoot), [asset('asset-1')]);
      await writeJson(getSpansPath(projectRoot), [span({
        id: 'span-1',
        assetId: 'asset-1',
        materialPatterns: ['环境远景', '道路环境', '晴天', '无口播语音', '道路环境观察', '道路延伸', '周边景观'],
      })]);
      await writeJson(getSpansMetaPath(projectRoot), {
        schemaVersion: '1.0',
        status: 'fresh',
        generatedAt: '2026-04-12T09:00:00.000Z',
        inputsHash: 'fresh-inputs',
        assetCount: 1,
        reportCount: 0,
        spanCount: 1,
        warnings: [],
      });

      await expect(buildProjectChronology({ workspaceRoot, projectId, reverseGeocodeService: null }))
        .rejects.toThrow(/requires GPS reverse-geocode service.*null service/u);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('blocks project chronology writes when GPS anchors cannot be reverse-geocoded', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'kairos-chronology-geocode-miss-'));
    try {
      const projectId = 'project-chronology-geocode-miss';
      const projectRoot = await initWorkspaceProject(workspaceRoot, projectId, 'Chronology Geocode Miss');
      await writeJson(getAssetsPath(projectRoot), [
        asset('asset-drive', {
          embeddedGps: embeddedGps('2026-04-12T08:00:00.000Z', 22.111111, 113.111111),
        }),
      ]);
      await writeJson(getSpansPath(projectRoot), [
        span({
          id: 'drive-span',
          assetId: 'asset-drive',
          type: 'drive',
          sourceInMs: 0,
          sourceOutMs: 60_000,
          materialPatterns: ['第一人称行车', '道路环境', '晴天', '无口播语音', '道路行车观察', '道路推进', '沿途景观'],
        }),
      ]);
      await writeJson(getSpansMetaPath(projectRoot), {
        schemaVersion: '1.0',
        status: 'fresh',
        generatedAt: '2026-04-12T09:00:00.000Z',
        inputsHash: 'fresh-inputs',
        assetCount: 1,
        reportCount: 0,
        spanCount: 1,
        warnings: [],
      });

      await expect(buildProjectChronology({ workspaceRoot, projectId }))
        .rejects.toThrow(/reverse-geocode failed/u);
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

function report(assetId: string, placeHint: string): IAssetCoarseReport {
  return {
    assetId,
    clipTypeGuess: 'broll',
    keepDecision: 'keep',
    densityScore: 0.5,
    pharosMatches: [],
    labels: [],
    placeHints: [placeHint],
    rootNotes: [],
    sampleFrames: [],
    interestingWindows: [],
    fineScanWindows: [],
    fineScanReasons: [],
    createdAt: '2026-05-05T11:00:00.000Z',
    updatedAt: '2026-05-05T11:00:00.000Z',
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
    actualCaptures: overrides.actualCaptures ?? [],
    actualTimeStart: overrides.actualTimeStart,
    actualTimeEnd: overrides.actualTimeEnd,
    status: overrides.status ?? 'expected',
    isExtraShot: overrides.isExtraShot ?? false,
  };
}

function point(time: string, lat: number, lng: number): { time: string; lat: number; lng: number } {
  return { time, lat, lng };
}

function fakeReverseGeocodeService(
  locations: Record<string, string>,
  calls: string[] = [],
): IReverseGeocodeService {
  return {
    async reverseGeocode(lat: number, lng: number): Promise<IReverseGeocodeCacheEntry> {
      const locationKey = formatReverseGeocodeLocationKey(lng, lat);
      calls.push(locationKey);
      const locationText = locations[locationKey];
      return {
        locationKey,
        lat,
        lng,
        provider: 'test',
        status: locationText ? 'ok' : 'empty',
        locationText,
        fetchedAt: '2026-04-12T09:00:00.000Z',
      };
    },
    async prewarm(points: Array<{ lat: number; lng: number }>): Promise<void> {
      for (const item of points) {
        await this.reverseGeocode(item.lat, item.lng);
      }
    },
  };
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
