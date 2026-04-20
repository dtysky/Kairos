import { randomUUID } from 'node:crypto';
import { basename, isAbsolute, relative, resolve } from 'node:path';
import type { IKtepAsset, IMediaRoot } from '../../protocol/schema.js';
import {
  appendAssets,
  loadAssetReports,
  loadProjectDeviceMediaMaps,
  loadIngestRoots,
  loadRuntimeConfig,
  loadChronology,
  loadAssets,
  resolveWorkspaceProjectRoot,
  syncProjectBriefMappings,
  touchProjectUpdatedAt,
  writeChronology,
  type IMergeResult,
} from '../../store/index.js';
import { resolveCaptureTime } from './capture-time.js';
import { buildMediaChronology } from './chronology.js';
import { resolveEmbeddedGpsBinding } from './gps-embedded.js';
import {
  findManualCaptureTimeOverride,
  loadManualCaptureTimeOverrides,
} from './manual-capture-time.js';
import { refreshProjectDerivedTrackCache } from './project-derived-track.js';
import { probe, type IMediaToolConfig } from './probe.js';
import { resolveProtectionAudioBinding } from './protection-audio.js';
import type { IReverseGeocodeService } from './reverse-geocode.js';
import { resolveMediaRootsForDevice, toPortableRelativePath } from './root-resolver.js';
import { scanDirectory } from './scanner.js';
import { prepareRootSameSourceGpsContext, resolveAssetSameSourceGpsBinding } from './same-source-gps.js';
import { enforceProjectTimelineConsistency } from './timeline-consistency.js';

export interface IIngestWorkspaceProjectInput {
  workspaceRoot: string;
  projectId: string;
  deviceMapPath?: string;
  resolveTimezoneFromLocation?: (location: string) => Promise<string | null>;
  geocodeLocation?: (location: string) => Promise<{ lat: number; lng: number } | null>;
  reverseGeocodeService?: IReverseGeocodeService | null;
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
  warnings: string[];
}

export async function ingestWorkspaceProjectMedia(
  input: IIngestWorkspaceProjectInput,
): Promise<IIngestWorkspaceProjectResult> {
  const projectRoot = resolveWorkspaceProjectRoot(input.workspaceRoot, input.projectId);
  await syncProjectBriefMappings({
    projectId: input.projectId,
    projectRoot,
    deviceMapPath: input.deviceMapPath,
  });
  const [{ roots }, deviceMaps, runtimeConfig] = await Promise.all([
    loadIngestRoots(projectRoot),
    loadProjectDeviceMediaMaps(projectRoot, input.deviceMapPath),
    loadRuntimeConfig(projectRoot),
  ]);
  const manualCaptureOverrides = await loadManualCaptureTimeOverrides(projectRoot);

  const resolution = resolveMediaRootsForDevice(input.projectId, roots, deviceMaps);
  const scannedRoots: IIngestedRootSummary[] = [];
  const incoming: IKtepAsset[] = [];
  const warnings = new Set<string>();

  for (const resolvedRoot of resolution.resolved) {
    const preparedRootGps = await prepareRootSameSourceGpsContext({
      projectRoot,
      flightRecordPath: resolvedRoot.flightRecordPath,
      djiOpenAPIKey: runtimeConfig.djiOpenAPIKey,
    });
    for (const warning of preparedRootGps.warnings) {
      warnings.add(warning);
    }

    const files = (await scanDirectory(resolvedRoot.localPath, {
      excludeSubtrees: resolveNestedRawExclusions(
        resolvedRoot.localPath,
        resolvedRoot.rawLocalPath,
      ),
    }))
      .filter(file => file.kind !== 'audio');
    scannedRoots.push({
      rootId: resolvedRoot.root.id,
      label: resolvedRoot.root.label,
      localPath: resolvedRoot.localPath,
      scannedFileCount: files.length,
    });

    for (const file of files) {
      incoming.push(await buildAssetFromScan(
        projectRoot,
        file.path,
        file.kind,
        file.sizeBytes,
        resolvedRoot.root,
        resolvedRoot.localPath,
        runtimeConfig,
        manualCaptureOverrides,
        preparedRootGps,
        warning => warnings.add(warning),
      ));
    }
  }

  const merge = await appendAssets(projectRoot, incoming);
  await refreshProjectDerivedTrackCache({
    projectRoot,
    resolveTimezoneFromLocation: input.resolveTimezoneFromLocation,
    geocodeLocation: input.geocodeLocation,
    reverseGeocodeService: input.reverseGeocodeService,
  });
  const chronologyCount = await refreshProjectChronology(projectRoot);
  await touchProjectUpdatedAt(projectRoot);
  await enforceProjectTimelineConsistency({
    projectRoot,
    assets: merge.assets,
    roots,
  });

  return {
    projectRoot,
    scannedRoots,
    missingRoots: resolution.missing,
    merge,
    chronologyCount,
    warnings: [...warnings],
  };
}

async function buildAssetFromScan(
  projectRoot: string,
  localFilePath: string,
  kind: IKtepAsset['kind'],
  sizeBytes: number,
  root: IMediaRoot,
  localRootPath: string,
  tools: IMediaToolConfig,
  manualCaptureOverrides: Awaited<ReturnType<typeof loadManualCaptureTimeOverrides>>,
  preparedRootGps: Awaited<ReturnType<typeof prepareRootSameSourceGpsContext>>,
  onWarning: (warning: string) => void,
): Promise<IKtepAsset> {
  const sourcePath = toPortableRelativePath(localRootPath, localFilePath);
  const probeResult = await safeProbe(localFilePath, tools);
  const manualOverride = findManualCaptureTimeOverride(manualCaptureOverrides, {
    rootRef: root.id,
    sourcePath,
  });
  const capture = manualOverride
    ? {
      capturedAt: manualOverride.capturedAt,
      originalValue: `${manualOverride.correctedDate} ${manualOverride.correctedTime}`,
      originalTimezone: manualOverride.timezone,
      source: 'manual' as const,
      confidence: 1,
    }
    : await resolveCaptureTime(localFilePath, probeResult);
  const metadataGps = kind === 'photo'
    ? resolveEmbeddedGpsBinding({
      capturedAt: capture.capturedAt,
      metadata: { rawTags: probeResult.rawTags },
    })
    : null;
  const sameSourceGps = metadataGps
    ? { binding: null, warnings: [] as string[] }
    : await resolveAssetSameSourceGpsBinding({
      projectRoot,
      trackIdentityKey: `${root.id}:${sourcePath}`,
      asset: {
        kind,
        capturedAt: capture.capturedAt,
        durationMs: probeResult.durationMs ?? undefined,
        displayName: sourcePath || basename(localFilePath),
        sourcePath,
      },
      localPath: localFilePath,
      preparedRootGps,
    });
  for (const warning of sameSourceGps.warnings) {
    onWarning(warning);
  }

  const protectionAudio = kind === 'video'
    ? await resolveProtectionAudioBinding({
      localPath: localFilePath,
      localRootPath,
      assetDurationMs: probeResult.durationMs ?? undefined,
      tools,
    })
    : null;

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
    embeddedGps: metadataGps ?? sameSourceGps.binding ?? undefined,
    protectionAudio: protectionAudio ?? undefined,
    metadata: {
      sizeBytes,
      rootLabel: root.label,
      rootDescription: root.description,
      rootNotes: root.notes,
      captureOriginalValue: capture.originalValue,
      hasAudioStream: probeResult.hasAudioStream,
      audioStreamCount: probeResult.audioStreamCount,
      audioCodec: probeResult.audioCodec,
      audioSampleRate: probeResult.audioSampleRate,
      audioChannels: probeResult.audioChannels,
      audioBitRate: probeResult.audioBitRate,
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
      hasAudioStream: false,
      audioStreamCount: 0,
      audioCodec: null,
      audioSampleRate: null,
      audioChannels: null,
      audioBitRate: null,
      creationTime: null,
      rawTags: {},
    };
  }
}

async function refreshProjectChronology(projectRoot: string): Promise<number> {
  const [assets, reports, existing, { roots }] = await Promise.all([
    loadAssets(projectRoot),
    loadAssetReports(projectRoot),
    loadChronology(projectRoot),
    loadIngestRoots(projectRoot),
  ]);
  const chronology = buildMediaChronology(assets, reports, existing, roots);
  await writeChronology(projectRoot, chronology);
  return chronology.length;
}

function resolveNestedRawExclusions(
  localPath: string,
  rawLocalPath?: string,
): string[] {
  if (!rawLocalPath?.trim()) {
    return [];
  }

  const currentRoot = resolve(localPath);
  const rawRoot = resolve(rawLocalPath);
  const rel = relative(currentRoot, rawRoot);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    return [];
  }

  return [rawRoot];
}
