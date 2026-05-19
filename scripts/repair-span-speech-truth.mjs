#!/usr/bin/env node
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';

const projectRoot = resolve(process.argv[2] ?? '');
const editId = process.argv[3] ?? 'main';

if (!process.argv[2]) {
  console.error('Usage: node scripts/repair-span-speech-truth.mjs <projectRoot> [editId]');
  process.exit(2);
}

const paths = {
  spans: join(projectRoot, 'store', 'spans.json'),
  spansMeta: join(projectRoot, 'store', 'spans.meta.json'),
  assets: join(projectRoot, 'store', 'assets.json'),
  reports: join(projectRoot, 'analysis', 'asset-reports'),
  materialSlots: join(projectRoot, 'edits', editId, 'script', 'material-slots.json'),
  chronology: join(projectRoot, 'media', 'chronology.json'),
  timelineAudit: join(projectRoot, '.tmp', 'edit-flow', editId, 'timeline', 'current.json'),
  repairSummary: join(projectRoot, '.tmp', 'edit-flow', editId, 'span-speech-repair-summary.json'),
};

const now = new Date().toISOString();
const [spans, assets, reports, spansMeta, materialSlots, chronology] = await Promise.all([
  readJson(paths.spans),
  readJson(paths.assets),
  readReports(paths.reports),
  readJsonOrNull(paths.spansMeta),
  readJsonOrNull(paths.materialSlots),
  readJsonOrNull(paths.chronology),
]);

const reportByAssetId = new Map(reports.map(report => [report.assetId, report]));
const assetById = new Map(assets.map(asset => [asset.id, asset]));
const repairDetails = [];
let repairedSpanCount = 0;
let repairedMaterialPatternCount = 0;

const repairedSpans = spans.map(span => {
  const report = reportByAssetId.get(span.assetId);
  if (!report) return span;
  const window = findMatchingFineScanWindow(report, span);
  if (!window || window.status !== 'recognized') return span;
  const semanticKind = resolveEffectiveSemanticKind(report, window);
  if (semanticKind !== 'speech' && semanticKind !== 'mixed') return span;
  if (
    !fineScanWindowHasSpeechTruth(window)
    && !hasTranscriptSegmentOverlap(report, span.sourceInMs ?? window.sourceInMs, span.sourceOutMs ?? window.sourceOutMs)
  ) {
    return span;
  }

  const sourceInMs = finiteNumber(span.sourceInMs) ? span.sourceInMs : window.sourceInMs;
  const sourceOutMs = finiteNumber(span.sourceOutMs) ? span.sourceOutMs : window.sourceOutMs;
  const transcript = clipTranscript(report, window, sourceInMs, sourceOutMs);
  const next = { ...span };
  const before = JSON.stringify(next);
  next.semanticKind = semanticKind;
  if (transcript.text) next.transcript = transcript.text;
  if (transcript.segments.length > 0) next.transcriptSegments = transcript.segments;
  if (finiteNumber(transcript.coverage)) next.speechCoverage = transcript.coverage;
  const patterns = Array.isArray(next.materialPatterns) ? [...next.materialPatterns] : [];
  if (patterns.length >= 4 && patterns[3] !== '有口播语音') {
    patterns[3] = '有口播语音';
    next.materialPatterns = patterns;
    repairedMaterialPatternCount += 1;
  }
  if (JSON.stringify(next) === before) return span;

  repairedSpanCount += 1;
  repairDetails.push({
    spanId: span.id,
    assetId: span.assetId,
    windowId: window.windowId,
    semanticKind,
    transcriptChars: next.transcript?.length ?? 0,
    transcriptSegmentCount: next.transcriptSegments?.length ?? 0,
    speechCoverage: next.speechCoverage,
  });
  return stripUndefined(next);
});

let materialSlotTreatmentRepairs = 0;
let materialSlotsWithAudit = materialSlots;
if (materialSlots) {
  const spanById = new Map(repairedSpans.map(span => [span.id, span]));
  materialSlotsWithAudit = {
    ...materialSlots,
    generatedAt: materialSlots.generatedAt ?? now,
    segments: materialSlots.segments.map(segment => ({
      ...segment,
      slots: segment.slots.map(slot => {
        const treatments = { ...(slot.treatments ?? {}) };
        for (const spanId of slot.chosenSpanIds ?? []) {
          const span = spanById.get(spanId);
          const asset = span ? assetById.get(span.assetId) : undefined;
          const treatment = treatments[spanId];
          if (!span || !asset || !treatment || asset.kind === 'photo') continue;
          if (!spanHasSpeechTruth(span) || treatment.audio > -100) continue;
          treatments[spanId] = { ...treatment, audio: 0 };
          materialSlotTreatmentRepairs += 1;
        }
        return { ...slot, treatments };
      }),
    })),
  };
  materialSlotsWithAudit.coverageAudit = buildCoverageAudit({
    materialSlots: materialSlotsWithAudit,
    spans: repairedSpans,
    assets,
    chronology,
    now,
  });
}

if (repairedSpanCount > 0) {
  await writeJson(paths.spans, repairedSpans);
  if (spansMeta) {
    const warning = `local speech truth repair ${now}: repaired ${repairedSpanCount} span(s) from asset-report speech-window evidence`;
    await writeJson(paths.spansMeta, {
      ...spansMeta,
      generatedAt: spansMeta.generatedAt,
      warnings: Array.from(new Set([...(spansMeta.warnings ?? []), warning])).slice(-50),
    });
  }
}

if (materialSlotsWithAudit) {
  await writeJson(paths.materialSlots, materialSlotsWithAudit);
}

await rm(paths.timelineAudit, { force: true });

const summary = {
  schemaVersion: '1.0',
  generatedAt: now,
  projectRoot,
  editId,
  repairedSpanCount,
  repairedMaterialPatternCount,
  materialSlotTreatmentRepairs,
  timelineAuditInvalidated: true,
  repairedSpans: repairDetails,
};
await writeJson(paths.repairSummary, summary);
console.log(JSON.stringify(summary, null, 2));

async function readReports(dir) {
  const files = await readdir(dir);
  const reports = [];
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    reports.push(await readJson(join(dir, file)));
  }
  return reports;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf-8'));
}

async function readJsonOrNull(path) {
  try {
    return await readJson(path);
  } catch (error) {
    if (error && typeof error === 'object' && Reflect.get(error, 'code') === 'ENOENT') return null;
    throw error;
  }
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

function findMatchingFineScanWindow(report, span) {
  return (report.fineScanWindows ?? []).find(window => window.windowId === span.id)
    ?? (report.fineScanWindows ?? []).find(window =>
      window.status === 'recognized'
      && Math.abs((window.sourceInMs ?? -1) - (span.sourceInMs ?? -2)) <= 1
      && Math.abs((window.sourceOutMs ?? -1) - (span.sourceOutMs ?? -2)) <= 1,
    );
}

function resolveEffectiveSemanticKind(report, window) {
  if (window.semanticKind) return window.semanticKind;
  if (fineScanWindowHasSpeechTruth(window)) return 'speech';
  if (!hasTranscriptSegmentOverlap(report, window.sourceInMs, window.sourceOutMs)) return undefined;
  if (isSpeechWindowReason(window.reason) || isSpeechWindowReason(window.sourceWindowReason)) {
    return 'speech';
  }
  const sourceWindow = findSpeechSourceInterestingWindow(report, window);
  if (sourceWindow) return 'speech';
  return undefined;
}

function findSpeechSourceInterestingWindow(report, window) {
  const sourceIds = new Set(window.sourceInterestingWindowIds ?? []);
  if (sourceIds.size > 0) {
    const byId = (report.interestingWindows ?? []).find(candidate =>
      candidate.windowId
      && sourceIds.has(candidate.windowId)
      && isSpeechInterestingWindow(candidate),
    );
    if (byId) return byId;
  }
  if (!finiteNumber(window.sourceInMs) || !finiteNumber(window.sourceOutMs)) return undefined;
  return (report.interestingWindows ?? []).find(candidate =>
    isSpeechInterestingWindow(candidate)
    && candidate.endMs > window.sourceInMs
    && candidate.startMs < window.sourceOutMs,
  );
}

function isSpeechInterestingWindow(window) {
  return window.semanticKind === 'speech'
    || window.semanticKind === 'mixed'
    || isSpeechWindowReason(window.reason);
}

function isSpeechWindowReason(reason) {
  return String(reason ?? '').trim().toLowerCase() === 'speech-window';
}

function hasTranscriptSegmentOverlap(report, sourceInMs, sourceOutMs) {
  if (!finiteNumber(sourceInMs) || !finiteNumber(sourceOutMs) || sourceOutMs <= sourceInMs) return false;
  return (report.transcriptSegments ?? []).some(segment =>
    String(segment.text ?? '').trim()
    && segment.endMs > sourceInMs
    && segment.startMs < sourceOutMs,
  );
}

function clipTranscript(report, window, sourceInMs, sourceOutMs) {
  const windowSegments = clipTranscriptSegments(window.transcriptSegments ?? [], sourceInMs, sourceOutMs);
  if (windowSegments.length > 0) {
    return {
      text: windowSegments.map(segment => segment.text).join(' ').trim() || normalizeText(window.transcript),
      segments: windowSegments,
      coverage: finiteNumber(window.speechCoverage)
        ? window.speechCoverage
        : computeSpeechCoverage(sourceInMs, sourceOutMs, windowSegments),
    };
  }
  const windowTranscript = normalizeText(window.transcript);
  if (windowTranscript) {
    return {
      text: windowTranscript,
      segments: [],
      coverage: window.speechCoverage,
    };
  }

  const segments = clipTranscriptSegments(report.transcriptSegments ?? [], sourceInMs, sourceOutMs);
  if (segments.length === 0) {
    return {
      text: normalizeText(report.transcript),
      segments: [],
      coverage: report.speechCoverage,
    };
  }
  return {
    text: segments.map(segment => segment.text).join(' ').trim(),
    segments,
    coverage: computeSpeechCoverage(sourceInMs, sourceOutMs, segments) ?? report.speechCoverage,
  };
}

function clipTranscriptSegments(segments, sourceInMs, sourceOutMs) {
  return segments
    .map(segment => ({
      startMs: Math.max(sourceInMs, segment.startMs),
      endMs: Math.min(sourceOutMs, segment.endMs),
      text: String(segment.text ?? '').trim(),
    }))
    .filter(segment => segment.text && segment.endMs > segment.startMs);
}

function computeSpeechCoverage(sourceInMs, sourceOutMs, segments) {
  const coveredMs = segments.reduce((sum, segment) => sum + segment.endMs - segment.startMs, 0);
  const denominatorMs = sourceOutMs > sourceInMs ? sourceOutMs - sourceInMs : undefined;
  return denominatorMs ? Math.min(coveredMs / denominatorMs, 1) : undefined;
}

function fineScanWindowHasSpeechTruth(window) {
  return Boolean(String(window.transcript ?? '').trim())
    || (window.transcriptSegments ?? []).some(segment => String(segment.text ?? '').trim())
    || finiteNumber(window.speechCoverage);
}

function spanHasSpeechTruth(span) {
  return Boolean(String(span.transcript ?? '').trim())
    || (span.transcriptSegments?.length ?? 0) > 0
    || span.semanticKind === 'speech'
    || span.semanticKind === 'mixed'
    || (span.materialPatterns ?? []).includes('有口播语音');
}

function buildCoverageAudit(input) {
  const chosenSpanIds = new Set();
  for (const segment of input.materialSlots.segments ?? []) {
    for (const slot of segment.slots ?? []) {
      for (const spanId of slot.chosenSpanIds ?? []) chosenSpanIds.add(spanId);
    }
  }
  const assetById = new Map(input.assets.map(asset => [asset.id, asset]));
  const byType = buildCoverageRows(groupBy(input.spans, span => span.type || 'unknown'), chosenSpanIds);
  const events = Array.isArray(input.chronology?.events) ? input.chronology.events : [];
  const byEvent = events.map(event => buildCoverageRow({
    key: event.id,
    label: event.title,
    spanIds: event.spanIds ?? [],
    chosenSpanIds,
  })).filter(row => row.available > 0);
  const byDayMap = new Map();
  for (const event of events) {
    const day = event.startAt?.slice(0, 10) || event.endAt?.slice(0, 10) || 'unknown-day';
    byDayMap.set(day, [...(byDayMap.get(day) ?? []), ...(event.spanIds ?? [])]);
  }
  const byDay = buildCoverageRows(byDayMap, chosenSpanIds);
  const speechProtectedSpanIds = input.spans
    .filter(span => assetById.get(span.assetId)?.kind !== 'photo' && spanHasSpeechTruth(span))
    .map(span => span.id);
  const droppedSpeech = speechProtectedSpanIds.filter(spanId => !chosenSpanIds.has(spanId));
  return {
    generatedAt: input.now,
    byType,
    byDay,
    byEvent,
    speechProtected: {
      available: speechProtectedSpanIds.length,
      chosen: speechProtectedSpanIds.length - droppedSpeech.length,
      dropped: droppedSpeech.length,
      droppedSpanIds: droppedSpeech.slice(0, 500),
    },
    notes: ['Generated by local span speech truth repair; rerun material.recall for a full recall-quality rebuild.'],
  };
}

function groupBy(spans, resolveKey) {
  const map = new Map();
  for (const span of spans) {
    const key = resolveKey(span);
    map.set(key, [...(map.get(key) ?? []), span.id]);
  }
  return map;
}

function buildCoverageRows(grouped, chosenSpanIds) {
  return Array.from(grouped.entries())
    .map(([key, spanIds]) => buildCoverageRow({ key, spanIds, chosenSpanIds }))
    .sort((left, right) => right.available - left.available || left.key.localeCompare(right.key));
}

function buildCoverageRow(input) {
  const spanIds = Array.from(new Set(input.spanIds));
  const chosen = spanIds.filter(spanId => input.chosenSpanIds.has(spanId));
  const dropped = spanIds.filter(spanId => !input.chosenSpanIds.has(spanId));
  return {
    key: input.key,
    label: input.label,
    available: spanIds.length,
    chosen: chosen.length,
    dropped: dropped.length,
    droppedSpanIds: dropped.slice(0, 300),
  };
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function normalizeText(value) {
  const text = String(value ?? '').replace(/\s+/gu, ' ').trim();
  return text || undefined;
}

function stripUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}
