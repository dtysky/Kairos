import { execFile, type ExecFileOptionsWithStringEncoding } from 'node:child_process';
import { access, mkdtemp, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
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
  backend?: 'pyjianyingdraft';
  outputPath?: string;
  draftRoot?: string;
  pythonPath?: string;
  uvPath?: string;
  pyProjectRoot?: string;
  scriptPath?: string;
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
    if (this.config.backend && this.config.backend !== 'pyjianyingdraft') {
      throw new Error(
        `Unsupported Jianying backend '${this.config.backend}'. The local runner only supports 'pyjianyingdraft'.`,
      );
    }

    const outputPath = resolveJianyingOutputPath(spec.project.name, this.config);
    const manifestDir = await mkdtemp(join(tmpdir(), 'kairos-jianying-'));
    const manifestPath = join(manifestDir, 'manifest.json');
    const manifest: IJianyingLocalManifest = {
      version: '1.0',
      backend: 'pyjianyingdraft',
      outputPath,
      spec,
    };
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');

    const invocation = await resolveJianyingPythonInvocation(this.config);
    const scriptPath = resolveJianyingScriptPath(this.config.scriptPath);

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
      const payload = parseCliPayload(stdout);
      const messages = dedupeMessages([
        {
          code: 'pyjianyingdraft_backend',
          level: 'info',
          message: CPYJIANYINGDRAFT_COMPATIBILITY_MESSAGE,
        },
        ...(payload.messages ?? []),
      ]);

      return {
        backend: 'pyjianyingdraft',
        outputPath: payload.outputPath ?? outputPath,
        manifestPath,
        messages,
      };
    } catch (error) {
      throw toExportError(error, manifestPath, outputPath);
    }
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

  return {
    command: config.uvPath?.trim() || 'uv',
    argsPrefix: ['run', '--no-project', ...buildJianyingUvDependencyArgs(), 'python'],
  };
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
  if (config.outputPath?.trim()) {
    return resolve(config.outputPath);
  }

  const draftRoot = config.draftRoot?.trim() || inferDefaultJianyingDraftRoot();
  if (!draftRoot) {
    throw new Error(
      'No Jianying draft root configured. Set outputPath or draftRoot (or configure jianyingDraftRoot in runtime config).',
    );
  }

  return resolve(join(draftRoot, sanitizeDraftName(projectName)));
}

export function inferDefaultJianyingDraftRoot(): string | null {
  if (process.platform === 'darwin') {
    return join(homedir(), 'Movies', 'JianyingPro', 'User Data', 'Projects', 'com.lveditor.draft');
  }
  if (process.platform === 'win32') {
    return join(homedir(), 'AppData', 'Local', 'JianyingPro', 'User Data', 'Projects', 'com.lveditor.draft');
  }
  return null;
}

function resolveJianyingWorkingDirectory(pyProjectRoot?: string): string {
  return dirname(resolveJianyingScriptPath()) || resolveJianyingPyProjectRoot(pyProjectRoot);
}

function buildJianyingUvDependencyArgs(): string[] {
  const deps = ['pymediainfo', 'imageio'];
  if (process.platform === 'win32') {
    deps.push('uiautomation>=2');
  }
  return deps.flatMap(dep => ['--with', dep]);
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

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
