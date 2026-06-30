import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, chmod, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path';
import { homedir, platform } from 'node:os';

type TResolveAssetStatus = 'installed' | 'missing' | 'outdated' | 'source-missing' | 'failed';
type TResolveAssetsOverallStatus = 'ready' | 'needs-install' | 'blocked';
type TResolveAssetKind = 'file' | 'generated-json';
type TResolveAssetTargetRoot = 'resolve-user-data';
type TGeneratedAssetKind = 'kairos-volc-voiceover-workspace-link';

interface IResolveAssetsManifest {
  schemaVersion?: string;
  assets?: IResolveAssetManifestEntry[];
  cleanup?: IResolveAssetCleanupEntry[];
}

interface IResolveAssetManifestEntry {
  id?: string;
  label?: string;
  kind?: TResolveAssetKind;
  source?: string;
  generator?: TGeneratedAssetKind;
  targetRoot?: TResolveAssetTargetRoot;
  target?: string;
  mode?: 'file' | 'executable';
}

interface IResolveAssetCleanupEntry {
  targetRoot?: TResolveAssetTargetRoot;
  target?: string;
}

export interface IResolveAssetInstallEntry {
  id: string;
  label: string;
  kind: TResolveAssetKind;
  sourcePath?: string;
  targetPath: string;
  sourceHash?: string;
  targetHash?: string;
  status: TResolveAssetStatus;
  installed: boolean;
  needsInstall: boolean;
  updated?: boolean;
  error?: string;
}

export interface IResolveAssetsInstallSummary {
  total: number;
  installed: number;
  missing: number;
  outdated: number;
  sourceMissing: number;
  failed: number;
  updated: number;
}

export interface IResolveAssetsInstallResult {
  status: TResolveAssetsOverallStatus;
  manifestPath: string;
  resolveUserDataRoot: string;
  checkedAt: string;
  installedAt?: string;
  summary: IResolveAssetsInstallSummary;
  entries: IResolveAssetInstallEntry[];
  errors: string[];
}

interface IResolveAssetsInstallOptions {
  workspaceRoot: string;
}

const CRESOLVE_ASSETS_MANIFEST_RELATIVE_PATH = 'config/resolve-assets/manifest.json';
const CRESOLVE_ASSETS_LATEST_RESULT_RELATIVE_PATH = '.tmp/resolve-assets/latest.json';
const CSUPERVISOR_URL = 'http://127.0.0.1:8940';

export async function getResolveAssetsStatus(
  options: IResolveAssetsInstallOptions,
): Promise<IResolveAssetsInstallResult> {
  return inspectResolveAssets(options, false);
}

export async function installResolveAssets(
  options: IResolveAssetsInstallOptions,
): Promise<IResolveAssetsInstallResult> {
  const result = await inspectResolveAssets(options, true);
  if (result.status !== 'ready') {
    const details = result.errors.length > 0
      ? result.errors.join('；')
      : 'Resolve 插件/Effect 安装未通过校验';
    throw new ResolveAssetsInstallError(details, result);
  }
  await writeLatestResult(options.workspaceRoot, result);
  return result;
}

export class ResolveAssetsInstallError extends Error {
  readonly code = 'resolve_assets_install_failed';

  constructor(message: string, readonly details: IResolveAssetsInstallResult) {
    super(message);
    this.name = 'ResolveAssetsInstallError';
  }
}

async function inspectResolveAssets(
  options: IResolveAssetsInstallOptions,
  install: boolean,
): Promise<IResolveAssetsInstallResult> {
  const workspaceRoot = resolve(options.workspaceRoot);
  const manifestPath = join(workspaceRoot, CRESOLVE_ASSETS_MANIFEST_RELATIVE_PATH);
  const resolveUserDataRoot = resolveResolveUserDataRoot();
  const checkedAt = new Date().toISOString();
  let manifest: IResolveAssetsManifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as IResolveAssetsManifest;
  } catch (error) {
    return buildResult({
      manifestPath,
      resolveUserDataRoot,
      checkedAt,
      installedAt: install ? checkedAt : undefined,
      entries: [],
      errors: [`无法读取 Resolve assets manifest：${error instanceof Error ? error.message : String(error)}`],
    });
  }

  if (manifest.schemaVersion !== 'kairos-resolve-assets-manifest-v1') {
    return buildResult({
      manifestPath,
      resolveUserDataRoot,
      checkedAt,
      installedAt: install ? checkedAt : undefined,
      entries: [],
      errors: [`Resolve assets manifest schema 不匹配：${manifest.schemaVersion || 'missing'}`],
    });
  }

  if (install) {
    await applyCleanupEntries(manifest.cleanup ?? [], { workspaceRoot, resolveUserDataRoot });
    await ensureGeneratedAssetRuntimeDirs(workspaceRoot, manifest.assets ?? []);
  }

  const entries: IResolveAssetInstallEntry[] = [];
  const errors: string[] = [];
  for (const rawEntry of manifest.assets ?? []) {
    const inspected = await inspectAsset(rawEntry, {
      workspaceRoot,
      resolveUserDataRoot,
      install,
    });
    entries.push(inspected);
    if (inspected.error) errors.push(`${inspected.id}: ${inspected.error}`);
  }

  const result = buildResult({
    manifestPath,
    resolveUserDataRoot,
    checkedAt,
    installedAt: install ? new Date().toISOString() : undefined,
    entries,
    errors,
  });
  if (install) {
    await writeLatestResult(workspaceRoot, result);
  }
  return result;
}

async function inspectAsset(
  rawEntry: IResolveAssetManifestEntry,
  context: {
    workspaceRoot: string;
    resolveUserDataRoot: string;
    install: boolean;
  },
): Promise<IResolveAssetInstallEntry> {
  const id = normalizeRequiredString(rawEntry.id, 'asset.id');
  const label = rawEntry.label?.trim() || id;
  const kind = rawEntry.kind;
  const targetRoot = rawEntry.targetRoot;
  const target = rawEntry.target;
  const entryBase = {
    id,
    label,
    kind: kind === 'generated-json' ? 'generated-json' as const : 'file' as const,
    targetPath: '',
    installed: false,
    needsInstall: true,
  };

  try {
    if (kind !== 'file' && kind !== 'generated-json') {
      throw new Error(`unsupported asset kind: ${String(kind)}`);
    }
    if (targetRoot !== 'resolve-user-data') {
      throw new Error(`unsupported targetRoot: ${String(targetRoot)}`);
    }
    const targetPath = joinSafe(context.resolveUserDataRoot, normalizeRequiredString(target, 'asset.target'));
    const expected = await buildExpectedAssetContent(rawEntry, context.workspaceRoot);
    const targetHash = await hashReadableFile(targetPath);
    const currentStatus: TResolveAssetStatus = !expected.sourceHash
      ? 'source-missing'
      : !targetHash
        ? 'missing'
        : targetHash === expected.sourceHash
          ? 'installed'
          : 'outdated';

    if (context.install && expected.content && currentStatus !== 'installed') {
      await mkdir(dirname(targetPath), { recursive: true });
      await writeFile(targetPath, expected.content);
      if (rawEntry.mode === 'executable' && platform() !== 'win32') {
        await chmod(targetPath, 0o755).catch(() => undefined);
      }
      const verifiedTargetHash = await hashReadableFile(targetPath);
      if (verifiedTargetHash !== expected.sourceHash) {
        throw new Error('copy verification failed');
      }
      return {
        id,
        label,
        kind,
        sourcePath: expected.sourcePath,
        targetPath,
        sourceHash: expected.sourceHash,
        targetHash: verifiedTargetHash,
        status: 'installed',
        installed: true,
        needsInstall: false,
        updated: true,
      };
    }

    return {
      id,
      label,
      kind,
      sourcePath: expected.sourcePath,
      targetPath,
      sourceHash: expected.sourceHash,
      targetHash,
      status: currentStatus,
      installed: currentStatus === 'installed',
      needsInstall: currentStatus !== 'installed',
    };
  } catch (error) {
    return {
      ...entryBase,
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function buildExpectedAssetContent(
  entry: IResolveAssetManifestEntry,
  workspaceRoot: string,
): Promise<{
  content?: Buffer;
  sourcePath?: string;
  sourceHash?: string;
}> {
  if (entry.kind === 'file') {
    const sourcePath = joinSafe(workspaceRoot, normalizeRequiredString(entry.source, 'asset.source'));
    const content = await readFile(sourcePath).catch(() => undefined);
    if (!content) return { sourcePath };
    return {
      content,
      sourcePath,
      sourceHash: hashBuffer(content),
    };
  }

  if (entry.kind === 'generated-json') {
    if (entry.generator !== 'kairos-volc-voiceover-workspace-link') {
      throw new Error(`unsupported generated asset: ${String(entry.generator)}`);
    }
    const content = Buffer.from(`${JSON.stringify(buildVoiceoverWorkspaceLink(workspaceRoot), null, 2)}\n`, 'utf-8');
    return {
      content,
      sourceHash: hashBuffer(content),
    };
  }

  throw new Error(`unsupported asset kind: ${String(entry.kind)}`);
}

async function applyCleanupEntries(
  entries: IResolveAssetCleanupEntry[],
  context: { workspaceRoot: string; resolveUserDataRoot: string },
): Promise<void> {
  for (const entry of entries) {
    if (entry.targetRoot !== 'resolve-user-data') continue;
    const target = entry.target?.trim();
    if (!target) continue;
    const targetPath = joinSafe(context.resolveUserDataRoot, target);
    await rm(targetPath, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function ensureGeneratedAssetRuntimeDirs(
  workspaceRoot: string,
  entries: IResolveAssetManifestEntry[],
): Promise<void> {
  if (!entries.some(entry => entry.generator === 'kairos-volc-voiceover-workspace-link')) return;
  const ipcRoot = join(workspaceRoot, '.tmp/resolve-volc-voiceover-plugin/ipc');
  await Promise.all([
    mkdir(join(ipcRoot, 'requests'), { recursive: true }),
    mkdir(join(ipcRoot, 'processing'), { recursive: true }),
    mkdir(join(ipcRoot, 'responses'), { recursive: true }),
  ]);
}

function buildVoiceoverWorkspaceLink(workspaceRoot: string): Record<string, string> {
  return {
    workspaceRoot,
    runtimeConfigPath: join(workspaceRoot, 'config/runtime.json'),
    supervisorUrl: CSUPERVISOR_URL,
    ipcRoot: join(workspaceRoot, '.tmp/resolve-volc-voiceover-plugin/ipc'),
  };
}

function buildResult(input: {
  manifestPath: string;
  resolveUserDataRoot: string;
  checkedAt: string;
  installedAt?: string;
  entries: IResolveAssetInstallEntry[];
  errors: string[];
}): IResolveAssetsInstallResult {
  const summary: IResolveAssetsInstallSummary = {
    total: input.entries.length,
    installed: input.entries.filter(entry => entry.status === 'installed').length,
    missing: input.entries.filter(entry => entry.status === 'missing').length,
    outdated: input.entries.filter(entry => entry.status === 'outdated').length,
    sourceMissing: input.entries.filter(entry => entry.status === 'source-missing').length,
    failed: input.entries.filter(entry => entry.status === 'failed').length,
    updated: input.entries.filter(entry => entry.updated).length,
  };
  const status: TResolveAssetsOverallStatus = input.errors.length > 0 || summary.failed > 0 || summary.sourceMissing > 0
    ? 'blocked'
    : summary.missing > 0 || summary.outdated > 0
      ? 'needs-install'
      : 'ready';
  return {
    status,
    manifestPath: input.manifestPath,
    resolveUserDataRoot: input.resolveUserDataRoot,
    checkedAt: input.checkedAt,
    ...(input.installedAt ? { installedAt: input.installedAt } : {}),
    summary,
    entries: input.entries,
    errors: input.errors,
  };
}

function resolveResolveUserDataRoot(): string {
  const currentPlatform = platform();
  if (currentPlatform === 'darwin') {
    return join(homedir(), 'Library/Application Support/Blackmagic Design/DaVinci Resolve');
  }
  if (currentPlatform === 'win32') {
    const appData = process.env.APPDATA || join(homedir(), 'AppData/Roaming');
    return join(appData, 'Blackmagic Design/DaVinci Resolve/Support');
  }
  return join(homedir(), '.local/share/DaVinciResolve');
}

function normalizeRequiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

function joinSafe(root: string, relativePath: string): string {
  if (isAbsolute(relativePath)) {
    throw new Error(`absolute paths are not allowed in Resolve asset manifest: ${relativePath}`);
  }
  const normalized = normalize(relativePath).replace(/\\/gu, sep);
  if (normalized === '..' || normalized.startsWith(`..${sep}`)) {
    throw new Error(`parent traversal is not allowed in Resolve asset manifest: ${relativePath}`);
  }
  const target = resolve(root, normalized);
  const rootWithSeparator = root.endsWith(sep) ? root : `${root}${sep}`;
  if (target !== root && !target.startsWith(rootWithSeparator)) {
    throw new Error(`target escapes Resolve asset root: ${relativePath}`);
  }
  return target;
}

async function hashReadableFile(path: string): Promise<string | undefined> {
  try {
    await access(path, constants.R_OK);
    const fileStat = await stat(path);
    if (!fileStat.isFile()) return undefined;
    return hashBuffer(await readFile(path));
  } catch {
    return undefined;
  }
}

function hashBuffer(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

async function writeLatestResult(workspaceRoot: string, result: IResolveAssetsInstallResult): Promise<void> {
  const targetPath = join(workspaceRoot, CRESOLVE_ASSETS_LATEST_RESULT_RELATIVE_PATH);
  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, `${JSON.stringify(result, null, 2)}\n`, 'utf-8');
}
