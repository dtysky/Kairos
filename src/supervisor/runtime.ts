import { mkdir } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { spawn, execFile as execFileCallback, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  getSupervisorServiceRoot,
  loadServiceRecord,
  writeServiceRecord,
  type ISupervisorServiceRecord,
} from './state.js';

const execFile = promisify(execFileCallback);

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

export async function startMlService(workspaceRoot: string): Promise<ISupervisorServiceRecord> {
  const config = resolveMlServiceConfig(workspaceRoot);
  await mkdir(getSupervisorServiceRoot(workspaceRoot, 'ml'), { recursive: true });
  await killPortOccupant(config.port);

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
  const listenerPid = record?.listenerPid ?? await findPortListenerPid(config.port);
  if (listenerPid) {
    await killPid(listenerPid);
  } else {
    await killPortOccupant(config.port);
  }

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
  };
  await writeServiceRecord(workspaceRoot, stopped);
  return stopped;
}

export async function getMlServiceStatus(workspaceRoot: string): Promise<ISupervisorServiceRecord> {
  const config = resolveMlServiceConfig(workspaceRoot);
  const record = await loadServiceRecord(workspaceRoot, 'ml');
  const listenerPid = await findPortListenerPid(config.port);
  const health = listenerPid ? await waitForJson(config.healthUrl, 2_000).catch(() => null) : null;
  const status: ISupervisorServiceRecord = {
    name: 'ml',
    status: listenerPid && health ? 'running' : (record?.status === 'starting' ? 'starting' : 'stopped'),
    port: config.port,
    url: `http://${config.host}:${config.port}/`,
    launcherPid: record?.launcherPid,
    listenerPid: listenerPid ?? record?.listenerPid,
    command: record?.command,
    cwd: config.workingDirectory,
    startedAt: record?.startedAt,
    updatedAt: new Date().toISOString(),
    stdoutPath: config.stdoutPath,
    stderrPath: config.stderrPath,
    health: health ?? undefined,
    lastError: record?.lastError,
  };
  await writeServiceRecord(workspaceRoot, status);
  return status;
}

export async function waitForJson(url: string, timeoutMs: number): Promise<unknown> {
  const startedAt = Date.now();
  let lastError: unknown;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url);
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
