import type {
  IAssetCoarseReport,
  IInferredGps,
  IKtepAsset,
  IKtepSlice,
  IMediaRoot,
} from '../../protocol/schema.js';
import {
  getProjectProgressPath,
  getSpansPath,
  loadAssetReports,
  loadAssets,
  loadChronology,
  loadIngestRoots,
  loadProjectBriefConfig,
  loadRuntimeConfig,
  loadSlices,
  resolveWorkspaceProjectRoot,
  touchProjectUpdatedAt,
  writeAssetReport,
  writeChronology,
  writeJson,
  writeKairosProgress,
} from '../../store/index.js';
import { loadOrBuildProjectPharosContext, pharosRefsFromMatches } from '../pharos/context.js';
import { resolvePharosTimedSpatialContext } from '../pharos/gpx-timed.js';
import { matchAssetToPharos } from '../pharos/matcher.js';
import { buildMediaChronology } from './chronology.js';
import type { IManualSpatialContext } from './manual-spatial.js';
import { refreshProjectDerivedTrackCache } from './project-derived-track.js';
import { refreshProjectGpsCache, resolveProjectGpxPaths } from './project-gps.js';
import {
  createProjectReverseGeocodeService,
  resolveAnalyzeLocationText,
  type IReverseGeocodeService,
} from './reverse-geocode.js';
import { buildSpatialEvidenceFromReport } from './semantic-slice.js';
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
  spanCount: number;
  updatedSpanCount: number;
  chronologyCount: number;
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
      { key: 'downstream', label: '刷新 chronology / spans' },
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

  const [assets, reports, ingestRoots, existingChronology, existingSlices] = await Promise.all([
    loadAssets(projectRoot),
    loadAssetReports(projectRoot),
    loadIngestRoots(projectRoot),
    loadChronology(projectRoot),
    loadSlices(projectRoot),
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
    step: 'downstream',
    stepLabel: '刷新 chronology / spans',
    stepIndex: 3,
    stepTotal: 3,
    current: 2,
    total: 3,
    unit: 'step',
    detail: '正在用新的 report 空间字段刷新 chronology 和 spans grounding',
    extra: { projectId: input.projectId, updatedReportCount },
  });

  const chronology = buildMediaChronology(assets, refreshedReports, existingChronology, roots);
  await writeChronology(projectRoot, chronology);

  const refreshedReportMap = new Map(refreshedReports.map(report => [report.assetId, report]));
  const refreshedSlices = await refreshSlicesSpatialGrounding({
    slices: existingSlices,
    assetsById: assetMap,
    reportsByAssetId: refreshedReportMap,
    pharosContext,
  });
  await writeJson(getSpansPath(projectRoot), refreshedSlices.slices);
  await touchProjectUpdatedAt(projectRoot);

  const result: IRefreshAnalyzeSpatialResultsResult = {
    projectRoot,
    reportCount: reports.length,
    updatedReportCount,
    skippedReportCount: reports.length - updatedReportCount,
    missingAssetReportCount,
    spanCount: existingSlices.length,
    updatedSpanCount: refreshedSlices.updatedCount,
    chronologyCount: chronology.length,
    pharosMatchCount,
    embeddedPreservedCount,
  };

  await writeKairosProgress(progressPath, {
    ...progressBase,
    status: 'succeeded',
    step: 'downstream',
    stepLabel: '刷新 chronology / spans',
    stepIndex: 3,
    stepTotal: 3,
    current: 3,
    total: 3,
    unit: 'step',
    etaSeconds: 0,
    detail: `空间刷新完成：更新 ${updatedReportCount} 条 report，刷新 ${refreshedSlices.updatedCount} 条 span`,
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

async function refreshSlicesSpatialGrounding(input: {
  slices: IKtepSlice[];
  assetsById: Map<string, IKtepAsset>;
  reportsByAssetId: Map<string, IAssetCoarseReport>;
  pharosContext: Awaited<ReturnType<typeof loadOrBuildProjectPharosContext>>;
}): Promise<{ slices: IKtepSlice[]; updatedCount: number }> {
  let updatedCount = 0;
  const slices = await Promise.all(input.slices.map(async slice => {
    const report = input.reportsByAssetId.get(slice.assetId);
    if (!report) return slice;
    const asset = input.assetsById.get(slice.assetId);
    const spatialEvidence = await buildSpatialEvidenceFromReport({
      clipType: report.clipTypeGuess,
      report,
      asset,
      slice,
      pharosContext: input.pharosContext,
    });
    const pharosRefs = pharosRefsFromMatches(report.pharosMatches);
    const refreshed: IKtepSlice = {
      ...slice,
      pharosRefs,
      grounding: {
        speechMode: slice.grounding?.speechMode ?? 'none',
        speechValue: slice.grounding?.speechValue ?? 'none',
        spatialEvidence,
        pharosRefs,
      },
    };
    if (JSON.stringify(slice) !== JSON.stringify(refreshed)) {
      updatedCount += 1;
    }
    return refreshed;
  }));
  return { slices, updatedCount };
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
