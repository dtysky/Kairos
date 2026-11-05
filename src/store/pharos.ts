import { access, mkdir, readdir, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve } from 'node:path';
import { IProjectPharosContext } from '../protocol/schema.js';
import { readJsonOrNull, writeJson } from './writer.js';
import { loadProjectBriefConfig } from './workspace-config.js';

export function getProjectPharosRoot(projectRoot: string): string {
  return join(projectRoot, 'pharos');
}

export async function ensureProjectPharosRoot(projectRoot: string): Promise<string> {
  const rootPath = getProjectPharosRoot(projectRoot);
  await mkdir(rootPath, { recursive: true });
  return rootPath;
}

/** Resolve read-only trip inputs. Only the legacy project-local root is created. */
export async function resolveProjectPharosSource(projectRoot: string): Promise<{
  rootPath: string;
  tripRoots: Map<string, string>;
  errors: string[];
}> {
  const config = await loadProjectBriefConfig(projectRoot);
  const sourcePath = config.pharos?.sourcePath?.trim();
  const rootPath = sourcePath
    ? resolve(projectRoot, sourcePath)
    : await ensureProjectPharosRoot(projectRoot);
  const tripRoots = new Map<string, string>();
  try {
    await access(rootPath, constants.R_OK);
    const entries = await readdir(rootPath, { withFileTypes: true });
    if (entries.some(entry => entry.name === 'plan.json' && entry.isFile())) {
      const plan = JSON.parse(await readFile(join(rootPath, 'plan.json'), 'utf8'));
      const tripId = typeof plan?.trip_id === 'string' ? plan.trip_id.trim() : '';
      if (!tripId) throw new Error('plan.json 缺少 trip_id');
      tripRoots.set(tripId, rootPath);
    } else {
      for (const entry of entries.filter(item => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
        tripRoots.set(entry.name, join(rootPath, entry.name));
      }
      if (sourcePath && tripRoots.size === 0) throw new Error('目录内没有 plan.json 或 Trip 子目录');
    }
    return { rootPath, tripRoots, errors: [] };
  } catch (error) {
    return {
      rootPath, tripRoots,
      errors: [`Pharos 目录读取失败：${rootPath}；${error instanceof Error ? error.message : String(error)}`],
    };
  }
}

export function getProjectPharosContextPath(projectRoot: string): string {
  return join(projectRoot, 'analysis', 'pharos-context.json');
}

export async function loadProjectPharosContext(
  projectRoot: string,
): Promise<IProjectPharosContext | null> {
  return readJsonOrNull(
    getProjectPharosContextPath(projectRoot),
    IProjectPharosContext,
  ) as Promise<IProjectPharosContext | null>;
}

export async function writeProjectPharosContext(
  projectRoot: string,
  context: IProjectPharosContext,
): Promise<void> {
  await writeJson(getProjectPharosContextPath(projectRoot), context);
}
