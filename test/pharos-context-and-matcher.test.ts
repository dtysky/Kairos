import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type {
  IProjectPharosContext,
  IProjectPharosShot,
  IProjectPharosTripSummary,
} from '../src/protocol/schema.js';
import { buildProjectPharosContext } from '../src/modules/pharos/context.js';
import { matchAssetToPharos } from '../src/modules/pharos/matcher.js';

function makeTripSummary(overrides: Partial<IProjectPharosTripSummary> = {}): IProjectPharosTripSummary {
  return {
    tripId: 'trip-1',
    title: 'Trip 1',
    mustCount: 0,
    optionalCount: 0,
    pendingCount: 0,
    expectedCount: 0,
    unexpectedCount: 0,
    abandonedCount: 0,
    gpxCount: 0,
    warnings: [],
    ...overrides,
  };
}

function makeShot(overrides: Partial<IProjectPharosShot> = {}): IProjectPharosShot {
  return {
    ref: {
      tripId: 'trip-1',
      shotId: 'shot-1',
    },
    location: '陌上花公园',
    description: '人像拍摄',
    type: 'shot',
    devices: [],
    rolls: [],
    isExtraShot: false,
    ...overrides,
  };
}

function makeContext(shots: IProjectPharosShot[]): IProjectPharosContext {
  return {
    schemaVersion: '1.0',
    generatedAt: '2026-04-16T00:00:00.000Z',
    status: 'success',
    rootPath: '/tmp/pharos',
    discoveredTripIds: ['trip-1'],
    includedTripIds: ['trip-1'],
    warnings: [],
    errors: [],
    trips: [makeTripSummary()],
    shots,
    gpxFiles: [],
  };
}

describe('Pharos context + matcher', () => {
  it('uses record actual_time for continuous shots without planned time', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'kairos-pharos-context-'));
    try {
      const tripRoot = join(projectRoot, 'pharos', 'trip-1');
      await mkdir(tripRoot, { recursive: true });
      await writeFile(join(tripRoot, 'plan.json'), JSON.stringify({
        $schema: 'pharos/plan/1.0',
        trip_id: 'trip-1',
        title: 'Trip 1',
        timezone: 'Asia/Shanghai',
        days: [{
          day: 1,
          date: '2026-04-12',
          title: 'Day 1',
          shots: [{
            id: 'drive-1',
            location: '幸福港湾',
            description: '去程车拍',
            kind: 'continuous',
            priority: 'must',
          }],
        }],
      }, null, 2));
      await writeFile(join(tripRoot, 'record.json'), JSON.stringify({
        $schema: 'pharos/record/1.0',
        trip_id: 'trip-1',
        records: [{
          shot_id: 'drive-1',
          status: 'expected',
          actual_time: {
            start: '2026-04-12T08:00:00+08:00',
            end: '2026-04-12T08:20:00+08:00',
          },
        }],
      }, null, 2));

      const context = await buildProjectPharosContext({ projectRoot });
      expect(context.shots).toHaveLength(1);
      expect(context.shots[0]?.type).toBe('continuous');
      expect(context.shots[0]?.plannedTimeStart).toBeUndefined();
      expect(context.shots[0]?.actualTimeStart).toBe('2026-04-12T00:00:00.000Z');
      expect(context.shots[0]?.actualTimeEnd).toBe('2026-04-12T00:20:00.000Z');
      expect(context.warnings.some(item => item.includes('drive-1'))).toBe(false);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('warns when a planned shot has neither normalized planned nor record time', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'kairos-pharos-context-'));
    try {
      const tripRoot = join(projectRoot, 'pharos', 'trip-1');
      await mkdir(tripRoot, { recursive: true });
      await writeFile(join(tripRoot, 'plan.json'), JSON.stringify({
        $schema: 'pharos/plan/1.0',
        trip_id: 'trip-1',
        title: 'Trip 1',
        timezone: 'Asia/Shanghai',
        days: [{
          day: 1,
          date: '2026-04-12',
          title: 'Day 1',
          shots: [{
            id: 'drive-1',
            location: '幸福港湾',
            description: '去程车拍',
            type: 'continuous',
            priority: 'must',
          }],
        }],
      }, null, 2));

      const context = await buildProjectPharosContext({ projectRoot });
      expect(context.shots).toHaveLength(1);
      expect(context.shots[0]?.plannedTimeStart).toBeUndefined();
      expect(context.shots[0]?.actualTimeStart).toBeUndefined();
      expect(context.warnings.some(item => item.includes('drive-1') && item.includes('planned/record time'))).toBe(true);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('matches only exact executed actual_time windows without planned fallback or tolerance', () => {
    const context = makeContext([
      makeShot({
        ref: { tripId: 'trip-1', shotId: 'planned-overridden-by-actual' },
        status: 'expected',
        plannedTimeStart: '2026-04-12T10:00:00.000Z',
        plannedTimeEnd: '2026-04-12T10:30:00.000Z',
        actualTimeStart: '2026-04-12T20:00:00.000Z',
        actualTimeEnd: '2026-04-12T20:20:00.000Z',
        actualGpsStart: [10, 10],
        actualGpsEnd: [10, 10],
        device: 'ZV-E1',
      }),
      makeShot({
        ref: { tripId: 'trip-1', shotId: 'actual-correct' },
        status: 'expected',
        plannedTimeStart: '2026-04-12T12:00:00.000Z',
        plannedTimeEnd: '2026-04-12T12:30:00.000Z',
        actualTimeStart: '2026-04-12T10:05:00.000Z',
        actualTimeEnd: '2026-04-12T10:25:00.000Z',
        actualGpsStart: [113.95, 22.55],
        actualGpsEnd: [113.95, 22.55],
        device: 'ZV-E1',
      }),
      makeShot({
        ref: { tripId: 'trip-1', shotId: 'planned-fallback' },
        status: 'expected',
        location: '幸福港湾',
        description: '计划时间备用匹配',
        plannedTimeStart: '2026-04-12T10:00:00.000Z',
        plannedTimeEnd: '2026-04-12T10:30:00.000Z',
        device: 'ZV-E1',
      }),
      makeShot({
        ref: { tripId: 'trip-1', shotId: 'end-tolerance-old-bug' },
        status: 'expected',
        actualTimeStart: '2026-04-12T09:50:00.000Z',
        actualTimeEnd: '2026-04-12T10:14:59.999Z',
        device: 'ZV-E1',
      }),
      makeShot({
        ref: { tripId: 'trip-1', shotId: 'abandoned-planned-covering' },
        status: 'abandoned',
        plannedTimeStart: '2026-04-12T10:00:00.000Z',
        plannedTimeEnd: '2026-04-12T10:30:00.000Z',
        actualTimeStart: '2026-04-12T10:05:00.000Z',
        actualTimeEnd: '2026-04-12T10:25:00.000Z',
        device: 'ZV-E1',
      }),
    ]);

    const matches = matchAssetToPharos({
      asset: {
        sourcePath: 'DCIM/100MSDCF/C0001.MP4',
        capturedAt: '2026-04-12T10:15:00.000Z',
        metadata: {
          cameraModel: 'Sony ZV-E1',
        },
      },
      context,
      report: {
        clipTypeGuess: 'unknown',
        summary: '陌上花公园人像拍摄',
        placeHints: ['陌上花公园'],
        labels: ['portrait'],
      },
    });

    expect(matches[0]?.ref.shotId).toBe('actual-correct');
    expect(matches[0]?.matchReasons).toContain('actual-time:within-window');
    expect(matches[0]?.shotLocation).toBe('陌上花公园');
    expect(matches.some(match => match.ref.shotId === 'planned-fallback')).toBe(false);
    expect(matches.some(match => match.ref.shotId === 'planned-overridden-by-actual')).toBe(false);
    expect(matches.some(match => match.ref.shotId === 'end-tolerance-old-bug')).toBe(false);
    expect(matches.some(match => match.ref.shotId === 'abandoned-planned-covering')).toBe(false);
  });

  it('keeps multiple exact actual-time candidates and ranks the primary first', () => {
    const context = makeContext([
      makeShot({
        ref: { tripId: 'trip-1', shotId: 'continuous-drive' },
        status: 'unexpected',
        type: 'continuous',
        location: '深圳到南宁',
        description: '全程行车记录',
        actualTimeStart: '2026-04-12T10:00:00.000Z',
        actualTimeEnd: '2026-04-12T11:00:00.000Z',
        devices: ['ZV-E1'],
      }),
      makeShot({
        ref: { tripId: 'trip-1', shotId: 'event-covering' },
        status: 'expected',
        type: 'event',
        location: '出发点',
        description: '出发口播',
        actualTimeStart: '2026-04-12T10:10:00.000Z',
        actualTimeEnd: '2026-04-12T10:20:00.000Z',
      }),
    ]);

    const matches = matchAssetToPharos({
      asset: {
        sourcePath: 'zve1/day0/C0001.MP4',
        capturedAt: '2026-04-12T10:15:00.000Z',
        metadata: {
          cameraModel: 'Sony ZV-E1',
        },
      },
      context,
      report: {
        clipTypeGuess: 'drive',
        summary: '开车从深圳去南宁',
        placeHints: ['深圳到南宁'],
        labels: ['drive'],
      },
    });

    expect(matches.map(match => match.ref.shotId)).toEqual(['continuous-drive', 'event-covering']);
    expect(matches[0]?.shotKind).toBe('continuous');
    expect(matches[0]?.matchReasons).toEqual(expect.arrayContaining([
      'actual-time:within-window',
      'device:zv',
      'clip-type:drive',
    ]));
  });
});
