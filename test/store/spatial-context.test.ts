import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getManualItineraryPath,
  initWorkspaceProject,
  loadManualItinerary,
} from '../../src/store/index.js';

const workspaces: string[] = [];

afterEach(async () => {
  await Promise.all(
    workspaces.splice(0).map(path => rm(path, { recursive: true, force: true })),
  );
});

async function createWorkspace(): Promise<string> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'kairos-spatial-context-test-'));
  workspaces.push(workspaceRoot);
  return workspaceRoot;
}

describe('loadManualItinerary', () => {
  it('splits date-led natural-language lines into separate itinerary segments', async () => {
    const workspaceRoot = await createWorkspace();
    const projectRoot = await initWorkspaceProject(workspaceRoot, 'project-a', 'Test Project');

    await writeFile(
      getManualItineraryPath(projectRoot),
      [
        '2026.02.07，凌晨0点0分到下午4点4分，从广州乘坐航班前往新西兰奥克兰',
        '2026.02.07，下午4点4分到晚上9点43分，开车抵达新西兰奥克兰-Saint Marys Bay，沿途拍摄与记录（79 Westhaven Drive）',
        '2026.02.21，上午11点24分到下午13点26，基督城机场候机',
        '2026.02.21，下午13点26到下午16点36，基督城飞完奥克兰机场',
      ].join('\n'),
      'utf-8',
    );

    const itinerary = await loadManualItinerary(projectRoot);

    expect(itinerary.warnings).toEqual([]);
    expect(itinerary.segments).toHaveLength(4);
    expect(itinerary.segments[0]).toEqual(expect.objectContaining({
      date: '2026-02-07',
      startLocalTime: '00:00',
      endLocalTime: '16:04',
      to: '新西兰奥克兰',
      transport: 'flight',
    }));
    expect(itinerary.segments[1]).toEqual(expect.objectContaining({
      date: '2026-02-07',
      startLocalTime: '16:04',
      endLocalTime: '21:43',
      to: '新西兰奥克兰-Saint Marys Bay',
      transport: 'drive',
    }));
    expect(itinerary.segments[2]).toEqual(expect.objectContaining({
      date: '2026-02-21',
      startLocalTime: '11:24',
      endLocalTime: '13:26',
      location: '基督城机场',
    }));
    expect(itinerary.segments[3]).toEqual(expect.objectContaining({
      date: '2026-02-21',
      startLocalTime: '13:26',
      endLocalTime: '16:36',
      from: '基督城',
      to: '奥克兰机场',
      transport: 'flight',
    }));
  });
});
