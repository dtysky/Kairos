import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, mkdir, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import {
  getProjectProgressPath,
  listWorkspaceProjects,
  loadManualItineraryConfig,
  loadProjectBriefConfig,
  loadReviewQueue,
  loadScriptBriefConfig,
  loadStyleSourcesConfig,
  resolveReviewItem,
  saveManualItineraryConfig,
  saveProjectBriefConfig,
  saveScriptBriefConfig,
  saveStyleSourcesConfig,
  syncWorkspaceProjectBrief,
} from '../store/index.js';
import {
  buildProjectPharosAssetStatus,
  loadOrBuildProjectPharosContext,
} from '../modules/pharos/context.js';
import { getMlServiceStatus, startMlService, stopMlService } from './runtime.js';
import {
  getSupervisorJobRoot,
  listJobRecords,
  loadJobRecord,
  writeJobRecord,
  writeServiceRecord,
  type ISupervisorJobRecord,
  type ISupervisorServiceRecord,
} from './state.js';
import { buildAnalyzeMonitorModel, buildStyleMonitorModel } from './monitor-model.js';

interface IDaemonOptions {
  workspaceRoot: string;
  port: number;
}

async function main(): Promise<void> {
  const options = parseDaemonOptions(process.argv.slice(2));
  await ensureDashboardServiceRecord(options.workspaceRoot, options.port);

  const server = createServer(async (request, response) => {
    try {
      await routeRequest(options, request, response);
    } catch (error) {
      sendJson(response, 500, {
        error: error instanceof Error ? error.message : String(error),
      });
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
        { jobType: 'style-analysis', executionMode: 'agent', supported: true, note: 'agent-backed manifest is ready; runner still returns explicit blocker' },
        { jobType: 'script', executionMode: 'deterministic', supported: true, note: 'runs only after reviewed brief is saved; advances ready_to_prepare -> ready_for_agent; final script remains agent-authored' },
        { jobType: 'timeline', executionMode: 'deterministic', supported: false },
        { jobType: 'export-jianying', executionMode: 'deterministic', supported: false },
        { jobType: 'export-resolve', executionMode: 'agent', supported: false },
      ],
    });
    return;
  }

  const configMatch = pathname.match(/^\/api\/projects\/([^/]+)\/config$/u);
  if (configMatch && method === 'GET') {
    const projectId = decodeURIComponent(configMatch[1]!);
    const projectRoot = join(options.workspaceRoot, 'projects', projectId);
    const [projectBrief, manualItinerary, scriptBrief] = await Promise.all([
      loadProjectBriefConfig(projectRoot),
      loadManualItineraryConfig(projectRoot),
      loadScriptBriefConfig(projectRoot),
    ]);
    const pharosContext = await loadOrBuildProjectPharosContext({
      projectRoot,
      includedTripIds: projectBrief.pharos?.includedTripIds ?? [],
    });
    sendJson(response, 200, {
      projectBrief,
      manualItinerary,
      scriptBrief,
      pharosStatus: buildProjectPharosAssetStatus(pharosContext, projectRoot),
      pharosContext,
    });
    return;
  }

  if (pathname === '/api/workspace/config/style-sources' && method === 'GET') {
    sendJson(response, 200, await loadStyleSourcesConfig(options.workspaceRoot));
    return;
  }

  const projectBriefMatch = pathname.match(/^\/api\/projects\/([^/]+)\/config\/project-brief$/u);
  if (projectBriefMatch && method === 'PUT') {
    const projectId = decodeURIComponent(projectBriefMatch[1]!);
    const projectRoot = join(options.workspaceRoot, 'projects', projectId);
    const payload = await readJsonBody(request);
    const saved = await saveProjectBriefConfig(projectRoot, payload);
    await syncWorkspaceProjectBrief(options.workspaceRoot, projectId);
    sendJson(response, 200, saved);
    return;
  }

  const manualItineraryMatch = pathname.match(/^\/api\/projects\/([^/]+)\/config\/manual-itinerary$/u);
  if (manualItineraryMatch && method === 'PUT') {
    const projectId = decodeURIComponent(manualItineraryMatch[1]!);
    const projectRoot = join(options.workspaceRoot, 'projects', projectId);
    const payload = await readJsonBody(request);
    const saved = await saveManualItineraryConfig(projectRoot, payload);
    await syncCaptureTimeReviewsFromConfig(projectId, projectRoot);
    sendJson(response, 200, saved);
    return;
  }

  const scriptBriefMatch = pathname.match(/^\/api\/projects\/([^/]+)\/config\/script-brief$/u);
  if (scriptBriefMatch && method === 'PUT') {
    const projectId = decodeURIComponent(scriptBriefMatch[1]!);
    const projectRoot = join(options.workspaceRoot, 'projects', projectId);
    const payload = await readJsonBody(request);
    sendJson(response, 200, await saveScriptBriefConfig(projectRoot, payload));
    return;
  }

  if (pathname === '/api/workspace/config/style-sources' && method === 'PUT') {
    const payload = await readJsonBody(request);
    sendJson(response, 200, await saveStyleSourcesConfig(options.workspaceRoot, payload));
    return;
  }

  const reviewMatch = pathname.match(/^\/api\/projects\/([^/]+)\/reviews$/u);
  if (reviewMatch && method === 'GET') {
    const projectId = decodeURIComponent(reviewMatch[1]!);
    const projectRoot = join(options.workspaceRoot, 'projects', projectId);
    await syncCaptureTimeReviewsFromConfig(projectId, projectRoot);
    sendJson(response, 200, await loadReviewQueue(projectRoot));
    return;
  }

  const resolveReviewMatch = pathname.match(/^\/api\/projects\/([^/]+)\/reviews\/([^/]+)\/resolve$/u);
  if (resolveReviewMatch && method === 'POST') {
    const projectId = decodeURIComponent(resolveReviewMatch[1]!);
    const reviewId = decodeURIComponent(resolveReviewMatch[2]!);
    const projectRoot = join(options.workspaceRoot, 'projects', projectId);
    const payload = await readJsonBody(request).catch(() => ({}));
    const review = await resolveReviewItem(projectRoot, reviewId, payload);
    if (!review) {
      sendJson(response, 404, { error: 'review not found' });
      return;
    }
    if (review.kind === 'capture-time-correction') {
      await applyCaptureTimeReviewResolution(projectRoot, review);
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
      progress: job.progressPath ? await readJsonFile(job.progressPath) : null,
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
  const jobId = randomUUID();
  const jobRoot = getSupervisorJobRoot(workspaceRoot, jobId);
  await mkdir(jobRoot, { recursive: true });
  const stdoutPath = join(jobRoot, 'stdout.log');
  const stderrPath = join(jobRoot, 'stderr.log');
  const resultPath = join(jobRoot, 'result.json');
  const progressPath = payload.jobType === 'analyze' && payload.projectId
    ? getProjectProgressPath(join(workspaceRoot, 'projects', payload.projectId), 'media-analyze')
    : undefined;
  const inputSnapshotPath = join(jobRoot, 'input.json');
  const configSnapshotPath = join(jobRoot, 'config-snapshot.json');
  await writeFileSafe(inputSnapshotPath, JSON.stringify(payload.args ?? {}, null, 2));

  if (payload.projectId) {
    const projectRoot = join(workspaceRoot, 'projects', payload.projectId);
    await writeFileSafe(configSnapshotPath, JSON.stringify({
      projectBrief: await loadProjectBriefConfig(projectRoot).catch(() => null),
      manualItinerary: await loadManualItineraryConfig(projectRoot).catch(() => null),
      scriptBrief: await loadScriptBriefConfig(projectRoot).catch(() => null),
      pharosContext: await loadOrBuildProjectPharosContext({
        projectRoot,
        includedTripIds: (await loadProjectBriefConfig(projectRoot).catch(() => null))?.pharos?.includedTripIds ?? [],
      }).catch(() => null),
      workspaceStyleSources: await loadStyleSourcesConfig(workspaceRoot).catch(() => null),
    }, null, 2));
  } else if (payload.jobType === 'style-analysis') {
    await writeFileSafe(configSnapshotPath, JSON.stringify({
      workspaceStyleSources: await loadStyleSourcesConfig(workspaceRoot).catch(() => null),
    }, null, 2));
  }

  const record: ISupervisorJobRecord = {
    jobId,
    jobType: payload.jobType,
    executionMode: payload.jobType === 'style-analysis'
      ? 'agent'
      : 'deterministic',
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

async function applyCaptureTimeReviewResolution(
  projectRoot: string,
  review: Awaited<ReturnType<typeof resolveReviewItem>> extends infer T ? NonNullable<T> : never,
): Promise<void> {
  const config = await loadManualItineraryConfig(projectRoot);
  const correctedDate = review.fields.find(field => field.key === 'correctedDate')?.value?.trim();
  const correctedTime = review.fields.find(field => field.key === 'correctedTime')?.value?.trim();
  const timezone = review.fields.find(field => field.key === 'timezone')?.value?.trim();
  const key = `${(review.rootRef ?? '').trim().toLowerCase()}::${normalizePortablePath(review.sourcePath ?? '')}`;
  const existingByKey = new Map(config.captureTimeOverrides.map(item => [
    `${(item.rootRef ?? '').trim().toLowerCase()}::${normalizePortablePath(item.sourcePath)}`,
    item,
  ]));
  const current = existingByKey.get(key);
  const next = {
    rootRef: review.rootRef,
    sourcePath: review.sourcePath ?? current?.sourcePath ?? '',
    currentCapturedAt: current?.currentCapturedAt,
    currentSource: current?.currentSource,
    suggestedDate: current?.suggestedDate,
    suggestedTime: current?.suggestedTime,
    correctedDate,
    correctedTime,
    timezone,
    note: review.note ?? current?.note,
  };
  existingByKey.set(key, next);
  await saveManualItineraryConfig(projectRoot, {
    ...config,
    captureTimeOverrides: [...existingByKey.values()],
  });
}

async function syncCaptureTimeReviewsFromConfig(projectId: string, projectRoot: string): Promise<void> {
  const config = await loadManualItineraryConfig(projectRoot);
  const queue = await loadReviewQueue(projectRoot);
  const preserved = queue.items.filter(item => item.kind !== 'capture-time-correction');
  const now = new Date().toISOString();
  const captureItems = config.captureTimeOverrides.map(item => ({
    id: `capture-time:${(item.rootRef ?? '').trim().toLowerCase()}::${normalizePortablePath(item.sourcePath)}`,
    projectId,
    kind: 'capture-time-correction' as const,
    stage: 'ingest' as const,
    status: item.correctedDate && item.correctedTime ? 'resolved' as const : 'open' as const,
    title: `校正素材拍摄时间：${item.sourcePath}`,
    reason: item.note ?? '当前拍摄时间与项目时间线明显不一致。',
    sourcePath: item.sourcePath,
    rootRef: item.rootRef,
    currentValue: {
      currentCapturedAt: item.currentCapturedAt ?? '',
      currentSource: item.currentSource ?? '',
    },
    suggestedValue: {
      suggestedDate: item.suggestedDate ?? '',
      suggestedTime: item.suggestedTime ?? '',
      timezone: item.timezone ?? '',
    },
    fields: [
      { key: 'correctedDate', label: '正确日期', value: item.correctedDate, suggestedValue: item.suggestedDate, required: true },
      { key: 'correctedTime', label: '正确时间', value: item.correctedTime, suggestedValue: item.suggestedTime, required: true },
      { key: 'timezone', label: '时区', value: item.timezone, suggestedValue: item.timezone },
    ],
    note: item.note,
    createdAt: now,
    updatedAt: now,
    resolvedAt: item.correctedDate && item.correctedTime ? now : undefined,
  }));
  await writeFileSafe(join(projectRoot, 'config', 'review-queue.json'), JSON.stringify({
    items: [...preserved, ...captureItems],
  }, null, 2));
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

async function loadJobsWithProgress(workspaceRoot: string): Promise<Array<ISupervisorJobRecord & { progress: unknown }>> {
  const jobs = await listJobRecords(workspaceRoot);
  const hydrated = await Promise.all(jobs.map(async job => ({
    ...job,
    progress: job.progressPath ? await readJsonFile(job.progressPath) : null,
  })));
  return hydrated;
}

function sendJson(response: ServerResponse, statusCode: number, data: unknown): void {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(data, null, 2));
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

function normalizePortablePath(value: string): string {
  return value.replace(/\\/gu, '/').replace(/^\.?\//u, '').replace(/\/+/gu, '/').toLowerCase();
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
