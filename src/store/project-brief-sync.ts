import type { IDeviceMediaMapFile, IMediaRoot } from '../protocol/schema.js';
import { loadProjectDeviceMediaMaps, saveProjectDeviceMap } from './device-media-maps.js';
import { loadIngestRoots } from './project.js';
import { normalizeProjectBriefLocalPath } from './project-brief.js';
import { projectBriefToMediaRoots } from './project-root-truth.js';
import { loadProjectBriefConfig, saveProjectBriefConfig } from './workspace-config.js';

export interface ISyncProjectBriefInput {
  projectId: string;
  projectRoot: string;
  deviceMapPath?: string;
}

export interface ISyncProjectBriefResult {
  ingestRoots: IMediaRoot[];
  deviceMaps: IDeviceMediaMapFile;
  warnings: string[];
}

export async function syncProjectBriefMappings(
  input: ISyncProjectBriefInput,
): Promise<ISyncProjectBriefResult> {
  const [projectBrief, existingRoots, existingDeviceMaps] = await Promise.all([
    loadProjectBriefConfig(input.projectRoot),
    loadIngestRoots(input.projectRoot),
    loadProjectDeviceMediaMaps(input.projectRoot, input.deviceMapPath),
  ]);

  if (projectBrief.mappings.length === 0) {
    return {
      ingestRoots: existingRoots.roots,
      deviceMaps: existingDeviceMaps,
      warnings: [],
    };
  }

  const savedProjectBrief = await saveProjectBriefConfig(input.projectRoot, projectBrief);
  const roots = projectBriefToMediaRoots(savedProjectBrief);
  const deviceMaps = await saveProjectDeviceMap(
    input.projectRoot,
    input.projectId,
    {
      roots: savedProjectBrief.mappings.map(mapping => ({
        rootId: mapping.rootId,
        localPath: normalizeProjectBriefLocalPath(mapping.path),
        rawLocalPath: mapping.rawPath
          ? normalizeProjectBriefLocalPath(mapping.rawPath, mapping.path)
          : undefined,
        flightRecordPath: mapping.flightRecordPath
          ? normalizeProjectBriefLocalPath(mapping.flightRecordPath, mapping.path)
          : undefined,
      })),
    },
    input.deviceMapPath,
  );

  return {
    ingestRoots: roots,
    deviceMaps,
    warnings: [],
  };
}
