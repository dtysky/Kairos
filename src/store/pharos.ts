import { join } from 'node:path';
import { IProjectPharosContext } from '../protocol/schema.js';
import { readJsonOrNull, writeJson } from './writer.js';

export function getProjectPharosRoot(projectRoot: string): string {
  return join(projectRoot, 'pharos');
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
