import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import type { ICaptureTime, IKtepAsset, IMediaRoot, IProtectionAudioBinding } from '../../protocol/schema.js';
import {
  appendAssets,
  loadIngestRoots,
  loadAssets,
  loadColorTransformPresetsConfig,
  loadRuntimeConfig,
  loadProjectBriefConfig,
  markChronologyStale,
  markSpansStale,
  resolveWorkspaceProjectRoot,
  syncProjectBriefMappings,
  touchProjectUpdatedAt,
  writeJson,
  type IMergeResult,
} from '../../store/index.js';
import { resolveCaptureTime } from './capture-time.js';
import { mapWithConcurrency } from './concurrency.js';
import { createIngestProbeCache, type IIngestMetadataStats } from './ingest-probe-cache.js';
import { createIngestProgressReporter } from './ingest-progress.js';
import { resolveEmbeddedGpsBinding } from './gps-embedded.js';
import {
  findManualCaptureTimeOverride,
  loadManualCaptureTimeOverrides,
} from './manual-capture-time.js';
import { refreshProjectDerivedTrackCache } from './project-derived-track.js';
import { probe, type IMediaToolConfig, type IProbeResult } from './probe.js';
import { resolveProtectionAudioBinding } from './protection-audio.js';
import type { IReverseGeocodeService } from './reverse-geocode.js';
import { resolveMediaRoot, resolveMediaRoots, toPortableRelativePath } from './root-resolver.js';
import { assetAnalysisDependency, buildAnalysisInput, materialVersionKey, registerMediaVersion, type MediaRole } from './media-versions.js';
import { scanDirectory, type IScannedFile } from './scanner.js';
import { prepareRootSameSourceGpsContext, resolveAssetSameSourceGpsBinding } from './same-source-gps.js';
import { enforceProjectTimelineConsistency } from './timeline-consistency.js';
import { loadOrBuildProjectPharosContext } from '../pharos/context.js';
import { refreshColorInputs } from '../../store/color-inputs.js';
import { assertUniqueRootCodes, assignUniqueMaterialAssetIds, buildMaterialAssetIdForRoot } from './material-ids.js';

export interface IIngestWorkspaceProjectInput {
  workspaceRoot: string;
  projectId: string;
  jobId?: string;
  progressPath?: string;
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
  metadata: IIngestMetadataStats;
  versionChanges: Array<{ assetId: string; role: MediaRole; change: 'added' | 'removed' | 'content' | 'stat' | 'availability' | 'profile' }>;
  spansMarkedStale: boolean;
  chronologyMarkedStale: boolean;
  warnings: string[];
}

export async function ingestWorkspaceProjectMedia(
  input: IIngestWorkspaceProjectInput,
): Promise<IIngestWorkspaceProjectResult> {
  const projectRoot = resolveWorkspaceProjectRoot(input.workspaceRoot, input.projectId);
  const progress = createIngestProgressReporter(projectRoot, input.jobId, input.progressPath);
  try {
    return await runProjectIngest(input, projectRoot, progress);
  } catch (error) {
    await progress.fail(error).catch(() => undefined);
    throw error;
  }
}

async function runProjectIngest(
  input: IIngestWorkspaceProjectInput,
  projectRoot: string,
  progress: ReturnType<typeof createIngestProgressReporter>,
): Promise<IIngestWorkspaceProjectResult> {
  let scannedFileCount = 0;
  let processedFileCount = 0;
  let boundFileCount = 0;
  let metadataStats: IIngestMetadataStats = { probedFileCount: 0, reusedFileCount: 0, failedFileCount: 0 };
  let rootContext: Record<string, unknown> = {};
  const counts = () => ({ ...metadataStats, scannedFileCount, processedFileCount, boundFileCount, ...rootContext });
  await progress.report({ phaseKey: 'prepare', phaseLabel: '读取项目配置', extra: counts() }, true);
  await syncProjectBriefMappings({
    projectId: input.projectId,
    projectRoot,
  });
  const [{ roots }, runtimeConfig, projectBrief] = await Promise.all([
    loadIngestRoots(projectRoot),
    loadRuntimeConfig(projectRoot),
    loadProjectBriefConfig(projectRoot),
  ]);
  await progress.report({ phaseKey: 'context', phaseLabel: '读取行程上下文', extra: counts() }, true);
  const pharosContext = await loadOrBuildProjectPharosContext({
    projectRoot,
    includedTripIds: projectBrief.pharos?.includedTripIds ?? [],
  });
  assertProjectPharosContextReady(pharosContext);
  assertUniqueRootCodes(roots);
  const manualCaptureOverrides = await loadManualCaptureTimeOverrides(projectRoot);

  const existingAssets = await loadAssets(projectRoot);
  const transforms = await loadColorTransformPresetsConfig(input.workspaceRoot);
  const rootResolutions = roots.filter(root => root.enabled).map(resolveMediaRoot);
  const resolution = {
    resolved: rootResolutions.filter(root => root.localPath || root.rawLocalPath),
    missing: rootResolutions.filter(root => !root.localPath && !root.rawLocalPath).map(item => item.root),
  };
  const scannedRoots: IIngestedRootSummary[] = [];
  const incoming: IKtepAsset[] = [];
  const warnings = new Set<string>();
  const metadataCache = createIngestProbeCache(projectRoot, runtimeConfig, warning => warnings.add(warning));
  metadataStats = metadataCache.stats;

  for (const [rootIndex, resolvedRoot] of resolution.resolved.entries()) {
    rootContext = {
      rootId: resolvedRoot.root.id,
      rootLabel: resolvedRoot.root.label || resolvedRoot.root.rootCode || basename(resolvedRoot.localPath ?? resolvedRoot.rawLocalPath!),
      rootIndex: rootIndex + 1, rootTotal: resolution.resolved.length,
    };
    await progress.report({ phaseKey: 'root-gps', phaseLabel: '准备同源 GPS', extra: counts() }, true);
    const preparedRootGps = await prepareRootSameSourceGpsContext({
      projectRoot,
      flightRecordPath: resolvedRoot.flightRecordPath,
      djiOpenAPIKey: runtimeConfig.djiOpenAPIKey,
    });
    for (const warning of preparedRootGps.warnings) {
      warnings.add(warning);
    }

    let rootScanned = 0;
    const scanProgress = (fileName: string) => progress.report({
      phaseKey: 'scan', phaseLabel: '扫描素材', current: rootScanned, unit: '个素材',
      fileName, extra: counts(),
    });
    await progress.report({ phaseKey: 'scan', phaseLabel: '扫描素材', current: 0, unit: '个素材', extra: counts() }, true);
    const previousByKey = new Map(existingAssets.filter(asset => asset.ingestRootId === resolvedRoot.root.id)
      .map(asset => [materialVersionKey(asset.kind, asset.sourcePath), asset]));
    const pairs = new Map<string, { kind: IKtepAsset['kind']; versions: NonNullable<IKtepAsset['mediaVersions']>; files: Partial<Record<MediaRole, IScannedFile>>; previous?: IKtepAsset }>();
    // Preserve records belonging to an offline role, without pretending those bytes are available.
    for (const [key, previous] of previousByKey) {
      const versions: NonNullable<IKtepAsset['mediaVersions']> = {};
      for (const role of ['target', 'raw'] as const) {
        if (role === 'target' ? resolvedRoot.localPath : resolvedRoot.rawLocalPath) continue;
        const version = previous.mediaVersions?.[role];
        if (version) versions[role] = { ...version, available: false };
      }
      if (Object.keys(versions).length) pairs.set(key, { kind: previous.kind, versions, files: {}, previous });
    }
    for (const role of ['target', 'raw'] as const) {
      const basePath = role === 'target' ? resolvedRoot.localPath : resolvedRoot.rawLocalPath;
      if (!basePath) continue;
      const scanned = (await scanDirectory(basePath, {
        strict: true,
        excludeSubtrees: [
          ...resolveNestedRawExclusions(basePath, role === 'target' ? resolvedRoot.rawLocalPath : resolvedRoot.localPath),
          ...(projectBrief.extraMedia ? [resolveMediaRoot({ ...projectBrief.extraMedia, id: projectBrief.extraMedia.rootId || 'extra', enabled: true }).localPath].filter((path): path is string => Boolean(path)) : []),
        ],
        onDirectory: directory => scanProgress(`${role}/${toPortableRelativePath(basePath, directory)}`),
        onFile: file => {
          if (file.kind === 'audio') return;
          rootScanned++; scannedFileCount++;
          return scanProgress(`${role}/${toPortableRelativePath(basePath, file.path)}`);
        },
      })).filter(file => file.kind !== 'audio');
      for (const file of scanned) {
        const relativePath = toPortableRelativePath(basePath, file.path);
        const key = materialVersionKey(file.kind, relativePath);
        const previous = previousByKey.get(key);
        const pair = pairs.get(key) ?? { kind: file.kind, versions: {}, files: {}, previous };
        if (pair.files[role]) throw new Error(`同一素材的 ${role} 存在重名冲突：${relativePath}`);
        pair.files[role] = file;
        pairs.set(key, pair);
      }
    }
    const files: Array<IScannedFile & { basePath: string; pair: (typeof pairs extends Map<string, infer P> ? P : never) }> = [];
    // A legacy target-only index has no version hash to migrate while its target
    // directory is offline. Preserve it until those bytes are available to register.
    if (!resolvedRoot.localPath) {
      for (const [key, previous] of previousByKey) {
        if (!previous.mediaVersions && !pairs.has(key)) incoming.push(previous);
      }
    }
    for (const pair of pairs.values()) {
      const selectedRole = pair.files.target ? 'target' : pair.files.raw ? 'raw' : undefined;
      if (!selectedRole) {
        if (pair.previous) incoming.push({ ...pair.previous, mediaVersions: pair.versions, analysisInput: undefined });
        continue;
      }
      files.push({ ...pair.files[selectedRole]!, basePath: (selectedRole === 'target' ? resolvedRoot.localPath : resolvedRoot.rawLocalPath)!, pair });
    }
    scannedRoots.push({
      rootId: resolvedRoot.root.id,
      label: resolvedRoot.root.label,
      localPath: resolvedRoot.localPath ?? resolvedRoot.rawLocalPath!,
      scannedFileCount: files.length,
    });

    // Only independent reads run in parallel; GPS index updates below remain ordered.
    let metadataCompleted = 0;
    const activeFiles = new Set<string>();
    const metadataProgress = () => progress.report({
      phaseKey: 'metadata', phaseLabel: '读取素材元数据', current: metadataCompleted, total: files.length,
      unit: '个素材', fileName: activeFiles.values().next().value,
      extra: { ...counts(), activeFileCount: activeFiles.size },
    });
    await progress.report({ phaseKey: 'metadata', phaseLabel: '读取素材元数据', current: 0, total: files.length,
      unit: '个素材', extra: counts() }, true);
    const metadata = await mapWithConcurrency(files, 4, async file => {
      const fileName = toPortableRelativePath(file.basePath, file.path);
      activeFiles.add(fileName);
      await metadataProgress();
      for (const role of ['target', 'raw'] as const) {
        const versionFile = file.pair.files[role];
        if (!versionFile) continue;
        const basePath = (role === 'target' ? resolvedRoot.localPath : resolvedRoot.rawLocalPath)!;
        file.pair.versions[role] = await registerMediaVersion(versionFile.path, toPortableRelativePath(basePath, versionFile.path), role, resolvedRoot.root, file.pair.previous?.mediaVersions?.[role]);
      }
      const probeResult = await safeProbe(file.path, runtimeConfig, metadataCache.probe);
      const rawCapture = await resolveCaptureTime(file.path, probeResult);
      const protectionAudio = file.kind === 'video'
        ? await resolveProtectionAudioBinding({
          localPath: file.path,
          localRootPath: file.basePath,
          sourceRole: file.pair.files.target ? 'target' : 'raw',
          previousBinding: file.pair.previous?.protectionAudio,
          assetDurationMs: probeResult.durationMs ?? undefined,
          tools: runtimeConfig,
          probeMedia: metadataCache.probe,
        })
        : null;
      metadataCompleted++;
      processedFileCount++;
      activeFiles.delete(fileName);
      await metadataProgress();
      return { probeResult, rawCapture, protectionAudio };
    });
    await progress.report({ phaseKey: 'bind', phaseLabel: '更新拍摄时间与 GPS 绑定', current: 0, total: files.length,
      unit: '个素材', extra: counts() }, true);
    for (const [index, file] of files.entries()) {
      const fileName = toPortableRelativePath(file.basePath, file.path);
      await progress.report({ phaseKey: 'bind', phaseLabel: '更新拍摄时间与 GPS 绑定', current: index,
        total: files.length, unit: '个素材', fileName, extra: counts() });
      const asset = await buildAssetFromScan(
        projectRoot,
        file.path,
        file.kind,
        file.sizeBytes,
        resolvedRoot.root,
        file.basePath,
        metadata[index]!,
        manualCaptureOverrides,
        preparedRootGps,
        warning => warnings.add(warning),
        [file.pair.previous?.sourcePath, ...Object.values(file.pair.versions).map(version => version.relativePath)].filter((value): value is string => Boolean(value)),
      );
      asset.mediaVersions = file.pair.versions;
      asset.analysisInput = await buildAnalysisInput(asset, resolvedRoot.root, input.workspaceRoot, transforms);
      if (file.pair.previous) asset.id = file.pair.previous.id;
      incoming.push(asset);
      boundFileCount++;
      await progress.report({ phaseKey: 'bind', phaseLabel: '更新拍摄时间与 GPS 绑定', current: index + 1,
        total: files.length, unit: '个素材', fileName, extra: counts() });
    }
  }

  rootContext = {};
  await progress.report({ phaseKey: 'write', phaseLabel: '写入素材索引', extra: counts() }, true);
  const rootById = new Map(roots.map(root => [root.id, root] as const));
  const uniqueIncoming = assignUniqueMaterialAssetIds(
    incoming,
    asset => rootById.get(asset.ingestRootId ?? '')?.rootCode,
  );
  const merge = await appendAssets(projectRoot, uniqueIncoming, {
    replaceRootIds: scannedRoots.map(root => root.rootId),
  });
  await refreshColorInputs(projectRoot);
  const previousById = new Map(existingAssets.map(asset => [asset.id, asset]));
  const nextById = new Map(merge.assets.map(asset => [asset.id, asset]));
  const versionChanges: IIngestWorkspaceProjectResult['versionChanges'] = [];
  for (const assetId of new Set([...previousById.keys(), ...nextById.keys()])) {
    for (const role of ['target', 'raw'] as const) {
      const before = previousById.get(assetId)?.mediaVersions?.[role];
      const after = nextById.get(assetId)?.mediaVersions?.[role];
      const change = !before && after ? 'added' : before && !after ? 'removed'
        : before && after ? before.contentHash !== after.contentHash ? 'content'
          : before.sourceProfile !== after.sourceProfile || before.colorPrimaries !== after.colorPrimaries || before.transferFunction !== after.transferFunction ? 'profile'
          : before.available !== after.available ? 'availability'
          : before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs ? 'stat' : undefined
        : undefined;
      if (change) versionChanges.push({ assetId, role, change });
    }
  }
  await writeJson(join(projectRoot, '.tmp', 'ingest', 'versions.json'), { jobId: input.jobId, updatedAt: new Date().toISOString(), changes: versionChanges });
  await progress.report({ phaseKey: 'gps', phaseLabel: '刷新空间缓存', extra: counts() }, true);
  await refreshProjectDerivedTrackCache({
    projectRoot,
    resolveTimezoneFromLocation: input.resolveTimezoneFromLocation,
    geocodeLocation: input.geocodeLocation,
    reverseGeocodeService: input.reverseGeocodeService,
  });
  const previousDependencies = new Map(existingAssets.map(asset => [asset.id, assetAnalysisDependency(asset)]));
  const dependenciesChanged = merge.pruned.length > 0 || merge.assets.some(asset => previousDependencies.get(asset.id) !== assetAnalysisDependency(asset));
  const [staleSpans, staleChronology] = dependenciesChanged ? await Promise.all([
    markSpansStale(projectRoot, 'ingest changed analysis or spatial inputs; rerun Analyze and /chronology span-rebuild'),
    markChronologyStale(projectRoot),
  ]) : [null, null];
  await touchProjectUpdatedAt(projectRoot);
  await progress.report({ phaseKey: 'validate', phaseLabel: '校验素材时间', extra: counts() }, true);
  await enforceProjectTimelineConsistency({
    projectRoot,
    assets: merge.assets,
    roots,
  });

  await progress.report({ status: 'succeeded', phaseKey: 'complete', phaseLabel: '导入完成',
    current: incoming.length, total: incoming.length, unit: '个素材',
    extra: { ...counts(), addedCount: merge.added.length, prunedCount: merge.pruned.length,
      versionContentChangedCount: versionChanges.filter(change => change.change === 'content').length,
      versionStatOnlyChangedCount: versionChanges.filter(change => change.change === 'stat').length,
      assetCount: merge.assets.length, missingRootCount: resolution.missing.length, warningCount: warnings.size },
  }, true);
  return {
    projectRoot,
    scannedRoots,
    missingRoots: resolution.missing,
    merge,
    metadata: { ...metadataCache.stats },
    versionChanges,
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
  metadata: {
    probeResult: IProbeResult;
    rawCapture: ICaptureTime;
    protectionAudio: IProtectionAudioBinding | null;
  },
  manualCaptureOverrides: Awaited<ReturnType<typeof loadManualCaptureTimeOverrides>>,
  preparedRootGps: Awaited<ReturnType<typeof prepareRootSameSourceGpsContext>>,
  onWarning: (warning: string) => void,
  sourceAliases: string[] = [],
): Promise<IKtepAsset> {
  const sourcePath = toPortableRelativePath(localRootPath, localFilePath);
  const { probeResult, rawCapture, protectionAudio } = metadata;
  const manualOverrides = [...new Set([sourcePath, ...sourceAliases])].map(path => findManualCaptureTimeOverride(manualCaptureOverrides, { rootRef: root.id, sourcePath: path })).filter(Boolean);
  if (new Set(manualOverrides.map(row => row!.capturedAt)).size > 1) throw new Error(`同一素材 raw/target 的人工拍摄时间冲突：${sourcePath}`);
  const manualOverride = manualOverrides[0];
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
      displayWidth: probeResult.displayWidth,
      displayHeight: probeResult.displayHeight,
      rotationDegrees: probeResult.rotationDegrees,
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
  probeMedia: typeof probe,
): Promise<Awaited<ReturnType<typeof probe>>> {
  try {
    return await probeMedia(filePath, tools);
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
