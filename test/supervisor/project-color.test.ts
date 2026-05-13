import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as mediaProbe from '../../src/modules/media/probe.js';
import * as captureTime from '../../src/modules/media/capture-time.js';
import * as colorCastClassifier from '../../src/modules/color/color-cast-classifier.js';
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
  registerExternalColorDrpSnapshot,
  runProjectColorAction,
  snapshotProjectColorDrp,
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
    lowlight: clip.lowlight === true,
    colorCastClass: clip.colorCastClass,
    colorCastConfidence: clip.colorCastConfidence,
    colorCastMetrics: clip.colorCastMetrics ?? {},
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
  onPrepareRoot?: NonNullable<IColorExecutor['prepareRoot']>;
  onSyncGroups?: NonNullable<IColorExecutor['syncGroups']>;
  onExecuteRoot?: NonNullable<IColorExecutor['executeRoot']>;
  onSaveDrpSnapshot?: NonNullable<IColorExecutor['saveDrpSnapshot']>;
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
      const snapshotPath = join(input.snapshotRoot, 'snapshots', `${input.snapshotLabel || 'manual'}.drp`);
      await mkdir(join(input.snapshotRoot, 'snapshots'), { recursive: true });
      await writeFile(snapshotPath, 'drp', 'utf-8');
      return {
        snapshot: {
          projectName: input.resolveProjectName,
          snapshotPath,
          latestPath: join(input.snapshotRoot, 'latest.drp'),
          createdAt: '2026-04-19T10:06:00.000Z',
          mode: input.action === 'manual' ? 'manual' as const : 'auto' as const,
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
  colorCastClass?: 'neutral' | 'cool-cyan' | 'green-cyan' | 'green' | 'warm' | 'mixed' | 'unknown';
  colorCastConfidence?: number;
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
  vi.spyOn(colorCastClassifier, 'classifyColorCast').mockResolvedValue({
    colorCastClass: options.colorCastClass ?? 'neutral',
    colorCastConfidence: options.colorCastConfidence ?? 0.9,
    colorCastMetrics: {},
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
  });

  it('syncs Resolve groups without re-running first-frame lowlight detection', async () => {
    const workspaceRoot = await createWorkspace();
    const projectId = 'project-color-sync-lightweight';
    const { rootId } = await seedSingleRootProject({
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

    const lowlightSpy = vi.mocked(lowlightClassifier.classifyFirstFrameLowlight);
    const colorCastSpy = vi.mocked(colorCastClassifier.classifyColorCast);
    lowlightSpy.mockClear();
    colorCastSpy.mockClear();
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
    expect(colorCastSpy).not.toHaveBeenCalled();
    expect(syncedInputs[0]?.clips.map(clip => clip.lowlight)).toEqual([true, true]);
    expect(syncedInputs[0]?.clips.map(clip => clip.colorCastClass)).toEqual(['neutral', 'neutral']);
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

  it('uses the workspace technical LUT for log color-cast preview', async () => {
    const workspaceRoot = await createWorkspace();
    const projectId = 'project-color-cast-preview-lut';
    const { rootId } = await seedSingleRootProject({
      workspaceRoot,
      projectId,
      projectName: 'Project Color Cast Preview LUT',
    });
    const relativeLutPath = 'Sony/SLog3SGamut3.CineToLC-709.cube';
    const lutPath = join(workspaceRoot, 'config', 'luts', 'Sony', 'SLog3SGamut3.CineToLC-709.cube');
    await mkdir(join(workspaceRoot, 'config', 'luts', 'Sony'), { recursive: true });
    await writeFile(lutPath, 'TITLE "test lut"\nLUT_3D_SIZE 2\n0 0 0\n0 0 1\n0 1 0\n0 1 1\n1 0 0\n1 0 1\n1 1 0\n1 1 1\n', 'utf-8');
    await saveColorTransformPresetsConfig(workspaceRoot, {
      profiles: {
        slog3: {
          default: relativeLutPath,
        },
      },
    });

    mockColorMetadata();
    mockClipSignals({ logProfile: 'slog3' });
    await prepareProjectColorRoot({
      workspaceRoot,
      projectId,
      rootId,
      jobId: 'job-color-cast-preview-lut',
      executor: createFakeExecutor(),
    });

    expect(colorCastClassifier.classifyColorCast).toHaveBeenCalledWith(
      expect.stringContaining('A001.mov'),
      expect.anything(),
      expect.objectContaining({
        lutPath,
      }),
    );
  });

  it('promotes a continuous weak cool-blue run into the cool-cyan group', async () => {
    const workspaceRoot = await createWorkspace();
    const projectId = 'project-color-cool-continuity';
    const rawFiles = Array.from(
      { length: 17 },
      (_, index) => `day11/C${String(1827 + index).padStart(4, '0')}.MP4`,
    );
    const { rootId } = await seedSingleRootProject({
      workspaceRoot,
      projectId,
      projectName: 'Project Color Cool Continuity',
      rawFiles,
    });

    mockColorMetadata();
    mockClipSignals({ logProfile: 'slog3' });
    const anchorStems = new Set(['C1827', 'C1829', 'C1832', 'C1833', 'C1834', 'C1835', 'C1837', 'C1841']);
    vi.mocked(colorCastClassifier.classifyColorCast).mockImplementation(async filePath => {
      const stem = String(filePath).match(/C\d{4}/)?.[0] ?? '';
      if (anchorStems.has(stem)) {
        return {
          colorCastClass: 'cool-cyan',
          colorCastConfidence: 0.72,
          colorCastMetrics: {
            medianA: -3,
            medianB: -4.3,
            candidatePixelRatio: 0.12,
          },
        };
      }
      return {
        colorCastClass: 'neutral',
        colorCastConfidence: 0.45,
        colorCastMetrics: {
          medianA: stem === 'C1842' ? -1.7 : -2.5,
          medianB: stem === 'C1842' ? 0.8 : -2.0,
          candidatePixelRatio: 0.14,
        },
      };
    });

    const prepared: IColorExecutorPrepareRootInput[] = [];
    await prepareProjectColorRoot({
      workspaceRoot,
      projectId,
      rootId,
      jobId: 'job-color-cool-continuity',
      executor: createFakeExecutor({
        onPrepareRoot: async input => {
          prepared.push(input);
          return {
            resolveProjectName: input.resolveProjectName,
            gradingTimelineName: input.gradingTimelineName,
            mirrorStatus: 'synced',
            timelineStatus: 'ready',
            groupsSnapshot: buildGroupsSnapshot(input, 'prepare_root'),
            hostSummary: {},
          };
        },
      }),
    });

    const clips = prepared[0]?.clips ?? [];
    expect(clips).toHaveLength(17);
    expect(clips.map(clip => clip.colorCastClass)).toEqual(Array.from({ length: 17 }, () => 'cool-cyan'));
    expect(clips.find(clip => clip.rawRelativePath.endsWith('C1842.MP4'))?.colorCastMetrics).toMatchObject({
      continuityAdjustment: 'cool-cyan-sequence',
      continuityAdjustedFromClass: 'neutral',
    });
  });

  it('promotes a continuous weak green-cyan run into the green-cyan group', async () => {
    const workspaceRoot = await createWorkspace();
    const projectId = 'project-color-green-cyan-continuity';
    const rawFiles = Array.from(
      { length: 11 },
      (_, index) => `day2/C${String(530 + index).padStart(4, '0')}.MP4`,
    );
    const { rootId } = await seedSingleRootProject({
      workspaceRoot,
      projectId,
      projectName: 'Project Color Green Cyan Continuity',
      rawFiles,
    });

    mockColorMetadata();
    mockClipSignals({ logProfile: 'slog3' });
    const metricsByStem = new Map([
      ['C0530', { colorCastClass: 'green', colorCastConfidence: 0.67, medianA: -5.9, medianB: 0.4 }],
      ['C0531', { colorCastClass: 'neutral', colorCastConfidence: 0.45, medianA: -4.2, medianB: 0.9 }],
      ['C0532', { colorCastClass: 'neutral', colorCastConfidence: 0.44, medianA: -2.9, medianB: -1.3 }],
      ['C0533', { colorCastClass: 'mixed', colorCastConfidence: 0.52, medianA: -3.6, medianB: -2.4 }],
      ['C0534', { colorCastClass: 'neutral', colorCastConfidence: 0.43, medianA: -3.2, medianB: -1.8 }],
      ['C0535', { colorCastClass: 'mixed', colorCastConfidence: 0.51, medianA: -4.0, medianB: -3.0 }],
      ['C0536', { colorCastClass: 'green', colorCastConfidence: 0.64, medianA: -5.6, medianB: -1.3 }],
      ['C0537', { colorCastClass: 'neutral', colorCastConfidence: 0.42, medianA: -4.2, medianB: -1.5 }],
      ['C0538', { colorCastClass: 'green-cyan', colorCastConfidence: 0.76, medianA: -5.7, medianB: -4.3 }],
      ['C0539', { colorCastClass: 'neutral', colorCastConfidence: 0.43, medianA: -2.8, medianB: -1.3 }],
      ['C0540', { colorCastClass: 'neutral', colorCastConfidence: 0.43, medianA: -2.9, medianB: -1.5 }],
    ] as const);
    vi.mocked(colorCastClassifier.classifyColorCast).mockImplementation(async filePath => {
      const stem = String(filePath).match(/C\d{4}/)?.[0] ?? '';
      const metrics = metricsByStem.get(stem);
      return {
        colorCastClass: metrics?.colorCastClass ?? 'neutral',
        colorCastConfidence: metrics?.colorCastConfidence ?? 0.4,
        colorCastMetrics: {
          medianA: metrics?.medianA ?? 0,
          medianB: metrics?.medianB ?? 0,
          candidatePixelRatio: 0.12,
        },
      };
    });

    const prepared: IColorExecutorPrepareRootInput[] = [];
    await prepareProjectColorRoot({
      workspaceRoot,
      projectId,
      rootId,
      jobId: 'job-color-green-cyan-continuity',
      executor: createFakeExecutor({
        onPrepareRoot: async input => {
          prepared.push(input);
          return {
            resolveProjectName: input.resolveProjectName,
            gradingTimelineName: input.gradingTimelineName,
            mirrorStatus: 'synced',
            timelineStatus: 'ready',
            groupsSnapshot: buildGroupsSnapshot(input, 'prepare_root'),
            hostSummary: {},
          };
        },
      }),
    });

    const clips = prepared[0]?.clips ?? [];
    expect(clips.map(clip => clip.colorCastClass)).toEqual(Array.from({ length: 11 }, () => 'green-cyan'));
    expect(clips.find(clip => clip.rawRelativePath.endsWith('C0531.MP4'))?.colorCastMetrics).toMatchObject({
      continuityAdjustment: 'green-cyan-sequence',
      continuityAdjustedFromClass: 'neutral',
    });
  });

  it('extends a green-cyan run forward only through compatible nearby clips', async () => {
    const workspaceRoot = await createWorkspace();
    const projectId = 'project-color-green-cyan-forward-continuity';
    const rawFiles = Array.from(
      { length: 12 },
      (_, index) => `day11/C${String(1854 + index).padStart(4, '0')}.MP4`,
    );
    const { rootId } = await seedSingleRootProject({
      workspaceRoot,
      projectId,
      projectName: 'Project Color Green Cyan Forward Continuity',
      rawFiles,
    });

    mockColorMetadata();
    mockClipSignals({ logProfile: 'slog3' });
    const metricsByStem = new Map([
      ['C1854', { colorCastClass: 'green-cyan', colorCastConfidence: 0.76, medianA: -5.5, medianB: -2.5 }],
      ['C1855', { colorCastClass: 'green', colorCastConfidence: 0.66, medianA: -6.1, medianB: 0.3 }],
      ['C1856', { colorCastClass: 'green', colorCastConfidence: 0.64, medianA: -5.6, medianB: 0.8 }],
      ['C1857', { colorCastClass: 'green-cyan', colorCastConfidence: 0.74, medianA: -5.3, medianB: -3.6 }],
      ['C1858', { colorCastClass: 'green', colorCastConfidence: 0.70, medianA: -7.1, medianB: 0.6 }],
      ['C1859', { colorCastClass: 'green', colorCastConfidence: 0.71, medianA: -7.3, medianB: 0.2 }],
      ['C1860', { colorCastClass: 'green', colorCastConfidence: 0.67, medianA: -6.0, medianB: 1.0 }],
      ['C1861', { colorCastClass: 'neutral', colorCastConfidence: 0.42, medianA: -2.8, medianB: 3.0 }],
      ['C1862', { colorCastClass: 'green', colorCastConfidence: 0.67, medianA: -6.1, medianB: 1.0 }],
      ['C1863', { colorCastClass: 'neutral', colorCastConfidence: 0.44, medianA: -2.9, medianB: 0.6 }],
      ['C1864', { colorCastClass: 'green-cyan', colorCastConfidence: 0.64, medianA: -5.2, medianB: -2.8 }],
      ['C1865', { colorCastClass: 'green', colorCastConfidence: 0.64, medianA: -5.2, medianB: 5.1 }],
    ] as const);
    vi.mocked(colorCastClassifier.classifyColorCast).mockImplementation(async filePath => {
      const stem = String(filePath).match(/C\d{4}/)?.[0] ?? '';
      const metrics = metricsByStem.get(stem);
      return {
        colorCastClass: metrics?.colorCastClass ?? 'neutral',
        colorCastConfidence: metrics?.colorCastConfidence ?? 0.4,
        colorCastMetrics: {
          medianA: metrics?.medianA ?? 0,
          medianB: metrics?.medianB ?? 0,
          candidatePixelRatio: 0.11,
        },
      };
    });

    const prepared: IColorExecutorPrepareRootInput[] = [];
    await prepareProjectColorRoot({
      workspaceRoot,
      projectId,
      rootId,
      jobId: 'job-color-green-cyan-forward-continuity',
      executor: createFakeExecutor({
        onPrepareRoot: async input => {
          prepared.push(input);
          return {
            resolveProjectName: input.resolveProjectName,
            gradingTimelineName: input.gradingTimelineName,
            mirrorStatus: 'synced',
            timelineStatus: 'ready',
            groupsSnapshot: buildGroupsSnapshot(input, 'prepare_root'),
            hostSummary: {},
          };
        },
      }),
    });

    const clips = prepared[0]?.clips ?? [];
    expect(clips.map(clip => clip.colorCastClass)).toEqual(Array.from({ length: 12 }, () => 'green-cyan'));
    expect(clips.find(clip => clip.rawRelativePath.endsWith('C1865.MP4'))?.colorCastMetrics).toMatchObject({
      continuityAdjustment: 'green-cyan-sequence',
    });
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
    expect(validation?.status).toBe('pass');
    expect(current.roots[0]).toMatchObject({
      latestBatchId: executeResult.batchId,
      latestBatchStatus: 'validated',
      latestValidationStatus: 'pass',
    });

    expect(await readFile(join(currentLocalPath, 'day1', 'A001.mp4'), 'utf-8')).toBe('rendered:day1/A001.mov');
    expect(await readFile(join(currentLocalPath, 'day2', 'A001.mp4'), 'utf-8')).toBe('rendered:day2/A001.mov');
  });

  it('mirrors same-basename raw sidecars after direct-root export', async () => {
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
    const [manifest, validation] = await Promise.all([
      loadColorBatchManifest(projectRoot, executeResult.batchId!),
      loadColorBatchValidation(projectRoot, executeResult.batchId!),
    ]);
    expect(manifest?.entries[0]?.sidecars.map(sidecar => sidecar.outputRelativePath)).toEqual([
      'day1/A001.SRT',
      'day1/A001.WAV',
    ]);
    expect(manifest?.managedSidecarSet).toEqual(['day1/A001.SRT', 'day1/A001.WAV']);
    expect(validation?.status).toBe('pass');
    expect(await readFile(join(currentLocalPath, 'day1', 'A001.SRT'), 'utf-8')).toBe('subtitle');
    expect(await readFile(join(currentLocalPath, 'day1', 'A001.WAV'), 'utf-8')).toBe('audio');
    await expect(readFile(join(currentLocalPath, 'day1', 'A001_notes.srt'), 'utf-8')).rejects.toThrow();
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
        lowlight: true,
        colorCastClass: 'neutral',
        colorCastConfidence: 0.9,
        colorCastMetrics: {
          technicalTransformStatus: 'source-rgb',
          technicalLutRelativePath: undefined,
        },
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

  it('passes portrait orientation templates and horizontal-fill transform into prepare_root requests', async () => {
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
      rotationDegrees: 90,
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
      rotationDegrees: 90,
      orientationStatus: 'portrait',
      repairTemplateKey: 'portrait--90',
      gyroDataAvailable: true,
      gyroEligible: true,
      timelineTransform: {
        rotationAngle: -90,
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
    expect((await loadColorResolveProjectMap(projectRoot)).projects[saved.snapshot!.projectName]?.latestSnapshot?.snapshotPath)
      .toBe(saved.snapshot?.snapshotPath);

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

  it('prepare_all_roots respects priority order and continues after failures', async () => {
    const workspaceRoot = await createWorkspace();
    const projectId = 'project-color-prepare-all';
    const projectRoot = await initWorkspaceProject(workspaceRoot, projectId, 'Project Color Prepare All');
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
