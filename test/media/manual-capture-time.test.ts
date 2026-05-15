import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  initWorkspaceProject,
  loadReviewQueue,
  upsertReviewItems,
} from '../../src/store/index.js';
import {
  loadManualCaptureTimeOverrides,
  syncManualCaptureTimeBlockers,
} from '../../src/modules/media/manual-capture-time.js';

const workspaces: string[] = [];

afterEach(async () => {
  await Promise.all(
    workspaces.splice(0).map(path => rm(path, { recursive: true, force: true })),
  );
});

async function createWorkspace(): Promise<string> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'kairos-manual-capture-time-test-'));
  workspaces.push(workspaceRoot);
  return workspaceRoot;
}

describe('manual capture time table', () => {
  it('appends a blocker table to manual-itinerary and parses user-filled overrides', async () => {
    const workspaceRoot = await createWorkspace();
    const projectRoot = await initWorkspaceProject(workspaceRoot, 'project-a', 'Test Project');
    const itineraryPath = join(projectRoot, 'config/manual-itinerary.md');

    await writeFile(
      itineraryPath,
      '2026.02.17，上午10点，在新西兰皇后镇拍摄\n',
      'utf-8',
    );

    await syncManualCaptureTimeBlockers(projectRoot, [{
      rootRef: 'root-1',
      sourcePath: 'day11/DJI_0019_D.mp4',
      currentCapturedAt: '2026-02-22T08:30:09.000Z',
      currentSource: 'filesystem',
      suggestedDate: '2026-02-17',
      suggestedTime: '04:17:13',
      timezone: 'Pacific/Auckland',
      note: '文件名日期与当前时间相差 5 天',
    }]);

    const withTable = await readFile(itineraryPath, 'utf-8');
    expect(withTable).toContain('## 素材时间校正');
    expect(withTable).toContain('day11/DJI_0019_D.mp4');

    const filled = withTable.replace(
      '| 待填写 | root-1 | day11/DJI_0019_D.mp4 | 2026-02-22T08:30:09.000Z | filesystem | 2026-02-17 | 04:17:13 |  |  |  | Pacific/Auckland | 文件名日期与当前时间相差 5 天 |',
      '| 已填写 | root-1 | day11/DJI_0019_D.mp4 | 2026-02-22T08:30:09.000Z | filesystem | 2026-02-17 | 04:17:13 |  |  | 04:17:13 | Pacific/Auckland | 文件名日期与当前时间相差 5 天 |',
    );
    await writeFile(itineraryPath, filled, 'utf-8');

    const overrides = await loadManualCaptureTimeOverrides(projectRoot);
    expect(overrides).toEqual([expect.objectContaining({
      rootRef: 'root-1',
      sourcePath: 'day11/DJI_0019_D.mp4',
      timezone: 'Pacific/Auckland',
      correctedDate: '2026-02-17',
      correctedTime: '04:17:13',
      capturedAt: '2026-02-16T15:17:13.000Z',
    })]);
  });

  it('preserves user-filled rows even when they are no longer active blockers', async () => {
    const workspaceRoot = await createWorkspace();
    const projectRoot = await initWorkspaceProject(workspaceRoot, 'project-b', 'Test Project');
    const itineraryPath = join(projectRoot, 'config/manual-itinerary.md');

    await writeFile(
      itineraryPath,
      [
        '2026-02-07 从广州白云机场飞往奥克兰，航班上拍摄夜转日。',
        '',
        '## 素材时间校正',
        '',
        '以下素材的拍摄时间和项目时间线明显不一致。请优先填写“正确时间 / 时区”；如可推导，系统会自动补齐正确日期。未解决的行会阻塞后续 Analyze。',
        '',
        '| 状态 | 素材源 | 路径 | 当前时间UTC | 当前来源 | 建议日期 | 建议时间 | 正确日期 | 正确时间 | 时区 | 备注 |',
        '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
        '| 已填写 | root-ts | 20260212_基督城朝霞.mp4 | 2026-02-26T06:29:45.000Z | container | 2026-02-12 | 06:13:23 |  | 06:13:23 | Pacific/Auckland | 用户提供 TS 文件时间映射 |',
      ].join('\n'),
      'utf-8',
    );

    await syncManualCaptureTimeBlockers(projectRoot, [{
      rootRef: 'root-1',
      sourcePath: 'day11/DJI_0019_D.mp4',
      currentCapturedAt: '2026-02-22T08:30:09.000Z',
      currentSource: 'filesystem',
      suggestedDate: '2026-02-17',
      suggestedTime: '04:17:13',
      timezone: 'Pacific/Auckland',
      note: '文件名日期与当前时间相差 5 天',
    }]);

    const next = await readFile(itineraryPath, 'utf-8');
    expect(next).toContain('2026-02-07 从广州白云机场飞往奥克兰，航班上拍摄夜转日。');
    expect(next).toContain('| 已填写 | root-ts | 20260212_基督城朝霞.mp4 | 2026-02-26T06:29:45.000Z | container | 2026-02-12 | 06:13:23 |  | 2026-02-12 | 06:13:23 | Pacific/Auckland | 用户提供 TS 文件时间映射 |');
    expect(next).toContain('day11/DJI_0019_D.mp4');
  });

  it('requires an explicit date for manual-required capture time rows', async () => {
    const workspaceRoot = await createWorkspace();
    const projectRoot = await initWorkspaceProject(workspaceRoot, 'project-explicit-date', 'Test Project');

    await syncManualCaptureTimeBlockers(projectRoot, [{
      rootRef: 'root-ts',
      sourcePath: 'timelapse.mp4',
      currentCapturedAt: '2026-05-07T09:00:00.000Z',
      currentSource: 'container',
      suggestedDate: '2026-05-01',
      suggestedTime: '06:00:00',
      timezone: 'Asia/Shanghai',
      requiresExplicitDate: true,
      note: '延时视频导出时间不可信，必须人工确认拍摄日期和时间',
    }]);

    const itineraryPath = join(projectRoot, 'config/manual-itinerary.md');
    const withTable = await readFile(itineraryPath, 'utf-8');
    expect(withTable).toContain('| 待填写 | root-ts | timelapse.mp4 | 2026-05-07T09:00:00.000Z | container | 2026-05-01 | 06:00:00 | 是 |');

    const timeOnly = withTable.replace(
      '| 待填写 | root-ts | timelapse.mp4 | 2026-05-07T09:00:00.000Z | container | 2026-05-01 | 06:00:00 | 是 |  |  | Asia/Shanghai | 延时视频导出时间不可信，必须人工确认拍摄日期和时间 |',
      '| 已填写 | root-ts | timelapse.mp4 | 2026-05-07T09:00:00.000Z | container | 2026-05-01 | 06:00:00 | 是 |  | 06:00:00 | Asia/Shanghai | 延时视频导出时间不可信，必须人工确认拍摄日期和时间 |',
    );
    await writeFile(itineraryPath, timeOnly, 'utf-8');
    await expect(loadManualCaptureTimeOverrides(projectRoot)).resolves.toEqual([]);

    const fullyFilled = timeOnly.replace('| 是 |  | 06:00:00 |', '| 是 | 2026-05-01 | 06:00:00 |');
    await writeFile(itineraryPath, fullyFilled, 'utf-8');
    const overrides = await loadManualCaptureTimeOverrides(projectRoot);
    expect(overrides[0]).toEqual(expect.objectContaining({
      rootRef: 'root-ts',
      sourcePath: 'timelapse.mp4',
      correctedDate: '2026-05-01',
      correctedTime: '06:00:00',
    }));
  });

  it('does not mirror capture-time blockers into the generic review queue', async () => {
    const workspaceRoot = await createWorkspace();
    const projectRoot = await initWorkspaceProject(workspaceRoot, 'project-review-dedup', 'Test Project');

    await upsertReviewItems(projectRoot, [{
      id: 'capture-time:old',
      projectId: 'project-review-dedup',
      kind: 'capture-time-correction',
      stage: 'ingest',
      status: 'open',
      title: '旧时间校正镜像',
      reason: 'stale',
      sourcePath: 'old.mp4',
      createdAt: '2026-05-01T00:00:00.000Z',
      updatedAt: '2026-05-01T00:00:00.000Z',
    }, {
      id: 'review:keep',
      projectId: 'project-review-dedup',
      kind: 'generic',
      stage: 'ingest',
      status: 'open',
      title: '保留其他 review',
      reason: 'needs input',
      createdAt: '2026-05-01T00:00:00.000Z',
      updatedAt: '2026-05-01T00:00:00.000Z',
    }]);

    await syncManualCaptureTimeBlockers(projectRoot, [{
      rootRef: 'root-ts',
      sourcePath: 'timelapse.mp4',
      currentCapturedAt: '2026-05-07T09:00:00.000Z',
      currentSource: 'container',
      timezone: 'Asia/Shanghai',
      requiresExplicitDate: true,
      note: '延时视频导出时间不可信，必须人工确认拍摄日期和时间',
    }]);

    const queue = await loadReviewQueue(projectRoot);
    expect(queue.items).toEqual([
      expect.objectContaining({
        id: 'review:keep',
        kind: 'generic',
      }),
    ]);
  });
});
