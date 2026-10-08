import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as mediaProbe from '../../src/modules/media/probe.js';
import * as captureTime from '../../src/modules/media/capture-time.js';
import * as colorCastClassifier from '../../src/modules/color/color-cast-classifier.js';
import * as exposureSceneClassifier from '../../src/modules/color/exposure-scene-classifier.js';
import * as lowlightClassifier from '../../src/modules/color/lowlight-classifier.js';
import * as windshieldHazeClassifier from '../../src/modules/color/windshield-haze-classifier.js';
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
  registerExternalColorDrpSnapshot,
  relinkAllProjectColorRoots,
  relinkProjectColorRootMedia,
  runProjectColorAction,
  snapshotProjectColorDrp,
  syncProjectColorBatchMetadata,
  syncProjectColorBatchSidecars,
  syncProjectColorGroups,
  validateProjectColorBatch,
} from '../../src/modules/color/project-color.js';
import {
  ResolveColorHostError,
  type IColorExecutor,
  type IColorExecutorClipInput,
  type IColorExecutorPrepareRootInput,
  type IColorExecutorRelinkMediaInput,
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
  loadColorResolveProjectMap,
  saveColorTransformPresetsConfig,
  saveColorCurrent,
  saveColorGroupsSnapshot,
  saveIngestRoots,
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
    encodedWidth: clip.encodedWidth,
    encodedHeight: clip.encodedHeight,
    displayWidth: clip.displayWidth,
    displayHeight: clip.displayHeight,
    rotationDegrees: clip.rotationDegrees,
    orientationStatus: clip.orientationStatus,
    repairTemplateKey: clip.repairTemplateKey,
    repairTemplateHash: clip.previousRepairTemplateHash,
    timelineTransform: clip.timelineTransform,
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
  onRelinkMedia?: NonNullable<IColorExecutor['relinkMedia']>;
  onPrepareRoot?: NonNullable<IColorExecutor['prepareRoot']>;
  onSyncGroups?: NonNullable<IColorExecutor['syncGroups']>;
  onExecuteRoot?: NonNullable<IColorExecutor['executeRoot']>;
  onSaveDrpSnapshot?: NonNullable<IColorExecutor['saveDrpSnapshot']>;
} = {}): IColorExecutor {
  return {
    async preflight() {
      return options.preflightResult ?? createReadyPreflight();
    },
    async relinkMedia(input) {
      if (options.onRelinkMedia) {
        return options.onRelinkMedia(input);
      }
      return {
        resolveProjectName: input.resolveProjectName,
        rootNamespace: input.rootNamespace,
        gradingTimelineName: input.gradingTimelineName,
        createdAt: '2026-07-05T10:00:00.000Z',
        hostSummary: {
          rootNamespace: input.rootNamespace,
          gradingTimelineName: input.gradingTimelineName,
          relinked: 0,
          relinkFolderCount: 0,
          oldPathRemaining: 0,
          timelineOldPathRemaining: 0,
        },
      };
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
          const outputDir = join(input.outputRoot, ...relativeParts.slice(0, -1));
          const outputPath = join(outputDir, outputFilename);
          await mkdir(outputDir, { recursive: true });
          await writeFile(outputPath, `rendered:${clip.rawRelativePath}`, 'utf-8');
          return {
            rawRelativePath: clip.rawRelativePath,
            outputPath,
            normalizedOutputFilename: outputFilename,
            renderJobId: 'job-main',
          };
        }),
      );
      return {
        renderedAt: '2026-04-19T10:05:00.000Z',
        entries,
        renderJobs: [{
          jobId: 'job-main',
          timelineName: input.gradingTimelineName,
          targetDir: input.outputRoot,
          clipCount: input.clips.length,
        }],
      };
    },
    async saveDrpSnapshot(input) {
      if (options.onSaveDrpSnapshot) {
        return options.onSaveDrpSnapshot(input);
      }
      const latestFilename = input.latestFilename ?? 'latest.drp';
      const latestPath = join(input.snapshotRoot, latestFilename);
      const retention = input.retention === 'archive' ? 'archive' : 'latest-only';
      const snapshotPath = retention === 'archive'
        ? join(input.snapshotRoot, 'snapshots', `${input.snapshotLabel || 'manual'}.drp`)
        : latestPath;
      if (retention === 'archive') {
        await mkdir(join(input.snapshotRoot, 'snapshots'), { recursive: true });
        await writeFile(snapshotPath, 'drp', 'utf-8');
      }
      await mkdir(input.snapshotRoot, { recursive: true });
      await writeFile(latestPath, 'drp', 'utf-8');
      return {
        snapshot: {
          projectName: input.resolveProjectName,
          snapshotPath,
          latestPath,
          createdAt: '2026-04-19T10:06:00.000Z',
          mode: input.action === 'manual' ? 'manual' as const : 'auto' as const,
          retention,
          action: input.action,
          rootId: input.rootId,
          chunkId: (input.chunkId ?? null) as unknown as string | undefined,
        },
      };
    },
  };
}

function mockColorMetadata(options: {
  includeCaptureTime?: boolean;
  includeGps?: boolean;
  codec?: string;
  width?: number;
  height?: number;
  displayWidth?: number;
  displayHeight?: number;
  rotationDegrees?: number;
} = {}) {
  vi.spyOn(mediaProbe, 'probe').mockImplementation(async filePath => ({
    durationMs: 1000,
    width: options.width ?? 3840,
    height: options.height ?? 2160,
    displayWidth: options.displayWidth ?? options.width ?? 3840,
    displayHeight: options.displayHeight ?? options.height ?? 2160,
    rotationDegrees: options.rotationDegrees ?? null,
    fps: 30,
    codec: options.codec ?? (filePath.endsWith('.mp4') ? 'h265' : 'prores'),
    codecProfile: (options.codec ?? (filePath.endsWith('.mp4') ? 'h265' : 'prores')) === 'h265'
      ? 'Main 10'
      : null,
    pixelFormat: (options.codec ?? (filePath.endsWith('.mp4') ? 'h265' : 'prores')) === 'h265'
      ? 'yuv420p10le'
      : 'yuv422p10le',
    bitDepth: 10,
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
  windshieldHaze?: boolean;
  windshieldHazeConfidence?: number;
  colorCastClass?: 'neutral' | 'cool-cyan' | 'green-cyan' | 'green' | 'warm' | 'mixed' | 'unknown';
  colorCastConfidence?: number;
  exposureSceneClass?: 'normal' | 'high-contrast' | 'overexposed' | 'underexposed' | 'unknown';
  exposureSceneConfidence?: number;
  logProfile?: string;
  deviceFamilyKeys?: string[];
} = {}) {
  vi.spyOn(sourceTruth, 'extractColorSourceTruth').mockResolvedValue({
    logProfile: (options.logProfile ?? 'slog3') as never,
    gyro: options.gyroEligible,
    gyroDataAvailable: options.gyroEligible === true ? true : undefined,
    deviceFamilyKeys: options.deviceFamilyKeys ?? ['sony'],
    sourceKinds: [],
  });
  vi.spyOn(lowlightClassifier, 'classifyMidpointLowlight').mockResolvedValue({
    lowlight: options.lowlight ?? false,
    metrics: undefined,
  });
  vi.spyOn(windshieldHazeClassifier, 'classifyWindshieldHaze').mockResolvedValue({
    windshieldHaze: options.windshieldHaze ?? false,
    windshieldHazeConfidence: options.windshieldHazeConfidence ?? 0,
    windshieldHazeMetrics: {
      frameCount: 1,
      classifiedFrameCount: 1,
      positiveFrameCount: options.windshieldHaze ? 1 : 0,
      positiveFrameRatio: options.windshieldHaze ? 1 : 0,
      meanConfidence: options.windshieldHazeConfidence ?? 0,
      frames: [],
    },
  });
  vi.spyOn(colorCastClassifier, 'classifyColorCast').mockResolvedValue({
    colorCastClass: options.colorCastClass ?? 'neutral',
    colorCastConfidence: options.colorCastConfidence ?? 0.9,
    colorCastMetrics: {},
  });
  vi.spyOn(exposureSceneClassifier, 'classifyExposureScene').mockResolvedValue({
    exposureSceneClass: options.exposureSceneClass ?? 'normal',
    exposureSceneConfidence: options.exposureSceneConfidence ?? 0.9,
    exposureSceneMetrics: {},
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
  includeDefaultRepairDrt?: boolean;
}) {
  const projectRoot = await initWorkspaceProject(input.workspaceRoot, input.projectId, input.projectName);
  const rootId = input.rootId ?? 'root-camera';
  if (input.includeDefaultRepairDrt !== false) {
    await mkdir(join(input.workspaceRoot, 'config'), { recursive: true });
    await writeFile(join(input.workspaceRoot, 'config', 'default.drt'), 'default repair template', 'utf-8');
  }
  const rawLocalPath = join(projectRoot, '.fixtures', `${rootId}-raw`);
  const currentLocalPath = join(projectRoot, '.fixtures', `${rootId}-current`);
  await mkdir(currentLocalPath, { recursive: true });
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
      alternatePaths: [{
        path: currentLocalPath,
        rawPath: input.includeRawLocalPath === false ? undefined : rawLocalPath,
      }],
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
  return {
    projectRoot,
    rootId,
    rawLocalPath,
    currentLocalPath,
  };
}

describe('project color actions', () => {
  it('persists groups snapshot after prepare completion sync', async () => {
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
    expect(snapshot?.groups[0]?.hostSummary.origin).toBe('resolve');
    expect(snapshot?.groups[0]?.clips[0]).toMatchObject({
      gyroEligible: true,
      dehazeStatus: 'seeded-disabled',
      nrStatus: 'seeded-disabled',
      layoutStatus: 'canonical',
      reservedNodeIndices: { gyro: 1, dehaze: 2, userStart: 3, userEnd: 4, nr: 5 },
    });
    expect(current.roots[0]?.groupSyncStatus).toBe('ready');
    expect(current.roots[0]?.groups[0]?.status).toBe('ready');
    expect(current.roots[0]?.latestDrpSnapshot?.latestPath).toMatch(/Project Color Prepare Snapshot \[Color\]\.drp$/u);
  });

  it('blocks prepare_root before Resolve mutation when the default repair DRT is missing', async () => {
    const workspaceRoot = await createWorkspace();
    const projectId = 'project-color-missing-default-drt';
    const { projectRoot, rootId } = await seedSingleRootProject({
      workspaceRoot,
      projectId,
      projectName: 'Project Color Missing Default DRT',
      includeDefaultRepairDrt: false,
    });

    mockColorMetadata();
    mockClipSignals({ gyroEligible: true, lowlight: true });
    const prepareRootSpy = vi.fn(async (input: IColorExecutorPrepareRootInput) => (
      createFakeExecutor().prepareRoot(input)
    ));
    await expect(prepareProjectColorRoot({
      workspaceRoot,
      projectId,
      rootId,
      jobId: 'job-color-missing-default-drt',
      executor: createFakeExecutor({
        onPrepareRoot: prepareRootSpy,
      }),
    })).rejects.toBeInstanceOf(ColorPrepBlockedError);

    expect(prepareRootSpy).not.toHaveBeenCalled();
    const current = await loadColorCurrent(projectRoot);
    const root = current.roots.find(candidate => candidate.rootId === rootId);
    expect(root).toMatchObject({
      mirrorStatus: 'blocked',
      timelineStatus: 'blocked',
    });
    expect(root?.detail).toContain('config/default.drt');
    expect(root?.detail).toContain('五节点');
    expect(root?.prepareChunks.map(chunk => chunk.status)).toEqual(['failed']);
  });

  it('syncs existing Resolve groups without forwarding legacy visual diagnoses', async () => {
    const workspaceRoot = await createWorkspace();
    const projectId = 'project-color-sync-lightweight';
    const { rootId, projectRoot } = await seedSingleRootProject({
      workspaceRoot,
      projectId,
      projectName: 'Project Color Sync Lightweight',
      rawFiles: ['day1/A001.mov', 'day1/A002.mov'],
    });

    mockColorMetadata();
    mockClipSignals({ gyroEligible: true, lowlight: true });
    const executor = createFakeExecutor();
    await prepareProjectColorRoot({
      workspaceRoot,
      projectId,
      rootId,
      executor,
    });

    // Old snapshots may still contain confident false diagnoses. Sync must not reintroduce them.
    const oldSnapshot = (await loadColorGroupsSnapshot(projectRoot, rootId))!;
    oldSnapshot.groups[0]!.displayName = 'My graded green group';
    for (const clip of oldSnapshot.groups[0]!.clips) {
      clip.lowlight = true;
      clip.windshieldHaze = true;
      clip.colorCastClass = 'green';
      clip.colorCastConfidence = 0.99;
      clip.exposureSceneClass = 'underexposed';
    }
    await saveColorGroupsSnapshot(projectRoot, oldSnapshot);
    const lowlightSpy = vi.mocked(lowlightClassifier.classifyMidpointLowlight);
    const windshieldSpy = vi.mocked(windshieldHazeClassifier.classifyWindshieldHaze);
    const colorCastSpy = vi.mocked(colorCastClassifier.classifyColorCast);
    const exposureSpy = vi.mocked(exposureSceneClassifier.classifyExposureScene);
    lowlightSpy.mockClear();
    windshieldSpy.mockClear();
    colorCastSpy.mockClear();
    exposureSpy.mockClear();
    const syncedInputs: IColorExecutorSyncGroupsInput[] = [];
    await syncProjectColorGroups({
      workspaceRoot,
      projectId,
      rootId,
      action: 'sync_groups',
      jobId: 'job-color-sync-lightweight',
      executor: createFakeExecutor({
        onSyncGroups: async input => {
          syncedInputs.push(input);
          return buildGroupsSnapshot(input, 'resolve');
        },
      }),
    });

    expect(lowlightSpy).not.toHaveBeenCalled();
    expect(windshieldSpy).not.toHaveBeenCalled();
    expect(colorCastSpy).not.toHaveBeenCalled();
    expect(exposureSpy).not.toHaveBeenCalled();
    expect(syncedInputs[0]?.clips.map(clip => clip.lowlight)).toEqual([undefined, undefined]);
    expect(syncedInputs[0]?.clips.map(clip => clip.windshieldHaze)).toEqual([undefined, undefined]);
    expect(syncedInputs[0]?.clips.map(clip => clip.colorCastClass)).toEqual([undefined, undefined]);
    expect(syncedInputs[0]?.clips.map(clip => clip.exposureSceneClass)).toEqual([undefined, undefined]);
  });

  it('lets sync_groups recover a stale blocked prepare state when Resolve groups already exist', async () => {
    const workspaceRoot = await createWorkspace();
    const projectId = 'project-color-sync-recovers-stale-prepare';
    const { projectRoot, rootId } = await seedSingleRootProject({
      workspaceRoot,
      projectId,
      projectName: 'Project Color Sync Recovers Stale Prepare',
      rawFiles: ['day1/A001.mov', 'day1/A002.mov'],
    });

    mockColorMetadata();
    mockClipSignals({ gyroEligible: true, lowlight: true });
    const executor = createFakeExecutor();
    await prepareProjectColorRoot({
      workspaceRoot,
      projectId,
      rootId,
      executor,
    });

    const preparedCurrent = await loadColorCurrent(projectRoot);
    await saveColorCurrent(projectRoot, {
      ...preparedCurrent,
      roots: preparedCurrent.roots.map(root => root.rootId === rootId
        ? {
            ...root,
            mirrorStatus: 'blocked',
            timelineStatus: 'blocked',
            groupSyncStatus: 'blocked',
            activeStage: 'sync_root_bins',
            detail: 'Unable to append clip to grading timeline: day1/A001.mov',
            blockingReasons: ['Unable to append clip to grading timeline: day1/A001.mov'],
            prepareChunks: root.prepareChunks.map(chunk => ({ ...chunk, status: 'failed' as const })),
          }
        : root),
    });

    await syncProjectColorGroups({
      workspaceRoot,
      projectId,
      rootId,
      action: 'sync_groups',
      jobId: 'job-color-sync-recovers-stale-prepare',
      executor: createFakeExecutor({
        onSyncGroups: async input => buildGroupsSnapshot(input, 'resolve'),
      }),
    });

    const recoveredCurrent = await loadColorCurrent(projectRoot);
    const recoveredRoot = recoveredCurrent.roots.find(root => root.rootId === rootId);
    expect(recoveredRoot).toMatchObject({
      mirrorStatus: 'synced',
      timelineStatus: 'ready',
      groupSyncStatus: 'ready',
      blockingReasons: [],
    });
    expect(recoveredRoot?.activeStage).toBeUndefined();
    expect(recoveredRoot?.detail).toContain('已同步');
  });

  it.each([true, false])('prepares profile, orientation, LUT and Gyro without visual classifiers (LUT: %s)', async withLut => {
    const workspaceRoot = await createWorkspace();
    const projectId = 'project-color-metadata-only';
    const { rootId } = await seedSingleRootProject({
      workspaceRoot, projectId, projectName: 'Metadata Only', colorSpaceProfile: 'slog3',
    });
    const relativeLutPath = 'Sony/SLog3SGamut3.CineToLC-709.cube';
    if (withLut) {
      await mkdir(join(workspaceRoot, 'config', 'luts', 'Sony'), { recursive: true });
      await writeFile(join(workspaceRoot, 'config', 'luts', relativeLutPath), 'TITLE "test"\nLUT_3D_SIZE 2\n0 0 0\n0 0 1\n0 1 0\n0 1 1\n1 0 0\n1 0 1\n1 1 0\n1 1 1\n');
      await saveColorTransformPresetsConfig(workspaceRoot, {
        profiles: { slog3: { default: relativeLutPath } },
      });
    }
    mockColorMetadata();
    mockClipSignals({ gyroEligible: true, lowlight: true, colorCastClass: 'green', colorCastConfidence: 0.99 });
    const prepared: IColorExecutorPrepareRootInput[] = [];
    await prepareProjectColorRoot({
      workspaceRoot, projectId, rootId,
      executor: createFakeExecutor({
        onPrepareRoot: async input => {
          prepared.push(input);
          return createFakeExecutor().prepareRoot(input);
        },
      }),
    });
    expect(lowlightClassifier.classifyMidpointLowlight).not.toHaveBeenCalled();
    expect(colorCastClassifier.classifyColorCast).not.toHaveBeenCalled();
    expect(exposureSceneClassifier.classifyExposureScene).not.toHaveBeenCalled();
    expect(windshieldHazeClassifier.classifyWindshieldHaze).not.toHaveBeenCalled();
    expect(prepared[0]?.clips[0]).toMatchObject({
      logProfile: 'slog3', orientationStatus: 'horizontal', gyroEligible: true,
      repairTemplateKey: 'default',
    });
    expect(prepared[0]?.clips[0]?.resolvedLutRelativePath).toBe(withLut ? relativeLutPath : undefined);
    for (const key of ['lowlight', 'colorCastClass', 'colorCastMetrics', 'exposureSceneClass', 'windshieldHaze']) {
      expect(prepared[0]?.clips[0]).not.toHaveProperty(key);
    }
  });

  it('keeps motion-data evidence unknown when eligibility comes only from a gyroflow project', async () => {
    const workspaceRoot = await createWorkspace();
    const projectId = 'project-color-gyro-evidence';
    const { rootId } = await seedSingleRootProject({ workspaceRoot, projectId, projectName: 'Gyro evidence' });
    mockColorMetadata();
    mockClipSignals();
    vi.mocked(sourceTruth.extractColorSourceTruth).mockResolvedValue({
      gyro: true, gyroDataAvailable: undefined, deviceFamilyKeys: [], sourceKinds: ['gyroflow-project'],
    });
    const clips: IColorExecutorClipInput[] = [];
    await prepareProjectColorRoot({
      workspaceRoot, projectId, rootId,
      executor: createFakeExecutor({ onPrepareRoot: async input => {
        clips.push(...input.clips);
        return createFakeExecutor().prepareRoot(input);
      } }),
    });
    expect(clips).toHaveLength(1);
    expect(clips[0]?.gyroEligible).toBe(true);
    expect(clips[0]?.gyroDataAvailable).toBeUndefined();
  });

  it('prepares large roots in stable 50 clip chunks and records DRP snapshots', async () => {
    const workspaceRoot = await createWorkspace();
    const projectId = 'project-color-prepare-chunks';
    const rawFiles = Array.from({ length: 125 }, (_, index) => `day1/A${String(index + 1).padStart(4, '0')}.mov`);
    const { projectRoot, rootId } = await seedSingleRootProject({
      workspaceRoot,
      projectId,
      projectName: 'Project Color Prepare Chunks',
      rawFiles,
    });
    mockColorMetadata();
    mockClipSignals();
    const preparedChunks: IColorExecutorPrepareRootInput[] = [];
    const savedDrpSnapshots: string[] = [];
    const savedDrpRetentions: Array<'latest-only' | 'archive' | undefined> = [];
    const executor = createFakeExecutor({
      onPrepareRoot: async input => {
        preparedChunks.push(input);
        return {
          resolveProjectName: input.resolveProjectName,
          gradingTimelineName: input.gradingTimelineName,
          mirrorStatus: 'synced',
          timelineStatus: 'ready',
          groupsSnapshot: buildGroupsSnapshot(input, 'prepare_root'),
          hostSummary: {},
        };
      },
      onSaveDrpSnapshot: async input => {
        savedDrpSnapshots.push(input.snapshotLabel ?? '');
        savedDrpRetentions.push(input.retention);
        return createFakeExecutor().saveDrpSnapshot(input);
      },
    });

    await prepareProjectColorRoot({
      workspaceRoot,
      projectId,
      rootId,
      executor,
    });

    expect(preparedChunks).toHaveLength(3);
    expect(preparedChunks.map(input => input.clips.length)).toEqual([50, 50, 25]);
    expect(preparedChunks.every(input => typeof input.repairDrtPath === 'string')).toBe(true);
    expect(preparedChunks.every(input => !('repairDrxPath' in input))).toBe(true);
    expect(preparedChunks.map(input => input.gradingTimelineName)).toEqual([
      'current root-camera [Color]',
      'current root-camera [Color]',
      'current root-camera [Color]',
    ]);
    expect(preparedChunks.map(input => input.resetTimeline)).toEqual([true, false, false]);
    expect(savedDrpSnapshots).toEqual([`prepare-root-${rootId}-complete`]);
    expect(savedDrpRetentions).toEqual(['latest-only']);
    const currentRoot = (await loadColorCurrent(projectRoot)).roots.find(root => root.rootId === rootId);
    expect(currentRoot?.prepareChunks.map(chunk => chunk.status)).toEqual(['ready', 'ready', 'ready']);
    expect(currentRoot?.prepareChunks.map(chunk => chunk.timelineName)).toEqual([
      'current root-camera [Color]',
      'current root-camera [Color]',
      'current root-camera [Color]',
    ]);
    const resolveMap = await loadColorResolveProjectMap(projectRoot);
    const latest = resolveMap.projects[preparedChunks[0]!.resolveProjectName]?.latestSnapshot;
    expect(latest?.action).toBe('prepare_root');
    expect(latest?.chunkId).toBeUndefined();
  });

  it('runs prepare -> sync -> execute and persists root runtime/archive truth', async () => {
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
    const [snapshot, plan, manifest, validation, current] = await Promise.all([
      loadColorGroupsSnapshot(projectRoot, rootId),
      loadColorBatchPlan(projectRoot, executeResult.batchId!),
      loadColorBatchManifest(projectRoot, executeResult.batchId!),
      loadColorBatchValidation(projectRoot, executeResult.batchId!),
      loadColorCurrent(projectRoot),
    ]);

    expect(snapshot?.groups[0]?.groupKey).toBe('base-group');
    expect(plan?.entries.map(entry => entry.rawRelativePath)).toEqual(['day1/A001.mov', 'day2/A001.mov']);
    expect(plan?.selectionMode).toBe('all');
    expect(plan?.outputRoot).toBe(currentLocalPath);
    expect(Object.prototype.hasOwnProperty.call(plan ?? {}, 'holdingRoot')).toBe(false);
    expect(manifest?.managedOutputSet).toEqual(['day1/A001.mp4', 'day2/A001.mp4']);
    expect(manifest?.entries.map(entry => entry.outputPath)).toEqual([
      join(currentLocalPath, 'day1', 'A001.mp4'),
      join(currentLocalPath, 'day2', 'A001.mp4'),
    ]);
    expect(manifest?.metadataRepair).toMatchObject({
      status: 'pending',
      repairedCount: 0,
    });
    expect(manifest?.managedSidecarSet).toEqual([]);
    expect(validation).toBeNull();
    expect(current.roots[0]).toMatchObject({
      latestBatchId: executeResult.batchId,
      latestBatchStatus: 'rendered',
      latestValidationStatus: 'pending',
    });

    expect(await readFile(join(currentLocalPath, 'day1', 'A001.mp4'), 'utf-8')).toBe('rendered:day1/A001.mov');
    expect(await readFile(join(currentLocalPath, 'day2', 'A001.mp4'), 'utf-8')).toBe('rendered:day2/A001.mov');
  });

  it('defaults execute_root to synced Resolve group clips instead of raw inventory', async () => {
    const workspaceRoot = await createWorkspace();
    const projectId = 'project-color-execute-synced-selection';
    const { projectRoot, rootId, rawLocalPath, currentLocalPath } = await seedSingleRootProject({
      workspaceRoot,
      projectId,
      projectName: 'Project Color Execute Synced Selection',
      rawFiles: ['day1/A001.mov', 'day1/A002.mov', 'day2/A003.mov'],
    });
    const syncedClipKeys = ['day1/A001.mov', 'day2/A003.mov'];
    const syncedClips: IColorExecutorClipInput[] = syncedClipKeys.map(rawRelativePath => {
      const filename = rawRelativePath.split('/').at(-1) ?? rawRelativePath;
      return {
        rawRelativePath,
        sourceAbsolutePath: join(rawLocalPath, ...rawRelativePath.split('/')),
        sourceStem: filename.replace(/\.[^.]+$/, ''),
      };
    });
    await saveColorGroupsSnapshot(projectRoot, buildGroupsSnapshot({
      rootId,
      gradingTimelineName: 'Root [Color]',
      clips: syncedClips,
    }, 'resolve'));

    mockColorMetadata();
    let executedClipKeys: string[] = [];
    const executeResult = await executeProjectColorRoot({
      workspaceRoot,
      projectId,
      rootId,
      action: 'execute_root',
      executor: createFakeExecutor({
        onExecuteRoot: async input => {
          executedClipKeys = input.clips.map(clip => clip.rawRelativePath);
          return createFakeExecutor().executeRoot(input);
        },
      }),
    });
    const plan = await loadColorBatchPlan(projectRoot, executeResult.batchId!);

    expect(plan?.selectionMode).toBe('all');
    expect(plan?.entries.map(entry => entry.rawRelativePath)).toEqual(syncedClipKeys);
    expect(executedClipKeys).toEqual(syncedClipKeys);
    await expect(readFile(join(currentLocalPath, 'day1', 'A002.mp4'), 'utf-8')).rejects.toThrow();
  });

  it('fails batch validation when an H.265 render is not Main10 10-bit', async () => {
    const workspaceRoot = await createWorkspace();
    const projectId = 'project-color-main10-validation';
    const { projectRoot, rootId } = await seedSingleRootProject({
      workspaceRoot,
      projectId,
      projectName: 'Project Color Main10 Validation',
      rawFiles: ['day1/A001.mov'],
    });

    mockColorMetadata();
    const executor = createFakeExecutor();
    await prepareProjectColorRoot({ workspaceRoot, projectId, rootId, executor });
    const executeResult = await executeProjectColorRoot({
      workspaceRoot,
      projectId,
      rootId,
      action: 'execute_root',
      executor,
    });

    vi.spyOn(mediaProbe, 'probe').mockImplementation(async filePath => {
      const isOutput = filePath.endsWith('.mp4');
      return {
        durationMs: 1000,
        width: 3840,
        height: 2160,
        displayWidth: 3840,
        displayHeight: 2160,
        rotationDegrees: null,
        fps: 30,
        codec: isOutput ? 'hevc' : 'prores',
        codecProfile: isOutput ? 'Main' : 'HQ',
        pixelFormat: isOutput ? 'yuv420p' : 'yuv422p10le',
        bitDepth: isOutput ? 8 : 10,
        hasAudioStream: true,
        audioStreamCount: 1,
        audioCodec: 'aac',
        audioSampleRate: 48000,
        audioChannels: 2,
        audioBitRate: 192000,
        creationTime: null,
        rawTags: {},
      };
    });

    const validationResult = await validateProjectColorBatch({
      workspaceRoot,
      projectId,
      rootId,
      action: 'validate_batch',
      batchId: executeResult.batchId,
    });
    const validation = await loadColorBatchValidation(projectRoot, executeResult.batchId!);

    expect(validationResult.blockingReasons).toContain('H.265 Main10 output mismatch');
    expect(validation?.status).toBe('fail');
    expect(validation?.entries[0]?.checks.main10).toBe('fail');
  });

  it('mirrors same-basename raw sidecars only after manual sidecar sync', async () => {
    const workspaceRoot = await createWorkspace();
    const projectId = 'project-color-sidecars';
    const { projectRoot, rootId, rawLocalPath, currentLocalPath } = await seedSingleRootProject({
      workspaceRoot,
      projectId,
      projectName: 'Project Color Sidecars',
      rawFiles: ['day1/A001.mov'],
    });
    await writeFile(join(rawLocalPath, 'day1', 'A001.SRT'), 'subtitle', 'utf-8');
    await writeFile(join(rawLocalPath, 'day1', 'A001.WAV'), 'audio', 'utf-8');
    await writeFile(join(rawLocalPath, 'day1', 'A001.xml'), '<xml/>', 'utf-8');
    await writeFile(join(rawLocalPath, 'day1', 'A001.gyroflow'), '{}', 'utf-8');
    await writeFile(join(rawLocalPath, 'day1', 'A001_notes.srt'), 'not copied', 'utf-8');

    mockColorMetadata();
    const executor = createFakeExecutor();
    await prepareProjectColorRoot({ workspaceRoot, projectId, rootId, executor });
    const executeResult = await executeProjectColorRoot({
      workspaceRoot,
      projectId,
      rootId,
      action: 'execute_root',
      executor,
    });
    const manifestBefore = await loadColorBatchManifest(projectRoot, executeResult.batchId!);
    expect(manifestBefore?.entries[0]?.sidecars).toEqual([]);
    expect(manifestBefore?.managedSidecarSet).toEqual([]);
    await expect(readFile(join(currentLocalPath, 'day1', 'A001.SRT'), 'utf-8')).rejects.toThrow();
    await rm(join(projectRoot, 'color', 'batches', executeResult.batchId!, 'manifest.json'));

    const validationBefore = await validateProjectColorBatch({
      workspaceRoot,
      projectId,
      rootId,
      action: 'validate_batch',
      batchId: executeResult.batchId,
    });
    expect(validationBefore.blockingReasons).toContain('sidecar sync pending: run sync_batch_sidecars for day1/A001.SRT');
    const recoveredManifest = await loadColorBatchManifest(projectRoot, executeResult.batchId!);
    expect(recoveredManifest?.metadataRepair?.warnings).toContain('manifest recovered from plan and existing rendered outputs');
    expect((await loadColorCurrent(projectRoot)).roots[0]).toMatchObject({
      latestBatchStatus: 'rendered',
      latestValidationStatus: 'fail',
    });

    await syncProjectColorBatchSidecars({
      workspaceRoot,
      projectId,
      rootId,
      action: 'sync_batch_sidecars',
      batchId: executeResult.batchId,
    });
    const manifest = await loadColorBatchManifest(projectRoot, executeResult.batchId!);
    expect(manifest?.entries[0]?.sidecars.map(sidecar => sidecar.outputRelativePath)).toEqual([
      'day1/A001.SRT',
      'day1/A001.WAV',
    ]);
    expect(manifest?.managedSidecarSet).toEqual(['day1/A001.SRT', 'day1/A001.WAV']);
    const validationResult = await validateProjectColorBatch({
      workspaceRoot,
      projectId,
      rootId,
      action: 'validate_batch',
      batchId: executeResult.batchId,
    });
    expect(validationResult.blockingReasons).toEqual([]);
    expect((await loadColorBatchValidation(projectRoot, executeResult.batchId!))?.status).toBe('pass');
    expect(await readFile(join(currentLocalPath, 'day1', 'A001.SRT'), 'utf-8')).toBe('subtitle');
    expect(await readFile(join(currentLocalPath, 'day1', 'A001.WAV'), 'utf-8')).toBe('audio');
    await expect(readFile(join(currentLocalPath, 'day1', 'A001.xml'), 'utf-8')).rejects.toThrow();
    await expect(readFile(join(currentLocalPath, 'day1', 'A001.gyroflow'), 'utf-8')).rejects.toThrow();
    await expect(readFile(join(currentLocalPath, 'day1', 'A001_notes.srt'), 'utf-8')).rejects.toThrow();
  });

  it('requires manual metadata sync before validating metadata-bearing outputs', async () => {
    const workspaceRoot = await createWorkspace();
    const projectId = 'project-color-manual-metadata';
    const { projectRoot, rootId, currentLocalPath } = await seedSingleRootProject({
      workspaceRoot,
      projectId,
      projectName: 'Project Color Manual Metadata',
      rawFiles: ['day1/A001.mov'],
    });

    mockColorMetadata({ includeCaptureTime: true, includeGps: true });
    const executor = createFakeExecutor();
    await prepareProjectColorRoot({ workspaceRoot, projectId, rootId, executor });
    const executeResult = await executeProjectColorRoot({
      workspaceRoot,
      projectId,
      rootId,
      action: 'execute_root',
      executor,
    });
    const staleTempPath = join(currentLocalPath, 'day1', '.kairos-meta-11111111-2222-3333-4444-555555555555.mp4');
    await writeFile(staleTempPath, 'stale temp', 'utf-8');

    expect((await loadColorBatchManifest(projectRoot, executeResult.batchId!))?.metadataRepair).toMatchObject({
      status: 'pending',
      repairedCount: 0,
    });
    const validationBefore = await validateProjectColorBatch({
      workspaceRoot,
      projectId,
      rootId,
      action: 'validate_batch',
      batchId: executeResult.batchId,
    });
    expect(validationBefore.blockingReasons).toContain('metadata sync pending: run sync_batch_metadata before validate_batch');

    vi.spyOn(mediaProbe, 'probe').mockImplementation(async filePath => ({
      durationMs: 1000,
      width: 3840,
      height: 2160,
      displayWidth: 3840,
      displayHeight: 2160,
      rotationDegrees: null,
      fps: 30,
      codec: filePath.endsWith('.mp4') ? 'h265' : 'prores',
      hasAudioStream: true,
      audioStreamCount: 1,
      audioCodec: 'aac',
      audioSampleRate: 48000,
      audioChannels: 2,
      audioBitRate: 192000,
      creationTime: undefined,
      rawTags: {},
    }));
    vi.spyOn(captureTime, 'resolveCaptureTime').mockResolvedValue(null);

    await expect(syncProjectColorBatchMetadata({
      workspaceRoot,
      projectId,
      rootId,
      action: 'sync_batch_metadata',
      batchId: executeResult.batchId,
    })).rejects.toBeInstanceOf(ProjectColorBlockedError);
    const manifestAfter = await loadColorBatchManifest(projectRoot, executeResult.batchId!);
    expect(manifestAfter?.metadataRepair?.status).toBe('failed');
    expect(manifestAfter?.metadataRepair?.failedOutputs[0]?.rawRelativePath).toBe('day1/A001.mov');
    expect(manifestAfter?.metadataRepair?.warnings).toContain('cleaned 1 stale metadata temp files before metadata sync');
    await expect(readFile(staleTempPath, 'utf-8')).rejects.toThrow();
    const progress = JSON.parse(await readFile(join(projectRoot, '.tmp', 'color', 'progress.json'), 'utf-8'));
    expect(progress).toMatchObject({
      status: 'failed',
      phaseKey: 'sync_batch_metadata',
      current: 1,
      total: 1,
      unit: 'file',
    });
  });

  it('skips metadata remux when target metadata fields already match source snapshots', async () => {
    const workspaceRoot = await createWorkspace();
    const projectId = 'project-color-metadata-skip';
    const { projectRoot, rootId, currentLocalPath } = await seedSingleRootProject({
      workspaceRoot,
      projectId,
      projectName: 'Project Color Metadata Skip',
      rawFiles: ['day1/A001.mov'],
    });

    mockColorMetadata({ includeCaptureTime: true, includeGps: true });
    const executor = createFakeExecutor();
    await prepareProjectColorRoot({ workspaceRoot, projectId, rootId, executor });
    const executeResult = await executeProjectColorRoot({
      workspaceRoot,
      projectId,
      rootId,
      action: 'execute_root',
      executor,
    });
    const outputPath = join(currentLocalPath, 'day1', 'A001.mp4');
    const renderedPayload = await readFile(outputPath, 'utf-8');

    await syncProjectColorBatchMetadata({
      workspaceRoot,
      projectId,
      rootId,
      action: 'sync_batch_metadata',
      batchId: executeResult.batchId,
    });

    const manifest = await loadColorBatchManifest(projectRoot, executeResult.batchId!);
    expect(manifest?.metadataRepair).toMatchObject({
      status: 'completed',
      repairedCount: 0,
      skippedCount: 1,
      failedOutputs: [],
    });
    expect(manifest?.entries[0]?.outputMetadataSnapshot).toMatchObject({
      capturedAt: '2026-02-01T10:00:00.000Z',
      createTime: '2026-02-01T10:00:00.000Z',
      gps: [40.1, 120.2],
    });
    expect(await readFile(outputPath, 'utf-8')).toBe(renderedPayload);
    const progress = JSON.parse(await readFile(join(projectRoot, '.tmp', 'color', 'progress.json'), 'utf-8'));
    expect(progress.extra).toMatchObject({
      repairedCount: 0,
      skippedCount: 1,
      failedCount: 0,
    });

    const validation = await validateProjectColorBatch({
      workspaceRoot,
      projectId,
      rootId,
      action: 'validate_batch',
      batchId: executeResult.batchId,
    });
    expect(validation.blockingReasons).toEqual([]);
  });

  it('marks execute_root failed instead of leaving a stale rendering state', async () => {
    const workspaceRoot = await createWorkspace();
    const projectId = 'project-color-execute-failed-state';
    const { projectRoot, rootId } = await seedSingleRootProject({
      workspaceRoot,
      projectId,
      projectName: 'Project Color Execute Failed State',
      rawFiles: ['day1/A001.mov'],
    });

    mockColorMetadata();
    await prepareProjectColorRoot({
      workspaceRoot,
      projectId,
      rootId,
      executor: createFakeExecutor(),
    });

    await expect(executeProjectColorRoot({
      workspaceRoot,
      projectId,
      rootId,
      action: 'execute_root',
      jobId: 'job-color-execute-failed-state',
      executor: createFakeExecutor({
        onExecuteRoot: async () => {
          throw new Error('render exploded');
        },
      }),
    })).rejects.toThrow('render exploded');

    const savedRoot = (await loadColorCurrent(projectRoot)).roots.find(root => root.rootId === rootId);
    expect(savedRoot).toMatchObject({
      latestBatchStatus: 'failed',
      latestValidationStatus: 'pending',
      blockingReasons: ['render exploded'],
    });
    expect(savedRoot?.activeStage).toBeUndefined();
    expect(savedRoot?.currentJobId).toBeUndefined();
  });

  it('keeps Resolve render queue filename diagnostics when execute_root fails', async () => {
    const workspaceRoot = await createWorkspace();
    const projectId = 'project-color-execute-host-filename-diagnostics';
    const { projectRoot, rootId } = await seedSingleRootProject({
      workspaceRoot,
      projectId,
      projectName: 'Project Color Execute Host Filename Diagnostics',
      rawFiles: ['day1/A001.mov'],
    });

    mockColorMetadata();
    await prepareProjectColorRoot({
      workspaceRoot,
      projectId,
      rootId,
      executor: createFakeExecutor(),
    });

    await expect(executeProjectColorRoot({
      workspaceRoot,
      projectId,
      rootId,
      action: 'execute_root',
      jobId: 'job-color-execute-host-filename-diagnostics',
      executor: createFakeExecutor({
        onExecuteRoot: async () => {
          throw new ResolveColorHostError({
            code: 'resolve_render_job_filename_mode_failed',
            message: 'Resolve queued a render job that is not using Source Name filenames.',
            requestPath: '/tmp/request.json',
            details: {
              code: 'resolve_render_job_filename_mode_failed',
              message: 'Resolve queued a render job that is not using Source Name filenames.',
              details: {
                outputFilename: '00000000.mp4 and 2 more',
                firstOutputFilename: '00000000.mp4',
                expectedSourceNameFilenames: ['A001.mp4', 'A002.mp4'],
                expectedSourceNameStems: ['A001', 'A002'],
              },
            },
          });
        },
      }),
    })).rejects.toThrow('queue OutputFilename=00000000.mp4 and 2 more');

    const savedRoot = (await loadColorCurrent(projectRoot)).roots.find(root => root.rootId === rootId);
    expect(savedRoot?.blockingReasons[0]).toContain('queue OutputFilename=00000000.mp4 and 2 more');
    expect(savedRoot?.blockingReasons[0]).toContain('expected=A001.mp4, A002.mp4');
    expect(savedRoot?.hostSummary.latestExecuteFailure).toMatchObject({
      code: 'resolve_render_job_filename_mode_failed',
      outputFilename: '00000000.mp4 and 2 more',
      firstOutputFilename: '00000000.mp4',
      expectedSourceNameFilenameCount: 2,
      expectedSourceNameFilenameSamples: ['A001.mp4', 'A002.mp4'],
    });

    const progress = JSON.parse(await readFile(join(projectRoot, '.tmp', 'color', 'progress.json'), 'utf-8'));
    expect(progress.detail).toContain('queue OutputFilename=00000000.mp4 and 2 more');
    expect(progress.extra.hostFailure).toMatchObject({
      code: 'resolve_render_job_filename_mode_failed',
      outputFilename: '00000000.mp4 and 2 more',
    });
  });

  it('clears stale Source Name render blockers after a successful execute_root rerun', async () => {
    const workspaceRoot = await createWorkspace();
    const projectId = 'project-color-clears-source-name-render-blocker';
    const { projectRoot, rootId } = await seedSingleRootProject({
      workspaceRoot,
      projectId,
      projectName: 'Project Color Clears Source Name Render Blocker',
      rawFiles: ['day1/A001.mov'],
    });

    mockColorMetadata();
    await prepareProjectColorRoot({
      workspaceRoot,
      projectId,
      rootId,
      executor: createFakeExecutor(),
    });

    const currentBefore = await loadColorCurrent(projectRoot);
    await saveColorCurrent(projectRoot, {
      ...currentBefore,
      roots: currentBefore.roots.map(root => root.rootId === rootId
        ? {
            ...root,
            blockingReasons: ['Resolve queued a render job that is not using Source Name filenames.'],
          }
        : root),
    });

    await executeProjectColorRoot({
      workspaceRoot,
      projectId,
      rootId,
      action: 'execute_root',
      jobId: 'job-color-clears-source-name-render-blocker',
      executor: createFakeExecutor(),
    });

    const savedRoot = (await loadColorCurrent(projectRoot)).roots.find(root => root.rootId === rootId);
    expect(savedRoot?.latestBatchStatus).toBe('rendered');
    expect(savedRoot?.blockingReasons).toEqual([]);
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
    expect(savedCurrent.roots[0]?.activeStage).toBeUndefined();
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
        capturedAt: undefined,
        width: 3840,
        height: 2160,
        encodedWidth: 3840,
        encodedHeight: 2160,
        displayWidth: 3840,
        displayHeight: 2160,
        rotationDegrees: undefined,
        orientationStatus: 'horizontal',
        repairTemplateKey: 'default',
        timelineTransform: undefined,
        fps: 30,
        codec: 'prores',
        rawTags: {},
        detectedProfile: 'dlog-m',
        effectiveProfile: 'dlog-m',
        profileSource: 'detected',
        logProfile: 'dlog-m',
        gyroDataAvailable: true,
        gyroEligible: true,
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

  it.each([90, -90, 270])('keeps portrait rotation at zero for source rotation %s while preserving fill and template selection', async rotationDegrees => {
    const workspaceRoot = await createWorkspace();
    const projectId = 'project-color-portrait-transform';
    const { rootId } = await seedSingleRootProject({
      workspaceRoot,
      projectId,
      projectName: 'Project Color Portrait Transform',
    });

    mockColorMetadata({
      width: 3840,
      height: 2160,
      displayWidth: 2160,
      displayHeight: 3840,
      rotationDegrees,
    });
    mockClipSignals({ gyroEligible: true, logProfile: 'slog3' });

    const prepared: Array<Record<string, unknown>> = [];
    const executor = createFakeExecutor({
      onPrepareRoot: async input => {
        prepared.push({
          repairTemplates: input.repairTemplates,
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
    });

    await prepareProjectColorRoot({
      workspaceRoot,
      projectId,
      rootId,
      jobId: 'job-color-portrait-prepare',
      executor,
    });

    expect(prepared[0]?.repairTemplates).toMatchObject({
      default: join(workspaceRoot, 'config', 'default.drt'),
      'portrait-90': join(workspaceRoot, 'config', 'gyroflow-portrait-90.drt'),
      'portrait--90': join(workspaceRoot, 'config', 'gyroflow-portrait--90.drt'),
    });
    expect(prepared[0]?.timelineSpec).toEqual({
      width: 3840,
      height: 2160,
      fps: 30,
    });
    expect((prepared[0]?.clips as any[])[0]).toMatchObject({
      displayWidth: 2160,
      displayHeight: 3840,
      rotationDegrees,
      orientationStatus: 'portrait',
      repairTemplateKey: rotationDegrees === 90 ? 'portrait--90' : 'portrait-90',
      gyroDataAvailable: true,
      gyroEligible: true,
      timelineTransform: {
        rotationAngle: 0,
        zoomGang: true,
        zoomX: 1.7778,
        zoomY: 1.7778,
        pan: 0,
        tilt: 0,
      },
    });
  });

  it('reruns only the stale portrait chunk when a portrait DRT hash is stale', async () => {
    const workspaceRoot = await createWorkspace();
    const projectId = 'project-color-portrait-template-rebuild';
    const portraitPath = 'day1/A0000PORTRAIT.MP4';
    const rawFiles = [
      portraitPath,
      ...Array.from({ length: 50 }, (_, index) => `day1/A${String(index + 1).padStart(4, '0')}.MP4`),
    ];
    const { projectRoot, rootId } = await seedSingleRootProject({
      workspaceRoot,
      projectId,
      projectName: 'Project Color Portrait Template Reseed',
      rawFiles,
    });
    await mkdir(join(workspaceRoot, 'config'), { recursive: true });
    await writeFile(join(workspaceRoot, 'config', 'gyroflow-portrait--90.drt'), 'portrait-template-v2', 'utf-8');
    const currentPortraitTemplateHash = createHash('sha256').update('portrait-template-v2').digest('hex');

    vi.spyOn(mediaProbe, 'probe').mockImplementation(async filePath => {
      const isPortrait = filePath.endsWith('A0000PORTRAIT.MP4');
      return {
        durationMs: 1000,
        width: 3840,
        height: 2160,
        displayWidth: isPortrait ? 2160 : 3840,
        displayHeight: isPortrait ? 3840 : 2160,
        rotationDegrees: isPortrait ? 90 : null,
        fps: 30,
        codec: 'h265',
        hasAudioStream: true,
        audioStreamCount: 1,
        audioCodec: 'aac',
        audioSampleRate: 48000,
        audioChannels: 2,
        audioBitRate: 192000,
        rawTags: {},
      };
    });
    vi.spyOn(captureTime, 'resolveCaptureTime').mockResolvedValue(null);
    mockClipSignals({ gyroEligible: true, logProfile: 'slog3' });

    await prepareProjectColorRoot({
      workspaceRoot,
      projectId,
      rootId,
      jobId: 'job-color-portrait-template-initial',
      executor: createFakeExecutor(),
    });

    const existingSnapshot = await loadColorGroupsSnapshot(projectRoot, rootId);
    expect(existingSnapshot).toBeTruthy();
    await saveColorGroupsSnapshot(projectRoot, {
      ...existingSnapshot!,
      groups: existingSnapshot!.groups.map(group => ({
        ...group,
        clips: group.clips.map(clip => clip.clipKey === portraitPath
          ? {
              ...clip,
              repairTemplateHash: 'stale-template-hash',
            }
          : clip),
      })),
    });

    const prepareCalls: IColorExecutorPrepareRootInput[] = [];
    let syncPortraitClip: IColorExecutorClipInput | undefined;
    await prepareProjectColorRoot({
      workspaceRoot,
      projectId,
      rootId,
      jobId: 'job-color-portrait-template-rerun',
      executor: createFakeExecutor({
        onPrepareRoot: async input => {
          prepareCalls.push(input);
          return {
            resolveProjectName: input.resolveProjectName,
            gradingTimelineName: input.gradingTimelineName,
            mirrorStatus: 'synced',
            timelineStatus: 'ready',
            groupsSnapshot: buildGroupsSnapshot(input, 'prepare_root'),
          };
        },
        onSyncGroups: async input => {
          syncPortraitClip = input.clips.find(clip => clip.rawRelativePath === portraitPath);
          return buildGroupsSnapshot(input, 'resolve');
        },
      }),
    });

    expect(prepareCalls).toHaveLength(1);
    expect(prepareCalls[0]?.resetTimeline).toBe(false);
    expect(prepareCalls[0]?.clips.map(clip => clip.rawRelativePath)).toContain(portraitPath);
    expect(prepareCalls[0]?.clips.find(clip => clip.rawRelativePath === portraitPath)).toMatchObject({
      previousRepairTemplateHash: 'stale-template-hash',
      repairTemplateKey: 'portrait--90',
    });
    expect(syncPortraitClip).toMatchObject({
      previousRepairTemplateHash: currentPortraitTemplateHash,
      repairTemplateKey: 'portrait--90',
    });
  });

  it('clears stale transient prepare blockers after a successful rerun', async () => {
    const workspaceRoot = await createWorkspace();
    const projectId = 'project-color-clear-stale-prepare-blocker';
    const { projectRoot, rootId } = await seedSingleRootProject({
      workspaceRoot,
      projectId,
      projectName: 'Project Color Clear Stale Prepare Blocker',
    });

    await saveColorCurrent(projectRoot, {
      selectedRootId: rootId,
      roots: [{
        rootId,
        mirrorStatus: 'blocked',
        timelineStatus: 'blocked',
        detail: 'Unable to import clip repair template timeline: gyroflow-portrait--90.drt',
        blockingReasons: ['Unable to import clip repair template timeline: gyroflow-portrait--90.drt'],
      }],
    });

    mockColorMetadata();
    mockClipSignals({ gyroEligible: true });
    const result = await prepareProjectColorRoot({
      workspaceRoot,
      projectId,
      rootId,
      jobId: 'job-color-clear-stale-prepare-blocker',
      executor: createFakeExecutor(),
    });

    expect(result.blockingReasons).toEqual([]);
    const savedRoot = (await loadColorCurrent(projectRoot)).roots.find(root => root.rootId === rootId);
    expect(savedRoot).toMatchObject({
      mirrorStatus: 'synced',
      timelineStatus: 'ready',
      blockingReasons: [],
    });
  });

  it('rejects legacy promote after direct-root export', async () => {
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
        async saveDrpSnapshot(input) {
          return createFakeExecutor().saveDrpSnapshot(input);
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

  it('saves and registers DRP snapshots as latest Resolve project truth', async () => {
    const workspaceRoot = await createWorkspace();
    const projectId = 'project-color-drp-snapshot';
    const { projectRoot, rootId } = await seedSingleRootProject({
      workspaceRoot,
      projectId,
      projectName: 'Project Color DRP Snapshot',
    });
    const executor = createFakeExecutor();

    const saved = await snapshotProjectColorDrp({
      workspaceRoot,
      projectId,
      rootId,
      executor,
    });
    expect(saved.snapshot?.mode).toBe('manual');
    expect(saved.snapshot?.retention).toBe('latest-only');
    expect(saved.snapshot?.snapshotPath).toBe(saved.snapshot?.latestPath);
    expect(saved.snapshot?.latestPath).toMatch(/Project Color DRP Snapshot \[Color\]\.drp$/u);
    expect(saved.snapshot?.latestPath).not.toMatch(/latest\.drp$/u);
    const savedMapEntry = (await loadColorResolveProjectMap(projectRoot)).projects[saved.snapshot!.projectName];
    expect(savedMapEntry?.latestSnapshot?.snapshotPath).toBe(saved.snapshot?.snapshotPath);
    expect(savedMapEntry?.snapshots).toHaveLength(0);

    const externalPath = join(projectRoot, '.fixtures', 'manual-export.drp');
    await mkdir(join(projectRoot, '.fixtures'), { recursive: true });
    await writeFile(externalPath, 'external drp', 'utf-8');
    const registered = await registerExternalColorDrpSnapshot({
      workspaceRoot,
      projectId,
      rootId,
      drpPath: externalPath,
    });
    const [resolveMap, current] = await Promise.all([
      loadColorResolveProjectMap(projectRoot),
      loadColorCurrent(projectRoot),
    ]);
    expect(registered.snapshot.mode).toBe('external');
    expect(registered.snapshot.retention).toBe('archive');
    expect(registered.snapshot.latestPath).toMatch(/Project Color DRP Snapshot \[Color\]\.drp$/u);
    expect(registered.snapshot.latestPath).not.toMatch(/latest\.drp$/u);
    expect(resolveMap.projects[registered.snapshot.projectName]?.latestSnapshot?.snapshotPath)
      .toBe(registered.snapshot.snapshotPath);
    expect(current.roots.find(root => root.rootId === rootId)?.latestDrpSnapshot?.snapshotPath)
      .toBe(registered.snapshot.snapshotPath);
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
      async syncGroups(input) {
        return createFakeExecutor().syncGroups(input);
      },
      async executeRoot() {
        throw new Error('not used');
      },
      async saveDrpSnapshot(input) {
        return createFakeExecutor().saveDrpSnapshot(input);
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
      async saveDrpSnapshot(input) {
        return createFakeExecutor().saveDrpSnapshot(input);
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

  it('relink_media uses raw path candidates when current path is missing', async () => {
    const workspaceRoot = await createWorkspace();
    const projectId = 'project-color-relink-root';
    const projectRoot = await initWorkspaceProject(workspaceRoot, projectId, 'Project Color Relink Root');
    const rawLocalPath = join(projectRoot, '.fixtures', 'raw-zve1');
    const missingCurrentPath = join(projectRoot, '.fixtures', 'missing-current-zve1');
    await mkdir(rawLocalPath, { recursive: true });
    await saveIngestRoots(projectRoot, {
      roots: [{
        id: 'zve1',
        label: 'ZV-E1',
        path: missingCurrentPath,
        rawPath: '/archive/raw/zve1',
        alternatePaths: [{
          rawPath: rawLocalPath,
        }, {
          rawPath: '/old/raw/zve1',
        }],
        enabled: true,
      }],
    });

    const relinkInputs: IColorExecutorRelinkMediaInput[] = [];
    const executor = createFakeExecutor({
      onRelinkMedia: async input => {
        relinkInputs.push(input);
        return {
          resolveProjectName: input.resolveProjectName,
          rootNamespace: input.rootNamespace,
          gradingTimelineName: input.gradingTimelineName,
          createdAt: '2026-07-05T12:00:00.000Z',
          hostSummary: {
            relinked: 3,
            relinkFolderCount: 2,
            oldPathRemaining: 0,
            timelineOldPathRemaining: 0,
            missingTargetCount: 0,
            timelineMissingTargetCount: 0,
            unmappedCount: 1,
            timelineUnmappedCount: 0,
            skippedNonFileCount: 0,
            timelineSkippedNonFileCount: 0,
          },
        };
      },
    });

    const result = await relinkProjectColorRootMedia({
      workspaceRoot,
      projectId,
      rootId: 'zve1',
      action: 'relink_media',
      executor,
    });

    expect(result.detail).toContain('3 个 item');
    expect(relinkInputs).toHaveLength(1);
    expect(relinkInputs[0]).toMatchObject({
      rootId: 'zve1',
      resolveProjectName: 'Project Color Relink Root [Color]',
      rootNamespace: 'ZV-E1 [Color Root]',
      gradingTimelineName: 'ZV-E1 [Color]',
    });
    expect(relinkInputs[0]?.roots[0]).toMatchObject({
      rootId: 'zve1',
      label: 'ZV-E1',
      localPath: rawLocalPath,
    });
    expect(relinkInputs[0]?.roots[0]?.candidates).toEqual([
      rawLocalPath,
      '/archive/raw/zve1',
      '/old/raw/zve1',
    ]);
    const colorCurrent = await loadColorCurrent(projectRoot);
    const rootCurrent = colorCurrent.roots.find(root => root.rootId === 'zve1');
    expect(rootCurrent).toMatchObject({
      mirrorStatus: 'synced',
      timelineStatus: 'ready',
      detail: 'Resolve Color 素材重链完成：3 个 item，2 个目标目录。 未映射 1 个。',
      hostSummary: {
        latestRelinkAt: '2026-07-05T12:00:00.000Z',
        latestRelink: {
          relinked: 3,
          relinkFolderCount: 2,
        },
      },
    });
  });

  it('relink_all_roots respects priority order and continues after failures', async () => {
    const workspaceRoot = await createWorkspace();
    const projectId = 'project-color-relink-all';
    const projectRoot = await initWorkspaceProject(workspaceRoot, projectId, 'Project Color Relink All');
    const rawFail = join(projectRoot, '.fixtures', 'root-z-raw');
    const rawReady = join(projectRoot, '.fixtures', 'root-a-raw');
    await mkdir(rawFail, { recursive: true });
    await mkdir(rawReady, { recursive: true });
    await saveIngestRoots(projectRoot, {
      roots: [{
        id: 'root-z',
        label: 'Z Root',
        priority: 1,
        path: join(projectRoot, '.fixtures', 'missing-current-z'),
        rawPath: '/media/raw/root-z',
        alternatePaths: [{
          rawPath: rawFail,
        }],
        enabled: true,
      }, {
        id: 'root-a',
        label: 'A Root',
        priority: 2,
        path: join(projectRoot, '.fixtures', 'missing-current-a'),
        rawPath: '/media/raw/root-a',
        alternatePaths: [{
          rawPath: rawReady,
        }],
        enabled: true,
      }],
    });

    const relinkOrder: string[] = [];
    const executor = createFakeExecutor({
      onRelinkMedia: async input => {
        relinkOrder.push(input.rootId);
        if (input.rootId === 'root-z') {
          throw new ResolveColorHostError({
            code: 'resolve_color_relink_failed',
            message: 'relink failed for root-z',
            requestPath: '/tmp/request.json',
          });
        }
        return {
          resolveProjectName: input.resolveProjectName,
          rootNamespace: input.rootNamespace,
          gradingTimelineName: input.gradingTimelineName,
          createdAt: '2026-07-05T12:00:00.000Z',
          hostSummary: {
            relinked: 1,
            relinkFolderCount: 1,
          },
        };
      },
    });

    const result = await relinkAllProjectColorRoots({
      workspaceRoot,
      projectId,
      action: 'relink_all_roots',
      executor,
    });

    expect(relinkOrder).toEqual(['root-z', 'root-a']);
    expect(result.detail).toBe('Relink All Roots 完成：1 个成功，1 个失败。');
    expect(result.roots).toEqual([{
      rootId: 'root-z',
      status: 'failed',
      actionSummary: 'relink failed for root-z',
      error: 'relink failed for root-z',
    }, {
      rootId: 'root-a',
      status: 'succeeded',
      actionSummary: 'Resolve Color 素材重链完成：1 个 item，1 个目标目录。',
    }]);
  });

  it('prepare_all_roots respects priority order and continues after failures', async () => {
    const workspaceRoot = await createWorkspace();
    const projectId = 'project-color-prepare-all';
    const projectRoot = await initWorkspaceProject(workspaceRoot, projectId, 'Project Color Prepare All');
    await mkdir(join(workspaceRoot, 'config'), { recursive: true });
    await writeFile(join(workspaceRoot, 'config', 'default.drt'), 'default repair template', 'utf-8');
    const rawFail = join(projectRoot, '.fixtures', 'root-z-raw');
    const rawReady = join(projectRoot, '.fixtures', 'root-a-raw');
    const currentFail = join(projectRoot, '.fixtures', 'root-z-current');
    const currentReady = join(projectRoot, '.fixtures', 'root-a-current');
    await mkdir(join(rawFail, 'day1'), { recursive: true });
    await mkdir(join(rawReady, 'day1'), { recursive: true });
    await mkdir(currentFail, { recursive: true });
    await mkdir(currentReady, { recursive: true });
    await writeFile(join(rawFail, 'day1', 'A001.mov'), 'raw-z', 'utf-8');
    await writeFile(join(rawReady, 'day1', 'A001.mov'), 'raw-a', 'utf-8');
    await saveIngestRoots(projectRoot, {
      roots: [{
        id: 'root-z',
        label: 'Z Root',
        priority: 1,
        path: '/media/current/root-z',
        rawPath: '/media/raw/root-z',
        alternatePaths: [{
          path: currentFail,
          rawPath: rawFail,
        }],
        enabled: true,
      }, {
        id: 'root-a',
        label: 'A Root',
        priority: 2,
        path: '/media/current/root-a',
        rawPath: '/media/raw/root-a',
        alternatePaths: [{
          path: currentReady,
          rawPath: rawReady,
        }],
        enabled: true,
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
        actionSummary: 'Resolve host root prep 已完成：1/1 chunks ready。 Kairos 已写入 1 个 Resolve Groups 快照。 如需复核 Resolve 内调整，可继续运行 Sync Groups。',
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
    const currentFail = join(projectRoot, '.fixtures', 'root-fail-current');
    const currentReady = join(projectRoot, '.fixtures', 'root-ready-current');
    await mkdir(join(rawFail, 'day1'), { recursive: true });
    await mkdir(join(rawReady, 'day1'), { recursive: true });
    await mkdir(currentFail, { recursive: true });
    await mkdir(currentReady, { recursive: true });
    await writeFile(join(rawFail, 'day1', 'A001.mov'), 'raw-fail', 'utf-8');
    await writeFile(join(rawReady, 'day1', 'A001.mov'), 'raw-ready', 'utf-8');
    await saveIngestRoots(projectRoot, {
      roots: [{
        id: 'root-fail',
        label: 'Fail Root',
        priority: 1,
        path: '/media/current/root-fail',
        rawPath: '/media/raw/root-fail',
        alternatePaths: [{
          path: currentFail,
          rawPath: rawFail,
        }],
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
        alternatePaths: [{
          path: currentReady,
          rawPath: rawReady,
        }],
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
    await saveColorGroupsSnapshot(projectRoot, buildGroupsSnapshot({
      rootId: 'root-fail',
      gradingTimelineName: 'Fail Root [Color]',
      clips: [{
        rawRelativePath: 'day1/A001.mov',
        sourceAbsolutePath: join(rawFail, 'day1', 'A001.mov'),
        sourceStem: 'A001',
      }],
    }, 'resolve'));
    await saveColorGroupsSnapshot(projectRoot, buildGroupsSnapshot({
      rootId: 'root-ready',
      gradingTimelineName: 'Ready Root [Color]',
      clips: [{
        rawRelativePath: 'day1/A001.mov',
        sourceAbsolutePath: join(rawReady, 'day1', 'A001.mov'),
        sourceStem: 'A001',
      }],
    }, 'resolve'));
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
