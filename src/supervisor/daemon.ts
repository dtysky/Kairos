import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, mkdir, readFile, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { summarizeSpanMaterialPatternIntegrity } from '../protocol/material-pattern-integrity.js';
import {
  getProjectProgressPath,
  getWorkspaceStyleAnalysisProgressPath,
  loadAssets,
  loadColorArchiveViews,
  loadChronologyReviewState,
  loadChronologyEventConsolidationState,
  loadSpans,
  loadSpansMeta,
  loadColorGroupsSnapshots,
  loadColorCurrent,
  loadColorResolveProjectMap,
  loadColorTransformPresetsConfig,
  loadIngestRoots,
  loadEditRulesConfig,
  loadEditUnitConfig,
  loadEditFlowRunRecords,
  loadEditResolveProjectMap,
  loadProject,
  listWorkspaceProjects,
  loadManualItineraryConfig,
  normalizeEditId,
  loadProjectBriefConfig,
  loadReviewQueue,
  loadScriptBriefConfig,
  saveColorCurrent,
  saveIngestRoots,
  resolveReviewItem,
  saveReviewQueue,
  saveManualItineraryConfig,
  loadStyleSourcesConfig,
  loadTranscriptGlossary,
  loadWorkspaceAsrConfig,
  saveProjectBriefConfig,
  saveScriptBriefConfig,
  saveEditUnitConfig,
  saveEditRulesConfig,
  saveStyleSourcesConfig,
  saveTranscriptGlossary,
  saveWorkspaceAsrConfig,
  syncWorkspaceProjectBrief,
  touchProjectUpdatedAt,
  writeKairosProgress,
  markChronologyStale,
  markSpansStale,
  confirmChronology,
  updateChronologyEvent,
  mergeChronologyEvents,
  splitChronologyEvent,
} from '../store/index.js';
import {
  CEDIT_FLOW_CAPABILITY_CATALOG,
  loadEditFlowPlanReadOnly,
} from '../modules/edit-flow/index.js';
import {
  isLayeredStyleProfile,
  loadStyleByCategory,
} from '../modules/script/style-loader.js';
import {
  buildColorWorkspaceState,
  inspectResolveColorBackend,
  preflightProjectColorHost,
  previewProjectColorOverwrite,
  registerExternalColorDrpSnapshot,
  snapshotProjectColorDrp,
} from '../modules/color/index.js';
import {
  deriveResolveRoughCutProjectName,
  registerExternalEditDrpSnapshot,
  relinkProjectEditMedia,
  resolveLatestEditDrpSnapshot,
  snapshotProjectEditDrp,
} from '../modules/timeline-core/index.js';
import {
  getResolveAssetsStatus,
  installResolveAssets,
} from '../modules/resolve-assets/index.js';
import {
  resolveMediaRoot,
  type IMediaRootPathResolution,
} from '../modules/media/root-resolver.js';
import {
  commitProjectSpeechTranscriptReview,
  loadCurrentSpeechTranscriptReview,
  resolveTranscriptCorrectionReview,
  saveProjectSpeechTranscriptReviewDraft,
} from '../modules/media/transcript-review.js';
import { prepareProjectSpeechReviewAudio } from '../modules/media/speech-review-audio.js';
import {
  buildProjectPharosAssetStatus,
  loadOrBuildProjectPharosContext,
} from '../modules/pharos/context.js';
import {
  buildResolveVolcVoiceoverConfigSummaryTsv,
  errorToTsv,
  startResolveVolcVoiceoverIpcServer,
  synthesizeResolveVolcVoiceoverTsv,
  type IResolveVoiceoverJobInput,
} from '../modules/voiceover/index.js';
import { getMlServiceStatus, startMlService, stopMlService } from './runtime.js';
import type { IKtepAsset, IProjectChronology, IMediaRoot } from '../protocol/schema.js';
import {
  getSupervisorJobRoot,
  listJobRecords,
  loadJobRecord,
  progressBelongsToSupervisorJob,
  writeJobRecord,
  writeServiceRecord,
  type ISupervisorJobRecord,
  type ISupervisorServiceRecord,
  type TSupervisorExecutionMode,
} from './state.js';
import { buildAnalyzeMonitorModel, buildStyleMonitorModel } from './monitor-model.js';

interface IDaemonOptions {
  workspaceRoot: string;
  port: number;
}

async function main(): Promise<void> {
  const options = parseDaemonOptions(process.argv.slice(2));
  await ensureDashboardServiceRecord(options.workspaceRoot, options.port);
  await startResolveVolcVoiceoverIpcServer({ workspaceRoot: options.workspaceRoot });

  const server = createServer(async (request, response) => {
    try {
      await routeRequest(options, request, response);
    } catch (error) {
      sendJson(response, 500, serializeApiError(error));
    }
  });

  server.listen(options.port, '127.0.0.1');
}

function parseDaemonOptions(argv: string[]): IDaemonOptions {
  const args = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const part = argv[index];
    if (!part.startsWith('--')) continue;
    const key = part.slice(2);
    const value = argv[index + 1] && !argv[index + 1].startsWith('--')
      ? argv[index + 1]
      : 'true';
    args.set(key, value);
    if (value !== 'true') index += 1;
  }

  return {
    workspaceRoot: args.get('workspaceRoot') ?? process.cwd(),
    port: Number(args.get('port') ?? 8940),
  };
}

async function ensureDashboardServiceRecord(workspaceRoot: string, port: number): Promise<void> {
  const record: ISupervisorServiceRecord = {
    name: 'dashboard',
    status: 'running',
    port,
    url: `http://127.0.0.1:${port}/`,
    launcherPid: process.pid,
    listenerPid: process.pid,
    command: [process.execPath, new URL('./daemon.js', import.meta.url).pathname],
    cwd: workspaceRoot,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await writeServiceRecord(workspaceRoot, record);
}

async function routeRequest(
  options: IDaemonOptions,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const method = request.method ?? 'GET';
  const url = new URL(request.url ?? '/', `http://127.0.0.1:${options.port}`);
  const pathname = url.pathname;

  if (pathname === '/api/status' && method === 'GET') {
    await reconcileInterruptedJobs(options.workspaceRoot);
    const [projects, jobs, ml] = await Promise.all([
      listWorkspaceProjects(options.workspaceRoot),
      loadJobsWithProgress(options.workspaceRoot),
      getMlServiceStatus(options.workspaceRoot),
    ]);
    sendJson(response, 200, {
      workspaceRoot: options.workspaceRoot,
      services: [
        {
          name: 'dashboard',
          status: 'running',
          port: options.port,
          url: `http://127.0.0.1:${options.port}/`,
          listenerPid: process.pid,
        },
        ml,
      ],
      projects,
      jobs,
    });
    return;
  }

  if (pathname === '/api/resolve-volc-voiceover/config-summary.tsv' && method === 'GET') {
    try {
      sendText(response, 200, await buildResolveVolcVoiceoverConfigSummaryTsv({
        workspaceRoot: options.workspaceRoot,
        resolveProjectName: url.searchParams.get('resolveProjectName') ?? undefined,
      }));
    } catch (error) {
      sendText(response, 200, errorToTsv(error));
    }
    return;
  }

  if (pathname === '/api/resolve-volc-voiceover/synthesize.tsv' && method === 'POST') {
    try {
      const job = await readJsonBody(request) as IResolveVoiceoverJobInput;
      sendText(response, 200, await synthesizeResolveVolcVoiceoverTsv({
        workspaceRoot: options.workspaceRoot,
        job,
      }));
    } catch (error) {
      sendText(response, 200, errorToTsv(error));
    }
    return;
  }

  const analyzeMonitorMatch = pathname.match(/^\/api\/projects\/([^/]+)\/monitor\/analyze$/u);
  if (analyzeMonitorMatch && method === 'GET') {
    const projectId = decodeURIComponent(analyzeMonitorMatch[1]!);
    sendJson(response, 200, await buildAnalyzeMonitorModel(options.workspaceRoot, projectId));
    return;
  }

  if (pathname === '/api/workspace/monitor/style-analysis' && method === 'GET') {
    const categoryId = url.searchParams.get('categoryId') ?? undefined;
    sendJson(response, 200, await buildStyleMonitorModel(options.workspaceRoot, categoryId));
    return;
  }

  if (pathname === '/api/projects' && method === 'GET') {
    sendJson(response, 200, await listWorkspaceProjects(options.workspaceRoot));
    return;
  }

  if (pathname === '/api/capabilities' && method === 'GET') {
    sendJson(response, 200, {
      jobs: [
        { jobType: 'project-init', executionMode: 'deterministic', supported: true },
	        { jobType: 'ingest', executionMode: 'deterministic', supported: true },
	        { jobType: 'gps-refresh', executionMode: 'deterministic', supported: true },
	        { jobType: 'analyze', executionMode: 'deterministic', supported: true },
	        { jobType: 'spatial-refresh', executionMode: 'deterministic', supported: true, note: 'refreshes existing Analyze GPS / Pharos report fields and marks spans/chronology stale without running ML' },
        { jobType: 'span-rebuild', executionMode: 'deterministic', supported: true, note: 'deterministically builds candidate spans, then uses the local qwen text LM to generate provisional Chinese materialPatterns; speech/mixed candidates require Codex Agent speech-window review before chronology-build' },
        { jobType: 'chronology-build', executionMode: 'deterministic', supported: true, note: 'requires fresh spans and rebuilds draft Chronology V2 for review' },
	        { jobType: 'style-analysis', executionMode: 'deterministic', supported: true, note: 'runs deterministic prep and then hands off to Agent for final text/art-style reference; does not generate edit rules' },
        { jobType: 'color', executionMode: 'deterministic', supported: true, note: 'supports relink_media / prepare_root / sync_groups / execute_root / sync_batch_metadata / sync_batch_sidecars / validate_batch / relink_all_roots / prepare_all_roots / export_all_roots through the same-machine vendored Resolve backend; clip repair now follows the canonical Gyro -> Dehaze -> User1 -> User2 -> NR layout, and execute/export-all require explicit overwrite confirmation before replacing existing root outputs' },
        { jobType: 'export-jianying', executionMode: 'deterministic', supported: false },
        { jobType: 'export-resolve', executionMode: 'agent', supported: false },
      ],
      editFlowCapabilities: CEDIT_FLOW_CAPABILITY_CATALOG,
    });
    return;
  }

  const configMatch = pathname.match(/^\/api\/projects\/([^/]+)\/config$/u);
  if (configMatch && method === 'GET') {
    const projectId = decodeURIComponent(configMatch[1]!);
    const projectRoot = join(options.workspaceRoot, 'projects', projectId);
    const editId = normalizeEditId(url.searchParams.get('editId'));
    const [
      projectBrief,
      manualItinerary,
      editUnit,
      scriptBrief,
      ingestRoots,
      assets,
      spans,
      spansMeta,
      chronologyState,
      chronologyEventConsolidation,
      colorCurrent,
      colorGroupSnapshots,
      workspaceColorTransformPresets,
      colorResolveProjectMap,
      editResolveProjectMap,
      project,
      editFlowPlan,
      editFlowRuns,
    ] = await Promise.all([
      loadProjectBriefConfig(projectRoot),
      loadManualItineraryConfig(projectRoot),
      loadEditUnitConfig(projectRoot, editId),
      loadScriptBriefConfig(projectRoot, editId),
      loadIngestRoots(projectRoot),
      loadAssets(projectRoot),
      loadSpans(projectRoot),
      loadSpansMeta(projectRoot),
      loadChronologyReviewState(projectRoot),
      loadChronologyEventConsolidationState(projectRoot),
      loadColorCurrent(projectRoot),
      loadColorGroupsSnapshots(projectRoot),
      loadColorTransformPresetsConfig(options.workspaceRoot).catch(() => ({ profiles: {}, discoveredPresets: {} })),
      loadColorResolveProjectMap(projectRoot),
      loadEditResolveProjectMap(projectRoot),
      loadProject(projectRoot),
      loadEditFlowPlanReadOnly(options.workspaceRoot, projectRoot, editId),
      loadEditFlowRunRecords(projectRoot, editId),
    ]);
    const editResolveProjectName = deriveResolveRoughCutProjectName(project.name, project.id);
    const colorWorkspace = buildColorWorkspaceState({
      projectId,
      projectName: projectBrief.name,
      projectRoots: ingestRoots.roots,
      colorCurrent,
      resolveBackend: inspectResolveColorBackend(),
      groupSnapshotsByRootId: colorGroupSnapshots,
      colorResolveProjectMap,
    });
    const ingestRootSummaries = buildIngestRootSummaries(ingestRoots.roots, assets, chronologyState.chronology);
    const pharosContext = await loadOrBuildProjectPharosContext({
      projectRoot,
      includedTripIds: projectBrief.pharos?.includedTripIds ?? [],
    });
    const speechTranscriptReview = await loadCurrentSpeechTranscriptReview(projectRoot);
    const materialPatternIntegrity = summarizeSpanMaterialPatternIntegrity(spans);
    sendJson(response, 200, {
      projectBrief,
      manualItinerary,
      editUnit,
      scriptBrief,
      ingestRoots,
      colorCurrent: colorWorkspace.colorCurrent,
      colorRoots: colorWorkspace.colorRoots,
      workspaceColorTransformPresets,
      ingestRootSummaries,
      pharosStatus: buildProjectPharosAssetStatus(pharosContext, projectRoot),
      pharosContext,
      spans: {
        count: spans.length,
        meta: spansMeta,
        status: spansMeta?.status ?? 'missing',
        fresh: spans.length > 0
          && spansMeta?.status === 'fresh'
          && spansMeta.spanCount === spans.length
          && materialPatternIntegrity.incompleteCount === 0,
        materialPatternIntegrity: {
          ...materialPatternIntegrity,
          incompleteSpanIds: materialPatternIntegrity.incompleteSpanIds.slice(0, 20),
        },
        speechTranscriptReview,
      },
      chronology: {
        ...chronologyState,
        eventConsolidation: chronologyEventConsolidation,
      },
      editResolveProject: {
        resolveProjectName: editResolveProjectName,
        latestDrpSnapshot: resolveLatestEditDrpSnapshot(editResolveProjectMap, editResolveProjectName),
        resolveProjectMap: editResolveProjectMap,
      },
      resolveAssets: await getResolveAssetsStatus({ workspaceRoot: options.workspaceRoot }),
      editFlowPlan,
      editFlowRuns,
    });
    return;
  }

  const editFlowMatch = pathname.match(/^\/api\/projects\/([^/]+)\/edit-flow$/u);
  if (editFlowMatch && method === 'GET') {
    const projectId = decodeURIComponent(editFlowMatch[1]!);
    const projectRoot = join(options.workspaceRoot, 'projects', projectId);
    const editId = normalizeEditId(url.searchParams.get('editId'));
    sendJson(response, 200, {
      editUnit: await loadEditUnitConfig(projectRoot, editId),
      flowPlan: await loadEditFlowPlanReadOnly(options.workspaceRoot, projectRoot, editId),
      runs: await loadEditFlowRunRecords(projectRoot, editId),
      capabilities: CEDIT_FLOW_CAPABILITY_CATALOG,
    });
    return;
  }

  const chronologyConfirmMatch = pathname.match(/^\/api\/projects\/([^/]+)\/chronology\/confirm$/u);
  if (chronologyConfirmMatch && method === 'POST') {
    const projectId = decodeURIComponent(chronologyConfirmMatch[1]!);
    const projectRoot = join(options.workspaceRoot, 'projects', projectId);
    sendJson(response, 200, {
      chronology: await confirmChronology(projectRoot),
    });
    return;
  }

  const chronologyMergeMatch = pathname.match(/^\/api\/projects\/([^/]+)\/chronology\/events\/merge$/u);
  if (chronologyMergeMatch && method === 'POST') {
    const projectId = decodeURIComponent(chronologyMergeMatch[1]!);
    const projectRoot = join(options.workspaceRoot, 'projects', projectId);
    const payload = await readJsonBody(request).catch(() => ({}));
    const eventIds = Array.isArray(payload?.eventIds)
      ? payload.eventIds.filter((item: unknown): item is string => typeof item === 'string' && Boolean(item.trim()))
      : [];
    sendJson(response, 200, {
      chronology: await mergeChronologyEvents(projectRoot, eventIds),
    });
    return;
  }

  const chronologyEventMatch = pathname.match(/^\/api\/projects\/([^/]+)\/chronology\/events\/([^/]+)$/u);
  if (chronologyEventMatch && method === 'PUT') {
    const projectId = decodeURIComponent(chronologyEventMatch[1]!);
    const eventId = decodeURIComponent(chronologyEventMatch[2]!);
    const projectRoot = join(options.workspaceRoot, 'projects', projectId);
    const payload = await readJsonBody(request).catch(() => ({}));
    sendJson(response, 200, {
      chronology: await updateChronologyEvent(projectRoot, eventId, payload ?? {}),
    });
    return;
  }

  const chronologySplitMatch = pathname.match(/^\/api\/projects\/([^/]+)\/chronology\/events\/([^/]+)\/split$/u);
  if (chronologySplitMatch && method === 'POST') {
    const projectId = decodeURIComponent(chronologySplitMatch[1]!);
    const eventId = decodeURIComponent(chronologySplitMatch[2]!);
    const projectRoot = join(options.workspaceRoot, 'projects', projectId);
    sendJson(response, 200, {
      chronology: await splitChronologyEvent(projectRoot, eventId),
    });
    return;
  }

  const colorPreflightMatch = pathname.match(/^\/api\/projects\/([^/]+)\/color\/preflight$/u);
  if (colorPreflightMatch && method === 'POST') {
    const projectId = decodeURIComponent(colorPreflightMatch[1]!);
    const payload = await readJsonBody(request).catch(() => ({}));
    const rootId = typeof payload?.rootId === 'string' && payload.rootId.trim()
      ? payload.rootId.trim()
      : undefined;
    sendJson(response, 200, await preflightProjectColorHost({
      workspaceRoot: options.workspaceRoot,
      projectId,
      rootId,
    }));
    return;
  }

  const colorDrpSnapshotMatch = pathname.match(/^\/api\/projects\/([^/]+)\/color\/drp-snapshot$/u);
  if (colorDrpSnapshotMatch && method === 'POST') {
    const projectId = decodeURIComponent(colorDrpSnapshotMatch[1]!);
    const payload = await readJsonBody(request).catch(() => ({}));
    const rootId = typeof payload?.rootId === 'string' && payload.rootId.trim()
      ? payload.rootId.trim()
      : undefined;
    sendJson(response, 200, await snapshotProjectColorDrp({
      workspaceRoot: options.workspaceRoot,
      projectId,
      rootId,
      mode: 'manual',
      retention: payload?.retention === 'archive' ? 'archive' : 'latest-only',
    }));
    return;
  }

  const colorDrpRegisterMatch = pathname.match(/^\/api\/projects\/([^/]+)\/color\/drp-snapshot\/register$/u);
  if (colorDrpRegisterMatch && method === 'POST') {
    const projectId = decodeURIComponent(colorDrpRegisterMatch[1]!);
    const payload = await readJsonBody(request).catch(() => ({}));
    const rootId = typeof payload?.rootId === 'string' && payload.rootId.trim()
      ? payload.rootId.trim()
      : undefined;
    const drpPath = typeof payload?.path === 'string' && payload.path.trim()
      ? payload.path.trim()
      : typeof payload?.drpPath === 'string' && payload.drpPath.trim()
        ? payload.drpPath.trim()
        : '';
    sendJson(response, 200, await registerExternalColorDrpSnapshot({
      workspaceRoot: options.workspaceRoot,
      projectId,
      rootId,
      drpPath,
    }));
    return;
  }

  const editDrpSnapshotMatch = pathname.match(/^\/api\/projects\/([^/]+)\/edit\/resolve-project-snapshot$/u);
  if (editDrpSnapshotMatch && method === 'POST') {
    const projectId = decodeURIComponent(editDrpSnapshotMatch[1]!);
    const payload = await readJsonBody(request).catch(() => ({}));
    const editId = typeof payload?.editId === 'string' && payload.editId.trim()
      ? payload.editId.trim()
      : undefined;
    sendJson(response, 200, await snapshotProjectEditDrp({
      workspaceRoot: options.workspaceRoot,
      projectId,
      editId,
      mode: 'manual',
      retention: payload?.retention === 'archive' ? 'archive' : 'latest-only',
    }));
    return;
  }

  const editDrpRegisterMatch = pathname.match(/^\/api\/projects\/([^/]+)\/edit\/resolve-project-snapshot\/register$/u);
  if (editDrpRegisterMatch && method === 'POST') {
    const projectId = decodeURIComponent(editDrpRegisterMatch[1]!);
    const payload = await readJsonBody(request).catch(() => ({}));
    const editId = typeof payload?.editId === 'string' && payload.editId.trim()
      ? payload.editId.trim()
      : undefined;
    const drpPath = typeof payload?.path === 'string' && payload.path.trim()
      ? payload.path.trim()
      : typeof payload?.drpPath === 'string' && payload.drpPath.trim()
        ? payload.drpPath.trim()
        : '';
    sendJson(response, 200, await registerExternalEditDrpSnapshot({
      workspaceRoot: options.workspaceRoot,
      projectId,
      editId,
      drpPath,
    }));
    return;
  }

  const editResolveAssetsMatch = pathname.match(/^\/api\/projects\/([^/]+)\/edit\/resolve-assets$/u);
  if (editResolveAssetsMatch && (method === 'GET' || method === 'POST')) {
    const projectId = decodeURIComponent(editResolveAssetsMatch[1]!);
    await loadProject(join(options.workspaceRoot, 'projects', projectId));
    if (method === 'POST') {
      sendJson(response, 200, await installResolveAssets({
        workspaceRoot: options.workspaceRoot,
      }));
      return;
    }
    sendJson(response, 200, await getResolveAssetsStatus({
      workspaceRoot: options.workspaceRoot,
    }));
    return;
  }

  const editMediaRelinkMatch = pathname.match(/^\/api\/projects\/([^/]+)\/edit\/resolve-media-relink$/u);
  if (editMediaRelinkMatch && method === 'POST') {
    const projectId = decodeURIComponent(editMediaRelinkMatch[1]!);
    const payload = await readJsonBody(request).catch(() => ({}));
    const editId = typeof payload?.editId === 'string' && payload.editId.trim()
      ? payload.editId.trim()
      : undefined;
    const resolveAssetsInstall = await installResolveAssets({
      workspaceRoot: options.workspaceRoot,
    });
    const relinkResult = await relinkProjectEditMedia({
      workspaceRoot: options.workspaceRoot,
      projectId,
      editId,
    });
    sendJson(response, 200, {
      ...relinkResult,
      resolveAssetsInstall,
      hostSummary: {
        ...(relinkResult.hostSummary ?? {}),
        resolveAssetsInstall,
      },
    });
    return;
  }

  const colorArchiveMatch = pathname.match(/^\/api\/projects\/([^/]+)\/color\/archive$/u);
  if (colorArchiveMatch && method === 'GET') {
    const projectId = decodeURIComponent(colorArchiveMatch[1]!);
    const projectRoot = join(options.workspaceRoot, 'projects', projectId);
    sendJson(response, 200, {
      roots: Object.values(await loadColorArchiveViews(projectRoot)),
    });
    return;
  }

  const colorOverwritePreviewMatch = pathname.match(/^\/api\/projects\/([^/]+)\/color\/render-overwrite-preview$/u);
  if (colorOverwritePreviewMatch && method === 'POST') {
    const projectId = decodeURIComponent(colorOverwritePreviewMatch[1]!);
    const payload = await readJsonBody(request).catch(() => ({}));
    sendJson(response, 200, await previewProjectColorOverwrite({
      workspaceRoot: options.workspaceRoot,
      projectId,
      rootId: typeof payload?.rootId === 'string' && payload.rootId.trim() ? payload.rootId.trim() : undefined,
      action: payload?.mode === 'export_all_roots' || payload?.action === 'export_all_roots'
        ? 'export_all_roots'
        : 'execute_root',
      clipKeys: Array.isArray(payload?.clipKeys)
        ? payload.clipKeys.filter((item: unknown): item is string => typeof item === 'string' && Boolean(item.trim()))
        : undefined,
    }));
    return;
  }

  if (pathname === '/api/workspace/config/style-sources' && method === 'GET') {
    sendJson(response, 200, await buildStyleSourcesReadModel(options.workspaceRoot));
    return;
  }

  if (pathname === '/api/workspace/config/edit-rules' && method === 'GET') {
    sendJson(response, 200, await loadEditRulesConfig(options.workspaceRoot));
    return;
  }

  if (pathname === '/api/workspace/config/transcript-glossary' && method === 'GET') {
    sendJson(response, 200, await loadTranscriptGlossary(options.workspaceRoot));
    return;
  }

  if (pathname === '/api/workspace/config/asr' && method === 'GET') {
    sendJson(response, 200, await loadWorkspaceAsrConfig(options.workspaceRoot));
    return;
  }

  const projectBriefMatch = pathname.match(/^\/api\/projects\/([^/]+)\/config\/project-brief$/u);
  if (projectBriefMatch && method === 'PUT') {
    const projectId = decodeURIComponent(projectBriefMatch[1]!);
    const projectRoot = join(options.workspaceRoot, 'projects', projectId);
    const payload = await readJsonBody(request);
    const saved = await saveProjectBriefConfig(projectRoot, payload);
    await Promise.all([
      syncWorkspaceProjectBrief(options.workspaceRoot, projectId),
      markSpansStale(projectRoot, 'project-brief changed; rerun /chronology span-rebuild'),
      markChronologyStale(projectRoot),
    ]);
    await touchProjectUpdatedAt(projectRoot);
    sendJson(response, 200, saved);
    return;
  }

  const manualItineraryMatch = pathname.match(/^\/api\/projects\/([^/]+)\/config\/manual-itinerary$/u);
  if (manualItineraryMatch && method === 'PUT') {
    const projectId = decodeURIComponent(manualItineraryMatch[1]!);
    const projectRoot = join(options.workspaceRoot, 'projects', projectId);
    const payload = await readJsonBody(request);
    const saved = await saveManualItineraryConfig(projectRoot, payload);
    await syncCaptureTimeReviewsFromConfig(projectRoot);
    await Promise.all([
      markSpansStale(projectRoot, 'manual itinerary changed; refresh ingest/spatial context and rerun /chronology span-rebuild'),
      markChronologyStale(projectRoot),
    ]);
    sendJson(response, 200, saved);
    return;
  }

  const ingestRootsMatch = pathname.match(/^\/api\/projects\/([^/]+)\/config\/ingest-roots$/u);
  if (ingestRootsMatch && method === 'PUT') {
    const projectId = decodeURIComponent(ingestRootsMatch[1]!);
    const projectRoot = join(options.workspaceRoot, 'projects', projectId);
    const payload = await readJsonBody(request);
    const saved = await saveIngestRoots(projectRoot, payload);
    await Promise.all([
      markSpansStale(projectRoot, 'ingest roots changed; rerun /chronology span-rebuild'),
      markChronologyStale(projectRoot),
    ]);
    await touchProjectUpdatedAt(projectRoot);
    sendJson(response, 200, saved);
    return;
  }

  const scriptBriefMatch = pathname.match(/^\/api\/projects\/([^/]+)\/config\/script-brief$/u);
  if (scriptBriefMatch && method === 'PUT') {
    const projectId = decodeURIComponent(scriptBriefMatch[1]!);
    const projectRoot = join(options.workspaceRoot, 'projects', projectId);
    const payload = await readJsonBody(request);
    const editId = normalizeEditId(url.searchParams.get('editId') ?? payload?.editId);
    sendJson(response, 200, await saveScriptBriefConfig(projectRoot, payload, editId));
    return;
  }

  const editUnitMatch = pathname.match(/^\/api\/projects\/([^/]+)\/config\/edit-unit$/u);
  if (editUnitMatch && method === 'PUT') {
    const projectId = decodeURIComponent(editUnitMatch[1]!);
    const projectRoot = join(options.workspaceRoot, 'projects', projectId);
    const payload = await readJsonBody(request);
    const editId = normalizeEditId(url.searchParams.get('editId') ?? payload?.editId);
    sendJson(response, 200, await saveEditUnitConfig(projectRoot, payload, editId));
    return;
  }

  if (pathname === '/api/workspace/config/style-sources' && method === 'PUT') {
    const payload = await readJsonBody(request);
    sendJson(response, 200, await saveStyleSourcesConfig(options.workspaceRoot, payload));
    return;
  }

  if (pathname === '/api/workspace/config/edit-rules' && method === 'PUT') {
    const payload = await readJsonBody(request);
    sendJson(response, 200, await saveEditRulesConfig(options.workspaceRoot, payload));
    return;
  }

  if (pathname === '/api/workspace/config/transcript-glossary' && method === 'PUT') {
    const payload = await readJsonBody(request);
    sendJson(response, 200, await saveTranscriptGlossary(options.workspaceRoot, payload));
    return;
  }

  if (pathname === '/api/workspace/config/asr' && method === 'PUT') {
    const payload = await readJsonBody(request);
    sendJson(response, 200, await saveWorkspaceAsrConfig(options.workspaceRoot, payload));
    return;
  }

  const reviewMatch = pathname.match(/^\/api\/projects\/([^/]+)\/reviews$/u);
  if (reviewMatch && method === 'GET') {
    const projectId = decodeURIComponent(reviewMatch[1]!);
    const projectRoot = join(options.workspaceRoot, 'projects', projectId);
    await syncCaptureTimeReviewsFromConfig(projectRoot);
    sendJson(response, 200, await loadReviewQueue(projectRoot));
    return;
  }

  const speechTranscriptCommitMatch = pathname.match(/^\/api\/projects\/([^/]+)\/speech-transcript-review\/commit$/u);
  if (speechTranscriptCommitMatch && method === 'POST') {
    const projectId = decodeURIComponent(speechTranscriptCommitMatch[1]!);
    const projectRoot = join(options.workspaceRoot, 'projects', projectId);
    const payload = await readJsonBody(request).catch(() => ({}));
    const inputsHash = typeof payload?.inputsHash === 'string' ? payload.inputsHash : '';
    if (!inputsHash) {
      sendJson(response, 400, { error: 'inputsHash is required' });
      return;
    }
    const artifact = await commitProjectSpeechTranscriptReview({
      workspaceRoot: options.workspaceRoot,
      projectRoot,
      inputsHash,
      resolutions: Array.isArray(payload?.resolutions) ? payload.resolutions : [],
    });
    sendJson(response, 200, artifact);
    return;
  }

  const speechTranscriptDraftMatch = pathname.match(/^\/api\/projects\/([^/]+)\/speech-transcript-review\/draft$/u);
  if (speechTranscriptDraftMatch && method === 'PUT') {
    const projectId = decodeURIComponent(speechTranscriptDraftMatch[1]!);
    const projectRoot = join(options.workspaceRoot, 'projects', projectId);
    const payload = await readJsonBody(request).catch(() => ({}));
    const inputsHash = typeof payload?.inputsHash === 'string' ? payload.inputsHash : '';
    if (!inputsHash) {
      sendJson(response, 400, { error: 'inputsHash is required' });
      return;
    }
    const artifact = await saveProjectSpeechTranscriptReviewDraft({
      workspaceRoot: options.workspaceRoot,
      projectRoot,
      inputsHash,
      resolutions: Array.isArray(payload?.resolutions) ? payload.resolutions : [],
    });
    sendJson(response, 200, artifact);
    return;
  }

  const speechReviewAudioMatch = pathname.match(/^\/api\/projects\/([^/]+)\/speech-transcript-review\/audio\/([^/]+)$/u);
  if (speechReviewAudioMatch && method === 'GET') {
    const projectId = decodeURIComponent(speechReviewAudioMatch[1]!);
    const assetId = decodeURIComponent(speechReviewAudioMatch[2]!);
    const rawStartMs = url.searchParams.get('startMs');
    const rawEndMs = url.searchParams.get('endMs');
    if (rawStartMs === null || rawEndMs === null) {
      sendJson(response, 400, { error: 'startMs and endMs are required' });
      return;
    }
    const clip = await prepareProjectSpeechReviewAudio({
      workspaceRoot: options.workspaceRoot,
      projectRoot: join(options.workspaceRoot, 'projects', projectId),
      assetId,
      startMs: Number(rawStartMs),
      endMs: Number(rawEndMs),
    });
    const clipStat = await stat(clip.path);
    response.writeHead(200, {
      'Content-Type': clip.contentType,
      'Content-Length': clipStat.size,
      'Cache-Control': 'private, max-age=86400',
      'X-Content-Type-Options': 'nosniff',
    });
    createReadStream(clip.path).pipe(response);
    return;
  }

  const resolveReviewMatch = pathname.match(/^\/api\/projects\/([^/]+)\/reviews\/([^/]+)\/resolve$/u);
  if (resolveReviewMatch && method === 'POST') {
    const projectId = decodeURIComponent(resolveReviewMatch[1]!);
    const reviewId = decodeURIComponent(resolveReviewMatch[2]!);
    const projectRoot = join(options.workspaceRoot, 'projects', projectId);
    const payload = await readJsonBody(request).catch(() => ({}));
    const queue = await loadReviewQueue(projectRoot);
    const current = queue.items.find(item => item.id === reviewId);
    const review = current?.kind === 'transcript-correction'
      ? await resolveTranscriptCorrectionReview({
          workspaceRoot: options.workspaceRoot,
          projectRoot,
          reviewId,
          finalText: typeof payload?.finalText === 'string' ? payload.finalText : undefined,
          promoteToGlossary: payload?.promoteToGlossary === true,
          note: typeof payload?.note === 'string' ? payload.note : undefined,
        })
      : await resolveReviewItem(projectRoot, reviewId, payload);
    if (!review) {
      sendJson(response, 404, { error: 'review not found' });
      return;
    }
    sendJson(response, 200, review);
    return;
  }

  const progressMatch = pathname.match(/^\/api\/projects\/([^/]+)\/progress\/([^/]+)$/u);
  if (progressMatch && method === 'GET') {
    const projectId = decodeURIComponent(progressMatch[1]!);
    const pipelineKey = decodeURIComponent(progressMatch[2]!);
    const progressPath = getProjectProgressPath(join(options.workspaceRoot, 'projects', projectId), pipelineKey);
    sendJson(response, 200, await readJsonFile(progressPath));
    return;
  }

  const jobMatch = pathname.match(/^\/api\/jobs\/([^/]+)$/u);
  if (jobMatch && method === 'GET') {
    const job = await loadJobRecord(options.workspaceRoot, decodeURIComponent(jobMatch[1]!));
    if (!job) {
      sendJson(response, 404, { error: 'job not found' });
      return;
    }
    sendJson(response, 200, {
      ...job,
      progress: await readJobProgressForStatus(job),
      result: job.status === 'awaiting_agent' ? await readJsonFile(job.resultPath) : undefined,
    });
    return;
  }

  if (pathname === '/api/jobs' && method === 'POST') {
    const payload = await readJsonBody(request);
    const job = await startJob(options.workspaceRoot, payload);
    sendJson(response, 202, job);
    return;
  }

  const jobActionMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/(stop|restart)$/u);
  if (jobActionMatch && method === 'POST') {
    const jobId = decodeURIComponent(jobActionMatch[1]!);
    const action = jobActionMatch[2]!;
    const current = await loadJobRecord(options.workspaceRoot, jobId);
    if (!current) {
      sendJson(response, 404, { error: 'job not found' });
      return;
    }
    if (action === 'stop') {
      if (current.pid) {
        try {
          process.kill(current.pid, 'SIGTERM');
        } catch {
          // ignore
        }
      }
      await stopMlService(options.workspaceRoot).catch(() => undefined);
      const stopped = {
        ...current,
        status: 'stopped' as const,
        finishedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await writeJobRecord(options.workspaceRoot, stopped);
      sendJson(response, 200, stopped);
      return;
    }

    await stopMlService(options.workspaceRoot).catch(() => undefined);
    const restarted = await startJob(options.workspaceRoot, {
      jobType: current.jobType,
      projectId: current.projectId,
      args: current.args,
      restartOf: current.jobId,
    });
    sendJson(response, 202, restarted);
    return;
  }

  const serviceActionMatch = pathname.match(/^\/api\/services\/([^/]+)\/(start|stop|restart)$/u);
  if (serviceActionMatch && method === 'POST') {
    const serviceName = decodeURIComponent(serviceActionMatch[1]!);
    const action = serviceActionMatch[2]!;
    if (serviceName !== 'ml') {
      sendJson(response, 400, { error: `Unsupported service action for ${serviceName}` });
      return;
    }

    if (action === 'start') {
      sendJson(response, 202, await startMlService(options.workspaceRoot));
      return;
    }
    if (action === 'stop') {
      sendJson(response, 200, await stopMlService(options.workspaceRoot));
      return;
    }

    await stopMlService(options.workspaceRoot);
    sendJson(response, 202, await startMlService(options.workspaceRoot));
    return;
  }

  const logsMatch = pathname.match(/^\/api\/logs\/(.+)$/u);
  if (logsMatch && method === 'GET') {
    const scope = decodeURIComponent(logsMatch[1]!);
    sendJson(response, 200, {
      scope,
      content: await readLogScope(options.workspaceRoot, scope),
    });
    return;
  }

  if (pathname.startsWith('/api/')) {
    sendJson(response, 404, { error: `unknown api endpoint: ${pathname}` });
    return;
  }

  await serveConsoleAsset(options.workspaceRoot, pathname, response);
}

async function startJob(
  workspaceRoot: string,
  payload: {
    jobType: string;
    projectId?: string;
    args?: Record<string, unknown>;
    restartOf?: string;
  },
): Promise<ISupervisorJobRecord> {
  await reconcileInterruptedJobs(workspaceRoot);
  if (payload.jobType === 'edit-flow') {
    throw new Error('edit-flow jobs have been removed; initialize /edit and let Codex Agent maintain Flow Plan artifacts directly');
  }
	  if (payload.jobType === 'color' && payload.projectId) {
	    const existingJobs = await listJobRecords(workspaceRoot);
	    const activeColorJob = existingJobs.find(job => (
      job.jobType === 'color'
      && job.projectId === payload.projectId
      && ['queued', 'running'].includes(job.status)
    ));
    if (activeColorJob) {
	      throw new Error(`project ${payload.projectId} already has an active color job: ${activeColorJob.jobId}`);
	    }
	  }
	  if (['analyze', 'spatial-refresh', 'span-rebuild', 'chronology-build'].includes(payload.jobType) && payload.projectId) {
	    const existingJobs = await listJobRecords(workspaceRoot);
	    const activeAnalyzeJob = existingJobs.find(job => (
	      ['analyze', 'spatial-refresh', 'span-rebuild', 'chronology-build'].includes(job.jobType)
	      && job.projectId === payload.projectId
	      && ['queued', 'running'].includes(job.status)
	    ));
	    if (activeAnalyzeJob) {
	      throw new Error(`project ${payload.projectId} already has an active analyze/chronology job: ${activeAnalyzeJob.jobId}`);
	    }
	  }

  const jobId = randomUUID();
  const jobRoot = getSupervisorJobRoot(workspaceRoot, jobId);
  await mkdir(jobRoot, { recursive: true });
  const stdoutPath = join(jobRoot, 'stdout.log');
  const stderrPath = join(jobRoot, 'stderr.log');
  const resultPath = join(jobRoot, 'result.json');
	  const progressPath = ['analyze', 'spatial-refresh'].includes(payload.jobType) && payload.projectId
	    ? getProjectProgressPath(join(workspaceRoot, 'projects', payload.projectId), 'media-analyze')
    : ['span-rebuild', 'chronology-build'].includes(payload.jobType) && payload.projectId
      ? getProjectProgressPath(join(workspaceRoot, 'projects', payload.projectId), 'chronology')
    : payload.jobType === 'color' && payload.projectId
      ? getProjectProgressPath(join(workspaceRoot, 'projects', payload.projectId), 'color')
    : payload.jobType === 'style-analysis'
      ? getWorkspaceStyleAnalysisProgressPath(
        workspaceRoot,
        await resolveStyleAnalysisCategoryId(workspaceRoot, payload.args),
      )
    : undefined;
  const inputSnapshotPath = join(jobRoot, 'input.json');
  const configSnapshotPath = join(jobRoot, 'config-snapshot.json');
  await writeFileSafe(inputSnapshotPath, JSON.stringify(payload.args ?? {}, null, 2));

  if (payload.projectId) {
    const projectRoot = join(workspaceRoot, 'projects', payload.projectId);
    const editId = normalizeEditId(typeof payload.args?.editId === 'string' ? payload.args.editId : undefined);
    await writeFileSafe(configSnapshotPath, JSON.stringify({
      projectBrief: await loadProjectBriefConfig(projectRoot).catch(() => null),
      ingestRoots: await loadIngestRoots(projectRoot).catch(() => null),
      colorCurrent: await loadColorCurrent(projectRoot).catch(() => null),
      colorGroups: await loadColorGroupsSnapshots(projectRoot).catch(() => null),
      manualItinerary: await loadManualItineraryConfig(projectRoot).catch(() => null),
      editUnit: await loadEditUnitConfig(projectRoot, editId).catch(() => null),
      scriptBrief: await loadScriptBriefConfig(projectRoot, editId).catch(() => null),
      editFlowPlan: await loadEditFlowPlanReadOnly(workspaceRoot, projectRoot, editId).catch(() => null),
      editFlowRuns: await loadEditFlowRunRecords(projectRoot, editId).catch(() => null),
      pharosContext: await loadOrBuildProjectPharosContext({
        projectRoot,
        includedTripIds: (await loadProjectBriefConfig(projectRoot).catch(() => null))?.pharos?.includedTripIds ?? [],
      }).catch(() => null),
      workspaceStyleSources: await loadStyleSourcesConfig(workspaceRoot).catch(() => null),
      workspaceEditRules: await loadEditRulesConfig(workspaceRoot).catch(() => null),
      workspaceColorTransformPresets: await loadColorTransformPresetsConfig(workspaceRoot).catch(() => null),
    }, null, 2));
  } else if (payload.jobType === 'style-analysis') {
    await writeFileSafe(configSnapshotPath, JSON.stringify({
      workspaceStyleSources: await loadStyleSourcesConfig(workspaceRoot).catch(() => null),
      workspaceEditRules: await loadEditRulesConfig(workspaceRoot).catch(() => null),
    }, null, 2));
  }

  const record: ISupervisorJobRecord = {
    jobId,
    jobType: payload.jobType,
    executionMode: resolveJobExecutionMode(payload.jobType),
    projectId: payload.projectId,
    args: payload.args ?? {},
    status: 'queued',
    updatedAt: new Date().toISOString(),
    stdoutPath,
    stderrPath,
    resultPath,
    progressPath,
    blockers: [],
    restartOf: payload.restartOf,
    inputSnapshotPath,
    configSnapshotPath,
  };
  await writeJobRecord(workspaceRoot, record);

  const child = spawn(
    process.execPath,
    [
      fileUrlPath(new URL('./job-runner.js', import.meta.url)),
      '--workspaceRoot', workspaceRoot,
      '--jobId', jobId,
    ],
    {
      cwd: workspaceRoot,
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );
  child.stdout?.pipe(createWriteStream(stdoutPath, { flags: 'w' }));
  child.stderr?.pipe(createWriteStream(stderrPath, { flags: 'w' }));

  const queued: ISupervisorJobRecord = {
    ...record,
    pid: child.pid ?? undefined,
    updatedAt: new Date().toISOString(),
  };
  await writeJobRecord(workspaceRoot, queued);
  return queued;
}

async function resolveStyleAnalysisCategoryId(
  workspaceRoot: string,
  args?: Record<string, unknown>,
): Promise<string> {
  const explicit = typeof args?.categoryId === 'string' && args.categoryId.trim()
    ? args.categoryId.trim()
    : undefined;
  if (explicit) return explicit;

  const config = await loadStyleSourcesConfig(workspaceRoot);
  const categoryId = config.defaultCategory || config.categories[0]?.categoryId;
  if (!categoryId) {
    throw new Error('workspace style-sources.json does not define any categories');
  }
  return categoryId;
}

function resolveJobExecutionMode(jobType: string): TSupervisorExecutionMode {
  return ['export-resolve'].includes(jobType)
    ? 'agent'
    : 'deterministic';
}

async function syncCaptureTimeReviewsFromConfig(projectRoot: string): Promise<void> {
  const queue = await loadReviewQueue(projectRoot);
  const preserved = queue.items.filter(item => item.kind !== 'capture-time-correction');
  if (preserved.length === queue.items.length) return;
  await saveReviewQueue(projectRoot, { items: preserved });
}

function buildIngestRootSummaries(
  roots: IMediaRoot[],
  assets: IKtepAsset[],
  chronology: IProjectChronology | null,
): Array<{
  rootId: string;
  localPath?: string;
  rawLocalPath?: string;
  pathResolution: IMediaRootPathResolution;
  rawPathResolution: IMediaRootPathResolution;
  blockingReasons: string[];
  assetCount: number;
  firstAnchor?: {
    assetId: string;
    displayName: string;
    capturedAt?: string;
    sortCapturedAt?: string;
  };
  lastAnchor?: {
    assetId: string;
    displayName: string;
    capturedAt?: string;
    sortCapturedAt?: string;
  };
}> {
  const chronologyByAssetId = new Map((chronology?.assetIndex ?? []).map(entry => [entry.assetId, entry]));
  const grouped = new Map<string, IKtepAsset[]>();

  for (const asset of assets) {
    const rootId = asset.ingestRootId;
    if (!rootId) continue;
    const current = grouped.get(rootId) ?? [];
    current.push(asset);
    grouped.set(rootId, current);
  }

  return roots.map(root => {
    const resolvedRoot = resolveMediaRoot(root);
    const entries = [...(grouped.get(root.id) ?? [])].sort((left, right) => {
      const leftChronology = chronologyByAssetId.get(left.id);
      const rightChronology = chronologyByAssetId.get(right.id);
      const leftKey = leftChronology?.sortCapturedAt ?? left.capturedAt ?? '';
      const rightKey = rightChronology?.sortCapturedAt ?? right.capturedAt ?? '';
      if (leftKey !== rightKey) return leftKey.localeCompare(rightKey);
      return left.id.localeCompare(right.id);
    });
    const first = entries[0];
    const last = entries[entries.length - 1];
    const firstChronology = first ? chronologyByAssetId.get(first.id) : undefined;
    const lastChronology = last ? chronologyByAssetId.get(last.id) : undefined;

    return {
      rootId: root.id,
      localPath: resolvedRoot.localPath,
      rawLocalPath: resolvedRoot.rawLocalPath,
      pathResolution: resolvedRoot.localPathResolution,
      rawPathResolution: resolvedRoot.rawPathResolution,
      blockingReasons: [
        !resolvedRoot.localPath ? resolvedRoot.localPathResolution.blocker : '',
        root.rawPath || root.alternatePaths?.some(alternate => alternate.rawPath)
          ? (!resolvedRoot.rawLocalPath ? resolvedRoot.rawPathResolution.blocker : '')
          : '',
      ].filter((value): value is string => Boolean(value)),
      assetCount: entries.length,
      firstAnchor: first
        ? {
          assetId: first.id,
          displayName: first.displayName ?? first.id,
          capturedAt: first.capturedAt,
          sortCapturedAt: firstChronology?.sortCapturedAt ?? first.capturedAt,
        }
        : undefined,
      lastAnchor: last
        ? {
          assetId: last.id,
          displayName: last.displayName ?? last.id,
          capturedAt: last.capturedAt,
          sortCapturedAt: lastChronology?.sortCapturedAt ?? last.capturedAt,
        }
        : undefined,
    };
  });
}

async function serveConsoleAsset(
  workspaceRoot: string,
  pathname: string,
  response: ServerResponse,
): Promise<void> {
  const consoleDist = join(workspaceRoot, 'apps', 'kairos-console', 'dist');
  const safePath = pathname === '/'
    ? 'index.html'
    : normalize(pathname).replace(/^[/\\]+/u, '');
  const targetPath = join(consoleDist, safePath);
  const resolvedTargetPath = resolve(targetPath);
  const resolvedConsoleDist = resolve(consoleDist);

  if (resolvedTargetPath.startsWith(resolvedConsoleDist) && await canRead(resolvedTargetPath)) {
    response.writeHead(200, { 'Content-Type': contentTypeFor(resolvedTargetPath) });
    createReadStream(resolvedTargetPath).pipe(response);
    return;
  }

  const indexPath = join(consoleDist, 'index.html');
  if (await canRead(indexPath)) {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    createReadStream(indexPath).pipe(response);
    return;
  }

  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end([
    '<!doctype html>',
    '<html><body style="font-family: sans-serif; padding: 24px;">',
    '<h1>Kairos Console</h1>',
    '<p>Console assets are not built yet. Run <code>npm install && npm run build</code> inside <code>apps/kairos-console</code>.</p>',
    '</body></html>',
  ].join(''));
}

async function readLogScope(workspaceRoot: string, scope: string): Promise<string> {
  if (scope === 'service:ml') {
    const ml = await getMlServiceStatus(workspaceRoot);
    return readTail(ml.stdoutPath);
  }
  if (scope === 'service:dashboard') {
    return 'Dashboard logs are emitted by the current supervisor process.';
  }
  const stdoutMatch = scope.match(/^job:([^:]+):(stdout|stderr)$/u);
  if (stdoutMatch?.[1] && stdoutMatch[2]) {
    const job = await loadJobRecord(workspaceRoot, stdoutMatch[1]);
    if (!job) return '';
    return readTail(stdoutMatch[2] === 'stdout' ? job.stdoutPath : job.stderrPath);
  }
  return '';
}

async function readTail(path?: string, maxChars = 24_000): Promise<string> {
  if (!path) return '';
  try {
    const raw = await readFile(path, 'utf-8');
    return raw.slice(-maxChars);
  } catch {
    return '';
  }
}

async function readJsonBody(request: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf-8').trim();
  return raw ? JSON.parse(raw) : {};
}

async function readJsonFile(path?: string): Promise<unknown> {
  if (!path) return null;
  try {
    const raw = await readFile(path, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function loadJobsWithProgress(workspaceRoot: string): Promise<Array<ISupervisorJobRecord & { progress: unknown; result?: unknown }>> {
  const jobs = await listJobRecords(workspaceRoot);
  const hydrated = await Promise.all(jobs.map(async job => ({
    ...job,
    progress: await readJobProgressForStatus(job),
    result: job.status === 'awaiting_agent' ? await readJsonFile(job.resultPath) : undefined,
  })));
  return hydrated;
}

async function readJobProgressForStatus(job: ISupervisorJobRecord): Promise<unknown> {
  if (!job.progressPath) return null;
  if (!['queued', 'running', 'failed', 'blocked'].includes(job.status)) return null;
  const progress = await readJsonFile(job.progressPath);
  if (!progressBelongsToSupervisorJob(job, progress)) return null;
  return progress;
}

async function reconcileInterruptedJobs(workspaceRoot: string): Promise<void> {
  const jobs = await listJobRecords(workspaceRoot);
  await Promise.all(
    jobs
      .filter(job => job.status === 'running' && typeof job.pid === 'number' && !isPidAlive(job.pid))
      .map(job => markJobInterrupted(workspaceRoot, job)),
  );
}

async function markJobInterrupted(workspaceRoot: string, job: ISupervisorJobRecord): Promise<void> {
  const now = new Date().toISOString();
  const detail = `interrupted: recorded pid ${job.pid} is no longer running`;
  await writeJobRecord(workspaceRoot, {
    ...job,
    status: 'failed',
    finishedAt: now,
    updatedAt: now,
    lastError: detail,
    blockers: dedupeTextList([...(job.blockers ?? []), detail]),
  });
  if (job.progressPath) {
    await writeKairosProgress(job.progressPath, {
      status: 'failed',
      pipelineKey: job.jobType === 'color' ? 'color' : job.jobType,
      pipelineLabel: job.jobType === 'color' ? '达芬奇调色流程' : job.jobType,
      phaseKey: 'interrupted',
      phaseLabel: 'Interrupted',
      step: 'interrupted',
      stepLabel: '进程已中断',
      stepIndex: 1,
      stepTotal: 1,
      current: 0,
      total: 1,
      unit: 'step',
      detail,
      extra: {
        jobId: job.jobId,
        pid: job.pid,
        projectId: job.projectId,
      },
    }).catch(() => undefined);
  }
  if (job.jobType === 'color' && job.projectId) {
    const projectRoot = join(workspaceRoot, 'projects', job.projectId);
    const current = await loadColorCurrent(projectRoot).catch(() => null);
    if (current) {
      await saveColorCurrent(projectRoot, {
        ...current,
        roots: current.roots.map(root => root.currentJobId === job.jobId
          ? {
              ...root,
              activeStage: undefined,
              currentJobId: undefined,
              detail,
              blockingReasons: dedupeTextList([...(root.blockingReasons ?? []), detail]),
            }
          : root),
        updatedAt: now,
      }).catch(() => undefined);
    }
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function dedupeTextList(values: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value?.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

async function buildStyleSourcesReadModel(workspaceRoot: string): Promise<unknown> {
  const config = await loadStyleSourcesConfig(workspaceRoot);
  const categories = await Promise.all(config.categories.map(async category => {
    const profile = await loadStyleByCategory(`${workspaceRoot}/config/styles`, category.categoryId)
      .catch(() => null);
    return {
      ...category,
      profileStatus: profile
        ? isLayeredStyleProfile(profile) ? 'layered-v1' : 'legacy'
        : 'missing',
      styleProfileVersion: profile?.styleProfileVersion,
      availableLayers: profile?.layers
        ? Object.keys(profile.layers)
        : [],
    };
  }));
  return {
    ...config,
    categories,
  };
}

function sendJson(response: ServerResponse, statusCode: number, data: unknown): void {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(data, null, 2));
}

function sendText(
  response: ServerResponse,
  statusCode: number,
  content: string,
  contentType = 'text/tab-separated-values; charset=utf-8',
): void {
  response.writeHead(statusCode, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
  });
  response.end(content);
}

function serializeApiError(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) {
    return { error: String(error) };
  }
  const richError = error as Error & {
    code?: unknown;
    details?: unknown;
    stdout?: unknown;
    stderr?: unknown;
  };
  const payload: Record<string, unknown> = { error: error.message };
  if (typeof richError.code === 'string') payload.code = richError.code;
  if (richError.details !== undefined) payload.details = richError.details;
  return payload;
}

async function writeFileSafe(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await import('node:fs/promises').then(fs => fs.writeFile(path, `${content.trimEnd()}\n`, 'utf-8'));
}

async function canRead(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function contentTypeFor(path: string): string {
  const extension = extname(path).toLowerCase();
  switch (extension) {
    case '.js': return 'application/javascript; charset=utf-8';
    case '.css': return 'text/css; charset=utf-8';
    case '.json': return 'application/json; charset=utf-8';
    case '.svg': return 'image/svg+xml';
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    default: return 'text/html; charset=utf-8';
  }
}

function fileUrlPath(url: URL): string {
  return decodeURIComponent(url.pathname.replace(/^\/([A-Za-z]:\/)/u, '$1'));
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
