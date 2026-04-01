import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  IDeviceMediaMapFile,
  IDeviceMediaProjectMap,
} from '../protocol/schema.js';
import { readJsonOrNull, writeJson } from './writer.js';

export function getGlobalDeviceMediaMapPath(): string {
  return join(homedir(), '.kairos', 'device-media-maps.json');
}

export function getProjectDeviceMediaMapPath(projectRoot: string): string {
  return join(projectRoot, 'config', 'device-media-maps.local.json');
}

export function getDefaultDeviceMediaMapPath(projectRoot?: string): string {
  return projectRoot
    ? getProjectDeviceMediaMapPath(projectRoot)
    : getGlobalDeviceMediaMapPath();
}

export async function loadDeviceMediaMaps(
  filePath = getGlobalDeviceMediaMapPath(),
): Promise<IDeviceMediaMapFile> {
  return await readJsonOrNull(filePath, IDeviceMediaMapFile) ?? { projects: {} };
}

export async function saveDeviceMediaMaps(
  data: IDeviceMediaMapFile,
  filePath = getGlobalDeviceMediaMapPath(),
): Promise<void> {
  await writeJson(filePath, data);
}

export async function saveDeviceProjectMap(
  projectId: string,
  projectMap: Omit<IDeviceMediaProjectMap, 'projectId'>,
  filePath = getGlobalDeviceMediaMapPath(),
): Promise<IDeviceMediaMapFile> {
  const data = await loadDeviceMediaMaps(filePath);
  data.projects[projectId] = {
    projectId,
    roots: projectMap.roots,
  };
  await saveDeviceMediaMaps(data, filePath);
  return data;
}

export async function assignDeviceMediaRoot(
  projectId: string,
  rootId: string,
  localPath: string,
  filePath = getGlobalDeviceMediaMapPath(),
): Promise<IDeviceMediaMapFile> {
  const data = await loadDeviceMediaMaps(filePath);
  const existing = data.projects[projectId] ?? { projectId, roots: [] };
  const now = new Date().toISOString();

  const idx = existing.roots.findIndex(root => root.rootId === rootId);
  if (idx >= 0) {
    existing.roots[idx] = {
      ...existing.roots[idx],
      localPath,
      lastCheckedAt: now,
    };
  } else {
    existing.roots.push({
      rootId,
      localPath,
      lastCheckedAt: now,
    });
  }

  data.projects[projectId] = existing;
  await saveDeviceMediaMaps(data, filePath);
  return data;
}

export async function loadProjectDeviceMediaMaps(
  projectRoot: string,
  filePath?: string,
): Promise<IDeviceMediaMapFile> {
  return loadDeviceMediaMaps(resolveDeviceMediaMapPath(projectRoot, filePath));
}

export async function saveProjectDeviceMap(
  projectRoot: string,
  projectId: string,
  projectMap: Omit<IDeviceMediaProjectMap, 'projectId'>,
  filePath?: string,
): Promise<IDeviceMediaMapFile> {
  return saveDeviceProjectMap(
    projectId,
    projectMap,
    resolveDeviceMediaMapPath(projectRoot, filePath),
  );
}

export async function assignProjectDeviceMediaRoot(
  projectRoot: string,
  projectId: string,
  rootId: string,
  localPath: string,
  filePath?: string,
): Promise<IDeviceMediaMapFile> {
  return assignDeviceMediaRoot(
    projectId,
    rootId,
    localPath,
    resolveDeviceMediaMapPath(projectRoot, filePath),
  );
}

function resolveDeviceMediaMapPath(projectRoot: string, filePath?: string): string {
  return filePath ?? getProjectDeviceMediaMapPath(projectRoot);
}
