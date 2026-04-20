import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  IColorBatchManifest,
  IColorBatchPlan,
  IColorBatchPromote,
  IColorBatchValidation,
  IColorGroupsSnapshotFile,
  type IColorBatchManifest as TColorBatchManifest,
  type IColorBatchPlan as TColorBatchPlan,
  type IColorBatchPromote as TColorBatchPromote,
  type IColorBatchValidation as TColorBatchValidation,
  type IColorGroupsSnapshotFile as TColorGroupsSnapshotFile,
} from '../protocol/schema.js';
import { readJson, readJsonOrNull, writeJson } from './writer.js';

export function getColorRootPath(projectRoot: string): string {
  return join(projectRoot, 'color');
}

export function getColorGroupsRoot(projectRoot: string): string {
  return join(getColorRootPath(projectRoot), 'groups');
}

export function getColorGroupsSnapshotPath(projectRoot: string, rootId: string): string {
  return join(getColorGroupsRoot(projectRoot), `${rootId}.json`);
}

export async function loadColorGroupsSnapshot(
  projectRoot: string,
  rootId: string,
): Promise<TColorGroupsSnapshotFile | null> {
  const stored = await readJsonOrNull(getColorGroupsSnapshotPath(projectRoot, rootId), IColorGroupsSnapshotFile);
  return stored ? IColorGroupsSnapshotFile.parse(stored) : null;
}

export async function loadColorGroupsSnapshots(
  projectRoot: string,
): Promise<Record<string, TColorGroupsSnapshotFile>> {
  const groupsRoot = getColorGroupsRoot(projectRoot);
  const entries = await readdir(groupsRoot, { withFileTypes: true }).catch(() => []);
  const snapshots = await Promise.all(
    entries
      .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
      .map(async entry => readJsonOrNull(join(groupsRoot, entry.name), IColorGroupsSnapshotFile)),
  );
  return Object.fromEntries(
    snapshots
      .filter((snapshot): snapshot is TColorGroupsSnapshotFile => Boolean(snapshot?.rootId))
      .map(snapshot => [snapshot.rootId, snapshot]),
  );
}

export async function saveColorGroupsSnapshot(
  projectRoot: string,
  snapshot: TColorGroupsSnapshotFile,
): Promise<TColorGroupsSnapshotFile> {
  const normalized = IColorGroupsSnapshotFile.parse(snapshot);
  await writeJson(getColorGroupsSnapshotPath(projectRoot, normalized.rootId), normalized);
  return normalized;
}

export function getColorBatchesRoot(projectRoot: string): string {
  return join(getColorRootPath(projectRoot), 'batches');
}

export function getColorBatchRoot(projectRoot: string, batchId: string): string {
  return join(getColorBatchesRoot(projectRoot), batchId);
}

export function getColorBatchPlanPath(projectRoot: string, batchId: string): string {
  return join(getColorBatchRoot(projectRoot, batchId), 'plan.json');
}

export function getColorBatchManifestPath(projectRoot: string, batchId: string): string {
  return join(getColorBatchRoot(projectRoot, batchId), 'manifest.json');
}

export function getColorBatchValidationPath(projectRoot: string, batchId: string): string {
  return join(getColorBatchRoot(projectRoot, batchId), 'validation.json');
}

export function getColorBatchPromotePath(projectRoot: string, batchId: string): string {
  return join(getColorBatchRoot(projectRoot, batchId), 'promote.json');
}

export async function loadColorBatchPlan(
  projectRoot: string,
  batchId: string,
): Promise<TColorBatchPlan | null> {
  const stored = await readJsonOrNull(getColorBatchPlanPath(projectRoot, batchId), IColorBatchPlan);
  return stored ? IColorBatchPlan.parse(stored) : null;
}

export async function saveColorBatchPlan(
  projectRoot: string,
  batch: TColorBatchPlan,
): Promise<TColorBatchPlan> {
  const normalized = IColorBatchPlan.parse(batch);
  await writeJson(getColorBatchPlanPath(projectRoot, normalized.batchId), normalized);
  return normalized;
}

export async function loadColorBatchManifest(
  projectRoot: string,
  batchId: string,
): Promise<TColorBatchManifest | null> {
  const stored = await readJsonOrNull(getColorBatchManifestPath(projectRoot, batchId), IColorBatchManifest);
  return stored ? IColorBatchManifest.parse(stored) : null;
}

export async function saveColorBatchManifest(
  projectRoot: string,
  batch: TColorBatchManifest,
): Promise<TColorBatchManifest> {
  const normalized = IColorBatchManifest.parse(batch);
  await writeJson(getColorBatchManifestPath(projectRoot, normalized.batchId), normalized);
  return normalized;
}

export async function loadColorBatchValidation(
  projectRoot: string,
  batchId: string,
): Promise<TColorBatchValidation | null> {
  const stored = await readJsonOrNull(getColorBatchValidationPath(projectRoot, batchId), IColorBatchValidation);
  return stored ? IColorBatchValidation.parse(stored) : null;
}

export async function saveColorBatchValidation(
  projectRoot: string,
  batch: TColorBatchValidation,
): Promise<TColorBatchValidation> {
  const normalized = IColorBatchValidation.parse(batch);
  await writeJson(getColorBatchValidationPath(projectRoot, normalized.batchId), normalized);
  return normalized;
}

export async function loadColorBatchPromote(
  projectRoot: string,
  batchId: string,
): Promise<TColorBatchPromote | null> {
  const stored = await readJsonOrNull(getColorBatchPromotePath(projectRoot, batchId), IColorBatchPromote);
  return stored ? IColorBatchPromote.parse(stored) : null;
}

export async function saveColorBatchPromote(
  projectRoot: string,
  batch: TColorBatchPromote,
): Promise<TColorBatchPromote> {
  const normalized = IColorBatchPromote.parse(batch);
  await writeJson(getColorBatchPromotePath(projectRoot, normalized.batchId), normalized);
  return normalized;
}

export async function readRequiredColorBatchManifest(
  projectRoot: string,
  batchId: string,
): Promise<TColorBatchManifest> {
  return IColorBatchManifest.parse(
    await readJson(getColorBatchManifestPath(projectRoot, batchId), IColorBatchManifest),
  );
}
