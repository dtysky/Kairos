import type {
  IAssetCoarseReport,
  IInferredGps,
  IKtepAsset,
  IMediaRoot,
} from '../../protocol/schema.js';
import {
  getProjectProgressPath,
  loadAssetReports,
  loadAssets,
  loadIngestRoots,
  loadProjectBriefConfig,
  loadRuntimeConfig,
  markChronologyStale,
  markSpansStale,
  resolveWorkspaceProjectRoot,
  touchProjectUpdatedAt,
  writeAssetReport,
  writeKairosProgress,
} from '../../store/index.js';
import { loadOrBuildProjectPharosContext } from '../pharos/context.js';
import { resolvePharosTimedSpatialContext } from '../pharos/gpx-timed.js';
import { matchAssetToPharos } from '../pharos/matcher.js';
import { refreshProjectDerivedTrackCache } from './project-derived-track.js';
import { refreshProjectGpsCache, resolveProjectGpxPaths } from './project-gps.js';
import {
  createProjectReverseGeocodeService,
  resolveAnalyzeLocationText,
  type IReverseGeocodeService,
} from './reverse-geocode.js';
import { resolveAssetSpatialContext } from './spatial-resolver.js';
import { resolveAnalyzePrimarySpatial } from './spatial-priority.js';

export interface IRefreshAnalyzeSpatialResultsInput {
  workspaceRoot: string;
  projectId: string;
  gpxMatchToleranceMs?: number;
  reverseGeocodeService?: IReverseGeocodeService | null;
}

export interface IRefreshAnalyzeSpatialResultsResult {
  projectRoot: string;
  reportCount: number;
  updatedReportCount: number;
  skippedReportCount: number;
  missingAssetReportCount: number;
  spansMarkedStale: boolean;
  chronologyMarkedStale: boolean;
  pharosMatchCount: number;
  embeddedPreservedCount: number;
}

export async function refreshAnalyzeSpatialResults(
  input: IRefreshAnalyzeSpatialResultsInput,
): Promise<IRefreshAnalyzeSpatialResultsResult> {
  const projectRoot = resolveWorkspaceProjectRoot(input.workspaceRoot, input.projectId);
  const progressPath = getProjectProgressPath(projectRoot, 'media-analyze');
  const progressBase = {
    pipelineKey: 'spatial-refresh',
    pipelineLabel: 'Analyze 空间结果刷新',
    phaseKey: 'spatial-refresh',
    phaseLabel: '刷新空间结果',
    stepDefinitions: [
      { key: 'inputs', label: '刷新空间输入' },
      { key: 'reports', label: '修补 asset-reports' },
      { key: 'stale', label: '标记下游过期' },
    ],
  };

  await writeKairosProgress(progressPath, {
    ...progressBase,
    status: 'running',
    step: 'inputs',
    stepLabel: '刷新空间输入',
    stepIndex: 1,
    stepTotal: 3,
    current: 0,
    total: 3,
    unit: 'step',
    detail: '正在刷新 project GPX / derived track / Pharos context',
    extra: { projectId: input.projectId },
  });

  const reverseGeocodeService = input.reverseGeocodeService
    ?? await createProjectReverseGeocodeService({
      projectRoot,
      runtimeConfig: await loadRuntimeConfig(projectRoot),
    });
  const projectBrief = await loadProjectBriefConfig(projectRoot);
  await refreshProjectGpsCache(projectRoot);
  const derivedTrack = await refreshProjectDerivedTrackCache({
    projectRoot,
    reverseGeocodeService,
  });
  const pharosContext = await loadOrBuildProjectPharosContext({
    projectRoot,
    includedTripIds: projectBrief.pharos?.includedTripIds ?? [],
  });
  if (pharosContext.status === 'failure') {
    throw new Error(pharosContext.errors.length > 0
      ? pharosContext.errors.join('; ')
      : 'Pharos context 解析失败');
  }

  const [assets, reports, ingestRoots] = await Promise.all([
    loadAssets(projectRoot),
    loadAssetReports(projectRoot),
    loadIngestRoots(projectRoot),
  ]);
  const roots = ingestRoots.roots;
  const assetMap = new Map(assets.map(asset => [asset.id, asset]));
  const rootMap = new Map(roots.map(root => [root.id, root]));
  const gpxPaths = await resolveProjectGpxPaths({
    projectRoot,
  });

  await writeKairosProgress(progressPath, {
    ...progressBase,
    status: 'running',
    step: 'reports',
    stepLabel: '修补 asset-reports',
    stepIndex: 2,
    stepTotal: 3,
    current: 0,
    total: reports.length,
    unit: 'reports',
    detail: `正在重算 ${reports.length} 条已有 report 的 GPS / Pharos 空间字段`,
    extra: { projectId: input.projectId, reportCount: reports.length },
  });

  let updatedReportCount = 0;
  let missingAssetReportCount = 0;
  let pharosMatchCount = 0;
  let embeddedPreservedCount = 0;
  const refreshedReports: IAssetCoarseReport[] = [];
  for (const [index, report] of reports.entries()) {
    const asset = assetMap.get(report.assetId);
    if (!asset) {
      missingAssetReportCount += 1;
      refreshedReports.push(report);
      continue;
    }
    const refreshed = await refreshReportSpatialFields({
      report,
      asset,
      root: rootMap.get(asset.ingestRootId ?? ''),
      gpxPaths,
      derivedTrack,
      pharosContext,
      reverseGeocodeService,
      gpxMatchToleranceMs: input.gpxMatchToleranceMs,
    });
    pharosMatchCount += refreshed.report.pharosMatches.length;
    if (refreshed.embeddedPreserved) embeddedPreservedCount += 1;
    if (hasSpatialReportChanged(report, refreshed.report)) {
      updatedReportCount += 1;
      await writeAssetReport(projectRoot, refreshed.report);
      refreshedReports.push(refreshed.report);
    } else {
      refreshedReports.push(report);
    }

    if ((index + 1) % 25 === 0 || index + 1 === reports.length) {
      await writeKairosProgress(progressPath, {
        ...progressBase,
        status: 'running',
        step: 'reports',
        stepLabel: '修补 asset-reports',
        stepIndex: 2,
        stepTotal: 3,
        current: index + 1,
        total: reports.length,
        unit: 'reports',
        detail: `已检查 ${index + 1}/${reports.length} 条 report`,
        extra: {
          projectId: input.projectId,
          updatedReportCount,
          missingAssetReportCount,
        },
      });
    }
  }

  await writeKairosProgress(progressPath, {
    ...progressBase,
    status: 'running',
    step: 'stale',
    stepLabel: '标记下游过期',
    stepIndex: 3,
    stepTotal: 3,
    current: 2,
    total: 3,
    unit: 'step',
    detail: '正在标记 spans 和 chronology 过期',
    extra: { projectId: input.projectId, updatedReportCount },
  });

  const [staleSpans, staleChronology] = await Promise.all([
    markSpansStale(projectRoot, 'spatial-refresh updated asset report spatial fields; rerun /chronology span-rebuild'),
    markChronologyStale(projectRoot),
  ]);
  await touchProjectUpdatedAt(projectRoot);

  const result: IRefreshAnalyzeSpatialResultsResult = {
    projectRoot,
    reportCount: reports.length,
    updatedReportCount,
    skippedReportCount: reports.length - updatedReportCount,
    missingAssetReportCount,
    spansMarkedStale: staleSpans != null,
    chronologyMarkedStale: staleChronology != null,
    pharosMatchCount,
    embeddedPreservedCount,
  };

  await writeKairosProgress(progressPath, {
    ...progressBase,
    status: 'succeeded',
    step: 'stale',
    stepLabel: '标记下游过期',
    stepIndex: 3,
    stepTotal: 3,
    current: 3,
    total: 3,
    unit: 'step',
    etaSeconds: 0,
    detail: `空间刷新完成：更新 ${updatedReportCount} 条 report；请重新生成 spans 与 chronology`,
    extra: { projectId: input.projectId, ...result },
  });

  return result;
}

async function refreshReportSpatialFields(input: {
  report: IAssetCoarseReport;
  asset: IKtepAsset;
  root?: IMediaRoot;
  gpxPaths: string[];
  derivedTrack: Awaited<ReturnType<typeof refreshProjectDerivedTrackCache>>;
  pharosContext: Awaited<ReturnType<typeof loadOrBuildProjectPharosContext>>;
  reverseGeocodeService?: IReverseGeocodeService | null;
  gpxMatchToleranceMs?: number;
}): Promise<{ report: IAssetCoarseReport; embeddedPreserved: boolean }> {
  const manualSpatial = await resolveAssetSpatialContext({
    asset: input.asset,
    root: input.root,
    gpxPaths: input.gpxPaths,
    gpxMatchToleranceMs: input.gpxMatchToleranceMs,
    derivedTrack: input.derivedTrack,
  });
  const basePlaceHints = dedupeStrings([
    ...(input.report.placeHints ?? []),
    ...(manualSpatial?.placeHints ?? []),
  ]);
  const pharosMatches = matchAssetToPharos({
    asset: input.asset,
    context: input.pharosContext,
    report: {
      clipTypeGuess: input.report.clipTypeGuess,
      summary: input.report.summary,
      placeHints: basePlaceHints,
      labels: input.report.labels ?? [],
    },
  });
  const pharosSpatial = await resolvePharosTimedSpatialContext({
    asset: input.asset,
    clipType: input.report.clipTypeGuess,
    pharosContext: input.pharosContext,
    pharosMatches,
    matchToleranceMs: input.gpxMatchToleranceMs,
  });
  const locationResolution = await resolveAnalyzeLocationText({
    clipType: input.report.clipTypeGuess,
    manualSpatial,
    pharosSpatial,
    reverseGeocodeService: input.reverseGeocodeService,
  });
  const primarySpatial = resolveAnalyzePrimarySpatial({
    manualSpatial,
    pharosSpatial,
  });
  const inferredGps = applyLocationTextToInferredGps(
    primarySpatial.inferredGps,
    locationResolution.locationText,
  );
  const updatedSpatial: IAssetCoarseReport = {
    ...input.report,
    gpsSummary: primarySpatial.gpsSummary,
    inferredGps,
    pharosMatches,
    primaryPharosRef: pharosMatches[0]?.ref,
    pharosMatchConfidence: pharosMatches[0]?.confidence,
    pharosStatus: pharosMatches[0]?.status,
    pharosDayTitle: pharosMatches[0]?.dayTitle,
    placeHints: dedupeStrings([
      ...basePlaceHints,
      ...locationResolution.placeHints,
    ]),
  };
  return {
    report: hasSpatialReportChanged(input.report, updatedSpatial)
      ? { ...updatedSpatial, updatedAt: new Date().toISOString() }
      : updatedSpatial,
    embeddedPreserved: Boolean(
      manualSpatial?.inferredGps?.source === 'embedded'
      && pharosSpatial?.inferredGps
      && inferredGps?.source === 'embedded',
    ),
  };
}

function hasSpatialReportChanged(
  before: IAssetCoarseReport,
  after: IAssetCoarseReport,
): boolean {
  return JSON.stringify(pickSpatialReportFields(before)) !== JSON.stringify(pickSpatialReportFields(after));
}

function pickSpatialReportFields(report: IAssetCoarseReport): Record<string, unknown> {
  return {
    gpsSummary: report.gpsSummary,
    inferredGps: report.inferredGps,
    pharosMatches: report.pharosMatches,
    primaryPharosRef: report.primaryPharosRef,
    pharosMatchConfidence: report.pharosMatchConfidence,
    pharosStatus: report.pharosStatus,
    pharosDayTitle: report.pharosDayTitle,
    placeHints: report.placeHints,
  };
}

function applyLocationTextToInferredGps(
  inferredGps: IInferredGps | undefined,
  locationText: string | undefined,
): IInferredGps | undefined {
  if (!inferredGps) return undefined;
  return {
    ...inferredGps,
    locationText: locationText ?? inferredGps.locationText,
  };
}

function dedupeStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.map(value => value?.trim()).filter(Boolean) as string[])];
}
