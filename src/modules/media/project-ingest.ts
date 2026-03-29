import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import type { IKtepAsset, IMediaRoot } from '../../protocol/schema.js';
import {
  appendAssets,
  loadAssetReports,
  loadDeviceMediaMaps,
  loadIngestRoots,
  loadRuntimeConfig,
  loadChronology,
  loadAssets,
  resolveWorkspaceProjectRoot,
  touchProjectUpdatedAt,
  writeChronology,
  type IMergeResult,
} from '../../store/index.js';
import { resolveCaptureTime } from './capture-time.js';
import { buildMediaChronology } from './chronology.js';
import { probe, type IMediaToolConfig } from './probe.js';
import { resolveMediaRootsForDevice, toPortableRelativePath } from './root-resolver.js';
import { scanDirectory } from './scanner.js';

export interface IIngestWorkspaceProjectInput {
  workspaceRoot: string;
  projectId: string;
  deviceMapPath?: string;
}

export interface IIngestedRootSummary {
  rootId: string;
  label?: string;
  localPath: string;
  scannedFileCount: number;
}

export interface IIngestWorkspaceProjectResult {
  projectRoot: string;
  scannedRoots: IIngestedRootSummary[];
  missingRoots: IMediaRoot[];
  merge: IMergeResult;
  chronologyCount: number;
}

export async function ingestWorkspaceProjectMedia(
  input: IIngestWorkspaceProjectInput,
): Promise<IIngestWorkspaceProjectResult> {
  const projectRoot = resolveWorkspaceProjectRoot(input.workspaceRoot, input.projectId);
  const [{ roots }, deviceMaps, runtimeConfig] = await Promise.all([
    loadIngestRoots(projectRoot),
    loadDeviceMediaMaps(input.deviceMapPath),
    loadRuntimeConfig(projectRoot),
  ]);

  const resolution = resolveMediaRootsForDevice(input.projectId, roots, deviceMaps);
  const scannedRoots: IIngestedRootSummary[] = [];
  const incoming: IKtepAsset[] = [];

  for (const resolvedRoot of resolution.resolved) {
    const files = (await scanDirectory(resolvedRoot.localPath))
      .filter(file => file.kind !== 'audio');
    scannedRoots.push({
      rootId: resolvedRoot.root.id,
      label: resolvedRoot.root.label,
      localPath: resolvedRoot.localPath,
      scannedFileCount: files.length,
    });

    for (const file of files) {
      incoming.push(await buildAssetFromScan(
        file.path,
        file.kind,
        file.sizeBytes,
        resolvedRoot.root,
        resolvedRoot.localPath,
        runtimeConfig,
      ));
    }
  }

  const merge = await appendAssets(projectRoot, incoming);
  const chronologyCount = await refreshProjectChronology(projectRoot);
  await touchProjectUpdatedAt(projectRoot);

  return {
    projectRoot,
    scannedRoots,
    missingRoots: resolution.missing,
    merge,
    chronologyCount,
  };
}

async function buildAssetFromScan(
  localFilePath: string,
  kind: IKtepAsset['kind'],
  sizeBytes: number,
  root: IMediaRoot,
  localRootPath: string,
  tools: IMediaToolConfig,
): Promise<IKtepAsset> {
  const sourcePath = toPortableRelativePath(localRootPath, localFilePath);
  const probeResult = await safeProbe(localFilePath, tools);
  const capture = await resolveCaptureTime(
    localFilePath,
    probeResult,
    root.defaultTimezone,
  );

  return {
    id: randomUUID(),
    kind,
    sourcePath,
    displayName: sourcePath || basename(localFilePath),
    ingestRootId: root.id,
    durationMs: probeResult.durationMs ?? undefined,
    fps: probeResult.fps ?? undefined,
    width: probeResult.width ?? undefined,
    height: probeResult.height ?? undefined,
    capturedAt: capture.capturedAt,
    captureTimeSource: capture.source,
    captureTimeConfidence: capture.confidence,
    createdAt: capture.capturedAt,
    metadata: {
      sizeBytes,
      rootLabel: root.label,
      rootDescription: root.description,
      rootNotes: root.notes,
      rawTags: probeResult.rawTags,
    },
  };
}

async function safeProbe(
  filePath: string,
  tools: IMediaToolConfig,
): Promise<Awaited<ReturnType<typeof probe>>> {
  try {
    return await probe(filePath, tools);
  } catch {
    return {
      durationMs: null,
      width: null,
      height: null,
      fps: null,
      codec: null,
      creationTime: null,
      rawTags: {},
    };
  }
}

async function refreshProjectChronology(projectRoot: string): Promise<number> {
  const [assets, reports, existing] = await Promise.all([
    loadAssets(projectRoot),
    loadAssetReports(projectRoot),
    loadChronology(projectRoot),
  ]);
  const chronology = buildMediaChronology(assets, reports, existing);
  await writeChronology(projectRoot, chronology);
  return chronology.length;
}
