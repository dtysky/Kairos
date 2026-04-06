import { mkdir, readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { writeJson } from '../store/writer.js';

export type TSupervisorServiceName = 'dashboard' | 'ml';
export type TSupervisorServiceStatus = 'stopped' | 'starting' | 'running' | 'error';
export type TSupervisorJobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'blocked' | 'stopped' | 'awaiting_agent';
export type TSupervisorExecutionMode = 'deterministic' | 'agent';

export interface ISupervisorServiceRecord {
  name: TSupervisorServiceName;
  status: TSupervisorServiceStatus;
  port: number;
  url?: string;
  launcherPid?: number;
  listenerPid?: number;
  command?: string[];
  cwd?: string;
  startedAt?: string;
  updatedAt: string;
  health?: unknown;
  stdoutPath?: string;
  stderrPath?: string;
  lastError?: string;
}

export interface ISupervisorJobRecord {
  jobId: string;
  jobType: string;
  executionMode: TSupervisorExecutionMode;
  projectId?: string;
  args: Record<string, unknown>;
  status: TSupervisorJobStatus;
  startedAt?: string;
  finishedAt?: string;
  updatedAt: string;
  pid?: number;
  progressPath?: string;
  stdoutPath?: string;
  stderrPath?: string;
  resultPath?: string;
  blockers: string[];
  restartOf?: string;
  inputSnapshotPath?: string;
  promptSnapshotPath?: string;
  configSnapshotPath?: string;
  lastError?: string;
}

export function getSupervisorRoot(workspaceRoot: string): string {
  return join(workspaceRoot, '.tmp', 'run', 'supervisor');
}

export function getSupervisorServiceRoot(workspaceRoot: string, name: TSupervisorServiceName): string {
  return join(getSupervisorRoot(workspaceRoot), 'services', name);
}

export function getSupervisorServiceStatePath(workspaceRoot: string, name: TSupervisorServiceName): string {
  return join(getSupervisorServiceRoot(workspaceRoot, name), 'service.json');
}

export function getSupervisorJobRoot(workspaceRoot: string, jobId: string): string {
  return join(getSupervisorRoot(workspaceRoot), 'jobs', jobId);
}

export function getSupervisorJobStatePath(workspaceRoot: string, jobId: string): string {
  return join(getSupervisorJobRoot(workspaceRoot, jobId), 'job.json');
}

export async function writeServiceRecord(
  workspaceRoot: string,
  record: ISupervisorServiceRecord,
): Promise<void> {
  await mkdir(dirname(getSupervisorServiceStatePath(workspaceRoot, record.name)), { recursive: true });
  await writeJson(getSupervisorServiceStatePath(workspaceRoot, record.name), record);
}

export async function loadServiceRecord(
  workspaceRoot: string,
  name: TSupervisorServiceName,
): Promise<ISupervisorServiceRecord | null> {
  return readJsonFile<ISupervisorServiceRecord>(getSupervisorServiceStatePath(workspaceRoot, name));
}

export async function listServiceRecords(workspaceRoot: string): Promise<ISupervisorServiceRecord[]> {
  const servicesRoot = join(getSupervisorRoot(workspaceRoot), 'services');
  const entries = await readdir(servicesRoot, { withFileTypes: true }).catch(() => []);
  const items: ISupervisorServiceRecord[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const record = await readJsonFile<ISupervisorServiceRecord>(join(servicesRoot, entry.name, 'service.json'));
    if (record) items.push(record);
  }
  return items.sort((left, right) => left.name.localeCompare(right.name));
}

export async function writeJobRecord(
  workspaceRoot: string,
  record: ISupervisorJobRecord,
): Promise<void> {
  await mkdir(dirname(getSupervisorJobStatePath(workspaceRoot, record.jobId)), { recursive: true });
  await writeJson(getSupervisorJobStatePath(workspaceRoot, record.jobId), record);
}

export async function loadJobRecord(
  workspaceRoot: string,
  jobId: string,
): Promise<ISupervisorJobRecord | null> {
  return readJsonFile<ISupervisorJobRecord>(getSupervisorJobStatePath(workspaceRoot, jobId));
}

export async function listJobRecords(workspaceRoot: string): Promise<ISupervisorJobRecord[]> {
  const jobsRoot = join(getSupervisorRoot(workspaceRoot), 'jobs');
  const entries = await readdir(jobsRoot, { withFileTypes: true }).catch(() => []);
  const items: ISupervisorJobRecord[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const record = await readJsonFile<ISupervisorJobRecord>(join(jobsRoot, entry.name, 'job.json'));
    if (record) items.push(record);
  }
  return items.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

async function readJsonFile<T>(path: string): Promise<T | null> {
  try {
    const raw = await readFile(path, 'utf-8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}
