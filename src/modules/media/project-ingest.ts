import { basename, isAbsolute, relative, resolve } from 'node:path';
import type { IKtepAsset, IMediaRoot, IProjectPharosContext } from '../../protocol/schema.js';
import {
  appendAssets,
  loadIngestRoots,
  loadRuntimeConfig,
  loadProjectBriefConfig,
  markChronologyStale,
  markSpansStale,
  resolveWorkspaceProjectRoot,
  syncProjectBriefMappings,
  touchProjectUpdatedAt,
  type IMergeResult,
} from '../../store/index.js';
import { resolveCaptureTime } from './capture-time.js';
import { resolveEmbeddedGpsBinding } from './gps-embedded.js';
import {
  findManualCaptureTimeOverride,
  loadManualCaptureTimeOverrides,
} from './manual-capture-time.js';
import { refreshProjectDerivedTrackCache } from './project-derived-track.js';
import { probe, type IMediaToolConfig } from './probe.js';
import { resolveProtectionAudioBinding } from './protection-audio.js';
import type { IReverseGeocodeService } from './reverse-geocode.js';
import { resolveMediaRoots, toPortableRelativePath } from './root-resolver.js';
import { scanDirectory } from './scanner.js';
import { prepareRootSameSourceGpsContext, resolveAssetSameSourceGpsBinding } from './same-source-gps.js';
import { enforceProjectTimelineConsistency } from './timeline-consistency.js';
import { loadOrBuildProjectPharosContext } from '../pharos/context.js';
import { assertUniqueRootCodes, assignUniqueMaterialAssetIds, buildMaterialAssetIdForRoot } from './material-ids.js';

export interface IIngestWorkspaceProjectInput {
  workspaceRoot: string;
  projectId: string;
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
  spansMarkedStale: boolean;
  chronologyMarkedStale: boolean;
  warnings: string[];
}

export async function ingestWorkspaceProjectMedia(
  input: IIngestWorkspaceProjectInput,
): Promise<IIngestWorkspaceProjectResult> {
  const projectRoot = resolveWorkspaceProjectRoot(input.workspaceRoot, input.projectId);
  await syncProjectBriefMappings({
    projectId: input.projectId,
    projectRoot,
  });
  const [{ roots }, runtimeConfig, projectBrief] = await Promise.all([
    loadIngestRoots(projectRoot),
    loadRuntimeConfig(projectRoot),
    loadProjectBriefConfig(projectRoot),
  ]);
  const pharosContext = await loadOrBuildProjectPharosContext({
    projectRoot,
    includedTripIds: projectBrief.pharos?.includedTripIds ?? [],
  });
  assertProjectPharosContextReady(pharosContext);
  assertUniqueRootCodes(roots);
  const manualCaptureOverrides = await loadManualCaptureTimeOverrides(projectRoot);

  const resolution = resolveMediaRoots(roots);
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

  const rootById = new Map(roots.map(root => [root.id, root] as const));
  const uniqueIncoming = assignUniqueMaterialAssetIds(
    incoming,
    asset => rootById.get(asset.ingestRootId ?? '')?.rootCode,
  );
  const merge = await appendAssets(projectRoot, uniqueIncoming, {
    replaceRootIds: scannedRoots.map(root => root.rootId),
  });
  await refreshProjectDerivedTrackCache({
    projectRoot,
    resolveTimezoneFromLocation: input.resolveTimezoneFromLocation,
    geocodeLocation: input.geocodeLocation,
    reverseGeocodeService: input.reverseGeocodeService,
  });
  const [staleSpans, staleChronology] = await Promise.all([
    markSpansStale(projectRoot, 'ingest updated assets or spatial inputs; rerun /chronology span-rebuild'),
    markChronologyStale(projectRoot),
  ]);
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
    spansMarkedStale: staleSpans != null,
    chronologyMarkedStale: staleChronology != null,
    warnings: [...warnings],
  };
}

function assertProjectPharosContextReady(
  context: Awaited<ReturnType<typeof loadOrBuildProjectPharosContext>>,
): void {
  if (context.status !== 'failure') return;
  const detail = context.errors.length > 0
    ? context.errors.join('；')
    : 'Pharos context 解析失败。';
  throw new Error(`Pharos 解析失败，已阻塞 Ingest/GPS：${detail}`);
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
  const rawCapture = await resolveCaptureTime(localFilePath, probeResult);
  const manualOverride = findManualCaptureTimeOverride(manualCaptureOverrides, {
    rootRef: root.id,
    sourcePath,
  });
  const rootClockOffsetMs = normalizeClockOffsetMs(root.clockOffsetMs);
  const capture = manualOverride
    ? {
      capturedAt: manualOverride.capturedAt,
      originalValue: `${manualOverride.correctedDate} ${manualOverride.correctedTime}`,
      originalTimezone: manualOverride.timezone,
      source: 'manual' as const,
      confidence: 1,
    }
    : {
      ...rawCapture,
      capturedAt: applyProjectClockOffset(rawCapture.capturedAt, rootClockOffsetMs),
    };
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
    id: buildMaterialAssetIdForRoot({ root, sourcePath }),
    kind,
    sourcePath,
    displayName: sourcePath || basename(localFilePath),
    ingestRootId: root.id,
    durationMs: probeResult.durationMs ?? undefined,
    fps: probeResult.fps ?? undefined,
    width: probeResult.width ?? undefined,
    height: probeResult.height ?? undefined,
    capturedAt: capture.capturedAt,
    rawCapturedAt: rawCapture.capturedAt,
    appliedClockOffsetMs: manualOverride ? 0 : rootClockOffsetMs || undefined,
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

function normalizeClockOffsetMs(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : 0;
}

function applyProjectClockOffset(
  capturedAt: string | undefined,
  clockOffsetMs: number,
): string | undefined {
  if (!capturedAt || clockOffsetMs === 0) return capturedAt;
  const capturedAtMs = Date.parse(capturedAt);
  if (!Number.isFinite(capturedAtMs)) return capturedAt;
  return new Date(capturedAtMs + clockOffsetMs).toISOString();
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
      displayWidth: null,
      displayHeight: null,
      rotationDegrees: null,
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
