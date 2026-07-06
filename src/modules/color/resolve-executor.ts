import { execFile, type ExecFileOptionsWithStringEncoding } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type {
  EColorSourceProfile,
  IColorHostPreflight,
  IColorGroupsSnapshotFile,
  IColorResolveProjectSnapshot,
  IColorRenderPreset,
  EColorCastClass,
  EColorExposureSceneClass,
} from '../../protocol/schema.js';
import type {
  IResolveLutSyncSummary,
  TColorProfileSource,
} from './transform-presets.js';

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
  repairDrtPath?: string;
  repairTemplates?: Record<string, string | undefined>;
  timelineSpec?: {
    width: number;
    height: number;
    fps: number;
  };
  lutSyncSummary?: IResolveLutSyncSummary;
  chunkId?: string;
  resetTimeline?: boolean;
  clips: IColorExecutorClipInput[];
}

export interface IColorExecutorPrepareRootResult {
  resolveProjectName: string;
  gradingTimelineName: string;
  mirrorStatus: 'ready' | 'synced';
  timelineStatus: 'ready';
  groupsSnapshot?: IColorGroupsSnapshotFile;
  hostSummary?: Record<string, unknown>;
}

export interface IColorExecutorSyncGroupsInput {
  projectId: string;
  rootId: string;
  resolveProjectName: string;
  gradingTimelineName: string;
  rawPath: string;
  rawLocalPath: string;
  clips: IColorExecutorClipInput[];
}

export interface IColorExecutorSyncGroupsResult extends IColorGroupsSnapshotFile {}

export interface IColorExecutorRelinkMediaRoot {
  rootId: string;
  label?: string;
  localPath: string;
  candidates: string[];
}

export interface IColorExecutorRelinkMediaInput {
  projectId: string;
  rootId: string;
  resolveProjectName: string;
  rootNamespace: string;
  gradingTimelineName: string;
  roots: IColorExecutorRelinkMediaRoot[];
}

export interface IColorExecutorRelinkMediaResult {
  resolveProjectName: string;
  rootNamespace: string;
  gradingTimelineName: string;
  createdAt: string;
  hostSummary?: Record<string, unknown>;
}

export interface IColorExecutorClipInput {
  rawRelativePath: string;
  sourceAbsolutePath: string;
  sourceStem: string;
  capturedAt?: string;
  width?: number;
  height?: number;
  encodedWidth?: number;
  encodedHeight?: number;
  displayWidth?: number;
  displayHeight?: number;
  rotationDegrees?: number;
  orientationStatus?: 'unknown' | 'horizontal' | 'portrait';
  repairTemplateKey?: string;
  previousRepairTemplateHash?: string;
  timelineTransform?: {
    rotationAngle?: number;
    zoomX?: number;
    zoomY?: number;
    zoomGang?: boolean;
    pan?: number;
    tilt?: number;
  };
  gyroDataAvailable?: boolean;
  fps?: number;
  codec?: string;
  rawTags?: Record<string, string>;
  detectedProfile?: EColorSourceProfile;
  effectiveProfile?: string;
  profileSource?: TColorProfileSource;
  logProfile?: EColorSourceProfile;
  gyroEligible?: boolean;
  lowlight?: boolean;
  windshieldHaze?: boolean;
  windshieldHazeConfidence?: number;
  windshieldHazeMetrics?: Record<string, unknown>;
  colorCastClass?: EColorCastClass;
  colorCastConfidence?: number;
  colorCastMetrics?: Record<string, unknown>;
  exposureSceneClass?: EColorExposureSceneClass;
  exposureSceneConfidence?: number;
  exposureSceneMetrics?: Record<string, unknown>;
  deviceFamilyKeys?: string[];
  resolvedTransformPresetKey?: string;
  resolvedLutRelativePath?: string;
  resolvedLutAbsolutePath?: string;
}

export interface IColorExecutorExecuteRootInput {
  projectId: string;
  rootId: string;
  resolveProjectName: string;
  gradingTimelineName: string;
  rawLocalPath: string;
  renderPreset: IColorRenderPreset;
  outputRoot: string;
  selectionMode?: 'all' | 'subset';
  clips: Array<{
    rawRelativePath: string;
    sourceAbsolutePath: string;
    sourceStem: string;
    width?: number;
    height?: number;
    fps?: number;
  }>;
}

export interface IColorExecutorExecuteRootResult {
  renderedAt: string;
  entries: Array<{
    rawRelativePath: string;
    outputPath: string;
    normalizedOutputFilename: string;
    renderJobId?: string;
    hostSummary?: Record<string, unknown>;
  }>;
  renderJobs?: Array<{
    jobId?: string;
    timelineName?: string;
    targetDir: string;
    clipCount?: number;
    duplicateStemGroup?: string;
  }>;
  hostSummary?: Record<string, unknown>;
}

export interface IColorExecutorPreflightInput {
  projectId?: string;
  rootId?: string;
  resolveProjectName?: string;
}

export interface IColorExecutorPreflightResult extends IColorHostPreflight {}

export interface IColorExecutorSaveDrpSnapshotInput {
  projectId: string;
  resolveProjectName: string;
  snapshotRoot: string;
  snapshotLabel?: string;
  latestFilename?: string;
  retention?: 'latest-only' | 'archive';
  action?: string;
  rootId?: string;
  chunkId?: string;
}

export interface IColorExecutorSaveDrpSnapshotResult {
  snapshot: IColorResolveProjectSnapshot;
  hostSummary?: Record<string, unknown>;
}

export interface IColorExecutor {
  preflight(input?: IColorExecutorPreflightInput): Promise<IColorExecutorPreflightResult>;
  relinkMedia(input: IColorExecutorRelinkMediaInput): Promise<IColorExecutorRelinkMediaResult>;
  prepareRoot(input: IColorExecutorPrepareRootInput): Promise<IColorExecutorPrepareRootResult>;
  syncGroups(input: IColorExecutorSyncGroupsInput): Promise<IColorExecutorSyncGroupsResult>;
  executeRoot(input: IColorExecutorExecuteRootInput): Promise<IColorExecutorExecuteRootResult>;
  saveDrpSnapshot(input: IColorExecutorSaveDrpSnapshotInput): Promise<IColorExecutorSaveDrpSnapshotResult>;
}

export interface IResolveColorExecutorConfig {
  backendRoot?: string;
  pythonPath?: string;
  scriptPath?: string;
  workingDirectory?: string;
}

export interface IResolveColorBackendStatus {
  available: boolean;
  backendRoot: string;
  pythonPath: string;
  scriptPath: string;
  missingPaths: string[];
  blockingReason?: string;
}

export class ResolveColorExecutorUnavailableError extends Error {
  constructor(message = inspectResolveColorBackend().blockingReason ?? '未找到 vendored Resolve backend。') {
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

  async preflight(input: IColorExecutorPreflightInput = {}): Promise<IColorExecutorPreflightResult> {
    return this.runRequest<IColorExecutorPreflightResult>({
      operation: 'preflight',
      input,
    });
  }

  async prepareRoot(input: IColorExecutorPrepareRootInput): Promise<IColorExecutorPrepareRootResult> {
    return this.runRequest<IColorExecutorPrepareRootResult>({
      operation: 'prepare_root',
      input,
    });
  }

  async relinkMedia(input: IColorExecutorRelinkMediaInput): Promise<IColorExecutorRelinkMediaResult> {
    return this.runRequest<IColorExecutorRelinkMediaResult>({
      operation: 'relink_color_media',
      input,
    });
  }

  async syncGroups(input: IColorExecutorSyncGroupsInput): Promise<IColorExecutorSyncGroupsResult> {
    return this.runRequest<IColorExecutorSyncGroupsResult>({
      operation: 'sync_groups',
      input,
    });
  }

  async executeRoot(input: IColorExecutorExecuteRootInput): Promise<IColorExecutorExecuteRootResult> {
    return this.runRequest<IColorExecutorExecuteRootResult>({
      operation: 'execute_root',
      input,
    });
  }

  async saveDrpSnapshot(input: IColorExecutorSaveDrpSnapshotInput): Promise<IColorExecutorSaveDrpSnapshotResult> {
    return this.runRequest<IColorExecutorSaveDrpSnapshotResult>({
      operation: 'save_drp_snapshot',
      input,
    });
  }

  private async runRequest<T>(payload: {
    operation: 'preflight' | 'relink_color_media' | 'prepare_root' | 'sync_groups' | 'execute_root' | 'save_drp_snapshot';
    input: unknown;
  }): Promise<T> {
    const pythonPath = resolveColorPythonInvocation(this.config);
    const scriptPath = resolveColorScriptPath(this.config.scriptPath, this.config.backendRoot);
    const requestRoot = await mkdtemp(join(tmpdir(), 'kairos-resolve-color-'));
    const requestPath = join(requestRoot, 'request.json');
    await writeFile(requestPath, JSON.stringify({
      operation: payload.operation,
      input: payload.input,
    }, null, 2), 'utf-8');

    try {
      const { stdout } = await this.execFileImpl(
        pythonPath,
        [scriptPath, '--request', requestPath],
        {
          cwd: resolveColorWorkingDirectory(this.config),
          env: {
            ...process.env,
            PYTHONIOENCODING: 'utf-8',
          },
          encoding: 'utf8',
          maxBuffer: 10 * 1024 * 1024,
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
    const backend = inspectResolveColorBackend(config.backendRoot);
    if (!backend.available) {
      throw new ResolveColorExecutorUnavailableError(backend.blockingReason);
    }
    return backend.pythonPath;
  }
  return explicit;
}

export function resolveColorBackendRoot(backendRoot?: string): string {
  return resolve(backendRoot ?? join(process.cwd(), 'vendor', 'resolve-color-host'));
}

export function getVendoredResolveColorPythonPath(backendRoot = resolveColorBackendRoot()): string {
  return process.platform === 'win32'
    ? join(backendRoot, '.venv', 'Scripts', 'python.exe')
    : join(backendRoot, '.venv', 'bin', 'python');
}

export function resolveColorScriptPath(scriptPath?: string, backendRoot?: string): string {
  return resolve(scriptPath ?? join(resolveColorBackendRoot(backendRoot), 'resolve-color-host.py'));
}

export function inspectResolveColorBackend(backendRoot?: string): IResolveColorBackendStatus {
  const resolvedBackendRoot = resolveColorBackendRoot(backendRoot);
  const pythonPath = getVendoredResolveColorPythonPath(resolvedBackendRoot);
  const scriptPath = resolveColorScriptPath(undefined, resolvedBackendRoot);
  const missingPaths = [scriptPath, pythonPath].filter(path => !existsSync(path));

  return {
    available: missingPaths.length === 0,
    backendRoot: resolvedBackendRoot,
    pythonPath,
    scriptPath,
    missingPaths,
    blockingReason: missingPaths.length > 0
      ? buildMissingResolveColorBackendMessage({
        backendRoot: resolvedBackendRoot,
        pythonPath,
        scriptPath,
      })
      : undefined,
  };
}

function resolveColorWorkingDirectory(config: IResolveColorExecutorConfig): string {
  return config.workingDirectory?.trim()
    ? resolve(config.workingDirectory)
    : dirname(resolveColorScriptPath(config.scriptPath, config.backendRoot));
}

function buildMissingResolveColorBackendMessage(paths: {
  backendRoot: string;
  pythonPath: string;
  scriptPath: string;
}): string {
  return (
    '未找到 vendored Resolve backend。'
    + ` 期望脚本：${paths.scriptPath}；`
    + `期望 Python：${paths.pythonPath}。`
    + ` 请先在 ${paths.backendRoot} 下准备固定 backend 与 .venv。`
  );
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
    code?: string | number | null;
    killed?: boolean;
    signal?: string | null;
    message?: string;
    stdout?: string;
    stderr?: string;
  };
  const stdout = typeof cause.stdout === 'string' ? cause.stdout : '';
  const stderr = typeof cause.stderr === 'string' ? cause.stderr : '';
  const payload = tryParseJsonPayload(stderr) ?? tryParseJsonPayload(stdout);
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
    : inferResolveHostErrorCode(cause);

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

function tryParseJsonPayload(raw: string): unknown | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function inferResolveHostErrorCode(cause: {
  code?: string | number | null;
  message?: string;
}): string {
  if (typeof cause.code === 'string' && ['ENOENT', 'EACCES', 'ECONNREFUSED', 'ECONNRESET'].includes(cause.code)) {
    return 'resolve_color_host_connection_failed';
  }
  return 'resolve_color_host_failed';
}
