#!/usr/bin/env node
import { existsSync } from 'node:fs';
import {
  copyFile,
  mkdir,
  readdir,
  readFile,
  rename,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import {
  assignUniqueMaterialAssetIds,
  assignUniqueMaterialSpanIds,
  CMATERIAL_ID_POLICY_VERSION,
} from '../dist/modules/media/material-ids.js';

const PROJECT_ID = 'bingchacha-genie-south-zimeiyakou';
const ROOT_CODES = new Map([
  ['root-draft-1778318452475-huvyid', 'zve1'],
  ['root-draft-1778319636214-bb8ljb', 'drone'],
  ['root-draft-1778319664359-puaawa', 'ts-final'],
  ['root-draft-1778319790368-3hrfrl', 'photos'],
]);

const mode = process.argv.includes('--apply')
  ? 'apply'
  : process.argv.includes('--dry-run')
    ? 'dry-run'
    : null;

if (!mode) {
  console.error('Usage: node scripts/migrate-readable-material-ids.mjs --dry-run|--apply');
  process.exit(1);
}

const workspaceRoot = process.cwd();
const projectRoot = join(workspaceRoot, 'projects', PROJECT_ID);
if (!existsSync(projectRoot)) {
  throw new Error(`This migration only supports projects/${PROJECT_ID}`);
}

const now = new Date().toISOString();
const migrationId = `human-material-ids-${now.replace(/[:.]/g, '-')}`;
const migrationRoot = join(projectRoot, '.tmp', 'migrations', migrationId);
const backupRoot = join(migrationRoot, 'backup');

const assetsPath = join(projectRoot, 'store', 'assets.json');
const spansPath = join(projectRoot, 'store', 'spans.json');
const projectBriefPath = join(projectRoot, 'config', 'project-brief.json');
const projectBriefMdPath = join(projectRoot, 'config', 'project-brief.md');

const assets = await readJson(assetsPath);
const spans = await readJson(spansPath);
const projectBrief = await readJson(projectBriefPath);

const mappings = Array.isArray(projectBrief.mappings) ? projectBrief.mappings : [];
for (const mapping of mappings) {
  const configured = ROOT_CODES.get(mapping.rootId);
  if (configured) mapping.rootCode = configured;
}
const rootCodeByRootId = new Map(mappings.map(mapping => [mapping.rootId, mapping.rootCode]).filter(([, code]) => code));

const assetsWithRootCode = assets.map(asset => {
  const rootCode = rootCodeByRootId.get(asset.ingestRootId);
  if (!rootCode) {
    throw new Error(`asset ${asset.id} root ${asset.ingestRootId} has no configured rootCode`);
  }
  return {
    ...asset,
    __rootCode: rootCode,
    metadata: {
      ...(asset.metadata ?? {}),
      rootCode,
    },
  };
});
const newAssets = assignUniqueMaterialAssetIds(
  assetsWithRootCode,
  asset => asset.__rootCode,
).map(({ __rootCode, ...asset }) => asset);
const assetIdMap = new Map();
for (let index = 0; index < assets.length; index += 1) {
  assetIdMap.set(assets[index].id, newAssets[index].id);
}
assertNoDuplicates(newAssets.map(asset => asset.id), 'asset id');

const assetsByOldId = new Map(assets.map(asset => [asset.id, asset]));
const newAssetKindById = new Map(newAssets.map(asset => [asset.id, { kind: asset.kind }]));
const projectedSpans = spans.map(span => ({
  ...span,
  assetId: assetIdMap.get(span.assetId) ?? span.assetId,
}));
const newSpans = assignUniqueMaterialSpanIds(projectedSpans, newAssetKindById);
const spanIdMap = new Map();
for (let index = 0; index < spans.length; index += 1) {
  spanIdMap.set(spans[index].id, newSpans[index].id);
}
assertNoDuplicates(newSpans.map(span => span.id), 'span id');

const extraIdMap = await buildWindowIdMap(assetIdMap, projectRoot);
const replacements = new Map([
  ...assetIdMap,
  ...spanIdMap,
  ...extraIdMap,
]);

const touchedFiles = new Set();
const renameOps = [];

await collectRenameOps(join(projectRoot, 'analysis', 'asset-reports'), '.json', assetIdMap, renameOps);
await collectRenameOps(join(projectRoot, 'analysis', 'prepared-assets'), '.json', assetIdMap, renameOps);
await collectRenameOps(join(projectRoot, 'analysis', 'audio-checkpoints'), '.json', assetIdMap, renameOps);
await collectRenameOps(join(projectRoot, 'analysis', 'fine-scan-checkpoints'), '.json', assetIdMap, renameOps);
await collectDirectoryRenameOps(join(projectRoot, '.tmp', 'media-analyze'), assetIdMap, renameOps);

const textFiles = [
  projectBriefPath,
  projectBriefMdPath,
  assetsPath,
  spansPath,
  join(projectRoot, 'store', 'spans.meta.json'),
  join(projectRoot, 'media', 'chronology.json'),
  join(projectRoot, 'gps', 'derived.json'),
  ...(await listTextFiles(join(projectRoot, 'analysis'), ['.json'])),
  ...(await listTextFiles(join(projectRoot, 'edits'), ['.json', '.md'])),
  ...(await listTextFiles(join(projectRoot, '.tmp', 'media-analyze'), ['.json'])),
  ...(await listTextFiles(join(projectRoot, '.tmp', 'chronology'), ['.json'])),
].filter((file, index, all) => existsSync(file) && all.indexOf(file) === index);

for (const file of textFiles) {
  let text = await readFile(file, 'utf-8');
  const original = text;
  if (file === projectBriefPath) {
    text = `${JSON.stringify(projectBrief, null, 2)}\n`;
  }
  if (file === projectBriefMdPath) {
    text = applyProjectBriefMarkdownRootCodes(text, mappings);
  }
  if (file === assetsPath) {
    text = `${JSON.stringify(newAssets, null, 2)}\n`;
  } else if (file === spansPath) {
    text = `${JSON.stringify(newSpans, null, 2)}\n`;
  } else {
    text = replaceAllIds(text, replacements);
    if (file.endsWith('flow-plan.json')) {
      text = markFlowPlanStale(text);
    } else if (isMaterialSlotsJson(file)) {
      text = markMaterialSlotsStale(text);
    } else if (isEditRunRecordsJson(file)) {
      text = markEditRunRecordsStale(text);
    } else if (isEditPlanningMarkdown(file)) {
      text = markPlanningMarkdownStale(text);
    }
  }
  if (text !== original) touchedFiles.add(file);
}

const manifest = {
  schemaVersion: '1.0',
  migrationId,
  projectId: PROJECT_ID,
  mode,
  generatedAt: now,
  materialIdPolicyVersion: CMATERIAL_ID_POLICY_VERSION,
  assetCount: assets.length,
  spanCount: spans.length,
  assetIdMap: Object.fromEntries(assetIdMap),
  spanIdMap: Object.fromEntries(spanIdMap),
  extraIdMap: Object.fromEntries(extraIdMap),
  touchedFileCount: touchedFiles.size,
  renamedPathCount: renameOps.length,
  touchedFiles: [...touchedFiles].map(file => relative(projectRoot, file).replace(/\\/g, '/')).sort(),
  renamedPaths: renameOps.map(op => ({
    from: relative(projectRoot, op.from).replace(/\\/g, '/'),
    to: relative(projectRoot, op.to).replace(/\\/g, '/'),
  })),
};

if (mode === 'dry-run') {
  console.log(JSON.stringify({
    mode,
    materialIdPolicyVersion: CMATERIAL_ID_POLICY_VERSION,
    assetCount: manifest.assetCount,
    spanCount: manifest.spanCount,
    touchedFileCount: manifest.touchedFileCount,
    renamedPathCount: manifest.renamedPathCount,
    sampleAssets: Object.entries(manifest.assetIdMap).slice(0, 5),
    sampleSpans: Object.entries(manifest.spanIdMap).slice(0, 5),
  }, null, 2));
  process.exit(0);
}

await mkdir(migrationRoot, { recursive: true });
await mkdir(backupRoot, { recursive: true });
for (const file of touchedFiles) {
  await backupFile(projectRoot, backupRoot, file);
}
for (const file of textFiles) {
  let text = await readFile(file, 'utf-8');
  if (file === projectBriefPath) {
    text = `${JSON.stringify(projectBrief, null, 2)}\n`;
  }
  if (file === projectBriefMdPath) {
    text = applyProjectBriefMarkdownRootCodes(text, mappings);
  }
  if (file === assetsPath) {
    text = `${JSON.stringify(newAssets, null, 2)}\n`;
  } else if (file === spansPath) {
    text = `${JSON.stringify(newSpans, null, 2)}\n`;
  } else {
    text = replaceAllIds(text, replacements);
    if (file.endsWith('flow-plan.json')) {
      text = markFlowPlanStale(text);
    } else if (isMaterialSlotsJson(file)) {
      text = markMaterialSlotsStale(text);
    } else if (isEditRunRecordsJson(file)) {
      text = markEditRunRecordsStale(text);
    } else if (isEditPlanningMarkdown(file)) {
      text = markPlanningMarkdownStale(text);
    }
  }
  await writeFile(file, text, 'utf-8');
}
for (const op of renameOps) {
  if (!existsSync(op.from) || op.from === op.to) continue;
  if (existsSync(op.to)) {
    throw new Error(`refusing to overwrite existing migration target: ${op.to}`);
  }
  await mkdir(dirname(op.to), { recursive: true }).catch(() => undefined);
  await rename(op.from, op.to);
}
await writeFile(join(migrationRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');
console.log(JSON.stringify({
  mode,
  manifestPath: relative(workspaceRoot, join(migrationRoot, 'manifest.json')).replace(/\\/g, '/'),
  assetCount: manifest.assetCount,
  spanCount: manifest.spanCount,
  touchedFileCount: manifest.touchedFileCount,
  renamedPathCount: manifest.renamedPathCount,
}, null, 2));

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf-8'));
}

function assertNoDuplicates(values, label) {
  const seen = new Set();
  for (const value of values) {
    if (seen.has(value)) throw new Error(`duplicate ${label}: ${value}`);
    seen.add(value);
  }
}

async function buildWindowIdMap(assetMap, root) {
  const result = new Map();
  const reportRoot = join(root, 'analysis', 'asset-reports');
  const entries = await readdir(reportRoot, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const report = await readJson(join(reportRoot, entry.name));
    const oldAssetId = report.assetId;
    const newAssetId = assetMap.get(oldAssetId);
    if (!newAssetId) continue;
    const assetKind = assetsByOldId.get(oldAssetId)?.kind ?? 'video';
    const windowSlices = (report.interestingWindows ?? []).map(window => ({
      id: window.windowId,
      assetId: newAssetId,
      type: mapClipTypeToSpanType(report.clipTypeGuess),
      semanticKind: window.semanticKind,
      sourceInMs: window.startMs,
      sourceOutMs: window.endMs,
    }));
    const assignedWindows = assignUniqueMaterialSpanIds(windowSlices, new Map([[newAssetId, { kind: assetKind }]]));
    for (let index = 0; index < windowSlices.length; index += 1) {
      if (windowSlices[index].id) result.set(windowSlices[index].id, assignedWindows[index].id);
    }
    const slices = (report.fineScanWindows ?? []).map(window => ({
      id: window.windowId,
      assetId: newAssetId,
      type: mapClipTypeToSpanType(report.clipTypeGuess),
      semanticKind: window.semanticKind,
      sourceInMs: window.sourceInMs,
      sourceOutMs: window.sourceOutMs,
    }));
    const assigned = assignUniqueMaterialSpanIds(slices, new Map([[newAssetId, { kind: assetKind }]]));
    for (let index = 0; index < slices.length; index += 1) {
      if (slices[index].id) result.set(slices[index].id, assigned[index].id);
    }
  }
  return result;
}

function mapClipTypeToSpanType(clipType) {
  if (clipType === 'drive') return 'drive';
  if (clipType === 'talking-head') return 'talking-head';
  if (clipType === 'aerial') return 'aerial';
  if (clipType === 'broll') return 'broll';
  if (clipType === 'timelapse') return 'timelapse';
  return 'unknown';
}

async function collectRenameOps(root, extension, idMap, ops) {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(extension)) continue;
    const oldId = entry.name.slice(0, -extension.length);
    const nextId = idMap.get(oldId);
    if (!nextId || nextId === oldId) continue;
    ops.push({
      from: join(root, entry.name),
      to: join(root, `${nextId}${extension}`),
    });
  }
}

async function collectDirectoryRenameOps(root, idMap, ops) {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const nextId = idMap.get(entry.name);
    if (!nextId || nextId === entry.name) continue;
    ops.push({
      from: join(root, entry.name),
      to: join(root, nextId),
    });
  }
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

function replaceAllIds(text, idMap) {
  let next = text;
  const entries = [...idMap.entries()].sort((left, right) => right[0].length - left[0].length);
  for (const [oldId, newId] of entries) {
    if (oldId !== newId) next = next.split(oldId).join(newId);
  }
  return next;
}

function markFlowPlanStale(text) {
  try {
    const plan = JSON.parse(text);
    plan.materialIdPolicyVersion = CMATERIAL_ID_POLICY_VERSION;
    plan.status = 'stale';
    plan.staleReason = `material id policy changed: ${CMATERIAL_ID_POLICY_VERSION}`;
    plan.updatedAt = now;
    return `${JSON.stringify(plan, null, 2)}\n`;
  } catch {
    return text;
  }
}

function isMaterialSlotsJson(file) {
  return normalizePath(file).endsWith('/script/material-slots.json');
}

function markMaterialSlotsStale(text) {
  try {
    const slots = JSON.parse(text);
    slots.materialIdPolicyVersion = CMATERIAL_ID_POLICY_VERSION;
    slots.status = 'stale';
    slots.staleReason = `material id policy changed: ${CMATERIAL_ID_POLICY_VERSION}; regenerate material recall before using this file.`;
    slots.updatedAt = now;
    return `${JSON.stringify(slots, null, 2)}\n`;
  } catch {
    return text;
  }
}

function isEditRunRecordsJson(file) {
  return normalizePath(file).endsWith('/runs/current.json');
}

function markEditRunRecordsStale(text) {
  try {
    const state = JSON.parse(text);
    const staleReason = `material id policy changed: ${CMATERIAL_ID_POLICY_VERSION}; regenerate the edit flow before trusting these run records.`;
    state.materialIdPolicyVersion = CMATERIAL_ID_POLICY_VERSION;
    state.staleReason = staleReason;
    state.updatedAt = now;
    if (Array.isArray(state.records)) {
      state.records = state.records.map(record => ({
        ...record,
        summary: {
          ...(record.summary ?? {}),
          materialIdPolicyStaleReason: staleReason,
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

function appendStaleNote(note, staleReason) {
  if (typeof note === 'string' && note.includes(staleReason)) return note;
  if (typeof note === 'string' && note.trim()) return `${note.trim()}\n${staleReason}`;
  return staleReason;
}

function normalizePath(file) {
  return file.replace(/\\/g, '/');
}

function isEditPlanningMarkdown(file) {
  return file.endsWith('edit-framework.md')
    || file.endsWith('event-table.md')
    || file.endsWith('material-archive.md');
}

function markPlanningMarkdownStale(text) {
  const marker = `> STALE: material id policy changed to ${CMATERIAL_ID_POLICY_VERSION}; regenerate Flow Plan and this planning artifact before using it.\n`;
  if (text.includes(marker)) return text;
  if (text.startsWith('# ')) {
    const newline = text.indexOf('\n');
    if (newline >= 0) {
      return `${text.slice(0, newline + 1)}\n${marker}\n${text.slice(newline + 1)}`;
    }
  }
  return `${marker}\n${text}`;
}

function applyProjectBriefMarkdownRootCodes(text, mappings) {
  let next = text;
  for (const mapping of mappings) {
    if (!mapping.path || !mapping.rootCode) continue;
    const pathLine = `路径：${mapping.path}`;
    const rootLine = `Root代号：${mapping.rootCode}`;
    const index = next.indexOf(pathLine);
    if (index < 0) continue;
    const after = next.slice(index + pathLine.length);
    if (/^\r?\nRoot代号：/u.test(after)) {
      next = `${next.slice(0, index + pathLine.length)}\n${rootLine}${after.replace(/^\r?\nRoot代号：[^\r\n]*/u, '')}`;
    } else {
      next = `${next.slice(0, index + pathLine.length)}\n${rootLine}${after}`;
    }
  }
  return next;
}

async function backupFile(projectRootPath, backupRootPath, file) {
  const rel = relative(projectRootPath, file);
  const target = join(backupRootPath, rel);
  await mkdir(dirname(target), { recursive: true }).catch(() => undefined);
  const info = await stat(file).catch(() => null);
  if (info?.isFile()) await copyFile(file, target);
}
