#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const CEXIF_DATETIME = /^(\d{4})[:.-](\d{2})[:.-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:[.,](\d+))?(?:\s*(Z|[+-]\d{2}:\d{2}))?$/u;

const args = parseArgs(process.argv.slice(2));
if (args.help || !args.projectId) {
  printUsage();
  process.exit(args.help ? 0 : 1);
}

const workspaceRoot = resolve(args.workspace ?? process.cwd());
const projectRoot = resolve(workspaceRoot, 'projects', args.projectId);
const assetsPath = join(projectRoot, 'store', 'assets.json');
const derivedPath = join(projectRoot, 'gps', 'derived.json');
const write = Boolean(args.write);

const assets = JSON.parse(await readFile(assetsPath, 'utf8'));
if (!Array.isArray(assets)) {
  throw new Error(`Unsupported assets shape at ${assetsPath}; expected an array.`);
}

const candidates = assets
  .map((asset, index) => ({ asset, index, repair: buildRepair(asset) }))
  .filter(item => item.repair);

const expectedCount = args.expectedCount == null ? null : Number(args.expectedCount);
if (write && (!Number.isInteger(expectedCount) || expectedCount < 0)) {
  throw new Error('--write requires --expected-count <number>.');
}
if (write && candidates.length !== expectedCount) {
  throw new Error(`Refusing to write: matched ${candidates.length} asset(s), expected ${expectedCount}.`);
}

const expectedIds = new Set((args.expectedIds ?? '')
  .split(',')
  .map(item => item.trim())
  .filter(Boolean));
if (write && expectedIds.size > 0) {
  const actualIds = new Set(candidates.map(item => item.asset.id));
  const missing = [...expectedIds].filter(id => !actualIds.has(id));
  const unexpected = [...actualIds].filter(id => !expectedIds.has(id));
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(`Refusing to write: expected id mismatch. Missing=${missing.join(',') || '-'} Unexpected=${unexpected.join(',') || '-'}`);
  }
}

const before = summarizeCandidates(candidates);
let derivedUpdates = [];

if (write && candidates.length > 0) {
  for (const { asset, repair } of candidates) {
    applyAssetRepair(asset, repair);
  }
  await writeFile(assetsPath, `${JSON.stringify(assets, null, 2)}\n`, 'utf8');
  derivedUpdates = await patchDerivedTrack(derivedPath, candidates.map(item => ({
    id: item.asset.id,
    correctedAt: item.repair.correctedAt,
  })));
}

const result = {
  mode: write ? 'write' : 'dry-run',
  projectId: args.projectId,
  assetCount: assets.length,
  matchedCount: candidates.length,
  candidates: before,
  derivedUpdates,
};
console.log(JSON.stringify(result, null, 2));

function buildRepair(asset) {
  if (asset?.captureTimeSource !== 'exif') return null;
  const tags = asset.metadata?.rawTags ?? {};
  const originalValue = tags.subsecdatetimeoriginal ?? tags.datetimeoriginal;
  const original = parseExifParts(originalValue);
  if (!original || original.timezone || normalizeTimezone(tags.offsettimeoriginal)) return null;

  const createdValue = tags.subseccreatedate ?? tags.createdate;
  const created = parseExifParts(createdValue);
  if (!created || original.wallSecond !== created.wallSecond) return null;

  const borrowedTimezone = created.timezone
    ?? normalizeTimezone(tags.offsettimedigitized)
    ?? normalizeTimezone(tags.offsettime);
  if (!borrowedTimezone) return null;

  const correctedAt = buildOffsetIso(original, borrowedTimezone);
  if (!correctedAt || !asset.capturedAt) return null;
  const diffMs = Date.parse(asset.capturedAt) - Date.parse(correctedAt);
  if (!Number.isFinite(diffMs) || Math.abs(diffMs) < 1000) return null;

  return {
    previousAt: asset.capturedAt,
    correctedAt,
    diffHours: Math.round((diffMs / 3_600_000) * 100) / 100,
    originalValue,
    createdValue,
    borrowedTimezone,
  };
}

function applyAssetRepair(asset, repair) {
  asset.capturedAt = repair.correctedAt;
  asset.rawCapturedAt = repair.correctedAt;
  asset.createdAt = repair.correctedAt;
  asset.captureTimeConfidence = 0.98;
  if (asset.embeddedGps) {
    asset.embeddedGps.representativeTime = repair.correctedAt;
    asset.embeddedGps.startTime = repair.correctedAt;
    asset.embeddedGps.endTime = repair.correctedAt;
  }
}

async function patchDerivedTrack(path, updates) {
  let derived;
  try {
    derived = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return [];
  }
  if (!Array.isArray(derived.entries)) return [];

  const byId = new Map(updates.flatMap(update => [
    [update.id, update.correctedAt],
    [`${update.id}_photo`, update.correctedAt],
  ]));
  const changed = [];
  for (const entry of derived.entries) {
    const assetId = entry.sourceAssetId;
    const correctedAt = byId.get(assetId);
    if (!correctedAt || entry.originType !== 'embedded-derived') continue;
    entry.time = correctedAt;
    entry.summary = `derived-track embedded-derived ${correctedAt} ${Number(entry.lat).toFixed(6)},${Number(entry.lng).toFixed(6)} ${entry.sourcePath}`;
    changed.push({ id: entry.id, sourceAssetId: assetId, time: correctedAt });
  }
  if (changed.length > 0) {
    derived.updatedAt = new Date().toISOString();
    derived.entries.sort(compareDerivedTrackEntries);
    await writeFile(path, `${JSON.stringify(derived, null, 2)}\n`, 'utf8');
  }
  return changed;
}

function summarizeCandidates(candidates) {
  return candidates.map(({ asset, repair }) => ({
    id: asset.id,
    sourcePath: asset.sourcePath,
    previousAt: repair.previousAt,
    correctedAt: repair.correctedAt,
    diffHours: repair.diffHours,
    borrowedTimezone: repair.borrowedTimezone,
    gps: asset.embeddedGps
      ? [asset.embeddedGps.representativeLat, asset.embeddedGps.representativeLng]
      : undefined,
  }));
}

function parseExifParts(value) {
  const match = String(value ?? '').trim().match(CEXIF_DATETIME);
  if (!match?.[1] || !match[2] || !match[3] || !match[4] || !match[5] || !match[6]) {
    return null;
  }
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: Number(match[6]),
    timezone: normalizeTimezone(match[8]),
    wallSecond: `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}`,
  };
}

function buildOffsetIso(parts, timezone) {
  const offsetMinutes = parseOffsetMinutes(timezone);
  if (offsetMinutes == null) return null;
  return new Date(Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute - offsetMinutes,
    parts.second,
  )).toISOString();
}

function normalizeTimezone(value) {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) return undefined;
  if (trimmed === 'Z') return '+00:00';
  return /^[+-]\d{2}:\d{2}$/u.test(trimmed) ? trimmed : undefined;
}

function parseOffsetMinutes(timezone) {
  const match = String(timezone ?? '').match(/^([+-])(\d{2}):(\d{2})$/u);
  if (!match) return null;
  const sign = match[1] === '-' ? -1 : 1;
  return sign * (Number(match[2]) * 60 + Number(match[3]));
}

function compareDerivedTrackEntries(left, right) {
  const leftTime = left.startTime ?? left.time ?? '';
  const rightTime = right.startTime ?? right.time ?? '';
  if (leftTime !== rightTime) return leftTime.localeCompare(rightTime);
  return String(left.id ?? '').localeCompare(String(right.id ?? ''));
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--write') {
      parsed.write = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      parsed.help = true;
      continue;
    }
    if (arg?.startsWith('--')) {
      const key = arg.slice(2).replace(/-([a-z])/gu, (_match, char) => char.toUpperCase());
      parsed[key] = argv[index + 1];
      index += 1;
    }
  }
  return parsed;
}

function printUsage() {
  console.log(`Usage:
  node scripts/repair-exif-sibling-timezone.mjs --project-id <id> [--workspace <root>]
  node scripts/repair-exif-sibling-timezone.mjs --project-id <id> --write --expected-count 3 [--expected-ids id1,id2]

Default mode is dry-run. Write mode refuses to run without an exact expected count.`);
}
