import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export const CDEFAULT_EDIT_ID = 'main' as const;

export function normalizeEditId(editId?: string | null): string {
  const trimmed = editId?.trim();
  if (!trimmed) return CDEFAULT_EDIT_ID;
  const normalized = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gu, '-')
    .replace(/-+/gu, '-')
    .replace(/^-|-$/gu, '');
  return normalized || CDEFAULT_EDIT_ID;
}

export function getProjectEditsRoot(projectRoot: string): string {
  return join(projectRoot, 'edits');
}

export function getProjectEditRoot(projectRoot: string, editId?: string | null): string {
  return join(getProjectEditsRoot(projectRoot), normalizeEditId(editId));
}

export function getProjectEditScriptRoot(projectRoot: string, editId?: string | null): string {
  return join(getProjectEditRoot(projectRoot, editId), 'script');
}

export function getProjectEditTimelineRoot(projectRoot: string, editId?: string | null): string {
  return join(getProjectEditRoot(projectRoot, editId), 'timeline');
}

export function getProjectEditSubtitlesRoot(projectRoot: string, editId?: string | null): string {
  return join(getProjectEditRoot(projectRoot, editId), 'subtitles');
}

export function getProjectEditPlanningRoot(projectRoot: string, editId?: string | null): string {
  return join(getProjectEditRoot(projectRoot, editId), 'planning');
}

export function getLegacyScriptRoot(projectRoot: string): string {
  return join(projectRoot, 'script');
}

export function getLegacyTimelineRoot(projectRoot: string): string {
  return join(projectRoot, 'timeline');
}

export function getLegacySubtitlesRoot(projectRoot: string): string {
  return join(projectRoot, 'subtitles');
}

export function shouldReadLegacyEditPath(editId?: string | null): boolean {
  return normalizeEditId(editId) === CDEFAULT_EDIT_ID;
}

export async function ensureProjectEditDirs(
  projectRoot: string,
  editId?: string | null,
): Promise<void> {
  await Promise.all([
    mkdir(getProjectEditScriptRoot(projectRoot, editId), { recursive: true }),
    mkdir(join(getProjectEditScriptRoot(projectRoot, editId), 'versions'), { recursive: true }),
    mkdir(getProjectEditPlanningRoot(projectRoot, editId), { recursive: true }),
    mkdir(join(getProjectEditPlanningRoot(projectRoot, editId), 'reviews'), { recursive: true }),
    mkdir(getProjectEditTimelineRoot(projectRoot, editId), { recursive: true }),
    mkdir(join(getProjectEditTimelineRoot(projectRoot, editId), 'versions'), { recursive: true }),
    mkdir(getProjectEditSubtitlesRoot(projectRoot, editId), { recursive: true }),
  ]);
}
