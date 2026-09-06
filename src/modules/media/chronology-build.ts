import type { IProjectChronology } from '../../protocol/schema.js';
import {
  assertFreshSpans,
  loadAssetReports,
  loadAssets,
  loadChronologyForRebuild,
  loadProjectDerivedTrack,
  loadProjectGpsMerged,
  loadIngestRoots,
  loadProjectBriefConfig,
  getProjectProgressPath,
  loadRuntimeConfig,
  resolveWorkspaceProjectRoot,
  touchProjectUpdatedAt,
  writeKairosProgress,
  writeChronology,
} from '../../store/index.js';
import { loadOrBuildProjectPharosContext } from '../pharos/context.js';
import { buildMediaChronologyWithProgress, type IChronologyTimedPoint } from './chronology.js';
import { loadGpxPoints } from './gpx-spatial.js';
import { createProjectReverseGeocodeService, type IReverseGeocodeService } from './reverse-geocode.js';
import { prepareProjectChronologyEventConsolidation } from './chronology-event-consolidation.js';

export interface IProjectChronologyBuildResult {
  projectRoot: string;
  spanCount: number;
  eventCount: number;
  inputsHash: string;
  chronology: IProjectChronology;
}

export async function buildProjectChronology(input: {
  workspaceRoot: string;
  projectId: string;
  now?: string;
  progressPath?: string;
  reverseGeocodeService?: IReverseGeocodeService | null;
}): Promise<IProjectChronologyBuildResult> {
  const projectRoot = resolveWorkspaceProjectRoot(input.workspaceRoot, input.projectId);
  const progressPath = input.progressPath ?? getProjectProgressPath(projectRoot, 'chronology');

  try {
    await writeChronologyBuildProgress(progressPath, {
      status: 'running',
      step: 'inputs',
      stepLabel: '读取 chronology 输入',
      stepIndex: 1,
      current: 1,
      detail: '读取 fresh spans、assets、asset reports、root config 与 GPS cache',
    });

    const [{ spans }, assets, reports, existing, { roots }, projectBrief, projectGpsMerged, derivedTrack] = await Promise.all([
      assertFreshSpans(projectRoot),
      loadAssets(projectRoot),
      loadAssetReports(projectRoot),
      loadChronologyForRebuild(projectRoot),
      loadIngestRoots(projectRoot),
      loadProjectBriefConfig(projectRoot),
      loadProjectGpsMerged(projectRoot),
      loadProjectDerivedTrack(projectRoot),
    ]);

    await writeChronologyBuildProgress(progressPath, {
      status: 'running',
      step: 'pharos-gps',
      stepLabel: '读取 Pharos / GPS',
      stepIndex: 2,
      current: 2,
      detail: `读取 ${spans.length} 个 spans 与 ${assets.length} 个 assets，准备加载 Pharos context`,
      extra: {
        spanCount: spans.length,
        assetCount: assets.length,
        reportCount: reports.length,
      },
    });

    const pharosContext = await loadOrBuildProjectPharosContext({
      projectRoot,
      includedTripIds: projectBrief.pharos?.includedTripIds ?? [],
    });
    if (pharosContext.status === 'failure') {
      throw new Error(pharosContext.errors.length > 0
        ? pharosContext.errors.join('; ')
        : 'Pharos context parse failed');
    }
    const pharosGpsPoints = await loadChronologyPharosGpsPoints(pharosContext.status === 'success' ? pharosContext : null);
    const reverseGeocodeService = await resolveRequiredChronologyReverseGeocodeService({
      projectRoot,
      service: input.reverseGeocodeService,
    });

    const chronology = await buildMediaChronologyWithProgress(
      assets,
      reports,
      existing,
      roots,
      {
        spans,
        pharosContext,
        pharosGpsPoints,
        projectGpsPoints: (projectGpsMerged?.points ?? []).map(point => ({
          lat: point.lat,
          lng: point.lng,
          time: point.time,
          path: point.sourcePath,
        })),
        derivedTrack,
        now: input.now,
        reverseGeocodeService,
        requireReverseGeocode: true,
        onProgress: progress => writeChronologyBuildProgress(progressPath, {
          status: 'running',
          ...progress,
          extra: {
            ...progress.extra,
            assetCount: assets.length,
            reportCount: reports.length,
            pharosShotCount: pharosContext.status === 'success' ? pharosContext.shots.length : 0,
            pharosGpsPointCount: pharosGpsPoints.length,
            projectGpsPointCount: projectGpsMerged?.points.length ?? 0,
            derivedTrackEntryCount: derivedTrack?.entries.length ?? 0,
          },
        }),
      },
    );

    await writeChronologyBuildProgress(progressPath, {
      status: 'running',
      step: 'write',
      stepLabel: '写入 Chronology V2',
      stepIndex: 11,
      current: chronology.events.length,
      total: Math.max(1, chronology.events.length),
      unit: 'event',
      detail: `生成 ${chronology.events.length} 个 chronology events，准备写入 media/chronology.json`,
      extra: {
        spanCount: spans.length,
        assetCount: assets.length,
        reportCount: reports.length,
        eventCount: chronology.events.length,
        inputsHash: chronology.inputsHash,
      },
    });

    await writeChronology(projectRoot, chronology);
    await prepareProjectChronologyEventConsolidation({
      workspaceRoot: input.workspaceRoot,
      projectId: input.projectId,
      chronology,
      now: input.now,
    });
    await touchProjectUpdatedAt(projectRoot);

    await writeChronologyBuildProgress(progressPath, {
      status: 'succeeded',
      step: 'done',
      stepLabel: '编年史已生成',
      stepIndex: 12,
      current: chronology.events.length,
      total: Math.max(1, chronology.events.length),
      unit: 'event',
      etaSeconds: 0,
      detail: `写入 ${chronology.events.length} 个 chronology events，来自 ${spans.length} 个 spans`,
      extra: {
        spanCount: spans.length,
        assetCount: assets.length,
        reportCount: reports.length,
        eventCount: chronology.events.length,
        inputsHash: chronology.inputsHash,
      },
    });

    return {
      projectRoot,
      spanCount: spans.length,
      eventCount: chronology.events.length,
      inputsHash: chronology.inputsHash,
      chronology,
    };
  } catch (error) {
    await writeChronologyBuildProgress(progressPath, {
      status: 'failed',
      step: 'done',
      stepLabel: '编年史生成失败',
      stepIndex: 12,
      current: 0,
      total: 1,
      unit: 'error',
      etaSeconds: 0,
      detail: formatChronologyBuildError(error),
      extra: {
        projectId: input.projectId,
      },
    }).catch(() => undefined);
    throw error;
  }
}

function formatChronologyBuildError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function resolveRequiredChronologyReverseGeocodeService(input: {
  projectRoot: string;
  service?: IReverseGeocodeService | null;
}): Promise<IReverseGeocodeService> {
  if (input.service === null) {
    throw new Error('chronology-build requires GPS reverse-geocode service; null service is not allowed for project chronology writes');
  }
  if (input.service) return input.service;
  return createProjectReverseGeocodeService({
    projectRoot: input.projectRoot,
    runtimeConfig: await loadRuntimeConfig(input.projectRoot),
  });
}

async function writeChronologyBuildProgress(
  progressPath: string,
  progress: {
    status: 'running' | 'succeeded' | 'failed';
    step: string;
    stepLabel: string;
    stepIndex: number;
    current: number;
    total?: number;
    unit?: string;
    detail: string;
    etaSeconds?: number;
    extra?: Record<string, unknown>;
  },
): Promise<void> {
  await writeKairosProgress(progressPath, {
    pipelineKey: 'chronology',
    pipelineLabel: 'Chronology 生成链路',
    phaseKey: 'chronology-build',
    phaseLabel: '生成/刷新编年史',
    stepDefinitions: [
      { key: 'inputs', label: '读取输入' },
      { key: 'pharos-gps', label: '读取 Pharos / GPS' },
      { key: 'asset-index', label: '建立素材时间索引' },
      { key: 'input-hash', label: '计算输入指纹' },
      { key: 'span-rows', label: '解析 span 时空归属' },
      { key: 'sort-rows', label: '排序 chronology rows' },
      { key: 'aggregate-events', label: '聚合事件路线' },
      { key: 'resolve-locations', label: 'GPS 反查地名' },
      { key: 'gap-events', label: '生成 Pharos 缺口' },
      { key: 'review-state', label: '合并审查状态' },
      { key: 'write', label: '写入结果' },
      { key: 'done', label: '完成' },
    ],
    stepTotal: 12,
    total: progress.total ?? 12,
    unit: progress.unit ?? 'step',
    ...progress,
  });
}

async function loadChronologyPharosGpsPoints(
  pharosContext: Awaited<ReturnType<typeof loadOrBuildProjectPharosContext>> | null,
): Promise<IChronologyTimedPoint[]> {
  if (!pharosContext || pharosContext.status !== 'success' || pharosContext.gpxFiles.length === 0) {
    return [];
  }
  const pointGroups = await Promise.all(pharosContext.gpxFiles.map(async file => {
    const points = await loadGpxPoints(file.path).catch(() => []);
    return points.map(point => ({
      lat: point.lat,
      lng: point.lng,
      time: point.time,
      path: point.path,
      tripId: file.tripId,
    }));
  }));
  return pointGroups.flat();
}
