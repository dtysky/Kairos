import { execFile, type ExecFileOptionsWithStringEncoding } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type {
  IColorGroupsSnapshotFile,
  IColorRenderPreset,
} from '../../protocol/schema.js';

const exec = promisify(execFile);

type IExecFile = (
  file: string,
  args: readonly string[],
  options: ExecFileOptionsWithStringEncoding,
) => Promise<{ stdout: string; stderr: string }>;

export interface IColorExecutorPrepareRootInput {
  projectId: string;
  rootId: string;
  resolveProjectName: string;
  rootNamespace: string;
  gradingTimelineName: string;
  rawPath: string;
  rawLocalPath: string;
}

export interface IColorExecutorPrepareRootResult {
  resolveProjectName: string;
  gradingTimelineName: string;
  mirrorStatus: 'ready' | 'synced';
  timelineStatus: 'ready';
  hostSummary?: Record<string, unknown>;
}

export interface IColorExecutorSyncGroupsInput {
  projectId: string;
  rootId: string;
  resolveProjectName: string;
  gradingTimelineName: string;
  rawPath: string;
  rawLocalPath: string;
}

export interface IColorExecutorSyncGroupsResult extends IColorGroupsSnapshotFile {}

export interface IColorExecutorExecuteGroupInput {
  projectId: string;
  rootId: string;
  groupKey: string;
  resolveProjectName: string;
  gradingTimelineName: string;
  renderPreset: IColorRenderPreset;
  stagingRoot: string;
  clips: Array<{
    rawRelativePath: string;
    sourceAbsolutePath: string;
  }>;
}

export interface IColorExecutorExecuteGroupResult {
  renderedAt: string;
  entries: Array<{
    rawRelativePath: string;
    outputPath: string;
    normalizedOutputFilename: string;
    hostSummary?: Record<string, unknown>;
  }>;
  hostSummary?: Record<string, unknown>;
}

export interface IColorExecutor {
  prepareRoot(input: IColorExecutorPrepareRootInput): Promise<IColorExecutorPrepareRootResult>;
  syncGroups(input: IColorExecutorSyncGroupsInput): Promise<IColorExecutorSyncGroupsResult>;
  executeGroup(input: IColorExecutorExecuteGroupInput): Promise<IColorExecutorExecuteGroupResult>;
}

export interface IResolveColorExecutorConfig {
  pythonPath?: string;
  scriptApiRoot?: string;
  scriptPath?: string;
  workingDirectory?: string;
  timeoutMs?: number;
}

export class ResolveColorExecutorUnavailableError extends Error {
  constructor(message = 'Color Resolve host requires config/runtime.json resolveColorPythonPath') {
    super(message);
    this.name = 'ResolveColorExecutorUnavailableError';
  }
}

export class ResolveColorHostError extends Error {
  readonly code: string;
  readonly requestPath: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly details?: unknown;

  constructor(input: {
    message: string;
    code: string;
    requestPath: string;
    stdout?: string;
    stderr?: string;
    details?: unknown;
  }) {
    super(input.message);
    this.name = 'ResolveColorHostError';
    this.code = input.code;
    this.requestPath = input.requestPath;
    this.stdout = input.stdout ?? '';
    this.stderr = input.stderr ?? '';
    this.details = input.details;
  }
}

export class PythonResolveColorExecutor implements IColorExecutor {
  constructor(
    private readonly config: IResolveColorExecutorConfig = {},
    private readonly execFileImpl: IExecFile = exec,
  ) {}

  async prepareRoot(input: IColorExecutorPrepareRootInput): Promise<IColorExecutorPrepareRootResult> {
    return this.runRequest<IColorExecutorPrepareRootResult>({
      operation: 'prepare_root',
      input,
    });
  }

  async syncGroups(input: IColorExecutorSyncGroupsInput): Promise<IColorExecutorSyncGroupsResult> {
    return this.runRequest<IColorExecutorSyncGroupsResult>({
      operation: 'sync_groups',
      input,
    });
  }

  async executeGroup(input: IColorExecutorExecuteGroupInput): Promise<IColorExecutorExecuteGroupResult> {
    return this.runRequest<IColorExecutorExecuteGroupResult>({
      operation: 'execute_group',
      input,
    });
  }

  private async runRequest<T>(payload: {
    operation: 'prepare_root' | 'sync_groups' | 'execute_group';
    input: unknown;
  }): Promise<T> {
    const pythonPath = resolveColorPythonInvocation(this.config);
    const scriptPath = resolveColorScriptPath(this.config.scriptPath);
    const requestRoot = await mkdtemp(join(tmpdir(), 'kairos-resolve-color-'));
    const requestPath = join(requestRoot, 'request.json');
    await writeFile(requestPath, JSON.stringify({
      operation: payload.operation,
      scriptApiRoot: this.config.scriptApiRoot?.trim() || undefined,
      input: payload.input,
    }, null, 2), 'utf-8');

    try {
      const { stdout } = await this.execFileImpl(
        pythonPath,
        [scriptPath, '--request', requestPath],
        {
          cwd: resolveColorWorkingDirectory(this.config),
          encoding: 'utf8',
          maxBuffer: 10 * 1024 * 1024,
          timeout: this.config.timeoutMs ?? 10 * 60 * 1000,
          windowsHide: true,
        },
      );
      return parseResolveHostPayload<T>(stdout);
    } catch (error) {
      throw toResolveHostError(error, requestPath);
    } finally {
      await rm(requestRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

export function resolveColorPythonInvocation(config: IResolveColorExecutorConfig = {}): string {
  const explicit = config.pythonPath?.trim();
  if (!explicit) {
    throw new ResolveColorExecutorUnavailableError(
      'Color Resolve host requires config/runtime.json resolveColorPythonPath.',
    );
  }
  return explicit;
}

export function resolveColorScriptPath(scriptPath?: string): string {
  return resolve(scriptPath ?? join(process.cwd(), 'scripts', 'resolve-color-host.py'));
}

function resolveColorWorkingDirectory(config: IResolveColorExecutorConfig): string {
  return config.workingDirectory?.trim()
    ? resolve(config.workingDirectory)
    : dirname(resolveColorScriptPath(config.scriptPath));
}

function parseResolveHostPayload<T>(raw: string): T {
  const payload = parseJsonPayload(raw, 'stdout');
  if (!payload || typeof payload !== 'object') {
    throw new Error('Resolve color host did not return a JSON payload.');
  }
  return payload as T;
}

function toResolveHostError(error: unknown, requestPath: string): ResolveColorHostError {
  const cause = error as {
    message?: string;
    stdout?: string;
    stderr?: string;
  };
  const stdout = typeof cause.stdout === 'string' ? cause.stdout : '';
  const stderr = typeof cause.stderr === 'string' ? cause.stderr : '';
  const payload = parseJsonPayload(stderr, 'stderr') ?? parseJsonPayload(stdout, 'stdout');
  const details = payload && typeof payload === 'object' ? payload : undefined;
  const message = (
    details
    && typeof details === 'object'
    && 'message' in details
    && typeof details.message === 'string'
  )
    ? details.message
    : cause.message ?? 'Resolve color host request failed.';
  const code = (
    details
    && typeof details === 'object'
    && 'code' in details
    && typeof details.code === 'string'
  )
    ? details.code
    : 'resolve_color_host_failed';

  return new ResolveColorHostError({
    message,
    code,
    requestPath,
    stdout,
    stderr,
    details,
  });
}

function parseJsonPayload(raw: string, channel: 'stdout' | 'stderr'): unknown | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    throw new Error(`Resolve color host returned non-JSON ${channel}: ${trimmed}`);
  }
}
