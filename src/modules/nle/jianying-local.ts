import { execFile, type ExecFileOptionsWithStringEncoding } from 'node:child_process';
import { access, cp, lstat, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { constants, existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { IJianyingDraftSpec } from './jianying-spec.js';

const exec = promisify(execFile);

export const CPYJIANYINGDRAFT_COMPATIBILITY_MESSAGE =
  'Kairos writes Jianying drafts through the vendored pyJianYingDraft backend and emits `draft_info.json`. Jianying may populate additional companion files after the first successful open.';

export interface IJianyingExportMessage {
  code: string;
  level: 'info' | 'warning';
  message: string;
}

export interface IJianyingExportResult {
  backend: 'pyjianyingdraft';
  outputPath: string;
  stagingPath: string;
  finalPath: string;
  manifestPath: string;
  messages: IJianyingExportMessage[];
}

export interface IJianyingLocalManifest {
  version: '1.0';
  backend: 'pyjianyingdraft';
  outputPath: string;
  spec: IJianyingDraftSpec;
}

export interface IJianyingLocalConfig {
  outputPath?: string;
  draftRoot?: string;
  projectRoot?: string;
  pythonPath?: string;
  pyProjectRoot?: string;
  scriptPath?: string;
}

export interface IJianyingResolvedPaths {
  draftName: string;
  stagingPath: string;
  finalPath: string;
  copyToFinal: boolean;
}

export interface IJianyingPythonInvocation {
  command: string;
  argsPrefix: string[];
}

type IExecFile = (
  file: string,
  args: readonly string[],
  options: ExecFileOptionsWithStringEncoding,
) => Promise<{ stdout: string; stderr: string }>;

export class JianyingLocalExportError extends Error {
  readonly code: string;
  readonly manifestPath: string;
  readonly outputPath: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly details?: unknown;
  readonly messages: IJianyingExportMessage[];

  constructor(input: {
    message: string;
    code: string;
    manifestPath: string;
    outputPath: string;
    stdout?: string;
    stderr?: string;
    details?: unknown;
    messages?: IJianyingExportMessage[];
  }) {
    super(input.message);
    this.name = 'JianyingLocalExportError';
    this.code = input.code;
    this.manifestPath = input.manifestPath;
    this.outputPath = input.outputPath;
    this.stdout = input.stdout ?? '';
    this.stderr = input.stderr ?? '';
    this.details = input.details;
    this.messages = input.messages ?? [];
  }
}

export class JianyingLocalRunner {
  private config: IJianyingLocalConfig;
  private execFile: IExecFile;

  constructor(config: IJianyingLocalConfig = {}, execFileImpl: IExecFile = exec) {
    this.config = config;
    this.execFile = execFileImpl;
  }

  async export(spec: IJianyingDraftSpec): Promise<IJianyingExportResult> {
    const paths = resolveJianyingExportPaths(spec.project.name, this.config);
    await assertSafeJianyingOutputPath(paths.stagingPath);
    if (paths.copyToFinal) {
      await assertSafeJianyingOutputPath(paths.finalPath);
    }

    const prepared = prepareJianyingDraftSpecForBackend(spec);
    const manifestDir = await mkdtemp(join(tmpdir(), 'kairos-jianying-'));
    const manifestPath = join(manifestDir, 'manifest.json');
    const manifest: IJianyingLocalManifest = {
      version: '1.0',
      backend: 'pyjianyingdraft',
      outputPath: paths.stagingPath,
      spec: prepared.spec,
    };
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');

    const invocation = await resolveJianyingPythonInvocation(this.config);
    const scriptPath = resolveJianyingScriptPath(this.config.scriptPath);

    let payload: {
      outputPath?: string;
      messages?: IJianyingExportMessage[];
    };
    try {
      const { stdout } = await this.execFile(
        invocation.command,
        [...invocation.argsPrefix, scriptPath, '--manifest', manifestPath],
        {
          cwd: resolveJianyingWorkingDirectory(this.config.pyProjectRoot),
          encoding: 'utf8',
          maxBuffer: 10 * 1024 * 1024,
          windowsHide: true,
        },
      );
      payload = parseCliPayload(stdout);
    } catch (error) {
      throw toExportError(error, manifestPath, paths.finalPath);
    }

    const stagingPath = payload.outputPath ?? paths.stagingPath;
    const messages = dedupeMessages([
      {
        code: 'pyjianyingdraft_backend',
        level: 'info',
        message: CPYJIANYINGDRAFT_COMPATIBILITY_MESSAGE,
      },
      ...(prepared.adjustedClipCount > 0
        ? [{
          code: 'pyjianying_timing_normalized',
          level: 'info' as const,
          message: (
            `Normalized ${prepared.adjustedClipCount} retimed clip`
            + `${prepared.adjustedClipCount === 1 ? '' : 's'} for pyJianYingDraft timing compatibility.`
          ),
        }]
        : []),
      ...(payload.messages ?? []),
    ]);

    if (paths.copyToFinal) {
      try {
        await cp(stagingPath, paths.finalPath, {
          recursive: true,
          errorOnExist: true,
          force: false,
        });
        messages.push({
          code: 'staging_draft_copied',
          level: 'info',
          message: `Copied staged Jianying draft to '${paths.finalPath}'.`,
        });
      } catch (error) {
        throw toCopyError({
          error,
          manifestPath,
          stagingPath,
          finalPath: paths.finalPath,
          messages,
        });
      }
    }

    return {
      backend: 'pyjianyingdraft',
      outputPath: paths.finalPath,
      stagingPath,
      finalPath: paths.finalPath,
      manifestPath,
      messages: dedupeMessages(messages),
    };
  }
}

export async function resolveJianyingPythonInvocation(
  config: IJianyingLocalConfig = {},
): Promise<IJianyingPythonInvocation> {
  const explicitPython = config.pythonPath?.trim();
  if (explicitPython) {
    return {
      command: explicitPython,
      argsPrefix: [],
    };
  }

  const pyProjectRoot = resolveJianyingPyProjectRoot(config.pyProjectRoot);
  const vendoredPython = getVendoredJianyingPythonPath(pyProjectRoot);
  if (await pathExists(vendoredPython)) {
    return {
      command: vendoredPython,
      argsPrefix: [],
    };
  }

  throw new Error(buildMissingJianyingPythonMessage(vendoredPython));
}

export function getVendoredJianyingPythonPath(pyProjectRoot = resolveJianyingPyProjectRoot()): string {
  return process.platform === 'win32'
    ? join(pyProjectRoot, '.venv', 'Scripts', 'python.exe')
    : join(pyProjectRoot, '.venv', 'bin', 'python');
}

export function resolveJianyingPyProjectRoot(pyProjectRoot?: string): string {
  return resolve(pyProjectRoot ?? join(process.cwd(), 'vendor', 'pyJianYingDraft'));
}

export function resolveJianyingScriptPath(scriptPath?: string): string {
  return resolve(scriptPath ?? join(process.cwd(), 'scripts', 'jianying-export.py'));
}

export function resolveJianyingOutputPath(projectName: string, config: IJianyingLocalConfig = {}): string {
  return resolveJianyingExportPaths(projectName, config).stagingPath;
}

export function resolveJianyingExportPaths(
  projectName: string,
  config: IJianyingLocalConfig = {},
): IJianyingResolvedPaths {
  const explicitOutputPath = config.outputPath?.trim();
  if (explicitOutputPath) {
    const stagingPath = resolve(explicitOutputPath);
    const draftName = basename(stagingPath);
    const configuredDraftRoot = config.draftRoot?.trim();
    const finalPath = configuredDraftRoot
      ? resolve(join(configuredDraftRoot, draftName))
      : stagingPath;
    return {
      draftName,
      stagingPath,
      finalPath,
      copyToFinal: configuredDraftRoot != null && !pathsEqual(stagingPath, finalPath),
    };
  }

  const configuredDraftRoot = config.draftRoot?.trim() || inferDefaultJianyingDraftRoot();
  if (!configuredDraftRoot) {
    throw new Error(
      'No Jianying draft root configured. Set draftRoot (or configure jianyingDraftRoot in runtime config), '
      + 'or pass outputPath explicitly for staging-only export.',
    );
  }

  const draftName = buildDefaultDraftName(projectName);
  const stagingRoot = inferDefaultJianyingStagingRoot(config.projectRoot);
  if (!stagingRoot) {
    const finalPath = resolve(join(configuredDraftRoot, draftName));
    return {
      draftName,
      stagingPath: finalPath,
      finalPath,
      copyToFinal: false,
    };
  }

  return {
    draftName,
    stagingPath: resolve(join(stagingRoot, draftName)),
    finalPath: resolve(join(configuredDraftRoot, draftName)),
    copyToFinal: true,
  };
}

export function inferDefaultJianyingDraftRoot(): string | null {
  if (process.platform === 'darwin') {
    return join(homedir(), 'Movies', 'JianyingPro', 'User Data', 'Projects', 'com.lveditor.draft');
  }
  if (process.platform === 'win32') {
    const commonDraftRoot = 'C:\\Applications\\JianyingPro Drafts';
    if (existsSync(commonDraftRoot)) {
      return commonDraftRoot;
    }
    return join(homedir(), 'AppData', 'Local', 'JianyingPro', 'User Data', 'Projects', 'com.lveditor.draft');
  }
  return null;
}

export function inferDefaultJianyingStagingRoot(projectRoot?: string): string | null {
  const resolvedProjectRoot = projectRoot?.trim();
  if (!resolvedProjectRoot) return null;
  return resolve(join(resolvedProjectRoot, 'adapters', 'jianying-staging'));
}

function resolveJianyingWorkingDirectory(pyProjectRoot?: string): string {
  return dirname(resolveJianyingScriptPath()) || resolveJianyingPyProjectRoot(pyProjectRoot);
}

function buildMissingJianyingPythonMessage(vendoredPython: string): string {
  return (
    'Cannot find Jianying backend Python. '
    + `Create '${vendoredPython}' for the vendored pyJianYingDraft backend `
    + `or set 'jianyingPythonPath' in runtime config.`
  );
}

function parseCliPayload(raw: string): {
  outputPath?: string;
  messages?: IJianyingExportMessage[];
} {
  const payload = parseJsonPayload(raw, 'stdout');
  if (!payload || typeof payload !== 'object') {
    throw new Error('Jianying export did not return a JSON payload.');
  }
  return payload as {
    outputPath?: string;
    messages?: IJianyingExportMessage[];
  };
}

function toExportError(
  error: unknown,
  manifestPath: string,
  outputPath: string,
): JianyingLocalExportError {
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
    details &&
    typeof details === 'object' &&
    'message' in details &&
    typeof details.message === 'string'
  )
    ? details.message
    : cause.message ?? 'Jianying local export failed.';
  const code = (
    details &&
    typeof details === 'object' &&
    'code' in details &&
    typeof details.code === 'string'
  )
    ? details.code
    : 'jianying_export_failed';
  const messages = (
    details &&
    typeof details === 'object' &&
    'messages' in details &&
    Array.isArray(details.messages)
  )
    ? details.messages as IJianyingExportMessage[]
    : [];

  return new JianyingLocalExportError({
    message,
    code,
    manifestPath,
    outputPath,
    stdout,
    stderr,
    details,
    messages,
  });
}

function parseJsonPayload(raw: string, channel: 'stdout' | 'stderr'): unknown | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    throw new Error(`Jianying export returned non-JSON ${channel}: ${trimmed}`);
  }
}

function dedupeMessages(messages: IJianyingExportMessage[]): IJianyingExportMessage[] {
  const seen = new Set<string>();
  return messages.filter(message => {
    const key = `${message.code}:${message.level}:${message.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sanitizeDraftName(projectName: string): string {
  const sanitized = projectName.replace(/[<>:"/\\|?*\u0000-\u001F]/g, '-').trim();
  return sanitized || 'Kairos Draft';
}

function buildDefaultDraftName(projectName: string): string {
  const now = new Date();
  const yyyy = String(now.getFullYear());
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const min = String(now.getMinutes()).padStart(2, '0');
  const sec = String(now.getSeconds()).padStart(2, '0');
  return `${sanitizeDraftName(projectName)}-${yyyy}${mm}${dd}-${hh}${min}${sec}`;
}

function pathsEqual(left: string, right: string): boolean {
  if (process.platform === 'win32') {
    return left.toLowerCase() === right.toLowerCase();
  }
  return left === right;
}

function prepareJianyingDraftSpecForBackend(input: IJianyingDraftSpec): {
  spec: IJianyingDraftSpec;
  adjustedClipCount: number;
} {
  const spec = JSON.parse(JSON.stringify(input)) as IJianyingDraftSpec;
  const adjustedClipCount = normalizeJianyingDraftSpecForBackend(spec);
  return { spec, adjustedClipCount };
}

function normalizeJianyingDraftSpecForBackend(spec: IJianyingDraftSpec): number {
  const clipsByTrack = new Map<string, IJianyingDraftSpec['clips']>();
  for (const clip of spec.clips) {
    const clips = clipsByTrack.get(clip.trackId) ?? [];
    clips.push(clip);
    clipsByTrack.set(clip.trackId, clips);
  }

  let adjustedClipCount = 0;
  for (const clips of clipsByTrack.values()) {
    clips.sort((left, right) => (
      left.targetStartMs - right.targetStartMs
      || left.targetEndMs - right.targetEndMs
      || left.id.localeCompare(right.id)
    ));

    let previousActualEndUs: number | null = null;
    for (const clip of clips) {
      const actualDurationUs = resolveClipTargetDurationUsForBackend(clip);
      const normalizedStartMs: number = previousActualEndUs == null
        ? clip.targetStartMs
        : Math.max(clip.targetStartMs, Math.ceil(previousActualEndUs / 1000));
      const normalizedEndMs: number = Math.max(
        normalizedStartMs + 1,
        normalizedStartMs + Math.ceil(actualDurationUs / 1000),
      );

      if (
        normalizedStartMs !== clip.targetStartMs
        || normalizedEndMs !== clip.targetEndMs
      ) {
        adjustedClipCount += 1;
      }

      clip.targetStartMs = normalizedStartMs;
      clip.targetEndMs = normalizedEndMs;
      previousActualEndUs = normalizedStartMs * 1000 + actualDurationUs;
    }
  }

  return adjustedClipCount;
}

function resolveClipTargetDurationUsForBackend(
  clip: IJianyingDraftSpec['clips'][number],
): number {
  if (
    clip.speed != null
    && clip.sourceInMs != null
    && clip.sourceOutMs != null
  ) {
    return Math.round(((clip.sourceOutMs - clip.sourceInMs) * 1000) / clip.speed);
  }

  return Math.max(1, (clip.targetEndMs - clip.targetStartMs) * 1000);
}

async function assertSafeJianyingOutputPath(outputPath: string): Promise<void> {
  try {
    const stats = await lstat(outputPath);
    if (!stats.isDirectory()) {
      throw new JianyingLocalExportError({
        code: 'unsafe_output_path',
        message: (
          `Refusing to export to existing path '${outputPath}'. `
          + 'Export target must be a brand-new directory because overwrite/delete is disabled.'
        ),
        manifestPath: '',
        outputPath,
      });
    }

    const entries = await readdir(outputPath);
    const detail = entries.length > 0
      ? ` It already contains ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}.`
      : ' The directory already exists.';
    throw new JianyingLocalExportError({
      code: 'unsafe_output_path',
      message: (
        `Refusing to export to existing directory '${outputPath}'. `
        + 'Export target must not already exist because overwrite/delete is disabled.'
        + detail
      ),
      manifestPath: '',
      outputPath,
      details: {
        entryCount: entries.length,
        sampleEntries: entries.slice(0, 10),
      },
    });
  } catch (error) {
    if (getErrorCode(error) === 'ENOENT') {
      return;
    }
    throw error;
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function getErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const code = Reflect.get(error, 'code');
  return typeof code === 'string' ? code : undefined;
}

function toCopyError(input: {
  error: unknown;
  manifestPath: string;
  stagingPath: string;
  finalPath: string;
  messages: IJianyingExportMessage[];
}): JianyingLocalExportError {
  const cause = input.error as { message?: string };
  return new JianyingLocalExportError({
    code: 'jianying_copy_failed',
    message: (
      `Jianying draft was staged at '${input.stagingPath}' but copying it to `
      + `'${input.finalPath}' failed: ${cause?.message ?? 'unknown error'}`
    ),
    manifestPath: input.manifestPath,
    outputPath: input.finalPath,
    details: {
      stagingPath: input.stagingPath,
      finalPath: input.finalPath,
      cause: cause?.message ?? String(input.error),
    },
    messages: input.messages,
  });
}
