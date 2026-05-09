import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { IMediaRoot } from '../protocol/schema.js';
import { loadIngestRoots } from './project.js';
import { projectBriefToMediaRoots } from './project-root-truth.js';
import { loadProjectBriefConfig, saveProjectBriefConfig } from './workspace-config.js';

export interface ISyncProjectBriefInput {
  projectId: string;
  projectRoot: string;
}

export interface ISyncProjectBriefResult {
  ingestRoots: IMediaRoot[];
  warnings: string[];
}

export async function syncProjectBriefMappings(
  input: ISyncProjectBriefInput,
): Promise<ISyncProjectBriefResult> {
  const [projectBrief, existingRoots] = await Promise.all([
    loadProjectBriefConfig(input.projectRoot),
    loadIngestRoots(input.projectRoot),
  ]);

  if (projectBrief.mappings.length === 0) {
    await removeLegacyProjectDeviceMap(input.projectRoot);
    return {
      ingestRoots: existingRoots.roots,
      warnings: [],
    };
  }

  const savedProjectBrief = await saveProjectBriefConfig(input.projectRoot, projectBrief);
  const roots = projectBriefToMediaRoots(savedProjectBrief);
  await removeLegacyProjectDeviceMap(input.projectRoot);

  return {
    ingestRoots: roots,
    warnings: [],
  };
}

async function removeLegacyProjectDeviceMap(projectRoot: string): Promise<void> {
  await rm(join(projectRoot, 'config', 'device-media-maps.local.json'), { force: true });
}
