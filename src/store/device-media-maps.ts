import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  IDeviceMediaMapFile,
  IDeviceMediaProjectMap,
} from '../protocol/schema.js';
import { readJsonOrNull, writeJson } from './writer.js';

export function getDefaultDeviceMediaMapPath(): string {
  return join(homedir(), '.kairos', 'device-media-maps.json');
}

export async function loadDeviceMediaMaps(
  filePath = getDefaultDeviceMediaMapPath(),
): Promise<IDeviceMediaMapFile> {
  return await readJsonOrNull(filePath, IDeviceMediaMapFile) ?? { projects: {} };
}

export async function saveDeviceMediaMaps(
  data: IDeviceMediaMapFile,
  filePath = getDefaultDeviceMediaMapPath(),
): Promise<void> {
  await writeJson(filePath, data);
}

export async function saveDeviceProjectMap(
  projectId: string,
  projectMap: Omit<IDeviceMediaProjectMap, 'projectId'>,
  filePath = getDefaultDeviceMediaMapPath(),
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
  filePath = getDefaultDeviceMediaMapPath(),
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
