import { isAbsolute, join, relative } from 'node:path';
import type {
  IDeviceMediaMapFile,
  IKtepAsset,
  IMediaRoot,
} from '../../protocol/schema.js';

export interface IResolvedMediaRoot {
  root: IMediaRoot;
  localPath: string;
  rawLocalPath?: string;
  flightRecordPath?: string;
}

export interface IMediaRootResolution {
  resolved: IResolvedMediaRoot[];
  missing: IMediaRoot[];
}

export function resolveMediaRootsForDevice(
  projectId: string,
  roots: IMediaRoot[],
  deviceMaps: IDeviceMediaMapFile,
): IMediaRootResolution {
  const projectMap = deviceMaps.projects[projectId];
  const pathMap = new Map(
    (projectMap?.roots ?? []).map(item => [item.rootId, item]),
  );
  const resolved: IResolvedMediaRoot[] = [];
  const missing: IMediaRoot[] = [];

  for (const root of roots) {
    if (!root.enabled) continue;
    const localRoot = pathMap.get(root.id);
    if (localRoot?.localPath) {
      resolved.push({
        root,
        localPath: localRoot.localPath,
        rawLocalPath: localRoot.rawLocalPath ?? root.rawPath,
        flightRecordPath: localRoot.flightRecordPath,
      });
    } else if (root.path) {
      // Backward-compatible fallback for older project configs.
      resolved.push({ root, localPath: root.path });
    } else {
      missing.push(root);
    }
  }

  return { resolved, missing };
}

export function toPortableRelativePath(
  rootPath: string,
  filePath: string,
): string {
  return relative(rootPath, filePath).replace(/\\/g, '/');
}

export function resolveAssetLocalPath(
  projectId: string,
  asset: Pick<IKtepAsset, 'ingestRootId' | 'sourcePath'>,
  roots: IMediaRoot[],
  deviceMaps: IDeviceMediaMapFile,
): string | null {
  if (isAbsolute(asset.sourcePath)) {
    return asset.sourcePath;
  }

  if (!asset.ingestRootId) return null;

  const { resolved } = resolveMediaRootsForDevice(projectId, roots, deviceMaps);
  const root = resolved.find(item => item.root.id === asset.ingestRootId);
  if (!root) return null;

  const segments = asset.sourcePath.split(/[\\/]+/).filter(Boolean);
  return join(root.localPath, ...segments);
}
