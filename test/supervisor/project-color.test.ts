import { afterEach, describe, expect, it, vi } from 'vitest';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as mediaProbe from '../../src/modules/media/probe.js';
import * as captureTime from '../../src/modules/media/capture-time.js';
import {
  ColorPrepBlockedError,
  ProjectColorBlockedError,
  executeProjectColorGroup,
  preflightProjectColorHost,
  prepareProjectColorRoot,
  promoteProjectColorBatch,
  syncProjectColorGroups,
  validateProjectColorBatch,
} from '../../src/modules/color/project-color.js';
import { ResolveColorHostError, type IColorExecutor } from '../../src/modules/color/resolve-executor.js';
import {
  getProjectProgressPath,
  initWorkspaceProject,
  loadColorBatchManifest,
  loadColorBatchPlan,
  loadColorBatchPromote,
  loadColorBatchValidation,
  loadColorCurrent,
  loadColorGroupsSnapshot,
  saveIngestRoots,
  saveProjectDeviceMap,
} from '../../src/store/index.js';

const workspaces: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  await Promise.all(
    workspaces.splice(0).map(path => rm(path, { recursive: true, force: true })),
  );
});

async function createWorkspace(): Promise<string> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'kairos-project-color-test-'));
  workspaces.push(workspaceRoot);
  return workspaceRoot;
}

function createFakeExecutor(): IColorExecutor {
  return {
    async preflight() {
      return {
        status: 'ready',
        checkedAt: '2026-04-20T10:00:00.000Z',
        productName: 'DaVinci Resolve Studio',
        versionString: '19.1.0',
        isStudio: true,
        warnings: [],
        blockingReasons: [],
        renderSupport: {
          containers: [{
            container: 'mp4',
            extension: 'mp4',
            videoCodecs: ['h265', 'prores'],
          }, {
            container: 'mov',
            extension: 'mov',
            videoCodecs: ['prores', 'h265'],
          }],
          supportsAudioCodec: true,
          supportsVideoQuality: true,
        },
      };
    },
    async prepareRoot(input) {
      return {
        resolveProjectName: input.resolveProjectName,
        gradingTimelineName: input.gradingTimelineName,
        mirrorStatus: 'synced',
        timelineStatus: 'ready',
        groupsSnapshot: {
          rootId: input.rootId,
          syncedAt: '2026-04-19T09:58:00.000Z',
          timelineName: input.gradingTimelineName,
          groups: [{
            groupKey: 'tech-day',
            displayName: 'Day Group',
            clipKeys: ['day1/A001.mov', 'day2/A001.mov'],
            hostSummary: {
              origin: 'prepare_root',
              fingerprint: 'cameraModel=sony::codecFamily=h265::resolution=3840x2160::fps=30',
              signals: {
                cameraModel: 'Sony A7S3',
                codecFamily: 'h265',
                resolution: '3840x2160',
                fps: '30',
              },
            },
          }],
        },
        hostSummary: {
          rootNamespace: input.rootNamespace,
        },
      };
    },
    async syncGroups(input) {
      return {
        rootId: input.rootId,
        syncedAt: '2026-04-19T10:00:00.000Z',
        timelineName: input.gradingTimelineName,
        groups: [{
          groupKey: 'tech-day',
          displayName: 'Day Group',
          clipKeys: ['day1/A001.mov', 'day2/A001.mov'],
          hostSummary: {
            origin: 'resolve',
            fingerprint: 'cameraModel=sony::codecFamily=h265::resolution=3840x2160::fps=30',
            signals: {
              cameraModel: 'Sony A7S3',
              codecFamily: 'h265',
              resolution: '3840x2160',
              fps: '30',
            },
          },
        }, {
          groupKey: 'empty-group',
          displayName: 'Empty Group',
          clipKeys: [],
          hostSummary: {
            origin: 'resolve',
            fingerprint: 'ungrouped',
            signals: {},
          },
        }],
      };
    },
    async executeGroup(input) {
      const outputs = [
        join(input.stagingRoot, 'day1', 'A001.mp4'),
        join(input.stagingRoot, 'day2', 'A001.mp4'),
      ];
      await mkdir(join(input.stagingRoot, 'day1'), { recursive: true });
      await mkdir(join(input.stagingRoot, 'day2'), { recursive: true });
      await Promise.all(outputs.map(path => writeFile(path, 'rendered', 'utf-8')));
      return {
        renderedAt: '2026-04-19T10:05:00.000Z',
        entries: [{
          rawRelativePath: 'day1/A001.mov',
          outputPath: outputs[0]!,
          normalizedOutputFilename: 'A001.mp4',
        }, {
          rawRelativePath: 'day2/A001.mov',
          outputPath: outputs[1]!,
          normalizedOutputFilename: 'A001.mp4',
        }],
      };
    },
  };
}

function mockColorMetadata() {
  vi.spyOn(mediaProbe, 'probe').mockImplementation(async filePath => ({
    durationMs: 1000,
    width: 3840,
    height: 2160,
    fps: 30,
    codec: filePath.endsWith('.mp4') ? 'h265' : 'prores',
    hasAudioStream: true,
    audioStreamCount: 1,
    audioCodec: 'aac',
    audioSampleRate: 48000,
    audioChannels: 2,
    audioBitRate: 192000,
    creationTime: '2026-02-01T10:00:00.000Z',
    rawTags: {
      createdate: '2026:02:01 10:00:00',
      gpslatitude: '40.1',
      gpslongitude: '120.2',
    },
  }));
  vi.spyOn(captureTime, 'resolveCaptureTime').mockResolvedValue({
    capturedAt: '2026-02-01T10:00:00.000Z',
    source: 'exif',
    confidence: 1,
  });
}

describe('project color actions', () => {
  it('persists groups snapshot directly from prepare_root', async () => {
    const workspaceRoot = await createWorkspace();
    const projectId = 'project-color-prepare-snapshot';
    const projectRoot = await initWorkspaceProject(workspaceRoot, projectId, 'Project Color Prepare Snapshot');
    const rawLocalPath = join(projectRoot, '.fixtures', 'raw-camera');
    await writeFile(join(projectRoot, 'config', 'runtime.json'), JSON.stringify({
      resolveColorPythonPath: '/usr/bin/python3',
    }, null, 2));
    await mkdir(join(rawLocalPath, 'day1'), { recursive: true });
    await writeFile(join(rawLocalPath, 'day1', 'A001.mov'), 'raw-a', 'utf-8');

    await saveIngestRoots(projectRoot, {
      roots: [{
        id: 'root-camera',
        path: '/media/current/camera',
        rawPath: '/media/raw/camera',
        enabled: true,
        color: {
          renderPreset: {
            container: 'mp4',
            videoCodec: 'h265',
            audioCodec: 'aac',
            bitrateMbps: 120,
          },
        },
      }],
    });
    await saveProjectDeviceMap(projectRoot, projectId, {
      roots: [{
        rootId: 'root-camera',
        localPath: join(projectRoot, '.fixtures', 'current-camera'),
        rawLocalPath,
      }],
    });

    mockColorMetadata();
    await prepareProjectColorRoot({
      workspaceRoot,
      projectId,
      rootId: 'root-camera',
      jobId: 'job-color-prepare',
      executor: createFakeExecutor(),
    });

    const [snapshot, current] = await Promise.all([
      loadColorGroupsSnapshot(projectRoot, 'root-camera'),
      loadColorCurrent(projectRoot),
    ]);
    expect(snapshot?.groups[0]?.hostSummary.origin).toBe('prepare_root');
    expect(snapshot?.groups[0]?.hostSummary.signals).toMatchObject({
      cameraModel: 'Sony A7S3',
      resolution: '3840x2160',
    });
    expect(current.roots[0]?.groupSyncStatus).toBe('ready');
    expect(current.roots[0]?.groups[0]?.status).toBe('ready');
  });

  it('runs prepare -> sync -> execute -> validate -> promote and persists runtime/archive truth', async () => {
    const workspaceRoot = await createWorkspace();
    const projectId = 'project-color-closure';
    const projectRoot = await initWorkspaceProject(workspaceRoot, projectId, 'Project Color Closure');
    const rawLocalPath = join(projectRoot, '.fixtures', 'raw-camera');
    const currentLocalPath = join(projectRoot, '.fixtures', 'current-camera');
    const rawClipPathA = join(rawLocalPath, 'day1', 'A001.mov');
    const rawClipPathB = join(rawLocalPath, 'day2', 'A001.mov');
    await writeFile(join(projectRoot, 'config', 'runtime.json'), JSON.stringify({
      resolveColorPythonPath: '/usr/bin/python3',
    }, null, 2));
    await mkdir(join(rawLocalPath, 'day1'), { recursive: true });
    await mkdir(join(rawLocalPath, 'day2'), { recursive: true });
    await writeFile(rawClipPathA, 'raw-a', 'utf-8');
    await writeFile(rawClipPathB, 'raw-b', 'utf-8');

    await saveIngestRoots(projectRoot, {
      roots: [{
        id: 'root-camera',
        path: '/media/current/camera',
        rawPath: '/media/raw/camera',
        enabled: true,
        color: {
          renderPreset: {
            container: 'mp4',
            videoCodec: 'h265',
            audioCodec: 'aac',
            bitrateMbps: 120,
          },
        },
      }],
    });
    await saveProjectDeviceMap(projectRoot, projectId, {
      roots: [{
        rootId: 'root-camera',
        localPath: currentLocalPath,
        rawLocalPath,
      }],
    });

    mockColorMetadata();
    const executor = createFakeExecutor();

    await prepareProjectColorRoot({
      workspaceRoot,
      projectId,
      rootId: 'root-camera',
      jobId: 'job-color-prepare',
      executor,
    });
    await syncProjectColorGroups({
      workspaceRoot,
      projectId,
      rootId: 'root-camera',
      action: 'sync_groups',
      jobId: 'job-color-sync',
      executor,
    });
    const executeResult = await executeProjectColorGroup({
      workspaceRoot,
      projectId,
      rootId: 'root-camera',
      action: 'execute_group',
      groupKey: 'tech-day',
      jobId: 'job-color-execute',
      executor,
    });
    expect(executeResult.batchId).toBeTruthy();

    await validateProjectColorBatch({
      workspaceRoot,
      projectId,
      rootId: 'root-camera',
      action: 'validate_batch',
      batchId: executeResult.batchId,
      jobId: 'job-color-validate',
    });
    await promoteProjectColorBatch({
      workspaceRoot,
      projectId,
      rootId: 'root-camera',
      action: 'promote_batch',
      batchId: executeResult.batchId,
      jobId: 'job-color-promote',
    });

    const [groupsSnapshot, plan, manifest, validation, promote, current] = await Promise.all([
      loadColorGroupsSnapshot(projectRoot, 'root-camera'),
      loadColorBatchPlan(projectRoot, executeResult.batchId!),
      loadColorBatchManifest(projectRoot, executeResult.batchId!),
      loadColorBatchValidation(projectRoot, executeResult.batchId!),
      loadColorBatchPromote(projectRoot, executeResult.batchId!),
      loadColorCurrent(projectRoot),
    ]);

    expect(groupsSnapshot?.groups[0]?.groupKey).toBe('tech-day');
    expect(groupsSnapshot?.groups[0]?.hostSummary.fingerprint).toContain('cameraModel=sony');
    expect(groupsSnapshot?.groups[0]?.hostSummary.signals).toMatchObject({
      cameraModel: 'Sony A7S3',
      codecFamily: 'h265',
    });
    expect(plan?.entries.map(entry => entry.rawRelativePath)).toEqual(['day1/A001.mov', 'day2/A001.mov']);
    expect(manifest?.managedOutputSet).toEqual(['day1/A001.mp4', 'day2/A001.mp4']);
    expect(validation?.status).toBe('pass');
    expect(promote?.status).toBe('completed');
    expect(current.roots[0]?.groups.find(group => group.groupKey === 'tech-day')?.status).toBe('promoted');
    expect(current.roots[0]?.groups.find(group => group.groupKey === 'tech-day')?.lastPromotedBatchId).toBe(executeResult.batchId);
    expect(current.roots[0]?.groups.find(group => group.groupKey === 'empty-group')?.status).toBe('blocked');
    await expect(access(join(currentLocalPath, 'day1', 'A001.mp4'))).resolves.toBeUndefined();
    await expect(access(join(currentLocalPath, 'day2', 'A001.mp4'))).resolves.toBeUndefined();

    const [promotedA, promotedB] = await Promise.all([
      readFile(join(currentLocalPath, 'day1', 'A001.mp4'), 'utf-8'),
      readFile(join(currentLocalPath, 'day2', 'A001.mp4'), 'utf-8'),
    ]);
    expect(promotedA).toBe('rendered');
    expect(promotedB).toBe('rendered');

    const progress = JSON.parse(
      await readFile(getProjectProgressPath(projectRoot, 'color'), 'utf-8'),
    ) as { status: string; detail: string };
    expect(progress.status).toBe('succeeded');
    expect(progress.detail).toContain('promote');
  });

  it('blocks prepare_root when rawLocalPath is missing', async () => {
    const workspaceRoot = await createWorkspace();
    const projectId = 'project-color-blocked';
    const projectRoot = await initWorkspaceProject(workspaceRoot, projectId, 'Project Color Blocked');

    await writeFile(join(projectRoot, 'config', 'runtime.json'), JSON.stringify({
      resolveColorPythonPath: '/usr/bin/python3',
    }, null, 2));
    await saveIngestRoots(projectRoot, {
      roots: [{
        id: 'root-camera',
        path: '/media/current/camera',
        rawPath: '/media/raw/camera',
        enabled: true,
      }],
    });
    await saveProjectDeviceMap(projectRoot, projectId, {
      roots: [{
        rootId: 'root-camera',
        localPath: 'F:\\current\\camera',
      }],
    });

    await expect(prepareProjectColorRoot({
      workspaceRoot,
      projectId,
      rootId: 'root-camera',
      jobId: 'job-color-blocked',
      executor: createFakeExecutor(),
    })).rejects.toBeInstanceOf(ColorPrepBlockedError);

    const savedCurrent = await loadColorCurrent(projectRoot);
    expect(savedCurrent.roots[0]?.mirrorStatus).toBe('blocked');
    expect(savedCurrent.roots[0]?.detail).toContain('rawLocalPath');
  });

  it('passes the full render preset into execute_group requests', async () => {
    const workspaceRoot = await createWorkspace();
    const projectId = 'project-color-render-preset';
    const projectRoot = await initWorkspaceProject(workspaceRoot, projectId, 'Project Color Render Preset');
    const rawLocalPath = join(projectRoot, '.fixtures', 'raw-camera');
    const currentLocalPath = join(projectRoot, '.fixtures', 'current-camera');
    await writeFile(join(projectRoot, 'config', 'runtime.json'), JSON.stringify({
      resolveColorPythonPath: '/usr/bin/python3',
    }, null, 2));
    await mkdir(join(rawLocalPath, 'day1'), { recursive: true });
    await writeFile(join(rawLocalPath, 'day1', 'A001.mov'), 'raw-a', 'utf-8');

    await saveIngestRoots(projectRoot, {
      roots: [{
        id: 'root-camera',
        path: '/media/current/camera',
        rawPath: '/media/raw/camera',
        enabled: true,
        color: {
          renderPreset: {
            container: 'mov',
            videoCodec: 'prores',
            audioCodec: 'pcm',
            bitrateMbps: 240,
          },
        },
      }],
    });
    await saveProjectDeviceMap(projectRoot, projectId, {
      roots: [{
        rootId: 'root-camera',
        localPath: currentLocalPath,
        rawLocalPath,
      }],
    });

    mockColorMetadata();
    const captured: Array<{ renderPreset: unknown; rawLocalPath: string }> = [];
    const executor: IColorExecutor = {
      async preflight() {
        return {
          status: 'ready',
          checkedAt: '2026-04-20T10:00:00.000Z',
          productName: 'DaVinci Resolve Studio',
          versionString: '19.1.0',
          isStudio: true,
          warnings: [],
          blockingReasons: [],
          renderSupport: {
            containers: [{
              container: 'mov',
              extension: 'mov',
              videoCodecs: ['prores'],
            }],
            supportsAudioCodec: true,
            supportsVideoQuality: true,
          },
        };
      },
      async prepareRoot(input) {
        return {
          resolveProjectName: input.resolveProjectName,
          gradingTimelineName: input.gradingTimelineName,
          mirrorStatus: 'synced',
          timelineStatus: 'ready',
          groupsSnapshot: {
            rootId: input.rootId,
            syncedAt: '2026-04-19T09:58:00.000Z',
            timelineName: input.gradingTimelineName,
            groups: [{
              groupKey: 'tech-day',
              displayName: 'Day Group',
              clipKeys: ['day1/A001.mov'],
              hostSummary: {
                origin: 'prepare_root',
                fingerprint: 'codecFamily=prores',
                signals: { codecFamily: 'prores' },
              },
            }],
          },
        };
      },
      async syncGroups(input) {
        return {
          rootId: input.rootId,
          syncedAt: '2026-04-19T10:00:00.000Z',
          timelineName: input.gradingTimelineName,
          groups: [{
            groupKey: 'tech-day',
            displayName: 'Day Group',
            clipKeys: ['day1/A001.mov'],
            hostSummary: {},
          }],
        };
      },
      async executeGroup(input) {
        captured.push({
          renderPreset: input.renderPreset,
          rawLocalPath: input.rawLocalPath,
        });
        const outputPath = join(input.stagingRoot, 'day1', 'A001.mov');
        await mkdir(join(input.stagingRoot, 'day1'), { recursive: true });
        await writeFile(outputPath, 'rendered', 'utf-8');
        return {
          renderedAt: '2026-04-19T10:05:00.000Z',
          entries: [{
            rawRelativePath: 'day1/A001.mov',
            outputPath,
            normalizedOutputFilename: 'A001.mov',
          }],
        };
      },
    };

    await prepareProjectColorRoot({
      workspaceRoot,
      projectId,
      rootId: 'root-camera',
      jobId: 'job-color-prepare',
      executor,
    });
    await syncProjectColorGroups({
      workspaceRoot,
      projectId,
      rootId: 'root-camera',
      action: 'sync_groups',
      jobId: 'job-color-sync',
      executor,
    });
    await executeProjectColorGroup({
      workspaceRoot,
      projectId,
      rootId: 'root-camera',
      action: 'execute_group',
      groupKey: 'tech-day',
      jobId: 'job-color-execute',
      executor,
    });

    expect(captured).toEqual([{
      renderPreset: {
        container: 'mov',
        videoCodec: 'prores',
        audioCodec: 'pcm',
        bitrateMbps: 240,
      },
      rawLocalPath,
    }]);
  });

  it('rejects promote when the batch has been superseded by a newer latest batch', async () => {
    const workspaceRoot = await createWorkspace();
    const projectId = 'project-color-superseded';
    const projectRoot = await initWorkspaceProject(workspaceRoot, projectId, 'Project Color Superseded');
    const rawLocalPath = join(projectRoot, '.fixtures', 'raw-camera');
    const currentLocalPath = join(projectRoot, '.fixtures', 'current-camera');
    const rawClipPathA = join(rawLocalPath, 'day1', 'A001.mov');
    const rawClipPathB = join(rawLocalPath, 'day2', 'A001.mov');
    await writeFile(join(projectRoot, 'config', 'runtime.json'), JSON.stringify({
      resolveColorPythonPath: '/usr/bin/python3',
    }, null, 2));
    await mkdir(join(rawLocalPath, 'day1'), { recursive: true });
    await mkdir(join(rawLocalPath, 'day2'), { recursive: true });
    await writeFile(rawClipPathA, 'raw-a', 'utf-8');
    await writeFile(rawClipPathB, 'raw-b', 'utf-8');

    await saveIngestRoots(projectRoot, {
      roots: [{
        id: 'root-camera',
        path: '/media/current/camera',
        rawPath: '/media/raw/camera',
        enabled: true,
        color: {
          renderPreset: {
            container: 'mp4',
            videoCodec: 'h265',
            audioCodec: 'aac',
            bitrateMbps: 120,
          },
        },
      }],
    });
    await saveProjectDeviceMap(projectRoot, projectId, {
      roots: [{
        rootId: 'root-camera',
        localPath: currentLocalPath,
        rawLocalPath,
      }],
    });

    mockColorMetadata();
    const executor = createFakeExecutor();

    await prepareProjectColorRoot({ workspaceRoot, projectId, rootId: 'root-camera', executor });
    await syncProjectColorGroups({ workspaceRoot, projectId, rootId: 'root-camera', action: 'sync_groups', executor });
    const batch1 = await executeProjectColorGroup({
      workspaceRoot,
      projectId,
      rootId: 'root-camera',
      action: 'execute_group',
      groupKey: 'tech-day',
      executor,
    });
    await validateProjectColorBatch({
      workspaceRoot,
      projectId,
      rootId: 'root-camera',
      action: 'validate_batch',
      batchId: batch1.batchId,
    });
    const batch2 = await executeProjectColorGroup({
      workspaceRoot,
      projectId,
      rootId: 'root-camera',
      action: 'execute_group',
      groupKey: 'tech-day',
      executor,
    });
    expect(batch2.batchId).not.toBe(batch1.batchId);

    await expect(promoteProjectColorBatch({
      workspaceRoot,
      projectId,
      rootId: 'root-camera',
      action: 'promote_batch',
      batchId: batch1.batchId,
    })).rejects.toBeInstanceOf(ProjectColorBlockedError);
  });

  it('returns blocked preflight when runtime python path is missing', async () => {
    const workspaceRoot = await createWorkspace();
    const projectId = 'project-color-preflight-missing-runtime';
    const projectRoot = await initWorkspaceProject(workspaceRoot, projectId, 'Project Color Preflight Missing Runtime');
    await saveIngestRoots(projectRoot, {
      roots: [{
        id: 'root-camera',
        path: '/media/current/camera',
        rawPath: '/media/raw/camera',
        enabled: true,
      }],
    });

    const result = await preflightProjectColorHost({
      workspaceRoot,
      projectId,
      rootId: 'root-camera',
    });

    expect(result.status).toBe('blocked');
    expect(result.blockingReasons[0]).toContain('resolveColorPythonPath');
    const current = await loadColorCurrent(projectRoot);
    expect(current.hostPreflight?.status).toBe('blocked');
  });

  it('maps app-unavailable preflight failures into blocked host diagnostics', async () => {
    const workspaceRoot = await createWorkspace();
    const projectId = 'project-color-preflight-app-down';
    const projectRoot = await initWorkspaceProject(workspaceRoot, projectId, 'Project Color Preflight App Down');
    await writeFile(join(projectRoot, 'config', 'runtime.json'), JSON.stringify({
      resolveColorPythonPath: '/usr/bin/python3',
    }, null, 2));

    const result = await preflightProjectColorHost({
      workspaceRoot,
      projectId,
      executor: {
        async preflight() {
          throw new ResolveColorHostError({
            code: 'resolve_project_unavailable',
            message: 'Resolve is not running',
            requestPath: '/tmp/request.json',
          });
        },
        async prepareRoot() {
          throw new Error('not used');
        },
        async syncGroups() {
          throw new Error('not used');
        },
        async executeGroup() {
          throw new Error('not used');
        },
      },
    });

    expect(result.status).toBe('blocked');
    expect(result.blockingReasons).toContain('Resolve is not running');
  });

  it('keeps degraded preflight results as executable diagnostics', async () => {
    const workspaceRoot = await createWorkspace();
    const projectId = 'project-color-preflight-degraded';
    const projectRoot = await initWorkspaceProject(workspaceRoot, projectId, 'Project Color Preflight Degraded');
    await writeFile(join(projectRoot, 'config', 'runtime.json'), JSON.stringify({
      resolveColorPythonPath: '/usr/bin/python3',
    }, null, 2));

    const result = await preflightProjectColorHost({
      workspaceRoot,
      projectId,
      executor: {
        async preflight() {
          return {
            status: 'degraded',
            checkedAt: '2026-04-20T10:00:00.000Z',
            productName: 'DaVinci Resolve Studio',
            versionString: '19.1.0',
            isStudio: true,
            warnings: ['legacy probe'],
            blockingReasons: [],
            renderSupport: {
              containers: [{
                container: 'mp4',
                extension: 'mp4',
                videoCodecs: ['h265'],
              }],
              supportsAudioCodec: true,
              supportsVideoQuality: false,
            },
          };
        },
        async prepareRoot() {
          throw new Error('not used');
        },
        async syncGroups() {
          throw new Error('not used');
        },
        async executeGroup() {
          throw new Error('not used');
        },
      },
    });

    expect(result.status).toBe('degraded');
    expect(result.warnings).toContain('legacy probe');
    expect((await loadColorCurrent(projectRoot)).hostPreflight?.status).toBe('degraded');
  });

  it('retries transient host failures before succeeding', async () => {
    vi.useFakeTimers();
    const workspaceRoot = await createWorkspace();
    const projectId = 'project-color-retry-success';
    const projectRoot = await initWorkspaceProject(workspaceRoot, projectId, 'Project Color Retry Success');
    const rawLocalPath = join(projectRoot, '.fixtures', 'raw-camera');
    await writeFile(join(projectRoot, 'config', 'runtime.json'), JSON.stringify({
      resolveColorPythonPath: '/usr/bin/python3',
    }, null, 2));
    await mkdir(join(rawLocalPath, 'day1'), { recursive: true });
    await writeFile(join(rawLocalPath, 'day1', 'A001.mov'), 'raw-a', 'utf-8');
    await saveIngestRoots(projectRoot, {
      roots: [{
        id: 'root-camera',
        path: '/media/current/camera',
        rawPath: '/media/raw/camera',
        enabled: true,
        color: {
          renderPreset: {
            container: 'mp4',
            videoCodec: 'h265',
            audioCodec: 'aac',
            bitrateMbps: 120,
          },
        },
      }],
    });
    await saveProjectDeviceMap(projectRoot, projectId, {
      roots: [{
        rootId: 'root-camera',
        localPath: join(projectRoot, '.fixtures', 'current-camera'),
        rawLocalPath,
      }],
    });
    mockColorMetadata();

    let attempts = 0;
    const executor: IColorExecutor = {
      async preflight() {
        return createFakeExecutor().preflight();
      },
      async prepareRoot(input) {
        attempts += 1;
        if (attempts < 3) {
          throw new ResolveColorHostError({
            code: 'resolve_app_unavailable',
            message: 'Resolve temporarily unavailable',
            requestPath: '/tmp/request.json',
          });
        }
        return createFakeExecutor().prepareRoot(input);
      },
      async syncGroups() {
        throw new Error('not used');
      },
      async executeGroup() {
        throw new Error('not used');
      },
    };

    const promise = prepareProjectColorRoot({
      workspaceRoot,
      projectId,
      rootId: 'root-camera',
      executor,
    });
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toMatchObject({ action: 'prepare_root' });
    expect(attempts).toBe(3);
  });

  it('does not retry semantic host failures', async () => {
    vi.useFakeTimers();
    const workspaceRoot = await createWorkspace();
    const projectId = 'project-color-retry-semantic';
    const projectRoot = await initWorkspaceProject(workspaceRoot, projectId, 'Project Color Retry Semantic');
    const rawLocalPath = join(projectRoot, '.fixtures', 'raw-camera');
    await writeFile(join(projectRoot, 'config', 'runtime.json'), JSON.stringify({
      resolveColorPythonPath: '/usr/bin/python3',
    }, null, 2));
    await mkdir(join(rawLocalPath, 'day1'), { recursive: true });
    await writeFile(join(rawLocalPath, 'day1', 'A001.mov'), 'raw-a', 'utf-8');
    await saveIngestRoots(projectRoot, {
      roots: [{
        id: 'root-camera',
        path: '/media/current/camera',
        rawPath: '/media/raw/camera',
        enabled: true,
        color: {
          renderPreset: {
            container: 'mp4',
            videoCodec: 'h265',
            audioCodec: 'aac',
            bitrateMbps: 120,
          },
        },
      }],
    });
    await saveProjectDeviceMap(projectRoot, projectId, {
      roots: [{
        rootId: 'root-camera',
        localPath: join(projectRoot, '.fixtures', 'current-camera'),
        rawLocalPath,
      }],
    });
    mockColorMetadata();

    let attempts = 0;
    const executor: IColorExecutor = {
      async preflight() {
        return createFakeExecutor().preflight();
      },
      async prepareRoot() {
        attempts += 1;
        throw new ResolveColorHostError({
          code: 'resolve_media_pool_import_failed',
          message: 'missing media',
          requestPath: '/tmp/request.json',
        });
      },
      async syncGroups() {
        throw new Error('not used');
      },
      async executeGroup() {
        throw new Error('not used');
      },
    };

    const promise = prepareProjectColorRoot({
      workspaceRoot,
      projectId,
      rootId: 'root-camera',
      executor,
    });
    await vi.runAllTimersAsync();
    await expect(promise).rejects.toMatchObject({ code: 'resolve_media_pool_import_failed' });
    expect(attempts).toBe(1);
  });

  it('blocks execute_group before render when host render support rejects the preset', async () => {
    const workspaceRoot = await createWorkspace();
    const projectId = 'project-color-render-support-blocked';
    const projectRoot = await initWorkspaceProject(workspaceRoot, projectId, 'Project Color Render Support Blocked');
    const rawLocalPath = join(projectRoot, '.fixtures', 'raw-camera');
    const currentLocalPath = join(projectRoot, '.fixtures', 'current-camera');
    await writeFile(join(projectRoot, 'config', 'runtime.json'), JSON.stringify({
      resolveColorPythonPath: '/usr/bin/python3',
    }, null, 2));
    await mkdir(join(rawLocalPath, 'day1'), { recursive: true });
    await writeFile(join(rawLocalPath, 'day1', 'A001.mov'), 'raw-a', 'utf-8');
    await saveIngestRoots(projectRoot, {
      roots: [{
        id: 'root-camera',
        path: '/media/current/camera',
        rawPath: '/media/raw/camera',
        enabled: true,
        color: {
          renderPreset: {
            container: 'mov',
            videoCodec: 'prores',
            audioCodec: 'pcm',
            bitrateMbps: 240,
          },
        },
      }],
    });
    await saveProjectDeviceMap(projectRoot, projectId, {
      roots: [{
        rootId: 'root-camera',
        localPath: currentLocalPath,
        rawLocalPath,
      }],
    });
    mockColorMetadata();

    let executeCalls = 0;
    const executor: IColorExecutor = {
      async preflight() {
        return {
          status: 'ready',
          checkedAt: '2026-04-20T10:00:00.000Z',
          productName: 'DaVinci Resolve Studio',
          versionString: '19.1.0',
          isStudio: true,
          warnings: [],
          blockingReasons: [],
          renderSupport: {
            containers: [{
              container: 'mp4',
              extension: 'mp4',
              videoCodecs: ['h265'],
            }],
            supportsAudioCodec: false,
            supportsVideoQuality: false,
          },
        };
      },
      async prepareRoot(input) {
        return createFakeExecutor().prepareRoot(input);
      },
      async syncGroups(input) {
        return createFakeExecutor().syncGroups(input);
      },
      async executeGroup() {
        executeCalls += 1;
        throw new Error('should not execute');
      },
    };

    await prepareProjectColorRoot({
      workspaceRoot,
      projectId,
      rootId: 'root-camera',
      executor,
    });
    await syncProjectColorGroups({
      workspaceRoot,
      projectId,
      rootId: 'root-camera',
      action: 'sync_groups',
      executor,
    });

    await expect(executeProjectColorGroup({
      workspaceRoot,
      projectId,
      rootId: 'root-camera',
      action: 'execute_group',
      groupKey: 'tech-day',
      executor,
    })).rejects.toBeInstanceOf(ProjectColorBlockedError);
    expect(executeCalls).toBe(0);
  });
});
