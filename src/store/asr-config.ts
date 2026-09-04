import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  IWorkspaceAsrConfig,
  type IWorkspaceAsrConfig as TWorkspaceAsrConfig,
} from '../protocol/schema.js';
import { writeJson } from './writer.js';

export const CDEFAULT_WORKSPACE_ASR_CONFIG: TWorkspaceAsrConfig = {
  backend: 'whisper',
};

export function getWorkspaceAsrConfigPath(workspaceRoot: string): string {
  return join(workspaceRoot, 'config', 'runtime.json');
}

export async function loadWorkspaceAsrConfig(
  workspaceRoot: string,
): Promise<TWorkspaceAsrConfig> {
  const runtime = await readRuntimeDocument(getWorkspaceAsrConfigPath(workspaceRoot));
  return normalizeWorkspaceAsrConfig(runtime.asr ?? CDEFAULT_WORKSPACE_ASR_CONFIG);
}

export async function saveWorkspaceAsrConfig(
  workspaceRoot: string,
  config: TWorkspaceAsrConfig,
): Promise<TWorkspaceAsrConfig> {
  const normalized = normalizeWorkspaceAsrConfig(config);
  const path = getWorkspaceAsrConfigPath(workspaceRoot);
  const runtime = await readRuntimeDocument(path);
  await writeJson(path, {
    ...runtime,
    asr: normalized,
  });
  return normalized;
}

export function normalizeWorkspaceAsrConfig(
  config: unknown,
): TWorkspaceAsrConfig {
  return IWorkspaceAsrConfig.parse(config);
}

async function readRuntimeDocument(path: string): Promise<Record<string, unknown>> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (error) {
    if (getErrorCode(error) === 'ENOENT') return {};
    throw error;
  }

  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${path} must contain a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function getErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const code = Reflect.get(error, 'code');
  return typeof code === 'string' ? code : undefined;
}
