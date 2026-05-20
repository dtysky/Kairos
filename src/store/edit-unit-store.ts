import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { IEditUnitConfig, IMaterialSlotsDocument } from '../protocol/schema.js';
import {
  IEditUnitConfig as ZEditUnitConfig,
  IMaterialSlotsDocument as ZMaterialSlotsDocument,
} from '../protocol/schema.js';
import {
  ensureProjectEditDirs,
  getProjectEditConfigRoot,
  getProjectEditPlanningRoot,
  getProjectEditScriptRoot,
  normalizeEditId,
} from './edit-store.js';
import {
  markEditFlowPlanStale,
  markEditFlowRunRecordsStale,
} from './edit-planning-store.js';
import { readJsonOrNull, writeJson } from './writer.js';

const CEDIT_UNIT_CONFIG_FILE = 'edit-unit.json';

export function getEditUnitConfigPath(projectRoot: string, editId?: string | null): string {
  return join(getProjectEditConfigRoot(projectRoot, editId), CEDIT_UNIT_CONFIG_FILE);
}

export async function loadEditUnitConfig(
  projectRoot: string,
  editId?: string | null,
): Promise<IEditUnitConfig> {
  const normalizedEditId = normalizeEditId(editId);
  const stored = await readRawEditUnitConfig(projectRoot, normalizedEditId);
  if (stored) return stored;
  return ZEditUnitConfig.parse({
    schemaVersion: '1.0',
    editId: normalizedEditId,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  });
}

export async function saveEditUnitConfig(
  projectRoot: string,
  config: Partial<IEditUnitConfig>,
  editId?: string | null,
): Promise<IEditUnitConfig> {
  const normalizedEditId = normalizeEditId(editId ?? config.editId);
  const previous = await readRawEditUnitConfig(projectRoot, normalizedEditId);
  const editRuleCategory = normalizeOptionalString(config.editRuleCategory);
  if (!editRuleCategory) {
    throw new Error('edit unit initialization requires editRuleCategory');
  }
  const now = new Date().toISOString();
  const next = ZEditUnitConfig.parse({
    schemaVersion: '1.0',
    editId: normalizedEditId,
    editRuleCategory,
    styleCategory: normalizeOptionalString(config.styleCategory),
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
  });
  await ensureProjectEditDirs(projectRoot, normalizedEditId);
  await writeJson(getEditUnitConfigPath(projectRoot, normalizedEditId), next);

  const dependencyChanged = !previous
    || previous.editRuleCategory !== next.editRuleCategory
    || previous.styleCategory !== next.styleCategory;
  if (dependencyChanged) {
    await markEditUnitDependentArtifactsStale(
      projectRoot,
      normalizedEditId,
      'edit unit config changed; regenerate Flow Plan and downstream edit artifacts with Codex Agent',
    );
  }
  return next;
}

export async function markEditUnitDependentArtifactsStale(
  projectRoot: string,
  editId?: string | null,
  staleReason = 'edit unit config changed; regenerate Flow Plan and downstream edit artifacts with Codex Agent',
): Promise<void> {
  const normalizedEditId = normalizeEditId(editId);
  await Promise.all([
    markEditFlowPlanStale(projectRoot, normalizedEditId, staleReason),
    markEditFlowRunRecordsStale(projectRoot, normalizedEditId, staleReason),
    markMaterialSlotsStale(projectRoot, normalizedEditId, staleReason),
    markEditFrameworkStale(projectRoot, normalizedEditId, staleReason),
  ]);
}

async function readRawEditUnitConfig(
  projectRoot: string,
  editId: string,
): Promise<IEditUnitConfig | null> {
  return readJsonOrNull(getEditUnitConfigPath(projectRoot, editId), ZEditUnitConfig) as Promise<IEditUnitConfig | null>;
}

async function markMaterialSlotsStale(
  projectRoot: string,
  editId: string,
  staleReason: string,
): Promise<IMaterialSlotsDocument | null> {
  const path = join(getProjectEditScriptRoot(projectRoot, editId), 'material-slots.json');
  const existing = await readJsonOrNull(path, ZMaterialSlotsDocument) as IMaterialSlotsDocument | null;
  if (!existing) return null;
  const stale = ZMaterialSlotsDocument.parse({
    ...existing,
    status: 'stale',
    staleReason,
  });
  await writeJson(path, stale);
  return stale;
}

async function markEditFrameworkStale(
  projectRoot: string,
  editId: string,
  staleReason: string,
): Promise<void> {
  const path = join(getProjectEditPlanningRoot(projectRoot, editId), 'edit-framework.md');
  if (!await fileExists(path)) return;
  const existing = await readFile(path, 'utf-8');
  if (existing.includes('kairos-stale: edit-unit-config')) return;
  const banner = [
    '<!-- kairos-stale: edit-unit-config -->',
    `> STALE: ${staleReason}`,
    '',
  ].join('\n');
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${banner}${existing}`, 'utf-8');
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
