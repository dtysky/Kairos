#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
  basename,
  dirname,
  extname,
  join,
  resolve,
} from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const WORKSPACE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VALID_PACKET_SCHEMA = 'kairos-postlock-narration-framework-clip-packet-v2';
const VALID_MAP_SCHEMA = 'kairos-postlock-narration-framework-clip-map-v2';
const FRAMEWORK_FORMAT = 'markdown-pack-list-v2';
const VISUAL_SPAN_NEAR_DISTANCE_MS = 15_000;
const WEAK_SPEECH_SUMMARY_PARTS = new Set([
  '短促现场反应',
  '短促语气反应',
  '短促现场指示',
]);
const FORBIDDEN_SPEECH_SUMMARY_PARTS = new Set([
  '口播信息待人工复核',
  '现场口播片段',
]);

const args = parseArgs(process.argv.slice(2));
if (!args.projectRoot) {
  console.error('Usage: node scripts/generate-postlock-narration-framework.mjs <projectRoot> [editId] [--timeline-export path] [--framework-draft path] [--candidate-only] [--subagent-id id]');
  process.exit(2);
}

const projectRoot = resolve(args.projectRoot);
const editId = args.editId || 'main';
const generatedAt = new Date().toISOString();

const project = await readJson(join(projectRoot, 'store', 'project.json'));
const editUnit = await readJson(join(projectRoot, 'edits', editId, 'config', 'edit-unit.json'));
const flowPlanPath = join(projectRoot, 'edits', editId, 'planning', 'flow-plan.json');
const flowPlanRaw = await readFile(flowPlanPath, 'utf8');
const flowPlan = JSON.parse(flowPlanRaw);
const lockedRoughCut = await readJson(join(projectRoot, 'edits', editId, 'timeline', 'locked-rough-cut.json'));
const materialSlots = await readOptionalJson(join(projectRoot, 'edits', editId, 'script', 'material-slots.json'));
const timelineExport = args.timelineExport
  ? await readJson(resolve(args.timelineExport))
  : await exportResolveTimeline({
    resolveProjectName: lockedRoughCut.resolveProjectName,
    timelineName: lockedRoughCut.timelineName,
  });

const timelineAudit = await readOptionalJson(resolveTimelineAuditPath(projectRoot, lockedRoughCut.timelineAuditPath));
const chronology = await readOptionalJson(join(projectRoot, 'media', 'chronology.json'));
const contentIndex = buildContentIndex(timelineAudit, materialSlots, chronology);
const spatialIndex = await buildSpatialIndex(projectRoot);
const outputRoots = resolveOutputRoots(projectRoot, editId);
await mkdir(outputRoots.tmpPostlockRoot, { recursive: true });
await mkdir(outputRoots.officialPostlockRoot, { recursive: true });

const packet = buildClipPacket({
  project,
  editUnit,
  flowPlan,
  lockedRoughCut,
  timelineExport,
  contentIndex,
  spatialIndex,
  generatedAt,
});
const frameworkEntries = buildFrameworkEntries(packet);
const frameworkPacks = buildFrameworkPacks(packet, frameworkEntries);
const generatedFramework = buildFrameworkMarkdown(packet, frameworkPacks, generatedAt);
const framework = args.frameworkDraft
  ? await readFile(resolve(args.frameworkDraft), 'utf8')
  : generatedFramework;
const clipMapPacks = alignFrameworkPacksToMarkdown(frameworkPacks, framework);
const clipMap = buildClipMap(frameworkEntries, clipMapPacks);

const candidateFrameworkPath = join(outputRoots.tmpPostlockRoot, 'narration-framework.candidate.md');
const candidateMapPath = join(outputRoots.tmpPostlockRoot, 'narration-framework.clip-map.candidate.json');
const preciseGeoAudit = buildPreciseGeoAudit(packet);
await writeJson(outputRoots.rawResolveExportPath, timelineExport);
await writeJson(outputRoots.packetPath, packet);
await writeJson(outputRoots.preciseGeoPath, preciseGeoAudit);
await writeFile(candidateFrameworkPath, framework, 'utf8');
await writeJson(candidateMapPath, clipMap);

await runValidator(projectRoot, editId, {
  framework: candidateFrameworkPath,
  map: candidateMapPath,
});

if (args.candidateOnly) {
  process.stdout.write(JSON.stringify({
    ok: true,
    candidateOnly: true,
    projectRoot,
    editId,
    candidateFrameworkPath,
    candidateMapPath,
    packetPath: outputRoots.packetPath,
    rawResolveExportPath: outputRoots.rawResolveExportPath,
    videoClipCount: packet.summary.videoClipCount,
    speechClipCount: packet.summary.speechClipCount,
    narrationClipCount: packet.summary.narrationClipCount,
    frameworkFormat: FRAMEWORK_FORMAT,
    lineCount: frameworkEntries.length,
    packCount: frameworkPacks.length,
  }, null, 2));
  process.stdout.write('\n');
  process.exit(0);
}

await copyFile(candidateFrameworkPath, outputRoots.frameworkPath);
await copyFile(candidateMapPath, outputRoots.clipMapPath);
await runValidator(projectRoot, editId);

const runRecord = buildRunRecord({
  project,
  editId,
  flowPlan,
  flowPlanRaw,
  lockedRoughCut,
  packet,
  framework,
  generatedAt,
  subagentId: args.subagentId,
});
await appendRunRecord(projectRoot, editId, runRecord, generatedAt);

process.stdout.write(JSON.stringify({
  ok: true,
  projectRoot,
  editId,
  frameworkPath: outputRoots.frameworkPath,
  clipMapPath: outputRoots.clipMapPath,
  packetPath: outputRoots.packetPath,
  rawResolveExportPath: outputRoots.rawResolveExportPath,
  videoClipCount: packet.summary.videoClipCount,
  speechClipCount: packet.summary.speechClipCount,
  narrationClipCount: packet.summary.narrationClipCount,
  frameworkFormat: FRAMEWORK_FORMAT,
  lineCount: frameworkEntries.length,
  packCount: frameworkPacks.length,
}, null, 2));
process.stdout.write('\n');

function parseArgs(argv) {
  const parsed = {
    projectRoot: '',
    editId: '',
    timelineExport: '',
    frameworkDraft: '',
    candidateOnly: false,
    subagentId: '',
  };
  const positional = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--timeline-export') {
      parsed.timelineExport = argv[++index] || '';
      continue;
    }
    if (arg === '--framework-draft') {
      parsed.frameworkDraft = argv[++index] || '';
      continue;
    }
    if (arg === '--candidate-only') {
      parsed.candidateOnly = true;
      continue;
    }
    if (arg === '--subagent-id') {
      parsed.subagentId = argv[++index] || '';
      continue;
    }
    positional.push(arg);
  }
  parsed.projectRoot = positional[0] || '';
  parsed.editId = positional[1] || '';
  return parsed;
}

async function exportResolveTimeline(input) {
  const requestRoot = await mkdtemp(join(tmpdir(), 'kairos-postlock-export-'));
  const requestPath = join(requestRoot, 'request.json');
  const scriptPath = join(WORKSPACE_ROOT, 'vendor', 'resolve-color-host', 'resolve-color-host.py');
  const pythonPath = resolvePythonPath();
  await writeJson(requestPath, {
    operation: 'export_edit_timeline_clip_packet',
    input,
  });
  try {
    const { stdout } = await execFile(
      pythonPath,
      [scriptPath, '--request', requestPath],
      {
        cwd: dirname(scriptPath),
        env: {
          ...process.env,
          PYTHONIOENCODING: 'utf-8',
        },
        encoding: 'utf8',
        maxBuffer: 256 * 1024 * 1024,
      },
    );
    return JSON.parse(stdout.trim());
  } catch (error) {
    const stderr = typeof error?.stderr === 'string' ? error.stderr : '';
    const stdout = typeof error?.stdout === 'string' ? error.stdout : '';
    const detail = stderr.trim() || stdout.trim() || error.message;
    throw new Error(`Resolve timeline export failed: ${detail}`);
  } finally {
    await rm(requestRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

function resolvePythonPath() {
  const candidates = [
    join(WORKSPACE_ROOT, 'vendor', 'resolve-color-host', '.venv', 'bin', 'python'),
    join(WORKSPACE_ROOT, 'vendor', 'resolve-color-host', '.venv', 'Scripts', 'python.exe'),
  ];
  return candidates.find(candidate => existsSync(candidate)) || 'python3';
}

function buildContentIndex(timelineAudit, materialSlots, chronology) {
  const empty = {
    clipsById: new Map(),
    spansById: new Map(),
    assetsById: new Map(),
    assetsByStem: new Map(),
    spansByAssetId: new Map(),
    visualSpansByAssetId: new Map(),
    slotsById: new Map(),
    chronologyBySpanId: new Map(),
  };
  for (const event of chronology?.events ?? []) {
    const context = buildChronologyEventContext(event);
    if (!context) continue;
    for (const spanId of collectChronologySpanIds(event)) {
      empty.chronologyBySpanId.set(spanId, context);
    }
  }
  for (const segment of materialSlots?.segments ?? []) {
    for (const slot of segment?.slots ?? []) {
      if (!slot?.id) continue;
      empty.slotsById.set(slot.id, {
        segmentId: segment.segmentId,
        slotId: slot.id,
        query: typeof slot.query === 'string' ? slot.query : '',
      });
    }
  }
  if (!timelineAudit || typeof timelineAudit !== 'object') return empty;
  for (const asset of timelineAudit.assets ?? []) {
    if (!asset?.id) continue;
    empty.assetsById.set(asset.id, asset);
    for (const stem of assetLookupStems(asset)) {
      addMapList(empty.assetsByStem, normalizeKey(stem), asset);
    }
  }
  for (const span of timelineAudit.spans ?? timelineAudit.slices ?? []) {
    if (!span?.id) continue;
    empty.spansById.set(span.id, span);
    if (span.assetId) {
      addMapList(empty.spansByAssetId, span.assetId, span);
      if (isVisualEvidenceSpan(span)) {
        addMapList(empty.visualSpansByAssetId, span.assetId, span);
      }
    }
  }
  for (const clip of timelineAudit.timeline?.clips ?? []) {
    if (clip?.id) empty.clipsById.set(clip.id, clip);
  }
  return empty;
}

function buildChronologyEventContext(event) {
  if (!event || typeof event !== 'object') return null;
  const title = safeHumanLabel(event.title || event.name || '');
  const location = safeHumanLabel(event.location || '');
  const route = formatRouteLabel(event.route);
  return {
    eventId: event.id || '',
    kind: event.kind || '',
    title,
    location,
    route,
    startAt: event.startAt || '',
    endAt: event.endAt || '',
    summaryTags: extractChronologySummaryTags(event.summary),
  };
}

function collectChronologySpanIds(event) {
  const ids = new Set();
  const visit = (value) => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (Array.isArray(value.spanIds)) {
      for (const spanId of value.spanIds) {
        if (typeof spanId === 'string' && spanId.trim()) ids.add(spanId);
      }
    }
    for (const [key, child] of Object.entries(value)) {
      if (key === 'spanIds') continue;
      if (child && typeof child === 'object') visit(child);
    }
  };
  visit(event);
  return [...ids];
}

function formatRouteLabel(route) {
  if (!route || typeof route !== 'object') return '';
  const from = safeHumanLabel(route.from || '');
  const to = safeHumanLabel(route.to || '');
  if (from && to) return `${shortLocationLabel(from)}→${shortLocationLabel(to)}`;
  return from || to;
}

function extractChronologySummaryTags(summary) {
  const tags = [];
  for (const rawPart of String(summary || '').split(/\s*\/\s*|[，,；;。]/u)) {
    const part = sanitizeDescriptionPart(rawPart);
    if (!part || !hasCjk(part)) continue;
    if (part.length > 16 || /\.\.\.|…|\s/u.test(part)) continue;
    if (!isVisualFrameworkTag(part)) continue;
    if (/情景不明|天气光线不明|无口播语音|有口播语音|口播片段/u.test(part)) continue;
    if (/[A-Za-z]{4,}/u.test(part)) continue;
    if (tags.includes(part)) continue;
    tags.push(part);
    if (tags.length >= 12) break;
  }
  return tags;
}

async function buildSpatialIndex(root) {
  const derived = await readOptionalJson(join(root, 'gps', 'derived.json'));
  const reverse = await readOptionalJson(join(root, 'gps', 'reverse-geocode-cache.json'));
  const pharosContext = await readOptionalJson(join(root, 'analysis', 'pharos-context.json'));
  const derivedByAssetId = new Map();
  for (const entry of derived?.entries ?? []) {
    if (!entry?.sourceAssetId) continue;
    if (!Number.isFinite(Number(entry.lat)) || !Number.isFinite(Number(entry.lng))) continue;
    derivedByAssetId.set(entry.sourceAssetId, entry);
  }

  const reverseByKey = new Map();
  const reverseEntries = [];
  for (const entry of reverse?.entries ?? []) {
    if (!entry || entry.status !== 'ok') continue;
    if (!Number.isFinite(Number(entry.lat)) || !Number.isFinite(Number(entry.lng))) continue;
    reverseEntries.push(entry);
    if (entry.locationKey) reverseByKey.set(String(entry.locationKey), entry);
  }

  const gpxPaths = (pharosContext?.gpxFiles ?? [])
    .map(file => file?.path)
    .filter(filePath => typeof filePath === 'string' && filePath && existsSync(filePath));
  const gpxPoints = (await Promise.all(gpxPaths.map(loadGpxPointsFromFile)))
    .flat()
    .sort((left, right) => left.timeMs - right.timeMs);

  return {
    derivedByAssetId,
    reverseByKey,
    reverseEntries,
    gpxPoints,
  };
}

async function loadGpxPointsFromFile(filePath) {
  const text = await readFile(filePath, 'utf8').catch(() => '');
  if (!text) return [];
  const points = [];
  const matcher = /<trkpt\b[^>]*lat="([^"]+)"[^>]*lon="([^"]+)"[^>]*>[\s\S]*?<time>([^<]+)<\/time>/giu;
  for (const match of text.matchAll(matcher)) {
    const lat = Number(match[1]);
    const lng = Number(match[2]);
    const time = String(match[3] || '').trim();
    const timeMs = Date.parse(time);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(timeMs)) continue;
    points.push({ lat, lng, time, timeMs, sourcePath: filePath });
  }
  return points;
}

function resolveClipGeoContext({ asset, sourceRange, spatialIndex }) {
  if (!asset || !spatialIndex) return null;

  const embedded = asset.embeddedGps;
  if (
    Number.isFinite(Number(embedded?.representativeLat))
    && Number.isFinite(Number(embedded?.representativeLng))
  ) {
    return buildGeoContext({
      lat: Number(embedded.representativeLat),
      lng: Number(embedded.representativeLng),
      time: embedded.representativeTime || embedded.startTime || asset.capturedAt,
      source: embedded.originType ? `embedded-${embedded.originType}` : 'embedded-gps',
      confidence: finiteNumber(embedded.confidence) ?? 0.96,
      spatialIndex,
    });
  }

  const derived = asset.id ? spatialIndex.derivedByAssetId.get(asset.id) : null;
  if (derived) {
    return buildGeoContext({
      lat: Number(derived.lat),
      lng: Number(derived.lng),
      time: derived.time || asset.capturedAt,
      source: derived.originType || 'derived-gps',
      confidence: finiteNumber(derived.confidence) ?? 0.78,
      spatialIndex,
    });
  }

  const timeMs = clipRepresentativeTimeMs(asset, sourceRange);
  const nearest = pickNearestGpxPoint(spatialIndex.gpxPoints, timeMs, 10 * 60 * 1000);
  if (!nearest) return null;
  return buildGeoContext({
    lat: nearest.lat,
    lng: nearest.lng,
    time: nearest.time,
    source: 'pharos-gpx-nearest',
    confidence: nearest.deltaMs <= 60_000 ? 0.92 : 0.84,
    deltaMs: nearest.deltaMs,
    sourcePath: nearest.sourcePath,
    spatialIndex,
  });
}

function clipRepresentativeTimeMs(asset, sourceRange) {
  const capturedAtMs = Date.parse(asset?.capturedAt || asset?.createdAt || asset?.rawCapturedAt || '');
  if (!Number.isFinite(capturedAtMs)) return null;
  const inMs = finiteNumber(sourceRange?.sourceInMs) ?? 0;
  const outMs = finiteNumber(sourceRange?.sourceOutMs) ?? inMs;
  const midpointMs = Math.max(0, (inMs + outMs) / 2);
  return capturedAtMs + midpointMs;
}

function pickNearestGpxPoint(points, timeMs, maxDeltaMs) {
  if (!Array.isArray(points) || points.length === 0 || !Number.isFinite(timeMs)) return null;
  let low = 0;
  let high = points.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (points[mid].timeMs < timeMs) low = mid + 1;
    else high = mid;
  }
  const candidates = [points[low - 1], points[low], points[low + 1]].filter(Boolean);
  let best = null;
  for (const point of candidates) {
    const deltaMs = Math.abs(point.timeMs - timeMs);
    if (deltaMs > maxDeltaMs) continue;
    if (!best || deltaMs < best.deltaMs) best = { ...point, deltaMs };
  }
  return best;
}

function buildGeoContext({ lat, lng, time, source, confidence, deltaMs, sourcePath, spatialIndex }) {
  const reverse = findReverseGeocode(lat, lng, spatialIndex);
  const rawLocationText = reverse?.locationText || reverse?.formatted || reverse?.rawLabel || reverse?.label || '';
  const transportFacility = transportFacilityHintForGeo({ lat, lng, text: rawLocationText });
  const label = cleanGeoLabel(rawLocationText) || transportFacility?.label || '';
  const terrain = transportFacility?.terrain || terrainHintForGeo(rawLocationText || label);
  return {
    source,
    lat: roundCoordinate(lat),
    lng: roundCoordinate(lng),
    time: time || '',
    ...(Number.isFinite(deltaMs) ? { deltaMs: Math.round(deltaMs) } : {}),
    confidence,
    label,
    rawLocationText: rawLocationText || undefined,
    terrain: terrain || undefined,
    sourcePath: sourcePath || undefined,
  };
}

function findReverseGeocode(lat, lng, spatialIndex) {
  if (!spatialIndex) return null;
  const key = `${Number(lng).toFixed(6)},${Number(lat).toFixed(6)}`;
  const exact = spatialIndex.reverseByKey.get(key);
  if (exact) return { ...exact, matchDistance: 0 };
  let best = null;
  let bestDistance = Infinity;
  for (const entry of spatialIndex.reverseEntries ?? []) {
    if (isInvalidReverseLocationText(entry.locationText || entry.formatted || entry.rawLabel || entry.label || '')) continue;
    const distance = Math.hypot(Number(entry.lat) - Number(lat), Number(entry.lng) - Number(lng));
    if (distance >= bestDistance) continue;
    best = entry;
    bestDistance = distance;
  }
  return bestDistance <= 0.03 ? { ...best, matchDistance: bestDistance } : null;
}

function cleanGeoLabel(value) {
  const clean = sanitizeDescriptionPart(value);
  if (!clean) return '';
  if (isInvalidReverseLocationText(clean)) return '';
  if (containsRouteArrow(clean)) return '';
  const [rawAdmin, rawPoi = ''] = clean.split(/\s*·\s*/u);
  const adminParts = rawAdmin.split(/[，,]/u).map(part => part.trim()).filter(Boolean);
  const admin = adminParts.slice(-2).join('');
  const poi = sanitizeDescriptionPart(rawPoi).replace(/[()（）]/gu, '');
  const badPoi = /服务区|公司|园区|物流|商贸|汽车|委员会|村委会|卫生室|卫生间|厕所|公交|车站|消纳场|加油站|充电站|收费站|停车场|酒店|民宿|客栈|饭店|餐馆|观景台售票|摆渡/u.test(poi);
  if (admin && poi && !badPoi && !normalizeComparisonText(admin).includes(normalizeComparisonText(poi))) {
    return `${admin}·${poi}`.slice(0, 42);
  }
  return (admin || poi || clean).slice(0, 42);
}

function containsRouteArrow(value) {
  return /→|->|至|到/u.test(String(value || ''));
}

function isInvalidReverseLocationText(value) {
  const text = sanitizeDescriptionPart(value);
  return !text || /^Earth$/iu.test(text) || /^中国$/u.test(text) || /^0+(\.0+)?[,，]0+(\.0+)?$/u.test(text);
}

function terrainHintForGeo(value) {
  const text = String(value || '');
  if (/深中通道|伶仃洋|中山大桥/u.test(text)) return '深中通道跨越伶仃洋的海面桥隧、珠江口水汽和桥面车流';
  if (/老姆登|匹河|福贡/u.test(text)) return '碧罗雪山西坡、怒江峡谷云雾山村和常绿阔叶林坡';
  if (/丙中洛|贡山|怒江大峡谷/u.test(text)) return '怒江大峡谷北段、碧罗雪山与高黎贡山夹峙的江湾和崖壁';
  if (/石月亮/u.test(text)) return '怒江峡谷中段的沿江山路、陡坡村落和亚热带河谷植被';
  if (/然乌|八宿|白玛/u.test(text)) return '然乌湖、帕隆藏布上游冰川湖谷和雪线山坡';
  if (/永平|博南|阿米田|杭瑞/u.test(text)) return '博南山云雾林带、杭瑞高速桥隧和湿润山谷';
  if (/抚仙湖|澄江|江川/u.test(text)) return '抚仙湖湖盆、湖岸丘陵和云南松林带';
  if (/兴义|黔西南|万峰林|纳灰|八卦田/u.test(text)) return '万峰林喀斯特峰丛、纳灰河水渠和田块村路';
  if (/格聂|理塘|禾尼|奔戈|下则通|然日卡/u.test(text)) return '格聂神山周边高山草甸、雪线山口和融雪溪沟';
  if (/新都桥|折多|康定/u.test(text)) return '折多山以西的高原草甸、贡嘎远山和针叶林坡';
  if (/左贡|芒康|巴塘|东达/u.test(text)) return '横断山高海拔山口、澜沧江峡谷和针叶林坡';
  if (/子梅|贡嘎|上木居/u.test(text)) return '贡嘎西坡雪山垭口、针叶林线和高山草甸';
  if (/深圳|珠三角|江门|开平|赤坎/u.test(text)) return '珠三角湿热平原高速、桥面水汽和城镇灯带';
  if (/南宁|百色|灵山|田东|册亨/u.test(text)) return '桂西到黔西南的喀斯特丘陵、高速桥隧和常绿山地';
  return '';
}

function vegetationHintForGeo(value) {
  const text = String(value || '');
  if (/察瓦龙|丙中洛|贡山|怒江大峡谷|高黎贡|碧罗/u.test(text)) {
    return '干热河谷灌丛、云南松和针阔混交林';
  }
  if (/古玉|慈巴沟|竹瓦根|桑曲|雅热|雄珠拉|德姆拉|察隅/u.test(text)) {
    return '高山针叶林、杜鹃灌丛和冷杉林线';
  }
  if (/然乌|来古|波密|米堆|八宿|帕隆藏布/u.test(text)) {
    return '高山针叶林、杜鹃灌丛和湖岸草甸';
  }
  if (/格聂|理塘|禾尼|奔戈|下则通|然日卡|新都桥|折多|康定|子梅|贡嘎|上木居/u.test(text)) {
    return '高山草甸、杜鹃灌丛和冷杉林线';
  }
  if (/左贡|芒康|巴塘|东达|金沙江|澜沧江/u.test(text)) {
    return '高山灌丛、河谷草坡和针叶林坡';
  }
  if (/抚仙湖|澄江|江川/u.test(text)) {
    return '云南松林、湖岸灌丛和农田植被';
  }
  if (/兴义|黔西南|万峰林|纳灰|八卦田/u.test(text)) {
    return '喀斯特灌草坡、田埂植被和常绿阔叶林';
  }
  if (/南宁|百色|灵山|田东|册亨/u.test(text)) {
    return '亚热带常绿阔叶林、竹木灌丛和喀斯特石山植被';
  }
  if (/深圳|珠三角|江门|开平|赤坎/u.test(text)) {
    return '南亚热带常绿阔叶林和路侧绿化';
  }
  return '';
}

function transportFacilityHintForClip(clip) {
  const geo = clip?.geoContext ?? {};
  return transportFacilityHintForGeo({
    lat: geo.lat,
    lng: geo.lng,
    text: [
      geo.rawLocationText,
      geo.label,
      clip?.eventTitle,
      clip?.chronologyContext?.title,
      clip?.chronologyContext?.route,
      clip?.description,
      clip?.visualObservation,
    ].filter(Boolean).join('，'),
  });
}

function transportFacilityHintForGeo({ lat, lng, text = '' } = {}) {
  const cleanText = sanitizeDescriptionPart(text);
  const explicit = extractTransportFacilityName(cleanText);
  if (explicit) return { label: explicit, terrain: terrainHintForGeo(explicit) || transportFacilityTerrain(explicit) };

  const latNumber = Number(lat);
  const lngNumber = Number(lng);
  if (
    Number.isFinite(latNumber) &&
    Number.isFinite(lngNumber) &&
    latNumber >= 22.43 &&
    latNumber <= 22.62 &&
    lngNumber >= 113.12 &&
    lngNumber <= 113.82 &&
    /深圳|中山|江门|珠三角|高速|桥|桥面|桥体|通道|出城|西行|车流|雨|雾/u.test(cleanText)
  ) {
    return {
      label: '深中通道',
      terrain: '深中通道跨越伶仃洋的海面桥隧、珠江口水汽和桥面车流',
    };
  }
  return null;
}

function extractTransportFacilityName(value) {
  const text = String(value || '');
  const explicit = text.match(/深中通道|港珠澳大桥|黄茅海跨海通道|虎门大桥|南沙大桥|金沙江大桥|平陆运河旧州特大桥|怒江72拐/u)?.[0];
  if (explicit) return explicit;
  const generic = text.match(/([\p{Script=Han}A-Za-z0-9]{2,24}(?:特大桥|大桥|隧道|通道|互通|收费站|立交|枢纽))/u)?.[1];
  if (!generic) return '';
  if (/项目部|管理中心|停车场|观赏点|旅游集散中心|生活营地|办公室/u.test(generic)) return '';
  return generic;
}

function transportFacilityTerrain(name) {
  const text = String(name || '');
  if (/大桥|通道/u.test(text)) return '桥面、江河湖海水汽和跨水交通线';
  if (/隧道/u.test(text)) return '山体隧道、洞口光线和连续道路';
  if (/互通|立交|枢纽/u.test(text)) return '高速互通、匝道和车流转向';
  if (/收费站/u.test(text)) return '高速收费站、车道灯光和通行节点';
  return '';
}

function roundCoordinate(value) {
  return Math.round(Number(value) * 1_000_000) / 1_000_000;
}

function buildClipPacket(context) {
  const fps = Number(context.timelineExport.fps) > 0 ? Number(context.timelineExport.fps) : 30;
  const subtitleItems = (context.timelineExport.subtitleItems ?? [])
    .filter(item => item && item.clipEnabled !== false && hasFiniteRange(item))
    .map((item, index) => ({ ...item, subtitleIndex: index + 1 }));
  const videoItems = (context.timelineExport.videoItems ?? [])
    .filter(item => item && item.clipEnabled !== false)
    .sort(compareTimelineItems);

  const clips = videoItems.map((item, itemIndex) => {
    const clipId = extractClipId(item.name);
    const previousClipCandidate = clipId ? context.contentIndex.clipsById.get(clipId) : null;
    const currentSourceAsset = resolveAssetFromCurrentSource(item, context.contentIndex);
    const previousClip = isPreviousClipCompatible(previousClipCandidate, currentSourceAsset)
      ? previousClipCandidate
      : null;
    const staleResolveNameClipId = previousClipCandidate && !previousClip ? clipId : '';
    const slot = previousClip?.linkedScriptBeatId
      ? context.contentIndex.slotsById.get(previousClip.linkedScriptBeatId)
      : null;
    const asset = currentSourceAsset ?? resolveAssetForItem(item, previousClip, context.contentIndex);
    const span = resolveSpanForItem(item, previousClip, asset, context.contentIndex);
    const sourceRange = sourceRangeForItem(item, asset, fps);
    const geoContext = resolveClipGeoContext({
      asset,
      sourceRange,
      spatialIndex: context.spatialIndex,
    });
    const subtitleOverlaps = subtitleItems
      .filter(subtitle => rangesOverlapFrames(item, subtitle, fps))
      .map(subtitle => ({
        subtitleIndex: subtitle.subtitleIndex,
        trackIndex: subtitle.trackIndex,
        startFrame: subtitle.startFrame,
        endFrame: subtitle.endFrame,
        text: cleanSubtitleText(subtitle.text),
      }));
    const hasSubtitle = subtitleOverlaps.length > 0;
    const subtitleText = summarizeSubtitleText(subtitleOverlaps);
    const subtitleSummary = hasSubtitle
      ? summarizeSpeechFromSubtitles(subtitleOverlaps.map(subtitle => subtitle.text))
      : '';
    const speechTopicTokens = hasSubtitle
      ? extractSpeechTopicTokens(subtitleOverlaps.map(subtitle => subtitle.text))
      : [];
    const contentKind = classifyContentKind({ item, span, asset, previousClip });
    const narrationVisualEvidence = hasSubtitle
      ? undefined
      : resolveNarrationVisualEvidence({
        item,
        itemIndex,
        asset,
        span,
        contentIndex: context.contentIndex,
        sourceRange,
      });
    const evidenceSpan = narrationVisualEvidence?.spanId
      ? context.contentIndex.spansById.get(narrationVisualEvidence.spanId)
      : null;
    const chronologySpan = evidenceSpan ?? span;
    const chronologyContext = chronologySpan?.id
      ? context.contentIndex.chronologyBySpanId.get(chronologySpan.id)
      : null;
    const frameworkClass = hasSubtitle
      ? 'speech'
      : contentKind === 'aerial'
        ? 'aerial'
        : contentKind === 'timelapse'
          ? 'timelapse'
          : 'visual';
    const visualObservation = narrationVisualEvidence?.visualObservation
      ?? (typeof span?.visualObservation === 'string' ? span.visualObservation : undefined);
    const eventTitle = safeHumanLabel(chronologyContext?.title || '');
    return {
      index: itemIndex + 1,
      resolveTrackIndex: item.trackIndex,
      resolveName: item.name || '',
      resolveNameClipId: clipId || undefined,
      staleResolveNameClipId: staleResolveNameClipId || undefined,
      previousClipId: previousClip ? clipId : undefined,
      linkedScriptSegmentId: previousClip?.linkedScriptSegmentId || slot?.segmentId || undefined,
      linkedScriptBeatId: previousClip?.linkedScriptBeatId || slot?.slotId || undefined,
      slotQuery: slot?.query || undefined,
      assetId: previousClip?.assetId || asset?.id || undefined,
      spanIds: span?.id ? [span.id] : [],
      sourceStem: item.sourceStem || stemFromPath(item.filePath || item.name || ''),
      sourceFilePath: item.filePath || undefined,
      timelineStartFrame: item.startFrame,
      timelineEndFrame: item.endFrame,
      timelineInMs: finiteNumber(item.timelineInMs),
      timelineOutMs: finiteNumber(item.timelineOutMs),
      durationMs: finiteNumber(item.durationMs),
      sourceStartFrame: item.sourceStartFrame,
      sourceEndFrame: item.sourceEndFrame,
      sourceInMs: sourceRange?.sourceInMs,
      sourceOutMs: sourceRange?.sourceOutMs,
      sourceFps: sourceRange?.fps,
      hasSubtitle,
      subtitleText,
      subtitleSummary: subtitleSummary || undefined,
      speechTopicTokens: speechTopicTokens.length > 0 ? speechTopicTokens : undefined,
      subtitleOverlaps,
      frameworkClass,
      contentKind,
      semanticKind: span?.semanticKind || undefined,
      visualObservation,
      ...(geoContext ? { geoContext } : {}),
      ...(narrationVisualEvidence ? { narrationVisualEvidence } : {}),
      chronologyContext: chronologyContext || undefined,
      eventTitle: eventTitle || undefined,
      description: describeClip({
        hasSubtitle,
        frameworkClass,
        contentKind,
        visualObservation,
        narrationVisualEvidence,
        subtitleText,
        subtitleSummary,
        slotQuery: slot?.query,
        eventTitle,
        chronologyContext,
        geoContext,
        resolveName: item.name,
        sourceStem: item.sourceStem,
      }),
    };
  });

  return {
    schemaVersion: VALID_PACKET_SCHEMA,
    projectId: context.project.id,
    projectDirectory: basename(projectRoot),
    editId,
    editRuleCategory: context.editUnit.editRuleCategory,
    generatedAt: context.generatedAt,
    source: {
      resolveProjectName: context.lockedRoughCut.resolveProjectName,
      timelineName: context.lockedRoughCut.timelineName,
      timelineFps: fps,
      resolveExportSchemaVersion: context.timelineExport.schemaVersion,
      exportedAt: context.timelineExport.exportedAt,
    },
    summary: {
      videoClipCount: clips.length,
      speechClipCount: clips.filter(clip => clip.frameworkClass === 'speech').length,
      narrationClipCount: clips.filter(clip => clip.frameworkClass !== 'speech').length,
      visualClipCount: clips.filter(clip => clip.frameworkClass === 'visual').length,
      aerialClipCount: clips.filter(clip => clip.frameworkClass === 'aerial').length,
      timelapseClipCount: clips.filter(clip => clip.frameworkClass === 'timelapse').length,
      chronologyContextClipCount: clips.filter(clip => clip.chronologyContext?.eventId).length,
      subtitleItemCount: subtitleItems.length,
      sourceVideoItemCount: videoItems.length,
    staleResolveNameClipIdCount: clips.filter(clip => clip.staleResolveNameClipId).length,
      narrationVisualEvidenceCount: clips.filter(clip => !clip.hasSubtitle && clip.narrationVisualEvidence?.visualObservation).length,
      narrationVisualEvidenceSameAssetVisualSpanCount: clips.filter(clip => clip.narrationVisualEvidence?.source === 'same-asset-visual-span').length,
      narrationVisualEvidenceFallbackCount: clips.filter(clip => clip.narrationVisualEvidence?.source === 'speech-span-visualObservation-fallback').length,
      narrationVisualEvidenceWarningCount: clips.filter(clip => clip.narrationVisualEvidence?.source === 'missing-visualObservation-warning').length,
    },
    policy: {
      allowTimelapseSequenceMerge: hasTimelapseSequenceMergeInstruction(context.flowPlan),
      narrationVisualEvidencePolicy: 'visualObservation-only',
      speechNoSubtitleVisualSpanNearDistanceMs: VISUAL_SPAN_NEAR_DISTANCE_MS,
    },
    clips,
  };
}

function hasTimelapseSequenceMergeInstruction(flowPlan) {
  const text = JSON.stringify(flowPlan ?? {});
  return /延时摄影[^。；\n]*合并|延时[^。；\n]*合并成|timelapse[^.]*merge/i.test(text);
}

function buildFrameworkEntries(packet) {
  const entries = [];
  let speechMergeIndex = 0;
  let photoSequenceIndex = 0;
  let timelapseSequenceIndex = 0;
  for (let index = 0; index < packet.clips.length;) {
    const clip = packet.clips[index];
    if (clip.frameworkClass !== 'speech') {
      const group = [clip];
      let cursor = index + 1;
      const sequenceKind = isPhotoFrameworkClip(clip)
        ? 'photo'
        : packet.policy?.allowTimelapseSequenceMerge && isTimelapseFrameworkClip(clip)
          ? 'timelapse'
          : '';
      if (sequenceKind === 'photo') {
        while (cursor < packet.clips.length && canMergePhotoSequence(group[group.length - 1], packet.clips[cursor], packet.source.timelineFps)) {
          group.push(packet.clips[cursor]);
          cursor += 1;
        }
      } else if (sequenceKind === 'timelapse') {
        while (cursor < packet.clips.length && canMergeTimelapseSequence(group[group.length - 1], packet.clips[cursor], packet.source.timelineFps)) {
          group.push(packet.clips[cursor]);
          cursor += 1;
        }
      }
      if (sequenceKind === 'photo' && group.length > 1) {
        photoSequenceIndex += 1;
        const photoSequenceGroupId = `photo-sequence-${String(photoSequenceIndex).padStart(4, '0')}`;
        for (const photoClip of group) {
          photoClip.frameworkPhotoSequenceGroupId = photoSequenceGroupId;
          photoClip.frameworkPhotoSequenceReason = 'adjacent-no-subtitle-photo-sequence';
        }
        entries.push(buildPhotoSequenceFrameworkEntry(entries.length + 1, group, photoSequenceGroupId));
      } else if (sequenceKind === 'timelapse' && group.length > 1) {
        timelapseSequenceIndex += 1;
        const timelapseSequenceGroupId = `timelapse-sequence-${String(timelapseSequenceIndex).padStart(4, '0')}`;
        for (const timelapseClip of group) {
          timelapseClip.frameworkTimelapseSequenceGroupId = timelapseSequenceGroupId;
          timelapseClip.frameworkTimelapseSequenceReason = 'adjacent-no-subtitle-same-chronology-timelapse-sequence';
        }
        entries.push(buildTimelapseSequenceFrameworkEntry(entries.length + 1, group, timelapseSequenceGroupId));
      } else {
        entries.push(buildSingleClipFrameworkEntry(entries.length + 1, clip));
      }
      index = cursor;
      continue;
    }

    const group = [clip];
    let cursor = index + 1;
    const mergeReasons = [];
    while (cursor < packet.clips.length) {
      const decision = getSpeechMergeDecision(group[group.length - 1], packet.clips[cursor], packet.source.timelineFps);
      if (!decision.canMerge) break;
      mergeReasons.push(decision.reason);
      group.push(packet.clips[cursor]);
      cursor += 1;
    }

    let mergeGroupId;
    if (group.length > 1) {
      speechMergeIndex += 1;
      mergeGroupId = `speech-merge-${String(speechMergeIndex).padStart(4, '0')}`;
      for (const speechClip of group) {
        speechClip.frameworkSpeechMergeGroupId = mergeGroupId;
        speechClip.frameworkSpeechMergeReason = 'approved-framework-mouth-pack-summary-only';
        speechClip.frameworkSpeechMergeEvidence = [...new Set(mergeReasons)].join('+') || undefined;
      }
    }
    entries.push(buildSpeechFrameworkEntry(entries.length + 1, group));
    index = cursor;
  }
  packet.summary.frameworkEntryCount = entries.length;
  packet.summary.speechEntryCount = entries.filter(entry => entry.marker === 'speech').length;
  packet.summary.narrationEntryCount = entries.filter(entry => entry.marker !== 'speech').length;
  packet.summary.speechMergeGroupCount = speechMergeIndex;
  packet.summary.photoSequenceGroupCount = photoSequenceIndex;
  packet.summary.timelapseSequenceGroupCount = timelapseSequenceIndex;
  return entries;
}

function buildSingleClipFrameworkEntry(entryIndex, clip) {
  return {
    entryIndex,
    marker: clip.frameworkClass,
    clipIndices: [clip.index],
    description: clip.description,
  };
}

function buildSpeechFrameworkEntry(entryIndex, clips) {
  return {
    entryIndex,
    marker: 'speech',
    clipIndices: clips.map(clip => clip.index),
    description: describeSpeechGroup(clips),
  };
}

function buildPhotoSequenceFrameworkEntry(entryIndex, clips, photoSequenceGroupId) {
  return {
    entryIndex,
    marker: 'visual',
    clipIndices: clips.map(clip => clip.index),
    frameworkPhotoSequenceGroupId: photoSequenceGroupId,
    description: describePhotoSequence(clips),
  };
}

function buildTimelapseSequenceFrameworkEntry(entryIndex, clips, timelapseSequenceGroupId) {
  return {
    entryIndex,
    marker: 'timelapse',
    clipIndices: clips.map(clip => clip.index),
    frameworkTimelapseSequenceGroupId: timelapseSequenceGroupId,
    description: describeTimelapseSequence(clips),
  };
}

function canMergePhotoSequence(left, right, fps) {
  if (!isPhotoFrameworkClip(left) || !isPhotoFrameworkClip(right)) return false;
  const gapFrames = Number(right.timelineStartFrame) - Number(left.timelineEndFrame);
  if (!Number.isFinite(gapFrames) || gapFrames < -1) return false;
  return gapFrames <= Math.max(2, Math.round(Number(fps || 30) * 0.12));
}

function isPhotoFrameworkClip(clip) {
  return Boolean(
    clip
    && clip.hasSubtitle !== true
    && clip.frameworkClass === 'visual'
    && clip.contentKind === 'photo'
  );
}

function canMergeTimelapseSequence(left, right, fps) {
  if (!isTimelapseFrameworkClip(left) || !isTimelapseFrameworkClip(right)) return false;
  if (!sameChronologyEvent(left, right)) return false;
  const gapFrames = Number(right.timelineStartFrame) - Number(left.timelineEndFrame);
  if (!Number.isFinite(gapFrames) || gapFrames < -1) return false;
  return gapFrames <= Math.max(2, Math.round(Number(fps || 30) * 0.12));
}

function isTimelapseFrameworkClip(clip) {
  return Boolean(
    clip
    && clip.hasSubtitle !== true
    && clip.frameworkClass === 'timelapse'
    && clip.contentKind === 'timelapse'
  );
}

function sameChronologyEvent(left, right) {
  const leftEventId = left?.chronologyContext?.eventId;
  const rightEventId = right?.chronologyContext?.eventId;
  if (leftEventId && rightEventId) return leftEventId === rightEventId;
  if (leftEventId || rightEventId) return false;
  const leftTitle = normalizeComparisonText(left?.eventTitle || '');
  const rightTitle = normalizeComparisonText(right?.eventTitle || '');
  return Boolean(leftTitle && rightTitle && leftTitle === rightTitle);
}

function describePhotoSequence(clips) {
  const parts = [`照片序列`, `${clips.length}张`];
  for (const clip of clips) {
    for (const rawPart of String(clip.description || '').split(/[，,]/u)) {
      const part = sanitizeDescriptionPart(rawPart);
      if (!part || part === '照片' || part === '画面') continue;
      if (parts.includes(part)) continue;
      parts.push(part);
      if (parts.length >= 9) return parts.join('，');
    }
  }
  const title = commonNonEmpty(clips.map(clip => clip.eventTitle));
  if (title && !parts.includes(title)) parts.push(shortenRouteTitle(title));
  return parts.join('，');
}

function describeTimelapseSequence(clips) {
  const parts = ['延时序列', `${clips.length}段`];
  const chronologyLabel = commonChronologyLabel(clips);
  if (chronologyLabel) parts.push(chronologyLabel);
  const arc = inferTimelapseArc(clips);
  if (arc && !parts.includes(arc)) parts.push(arc);

  for (const clip of clips) {
    for (const rawPart of String(clip.description || '').split(/[，,]/u)) {
      const part = sanitizeDescriptionPart(rawPart);
      if (shouldSkipTimelapseSequencePart(part, parts)) continue;
      parts.push(part);
      if (parts.length >= 10) return clampDescription(parts.join('，'), 150);
    }
  }
  for (const tag of chronologyVisualTagsForClips(clips)) {
    if (shouldSkipTimelapseSequencePart(tag, parts)) continue;
    parts.push(tag);
    if (parts.length >= 10) {
      return clampDescription(parts.join('，'), 150);
    }
  }
  return clampDescription(parts.join('，'), 150);
}

function commonChronologyLabel(clips) {
  const contexts = uniqueChronologyContexts(clips);
  const commonContext = contexts.length === 1 ? contexts[0] : null;
  const title = commonContext?.title || commonNonEmpty(clips.map(clip => clip.eventTitle));
  const location = commonContext ? shortLocationLabel(commonContext.location) : '';
  if (location && title) {
    const normalizedLocation = normalizeComparisonText(location);
    const normalizedTitle = normalizeComparisonText(title);
    return normalizedTitle.includes(normalizedLocation)
      ? shortenRouteTitle(title)
      : `${location}，${shortenRouteTitle(title)}`;
  }
  return shortenRouteTitle(title || location || '');
}

function uniqueChronologyContexts(clips) {
  const byId = new Map();
  for (const clip of clips) {
    const context = clip?.chronologyContext;
    if (!context?.eventId) continue;
    byId.set(context.eventId, context);
  }
  return [...byId.values()];
}

function chronologyVisualTagsForClips(clips) {
  const tags = [];
  for (const context of uniqueChronologyContexts(clips)) {
    for (const tag of context.summaryTags ?? []) {
      const clean = sanitizeDescriptionPart(tag);
      if (!clean || tags.includes(clean)) continue;
      tags.push(clean);
    }
  }
  return tags;
}

function shouldSkipTimelapseSequencePart(part, existingParts) {
  const clean = sanitizeDescriptionPart(part);
  if (!clean) return true;
  if (existingParts.includes(clean)) return true;
  const normalized = normalizeComparisonText(clean);
  if (existingParts.some(existing => {
    const normalizedExisting = normalizeComparisonText(existing);
    return normalizedExisting.includes(normalized) || normalized.includes(normalizedExisting);
  })) return true;
  if (/^延时$|^延时记录$|^固定机位观察$|^画面$|^情景不明$|不明|口播|语音/u.test(clean)) return true;
  if (/^(广东省|广西壮族自治区|云南省|贵州省|西藏自治区|四川省|甘孜藏族自治州|怒江傈僳族自治州)$/u.test(clean)) return true;
  return false;
}

function inferTimelapseArc(clips) {
  const text = clips
    .flatMap(clip => [
      clip.sourceStem,
      clip.eventTitle,
      clip.description,
      clip.chronologyContext?.summaryTags?.join('，'),
    ])
    .join('，');
  const direct = String(text).match(/(日落转星空转月升|日落转星空|星空转月升|日落到星空|日落到月升)/u)?.[1];
  if (direct) return direct.replace(/到/u, '转');
  const phases = [];
  const add = (label, pattern) => {
    if (pattern.test(text) && !phases.includes(label)) phases.push(label);
  };
  add('日落', /日落|黄昏|晚霞|余晖/u);
  add('云海', /云海/u);
  add('蓝调', /蓝调|暮色/u);
  add('星空', /星空|银河|繁星/u);
  add('月升', /月升|月亮升起/u);
  return phases.length >= 2 ? phases.join('转') : '';
}

function getSpeechMergeDecision(left, right, fps) {
  if (left.frameworkClass !== 'speech' || right.frameworkClass !== 'speech') return { canMerge: false };
  if (!left.hasSubtitle || !right.hasSubtitle) return { canMerge: false };
  const gapFrames = Number(right.timelineStartFrame) - Number(left.timelineEndFrame);
  if (!Number.isFinite(gapFrames) || gapFrames < -1) return { canMerge: false };
  if (gapFrames > Math.max(2, Math.round(Number(fps || 30) * 0.12))) return { canMerge: false };

  const sameEvent = sameSpeechEvent(left, right);
  const contextCompatible = sameEvent || !hasSpeechEventConflict(left, right);

  if (sameEvent) {
    if (hasSharedSubtitleFragment(left, right)) {
      return { canMerge: true, reason: 'same-event-shared-subtitle-fragment' };
    }
    const eventContinuity = sameEventSpeechContinuityReason(left, right, fps);
    if (eventContinuity) {
      return { canMerge: true, reason: eventContinuity };
    }
  }

  if (!contextCompatible) {
    return { canMerge: false };
  }

  if (hasSharedSubtitleFragment(left, right)) {
    return { canMerge: true, reason: 'shared-subtitle-fragment' };
  }

  const topicScore = speechTopicContinuityScore(left, right);
  if (topicScore >= 0.46 && startsWithContinuationCue(right)) {
    return { canMerge: true, reason: 'subtitle-topic-continuity' };
  }
  if (topicScore >= 0.62 && hasShortSpeechGap(left, right, fps)) {
    return { canMerge: true, reason: 'same-subtitle-topic' };
  }
  return { canMerge: false };
}

function sameSpeechEvent(left, right) {
  const leftTitle = normalizedSpeechEventTitle(left);
  const rightTitle = normalizedSpeechEventTitle(right);
  return Boolean(leftTitle && rightTitle && leftTitle === rightTitle);
}

function hasSpeechEventConflict(left, right) {
  const leftTitle = normalizedSpeechEventTitle(left);
  const rightTitle = normalizedSpeechEventTitle(right);
  return Boolean(leftTitle && rightTitle && leftTitle !== rightTitle);
}

function normalizedSpeechEventTitle(clip) {
  const title = safeHumanLabel(clip?.eventTitle || clip?.chronologyContext?.title || '');
  return normalizeComparisonText(title.replace(/口播$/u, ''));
}

function sameEventSpeechContinuityReason(left, right, fps) {
  const leftClauses = uniqueSubtitleClauses(subtitleTextsForClip(left));
  const rightClauses = uniqueSubtitleClauses(subtitleTextsForClip(right));
  if (leftClauses.length === 0 || rightClauses.length === 0) return '';
  const leftCategories = speechTopicCategories(leftClauses);
  const rightCategories = speechTopicCategories(rightClauses);
  const sharedCategories = [...leftCategories].filter(category => rightCategories.has(category));
  if (sharedCategories.length > 0) return 'same-event-topic-category';

  const driveRunCategories = new Set(['route', 'road', 'vehicle', 'snow', 'weather', 'hazard', 'elevation', 'shooting']);
  const leftDriveRun = [...leftCategories].some(category => driveRunCategories.has(category));
  const rightDriveRun = [...rightCategories].some(category => driveRunCategories.has(category));
  if (leftDriveRun && rightDriveRun) return 'same-event-drive-run';

  if (startsWithContinuationCue(right)) return 'same-event-continuation-cue';

  if (hasShortSpeechGap(left, right, fps)) {
    const leftWeak = isWeakSpeechOnly(leftClauses);
    const rightWeak = isWeakSpeechOnly(rightClauses);
    if (leftWeak !== rightWeak) return 'same-event-brief-reaction';
    if (isShortSituationalSpeech(leftClauses) || isShortSituationalSpeech(rightClauses)) {
      return 'same-event-short-situational';
    }
  }
  return '';
}

function buildFrameworkPacks(packet, frameworkEntries) {
  const clipByIndex = new Map(packet.clips.map(clip => [clip.index, clip]));
  const packs = [];
  let index = 0;
  while (index < frameworkEntries.length) {
    const entry = frameworkEntries[index];
    const group = [entry];
    let cursor = index + 1;
    if (isDriveFrameworkEntry(entry, clipByIndex)) {
      while (
        cursor < frameworkEntries.length
        && isDriveFrameworkEntry(frameworkEntries[cursor], clipByIndex)
        && sameFrameworkPackContext(group[group.length - 1], frameworkEntries[cursor], clipByIndex)
      ) {
        group.push(frameworkEntries[cursor]);
        cursor += 1;
      }
    } else if (isAerialFrameworkEntry(entry)) {
      while (
        cursor < frameworkEntries.length
        && isAerialFrameworkEntry(frameworkEntries[cursor])
        && sameFrameworkPackContext(group[group.length - 1], frameworkEntries[cursor], clipByIndex)
      ) {
        group.push(frameworkEntries[cursor]);
        cursor += 1;
      }
    }
    packs.push(buildFrameworkPack(packs.length + 1, group, clipByIndex));
    index = cursor;
  }
  packet.summary.frameworkPackCount = packs.length;
  packet.summary.drivePackCount = packs.filter(pack => pack.type === '行车 pack').length;
  packet.summary.aerialPackCount = packs.filter(pack => pack.type === '航拍 pack').length;
  return packs;
}

function isDriveFrameworkEntry(entry, clipByIndex) {
  if (entry?.marker !== 'visual' || entry.frameworkPhotoSequenceGroupId) return false;
  const clips = (entry.clipIndices ?? []).map(clipIndex => clipByIndex.get(clipIndex)).filter(Boolean);
  return clips.length > 0 && clips.every(clip => clip.contentKind === 'drive');
}

function isAerialFrameworkEntry(entry) {
  return entry?.marker === 'aerial';
}

function sameFrameworkPackContext(leftEntry, rightEntry, clipByIndex) {
  const leftClips = (leftEntry?.clipIndices ?? []).map(clipIndex => clipByIndex.get(clipIndex)).filter(Boolean);
  const rightClips = (rightEntry?.clipIndices ?? []).map(clipIndex => clipByIndex.get(clipIndex)).filter(Boolean);
  if (leftClips.length === 0 || rightClips.length === 0) return false;
  const leftContext = packContextKey(leftClips);
  const rightContext = packContextKey(rightClips);
  if (!leftContext || !rightContext) return true;
  return leftContext === rightContext;
}

function packContextKey(clips) {
  const eventIds = [...new Set(clips.map(clip => clip.chronologyContext?.eventId).filter(Boolean))];
  if (eventIds.length === 1) return `event:${eventIds[0]}`;
  const titles = [...new Set(clips.map(clip => normalizeComparisonText(clip.eventTitle || '')).filter(Boolean))];
  if (titles.length === 1) return `title:${titles[0]}`;
  return '';
}

function buildFrameworkPack(packIndex, entries, clipByIndex) {
  const clips = entries.flatMap(entry => (entry.clipIndices ?? []).map(clipIndex => clipByIndex.get(clipIndex)).filter(Boolean));
  const firstEntry = entries[0];
  const type = frameworkPackType(firstEntry, entries, clipByIndex);
  const title = `${type}｜${frameworkPackTitle(type, entries, clips)}`;
  const summaryLabel = type.startsWith('口播') ? '摘要' : '整体';
  return {
    packIndex,
    type,
    title,
    marker: firstEntry.marker,
    entryIndices: entries.map(entry => entry.entryIndex),
    clipIndices: entries.flatMap(entry => entry.clipIndices),
    summaryLabel,
    summary: frameworkPackSummary(type, entries, clips),
    entries,
  };
}

function frameworkPackType(entry, entries, clipByIndex) {
  if (entry.marker === 'speech') return entry.clipIndices.length > 1 ? '口播 pack' : '口播';
  if (entry.marker === 'aerial') return entries.length > 1 ? '航拍 pack' : '航拍';
  if (entry.marker === 'timelapse') return entry.frameworkTimelapseSequenceGroupId ? '延时序列' : '延时';
  if (entry.frameworkPhotoSequenceGroupId) return '照片序列';
  if (isDriveFrameworkEntry(entry, clipByIndex)) return entries.length > 1 ? '行车 pack' : '行车';
  return '视觉';
}

function frameworkPackTitle(type, entries, clips) {
  const chronology = commonChronologyLabel(clips);
  const event = commonNonEmpty(clips.map(clip => safeHumanLabel(clip.eventTitle)));
  const route = routeTitleForClips(clips);
  const fallback = shortenRouteTitle(event || entries[0]?.description || clips[0]?.sourceStem || '当前片段');
  if (type.includes('行车') && route) return route;
  if (type.includes('航拍') && chronology) return chronology;
  if (type.includes('延时') && chronology) return chronology;
  if (type.includes('照片') && chronology) return chronology;
  if (type.includes('口播')) return shortenRouteTitle(event || fallback);
  return chronology || fallback;
}

function routeTitleForClips(clips) {
  const titles = clips
    .map(clip => safeHumanLabel(clip.eventTitle || ''))
    .filter(title => /→/.test(title));
  if (titles.length === 0) return '';
  return shortenRouteTitle(commonNonEmpty(titles) || titles[0]);
}

function frameworkPackSummary(type, entries, clips) {
  if (entries.length === 1) return entries[0].description;
  const descriptions = entries.map(entry => sanitizeEntryText(entry.description)).filter(Boolean);
  const context = frameworkPackTitle(type, entries, clips);
  if (type === '行车 pack') {
    return summarizeMovementPack(context, descriptions, clips, '行车');
  }
  if (type === '航拍 pack') {
    return summarizeMovementPack(context, descriptions, clips, '航拍');
  }
  return clampDescription(descriptions.slice(0, 3).join('；'), 150);
}

function summarizeMovementPack(context, descriptions, clips, kind) {
  const parts = [];
  const title = sanitizeDescriptionPart(context);
  if (title) parts.push(title);
  const geoSummary = packGeoFeatureSummary(clips);
  if (geoSummary && !parts.some(part => isSimilarText(part, geoSummary))) parts.push(geoSummary);
  const arc = packDescriptionArc(descriptions);
  if (arc && !parts.some(part => isSimilarText(part, arc))) parts.push(arc);
  if (parts.length === 0) return clampDescription(descriptions.slice(0, 3).join('；'), 150);
  const lead = kind === '航拍' ? '航拍围绕' : '';
  return clampDescription(`${lead}${parts.join('，')}`, 150);
}

function packGeoFeatureSummary(clips) {
  const labels = [];
  const features = [];
  for (const clip of clips) {
    const label = geoNarrativeLabelForClip(clip);
    if (label && !labels.some(existing => isSimilarText(existing, label))) labels.push(label);
    const feature = geoNarrativeFeatureForClip(clip, label);
    if (feature && !features.some(existing => isSimilarText(existing, feature))) features.push(feature);
  }
  const labelSummary = labels.slice(0, 2).join('、');
  const featureSummary = features.slice(0, 2).join('，');
  if (labelSummary && featureSummary) return `${labelSummary}一带，${featureSummary}`;
  return labelSummary || featureSummary;
}

function packDescriptionArc(descriptions) {
  const picks = [];
  const add = value => {
    const clean = sanitizeDescriptionPart(value);
    if (!clean || picks.some(existing => isSimilarText(existing, clean))) return;
    picks.push(clean);
  };
  add(descriptions[0]);
  if (descriptions.length > 2) add(descriptions[Math.floor(descriptions.length / 2)]);
  add(descriptions.at(-1));
  return picks.slice(0, 3).join('；');
}

function buildClipMap(frameworkEntries, frameworkPacks) {
  return {
    schemaVersion: VALID_MAP_SCHEMA,
    format: FRAMEWORK_FORMAT,
    sourcePacket: '.tmp/edit-flow/<editId>/postlock/current-timeline-clip-packet.json',
    entries: frameworkEntries.map(entry => ({
      marker: entry.marker,
      clips: entry.clipIndices,
    })),
    packs: frameworkPacks.map(pack => ({
      title: pack.title,
      entries: pack.entryIndices,
    })),
  };
}

function alignFrameworkPacksToMarkdown(frameworkPacks, frameworkText) {
  const titles = extractFrameworkPackTitles(frameworkText);
  if (titles.length !== frameworkPacks.length) return frameworkPacks;
  return frameworkPacks.map(pack => ({
    ...pack,
    title: titles[pack.packIndex - 1] || pack.title,
  }));
}

function extractFrameworkPackTitles(frameworkText) {
  const titles = [];
  let inBody = false;
  for (const line of String(frameworkText || '').split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.includes('下面是粗剪时间线正文')) {
      inBody = true;
      continue;
    }
    if (!inBody) continue;
    if (trimmed.startsWith('## 人工审查点')) break;
    const match = trimmed.match(/^(\d+)\.\s+(.+)$/u);
    if (!match) continue;
    const packIndex = Number(match[1]);
    if (packIndex === titles.length + 1) {
      titles.push(match[2].trim());
    }
  }
  return titles;
}

function buildFrameworkMarkdown(packet, frameworkPacks, createdAt) {
  const clipByIndex = new Map(packet.clips.map(clip => [clip.index, clip]));
  const lines = [
    '主题：丙察察格聂南线子梅垭口穿越，自驾穿越与风光摄影',
    '季节：五一前后，滇藏川高原春末夏初',
    '格式：Markdown pack-list v2；顶层为叙事单元，clips 子列表保留 Resolve clip 边界。',
    '下面是粗剪时间线正文：',
  ];
  for (const pack of frameworkPacks) {
    lines.push(`${pack.packIndex}. ${pack.title}`);
    lines.push(`   - ${pack.summaryLabel}：${sanitizeEntryText(pack.summary)}`);
    if (pack.entries.length === 1 && pack.entries[0].clipIndices.length > 1) {
      lines.push(`   - clips：${formatClipRange(pack.entries[0].clipIndices)}`);
    } else if (pack.entries.length === 1) {
      lines.push('   - clips：');
      lines.push(formatFrameworkEntryLine(pack.entries[0], clipByIndex));
    } else {
      lines.push('   - clips：');
      for (const entry of pack.entries) {
        lines.push(formatFrameworkEntryLine(entry, clipByIndex));
      }
    }
  }
  lines.push(
    '## 人工审查点',
    `1. 本框架按当前 Resolve 时间线导出，共 ${packet.summary.videoClipCount} 个 clip；有字幕/台词 clip ${packet.summary.speechClipCount} 个，合并为 ${packet.summary.speechEntryCount} 条口播 leaf entry；无字幕 clip ${packet.summary.narrationClipCount} 个，生成 ${packet.summary.narrationEntryCount} 条旁白 leaf entry；正文组织为 ${packet.summary.frameworkPackCount} 个 pack，其中行车 pack ${packet.summary.drivePackCount} 个，航拍 pack ${packet.summary.aerialPackCount} 个，照片序列 ${packet.summary.photoSequenceGroupCount} 组，延时序列 ${packet.summary.timelapseSequenceGroupCount} 组。`,
    '2. 审查时可以改整体/摘要和 clips 子描述，但不要删改 clip 编号；clip 对应关系以 narration-framework.clip-map.json 为准。',
    `生成时间：${createdAt}`,
  );
  return `${lines.join('\n')}\n`;
}

function formatFrameworkEntryLine(entry, clipByIndex) {
  return `     - ${formatClipRange(entry.clipIndices)}｜${sanitizeEntryText(entry.description)}${preciseGeoNoteForEntry(entry, clipByIndex)}`;
}

function preciseGeoNoteForEntry(entry, clipByIndex) {
  if (!entry || entry.marker === 'speech' || entry.clipIndices?.length !== 1) return '';
  const clip = clipByIndex.get(entry.clipIndices[0]);
  if (!clip || clip.hasSubtitle || !clip.geoContext) return '';
  return preciseGeoNoteForClip(clip);
}

function preciseGeoNoteForClip(clip) {
  const geo = clip.geoContext;
  if (!Number.isFinite(Number(geo?.lat)) || !Number.isFinite(Number(geo?.lng))) return '';
  const label = geoNarrativeLabelForClip(clip);
  const terrain = geoNarrativeFeatureForClip(clip, label);
  const parts = [];
  if (label) parts.push(label);
  if (terrain && !parts.some(part => isSimilarText(part, terrain))) parts.push(terrain);
  if (parts.length === 0) return '';
  return `（定位：${parts.filter(Boolean).join('；')}）`;
}

function geoNarrativeLabelForClip(clip) {
  const geo = clip?.geoContext;
  const candidates = [
    geo?.rawLocationText,
    geo?.label,
    clip?.chronologyContext?.location,
  ];
  if (clip?.contentKind !== 'drive') {
    candidates.push(clip?.eventTitle, commonChronologyLabel([clip]));
  }
  for (const candidate of candidates) {
    const label = cleanNarrativeGeoLabel(candidate);
    if (label) return label;
  }
  const transportFacility = transportFacilityHintForClip(clip);
  if (transportFacility?.label) return transportFacility.label;
  if (clip?.contentKind === 'drive') {
    const fallback = commonRouteAreaLabel(clip?.eventTitle || clip?.chronologyContext?.title || '');
    if (fallback) return fallback;
  }
  return '';
}

function cleanNarrativeGeoLabel(value) {
  const clean = sanitizeDescriptionPart(value);
  if (!clean || containsRouteArrow(clean)) return '';
  const label = cleanGeoLabel(clean);
  if (!label || containsRouteArrow(label)) return '';
  if (/^(中国|四川省|云南省|贵州省|西藏自治区|广东省|广西壮族自治区)$/u.test(label)) return '';
  return label;
}

function commonRouteAreaLabel(value) {
  const clean = sanitizeDescriptionPart(value).replace(/^行车[:：]?/u, '');
  if (!containsRouteArrow(clean)) return '';
  const endpoints = clean
    .split(/\s*(?:→|->)\s*/u)
    .map(part => sanitizeDescriptionPart(part))
    .filter(Boolean);
  if (endpoints.length < 2) return '';
  const endpointLabels = endpoints.map(endpoint => {
    const [admin] = endpoint.split(/\s*·\s*/u);
    const parts = admin.split(/[，,]/u).map(part => part.trim()).filter(Boolean);
    return parts.slice(-2).join('');
  }).filter(Boolean);
  if (endpointLabels.length < 2) return '';
  const first = endpointLabels[0];
  if (endpointLabels.every(label => label === first)) return `${first}附近`;
  const commonPrefix = longestCommonCjkPrefix(endpointLabels);
  return commonPrefix.length >= 4 ? `${commonPrefix}一带` : '';
}

function longestCommonCjkPrefix(values) {
  if (!values.length) return '';
  let prefix = values[0];
  for (const value of values.slice(1)) {
    while (prefix && !value.startsWith(prefix)) {
      prefix = prefix.slice(0, -1);
    }
  }
  return prefix.replace(/[省市县区镇乡街道]+$/u, match => match);
}

function geoNarrativeFeatureForClip(clip, label = '') {
  const geo = clip?.geoContext;
  const text = [
    geo?.rawLocationText,
    geo?.label,
    label,
    clip?.eventTitle,
    clip?.chronologyContext?.title,
    clip?.chronologyContext?.location,
    clip?.description,
    clip?.visualObservation,
  ].filter(Boolean).join('，');
  const transportFacility = transportFacilityHintForClip(clip);
  const terrain = sanitizeDescriptionPart(transportFacility?.terrain || geo?.terrain || terrainHintForGeo(text));
  const visualFeatures = selectVisibleGeoFeatureLabelsForTerrain(
    terrain,
    visibleGeoFeatureRowsFromText([clip?.description, clip?.visualObservation].filter(Boolean).join('，'), text),
  ).join('、');
  if (terrain && visualFeatures && !isSimilarText(terrain, visualFeatures)) {
    return clampDescription(`${terrain}，${visualFeatures}`, 72);
  }
  return terrain || visualFeatures;
}

function visibleGeoFeaturesFromText(value, contextText = '') {
  return selectVisibleGeoFeatureLabelsForTerrain('', visibleGeoFeatureRowsFromText(value, contextText)).join('、');
}

function visibleGeoFeatureRowsFromText(value, contextText = '') {
  const text = String(value || '');
  const fullText = [contextText, text].filter(Boolean).join('，');
  const features = [];
  const add = (label, pattern, category) => {
    if (!pattern.test(text)) return;
    if (features.some(feature => feature.category === category || feature.label === label)) return;
    features.push({ label, category });
  };
  add('雪山', /雪山|雪峰|雪坡|雪线|雪地/u, 'snow');
  add('江河湖泊', /怒江|澜沧江|金沙江|河|江|湖|水渠|溪|湖面|江水|河道/u, 'water');
  add('峡谷崖壁', /峡谷|崖|岩壁|石墙|山谷|深谷/u, 'terrain');
  add('高山草甸', /草甸|草地|草坡|牧场/u, 'vegetation');
  const vegetationLabel = vegetationHintForGeo(fullText) || observedVegetationFeatureFromText(text);
  if (vegetationLabel) {
    add(vegetationLabel, /森林|树林|松林|杉林|林带|树|绿坡|绿山|植被|灌丛|灌木|阔叶|针叶/u, 'vegetation');
  }
  add('桥隧道路', /桥|隧道|护栏|弯道|盘山|山路|高速|公路|路牌/u, 'transport');
  add('村寨建筑', /村|寨|屋|房|白塔|经幡|建筑/u, 'settlement');
  return features;
}

function observedVegetationFeatureFromText(value) {
  const text = String(value || '');
  if (/冷杉|云杉|杉林|松林|松树|针叶/u.test(text)) return '针叶林坡';
  if (/常绿阔叶|阔叶/u.test(text)) return '常绿阔叶林坡';
  if (/灌丛|灌木/u.test(text)) return '灌丛坡';
  if (/森林|树林|密林/u.test(text)) return '森林坡地';
  if (/绿坡|绿山|植被/u.test(text)) return '山坡植被';
  return '';
}

function selectVisibleGeoFeatureLabelsForTerrain(terrain, featureRows) {
  const terrainText = sanitizeDescriptionPart(terrain);
  const labels = [];
  const categories = new Set();
  for (const feature of featureRows) {
    if (!feature?.label || !feature?.category) continue;
    if (categories.has(feature.category)) continue;
    if (terrainText && geoTextCoversFeatureCategory(terrainText, feature.category)) continue;
    if (terrainText && isSimilarText(terrainText, feature.label)) continue;
    labels.push(feature.label);
    categories.add(feature.category);
    if (labels.length >= 3) break;
  }
  return labels;
}

function geoTextCoversFeatureCategory(value, category) {
  const text = String(value || '');
  if (!text) return false;
  switch (category) {
    case 'snow':
      return /雪山|雪峰|雪坡|雪线|雪地|冰川|冰川湖|贡嘎远山|格聂神山/u.test(text);
    case 'water':
      return /怒江|澜沧江|金沙江|帕隆藏布|纳灰河|珠江口|伶仃洋|江湾|江水|河谷|河道|河水|湖|水渠|溪|海面|融雪溪沟/u.test(text);
    case 'terrain':
      return /峡谷|崖壁|岩壁|石墙|山谷|深谷|峰丛|山口|垭口|山坡|陡坡|丘陵|湖盆|夹峙/u.test(text);
    case 'vegetation':
      return /常绿阔叶|针阔混交|针叶|阔叶|云南松|松林|冷杉|杜鹃|灌丛|草甸|草坡|牧场|林坡|林带|森林|植被|常绿山地|农田植被/u.test(text);
    case 'transport':
      return /桥隧|桥|隧道|护栏|弯道|盘山|山路|高速|公路|路牌|道路|车流|收费站|互通|通道/u.test(text);
    case 'settlement':
      return /村寨|村落|山村|村路|村|寨|屋|房|白塔|经幡|建筑|民居|镇|乡/u.test(text);
    default:
      return false;
  }
}

function isSimilarText(left, right) {
  const leftText = normalizeComparisonText(left);
  const rightText = normalizeComparisonText(right);
  return Boolean(leftText && rightText && (leftText.includes(rightText) || rightText.includes(leftText)));
}

function buildPreciseGeoAudit(packet) {
  const rows = [];
  for (const clip of packet.clips ?? []) {
    if (clip.hasSubtitle || !clip.geoContext) continue;
    const note = preciseGeoNoteForClip(clip);
    rows.push({
      clipIndex: clip.index,
      hasSubtitle: false,
      contentKind: clip.contentKind,
      frameworkClass: clip.frameworkClass,
      source: clip.geoContext.source,
      lng: clip.geoContext.lng,
      lat: clip.geoContext.lat,
      time: clip.geoContext.time,
      deltaMs: clip.geoContext.deltaMs,
      confidence: clip.geoContext.confidence,
      label: geoNarrativeLabelForClip(clip),
      terrain: geoNarrativeFeatureForClip(clip),
      rawLocationText: clip.geoContext.rawLocationText,
      markdownNote: note,
    });
  }
  return {
    schemaVersion: 'postlock-narration-framework-precise-geo-v2',
    generatedFrom: 'projects/<projectId>/.tmp/edit-flow/<editId>/postlock/current-timeline-clip-packet.json',
    coordinateOrder: 'lng,lat',
    markdownPolicy: 'no-source-label-no-delta-no-raw-coordinate',
    nonSpeechGeoCount: rows.length,
    annotatedLeafCount: rows.filter(row => row.markdownNote).length,
    rows,
  };
}

function formatClipRange(clipIndices) {
  const indices = [...new Set((clipIndices ?? []).filter(Number.isInteger))].sort((a, b) => a - b);
  if (indices.length === 0) return '';
  const ranges = [];
  let start = indices[0];
  let previous = indices[0];
  for (let i = 1; i < indices.length; i += 1) {
    const value = indices[i];
    if (value === previous + 1) {
      previous = value;
      continue;
    }
    ranges.push(start === previous ? String(start) : `${start}-${previous}`);
    start = value;
    previous = value;
  }
  ranges.push(start === previous ? String(start) : `${start}-${previous}`);
  return ranges.join(',');
}

function describeClip(input) {
  if (input.hasSubtitle) {
    return describeSpeechGroup([input]);
  }
  return visualDescription(input);
}

function describeSpeechGroup(clips) {
  const subtitleSummary = summarizeSpeechFromSubtitles(clips.flatMap(clip => subtitleTextsForClip(clip)));
  const title = commonChronologyLabel(clips)
    || commonNonEmpty(clips.map(clip => safeHumanLabel(clip.eventTitle)));
  if (subtitleSummary) {
    const label = title ? `${shortenRouteTitle(sanitizeDescriptionPart(title))}口播` : '口播';
    return clampDescription(`${label}：${subtitleSummary}`, 100);
  }

  const slotQuery = commonNonEmpty(clips.map(clip => clip.slotQuery));
  if (slotQuery) {
    return summarizeSpeechSlotQuery(slotQuery);
  }
  if (title) {
    return `${shortenRouteTitle(sanitizeDescriptionPart(title))}口播`;
  }
  const visual = visualDescription({
    ...clips[0],
    hasSubtitle: false,
    frameworkClass: 'visual',
  });
  return `${visual}中的口播`;
}

function summarizeSpeechSlotQuery(query) {
  const clean = sanitizeDescriptionPart(query);
  const [rawTitle, ...rest] = clean.split(/[：:]/u);
  const title = sanitizeDescriptionPart(rawTitle).replace(/口播$/, '');
  const body = rest.join('：');
  const speechDetail = extractSpeechDetailFromSlotQuery(body);
  if (speechDetail) {
    return clampDescription(`${title}口播：${speechDetail}`, 120);
  }
  return clampDescription(`${title}口播`, 90);
}

function extractSpeechDetailFromSlotQuery(body) {
  const clauses = String(body || '')
    .split(/[；;。]/u)
    .map(clause => sanitizeDescriptionPart(clause))
    .filter(Boolean);
  const speechClauses = clauses.filter(clause =>
    /口播|说明|介绍|讨论|对话|提到|总结|吐槽|交代|反应|感受|声音|现场|闲聊/u.test(clause)
    && !/^画面以/u.test(clause)
  );
  const chosen = speechClauses[0] || clauses.find(clause => !/^画面以/u.test(clause)) || '';
  return cleanupSpeechDetail(chosen);
}

function summarizeSpeechFromSubtitles(texts) {
  const clauses = uniqueSubtitleClauses(texts);
  if (clauses.length === 0) return '';

  const sceneSummary = summarizeBySpeechScenes(clauses);
  const topicSummary = summarizeBySpeechTopics(clauses);
  const phraseSummary = summarizeByKeyPhrases(clauses);
  if (sceneSummary) return clampDescription(sceneSummary, 112);
  if (topicSummary && phraseSummary) {
    return clampDescription(`${topicSummary}，包括${phraseSummary}`, 96);
  }
  if (topicSummary) return clampDescription(topicSummary, 96);
  if (phraseSummary) return clampDescription(phraseSummary, 96);
  return clampDescription(rewriteSubtitleClause(clauses[0]), 72);
}

function summarizeBySpeechScenes(clauses) {
  const text = normalizeComparisonText(clauses.join('，'));
  const categories = speechTopicCategories(clauses);
  if (
    categories.has('arrival')
    && categories.has('route')
    && categories.has('reflection')
    && (categories.has('weather') || categories.has('landscape'))
  ) {
    const place = /子梅|紫梅|垭口|崖口/u.test(text) ? '子梅垭口' : '目的地';
    return `记录抵达${place}后回看惊险上山路、月亮和雪雾环境，并总结日照金山失败、旅程前后呼应和努力未必有结果的感慨`;
  }
  if (
    categories.has('early-start')
    && categories.has('route')
    && (categories.has('elevation') || categories.has('road'))
    && (categories.has('weather') || categories.has('snow') || categories.has('vehicle') || categories.has('hazard'))
  ) {
    const destination = /子梅|紫梅|垭口|崖口/u.test(text) ? '前往子梅垭口' : '前往目的地';
    return `交代清晨出发${destination}、海拔爬升和转入山路，描述起雾结冰、积雪加厚、车辆打滑、不能停车以及临近垭口的障碍风险`;
  }

  const summaries = [];
  const add = (category, summary) => {
    if (categories.has(category) && !summaries.includes(summary)) summaries.push(summary);
  };

  add('early-start', '交代清晨出发和出行安排');
  add('shooting', '交代拍摄计划和现场机位');
  add('route', '交代行车路线和目的地变化');
  add('elevation', '说明海拔爬升和路程距离');
  add('road', '描述山路爬升、转弯和通行条件');
  add('weather', '描述起雾、下雪和视线变化');
  add('snow', '记录冰雪覆盖、积雪加厚和路面结冰');
  add('vehicle', '记录车辆状态、打滑和驾驶反应');
  add('hazard', '提示落石、护栏、三脚架或其他路面障碍');
  add('arrival', '记录抵达垭口后的现场反应');
  add('landscape', '描述湖泊雪山、云海和高原风光');
  add('lodging', '回忆住宿地点和入住体验');
  add('food', '记录餐食选择和价格感受');
  add('reflection', '总结旅程遗憾、努力和现场感受');

  return joinSummaryParts(summaries.slice(0, 4));
}

function summarizeBySpeechTopics(clauses) {
  const text = clauses.join('，');
  const topics = [];
  if (/价|贵|离谱|不值|两百|人均|鱼|菜|餐|吃|味道|饭|标题/.test(text)) {
    topics.push('记录餐食选择和价格感受');
  }
  if (/住|住宿|酒店|民宿|房|集装箱/.test(text)) {
    topics.push('回忆住宿经历');
  }
  if (/出发|前往|国道|318|559|五九|高速|隧道|导航|路修|穿梭|左贡|丙察察|行车/.test(text)) {
    topics.push('交代行车路线和路况体验');
  }
  if (/湖|雪山|冰川|蓝|绿|清澈|倒影|风光|震撼|苍茫|荒凉|草地|云海|日出|银河|雾|峡谷|怒江|高原/.test(text)) {
    topics.push('描述沿途风光和现场感受');
  }
  if (/拍|机位|镜头|无人机|没电|打卡|观景平台|云海|银河|摄影/.test(text)) {
    topics.push('交代拍摄安排和现场状况');
  }
  if (/上次|三年前|以前|这次|不一样|还是那个样子|变化|化完/.test(text)) {
    topics.push('对比旧访印象和这次变化');
  }
  if (/时间|没有时间|疯了|不让|遗憾|期待|早点|旅行|意义|体验/.test(text)) {
    topics.push('表达旅行体验、期待或遗憾');
  }
  return joinSummaryParts(topics.slice(0, 2));
}

function summarizeByKeyPhrases(clauses) {
  const phrases = [];
  for (const clause of clauses) {
    const rewritten = rewriteSubtitleClause(clause).replace(/^提到/u, '');
    if (!rewritten || rewritten.length < 3 || isForbiddenSpeechSummaryPart(rewritten)) continue;
    if (phrases.some(existing => areSimilarSummaryPhrases(existing, rewritten))) continue;
    phrases.push(rewritten);
    if (phrases.length >= 3) break;
  }
  return joinSummaryParts(phrases);
}

function rewriteSubtitleClause(value) {
  let text = sanitizeDescriptionPart(value)
    .replace(/这个那个/g, '')
    .replace(/那个/g, '')
    .replace(/这个/g, '')
    .replace(/然后/g, '')
    .replace(/所以说/g, '')
    .replace(/因为/g, '')
    .replace(/感觉/g, '')
    .replace(/其实/g, '')
    .replace(/非常/g, '')
    .replace(/还是/g, '')
    .replace(/现在/g, '')
    .replace(/我们/g, '')
    .replace(/这边/g, '')
    .replace(/那边/g, '')
    .replace(/它/g, '')
    .replace(/就是/g, '')
    .replace(/有那个/g, '')
    .replace(/有一种/g, '')
    .replace(/一大片/g, '大片')
    .replace(/\s+/g, '')
    .trim();
  if (!text) return '';

  const rewrites = [
    [/^鹅+$/u, '短促现场声：鹅经过或叫声'],
    [/^thank\s*you\.?$/iu, '短促现场反应'],
    [/^thanks\.?$/iu, '短促现场反应'],
    [/^(哦|啊|嗯|诶|哎)+$/u, '短促语气反应'],
    [/^这$/u, '短促现场指示'],
    [/字幕|李宗盛/u, '提到字幕和背景音乐信息'],
    [/制作方法|胡辣椒|青椒|鸡/u, '讨论菜品做法和辣椒风味'],
    [/通道|不堵|堵/u, '说明通过通道后堵车缓解'],
    [/浇水|水田|水道民族/u, '解释农田水系和村寨背景'],
    [/停个车|停车|车子上不去|车上不去/u, '说明停车与道路通行情况'],
    [/交警|逆行|收费站/u, '交代交警指挥和收费站通行'],
    [/共当神山|贡当神山|观景台.*售票|售票|摆渡|40块钱|四十块/u, '吐槽观景台售票和摆渡车规则'],
    [/基督教堂|教堂|不过去/u, '路过教堂但不进入参观'],
    [/黑狗|拍车的机位|时代感/u, '观察黑狗、停车场和拍车机位'],
    [/进入小路|哪来的小路|小路/u, '进入岔路并确认道路方向'],
    [/行程的第|行程到第|五一|左供|左贡|巴塘|芒康|东达|东达拉山/u, '交代当天行程、目的地和山口路线'],
    [/牦牛|青柯|青稞|糯米|早餐|加油|身份证|尾门|颠掉/u, '评价早餐、加油价格和车辆状况'],
    [/死去的树|小雪|中雪|大学生|趁年轻|身体.*顶不住/u, '观察雪中枯树并闲聊旅行体力'],
    [/国线|交强线|香道|一个小时|小时15|十分感到/u, '讨论导航路线、限速和预计时间'],
    [/巡航|放松/u, '说明进入巡航后放松下来'],
    [/我知道|认路|三个树|路很难走|充电|1块6|一块6|食材|挂在/u, '讨论进村路径、充电价格和店家食材'],
    [/老虎嘴|单向通行|军队|军民|冰洞/u, '讨论险路通行、修路背景和冰洞'],
    [/旅途|追寻|灯塔|酒店|地暖|万里无云|深圳|十个小时|成都/u, '收束旅途、住宿和返程安排'],
    [/飞机|机场|到达成都|成都到达|旅程的结束|史诗级旅程/u, '抵达成都并总结旅程'],
    [/巡航|放松/u, '记录高速巡航后的放松感'],
    [/好莱坞|杏花鹰/u, '记录车内难辨识闲聊片段'],
    [/你们要干什么|你们想干什么|不想让你/u, '记录现场小动物互动'],
    [/五点钟|正式出发|紫梅|子梅|崖口|垭口|海拔|700米|14公里|40分钟/u, '交代清晨出发前往子梅垭口和海拔爬升'],
    [/拉车门|破桥|厚厚的冰雪|冰雪覆盖/u, '记录清晨车辆和车门被冰雪覆盖'],
    [/看不清|无名道路|开始爬升|小心点开|路面结冰|起雾|雾爆|护栏|积雪越厚|不能停|打滑|不敢刹车|硬着头皮|心理素质|前面是冰/u, '描述无名山路爬升、起雾结冰、积雪变厚和打滑风险'],
    [/三脚架|落石|微生间|危险|勉强/u, '记录临近垭口的障碍和紧张通过'],
    [/上来了|来到紫门|来到子梅|早上六点|上来的路|惊险|背后.*月亮|月亮/u, '抵达子梅垭口并回看惊险上山路'],
    [/日照金山|热热金山|大雪中的紫门|大雪中的子梅|前后呼应|付出了巨大|仍然在努力|不一定有个很好的结果/u, '总结日照金山失败、旅程前后呼应和努力未必有结果的感慨'],
    [/桥/u, '指出前方桥梁或过桥场景'],
    [/很艰难|石头|草丛|草坪/u, '讲述寻找机位和穿行草坡的过程'],
    [/早上|五点半|银河|日出|云海|观景平台/u, '说明清晨拍摄日出云海的安排'],
    [/小喵|喵喵|交配|羞耻心|功德心/u, '记录现场小动物插曲'],
    [/^沿着(.+?)走.*出现(.+)/u, '沿$1看到$2'],
    [/^后就出现了(.+)/u, '看到$1'],
    [/^背后是(.+)/u, '提到$1作背景'],
    [/^很?震撼$/u, '表达震撼感'],
    [/^风光.*不错/u, '评价风光不错'],
    [/^苍茫和荒凉/u, '概括苍茫荒凉的气质'],
    [/^找了一家标题里面没有鱼的/u, '说明选择店名不带鱼的餐馆'],
    [/价格太离谱|随便一个菜都要两百多|不太值/u, '吐槽餐食价格偏高和值不值'],
    [/^上次.*住.*集装箱/u, '回忆上次住集装箱'],
    [/雪都化完/u, '提到上次来雪已化完'],
    [/水.*清澈|绿色蓝色|蓝色|倒影/u, '描述湖水颜色、清澈感和倒影条件'],
    [/出发|前往|上318|上三一八/u, '交代出发上路和下一段目的地'],
    [/冰川|米堆|蓝固/u, '提到沿线冰川期待和未能前往的遗憾'],
    [/路修得.*好|穿梭/u, '评价道路条件和穿行感受'],
    [/旅行真正的意义/u, '表达旅行意义感'],
  ];
  for (const [pattern, replacement] of rewrites) {
    if (!pattern.test(text)) continue;
    const hasCaptureReplacement = /\$\d/.test(replacement);
    return sanitizeDescriptionPart(hasCaptureReplacement ? text.replace(pattern, replacement) : replacement);
  }

  text = text
    .replace(/^只不过/u, '')
    .replace(/^但/u, '')
    .replace(/^不过/u, '')
    .replace(/^而且/u, '')
    .replace(/^要/u, '准备')
    .replace(/的$/u, '')
    .trim();
  const abstract = abstractGenericSpeechClause(text);
  if (abstract) return abstract;
  if (text.length <= 4) return '短促现场反应';
  return subtitleFactFallback(text);
}

function abstractGenericSpeechClause(text) {
  const hits = [];
  const dictionary = [
    ['村寨背景说明', /村|寨|民族|布依|藏|纳西|怒族|水田|河/u],
    ['行车路况提示', /车|路|国道|高速|堵|隧道|桥|导航|转弯|停车|收费站|逆行|交警/u],
    ['湖泊雪山观察', /湖|雪山|水|蓝|绿|倒影|冰川/u],
    ['天气光线观察', /雨|雾|云|晴|阴|日出|晚霞|星|银河/u],
    ['餐食价格感受', /吃|菜|饭|鱼|价格|贵|人均|味道/u],
    ['住宿地点记录', /住|酒店|民宿|房间|床|集装箱/u],
    ['拍摄安排说明', /拍|无人机|镜头|机位|云台|电池|打卡/u],
    ['旅行感受表达', /震撼|不错|体验|意义|遗憾|期待|漂亮|荒凉/u],
  ];
  for (const [label, pattern] of dictionary) {
    if (pattern.test(text)) hits.push(label);
    if (hits.length >= 2) break;
  }
  return hits.length > 0 ? hits.join('和') : '';
}

function subtitleFactFallback(text) {
  const clean = sanitizeDescriptionPart(text)
    .replace(/^(我靠|我服了|哎|唉|啊|嗯|哦)+/u, '')
    .replace(/(我靠|我服了|哎|唉|啊|嗯|哦)+$/u, '')
    .trim();
  if (!clean) return '短促现场反应';
  return `记录${clean.slice(0, 24)}`;
}

function speechTopicCategories(clauses) {
  const text = normalizeComparisonText(clauses.join('，'));
  const categories = new Set();
  const checks = [
    ['early-start', /早上|清晨|五点|六点|出发|最后一天/u],
    ['shooting', /拍|机位|镜头|无人机|观景平台|日出|云海|银河|日照金山|打卡/u],
    ['route', /前往|目的地|转入|无名道路|国道|高速|导航|公里|路程|上来|来到|垭口|崖口|紫梅|子梅/u],
    ['elevation', /海拔|爬升|上去|山上|半山腰|4500|3800|700米/u],
    ['road', /路|桥|转弯|弯|通行|护栏|坡|停车|刹车|掉头|开上来|开上去/u],
    ['weather', /雾|雪|雨|云|晴|阴|视线|看不清|月亮/u],
    ['snow', /冰|雪|积雪|结冰|冰雪|雪地胎|雪地模式/u],
    ['vehicle', /车|车门|拉车门|打滑|刹车|雪地胎|雪地模式|不能停|驾驶/u],
    ['hazard', /危险|勉强|落石|三脚架|障碍|护栏|突发|怕/u],
    ['arrival', /上来了|来到|抵达|到达|早上六点|这就是刚才.*上来|一路.*上来/u],
    ['landscape', /湖|雪山|冰川|倒影|风光|高原|草地|峡谷|怒江|贡嘎|云海|月亮/u],
    ['lodging', /住|住宿|酒店|民宿|房|地暖|集装箱/u],
    ['food', /吃|饭|菜|鱼|餐|价格|贵|味道|人均|早餐/u],
    ['reflection', /遗憾|失败|努力|结果|人生|意义|体验|害怕|刺激|前后呼应|旅程|旅行/u],
  ];
  for (const [category, pattern] of checks) {
    if (pattern.test(text)) categories.add(category);
  }
  return categories;
}

function isWeakSpeechOnly(clauses) {
  const normalized = normalizeComparisonText(clauses.join(''));
  if (!normalized) return true;
  if (normalized.length <= 4) return true;
  return /^(我靠|哎|唉|啊|嗯|哦|对|好|行|看看|这边|那边)+$/u.test(normalized);
}

function isShortSituationalSpeech(clauses) {
  const normalized = normalizeComparisonText(clauses.join(''));
  return normalized.length > 0 && normalized.length <= 16;
}

function uniqueSubtitleClauses(texts) {
  const seen = new Set();
  const result = [];
  for (const text of texts) {
    for (const rawClause of String(text || '').split(/\s*\/\s*|[。！？!?；;]/u)) {
      const clause = cleanSubtitleText(rawClause);
      const key = normalizeComparisonText(clause);
      if (!clause || key.length < 1 || seen.has(key)) continue;
      seen.add(key);
      result.push(clause);
    }
  }
  return result;
}

function subtitleTextsForClip(clip) {
  if (Array.isArray(clip.subtitleOverlaps)) {
    return clip.subtitleOverlaps.map(item => item?.text).filter(Boolean);
  }
  if (typeof clip.subtitleText === 'string') return clip.subtitleText.split(/\s*\/\s*/u);
  return [];
}

function joinSummaryParts(parts) {
  let clean = [...new Set(parts
    .map(part => sanitizeDescriptionPart(part))
    .filter(part => part && !isForbiddenSpeechSummaryPart(part)))];
  const strong = clean.filter(part => !WEAK_SPEECH_SUMMARY_PARTS.has(part));
  if (strong.length > 0) clean = strong;
  if (clean.length <= 1) return clean[0] || '';
  return `${clean.slice(0, -1).join('、')}，并${clean[clean.length - 1]}`;
}

function isForbiddenSpeechSummaryPart(part) {
  const clean = sanitizeDescriptionPart(part);
  return FORBIDDEN_SPEECH_SUMMARY_PARTS.has(clean)
    || /待人工复核|信息待复核/u.test(clean);
}

function areSimilarSummaryPhrases(left, right) {
  const leftText = normalizeComparisonText(left);
  const rightText = normalizeComparisonText(right);
  return leftText.includes(rightText) || rightText.includes(leftText);
}

function cleanupSpeechDetail(text) {
  return sanitizeDescriptionPart(text)
    .replace(/^车内有/u, '车内')
    .replace(/^声音里/u, '')
    .replace(/^现场/u, '现场')
    .replace(/画面以.*$/u, '')
    .replace(/为主$/u, '')
    .replace(/的记录$/u, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

function commonNonEmpty(values) {
  const normalized = values
    .map(value => safeHumanLabel(value))
    .filter(Boolean);
  if (normalized.length === 0) return '';
  const first = normalized[0];
  return normalized.every(value => value === first) ? first : '';
}

function clampDescription(value, maxLength) {
  const clean = sanitizeDescriptionPart(value);
  if (clean.length <= maxLength) return clean;
  return clean.slice(0, maxLength - 1).replace(/[，、；:：]$/u, '');
}

function visualDescription(input) {
  if (input.frameworkClass === 'timelapse' || input.contentKind === 'timelapse') {
    return describeTimelapseClip(input);
  }
  const parts = [];
  const prefix = prefixForContentKind(input);
  if (prefix) parts.push(prefix);
  const rawObservation = sanitizeDescriptionPart(input.narrationVisualEvidence?.visualObservation || input.visualObservation || '')
    .replace(/黄色车|黄车/g, '车辆')
    .replace(/yellow vehicle/ig, 'vehicle')
    .replace(/yellow car/ig, 'vehicle');
  const observation = localizeVisualObservation(input, rawObservation);
  if (observation && !parts.includes(observation)) {
    parts.push(observation);
  }
  const eventContext = safeHumanLabel(input.eventTitle || input.chronologyContext?.title || '');
  const context = commonChronologyLabel([input])
    || shortenRouteTitle(eventContext);
  if (context && !parts.some(part => normalizeComparisonText(part).includes(normalizeComparisonText(context)))) {
    parts.push(context);
  }
  return clampDescription(parts.filter(Boolean).join('，'), 180);
}

function describeTimelapseClip(input) {
  const parts = ['延时'];
  const chronologyLabel = commonChronologyLabel([input]);
  if (chronologyLabel) parts.push(chronologyLabel);
  const arc = inferTimelapseArc([input]);
  if (arc && !parts.includes(arc)) parts.push(arc);

  const observation = localizeVisualObservation(
    input,
    sanitizeDescriptionPart(input.narrationVisualEvidence?.visualObservation || input.visualObservation || ''),
  );
  if (observation && !shouldSkipTimelapseSequencePart(observation, parts)) {
    parts.push(observation);
  }

  return clampDescription(parts.filter(Boolean).join('，'), 180);
}

function localizeVisualObservation(input, observation) {
  const clean = sanitizeDescriptionPart(observation);
  if (!clean) return '';
  if (!isEnglishHeavyGeneratedText(clean)) return clean;
  return fallbackChineseVisualObservation(input, clean);
}

function isEnglishHeavyGeneratedText(text) {
  const words = String(text || '').match(/[A-Za-z][A-Za-z-]{2,}/g) ?? [];
  const meaningful = words.filter(word => !/^(GPS|DJI|MP4|MOV|CINE|LOG)$/i.test(word));
  if (meaningful.length >= 4) return true;
  const cjkCount = (String(text || '').match(/[\u3400-\u9fff]/g) ?? []).length;
  const latinCount = meaningful.join('').length;
  return latinCount >= 24 && latinCount > cjkCount;
}

function fallbackChineseVisualObservation(input, englishText) {
  const text = String(englishText || '').toLowerCase();
  const parts = [];
  const prefix = prefixForContentKind(input);
  if (prefix === '开车') parts.push('车辆沿道路前进');
  else if (prefix === '航拍') parts.push('航拍从高处展开空间关系');
  else if (prefix === '延时') parts.push('延时记录天气和光线变化');
  else parts.push('画面记录现场环境');

  const add = (label, pattern) => {
    if (pattern.test(text) && !parts.some(part => isSimilarText(part, label))) parts.push(label);
  };
  add('雨湿路面和车流灯光被拉长', /wet|rain|slick|taillight|streetlight|night/);
  add('桥梁、高架或隧道接入路线', /bridge|overpass|tunnel|viaduct|gantry/);
  add('山体、峡谷和弯道贴近道路', /mountain|valley|gorge|slope|cliff|winding|curve/);
  add('村寨、田块和道路连在一起', /village|field|farmland|terrace|house|building/);
  add('湖面、河道或水渠进入画面', /lake|river|water|canal|stream/);
  add('雪山、积雪和高原冷光压住视线', /snow|snowy|ice|peak|glacier/);
  add('森林、绿坡和林带贴着路边', /forest|tree|green|vegetation|lush/);

  const geoFeature = geoNarrativeFeatureForClip(input);
  if (geoFeature && !parts.some(part => isSimilarText(part, geoFeature))) parts.push(geoFeature);
  return clampDescription(parts.join('，'), 112);
}

function prefixForContentKind(input) {
  if (input.frameworkClass === 'aerial' || input.contentKind === 'aerial') return '航拍';
  if (input.frameworkClass === 'timelapse' || input.contentKind === 'timelapse') return '延时';
  if (input.contentKind === 'drive') return '开车';
  if (input.contentKind === 'photo') return '照片';
  return '画面';
}

function sanitizeEntryText(text) {
  const clean = sanitizeDescriptionPart(text)
    .replace(/叙事功能是/g, '')
    .replace(/不补旁白/g, '')
    .replace(/保留台词/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return clean || '当前时间线片段';
}

function sanitizeDescriptionPart(text) {
  return String(text ?? '')
    .replace(/[()（）【】《》{}]/g, '')
    .replace(/\s*\/\s*/g, '，')
    .replace(/\s+/g, ' ')
    .replace(/,+/g, '，')
    .replace(/，+/g, '，')
    .replace(/^，|，$/g, '')
    .trim()
    .slice(0, 180);
}

function safeHumanLabel(value) {
  const clean = sanitizeDescriptionPart(value);
  if (!clean || isMojibakeText(clean)) return '';
  return clean;
}

function isMojibakeText(value) {
  const text = String(value || '');
  if (!text) return false;
  if (/�/.test(text)) return true;
  const latinRuns = text.match(/[A-Za-zÀ-ÿ]{8,}/g) ?? [];
  return latinRuns.some(run => /[À-ÿ]/u.test(run));
}

function isEnglishHeavyDescription(value) {
  const text = String(value || '');
  const words = text.match(/[A-Za-z][A-Za-z-]{2,}/g) ?? [];
  const meaningful = words.filter(word => !/^(GPS|DJI|MP4|MOV|CINE|LOG)$/i.test(word));
  const cjkCount = (text.match(/[\u3400-\u9fff]/g) ?? []).length;
  const latinCount = meaningful.join('').length;
  return meaningful.length >= 4 || (latinCount >= 24 && latinCount > cjkCount);
}

function resolveAssetForItem(item, previousClip, index) {
  if (previousClip?.assetId && index.assetsById.has(previousClip.assetId)) {
    return index.assetsById.get(previousClip.assetId);
  }
  return resolveAssetFromCurrentSource(item, index);
}

function resolveSpanForItem(item, previousClip, asset, index) {
  const assetSpans = asset?.id
    ? (index.spansByAssetId.get(asset.id) ?? [])
    : [...index.spansById.values()];
  if (previousClip?.spanId && index.spansById.has(previousClip.spanId)) {
    const previousSpan = index.spansById.get(previousClip.spanId);
    if (!asset?.id || previousSpan.assetId === asset.id) {
      return previousSpan;
    }
  }
  if (!asset?.id) return null;
  if (String(asset.kind || '').toLowerCase() === 'photo') {
    return assetSpans.find(span => span.type === 'photo') ?? assetSpans[0] ?? null;
  }
  return selectClosestSpan(assetSpans, sourceRangeForItem(item, asset, 30), {
    maxDistanceMs: VISUAL_SPAN_NEAR_DISTANCE_MS,
  });
}

function resolveNarrationVisualEvidence({ item, itemIndex, asset, span, contentIndex, sourceRange }) {
  const prefix = `clip ${itemIndex + 1} ${item.sourceStem || stemFromPath(item.filePath || item.name || '')}`;
  const assetId = asset?.id || span?.assetId || '';
  const visualCandidates = assetId ? (contentIndex.visualSpansByAssetId.get(assetId) ?? []) : [];
  const currentSpanIsVisual = isVisualEvidenceSpan(span);

  if (currentSpanIsVisual) {
    return {
      source: 'same-asset-visual-span',
      visualObservation: sanitizeDescriptionPart(span.visualObservation),
      spanId: span.id,
      overlapMs: Math.max(0, rangeOverlapMs(sourceRange, rangeForSpan(span))),
      distanceMs: rangeDistanceMs(sourceRange, rangeForSpan(span)),
    };
  }

  const visualMatch = selectClosestSpan(visualCandidates, sourceRange, {
    maxDistanceMs: VISUAL_SPAN_NEAR_DISTANCE_MS,
  });
  if (visualMatch && hasUsableVisualObservation(visualMatch.visualObservation)) {
    const visualRange = rangeForSpan(visualMatch);
    return {
      source: 'same-asset-visual-span',
      visualObservation: sanitizeDescriptionPart(visualMatch.visualObservation),
      spanId: visualMatch.id,
      overlapMs: Math.max(0, rangeOverlapMs(sourceRange, visualRange)),
      distanceMs: rangeDistanceMs(sourceRange, visualRange),
    };
  }

  if (isSpeechLikeSemantic(span?.semanticKind) && hasUsableVisualObservation(span?.visualObservation)) {
    return {
      source: 'speech-span-visualObservation-fallback',
      visualObservation: sanitizeDescriptionPart(span.visualObservation),
      spanId: span.id,
      overlapMs: Math.max(0, rangeOverlapMs(sourceRange, rangeForSpan(span))),
      distanceMs: rangeDistanceMs(sourceRange, rangeForSpan(span)),
      fallbackReason: 'no-nearby-same-asset-visual-span',
    };
  }

  if (hasUsableVisualObservation(span?.visualObservation)) {
    return {
      source: 'current-span-visualObservation-fallback',
      visualObservation: sanitizeDescriptionPart(span.visualObservation),
      spanId: span.id,
      overlapMs: Math.max(0, rangeOverlapMs(sourceRange, rangeForSpan(span))),
      distanceMs: rangeDistanceMs(sourceRange, rangeForSpan(span)),
      fallbackReason: 'current-span-has-visualObservation',
    };
  }

  return {
    source: 'missing-visualObservation-warning',
    visualObservation: `${prefix}缺少可用视觉观察`,
    ...(span?.id ? { spanId: span.id } : {}),
    fallbackReason: 'missing-visualObservation',
    warning: `${prefix} has no usable visualObservation for no-subtitle narration framework entry`,
  };
}

function resolveAssetFromCurrentSource(item, index) {
  const candidatesById = new Map();
  for (const stem of currentSourceStems(item)) {
    for (const candidate of index.assetsByStem.get(normalizeKey(stem)) ?? []) {
      candidatesById.set(candidate.id, candidate);
    }
  }
  const candidates = [...candidatesById.values()];
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];
  const filePath = normalizePathForCompare(item.filePath || item.mediaPoolName || '');
  if (filePath) {
    const exact = candidates.find(candidate => {
      const sourcePath = normalizePathForCompare(candidate.sourcePath || candidate.displayName || candidate.id);
      return sourcePath && (filePath.endsWith(`/${sourcePath}`) || filePath.endsWith(sourcePath));
    });
    if (exact) return exact;
  }
  return null;
}

function isPreviousClipCompatible(previousClip, currentSourceAsset) {
  if (!previousClip) return false;
  if (!currentSourceAsset?.id) return true;
  return previousClip.assetId === currentSourceAsset.id;
}

function currentSourceStems(item) {
  return [
    item?.sourceStem,
    stemFromPath(item?.filePath),
    stemFromPath(item?.mediaPoolName),
  ]
    .map(value => String(value || '').trim())
    .filter(Boolean);
}

function sourceRangeForItem(item, asset, fallbackFps) {
  const startFrame = finiteNumber(item?.sourceStartFrame);
  const endFrame = finiteNumber(item?.sourceEndFrame);
  const fps = sourceFpsForItem(item, asset, fallbackFps);
  if (startFrame == null || endFrame == null || !Number.isFinite(fps) || fps <= 0) return null;
  return {
    sourceInMs: startFrame * 1000 / fps,
    sourceOutMs: endFrame * 1000 / fps,
    fps,
  };
}

function sourceFpsForItem(item, asset, fallbackFps) {
  const mediaFps = finiteNumber(item?.mediaProperty?.FPS)
    ?? finiteNumber(item?.mediaProperty?.fps)
    ?? finiteNumber(item?.clipProperty?.FPS)
    ?? finiteNumber(item?.property?.FPS);
  return finiteNumber(asset?.fps)
    ?? mediaFps
    ?? finiteNumber(fallbackFps)
    ?? 30;
}

function rangeForSpan(span) {
  if (!span) return null;
  const sourceInMs = finiteNumber(span.sourceInMs) ?? finiteNumber(span.editSourceInMs);
  const sourceOutMs = finiteNumber(span.sourceOutMs) ?? finiteNumber(span.editSourceOutMs);
  if (sourceInMs == null || sourceOutMs == null) return null;
  return { sourceInMs, sourceOutMs };
}

function selectClosestSpan(spans, sourceRange, options = {}) {
  const maxDistanceMs = finiteNumber(options.maxDistanceMs);
  let best = null;
  let bestScore = null;
  for (const span of spans ?? []) {
    const spanRange = rangeForSpan(span);
    if (!sourceRange || !spanRange) {
      if (!best) best = span;
      continue;
    }
    const overlapMs = Math.max(0, rangeOverlapMs(sourceRange, spanRange));
    const distanceMs = rangeDistanceMs(sourceRange, spanRange);
    if (overlapMs <= 0 && maxDistanceMs != null && distanceMs > maxDistanceMs) continue;
    const score = {
      overlapMs,
      distanceMs,
      sourceInMs: spanRange.sourceInMs,
      durationMs: Math.max(0, spanRange.sourceOutMs - spanRange.sourceInMs),
    };
    if (!bestScore || compareSpanRangeScore(score, bestScore) < 0) {
      best = span;
      bestScore = score;
    }
  }
  return best;
}

function compareSpanRangeScore(left, right) {
  const leftHasOverlap = left.overlapMs > 0;
  const rightHasOverlap = right.overlapMs > 0;
  if (leftHasOverlap !== rightHasOverlap) return leftHasOverlap ? -1 : 1;
  if (leftHasOverlap && left.overlapMs !== right.overlapMs) return right.overlapMs - left.overlapMs;
  if (left.distanceMs !== right.distanceMs) return left.distanceMs - right.distanceMs;
  if (left.durationMs !== right.durationMs) return right.durationMs - left.durationMs;
  return left.sourceInMs - right.sourceInMs;
}

function rangeOverlapMs(left, right) {
  if (!left || !right) return 0;
  return Math.min(left.sourceOutMs, right.sourceOutMs) - Math.max(left.sourceInMs, right.sourceInMs);
}

function rangeDistanceMs(left, right) {
  if (!left || !right) return null;
  const overlap = rangeOverlapMs(left, right);
  if (overlap > 0) return 0;
  if (left.sourceOutMs <= right.sourceInMs) return right.sourceInMs - left.sourceOutMs;
  return left.sourceInMs - right.sourceOutMs;
}

function isVisualEvidenceSpan(span) {
  return Boolean(
    span
    && !isSpeechLikeSemantic(span.semanticKind)
    && hasUsableVisualObservation(span.visualObservation)
    && !hasTranscriptTruth(span)
  );
}

function isSpeechLikeSemantic(value) {
  return /^(speech|mixed)$/i.test(String(value || '').trim());
}

function hasTranscriptTruth(span) {
  return Boolean(
    typeof span?.transcript === 'string' && span.transcript.trim()
    || Array.isArray(span?.transcriptSegments) && span.transcriptSegments.length > 0
  );
}

function hasUsableVisualObservation(value) {
  const clean = sanitizeDescriptionPart(value);
  if (!clean) return false;
  if (/待人工复核|信息待复核|口播信息待|subtitle\s*\d*$/iu.test(clean)) return false;
  return clean.length >= 4;
}

function assetLookupStems(asset) {
  return [
    stemFromPath(asset.sourcePath),
    stemFromPath(asset.displayName),
    asset.id,
  ]
    .map(value => String(value || '').trim())
    .filter(Boolean);
}

function classifyContentKind({ item, span, asset, previousClip }) {
  const spanType = String(span?.type || '').toLowerCase();
  if (spanType === 'timelapse') return 'timelapse';
  if (spanType === 'aerial') return 'aerial';
  if (spanType === 'drive') return 'drive';
  if (spanType === 'photo') return 'photo';
  if (spanType === 'broll' || spanType === 'talking-head') return 'visual';
  if (asset?.kind === 'photo' || previousClip?.assetKind === 'photo') return 'photo';

  const fallbackText = [
    span?.semanticKind,
    span?.visualObservation,
    item?.name,
    item?.sourceStem,
    item?.mediaPoolName,
    asset?.kind,
    previousClip?.assetKind,
  ].join(' ');
  if (/timelapse|延时|縮時|缩时/i.test(fallbackText)) return 'timelapse';
  if (/aerial|drone|航拍|无人机/i.test(fallbackText)) return 'aerial';
  if (/photo|照片|图片/i.test(fallbackText)) return 'photo';
  if (/drive|行车|开车|公路|道路|高速/i.test(fallbackText)) return 'drive';
  return 'visual';
}

function rangesOverlapFrames(left, right, fps) {
  const leftStart = Number(left.startFrame);
  const leftEnd = Number(left.endFrame);
  const rightStart = Number(right.startFrame);
  const rightEnd = Number(right.endFrame);
  if (![leftStart, leftEnd, rightStart, rightEnd].every(Number.isFinite)) return false;
  const overlap = Math.min(leftEnd, rightEnd) - Math.max(leftStart, rightStart);
  return overlap >= Math.max(1, Math.round(Number(fps || 30) * 0.05));
}

function compareTimelineItems(left, right) {
  return (Number(left.startFrame) || 0) - (Number(right.startFrame) || 0)
    || (Number(left.trackIndex) || 0) - (Number(right.trackIndex) || 0)
    || (Number(left.endFrame) || 0) - (Number(right.endFrame) || 0)
    || String(left.name || '').localeCompare(String(right.name || ''));
}

function hasFiniteRange(item) {
  return Number.isFinite(Number(item.startFrame)) && Number.isFinite(Number(item.endFrame));
}

function extractClipId(name) {
  const match = String(name || '').match(/\bclip-\d{5}\b/i);
  return match ? match[0] : '';
}

function shortenRouteTitle(text) {
  return text
    .replace(/^行车[:：]\s*/, '行车')
    .replace(/广东省，|广西壮族自治区，|云南省，|贵州省，|西藏自治区，|四川省，/g, '')
    .slice(0, 80);
}

function shortLocationLabel(value) {
  const clean = sanitizeDescriptionPart(value);
  if (!clean) return '';
  const dotParts = clean.split(/\s*·\s*/u).map(part => part.trim()).filter(Boolean);
  if (dotParts.length >= 2) {
    const last = dotParts[dotParts.length - 1];
    const parent = dotParts
      .slice(0, -1)
      .join(' · ')
      .split(/[，,]/u)
      .map(part => part.trim())
      .filter(Boolean)
      .at(-1);
    return (parent && parent !== last ? `${parent} · ${last}` : last).slice(0, 42);
  }
  const commaParts = clean.split(/[，,]/u).map(part => part.trim()).filter(Boolean);
  if (commaParts.length >= 2) return commaParts.slice(-2).join('，').slice(0, 42);
  return clean.slice(0, 42);
}

function summarizeSubtitleText(overlaps) {
  const parts = [];
  for (const overlap of overlaps) {
    const text = cleanSubtitleText(overlap.text);
    if (!text || isGenericSubtitleText(text) || parts.includes(text)) continue;
    parts.push(text);
    if (parts.join(' / ').length > 160) break;
  }
  return parts.join(' / ').slice(0, 220);
}

function hasSharedSubtitleFragment(left, right) {
  const leftFragments = subtitleTextsForClip(left).map(normalizeComparisonText).filter(text => text.length >= 4);
  const rightFragments = new Set(subtitleTextsForClip(right).map(normalizeComparisonText).filter(text => text.length >= 4));
  return leftFragments.some(fragment => rightFragments.has(fragment));
}

function speechTopicContinuityScore(left, right) {
  const leftTokens = new Set(left.speechTopicTokens ?? extractSpeechTopicTokens(subtitleTextsForClip(left)));
  const rightTokens = new Set(right.speechTopicTokens ?? extractSpeechTopicTokens(subtitleTextsForClip(right)));
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
  const common = [...leftTokens].filter(token => rightTokens.has(token));
  if (common.length === 0) return 0;
  return common.length / Math.min(leftTokens.size, rightTokens.size);
}

function startsWithContinuationCue(clip) {
  const first = uniqueSubtitleClauses(subtitleTextsForClip(clip))[0] || '';
  return /^(然后|但是|但|不过|而且|所以|因为|只不过|这边|那边|它|这个|那个|还有|也|就|要|现在|最后|虽然)/u.test(first);
}

function hasShortSpeechGap(left, right, fps) {
  const gapFrames = Number(right.timelineStartFrame) - Number(left.timelineEndFrame);
  return Number.isFinite(gapFrames) && gapFrames <= Math.max(2, Math.round(Number(fps || 30) * 0.04));
}

function extractSpeechTopicTokens(texts) {
  const tokens = [];
  for (const clause of uniqueSubtitleClauses(texts)) {
    const normalized = normalizeComparisonText(rewriteSubtitleClause(clause));
    for (const token of keywordTokensFromText(normalized)) {
      if (!tokens.includes(token)) tokens.push(token);
      if (tokens.length >= 16) return tokens;
    }
  }
  return tokens;
}

function keywordTokensFromText(value) {
  const text = String(value || '')
    .replace(/现在|然后|因为|所以|还是|就是|感觉|非常|这个|那个|我们|它|这里|那里|一种|一点|已经|没有|时候|上次|这次|可以|好像|其实|这个/g, '');
  const explicit = text.match(/[A-Za-z0-9]+|[\u3400-\u9fff]{2,8}/gu) ?? [];
  const tokens = [];
  for (const item of explicit) {
    if (item.length >= 2 && !isGenericSpeechToken(item)) tokens.push(item);
  }
  for (let size = 2; size <= 3; size += 1) {
    for (let index = 0; index <= text.length - size; index += 1) {
      const token = text.slice(index, index + size);
      if (!/^[\u3400-\u9fff]+$/u.test(token) || isGenericSpeechToken(token)) continue;
      tokens.push(token);
    }
  }
  return [...new Set(tokens)].slice(0, 18);
}

function isGenericSpeechToken(value) {
  return /^(这个|那个|现在|然后|因为|所以|还是|就是|感觉|非常|一点|一种|这里|那里|上次|这次|时候|没有|可以|好像|其实|起来|看到|提到|说明|交代|描述|记录|表达|评价|口播|沿途|现场|感受|风光|待人工复核|信息待复核|现场口播片段)$/.test(String(value || ''));
}

function cleanSubtitleText(text) {
  return sanitizeDescriptionPart(String(text || '')
    .replace(/\r?\n/g, ' ')
    .replace(/\uFFFD+/g, '')
    .replace(/[ÃÂ][\u0080-\u00ff]|â[\u0080-\u00ff]/gu, ''));
}

function isGenericSubtitleText(text) {
  return /^subtitle\s*\d*$/i.test(String(text || '').trim());
}

function normalizePatterns(value) {
  if (!Array.isArray(value)) return [];
  const result = [];
  for (const item of value) {
    const text = sanitizeDescriptionPart(item);
    if (!text || result.includes(text)) continue;
    result.push(text);
  }
  return result;
}

function stemFromPath(value) {
  const text = String(value || '').replace(/\\/g, '/');
  const base = basename(text);
  return base.slice(0, base.length - extname(base).length) || base;
}

function normalizeKey(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeComparisonText(value) {
  return String(value || '')
    .replace(/[^\p{Letter}\p{Number}\u3400-\u9fff]+/gu, '')
    .trim();
}

function normalizePathForCompare(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
}

function isVisualFrameworkTag(tag) {
  const text = String(tag || '');
  if (!text) return false;
  if (/口播|语音|有字幕|无字幕/.test(text)) return false;
  if (/讨论|抱怨|吐槽|说话|说到|提到|对话|声音|介绍|说明|交代|回应|聊天|闲聊|感受|判断|期待/.test(text)) {
    return false;
  }
  return true;
}

function addMapList(map, key, value) {
  if (!key) return;
  const current = map.get(key) ?? [];
  current.push(value);
  map.set(key, current);
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function hasCjk(value) {
  return /[\u3400-\u9fff]/.test(String(value || ''));
}

function resolveTimelineAuditPath(root, auditPath) {
  if (!auditPath) return '';
  return resolve(WORKSPACE_ROOT, auditPath);
}

function resolveOutputRoots(root, id) {
  const tmpPostlockRoot = join(root, '.tmp', 'edit-flow', id, 'postlock');
  const officialPostlockRoot = join(root, 'edits', id, 'postlock');
  return {
    tmpPostlockRoot,
    officialPostlockRoot,
    rawResolveExportPath: join(tmpPostlockRoot, 'current-resolve-timeline-export.json'),
    packetPath: join(tmpPostlockRoot, 'current-timeline-clip-packet.json'),
    preciseGeoPath: join(tmpPostlockRoot, 'narration-framework.precise-geo.json'),
    frameworkPath: join(officialPostlockRoot, 'narration-framework.md'),
    clipMapPath: join(officialPostlockRoot, 'narration-framework.clip-map.json'),
  };
}

async function runValidator(root, id, options = {}) {
  const script = join(WORKSPACE_ROOT, 'scripts', 'validate-postlock-narration-framework.mjs');
  const args = [script, root, id];
  if (options.framework) args.push('--framework', options.framework);
  if (options.map) args.push('--map', options.map);
  if (options.packet) args.push('--packet', options.packet);
  await execFile(process.execPath, args, {
    cwd: WORKSPACE_ROOT,
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
  });
}

function buildRunRecord(input) {
  const step = input.flowPlan.steps.find(item => item.id === 'postlock-narration-framework-codex-v1')
    ?? input.flowPlan.steps.find(item => item.capabilityId === 'postlock.subtitle_narration' && item.runner === 'agent');
  const timestamp = compactTimestamp(input.generatedAt);
  const relativeOfficial = `edits/${input.editId}/postlock/narration-framework.md`;
  const relativeMap = `edits/${input.editId}/postlock/narration-framework.clip-map.json`;
  const relativePacket = `projects/${basename(projectRoot)}/.tmp/edit-flow/${input.editId}/postlock/current-timeline-clip-packet.json`;
  return {
    schemaVersion: '1.0',
    runId: `run-narration-framework-awaiting-review-${timestamp}`,
    editId: input.editId,
    flowPlanId: input.flowPlan.id,
    flowPlanHash: createHash('sha256').update(input.flowPlanRaw).digest('hex'),
    stepId: step?.id ?? 'postlock-narration-framework-codex-v1',
    capabilityId: 'postlock.subtitle_narration',
    runner: 'agent',
    status: 'awaiting_review',
    startedAt: input.generatedAt,
    updatedAt: input.generatedAt,
    completedAt: input.generatedAt,
    inputRefs: step?.inputRefs ?? [
      'edits/<editId>/timeline/locked-rough-cut.json',
      'Resolve timeline: speech subtitle track',
      'media/chronology.json',
      'config/edit-rules/travel-documentary.md',
    ],
    outputRefs: [
      ...(step?.outputRefs ?? ['edits/<editId>/postlock/narration-framework.md']),
      'edits/<editId>/postlock/narration-framework.clip-map.json',
      'projects/<projectId>/.tmp/edit-flow/<editId>/postlock/current-timeline-clip-packet.json',
    ],
    inputSnapshot: {
      source: 'codex-agent-current-resolve-clip-packet',
      projectId: basename(projectRoot),
      resolveProject: input.lockedRoughCut.resolveProjectName,
      timeline: input.lockedRoughCut.timelineName,
      timelineFps: input.packet.source.timelineFps,
      videoClipCount: input.packet.summary.videoClipCount,
      subtitleItemCount: input.packet.summary.subtitleItemCount,
      staleResolveNameClipIdCount: input.packet.summary.staleResolveNameClipIdCount,
      frameworkFormat: FRAMEWORK_FORMAT,
      clipMapSchema: VALID_MAP_SCHEMA,
      speechClipCount: input.packet.summary.speechClipCount,
      narrationClipCount: input.packet.summary.narrationClipCount,
      speechEntryCount: input.packet.summary.speechEntryCount,
      narrationEntryCount: input.packet.summary.narrationEntryCount,
      frameworkEntryCount: input.packet.summary.frameworkEntryCount,
      frameworkPackCount: input.packet.summary.frameworkPackCount,
      drivePackCount: input.packet.summary.drivePackCount,
      aerialPackCount: input.packet.summary.aerialPackCount,
      speechMergeGroupCount: input.packet.summary.speechMergeGroupCount,
      photoSequenceGroupCount: input.packet.summary.photoSequenceGroupCount,
      timelapseSequenceGroupCount: input.packet.summary.timelapseSequenceGroupCount,
      chronologyContextClipCount: input.packet.summary.chronologyContextClipCount,
      narrationVisualEvidenceCount: input.packet.summary.narrationVisualEvidenceCount,
      narrationVisualEvidenceSameAssetVisualSpanCount: input.packet.summary.narrationVisualEvidenceSameAssetVisualSpanCount,
      narrationVisualEvidenceFallbackCount: input.packet.summary.narrationVisualEvidenceFallbackCount,
      narrationVisualEvidenceWarningCount: input.packet.summary.narrationVisualEvidenceWarningCount,
      narrationVisualEvidencePolicy: input.packet.policy?.narrationVisualEvidencePolicy,
      subtitleBoundaryPolicy: 'A video clip is speech only when it overlaps a current Resolve subtitle item; framework body uses Markdown pack-list v2 for writing organization, while clip-map entries keep leaf clip boundaries. Plain no-subtitle clips remain leaf mapped; explicit adjacent photo/timelapse sequences may share one leaf entry.',
      flowPlanStatus: input.flowPlan.status,
      editRuleHash: input.flowPlan.editRuleHash,
      ...(input.subagentId ? { subagent: input.subagentId } : {}),
    },
    outputPaths: [
      relativeOfficial,
      relativeMap,
      relativePacket,
    ],
    summary: {
      artifact: relativeOfficial,
      clipMap: relativeMap,
      timelinePacket: relativePacket,
      resolveProject: input.lockedRoughCut.resolveProjectName,
      timeline: input.lockedRoughCut.timelineName,
      videoClipCount: input.packet.summary.videoClipCount,
      staleResolveNameClipIdCount: input.packet.summary.staleResolveNameClipIdCount,
      speechClipCount: input.packet.summary.speechClipCount,
      narrationClipCount: input.packet.summary.narrationClipCount,
      speechEntryCount: input.packet.summary.speechEntryCount,
      narrationEntryCount: input.packet.summary.narrationEntryCount,
      frameworkFormat: FRAMEWORK_FORMAT,
      clipMapSchema: VALID_MAP_SCHEMA,
      frameworkPackCount: input.packet.summary.frameworkPackCount,
      drivePackCount: input.packet.summary.drivePackCount,
      aerialPackCount: input.packet.summary.aerialPackCount,
      speechMergeGroupCount: input.packet.summary.speechMergeGroupCount,
      photoSequenceGroupCount: input.packet.summary.photoSequenceGroupCount,
      timelapseSequenceGroupCount: input.packet.summary.timelapseSequenceGroupCount,
      narrationVisualEvidenceCount: input.packet.summary.narrationVisualEvidenceCount,
      narrationVisualEvidenceSameAssetVisualSpanCount: input.packet.summary.narrationVisualEvidenceSameAssetVisualSpanCount,
      narrationVisualEvidenceFallbackCount: input.packet.summary.narrationVisualEvidenceFallbackCount,
      narrationVisualEvidenceWarningCount: input.packet.summary.narrationVisualEvidenceWarningCount,
      frameworkLineCount: input.packet.summary.frameworkEntryCount,
      frameworkCharCount: input.framework.length,
      validation: 'passed',
      boundaryPolicy: 'clip-level-pack-list-v2',
      visualEvidencePolicy: input.packet.policy?.narrationVisualEvidencePolicy,
      subagentUsed: Boolean(input.subagentId),
      ...(input.subagentId ? { subagentId: input.subagentId } : {}),
      reviewRequiredBeforeNextStep: true,
    },
    review: {
      status: 'pending',
      note: 'Clip-level narration framework regenerated from current Resolve timeline and awaits human review.',
    },
  };
}

async function appendRunRecord(root, id, record, updatedAt) {
  const runsPath = join(root, 'edits', id, 'runs', 'current.json');
  const existing = await readOptionalJson(runsPath) ?? {
    schemaVersion: '1.0',
    editId: id,
    updatedAt,
    records: [],
  };
  const records = (existing.records ?? [])
    .filter(item => item.runId !== record.runId)
    .map(item => {
      if (
        item.stepId === record.stepId
        && item.capabilityId === record.capabilityId
        && item.status !== 'stale'
      ) {
        return {
          ...item,
          status: 'stale',
          updatedAt,
          error: `Superseded by regenerated clip-level narration framework run ${record.runId}.`,
          review: {
            ...(item.review ?? {}),
            status: 'pending',
            note: `Stale: superseded by ${record.runId}.`,
          },
          summary: {
            ...(item.summary ?? {}),
            invalidatedAt: updatedAt,
            invalidatedReason: `superseded by ${record.runId}`,
          },
        };
      }
      return item;
    });
  records.push(record);
  await writeJson(runsPath, {
    schemaVersion: '1.0',
    editId: id,
    updatedAt,
    records,
  });
}

function compactTimestamp(iso) {
  return iso.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function readOptionalJson(path) {
  if (!path || !existsSync(path)) return null;
  return readJson(path);
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
