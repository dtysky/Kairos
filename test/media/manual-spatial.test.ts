import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadManualItinerary } from '../../src/store/spatial-context.js';
import { inferManualItineraryGps } from '../../src/modules/media/manual-spatial.js';

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map(path => rm(path, { recursive: true, force: true })),
  );
});

async function createProjectRoot(): Promise<string> {
  const projectRoot = await mkdtemp(join(tmpdir(), 'kairos-manual-spatial-'));
  tempRoots.push(projectRoot);
  await mkdir(join(projectRoot, 'config'), { recursive: true });
  return projectRoot;
}

describe('manual itinerary redesign', () => {
  it('parses natural language one-line itinerary entries', async () => {
    const projectRoot = await createProjectRoot();
    await writeFile(
      join(projectRoot, 'config/manual-itinerary.md'),
      '2026.02.17，早上九点左右，开车从新西兰皇后镇出发\n',
      'utf-8',
    );

    const result = await loadManualItinerary(projectRoot);
    expect(result.warnings).toEqual([]);
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0]).toEqual(expect.objectContaining({
      date: '2026-02-17',
      startLocalTime: '08:15',
      endLocalTime: '09:45',
      from: '新西兰皇后镇',
      transport: 'drive',
    }));
  });

  it('ignores timezone fields in manual-itinerary markdown', async () => {
    const projectRoot = await createProjectRoot();
    await writeFile(join(projectRoot, 'config/manual-itinerary.md'), [
      '默认时区: Pacific/Auckland',
      '',
      '日期: 2026-03-31',
      '时间: 16:00-17:00',
      '地点: 北京市天安门',
      '时区: Asia/Shanghai',
    ].join('\n'), 'utf-8');

    const result = await loadManualItinerary(projectRoot);
    expect(result).not.toHaveProperty('defaultTimezone');
    expect(result.warnings).toEqual([]);
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0]).not.toHaveProperty('timezone');
  });

  it('builds one inferred GPS from matched manual itinerary segment', async () => {
    const result = await inferManualItineraryGps({
      asset: {
        capturedAt: '2026-03-31T08:15:30.000Z',
        sourcePath: 'travel/day1/clip.mp4',
      },
      itinerary: {
        warnings: [],
        segments: [{
          id: 'seg-1',
          date: '2026-03-31',
          startLocalTime: '16:00',
          endLocalTime: '17:00',
          location: '北京市天安门',
        }],
      },
      resolveTimezoneFromLocation: async location => (
        location === '北京市天安门' ? 'Asia/Shanghai' : null
      ),
      geocodeLocation: async location => (
        location === '北京市天安门'
          ? { lat: 39.909187, lng: 116.397463 }
          : null
      ),
    });

    expect(result?.inferredGps).toEqual(expect.objectContaining({
      source: 'derived-track',
      derivedOriginType: 'manual-itinerary-derived',
      lat: 39.909187,
      lng: 116.397463,
      timezone: 'Asia/Shanghai',
      matchedItinerarySegmentId: 'seg-1',
    }));
    expect(result?.locationCandidates).toEqual([{
      role: 'point',
      lat: 39.909187,
      lng: 116.397463,
    }]);
  });
});
