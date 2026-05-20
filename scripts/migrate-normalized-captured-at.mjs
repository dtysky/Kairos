#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';

const PROJECT_ID = 'bingchacha-genie-south-zimeiyakou';
const CMATERIAL_TIME_POLICY_VERSION = 'normalized-captured-at-v1';

const mode = process.argv.includes('--apply')
  ? 'apply'
  : process.argv.includes('--dry-run')
    ? 'dry-run'
    : null;

if (!mode) {
  console.error('Usage: node scripts/migrate-normalized-captured-at.mjs --dry-run|--apply');
  process.exit(1);
}

const workspaceRoot = process.cwd();
const projectRoot = join(workspaceRoot, 'projects', PROJECT_ID);
if (!existsSync(projectRoot)) {
  throw new Error(`This migration only supports projects/${PROJECT_ID}`);
}

const now = new Date().toISOString();
const migrationId = `normalized-captured-at-${now.replace(/[:.]/g, '-')}`;
const migrationRoot = join(projectRoot, '.tmp', 'migrations', migrationId);
const backupRoot = join(migrationRoot, 'backup');

const assetsPath = join(projectRoot, 'store', 'assets.json');
const chronologyPath = join(projectRoot, 'media', 'chronology.json');
const derivedPath = join(projectRoot, 'gps', 'derived.json');
const projectBriefPath = join(projectRoot, 'config', 'project-brief.json');

const assets = await readJson(assetsPath);
const projectBrief = await readJson(projectBriefPath);
const rootsById = new Map((projectBrief.mappings ?? []).map(root => [root.rootId, root]));

const assetTimeMap = new Map();
const newAssets = assets.map(asset => normalizeAsset(asset, rootsById, assetTimeMap));

const textFiles = [
  assetsPath,
  chronologyPath,
  derivedPath,
  ...(await listTextFiles(join(projectRoot, 'edits'), ['.json', '.md'])),
].filter((file, index, all) => existsSync(file) && all.indexOf(file) === index);

const nextText = new Map();
for (const file of textFiles) {
  const raw = await readFile(file, 'utf-8');
  let text = raw;
  if (file === assetsPath) {
    text = `${JSON.stringify(newAssets, null, 2)}\n`;
  } else if (file === chronologyPath) {
    text = normalizeChronologyText(raw, newAssets, assetTimeMap);
  } else if (file === derivedPath) {
    text = normalizeDerivedTrackText(raw, assetTimeMap);
  } else if (file.endsWith('flow-plan.json')) {
    text = markFlowPlanStale(raw);
  } else if (isMaterialSlotsJson(file)) {
    text = markMaterialSlotsStale(raw);
  } else if (isEditRunRecordsJson(file)) {
    text = markEditRunRecordsStale(raw);
  } else if (isEditPlanningMarkdown(file)) {
    text = markPlanningMarkdownStale(raw);
  }
  if (text !== raw) nextText.set(file, text);
}

const changedAssets = newAssets.filter((asset, index) => JSON.stringify(asset) !== JSON.stringify(assets[index]));
const shiftedAssets = [...assetTimeMap.values()].filter(item => item.deltaMs !== 0);
const manifest = {
  schemaVersion: '1.0',
  migrationId,
  projectId: PROJECT_ID,
  mode,
  generatedAt: now,
  materialTimePolicyVersion: CMATERIAL_TIME_POLICY_VERSION,
  assetCount: assets.length,
  changedAssetCount: changedAssets.length,
  shiftedAssetCount: shiftedAssets.length,
  touchedFileCount: nextText.size,
  sampleAssets: changedAssets.slice(0, 8).map(asset => ({
    id: asset.id,
    rawCapturedAt: asset.rawCapturedAt,
    capturedAt: asset.capturedAt,
    appliedClockOffsetMs: asset.appliedClockOffsetMs,
  })),
  touchedFiles: [...nextText.keys()].map(file => relative(projectRoot, file).replace(/\\/g, '/')).sort(),
};

if (mode === 'dry-run') {
  console.log(JSON.stringify({
    mode,
    materialTimePolicyVersion: CMATERIAL_TIME_POLICY_VERSION,
    assetCount: manifest.assetCount,
    changedAssetCount: manifest.changedAssetCount,
    shiftedAssetCount: manifest.shiftedAssetCount,
    touchedFileCount: manifest.touchedFileCount,
    sampleAssets: manifest.sampleAssets,
  }, null, 2));
  process.exit(0);
}

await mkdir(migrationRoot, { recursive: true });
await mkdir(backupRoot, { recursive: true });
for (const file of nextText.keys()) {
  await backupFile(projectRoot, backupRoot, file);
}
for (const [file, text] of nextText.entries()) {
  await writeFile(file, text, 'utf-8');
}
await writeFile(join(migrationRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');
console.log(JSON.stringify({
  mode,
  manifestPath: relative(workspaceRoot, join(migrationRoot, 'manifest.json')).replace(/\\/g, '/'),
  assetCount: manifest.assetCount,
  changedAssetCount: manifest.changedAssetCount,
  shiftedAssetCount: manifest.shiftedAssetCount,
  touchedFileCount: manifest.touchedFileCount,
}, null, 2));

function normalizeAsset(asset, rootsById, assetTimeMap) {
  const root = rootsById.get(asset.ingestRootId);
  const offsetMs = normalizeClockOffsetMs(root?.clockOffsetMs);
  const manual = asset.captureTimeSource === 'manual';
  const rawCapturedAt = asset.rawCapturedAt ?? asset.capturedAt;
  const capturedAt = manual
    ? asset.capturedAt
    : applyOffset(rawCapturedAt, offsetMs);
  const deltaMs = diffMs(asset.capturedAt, capturedAt);
  assetTimeMap.set(asset.id, {
    assetId: asset.id,
    previousCapturedAt: asset.capturedAt,
    rawCapturedAt,
    capturedAt,
    deltaMs,
  });

  const next = {
    ...asset,
    capturedAt,
    rawCapturedAt,
    appliedClockOffsetMs: manual ? 0 : offsetMs || undefined,
  };
  if (!next.capturedAt) delete next.capturedAt;
  if (!next.rawCapturedAt) delete next.rawCapturedAt;
  if (next.appliedClockOffsetMs == null) delete next.appliedClockOffsetMs;
  if (!asset.createdAt || asset.createdAt === asset.capturedAt) {
    next.createdAt = capturedAt;
  }
  if (next.embeddedGps && deltaMs !== 0) {
    next.embeddedGps = shiftKnownTimeFields(next.embeddedGps, deltaMs);
  }
  return next;
}

function normalizeChronologyText(text, assets, assetTimeMap) {
  try {
    const chronology = JSON.parse(text);
    const byId = new Map(assets.map(asset => [asset.id, asset]));
    const originalAssetIndex = Array.isArray(chronology.assetIndex) ? chronology.assetIndex : [];
    let changed = false;
    if (Array.isArray(chronology.assetIndex)) {
      chronology.assetIndex = chronology.assetIndex.map((item, index) => {
        const next = {
          ...item,
          sortCapturedAt: byId.get(item.assetId)?.capturedAt ?? item.sortCapturedAt,
        };
        if (JSON.stringify(next) !== JSON.stringify(originalAssetIndex[index])) {
          changed = true;
        }
        return next;
      });
    }
    const shifted = [...assetTimeMap.values()].some(item => item.deltaMs !== 0);
    if (!changed && !shifted) return text;
    if (shifted) {
      chronology.status = 'stale';
      chronology.staleReason = `material time policy changed: ${CMATERIAL_TIME_POLICY_VERSION}; rebuild chronology after normalized asset capturedAt migration.`;
    }
    chronology.updatedAt = now;
    return `${JSON.stringify(chronology, null, 2)}\n`;
  } catch {
    return text;
  }
}

function normalizeDerivedTrackText(text, assetTimeMap) {
  try {
    const derived = JSON.parse(text);
    let changed = false;
    if (Array.isArray(derived.entries)) {
      derived.entries = derived.entries.map(entry => {
        const deltaMs = assetTimeMap.get(entry.sourceAssetId)?.deltaMs ?? 0;
        if (deltaMs === 0) return entry;
        changed = true;
        return shiftKnownTimeFields(entry, deltaMs);
      });
    }
    if (!changed) return text;
    derived.updatedAt = now;
    return `${JSON.stringify(derived, null, 2)}\n`;
  } catch {
    return text;
  }
}

function markFlowPlanStale(text) {
  try {
    const plan = JSON.parse(text);
    plan.materialTimePolicyVersion = CMATERIAL_TIME_POLICY_VERSION;
    plan.status = 'stale';
    plan.staleReason = `material time policy changed: ${CMATERIAL_TIME_POLICY_VERSION}`;
    plan.updatedAt = now;
    return `${JSON.stringify(plan, null, 2)}\n`;
  } catch {
    return text;
  }
}

function markMaterialSlotsStale(text) {
  try {
    const slots = JSON.parse(text);
    slots.materialTimePolicyVersion = CMATERIAL_TIME_POLICY_VERSION;
    slots.status = 'stale';
    slots.staleReason = `material time policy changed: ${CMATERIAL_TIME_POLICY_VERSION}; regenerate material recall before using this file.`;
    slots.updatedAt = now;
    return `${JSON.stringify(slots, null, 2)}\n`;
  } catch {
    return text;
  }
}

function markEditRunRecordsStale(text) {
  try {
    const state = JSON.parse(text);
    const staleReason = `material time policy changed: ${CMATERIAL_TIME_POLICY_VERSION}; regenerate the edit flow before trusting these run records.`;
    state.materialTimePolicyVersion = CMATERIAL_TIME_POLICY_VERSION;
    state.staleReason = staleReason;
    state.updatedAt = now;
    if (Array.isArray(state.records)) {
      state.records = state.records.map(record => ({
        ...record,
        summary: {
          ...(record.summary ?? {}),
          materialTimePolicyStaleReason: staleReason,
        },
        review: {
          ...(record.review ?? {}),
          note: appendStaleNote(record.review?.note, staleReason),
        },
      }));
    }
    return `${JSON.stringify(state, null, 2)}\n`;
  } catch {
    return text;
  }
}

function markPlanningMarkdownStale(text) {
  const marker = `> STALE: material time policy changed to ${CMATERIAL_TIME_POLICY_VERSION}; regenerate Flow Plan and this planning artifact before using it.\n`;
  if (text.includes(marker)) return text;
  if (text.startsWith('# ')) {
    const newline = text.indexOf('\n');
    if (newline >= 0) {
      return `${text.slice(0, newline + 1)}\n${marker}\n${text.slice(newline + 1)}`;
    }
  }
  return `${marker}\n${text}`;
}

function shiftKnownTimeFields(value, deltaMs) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const next = { ...value };
  for (const key of ['representativeTime', 'startTime', 'endTime', 'time']) {
    if (typeof next[key] === 'string') {
      next[key] = shiftIso(next[key], deltaMs);
    }
  }
  if (typeof next.summary === 'string') {
    for (const key of ['representativeTime', 'startTime', 'endTime', 'time']) {
      if (typeof value[key] === 'string' && typeof next[key] === 'string') {
        next.summary = next.summary.split(value[key]).join(next[key]);
      }
    }
  }
  return next;
}

function applyOffset(capturedAt, offsetMs) {
  if (!capturedAt || offsetMs === 0) return capturedAt;
  return shiftIso(capturedAt, offsetMs);
}

function shiftIso(value, deltaMs) {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return value;
  return new Date(ms + deltaMs).toISOString();
}

function diffMs(previous, next) {
  const previousMs = Date.parse(previous ?? '');
  const nextMs = Date.parse(next ?? '');
  if (!Number.isFinite(previousMs) || !Number.isFinite(nextMs)) return 0;
  return nextMs - previousMs;
}

function normalizeClockOffsetMs(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : 0;
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf-8'));
}

async function listTextFiles(root, extensions) {
  const result = [];
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const file = join(root, entry.name);
    if (entry.isDirectory()) {
      result.push(...await listTextFiles(file, extensions));
      continue;
    }
    if (entry.isFile() && extensions.some(ext => entry.name.endsWith(ext))) {
      result.push(file);
    }
  }
  return result;
}

function isMaterialSlotsJson(file) {
  return normalizePath(file).endsWith('/script/material-slots.json');
}

function isEditRunRecordsJson(file) {
  return normalizePath(file).endsWith('/runs/current.json');
}

function isEditPlanningMarkdown(file) {
  return file.endsWith('edit-framework.md')
    || file.endsWith('event-table.md')
    || file.endsWith('material-archive.md');
}

function appendStaleNote(note, staleReason) {
  if (typeof note === 'string' && note.includes(staleReason)) return note;
  if (typeof note === 'string' && note.trim()) return `${note.trim()}\n${staleReason}`;
  return staleReason;
}

function normalizePath(file) {
  return file.replace(/\\/g, '/');
}

async function backupFile(projectRootPath, backupRootPath, file) {
  const rel = relative(projectRootPath, file);
  const target = join(backupRootPath, rel);
  await mkdir(dirname(target), { recursive: true }).catch(() => undefined);
  const info = await stat(file).catch(() => null);
  if (info?.isFile()) await copyFile(file, target);
}
