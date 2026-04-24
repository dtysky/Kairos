import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as mediaProbe from '../../src/modules/media/probe.js';
import * as captureTime from '../../src/modules/media/capture-time.js';
import * as lowlightClassifier from '../../src/modules/color/lowlight-classifier.js';
import * as resolveExecutor from '../../src/modules/color/resolve-executor.js';
import * as sourceTruth from '../../src/modules/color/source-truth.js';
import type { IColorGroupsSnapshotFile } from '../../src/protocol/schema.js';
import {
  ColorPrepBlockedError,
  ProjectColorBlockedError,
  executeProjectColorRoot,
  exportAllProjectColorRoots,
  preflightProjectColorHost,
  prepareAllProjectColorRoots,
  prepareProjectColorRoot,
  promoteProjectColorBatch,
  runProjectColorAction,
  syncProjectColorGroups,
  validateProjectColorBatch,
} from '../../src/modules/color/project-color.js';
import {
  ResolveColorHostError,
  type IColorExecutor,
  type IColorExecutorClipInput,
  type IColorExecutorPrepareRootInput,
  type IColorExecutorSyncGroupsInput,
} from '../../src/modules/color/resolve-executor.js';
import {
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

function createReadyPreflight(
  overrides: Partial<Awaited<ReturnType<IColorExecutor['preflight']>>> = {},
) {
  return {
    status: 'ready' as const,
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
      }, {
        container: 'mov',
        extension: 'mov',
        videoCodecs: ['prores', 'h265'],
      }],
      supportsAudioCodec: true,
      supportsVideoQuality: true,
    },
    ...overrides,
  };
}

function buildClipRepairSnapshot(
  clip: IColorExecutorClipInput,
): NonNullable<IColorGroupsSnapshotFile['groups']>[number]['clips'][number] {
  const gyroEligible = clip.gyroEligible === true;
  const reservedNodeIndices = { gyro: 1, dehaze: 2, userStart: 3, userEnd: 4, nr: 5 };
  const gyroflowStatus: 'ready-to-load' | 'seeded-disabled' = gyroEligible ? 'ready-to-load' : 'seeded-disabled';
  return {
    clipKey: String(clip.rawRelativePath ?? ''),
    displayName: String(clip.sourceStem ?? ''),
    logProfile: typeof clip.logProfile === 'string' ? clip.logProfile : undefined,
    lowlight: clip.lowlight === true,
    gyroEligible,
    gyroflowStatus,
    dehazeStatus: 'seeded-disabled' as const,
    nrStatus: 'seeded-disabled' as const,
    clipRepairStatus: 'ready' as const,
    layoutStatus: 'canonical' as const,
    reservedNodeIndices,
    hostSummary: {
      layoutStatus: 'canonical',
      reservedNodeIndices,
    },
  };
}

function buildGroupsSnapshot(
  input: {
    rootId: string;
    gradingTimelineName: string;
    clips: IColorExecutorClipInput[];
  },
  origin: 'prepare_root' | 'resolve',
): IColorGroupsSnapshotFile {
  return {
    rootId: input.rootId,
    syncedAt: '2026-04-19T10:00:00.000Z',
    timelineName: input.gradingTimelineName,
    groups: [{
      groupKey: 'base-group',
      displayName: 'Base Group',
      clipKeys: input.clips.map(clip => String(clip.rawRelativePath ?? '')),
      clips: input.clips.map(buildClipRepairSnapshot),
      hostSummary: {
        origin,
        creativeTags: ['base'],
      },
    }],
  };
}

function createFakeExecutor(options: {
  preflightResult?: ReturnType<typeof createReadyPreflight>;
  onPrepareRoot?: NonNullable<IColorExecutor['prepareRoot']>;
  onSyncGroups?: NonNullable<IColorExecutor['syncGroups']>;
  onExecuteRoot?: NonNullable<IColorExecutor['executeRoot']>;
} = {}): IColorExecutor {
  return {
    async preflight() {
      return options.preflightResult ?? createReadyPreflight();
    },
    async prepareRoot(input) {
      if (options.onPrepareRoot) {
        return options.onPrepareRoot(input);
      }
      return {
        resolveProjectName: input.resolveProjectName,
        gradingTimelineName: input.gradingTimelineName,
        mirrorStatus: 'synced' as const,
        timelineStatus: 'ready' as const,
        groupsSnapshot: buildGroupsSnapshot(input, 'prepare_root'),
        hostSummary: {
          rootNamespace: input.rootNamespace,
        },
      };
    },
    async syncGroups(input) {
      if (options.onSyncGroups) {
        return options.onSyncGroups(input);
      }
      return buildGroupsSnapshot(input, 'resolve');
    },
    async executeRoot(input) {
      if (options.onExecuteRoot) {
        return options.onExecuteRoot(input);
      }
      const extension = input.renderPreset.container === 'mov' ? 'mov' : 'mp4';
      const entries = await Promise.all(
        input.clips.map(async clip => {
          const relativeParts = clip.rawRelativePath.split('/');
          const outputFilename = `${clip.sourceStem}.${extension}`;
          const outputPath = join(input.stagingRoot, ...relativeParts.slice(0, -1), outputFilename);
          await mkdir(join(input.stagingRoot, ...relativeParts.slice(0, -1)), { recursive: true });
          await writeFile(outputPath, `rendered:${clip.rawRelativePath}`, 'utf-8');
          return {
            rawRelativePath: clip.rawRelativePath,
            outputPath,
            normalizedOutputFilename: outputFilename,
          };
        }),
      );
      return {
        renderedAt: '2026-04-19T10:05:00.000Z',
        entries,
      };
    },
  };
}

function mockColorMetadata(options: {
  includeCaptureTime?: boolean;
  includeGps?: boolean;
  codec?: string;
} = {}) {
  vi.spyOn(mediaProbe, 'probe').mockImplementation(async filePath => ({
    durationMs: 1000,
    width: 3840,
    height: 2160,
    fps: 30,
    codec: options.codec ?? (filePath.endsWith('.mp4') ? 'h265' : 'prores'),
    hasAudioStream: true,
    audioStreamCount: 1,
    audioCodec: 'aac',
    audioSampleRate: 48000,
    audioChannels: 2,
    audioBitRate: 192000,
    creationTime: options.includeCaptureTime ? '2026-02-01T10:00:00.000Z' : undefined,
    rawTags: options.includeGps
      ? {
        gpslatitude: '40.1',
        gpslongitude: '120.2',
      }
      : {},
  }));
  vi.spyOn(captureTime, 'resolveCaptureTime').mockResolvedValue(
    options.includeCaptureTime
      ? {
        capturedAt: '2026-02-01T10:00:00.000Z',
        source: 'exif',
        confidence: 1,
      }
      : null,
  );
}

function mockClipSignals(options: {
  gyroEligible?: boolean;
  lowlight?: boolean;
  logProfile?: string;
  deviceFamilyKeys?: string[];
} = {}) {
  vi.spyOn(sourceTruth, 'extractColorSourceTruth').mockResolvedValue({
    logProfile: (options.logProfile ?? 'slog3') as never,
    gyro: options.gyroEligible,
    deviceFamilyKeys: options.deviceFamilyKeys ?? ['sony'],
    sourceKinds: [],
  });
  vi.spyOn(lowlightClassifier, 'classifyFirstFrameLowlight').mockResolvedValue({
    lowlight: options.lowlight ?? false,
    metrics: undefined,
  });
}

async function seedSingleRootProject(input: {
  workspaceRoot: string;
  projectId: string;
  projectName: string;
  rootId?: string;
  renderPreset?: {
    container?: string;
    videoCodec?: string;
    audioCodec?: string;
    bitrateKbps?: number;
  };
  colorSpaceProfile?: string;
  rawFiles?: string[];
  includeRawLocalPath?: boolean;
}) {
  const projectRoot = await initWorkspaceProject(input.workspaceRoot, input.projectId, input.projectName);
  const rootId = input.rootId ?? 'root-camera';
  const rawLocalPath = join(projectRoot, '.fixtures', `${rootId}-raw`);
  const currentLocalPath = join(projectRoot, '.fixtures', `${rootId}-current`);
  for (const rawRelativePath of input.rawFiles ?? ['day1/A001.mov']) {
    const targetPath = join(rawLocalPath, ...rawRelativePath.split('/'));
    await mkdir(join(targetPath, '..'), { recursive: true });
    await writeFile(targetPath, `raw:${rawRelativePath}`, 'utf-8');
  }
  await saveIngestRoots(projectRoot, {
    roots: [{
      id: rootId,
      path: `/media/current/${rootId}`,
      rawPath: `/media/raw/${rootId}`,
      enabled: true,
      color: {
        renderPreset: input.renderPreset ?? {
          container: 'mp4',
          videoCodec: 'h265',
          audioCodec: 'aac',
          bitrateKbps: 120,
        },
        colorSpaceProfile: input.colorSpaceProfile,
      },
    }],
  });
  await saveProjectDeviceMap(projectRoot, input.projectId, {
    roots: [{
      rootId,
      localPath: currentLocalPath,
      rawLocalPath: input.includeRawLocalPath === false ? undefined : rawLocalPath,
    }],
  });
  return {
    projectRoot,
    rootId,
    rawLocalPath,
    currentLocalPath,
  };
}

describe('project color actions', () => {
  it('persists groups snapshot directly from prepare_root', async () => {
    const workspaceRoot = await createWorkspace();
    const projectId = 'project-color-prepare-snapshot';
    const { projectRoot, rootId } = await seedSingleRootProject({
      workspaceRoot,
      projectId,
      projectName: 'Project Color Prepare Snapshot',
    });

    mockColorMetadata();
    mockClipSignals({ gyroEligible: true, lowlight: true });
    await prepareProjectColorRoot({
      workspaceRoot,
      projectId,
      rootId,
      jobId: 'job-color-prepare',
      executor: createFakeExecutor(),
    });

    const [snapshot, current] = await Promise.all([
      loadColorGroupsSnapshot(projectRoot, rootId),
      loadColorCurrent(projectRoot),
    ]);
    expect(snapshot?.groups[0]?.hostSummary.origin).toBe('prepare_root');
    expect(snapshot?.groups[0]?.clips[0]).toMatchObject({
      gyroEligible: true,
      dehazeStatus: 'seeded-disabled',
      nrStatus: 'seeded-disabled',
      layoutStatus: 'canonical',
      reservedNodeIndices: { gyro: 1, dehaze: 2, userStart: 3, userEnd: 4, nr: 5 },
    });
    expect(current.roots[0]?.groupSyncStatus).toBe('ready');
    expect(current.roots[0]?.groups[0]?.status).toBe('ready');
  });

  it('runs prepare -> sync -> execute -> validate -> promote and persists root runtime/archive truth', async () => {
    const workspaceRoot = await createWorkspace();
    const projectId = 'project-color-closure';
    const { projectRoot, rootId, currentLocalPath } = await seedSingleRootProject({
      workspaceRoot,
      projectId,
      projectName: 'Project Color Closure',
      rawFiles: ['day1/A001.mov', 'day2/A001.mov'],
    });

    mockColorMetadata();
    const executor = createFakeExecutor();

    await prepareProjectColorRoot({
      workspaceRoot,
      projectId,
      rootId,
      jobId: 'job-color-prepare',
      executor,
    });
    await syncProjectColorGroups({
      workspaceRoot,
      projectId,
      rootId,
      action: 'sync_groups',
      jobId: 'job-color-sync',
      executor,
    });
    const executeResult = await executeProjectColorRoot({
      workspaceRoot,
      projectId,
      rootId,
      action: 'execute_root',
      jobId: 'job-color-execute',
      executor,
    });
    await validateProjectColorBatch({
      workspaceRoot,
      projectId,
      rootId,
      action: 'validate_batch',
      batchId: executeResult.batchId,
      jobId: 'job-color-validate',
    });
    await promoteProjectColorBatch({
      workspaceRoot,
      projectId,
      rootId,
      action: 'promote_batch',
      batchId: executeResult.batchId,
      jobId: 'job-color-promote',
    });

    const [snapshot, plan, manifest, validation, promote, current] = await Promise.all([
      loadColorGroupsSnapshot(projectRoot, rootId),
      loadColorBatchPlan(projectRoot, executeResult.batchId!),
      loadColorBatchManifest(projectRoot, executeResult.batchId!),
      loadColorBatchValidation(projectRoot, executeResult.batchId!),
      loadColorBatchPromote(projectRoot, executeResult.batchId!),
      loadColorCurrent(projectRoot),
    ]);

    expect(snapshot?.groups[0]?.groupKey).toBe('base-group');
    expect(plan?.entries.map(entry => entry.rawRelativePath)).toEqual(['day1/A001.mov', 'day2/A001.mov']);
    expect(plan?.selectionMode).toBe('all');
    expect(manifest?.managedOutputSet).toEqual(['day1/A001.mp4', 'day2/A001.mp4']);
    expect(validation?.status).toBe('pass');
    expect(promote?.status).toBe('completed');
    expect(current.roots[0]).toMatchObject({
      latestBatchId: executeResult.batchId,
      latestBatchStatus: 'promoted',
      latestValidationStatus: 'pass',
      lastPromotedBatchId: executeResult.batchId,
    });

    expect(await readFile(join(currentLocalPath, 'day1', 'A001.mp4'), 'utf-8')).toBe('rendered:day1/A001.mov');
    expect(await readFile(join(currentLocalPath, 'day2', 'A001.mp4'), 'utf-8')).toBe('rendered:day2/A001.mov');
  });

  it('blocks prepare_root when rawLocalPath is missing', async () => {
    const workspaceRoot = await createWorkspace();
    const projectId = 'project-color-blocked';
    const { projectRoot, rootId } = await seedSingleRootProject({
      workspaceRoot,
      projectId,
      projectName: 'Project Color Blocked',
      includeRawLocalPath: false,
    });

    await expect(prepareProjectColorRoot({
      workspaceRoot,
      projectId,
      rootId,
      jobId: 'job-color-blocked',
      executor: createFakeExecutor(),
    })).rejects.toBeInstanceOf(ColorPrepBlockedError);

    const savedCurrent = await loadColorCurrent(projectRoot);
    expect(savedCurrent.roots[0]?.mirrorStatus).toBe('blocked');
    expect(savedCurrent.roots[0]?.detail).toContain('rawLocalPath');
  });

  it('passes current render preset and clip technical signals into prepare_root and execute_root requests', async () => {
    const workspaceRoot = await createWorkspace();
    const projectId = 'project-color-render-preset';
    const { rootId, rawLocalPath } = await seedSingleRootProject({
      workspaceRoot,
      projectId,
      projectName: 'Project Color Render Preset',
      renderPreset: {
        container: 'mov',
        videoCodec: 'prores',
        audioCodec: 'pcm',
        bitrateKbps: 240,
      },
      colorSpaceProfile: 'dlog-m',
    });

    mockColorMetadata({ codec: 'prores' });
    mockClipSignals({
      gyroEligible: true,
      lowlight: true,
      logProfile: 'dlog-m',
      deviceFamilyKeys: ['dji-osmo-pocket-3'],
    });

    const prepared: Array<Record<string, unknown>> = [];
    const executed: Array<Record<string, unknown>> = [];
    const executor = createFakeExecutor({
      onPrepareRoot: async input => {
        prepared.push({
          timelineSpec: input.timelineSpec,
          clips: input.clips,
        });
        return {
          resolveProjectName: input.resolveProjectName,
          gradingTimelineName: input.gradingTimelineName,
          mirrorStatus: 'synced',
          timelineStatus: 'ready',
          groupsSnapshot: buildGroupsSnapshot(input, 'prepare_root'),
        };
      },
      onExecuteRoot: async input => {
        executed.push({
          renderPreset: input.renderPreset,
          rawLocalPath: input.rawLocalPath,
          clips: input.clips,
        });
        return createFakeExecutor().executeRoot(input);
      },
    });

    await prepareProjectColorRoot({
      workspaceRoot,
      projectId,
      rootId,
      jobId: 'job-color-prepare',
      executor,
    });
    await executeProjectColorRoot({
      workspaceRoot,
      projectId,
      rootId,
      action: 'execute_root',
      jobId: 'job-color-execute',
      clipKeys: ['day1/A001.mov'],
      executor,
    });

    expect(prepared).toEqual([{
      timelineSpec: {
        width: 3840,
        height: 2160,
        fps: 30,
      },
      clips: [{
        rawRelativePath: 'day1/A001.mov',
        sourceAbsolutePath: join(rawLocalPath, 'day1', 'A001.mov'),
        sourceStem: 'A001',
        width: 3840,
        height: 2160,
        fps: 30,
        codec: 'prores',
        rawTags: {},
        detectedProfile: 'dlog-m',
        effectiveProfile: 'dlog-m',
        profileSource: 'detected',
        logProfile: 'dlog-m',
        gyroEligible: true,
        lowlight: true,
        deviceFamilyKeys: ['dji-osmo-pocket-3'],
        resolvedTransformPresetKey: undefined,
        resolvedLutRelativePath: undefined,
        resolvedLutAbsolutePath: undefined,
      }],
    }]);
    expect(executed).toEqual([{
      renderPreset: {
        container: 'mov',
        videoCodec: 'prores',
        audioCodec: 'pcm',
        bitrateKbps: 240,
      },
      rawLocalPath,
      clips: [{
        rawRelativePath: 'day1/A001.mov',
        sourceAbsolutePath: join(rawLocalPath, 'day1', 'A001.mov'),
        sourceStem: 'A001',
        width: 3840,
        height: 2160,
        fps: 30,
      }],
    }]);
  });

  it('rejects promote when the batch has been superseded by a newer latest batch', async () => {
    const workspaceRoot = await createWorkspace();
    const projectId = 'project-color-superseded';
    const { rootId } = await seedSingleRootProject({
      workspaceRoot,
      projectId,
      projectName: 'Project Color Superseded',
      rawFiles: ['day1/A001.mov', 'day2/A001.mov'],
    });

    mockColorMetadata();
    const executor = createFakeExecutor();

    await prepareProjectColorRoot({ workspaceRoot, projectId, rootId, executor });
    const batch1 = await executeProjectColorRoot({
      workspaceRoot,
      projectId,
      rootId,
      action: 'execute_root',
      executor,
    });
    await validateProjectColorBatch({
      workspaceRoot,
      projectId,
      rootId,
      action: 'validate_batch',
      batchId: batch1.batchId,
    });
    const batch2 = await executeProjectColorRoot({
      workspaceRoot,
      projectId,
      rootId,
      action: 'execute_root',
      executor,
    });
    expect(batch2.batchId).not.toBe(batch1.batchId);

    await expect(promoteProjectColorBatch({
      workspaceRoot,
      projectId,
      rootId,
      action: 'promote_batch',
      batchId: batch1.batchId,
    })).rejects.toBeInstanceOf(ProjectColorBlockedError);
  });

  it('returns blocked preflight when the vendored resolve backend is missing', async () => {
    const workspaceRoot = await createWorkspace();
    const projectId = 'project-color-preflight-missing-runtime';
    const projectRoot = await initWorkspaceProject(workspaceRoot, projectId, 'Project Color Preflight Missing Runtime');
    vi.spyOn(resolveExecutor, 'inspectResolveColorBackend').mockReturnValue({
      available: false,
      backendRoot: '/vendor/resolve-color-host',
      pythonPath: '/vendor/resolve-color-host/.venv/bin/python',
      scriptPath: '/vendor/resolve-color-host/resolve-color-host.py',
      missingPaths: ['/vendor/resolve-color-host/.venv/bin/python'],
      blockingReason: '未找到 vendored Resolve backend。 期望脚本：/vendor/resolve-color-host/resolve-color-host.py；期望 Python：/vendor/resolve-color-host/.venv/bin/python。 请先在 /vendor/resolve-color-host 下准备固定 backend 与 .venv。',
    });
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
    expect(result.blockingReasons[0]).toContain('vendored Resolve backend');
    expect((await loadColorCurrent(projectRoot)).hostPreflight?.status).toBe('blocked');
  });

  it('maps app-unavailable preflight failures into blocked host diagnostics', async () => {
    const workspaceRoot = await createWorkspace();
    const projectId = 'project-color-preflight-app-down';
    const projectRoot = await initWorkspaceProject(workspaceRoot, projectId, 'Project Color Preflight App Down');

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
        async executeRoot() {
          throw new Error('not used');
        },
      },
    });

    expect(result.status).toBe('blocked');
    expect(result.blockingReasons).toContain('Resolve is not running');
    expect((await loadColorCurrent(projectRoot)).hostPreflight?.status).toBe('blocked');
  });

  it('keeps degraded preflight results as executable diagnostics', async () => {
    const workspaceRoot = await createWorkspace();
    const projectId = 'project-color-preflight-degraded';
    const projectRoot = await initWorkspaceProject(workspaceRoot, projectId, 'Project Color Preflight Degraded');

    const result = await preflightProjectColorHost({
      workspaceRoot,
      projectId,
      executor: {
        async preflight() {
          return createReadyPreflight({
            status: 'degraded',
            warnings: ['legacy probe'],
            renderSupport: {
              containers: [{
                container: 'mp4',
                extension: 'mp4',
                videoCodecs: ['h265'],
              }],
              supportsAudioCodec: true,
              supportsVideoQuality: false,
            },
          });
        },
        async prepareRoot() {
          throw new Error('not used');
        },
        async syncGroups() {
          throw new Error('not used');
        },
        async executeRoot() {
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
    const { rootId } = await seedSingleRootProject({
      workspaceRoot,
      projectId,
      projectName: 'Project Color Retry Success',
    });
    mockColorMetadata();

    let attempts = 0;
    const executor: IColorExecutor = {
      async preflight() {
        return createReadyPreflight();
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
      async executeRoot() {
        throw new Error('not used');
      },
    };

    const promise = prepareProjectColorRoot({
      workspaceRoot,
      projectId,
      rootId,
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
    const { rootId } = await seedSingleRootProject({
      workspaceRoot,
      projectId,
      projectName: 'Project Color Retry Semantic',
    });
    mockColorMetadata();

    let attempts = 0;
    const executor: IColorExecutor = {
      async preflight() {
        return createReadyPreflight();
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
      async executeRoot() {
        throw new Error('not used');
      },
    };

    const promise = prepareProjectColorRoot({
      workspaceRoot,
      projectId,
      rootId,
      executor,
    });
    await vi.runAllTimersAsync();
    await expect(promise).rejects.toMatchObject({ code: 'resolve_media_pool_import_failed' });
    expect(attempts).toBe(1);
  });

  it('blocks execute_root before render when host render support rejects the preset', async () => {
    const workspaceRoot = await createWorkspace();
    const projectId = 'project-color-render-support-blocked';
    const { rootId } = await seedSingleRootProject({
      workspaceRoot,
      projectId,
      projectName: 'Project Color Render Support Blocked',
      renderPreset: {
        container: 'mov',
        videoCodec: 'prores',
        audioCodec: 'pcm',
        bitrateKbps: 240,
      },
    });
    mockColorMetadata();

    let executeCalls = 0;
    const executor = createFakeExecutor({
      preflightResult: createReadyPreflight({
        renderSupport: {
          containers: [{
            container: 'mp4',
            extension: 'mp4',
            videoCodecs: ['h265'],
          }],
          supportsAudioCodec: false,
          supportsVideoQuality: false,
        },
      }),
      onExecuteRoot: async () => {
        executeCalls += 1;
        throw new Error('should not execute');
      },
    });

    await prepareProjectColorRoot({
      workspaceRoot,
      projectId,
      rootId,
      executor,
    });
    await expect(executeProjectColorRoot({
      workspaceRoot,
      projectId,
      rootId,
      action: 'execute_root',
      executor,
    })).rejects.toBeInstanceOf(ProjectColorBlockedError);
    expect(executeCalls).toBe(0);
  });

  it('prepare_all_roots respects priority order and continues after failures', async () => {
    const workspaceRoot = await createWorkspace();
    const projectId = 'project-color-prepare-all';
    const projectRoot = await initWorkspaceProject(workspaceRoot, projectId, 'Project Color Prepare All');
    const rawFail = join(projectRoot, '.fixtures', 'root-z-raw');
    const rawReady = join(projectRoot, '.fixtures', 'root-a-raw');
    await mkdir(join(rawFail, 'day1'), { recursive: true });
    await mkdir(join(rawReady, 'day1'), { recursive: true });
    await writeFile(join(rawFail, 'day1', 'A001.mov'), 'raw-z', 'utf-8');
    await writeFile(join(rawReady, 'day1', 'A001.mov'), 'raw-a', 'utf-8');
    await saveIngestRoots(projectRoot, {
      roots: [{
        id: 'root-z',
        label: 'Z Root',
        priority: 1,
        path: '/media/current/root-z',
        rawPath: '/media/raw/root-z',
        enabled: true,
      }, {
        id: 'root-a',
        label: 'A Root',
        priority: 2,
        path: '/media/current/root-a',
        rawPath: '/media/raw/root-a',
        enabled: true,
      }],
    });
    await saveProjectDeviceMap(projectRoot, projectId, {
      roots: [{
        rootId: 'root-z',
        localPath: join(projectRoot, '.fixtures', 'root-z-current'),
        rawLocalPath: rawFail,
      }, {
        rootId: 'root-a',
        localPath: join(projectRoot, '.fixtures', 'root-a-current'),
        rawLocalPath: rawReady,
      }],
    });
    mockColorMetadata();

    const prepareOrder: string[] = [];
    const executor = createFakeExecutor({
      onPrepareRoot: async input => {
        prepareOrder.push(input.rootId);
        if (input.rootId === 'root-z') {
          throw new ResolveColorHostError({
            code: 'resolve_prepare_failed',
            message: 'prepare failed for root-z',
            requestPath: '/tmp/request.json',
          });
        }
        return {
          resolveProjectName: input.resolveProjectName,
          gradingTimelineName: input.gradingTimelineName,
          mirrorStatus: 'synced',
          timelineStatus: 'ready',
          groupsSnapshot: buildGroupsSnapshot(input, 'prepare_root'),
        };
      },
    });

    const result = await prepareAllProjectColorRoots({
      workspaceRoot,
      projectId,
      action: 'prepare_all_roots',
      executor,
    });

    expect(prepareOrder).toEqual(['root-z', 'root-a']);
    expect(result.roots).toEqual([
      {
        rootId: 'root-z',
        status: 'failed',
        actionSummary: 'prepare failed for root-z',
        error: 'prepare failed for root-z',
      },
      {
        rootId: 'root-a',
        status: 'succeeded',
        actionSummary: 'Resolve host root prep 已完成。 Kairos 已写入 1 个 Resolve Groups 快照。 如需复核 Resolve 内调整，可继续运行 Sync Groups。',
      },
    ]);
    expect(result.detail).toBe('Prepare All Roots 完成：1 个成功，1 个失败。');
    const colorCurrent = await loadColorCurrent(projectRoot);
    const failedRoot = colorCurrent.roots.find(root => root.rootId === 'root-z');
    const readyRoot = colorCurrent.roots.find(root => root.rootId === 'root-a');
    expect(failedRoot).toMatchObject({
      mirrorStatus: 'blocked',
      timelineStatus: 'blocked',
      detail: 'prepare failed for root-z',
      blockingReasons: ['prepare failed for root-z'],
    });
    expect(failedRoot?.currentJobId).toBeUndefined();
    expect(readyRoot).toMatchObject({
      mirrorStatus: 'synced',
      timelineStatus: 'ready',
    });
    expect(readyRoot?.currentJobId).toBeUndefined();
  });

  it('rejects rootId for project-scoped color actions', async () => {
    await expect(runProjectColorAction({
      workspaceRoot: await createWorkspace(),
      projectId: 'project-color-project-scoped-rootid',
      rootId: 'root-a',
      action: 'prepare_all_roots',
      executor: createFakeExecutor(),
    })).rejects.toBeInstanceOf(ProjectColorBlockedError);
  });

  it('export_all_roots continues after failures and aggregates per-root results', async () => {
    const workspaceRoot = await createWorkspace();
    const projectId = 'project-color-export-all';
    const projectRoot = await initWorkspaceProject(workspaceRoot, projectId, 'Project Color Export All');
    const rawFail = join(projectRoot, '.fixtures', 'root-fail-raw');
    const rawReady = join(projectRoot, '.fixtures', 'root-ready-raw');
    const currentReady = join(projectRoot, '.fixtures', 'root-ready-current');
    await mkdir(join(rawFail, 'day1'), { recursive: true });
    await mkdir(join(rawReady, 'day1'), { recursive: true });
    await writeFile(join(rawFail, 'day1', 'A001.mov'), 'raw-fail', 'utf-8');
    await writeFile(join(rawReady, 'day1', 'A001.mov'), 'raw-ready', 'utf-8');
    await saveIngestRoots(projectRoot, {
      roots: [{
        id: 'root-fail',
        label: 'Fail Root',
        priority: 1,
        path: '/media/current/root-fail',
        rawPath: '/media/raw/root-fail',
        enabled: true,
        color: {
          renderPreset: {
            container: 'mp4',
            videoCodec: 'h265',
            audioCodec: 'aac',
          },
        },
      }, {
        id: 'root-ready',
        label: 'Ready Root',
        priority: 2,
        path: '/media/current/root-ready',
        rawPath: '/media/raw/root-ready',
        enabled: true,
        color: {
          renderPreset: {
            container: 'mp4',
            videoCodec: 'h265',
            audioCodec: 'aac',
            bitrateKbps: 120,
          },
        },
      }],
    });
    await saveProjectDeviceMap(projectRoot, projectId, {
      roots: [{
        rootId: 'root-fail',
        localPath: join(projectRoot, '.fixtures', 'root-fail-current'),
        rawLocalPath: rawFail,
      }, {
        rootId: 'root-ready',
        localPath: currentReady,
        rawLocalPath: rawReady,
      }],
    });
    mockColorMetadata();

    const result = await exportAllProjectColorRoots({
      workspaceRoot,
      projectId,
      action: 'export_all_roots',
      executor: createFakeExecutor(),
    });

    expect(result.roots?.map(root => root.rootId)).toEqual(['root-fail', 'root-ready']);
    expect(result.roots?.[0]).toMatchObject({
      rootId: 'root-fail',
      status: 'failed',
      actionSummary: '未配置 root 级 renderPreset.bitrateKbps（kb/s），无法启动 execute_root。',
      error: '未配置 root 级 renderPreset.bitrateKbps（kb/s），无法启动 execute_root。',
    });
    expect(result.roots?.[1]).toMatchObject({
      rootId: 'root-ready',
      status: 'succeeded',
    });
    expect(result.detail).toBe('Export All Roots 完成：1 个成功，1 个失败。');
    expect(await readFile(join(currentReady, 'day1', 'A001.mp4'), 'utf-8')).toBe('rendered:day1/A001.mov');
  });
});
