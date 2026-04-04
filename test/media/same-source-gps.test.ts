import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bindAssetToFlightRecordPoints,
  installFlightRecordFetchGlobals,
  isLikelyDjiFlightRecordHeader,
  loadEmbeddedGpsBindingPoints,
  loadSameSourceTrackPoints,
  pickNearestEmbeddedGpsBindingPoint,
  prepareRootSameSourceGpsContext,
  resolveFlightRecordApiKey,
  resolveSidecarSrtBinding,
  sanitizeFlightRecordPoints,
} from '../../src/modules/media/same-source-gps.js';

const tempRoots: string[] = [];
const originalKairosDjiKey = process.env.KAIROS_DJI_OPEN_API_KEY;
const originalDjiKey = process.env.DJI_OPEN_API_KEY;
const originalFetch = globalThis.fetch;
const originalHeaders = globalThis.Headers;
const originalRequest = globalThis.Request;
const originalResponse = globalThis.Response;

afterEach(async () => {
  process.env.KAIROS_DJI_OPEN_API_KEY = originalKairosDjiKey;
  process.env.DJI_OPEN_API_KEY = originalDjiKey;
  globalThis.fetch = originalFetch;
  globalThis.Headers = originalHeaders;
  globalThis.Request = originalRequest;
  globalThis.Response = originalResponse;
  await Promise.all(
    tempRoots.splice(0).map(path => rm(path, { recursive: true, force: true })),
  );
});

async function createTempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'kairos-same-source-gps-test-'));
  tempRoots.push(root);
  return root;
}

describe('same-source GPS binding', () => {
  it('binds same-basename DJI SRT as sidecar embedded GPS', async () => {
    const root = await createTempRoot();
    const localPath = join(root, 'DJI_0001.MP4');
    await writeFile(localPath, '');
    await writeFile(join(root, 'DJI_0001.SRT'), [
      '1',
      '00:00:00,000 --> 00:00:00,500',
      '[latitude: -45.030230] [longitude: 168.662710]',
      '',
      '2',
      '00:00:02,000 --> 00:00:02,500',
      '[latitude: -45.030220] [longitude: 168.662700]',
      '',
    ].join('\n'), 'utf-8');

    const result = await resolveSidecarSrtBinding(
      {
        kind: 'video',
        capturedAt: '2026-02-17T03:20:12.000Z',
        durationMs: 10_000,
        displayName: 'DJI_0001.MP4',
        sourcePath: 'DJI_0001.MP4',
      },
      localPath,
      {
        projectRoot: root,
        trackIdentityKey: 'root-1:DJI_0001.MP4',
      },
    );

    expect(result.warnings).toEqual([]);
    expect(result.binding).toEqual(expect.objectContaining({
      originType: 'sidecar-srt',
      representativeTime: '2026-02-17T03:20:14.000Z',
      representativeLat: -45.03022,
      representativeLng: 168.6627,
      pointCount: 2,
      startTime: '2026-02-17T03:20:12.000Z',
      endTime: '2026-02-17T03:20:14.000Z',
      sourcePath: join(root, 'DJI_0001.SRT'),
    }));
    expect(result.binding?.trackId).toMatch(/^sidecar-srt-/u);
    expect(result.binding?.points).toBeUndefined();

    const cachedPoints = await loadSameSourceTrackPoints(root, result.binding!.trackId!);
    expect(cachedPoints).toHaveLength(2);

    const nearestPoint = await pickNearestEmbeddedGpsBindingPoint({
      projectRoot: root,
      binding: result.binding!,
      targetTime: '2026-02-17T03:20:13.900Z',
      toleranceMs: 5_000,
    });
    expect(nearestPoint).toEqual({
      time: '2026-02-17T03:20:14.000Z',
      lat: -45.03022,
      lng: 168.6627,
    });
  });

  it('cuts DJI flight record points to the asset time window', () => {
    const binding = bindAssetToFlightRecordPoints(
      {
        kind: 'video',
        capturedAt: '2026-02-17T03:20:12.000Z',
        durationMs: 10_000,
        displayName: 'DJI_0001.MP4',
        sourcePath: 'DJI_0001.MP4',
      },
      [
        {
          time: '2026-02-17T03:20:08.000Z',
          lat: -45.03023,
          lng: 168.66271,
          trackId: 'flight-record-a',
          sourcePath: 'FlightRecord/DJIFlightRecord_001.txt',
        },
        {
          time: '2026-02-17T03:20:17.000Z',
          lat: -45.0301,
          lng: 168.6626,
          trackId: 'flight-record-a',
          sourcePath: 'FlightRecord/DJIFlightRecord_001.txt',
        },
        {
          time: '2026-02-17T03:20:24.000Z',
          lat: -45.0299,
          lng: 168.6625,
          trackId: 'flight-record-a',
          sourcePath: 'FlightRecord/DJIFlightRecord_001.txt',
        },
      ],
    );

    expect(binding).toEqual(expect.objectContaining({
      originType: 'flight-record',
      representativeTime: '2026-02-17T03:20:17.000Z',
      representativeLat: -45.0301,
      representativeLng: 168.6626,
      trackId: 'flight-record-a',
      pointCount: 3,
      startTime: '2026-02-17T03:20:08.000Z',
      endTime: '2026-02-17T03:20:24.000Z',
      sourcePath: 'FlightRecord/DJIFlightRecord_001.txt',
    }));
    expect(binding?.points).toBeUndefined();
  });

  it('drops sparse FlightRecord time outliers around the dominant capture window', () => {
    const sanitized = sanitizeFlightRecordPoints([
      {
        time: '1970-01-01T00:00:00.000Z',
        lat: -45.55264,
        lng: 168.51069,
        trackId: 'flight-record-a',
        sourcePath: 'FlightRecord/DJIFlightRecord_001.txt',
      },
      {
        time: '2026-02-16T21:17:08.130Z',
        lat: -45.55264,
        lng: 168.51069,
        trackId: 'flight-record-a',
        sourcePath: 'FlightRecord/DJIFlightRecord_001.txt',
      },
      {
        time: '2026-02-16T21:17:08.234Z',
        lat: -45.55264,
        lng: 168.51069,
        trackId: 'flight-record-a',
        sourcePath: 'FlightRecord/DJIFlightRecord_001.txt',
      },
      {
        time: '2026-02-16T21:17:08.335Z',
        lat: -45.55264,
        lng: 168.51069,
        trackId: 'flight-record-a',
        sourcePath: 'FlightRecord/DJIFlightRecord_001.txt',
      },
      {
        time: '2031-12-28T10:18:35.225Z',
        lat: -45.55264,
        lng: 168.5107,
        trackId: 'flight-record-a',
        sourcePath: 'FlightRecord/DJIFlightRecord_001.txt',
      },
    ]);

    expect(sanitized).toEqual([
      {
        time: '2026-02-16T21:17:08.130Z',
        lat: -45.55264,
        lng: 168.51069,
        trackId: 'flight-record-a',
        sourcePath: 'FlightRecord/DJIFlightRecord_001.txt',
      },
      {
        time: '2026-02-16T21:17:08.234Z',
        lat: -45.55264,
        lng: 168.51069,
        trackId: 'flight-record-a',
        sourcePath: 'FlightRecord/DJIFlightRecord_001.txt',
      },
      {
        time: '2026-02-16T21:17:08.335Z',
        lat: -45.55264,
        lng: 168.51069,
        trackId: 'flight-record-a',
        sourcePath: 'FlightRecord/DJIFlightRecord_001.txt',
      },
    ]);
  });

  it('recognizes DJI flight record by header instead of filename', () => {
    const header = new Uint8Array(100);
    header.set([41, 3, 0, 0, 0, 0, 0, 0, 180, 1, 14, 1], 0);

    expect(isLikelyDjiFlightRecordHeader(header)).toBe(true);
    expect(
      isLikelyDjiFlightRecordHeader(
        new TextEncoder().encode('FlightRecord_2026-02-17_[05-17-08].txt'),
      ),
    ).toBe(false);
  });

  it('discovers flight record candidates by header even with generic filenames', async () => {
    const root = await createTempRoot();
    const header = new Uint8Array(128);
    header.set([41, 3, 0, 0, 0, 0, 0, 0, 180, 1, 14, 1], 0);
    await writeFile(join(root, 'FlightRecord_2026-02-17_[05-17-08].txt'), Buffer.from(header));

    const result = await prepareRootSameSourceGpsContext({
      projectRoot: root,
      flightRecordPath: root,
    });

    expect(result.warnings.some(warning => warning.includes('未找到可识别'))).toBe(false);
    expect(result.warnings.some(warning => warning.includes('解析失败'))).toBe(true);
  });

  it('prefers runtime-config DJI API key over environment variables', () => {
    process.env.KAIROS_DJI_OPEN_API_KEY = 'env-kairos-key';
    process.env.DJI_OPEN_API_KEY = 'env-dji-key';

    expect(resolveFlightRecordApiKey('runtime-config-key')).toBe('runtime-config-key');
    expect(resolveFlightRecordApiKey()).toBe('env-kairos-key');
  });

  it('falls back to legacy inline points when loading embedded GPS bindings', async () => {
    const points = await loadEmbeddedGpsBindingPoints('/unused-project-root', {
      points: [{
        time: '2026-02-17T03:20:12.000Z',
        lat: -45.03023,
        lng: 168.66271,
      }, {
        time: '2026-02-17T03:20:14.000Z',
        lat: -45.03022,
        lng: 168.6627,
      }],
    });

    expect(points).toEqual([
      {
        time: '2026-02-17T03:20:12.000Z',
        lat: -45.03023,
        lng: 168.66271,
      },
      {
        time: '2026-02-17T03:20:14.000Z',
        lat: -45.03022,
        lng: 168.6627,
      },
    ]);
  });

  it('installs full fetch globals for Node 16 flight record decryption', () => {
    globalThis.fetch = undefined as typeof fetch;
    globalThis.Headers = undefined as typeof Headers;
    globalThis.Request = undefined as typeof Request;
    globalThis.Response = undefined as typeof Response;

    installFlightRecordFetchGlobals();

    expect(typeof globalThis.fetch).toBe('function');
    expect(typeof globalThis.Headers).toBe('function');
    expect(typeof globalThis.Request).toBe('function');
    expect(typeof globalThis.Response).toBe('function');
  });
});
