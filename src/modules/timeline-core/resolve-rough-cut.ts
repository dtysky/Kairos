import { execFile, type ExecFileOptionsWithStringEncoding } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import type { IColorResolveProjectSnapshot } from '../../protocol/schema.js';
import {
  ResolveColorHostError,
  resolveColorPythonInvocation,
  resolveColorScriptPath,
} from '../color/resolve-executor.js';

const exec = promisify(execFile);

export interface IResolveTimelineHostConfig {
  backendRoot?: string;
  pythonPath?: string;
  scriptPath?: string;
  workingDirectory?: string;
}

type IExecFile = (
  file: string,
  args: readonly string[],
  options: ExecFileOptionsWithStringEncoding,
) => Promise<{ stdout: string; stderr: string }>;

export interface IResolveRoughCutClipInput {
  clipId: string;
  assetId: string;
  spanId?: string;
  spanType?: string;
  rawRelativePath?: string;
  eventId?: string;
  eventTitle?: string;
  eventKind?: string;
  assetKind: 'video' | 'photo' | 'audio';
  sourceAbsolutePath: string;
  sourceStem: string;
  fps?: number;
  sourceInMs?: number;
  sourceOutMs?: number;
  timelineInMs: number;
  timelineOutMs: number;
  audioGainDb: number;
  muteAudio: boolean;
  speed: number;
  requestedSpeed?: number;
}

export interface IResolveRoughCutMediaSyncInput {
  projectId: string;
  resolveProjectName: string;
  namespace?: string;
  legacyNamespaces?: string[];
  clips: Array<Pick<IResolveRoughCutClipInput,
    'assetId'
    | 'rawRelativePath'
    | 'eventId'
    | 'eventTitle'
    | 'eventKind'
    | 'assetKind'
    | 'sourceAbsolutePath'
    | 'sourceStem'
  >>;
}

export interface IResolveRoughCutTimelineInput {
  projectId: string;
  resolveProjectName: string;
  timelineName: string;
  legacyTimelineNames?: string[];
  timelineFolderName?: string;
  namespace?: string;
  legacyNamespaces?: string[];
  timelineSpec: {
    width: number;
    height: number;
    fps: number;
  };
  stillDurationMs?: number;
  clips: IResolveRoughCutClipInput[];
}

export interface IResolveRoughCutMediaSyncResult {
  resolveProjectName: string;
  namespace: string;
  createdAt: string;
  hostSummary?: Record<string, unknown>;
}

export interface IResolveRoughCutTimelineResult {
  resolveProjectName: string;
  timelineName: string;
  createdAt: string;
  clipCount: number;
  drpSnapshot?: IColorResolveProjectSnapshot;
  drpSnapshotWarning?: string;
  hostSummary?: Record<string, unknown>;
}

export interface IResolveEditMediaRelinkRoot {
  rootId: string;
  label?: string;
  localPath: string;
  candidates: string[];
}

export interface IResolveEditMediaRelinkInput {
  projectId: string;
  resolveProjectName: string;
  namespace?: string;
  timelineName?: string;
  timelineTrackTypes?: Array<'video' | 'audio'>;
  timelineCountUnmapped?: boolean;
  roots: IResolveEditMediaRelinkRoot[];
}

export interface IResolveEditMediaRelinkResult {
  resolveProjectName: string;
  namespace: string;
  timelineName?: string;
  createdAt: string;
  hostSummary?: Record<string, unknown>;
}

export async function syncResolveRoughCutMedia(
  input: IResolveRoughCutMediaSyncInput,
  config: IResolveTimelineHostConfig = {},
  execFileImpl: IExecFile = exec,
): Promise<IResolveRoughCutMediaSyncResult> {
  return runResolveTimelineRequest<IResolveRoughCutMediaSyncResult>({
    operation: 'sync_rough_cut_media',
    input,
    config,
    execFileImpl,
  });
}

export async function createResolveRoughCutTimeline(
  input: IResolveRoughCutTimelineInput,
  config: IResolveTimelineHostConfig = {},
  execFileImpl: IExecFile = exec,
): Promise<IResolveRoughCutTimelineResult> {
  return runResolveTimelineRequest<IResolveRoughCutTimelineResult>({
    operation: 'create_rough_cut_timeline',
    input,
    config,
    execFileImpl,
  });
}

export async function relinkResolveEditMedia(
  input: IResolveEditMediaRelinkInput,
  config: IResolveTimelineHostConfig = {},
  execFileImpl: IExecFile = exec,
): Promise<IResolveEditMediaRelinkResult> {
  return runResolveTimelineRequest<IResolveEditMediaRelinkResult>({
    operation: 'relink_edit_media',
    input,
    config,
    execFileImpl,
  });
}

async function runResolveTimelineRequest<T>(request: {
  operation: 'create_rough_cut_timeline' | 'sync_rough_cut_media' | 'relink_edit_media';
  input: unknown;
  config: IResolveTimelineHostConfig;
  execFileImpl: IExecFile;
}): Promise<T> {
  const pythonPath = resolveColorPythonInvocation(request.config);
  const scriptPath = resolveColorScriptPath(request.config.scriptPath, request.config.backendRoot);
  const requestRoot = await mkdtemp(join(tmpdir(), 'kairos-resolve-timeline-'));
  const requestPath = join(requestRoot, 'request.json');
  await writeFile(requestPath, JSON.stringify({
    operation: request.operation,
    input: request.input,
  }, null, 2), 'utf-8');

  try {
    const { stdout } = await request.execFileImpl(
      pythonPath,
      [scriptPath, '--request', requestPath],
        {
          cwd: request.config.workingDirectory?.trim()
            ? request.config.workingDirectory.trim()
            : dirname(scriptPath),
          env: {
            ...process.env,
            PYTHONIOENCODING: 'utf-8',
          },
          encoding: 'utf8',
          maxBuffer: 10 * 1024 * 1024,
          windowsHide: true,
      },
    );
    return parseResolveTimelinePayload<T>(stdout);
  } catch (error) {
    throw toResolveTimelineHostError(error, requestPath);
  } finally {
    await rm(requestRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

function parseResolveTimelinePayload<T>(raw: string): T {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error('Resolve timeline host did not return a JSON payload.');
  }
  const payload = JSON.parse(trimmed);
  if (!payload || typeof payload !== 'object') {
    throw new Error('Resolve timeline host returned a non-object JSON payload.');
  }
  return payload as T;
}

function toResolveTimelineHostError(error: unknown, requestPath: string): ResolveColorHostError {
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
  const details = tryParseJsonPayload(stderr) ?? tryParseJsonPayload(stdout);
  const message = (
    details
    && typeof details === 'object'
    && 'message' in details
    && typeof details.message === 'string'
  )
    ? details.message
    : cause.message ?? 'Resolve timeline host request failed.';
  const code = (
    details
    && typeof details === 'object'
    && 'code' in details
    && typeof details.code === 'string'
  )
    ? details.code
    : inferResolveTimelineHostErrorCode(cause);

  return new ResolveColorHostError({
    message,
    code,
    requestPath,
    stdout,
    stderr,
    details,
  });
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

function inferResolveTimelineHostErrorCode(cause: {
  code?: string | number | null;
  message?: string;
}): string {
  if (typeof cause.code === 'string' && ['ENOENT', 'EACCES', 'ECONNREFUSED', 'ECONNRESET'].includes(cause.code)) {
    return 'resolve_timeline_host_connection_failed';
  }
  return 'resolve_timeline_host_failed';
}
