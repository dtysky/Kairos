import type { IProjectChronology } from '../../protocol/schema.js';
import {
  assertFreshSpans,
  loadAssetReports,
  loadAssets,
  loadChronologyForRebuild,
  loadIngestRoots,
  loadProjectBriefConfig,
  resolveWorkspaceProjectRoot,
  touchProjectUpdatedAt,
  writeChronology,
} from '../../store/index.js';
import { loadOrBuildProjectPharosContext } from '../pharos/context.js';
import { buildMediaChronology } from './chronology.js';

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
  const [{ spans }, assets, reports, existing, { roots }, projectBrief] = await Promise.all([
    assertFreshSpans(projectRoot),
    loadAssets(projectRoot),
    loadAssetReports(projectRoot),
    loadChronologyForRebuild(projectRoot),
    loadIngestRoots(projectRoot),
    loadProjectBriefConfig(projectRoot),
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

  const chronology = buildMediaChronology(
    assets,
    reports,
    existing,
    roots,
    { spans, pharosContext, now: input.now },
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
