import { join } from 'node:path';
import { z } from 'zod';
import type { IKtepScript } from '../protocol/schema.js';
import type { IOutlineSegment } from '../modules/script/outline-builder.js';
import { readJsonOrNull, writeJson } from './writer.js';

const IOutlineFile = z.array(z.any());
const IScriptFile = z.array(z.any());

export function getOutlinePath(projectRoot: string): string {
  return join(projectRoot, 'analysis', 'outline.json');
}

export function getOutlinePromptPath(projectRoot: string): string {
  return join(projectRoot, 'analysis', 'outline-prompt.txt');
}

export function getCurrentScriptPath(projectRoot: string): string {
  return join(projectRoot, 'script', 'current.json');
}

export async function loadOutline(
  projectRoot: string,
): Promise<IOutlineSegment[] | null> {
  return readJsonOrNull(getOutlinePath(projectRoot), IOutlineFile) as Promise<IOutlineSegment[] | null>;
}

export async function writeOutline(
  projectRoot: string,
  outline: IOutlineSegment[],
): Promise<void> {
  await writeJson(getOutlinePath(projectRoot), outline);
}

export async function loadCurrentScript(
  projectRoot: string,
): Promise<IKtepScript[] | null> {
  return readJsonOrNull(getCurrentScriptPath(projectRoot), IScriptFile) as Promise<IKtepScript[] | null>;
}

export async function writeCurrentScript(
  projectRoot: string,
  script: IKtepScript[],
): Promise<void> {
  await writeJson(getCurrentScriptPath(projectRoot), script);
}
