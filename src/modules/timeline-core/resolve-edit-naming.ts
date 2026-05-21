import { normalizeEditId } from '../../store/index.js';

export function deriveResolveRoughCutProjectName(projectName?: string, projectId?: string): string {
  const base = (projectName?.trim() || projectId?.trim() || 'Kairos Project').slice(0, 100);
  return `${base} [Edit]`;
}

export function deriveResolveRoughCutTimelineName(editId: string, editLabel?: string): string {
  const normalizedEditId = normalizeEditId(editId);
  const label = (editLabel?.trim() || (normalizedEditId === 'main' ? 'Main' : normalizedEditId)).slice(0, 100);
  return `${label} [${normalizedEditId}]`;
}

export function resolveEditDrpLatestFilename(resolveProjectName: string): string {
  const sanitized = resolveProjectName
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001F]+/gu, '-')
    .replace(/^\.+|\.+$/gu, '')
    .trim();
  return `${sanitized || 'Kairos Edit Project'}.drp`;
}
