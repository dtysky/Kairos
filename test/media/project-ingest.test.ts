import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  initWorkspaceProject,
  loadAssets,
  loadIngestRoots,
  loadProjectDeviceMediaMaps,
  loadProjectDerivedTrack,
  loadProjectSameSourceGpsIndex,
  saveDeviceProjectMap,
  writeJson,
  writeWorkspaceProjectBrief,
} from '../../src/store/index.js';
import { ingestWorkspaceProjectMedia } from '../../src/modules/media/project-ingest.js';
import { loadSameSourceTrackPoints } from '../../src/modules/media/same-source-gps.js';

const workspaces: string[] = [];

afterEach(async () => {
  await Promise.all(
    workspaces.splice(0).map(path => rm(path, { recursive: true, force: true })),
  );
});

async function createWorkspace(): Promise<string> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'kairos-ingest-test-'));
  workspaces.push(workspaceRoot);
  return workspaceRoot;
}

describe('ingestWorkspaceProjectMedia', () => {
  it('binds same-stem protection audio without reopening generic audio ingest', async () => {
    const workspaceRoot = await createWorkspace();
    const projectId = 'project-protection-audio';
    const projectRoot = await initWorkspaceProject(workspaceRoot, projectId, 'Test Project');
    const mediaRoot = join(workspaceRoot, 'media-root');

    await mkdir(mediaRoot, { recursive: true });
    await writeFile(join(mediaRoot, 'A001.mp4'), '');
    await writeFile(join(mediaRoot, 'A001.wav'), '');
    await writeWorkspaceProjectBrief(workspaceRoot, projectId, [
      {
        path: mediaRoot,
        description: '主机位素材',
      },
    ]);

    const result = await ingestWorkspaceProjectMedia({
      workspaceRoot,
      projectId,
    });

    expect(result.scannedRoots[0]).toMatchObject({
      localPath: mediaRoot,
      scannedFileCount: 1,
    });

    const assets = await loadAssets(projectRoot);
    expect(assets).toHaveLength(1);
    expect(assets[0]?.sourcePath).toBe('A001.mp4');
    expect(assets[0]?.protectionAudio).toMatchObject({
      sourcePath: 'A001.wav',
      displayName: 'A001.wav',
      alignment: 'unknown',
    });
  });

  it('binds sidecar SRT as embedded GPS during ingest', async () => {
    const workspaceRoot = await createWorkspace();
    const projectId = 'project-sidecar-srt';
    const projectRoot = await initWorkspaceProject(workspaceRoot, projectId, 'Test Project');
    const mediaRoot = join(workspaceRoot, 'media-root');

    await mkdir(mediaRoot, { recursive: true });
    await writeFile(join(mediaRoot, 'DJI_0001.MP4'), '');
    await writeFile(join(mediaRoot, 'DJI_0001.SRT'), [
      '1',
      '00:00:00,000 --> 00:00:00,500',
      '[latitude: -45.030230] [longitude: 168.662710]',
      '',
      '2',
      '00:00:01,000 --> 00:00:01,500',
      '[latitude: -45.030220] [longitude: 168.662700]',
      '',
    ].join('\n'), 'utf-8');
    await writeWorkspaceProjectBrief(workspaceRoot, projectId, [
      {
        path: mediaRoot,
        description: '无人机素材',
      },
    ]);

    const result = await ingestWorkspaceProjectMedia({
      workspaceRoot,
      projectId,
    });

    expect(result.warnings).toEqual([]);
    const assets = await loadAssets(projectRoot);
    expect(assets[0]?.embeddedGps).toEqual(expect.objectContaining({
      originType: 'sidecar-srt',
      pointCount: 2,
      sourcePath: join(mediaRoot, 'DJI_0001.SRT'),
    }));
    expect(assets[0]?.embeddedGps?.trackId).toMatch(/^sidecar-srt-/u);
    expect(assets[0]?.embeddedGps?.points).toBeUndefined();

    const sameSourceIndex = await loadProjectSameSourceGpsIndex(projectRoot);
    expect(sameSourceIndex?.trackCount).toBe(1);
    expect(sameSourceIndex?.tracks[0]).toEqual(expect.objectContaining({
      id: assets[0]?.embeddedGps?.trackId,
      originType: 'sidecar-srt',
      pointCount: 2,
      sourcePath: join(mediaRoot, 'DJI_0001.SRT'),
    }));

    const cachedPoints = await loadSameSourceTrackPoints(projectRoot, assets[0]!.embeddedGps!.trackId!);
    expect(cachedPoints).toHaveLength(2);

    const derivedTrack = await loadProjectDerivedTrack(projectRoot);
    expect(derivedTrack?.entries[0]).toEqual(expect.objectContaining({
      originType: 'embedded-derived',
      sourceAssetId: assets[0]?.id,
    }));
  });

  it('refreshes project-derived-track cache during ingest', async () => {
    const workspaceRoot = await createWorkspace();
    const projectId = 'project-derived-track';
    const projectRoot = await initWorkspaceProject(workspaceRoot, projectId, 'Test Project');

    await writeFile(
      join(projectRoot, 'config/manual-itinerary.md'),
      '2026.03.31，下午四点，在北京市天安门拍摄\n',
      'utf-8',
    );

    await ingestWorkspaceProjectMedia({
      workspaceRoot,
      projectId,
      resolveTimezoneFromLocation: async location => (
        location === '北京市天安门' ? 'Asia/Shanghai' : null
      ),
      geocodeLocation: async location => (
        location === '北京市天安门'
          ? { lat: 39.909187, lng: 116.397463 }
          : null
      ),
    });

    const derivedTrack = await loadProjectDerivedTrack(projectRoot);
    expect(derivedTrack).toEqual(expect.objectContaining({
      entryCount: 1,
    }));
    expect(derivedTrack?.entries[0]).toEqual(expect.objectContaining({
      originType: 'manual-itinerary-derived',
      matchedItinerarySegmentId: 'manual-itinerary-1',
    }));
  });

  it('syncs project brief into project-local mappings before ingest', async () => {
    const workspaceRoot = await createWorkspace();
    const projectId = 'project-brief-driven';
    const projectRoot = await initWorkspaceProject(workspaceRoot, projectId, 'Test Project');
    const mediaRoot = join(workspaceRoot, 'media-root');

    await mkdir(mediaRoot, { recursive: true });
    await writeFile(join(mediaRoot, 'clip.mp4'), '');
    await writeWorkspaceProjectBrief(workspaceRoot, projectId, [
      {
        path: mediaRoot,
        description: '主机位素材',
      },
    ]);

    const result = await ingestWorkspaceProjectMedia({
      workspaceRoot,
      projectId,
    });

    expect(result.missingRoots).toEqual([]);
    expect(result.scannedRoots).toHaveLength(1);
    expect(result.scannedRoots[0]).toMatchObject({
      localPath: mediaRoot,
      scannedFileCount: 1,
    });

    const ingestRoots = await loadIngestRoots(projectRoot);
    expect(ingestRoots.roots).toHaveLength(1);

    const deviceMaps = await loadProjectDeviceMediaMaps(projectRoot);
    expect(deviceMaps.projects[projectId]?.roots).toEqual([
      {
        rootId: ingestRoots.roots[0]!.id,
        localPath: mediaRoot,
      },
    ]);

    const assets = await loadAssets(projectRoot);
    expect(assets).toHaveLength(1);
    expect(assets[0]?.ingestRootId).toBe(ingestRoots.roots[0]!.id);
  });

  it('excludes nested rawLocalPath from ingest scan', async () => {
    const workspaceRoot = await createWorkspace();
    const projectId = 'project-nested-raw';
    const projectRoot = await initWorkspaceProject(workspaceRoot, projectId, 'Nested Raw Project');
    const mediaRoot = join(workspaceRoot, 'media-root');
    const rawRoot = join(mediaRoot, 'raw');

    await mkdir(rawRoot, { recursive: true });
    await writeFile(join(mediaRoot, 'graded.mp4'), '');
    await writeFile(join(rawRoot, 'source.mov'), '');
    await writeWorkspaceProjectBrief(workspaceRoot, projectId, [
      {
        path: mediaRoot,
        rawPath: rawRoot,
        description: '主机位素材',
      },
    ]);

    const result = await ingestWorkspaceProjectMedia({
      workspaceRoot,
      projectId,
    });

    expect(result.scannedRoots[0]).toMatchObject({
      localPath: mediaRoot,
      scannedFileCount: 1,
    });

    const assets = await loadAssets(projectRoot);
    expect(assets).toHaveLength(1);
    expect(assets[0]?.sourcePath).toBe('graded.mp4');
  });

  it('keeps scanning current root when rawLocalPath is outside current root', async () => {
    const workspaceRoot = await createWorkspace();
    const projectId = 'project-external-raw';
    const projectRoot = await initWorkspaceProject(workspaceRoot, projectId, 'External Raw Project');
    const mediaRoot = join(workspaceRoot, 'media-root');
    const rawRoot = join(workspaceRoot, 'raw-root');

    await mkdir(mediaRoot, { recursive: true });
    await mkdir(rawRoot, { recursive: true });
    await writeFile(join(mediaRoot, 'graded.mp4'), '');
    await writeFile(join(mediaRoot, 'graded-2.mp4'), '');
    await writeFile(join(rawRoot, 'source.mov'), '');
    await writeWorkspaceProjectBrief(workspaceRoot, projectId, [
      {
        path: mediaRoot,
        rawPath: rawRoot,
        description: '主机位素材',
      },
    ]);

    const result = await ingestWorkspaceProjectMedia({
      workspaceRoot,
      projectId,
    });

    expect(result.scannedRoots[0]).toMatchObject({
      localPath: mediaRoot,
      scannedFileCount: 2,
    });

    const assets = await loadAssets(projectRoot);
    expect(assets).toHaveLength(2);
  });

  it('does not persist timezone-derived metadata during ingest', async () => {
    const workspaceRoot = await createWorkspace();
    const projectId = 'project-a';
    const projectRoot = await initWorkspaceProject(workspaceRoot, projectId, 'Test Project');
    const mediaRoot = join(workspaceRoot, 'media-root');
    const deviceMapPath = join(workspaceRoot, 'device-media-maps.json');

    await mkdir(mediaRoot, { recursive: true });
    await writeFile(join(mediaRoot, '20260331_081530.mp4'), '');

    await writeJson(join(projectRoot, 'config/ingest-roots.json'), {
      roots: [{
        id: 'root-1',
        enabled: true,
        label: 'camera-a',
        defaultTimezone: 'Pacific/Auckland',
      }],
    });

    await saveDeviceProjectMap(projectId, {
      roots: [{
        rootId: 'root-1',
        localPath: mediaRoot,
      }],
    }, deviceMapPath);

    await ingestWorkspaceProjectMedia({
      workspaceRoot,
      projectId,
      deviceMapPath,
    });

    const assets = await loadAssets(projectRoot);
    expect(assets).toHaveLength(1);

    const metadata = (assets[0]?.metadata ?? {}) as Record<string, unknown>;
    expect(metadata['effectiveTimezone']).toBeUndefined();
    expect(metadata['effectiveTimezoneSource']).toBeUndefined();
    expect(metadata['effectiveTimezonePathPrefix']).toBeUndefined();
    expect(metadata['captureOriginalTimezone']).toBeUndefined();
  });

  it('blocks ingest when weak capture times obviously conflict with project timeline and appends a correction table', async () => {
    const workspaceRoot = await createWorkspace();
    const projectId = 'project-timeline-block';
    const projectRoot = await initWorkspaceProject(workspaceRoot, projectId, 'Test Project');
    const mediaRoot = join(workspaceRoot, 'media-root');

    await mkdir(mediaRoot, { recursive: true });
    await writeFile(join(mediaRoot, '20260331_081530.mp4'), '');
    await writeFile(
      join(projectRoot, 'config/manual-itinerary.md'),
      '2026.02.17，上午10点，在新西兰皇后镇拍摄\n',
      'utf-8',
    );
    await writeWorkspaceProjectBrief(workspaceRoot, projectId, [{
      path: mediaRoot,
      description: '主机位素材',
    }]);

    await expect(ingestWorkspaceProjectMedia({
      workspaceRoot,
      projectId,
    })).rejects.toThrow(/拍摄时间与项目时间线明显不一致/u);

    const manualItinerary = await readFile(
      join(projectRoot, 'config/manual-itinerary.md'),
      'utf-8',
    );
    expect(manualItinerary).toContain('## 素材时间校正');
    expect(manualItinerary).toContain('20260331_081530.mp4');
  });

  it('applies filled manual capture time overrides during ingest', async () => {
    const workspaceRoot = await createWorkspace();
    const projectId = 'project-manual-capture-override';
    const projectRoot = await initWorkspaceProject(workspaceRoot, projectId, 'Test Project');
    const mediaRoot = join(workspaceRoot, 'media-root');

    await mkdir(mediaRoot, { recursive: true });
    await writeFile(join(mediaRoot, '20260331_081530.mp4'), '');
    await writeFile(
      join(projectRoot, 'config/manual-itinerary.md'),
      [
        '2026.02.17，上午10点，在新西兰皇后镇拍摄',
        '',
        '## 素材时间校正',
        '',
        '以下素材的拍摄时间和项目时间线明显不一致。请优先填写“正确时间 / 时区”；如可推导，系统会自动补齐正确日期。未解决的行会阻塞后续 Analyze。',
        '',
        '| 状态 | 素材源 | 路径 | 当前时间UTC | 当前来源 | 建议日期 | 建议时间 | 正确日期 | 正确时间 | 时区 | 备注 |',
        '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
        '| 已填写 | root-1 | 20260331_081530.mp4 | 2026-03-31T08:15:30.000Z | filename | 2026-02-17 | 10:15:00 |  | 10:15 | Pacific/Auckland | 手工修正 |',
      ].join('\n'),
      'utf-8',
    );

    await writeJson(join(projectRoot, 'config/ingest-roots.json'), {
      roots: [{
        id: 'root-1',
        enabled: true,
        label: 'camera-a',
      }],
    });
    await saveDeviceProjectMap(projectId, {
      roots: [{
        rootId: 'root-1',
        localPath: mediaRoot,
      }],
    }, join(workspaceRoot, 'device-media-maps.json'));

    const result = await ingestWorkspaceProjectMedia({
      workspaceRoot,
      projectId,
      deviceMapPath: join(workspaceRoot, 'device-media-maps.json'),
    });

    expect(result.missingRoots).toEqual([]);
    const assets = await loadAssets(projectRoot);
    expect(assets[0]).toEqual(expect.objectContaining({
      captureTimeSource: 'manual',
      capturedAt: '2026-02-16T21:15:00.000Z',
    }));
  });

  it('blocks ingest when weak capture times fall clearly outside included pharos trip dates', async () => {
    const workspaceRoot = await createWorkspace();
    const projectId = 'project-pharos-timeline-block';
    const projectRoot = await initWorkspaceProject(workspaceRoot, projectId, 'Test Project');
    const mediaRoot = join(workspaceRoot, 'media-root');

    await mkdir(mediaRoot, { recursive: true });
    await mkdir(join(projectRoot, 'pharos', 'trip-a'), { recursive: true });
    await writeFile(join(mediaRoot, '20260331_081530.mp4'), '');
    await writeFile(
      join(projectRoot, 'pharos', 'trip-a', 'plan.json'),
      JSON.stringify({
        $schema: 'pharos/plan/1.0',
        trip_id: 'trip-a',
        title: 'Trip A',
        timezone: 'Asia/Shanghai',
        dates: {
          start: '2026-02-17',
          end: '2026-02-18',
        },
        days: [],
      }, null, 2),
      'utf-8',
    );
    await writeWorkspaceProjectBrief(workspaceRoot, projectId, [{
      path: mediaRoot,
      description: '主机位素材',
    }]);

    await expect(ingestWorkspaceProjectMedia({
      workspaceRoot,
      projectId,
    })).rejects.toThrow(/拍摄时间与项目时间线明显不一致/u);

    const manualItinerary = await readFile(
      join(projectRoot, 'config/manual-itinerary.md'),
      'utf-8',
    );
    expect(manualItinerary).toContain('Pharos trip Trip A');
    expect(manualItinerary).toContain('20260331_081530.mp4');
  });
});
