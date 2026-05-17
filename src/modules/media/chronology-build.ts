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
  resolveWorkspaceProjectRoot,
  touchProjectUpdatedAt,
  writeChronology,
} from '../../store/index.js';
import { loadOrBuildProjectPharosContext } from '../pharos/context.js';
import { buildMediaChronology, type IChronologyTimedPoint } from './chronology.js';
import { loadGpxPoints } from './gpx-spatial.js';

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
}): Promise<IProjectChronologyBuildResult> {
  const projectRoot = resolveWorkspaceProjectRoot(input.workspaceRoot, input.projectId);
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

  const chronology = buildMediaChronology(
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
    },
  );
  await writeChronology(projectRoot, chronology);
  await touchProjectUpdatedAt(projectRoot);

  return {
    projectRoot,
    spanCount: spans.length,
    eventCount: chronology.events.length,
    inputsHash: chronology.inputsHash,
    chronology,
  };
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
