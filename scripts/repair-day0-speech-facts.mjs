#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MlClient } from '../dist/modules/media/ml-client.js';
import { transcribe } from '../dist/modules/media/transcriber.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const PROJECT_ROOT = path.join(REPO_ROOT, 'projects/bingchacha-genie-south-zimeiyakou');
const EDIT_ID = 'main';
const ML_URL = process.env.KAIROS_ML_URL ?? 'http://127.0.0.1:8910';

const TARGET_STEMS = [
  'C0353',
  'C0355',
  'C0356',
  'C0357',
  'C0358',
  'C0359',
  'C0360',
  'C0361',
  'C0363',
  'C0364',
  'C0365',
];

const CONTRADICTORY_REASON_PATTERNS = [
  /audio-without-meaningful-speech/i,
  /no strong speech/i,
  /no meaningful speech/i,
  /without meaningful speech/i,
  /coarse-scan-sufficient/i,
  /materialization:direct/i,
];

const SPEECH_REPAIR_WARNING =
  'local speech truth repair: reran ASR for day0 C0353/C0355/C0356/C0357/C0358/C0359/C0360/C0361/C0363/C0364/C0365; restored transcriptSegments/speechCoverage/speech windows in asset reports and existing spans without modifying material-slots or Resolve timeline.';

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, relativePath), 'utf8'));
}

function writeJson(relativePath, value) {
  fs.writeFileSync(path.join(PROJECT_ROOT, relativePath), `${JSON.stringify(value, null, 2)}\n`);
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function sha256Text(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function normalizeStem(asset) {
  const candidate = asset.sourcePath || asset.displayName || '';
  return path.basename(candidate, path.extname(candidate));
}

function collectChosenSpanIds(materialSlots) {
  const ids = new Set();
  for (const segment of materialSlots.segments ?? []) {
    for (const slot of segment.slots ?? []) {
      for (const spanId of slot.chosenSpanIds ?? []) {
        ids.add(spanId);
      }
    }
  }
  return [...ids].sort();
}

function chosenSpanHash(materialSlots) {
  return sha256Text(JSON.stringify(collectChosenSpanIds(materialSlots)));
}

function resolveMediaPath(asset, projectBrief) {
  const mapping = (projectBrief.mappings ?? []).find(entry => entry.rootId === asset.ingestRootId);
  if (!mapping) {
    throw new Error(`No project root mapping for asset ${asset.id} (${asset.sourcePath})`);
  }
  const roots = [
    mapping.path,
    ...(mapping.alternatePaths ?? []).map(entry => entry.path),
  ].filter(Boolean);
  for (const root of roots) {
    const candidate = path.resolve(root, asset.sourcePath);
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`Source file is not readable for asset ${asset.id}: tried ${roots.join(', ')} + ${asset.sourcePath}`);
}

function toTranscriptSegments(asrSegments) {
  return asrSegments
    .map(segment => ({
      startMs: Math.max(0, Math.round(Number(segment.start) * 1000)),
      endMs: Math.max(0, Math.round(Number(segment.end) * 1000)),
      text: String(segment.text ?? '').trim(),
    }))
    .filter(segment => segment.text.length > 0 && segment.endMs > segment.startMs)
    .sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs);
}

function clipSegments(segments, startMs, endMs) {
  return segments
    .filter(segment => segment.endMs > startMs && segment.startMs < endMs)
    .map(segment => ({
      startMs: Math.max(startMs, segment.startMs),
      endMs: Math.min(endMs, segment.endMs),
      text: segment.text,
    }))
    .filter(segment => segment.text.trim().length > 0 && segment.endMs > segment.startMs);
}

function computeCoverage(segments, startMs, endMs) {
  const durationMs = Math.max(0, endMs - startMs);
  if (durationMs <= 0) return 0;
  const spokenMs = clipSegments(segments, startMs, endMs)
    .reduce((sum, segment) => sum + Math.max(0, segment.endMs - segment.startMs), 0);
  return Math.max(0, Math.min(1, spokenMs / durationMs));
}

function transcriptText(segments) {
  return segments.map(segment => segment.text.trim()).filter(Boolean).join(' ').trim();
}

function buildSpeechWindows(assetId, durationMs, segments) {
  const windows = [];
  const sorted = [...segments].sort((left, right) => left.startMs - right.startMs);
  for (const segment of sorted) {
    const startMs = Math.max(0, segment.startMs - 500);
    const endMs = Math.min(durationMs, segment.endMs + 900);
    const previous = windows.at(-1);
    if (previous && startMs - previous.endMs <= 1500) {
      previous.endMs = Math.max(previous.endMs, endMs);
      continue;
    }
    windows.push({ startMs, endMs });
  }
  return windows.map((window, index) => {
    const clipped = clipSegments(segments, window.startMs, window.endMs);
    return {
      windowId: `${assetId}-speech-window-${String(index + 1).padStart(2, '0')}`,
      startMs: window.startMs,
      endMs: window.endMs,
      editStartMs: window.startMs,
      editEndMs: window.endMs,
      semanticKind: 'speech',
      reason: 'speech-window',
      transcript: transcriptText(clipped),
      transcriptSegments: clipped,
      speechCoverage: computeCoverage(segments, window.startMs, window.endMs),
    };
  });
}

function normalizeReasons(existingReasons, speechCoverage) {
  const preserved = (existingReasons ?? [])
    .map(reason => String(reason).trim())
    .filter(Boolean)
    .filter(reason => !CONTRADICTORY_REASON_PATTERNS.some(pattern => pattern.test(reason)));
  const additions = [
    'meaningful-human-speech',
    'speech-window',
    'materialization:fine-scan',
    'fine-scan:windowed',
    'local-day0-speech-truth-repair',
  ];
  if (speechCoverage >= 0.2) additions.unshift('high-speech-coverage');
  return [...new Set([...preserved, ...additions])];
}

function normalizeInterestingWindows(existingWindows, speechWindows) {
  const preserved = (existingWindows ?? [])
    .filter(window => window.reason !== 'speech-window')
    .filter(window => window.reason !== 'audio-without-meaningful-speech')
    .map(window => ({ ...window }));
  const speech = speechWindows.map(window => ({
    windowId: window.windowId,
    startMs: window.startMs,
    endMs: window.endMs,
    editStartMs: window.editStartMs,
    editEndMs: window.editEndMs,
    semanticKind: 'speech',
    reason: 'speech-window',
  }));
  return [...preserved, ...speech].sort((left, right) =>
    (left.startMs ?? 0) - (right.startMs ?? 0)
    || (left.endMs ?? 0) - (right.endMs ?? 0)
    || String(left.windowId ?? '').localeCompare(String(right.windowId ?? '')),
  );
}

function repairReport(report, repair, now) {
  const speechWindows = buildSpeechWindows(report.assetId, report.durationMs ?? repair.asset.durationMs ?? repair.durationMs, repair.transcriptSegments);
  if (speechWindows.length === 0) {
    throw new Error(`ASR produced no speech windows for ${repair.asset.sourcePath}`);
  }
  return {
    ...report,
    keepDecision: 'keep',
    materializationPath: 'fine-scan',
    fineScanMode: 'windowed',
    transcript: repair.transcript,
    transcriptSegments: repair.transcriptSegments,
    speechCoverage: repair.speechCoverage,
    interestingWindows: normalizeInterestingWindows(report.interestingWindows, speechWindows),
    fineScanReasons: normalizeReasons(report.fineScanReasons, repair.speechCoverage),
    updatedAt: now,
  };
}

function repairSpan(span, repair) {
  const sourceInMs = Number.isFinite(span.sourceInMs) ? span.sourceInMs : 0;
  const sourceOutMs = Number.isFinite(span.sourceOutMs)
    ? span.sourceOutMs
    : (repair.asset.durationMs ?? repair.durationMs);
  const clipped = clipSegments(repair.transcriptSegments, sourceInMs, sourceOutMs);
  if (clipped.length === 0) {
    const materialPatterns = Array.isArray(span.materialPatterns)
      ? [...span.materialPatterns]
      : [];
    while (materialPatterns.length < 4) materialPatterns.push('');
    materialPatterns[3] = '无口播语音';
    const repaired = {
      ...span,
      semanticKind: span.semanticKind === 'speech' ? 'visual' : span.semanticKind,
      materialPatterns,
    };
    delete repaired.transcript;
    delete repaired.transcriptSegments;
    delete repaired.speechCoverage;
    return repaired;
  }
  const materialPatterns = Array.isArray(span.materialPatterns)
    ? [...span.materialPatterns]
    : [];
  while (materialPatterns.length < 4) materialPatterns.push('');
  materialPatterns[3] = '有口播语音';
  return {
    ...span,
    semanticKind: 'speech',
    transcript: transcriptText(clipped),
    transcriptSegments: clipped,
    speechCoverage: computeCoverage(repair.transcriptSegments, sourceInMs, sourceOutMs),
    materialPatterns,
  };
}

function auditReport(report, asset) {
  const errors = [];
  if (!Array.isArray(report.transcriptSegments) || report.transcriptSegments.length === 0) {
    errors.push('missing transcriptSegments');
  }
  if (!(typeof report.speechCoverage === 'number' && report.speechCoverage >= 0.05)) {
    errors.push(`speechCoverage below threshold: ${report.speechCoverage}`);
  }
  if (!(report.interestingWindows ?? []).some(window => window.reason === 'speech-window')) {
    errors.push('missing speech-window');
  }
  if ((report.fineScanReasons ?? []).some(reason => reason === 'audio-without-meaningful-speech')) {
    errors.push('still contains audio-without-meaningful-speech');
  }
  if (report.materializationPath !== 'fine-scan' || report.fineScanMode !== 'windowed') {
    errors.push(`unexpected materialization ${report.materializationPath}/${report.fineScanMode}`);
  }
  if (errors.length > 0) {
    throw new Error(`Report audit failed for ${asset.sourcePath}: ${errors.join('; ')}`);
  }
}

function auditSpans(spans, targetAssetIds, previousSpanIds, materialSlots) {
  const currentSpanIds = new Set(spans.map(span => span.id));
  for (const spanId of previousSpanIds) {
    if (!currentSpanIds.has(spanId)) {
      throw new Error(`Span id was removed: ${spanId}`);
    }
  }
  const chosenSpanIds = collectChosenSpanIds(materialSlots);
  for (const spanId of chosenSpanIds) {
    if (!currentSpanIds.has(spanId)) {
      throw new Error(`material-slots references missing span: ${spanId}`);
    }
  }
  const targetSpans = spans.filter(span => targetAssetIds.has(span.assetId));
  const speechSpanByAsset = new Map();
  for (const span of targetSpans) {
    const errors = [];
    const hasSpeechTruth = (span.transcriptSegments?.length ?? 0) > 0 || Boolean(span.transcript?.trim());
    if (hasSpeechTruth) {
      speechSpanByAsset.set(span.assetId, true);
      if (span.semanticKind !== 'speech') errors.push(`semanticKind=${span.semanticKind}`);
      if (!Array.isArray(span.transcriptSegments) || span.transcriptSegments.length === 0) errors.push('missing transcriptSegments');
      if (!span.transcript?.trim()) errors.push('missing transcript');
      if (span.materialPatterns?.[3] !== '有口播语音') errors.push(`pattern4=${span.materialPatterns?.[3]}`);
    } else if (span.materialPatterns?.[3] === '有口播语音') {
      errors.push('span has no clipped transcript but materialPatterns says 有口播语音');
    }
    if (errors.length > 0) {
      throw new Error(`Span audit failed for ${span.id}: ${errors.join('; ')}`);
    }
  }
  for (const assetId of targetAssetIds) {
    if (!speechSpanByAsset.get(assetId)) {
      throw new Error(`No repaired speech span for target asset ${assetId}`);
    }
  }
}

async function main() {
  const projectBrief = readJson('config/project-brief.json');
  const assets = readJson('store/assets.json');
  const spans = readJson('store/spans.json');
  const spansMeta = readJson('store/spans.meta.json');
  const materialSlotsPath = path.join(PROJECT_ROOT, 'edits', EDIT_ID, 'script/material-slots.json');
  const materialSlots = JSON.parse(fs.readFileSync(materialSlotsPath, 'utf8'));
  const beforeMaterialSlotsSha = sha256File(materialSlotsPath);
  const beforeChosenSpanHash = chosenSpanHash(materialSlots);
  const previousSpanIds = spans.map(span => span.id);

  const targetAssets = TARGET_STEMS.map(stem => {
    const matches = assets.filter(asset =>
      normalizeStem(asset) === stem
      && asset.kind === 'video'
      && asset.sourcePath === `day0/${stem}.mp4`
    );
    if (matches.length !== 1) {
      throw new Error(`Expected exactly one asset for ${stem}; found ${matches.length}`);
    }
    return matches[0];
  });

  const client = new MlClient(ML_URL);
  const health = await client.health();
  console.log(`ML ok: ${health.backend}/${health.device}`);

  const repairs = [];
  for (const asset of targetAssets) {
    const mediaPath = resolveMediaPath(asset, projectBrief);
    console.log(`ASR ${asset.sourcePath}`);
    const asr = await transcribe(client, mediaPath, 'zh', { keepOtherModelsLoaded: false });
    const transcriptSegments = toTranscriptSegments(asr.segments);
    const durationMs = asset.durationMs ?? Math.max(...transcriptSegments.map(segment => segment.endMs), 0);
    const transcript = transcriptText(transcriptSegments);
    const speechCoverage = computeCoverage(transcriptSegments, 0, durationMs);
    if (transcriptSegments.length === 0 || !transcript) {
      throw new Error(`ASR produced no transcript for ${asset.sourcePath}`);
    }
    if (speechCoverage < 0.05) {
      throw new Error(`ASR speechCoverage below 0.05 for ${asset.sourcePath}: ${speechCoverage}`);
    }
    repairs.push({
      asset,
      mediaPath,
      transcript,
      transcriptSegments,
      speechCoverage,
      durationMs,
      segmentCount: transcriptSegments.length,
      roundTripMs: asr.roundTripMs,
      timing: asr.timing,
    });
    console.log(`  segments=${transcriptSegments.length} coverage=${speechCoverage.toFixed(3)}`);
  }

  const now = new Date().toISOString();
  const repairedReports = new Map();
  const targetAssetIds = new Set(repairs.map(repair => repair.asset.id));
  for (const repair of repairs) {
    const reportPath = `analysis/asset-reports/${repair.asset.id}.json`;
    const report = readJson(reportPath);
    const repaired = repairReport(report, repair, now);
    auditReport(repaired, repair.asset);
    repairedReports.set(reportPath, repaired);
  }

  const repairedSpans = spans.map(span =>
    targetAssetIds.has(span.assetId)
      ? repairSpan(span, repairs.find(repair => repair.asset.id === span.assetId))
      : span,
  );
  auditSpans(repairedSpans, targetAssetIds, previousSpanIds, materialSlots);

  const repairedMeta = {
    ...spansMeta,
    status: 'fresh',
    generatedAt: now,
    warnings: [...new Set([...(spansMeta.warnings ?? []), SPEECH_REPAIR_WARNING])],
  };

  for (const [relativePath, report] of repairedReports) {
    writeJson(relativePath, report);
  }
  writeJson('store/spans.json', repairedSpans);
  writeJson('store/spans.meta.json', repairedMeta);

  const afterMaterialSlotsSha = sha256File(materialSlotsPath);
  const afterChosenSpanHash = chosenSpanHash(JSON.parse(fs.readFileSync(materialSlotsPath, 'utf8')));
  if (afterMaterialSlotsSha !== beforeMaterialSlotsSha) {
    throw new Error('material-slots.json changed unexpectedly');
  }
  if (afterChosenSpanHash !== beforeChosenSpanHash) {
    throw new Error('chosenSpanIds changed unexpectedly');
  }

  const summary = {
    repairedAt: now,
    projectRoot: PROJECT_ROOT,
    targetAssets: repairs.map(repair => ({
      stem: normalizeStem(repair.asset),
      assetId: repair.asset.id,
      sourcePath: repair.asset.sourcePath,
      transcriptSegmentCount: repair.segmentCount,
      speechCoverage: repair.speechCoverage,
      asrRoundTripMs: repair.roundTripMs,
      asrTiming: repair.timing,
    })),
    materialSlotsSha256: beforeMaterialSlotsSha,
    chosenSpanHash: beforeChosenSpanHash,
    changedFiles: [
      ...[...repairedReports.keys()].map(relativePath => path.join(PROJECT_ROOT, relativePath)),
      path.join(PROJECT_ROOT, 'store/spans.json'),
      path.join(PROJECT_ROOT, 'store/spans.meta.json'),
    ],
  };
  const tmpDir = path.join(PROJECT_ROOT, '.tmp/manual-repairs');
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.writeFileSync(
    path.join(tmpDir, 'day0-speech-facts-summary.json'),
    `${JSON.stringify(summary, null, 2)}\n`,
  );
  console.log(JSON.stringify(summary, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
