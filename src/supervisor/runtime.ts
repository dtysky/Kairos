import { access, mkdir, readFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { spawn, execFile as execFileCallback, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { promisify } from 'node:util';
import nodeFetch from 'node-fetch';
import {
  getSupervisorServiceRoot,
  loadServiceRecord,
  writeServiceRecord,
  type ISupervisorServiceRecord,
} from './state.js';

const execFile = promisify(execFileCallback);
const fetchCompat: typeof fetch = typeof globalThis.fetch === 'function'
  ? globalThis.fetch.bind(globalThis)
  : ((
    input: Parameters<typeof nodeFetch>[0],
    init?: Parameters<typeof nodeFetch>[1],
  ) => nodeFetch(input, init)) as typeof fetch;

export interface IMlServiceConfig {
  host: string;
  port: number;
  pythonPath: string;
  workingDirectory: string;
  stdoutPath: string;
  stderrPath: string;
  healthUrl: string;
  command: string[];
}

const CASR_WORKER_PREFERRED_PORT = 8911;

type TAsrWorkerRuntime = NonNullable<ISupervisorServiceRecord['asrWorker']>;

function resolveAsrWorkerConfig(workspaceRoot: string, port: number) {
  const serviceRoot = getSupervisorServiceRoot(workspaceRoot, 'ml');
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    pythonPath: join(workspaceRoot, '.venv-asr', 'Scripts', 'python.exe'),
    workingDirectory: join(workspaceRoot, 'ml-server'),
    stdoutPath: join(serviceRoot, 'asr-worker-stdout.log'),
    stderrPath: join(serviceRoot, 'asr-worker-stderr.log'),
    command: ['-m', 'uvicorn', 'kairos_ml.main:app', '--host', '127.0.0.1', '--port', String(port)],
  };
}

export function resolveMlServiceConfig(workspaceRoot: string): IMlServiceConfig {
  const host = '127.0.0.1';
  const port = 8910;
  const serviceRoot = getSupervisorServiceRoot(workspaceRoot, 'ml');
  const pythonPath = process.platform === 'win32'
    ? join(workspaceRoot, '.venv-ml', 'Scripts', 'python.exe')
    : join(workspaceRoot, '.venv-ml', 'bin', 'python');

  return {
    host,
    port,
    pythonPath,
    workingDirectory: join(workspaceRoot, 'ml-server'),
    stdoutPath: join(serviceRoot, 'stdout.log'),
    stderrPath: join(serviceRoot, 'stderr.log'),
    healthUrl: `http://${host}:${port}/health`,
    command: ['-m', 'uvicorn', 'kairos_ml.main:app', '--host', host, '--port', String(port)],
  };
}

export async function ensureMlServiceRunning(workspaceRoot: string): Promise<ISupervisorServiceRecord> {
  const status = await getMlServiceStatus(workspaceRoot);
  if (status.status === 'running') {
    return status;
  }
  return startMlService(workspaceRoot);
}

export function shouldReuseExistingMlService(input: {
  listenerPid: number | null;
  health: unknown;
}): boolean {
  return Boolean(input.listenerPid && input.health);
}

export function shouldStopExistingMlService(input: {
  recordListenerPid?: number;
  listenerPid: number | null;
  health: unknown;
}): boolean {
  return Boolean(
    input.listenerPid
      && (input.recordListenerPid === input.listenerPid || input.health),
  );
}

export async function startMlService(workspaceRoot: string): Promise<ISupervisorServiceRecord> {
  const config = resolveMlServiceConfig(workspaceRoot);
  await mkdir(getSupervisorServiceRoot(workspaceRoot, 'ml'), { recursive: true });
  const existing = await loadServiceRecord(workspaceRoot, 'ml');
  const existingListenerPid = await findPortListenerPid(config.port);
  const existingHealth = existingListenerPid
    ? await waitForJson(config.healthUrl, 2_000).catch(() => null)
    : null;

  if (shouldReuseExistingMlService({ listenerPid: existingListenerPid, health: existingHealth })) {
    const running: ISupervisorServiceRecord = {
      name: 'ml',
      status: 'running',
      port: config.port,
      url: `http://${config.host}:${config.port}/`,
      launcherPid: existing?.launcherPid,
      listenerPid: existingListenerPid ?? undefined,
      command: existing?.command ?? [config.pythonPath, ...config.command],
      cwd: config.workingDirectory,
      startedAt: existing?.startedAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      stdoutPath: config.stdoutPath,
      stderrPath: config.stderrPath,
      health: existingHealth,
      asrWorker: existing?.asrWorker,
    };
    await writeServiceRecord(workspaceRoot, running);
    return running;
  }

  if (existingListenerPid) {
    if (existing?.listenerPid && existing.listenerPid === existingListenerPid) {
      await killPid(existingListenerPid);
    } else {
      throw new Error(`Cannot start Kairos ML service: port ${config.port} is already occupied by another process.`);
    }
  }

  const asrWorker = process.platform === 'win32' && await isQwenAsrConfigured(workspaceRoot)
    ? await startAsrWorker(workspaceRoot, existing?.asrWorker)
    : null;

  const stdout = createWriteStream(config.stdoutPath, { flags: 'w' });
  const stderr = createWriteStream(config.stderrPath, { flags: 'w' });
  const child = spawn(
    config.pythonPath,
    config.command,
    {
      cwd: config.workingDirectory,
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: {
        ...process.env,
        ...(asrWorker ? { KAIROS_ASR_WORKER_URL: asrWorker.url } : {}),
      },
    },
  );
  child.stdout?.pipe(stdout);
  child.stderr?.pipe(stderr);

  const pendingRecord: ISupervisorServiceRecord = {
    name: 'ml',
    status: 'starting',
    port: config.port,
    url: `http://${config.host}:${config.port}/`,
    launcherPid: child.pid ?? undefined,
    command: [config.pythonPath, ...config.command],
    cwd: config.workingDirectory,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    stdoutPath: config.stdoutPath,
    stderrPath: config.stderrPath,
    asrWorker: asrWorker ?? undefined,
  };
  await writeServiceRecord(workspaceRoot, pendingRecord);

  try {
    const health = await waitForJson(config.healthUrl, 60_000);
    const listenerPid = await findPortListenerPid(config.port);
    const running: ISupervisorServiceRecord = {
      ...pendingRecord,
      status: 'running',
      listenerPid: listenerPid ?? pendingRecord.launcherPid,
      health,
      updatedAt: new Date().toISOString(),
    };
    await writeServiceRecord(workspaceRoot, running);
    return running;
  } catch (error) {
    await terminateChildProcess(child);
    if (asrWorker) await stopAsrWorker(workspaceRoot, asrWorker).catch(() => undefined);
    const failed: ISupervisorServiceRecord = {
      ...pendingRecord,
      status: 'error',
      updatedAt: new Date().toISOString(),
      lastError: error instanceof Error ? error.message : String(error),
    };
    await writeServiceRecord(workspaceRoot, failed);
    throw error;
  }
}

export async function stopMlService(workspaceRoot: string): Promise<ISupervisorServiceRecord> {
  const config = resolveMlServiceConfig(workspaceRoot);
  const record = await loadServiceRecord(workspaceRoot, 'ml');
  const listenerPid = await findPortListenerPid(config.port);
  const health = listenerPid
    ? await waitForJson(config.healthUrl, 2_000).catch(() => null)
    : null;
  const shouldStop = shouldStopExistingMlService({
    recordListenerPid: record?.listenerPid,
    listenerPid,
    health,
  });

  if (listenerPid && shouldStop) {
    await killPid(listenerPid);
  }
  await stopAsrWorker(workspaceRoot, record?.asrWorker);

  const stopped: ISupervisorServiceRecord = {
    name: 'ml',
    status: 'stopped',
    port: config.port,
    url: `http://${config.host}:${config.port}/`,
    command: record?.command,
    cwd: config.workingDirectory,
    stdoutPath: config.stdoutPath,
    stderrPath: config.stderrPath,
    updatedAt: new Date().toISOString(),
    lastError: listenerPid && !shouldStop
      ? `Port ${config.port} is occupied by a non-Kairos process; left untouched.`
      : undefined,
  };
  await writeServiceRecord(workspaceRoot, stopped);
  return stopped;
}

async function startAsrWorker(
  workspaceRoot: string,
  trackedWorker?: TAsrWorkerRuntime,
): Promise<TAsrWorkerRuntime> {
  const existingHealth = trackedWorker
    ? await waitForJson(`${trackedWorker.url}/health`, 2_000).catch(() => null)
    : null;
  if (trackedWorker && isQwenAsrWorkerHealth(existingHealth)) {
    const listenerPid = await findPortListenerPid(trackedWorker.port);
    return {
      ...trackedWorker,
      listenerPid: listenerPid ?? trackedWorker.listenerPid,
    };
  }

  const port = await selectAvailableLoopbackPort();
  const config = resolveAsrWorkerConfig(workspaceRoot, port);
  await access(config.pythonPath).catch(() => {
    throw new Error(`Missing Windows Qwen ASR runtime: ${config.pythonPath}`);
  });

  const stdout = createWriteStream(config.stdoutPath, { flags: 'w' });
  const stderr = createWriteStream(config.stderrPath, { flags: 'w' });
  const child = spawn(config.pythonPath, config.command, {
    cwd: config.workingDirectory,
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...process.env, KAIROS_ASR_WORKER_URL: '' },
  });
  child.stdout?.pipe(stdout);
  child.stderr?.pipe(stderr);
  try {
    const health = await waitForJson(`${config.url}/health`, 60_000);
    if (!isQwenAsrWorkerHealth(health)) {
      throw new Error(`Port ${config.port} did not expose a Kairos Qwen ASR worker.`);
    }
    const listenerPid = await findPortListenerPid(config.port);
    return {
      port: config.port,
      url: config.url,
      launcherPid: child.pid ?? undefined,
      listenerPid: listenerPid ?? child.pid ?? undefined,
    };
  } catch (error) {
    await terminateChildProcess(child);
    throw error;
  }
}

async function stopAsrWorker(
  workspaceRoot: string,
  trackedWorker?: TAsrWorkerRuntime,
): Promise<void> {
  if (process.platform !== 'win32') return;
  const worker = trackedWorker ?? (await loadServiceRecord(workspaceRoot, 'ml'))?.asrWorker;
  if (!worker) return;
  const listenerPid = await findPortListenerPid(worker.port);
  if (!listenerPid) return;
  const health = await waitForJson(`${worker.url}/health`, 2_000).catch(() => null);
  const isTrackedPid = listenerPid === worker.listenerPid || listenerPid === worker.launcherPid;
  if (isQwenAsrWorkerHealth(health) || isTrackedPid) await killPid(listenerPid);
}

function isQwenAsrWorkerHealth(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const health = value as {
    status?: unknown;
    asr?: { configuredBackend?: unknown; actualBackend?: unknown; runtimeVariant?: unknown };
  };
  return health.status === 'ok'
    && health.asr?.configuredBackend === 'qwen3'
    && health.asr.actualBackend === 'qwen3'
    && typeof health.asr.runtimeVariant === 'string';
}

async function isQwenAsrConfigured(workspaceRoot: string): Promise<boolean> {
  try {
    const raw = JSON.parse(await readFile(join(workspaceRoot, 'config', 'runtime.json'), 'utf8')) as {
      asr?: { backend?: unknown };
    };
    return raw.asr?.backend === 'qwen3';
  } catch {
    return false;
  }
}

export async function getMlServiceStatus(workspaceRoot: string): Promise<ISupervisorServiceRecord> {
  const config = resolveMlServiceConfig(workspaceRoot);
  const record = await loadServiceRecord(workspaceRoot, 'ml');
  const listenerPid = await findPortListenerPid(config.port);
  const health = listenerPid ? await waitForJson(config.healthUrl, 2_000).catch(() => null) : null;
  const isRunning = Boolean(listenerPid && health);
  const isStarting = !isRunning && record?.status === 'starting';
  const hasExternalOccupant = Boolean(listenerPid && !health && record?.listenerPid !== listenerPid);
  const status: ISupervisorServiceRecord = {
    name: 'ml',
    status: isRunning ? 'running' : (isStarting ? 'starting' : 'stopped'),
    port: config.port,
    url: `http://${config.host}:${config.port}/`,
    launcherPid: record?.launcherPid,
    listenerPid: isRunning ? (listenerPid ?? undefined) : undefined,
    command: record?.command,
    cwd: config.workingDirectory,
    startedAt: record?.startedAt,
    updatedAt: new Date().toISOString(),
    stdoutPath: config.stdoutPath,
    stderrPath: config.stderrPath,
    health: health ?? undefined,
    asrWorker: record?.asrWorker,
    lastError: isRunning
      ? undefined
      : (isStarting
        ? record?.lastError
        : (hasExternalOccupant ? `Port ${config.port} is occupied by a non-Kairos process; treated as stopped.` : undefined)),
  };
  await writeServiceRecord(workspaceRoot, status);
  return status;
}

export async function selectAvailableLoopbackPort(
  preferredPort = CASR_WORKER_PREFERRED_PORT,
): Promise<number> {
  const preferred = await probeLoopbackPort(preferredPort).catch(() => null);
  if (preferred !== null) return preferred;

  const fallback = await probeLoopbackPort(0);
  if (fallback === null) {
    throw new Error('Cannot allocate a loopback port for the Kairos ASR worker.');
  }
  return fallback;
}

async function probeLoopbackPort(port: number): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', () => resolve(null));
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
      const address = server.address();
      const selectedPort = typeof address === 'object' && address ? address.port : null;
      server.close(error => {
        if (error) reject(error);
        else resolve(selectedPort);
      });
    });
  });
}

export async function waitForJson(url: string, timeoutMs: number): Promise<unknown> {
  const startedAt = Date.now();
  let lastError: unknown;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetchCompat(url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      return await response.json();
    } catch (error) {
      lastError = error;
      await sleep(500);
    }
  }

  throw lastError ?? new Error(`Timed out waiting for ${url}`);
}

export async function findPortListenerPid(port: number): Promise<number | null> {
  try {
    if (process.platform === 'win32') {
      const powershellPid = await findWindowsPortListenerPid(port);
      if (powershellPid) return powershellPid;
      return findWindowsPortListenerPidWithNetstat(port);
    }

    const { stdout } = await execFile('sh', ['-lc', `lsof -ti tcp:${port} -sTCP:LISTEN | head -n 1`]);
    const pid = Number(stdout.trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

async function findWindowsPortListenerPid(port: number): Promise<number | null> {
  try {
    const command = [
      '-NoProfile',
      '-Command',
      `(Get-NetTCPConnection -LocalPort ${port} -State Listen | Select-Object -First 1 -ExpandProperty OwningProcess)`,
    ];
    const { stdout } = await execFile('powershell.exe', command, { windowsHide: true });
    const pid = Number(stdout.trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

async function findWindowsPortListenerPidWithNetstat(port: number): Promise<number | null> {
  try {
    const { stdout } = await execFile('netstat', ['-ano', '-p', 'tcp'], { windowsHide: true });
    const lines = stdout.split(/\r?\n/gu);
    for (const line of lines) {
      if (!line.includes(`:${port}`) || !line.includes('LISTENING')) continue;
      const parts = line.trim().split(/\s+/gu);
      const pid = Number(parts.at(-1));
      if (Number.isInteger(pid) && pid > 0) return pid;
    }
    return null;
  } catch {
    return null;
  }
}

export async function killPortOccupant(port: number): Promise<void> {
  const pid = await findPortListenerPid(port);
  if (pid) {
    await killPid(pid);
  }
}

export async function killPid(pid: number): Promise<void> {
  try {
    if (process.platform === 'win32') {
      await execFile('taskkill', ['/PID', String(pid), '/F', '/T'], { windowsHide: true });
      return;
    }
    process.kill(pid, 'SIGKILL');
  } catch {
    // ignore missing processes
  }
}

export async function terminateChildProcess(child: ChildProcess): Promise<void> {
  if (!child.pid) return;
  await killPid(child.pid);
}

async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}
