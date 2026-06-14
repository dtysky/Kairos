#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const VALID_PACKET_SCHEMA = 'kairos-postlock-narration-framework-clip-packet-v2';
const VALID_MAP_SCHEMA = 'kairos-postlock-narration-framework-clip-map-v2';
const VALID_FRAMEWORK_FORMAT = 'markdown-pack-list-v2';
const VALID_MARKERS = new Set(['speech', 'visual', 'aerial', 'timelapse']);
const NON_SPEECH_MARKERS = new Set(['visual', 'aerial', 'timelapse']);
const NO_SUBTITLE_SPEECH_EVIDENCE_SOURCES = new Set([
  'same-asset-visual-span',
  'speech-span-visualObservation-fallback',
  'missing-visualObservation-warning',
]);
const MARKER_FROM_OPEN = new Map([
  ['（', 'speech'],
  ['【', 'visual'],
  ['《', 'aerial'],
  ['{', 'timelapse'],
]);
const FORBIDDEN_BODY_PHRASES = [
  '叙事功能是',
  '不补旁白',
  '保留台词',
];
const FORBIDDEN_SPEECH_PHRASES = [
  '口播信息待人工复核',
  '待人工复核',
  '信息待复核',
  '现场口播片段',
];
const FORBIDDEN_VISUAL_TEMPLATE_PHRASES = [
  '先停在确认',
  '继续停在确认',
  '最后停在确认',
  '之间的关系',
  '让这段路的绕行和高差变得可见',
  '不再只是窗外景物',
  '决定路线如何绕行的现场条件',
  '高原长途转场的地形关系',
];
const STOCK_VISUAL_TAGS = new Set([
  '云雾天光',
  '晴空',
  '清晨光线',
  '黄昏日落',
  '夜色',
  '雾气压低视线',
  '雨后湿滑',
  '积雪结冰',
  '高速路面',
  '道路延伸',
  '连续弯道',
  '桥梁高架',
  '隧道',
  '收费站',
  '护栏石墙',
  '路牌标识',
  '车流穿行',
  '黄色车在画面中推进',
  '灯光反射',
  '加油站停靠',
  '停车场景',
  '高空俯瞰',
  '山谷群峰',
  '林木植被',
  '村寨建筑',
  '田地梯田',
  '河道水系',
  '湖岸水面',
  '水面反光',
  '路旁花树',
  '棕榈树',
  '山坡风机',
  '人物在场',
  '红衣人物',
  '长外套人物',
  '观景平台',
]);

const args = process.argv.slice(2);
const options = parseArgs(args);

if (!options.projectRoot) {
  usage();
  process.exit(2);
}

const projectRoot = resolve(options.projectRoot);
const editId = options.editId ?? 'main';
const packetPath = resolve(options.packet ?? join(projectRoot, '.tmp', 'edit-flow', editId, 'postlock', 'current-timeline-clip-packet.json'));
const frameworkPath = resolve(options.framework ?? join(projectRoot, 'edits', editId, 'postlock', 'narration-framework.md'));
const mapPath = resolve(options.map ?? join(projectRoot, 'edits', editId, 'postlock', 'narration-framework.clip-map.json'));

const failures = [];

const [packet, frameworkText, clipMap] = await Promise.all([
  readJson(packetPath, 'clip-level packet', failures),
  readText(frameworkPath, 'narration framework', failures),
  readJson(mapPath, 'framework clip map', failures),
]);

if (packet && frameworkText !== null && clipMap) {
  validate({ packet, frameworkText, clipMap, failures });
}

if (failures.length > 0) {
  console.error(JSON.stringify({
    ok: false,
    projectRoot,
    editId,
    packetPath,
    frameworkPath,
    mapPath,
    failures,
  }, null, 2));
  process.exit(1);
}

const entries = parseFrameworkEntries(frameworkText, []);
const clips = packet.clips;
const nonSpeechClips = clips.filter(clip => !clip.hasSubtitle);
const speechClips = clips.filter(clip => clip.hasSubtitle);
console.log(JSON.stringify({
  ok: true,
  projectRoot,
  editId,
  packetPath,
  frameworkPath,
  mapPath,
  clipCount: clips.length,
  speechClipCount: speechClips.length,
  narrationClipCount: nonSpeechClips.length,
  frameworkEntryCount: entries.length,
  narrationEntryCount: entries.filter(entry => NON_SPEECH_MARKERS.has(entry.marker)).length,
}, null, 2));

function validate({ packet, frameworkText, clipMap, failures }) {
  validatePacket(packet, failures);
  validateClipMap(clipMap, failures);
  validateNoMojibakeText('narration framework', frameworkText, failures);
  const entries = parseFrameworkEntries(frameworkText, failures);
  validatePackMapAlignment(frameworkText, clipMap, failures);
  if (!Array.isArray(packet.clips) || !Array.isArray(clipMap.entries) || entries.length === 0) return;

  const clips = packet.clips;
  const clipByIndex = new Map(clips.map(clip => [clip.index, clip]));
  const packetClipIndices = new Set(clips.map(clip => clip.index));
  const mapEntries = clipMap.entries;

  if (entries.length !== mapEntries.length) {
    failures.push(`framework entry count (${entries.length}) must equal clip-map entry count (${mapEntries.length})`);
  }

  const allMappedClipIndices = [];
  const nonSpeechMappedClipIndices = [];
  const duplicateClipIndices = new Set();
  const seenClipIndices = new Set();

  for (let i = 0; i < mapEntries.length; i += 1) {
    const mapEntry = mapEntries[i];
    const markdownEntry = entries[i];
    if (!markdownEntry) continue;
    if (mapEntry.marker !== markdownEntry.marker) {
      failures.push(`entry ${i + 1} marker mismatch: markdown=${markdownEntry.marker}, clip-map=${mapEntry.marker}`);
    }

    const clipIndices = Array.isArray(mapEntry.clips) ? mapEntry.clips : [];
    if (NON_SPEECH_MARKERS.has(mapEntry.marker) && clipIndices.length !== 1) {
      if (mapEntry.marker === 'visual') {
        validateExplicitPhotoSequence({
          entryIndex: i + 1,
          markdownEntry,
          clipIndices,
          clips,
          clipByIndex,
          failures,
        });
      } else if (mapEntry.marker === 'timelapse') {
        validateExplicitTimelapseSequence({
          entryIndex: i + 1,
          markdownEntry,
          clipIndices,
          clips,
          clipByIndex,
          failures,
        });
      } else {
        failures.push(`non-speech entry ${i + 1} maps ${clipIndices.length} clips; only adjacent photo sequences or same-chronology timelapse sequences may merge`);
      }
    }
    if (mapEntry.marker === 'speech' && clipIndices.length > 1) {
      validateExplicitSpeechMerge({ entryIndex: i + 1, clipIndices, clips, clipByIndex, failures });
    }
    if (mapEntry.marker === 'speech') {
      validateSpeechEntryText({
        entryIndex: i + 1,
        markdownEntry,
        clipIndices,
        clipByIndex,
        failures,
      });
    } else {
      validateNonSpeechEntryText({
        entryIndex: i + 1,
        markdownEntry,
        marker: mapEntry.marker,
        clipIndices,
        clipByIndex,
        failures,
      });
    }

    for (const clipIndex of clipIndices) {
      allMappedClipIndices.push(clipIndex);
      if (seenClipIndices.has(clipIndex)) duplicateClipIndices.add(clipIndex);
      seenClipIndices.add(clipIndex);
      const clip = clipByIndex.get(clipIndex);
      if (!clip) {
        failures.push(`entry ${i + 1} references clipIndex=${clipIndex}, which does not exist in packet`);
        continue;
      }
      if (mapEntry.marker === 'speech') {
        if (!clip.hasSubtitle) {
          failures.push(`entry ${i + 1} is speech but clipIndex=${clipIndex} has no subtitle`);
        }
        continue;
      }
      nonSpeechMappedClipIndices.push(clipIndex);
      if (clip.hasSubtitle) {
        failures.push(`entry ${i + 1} is ${mapEntry.marker} but clipIndex=${clipIndex} has subtitle`);
      }
      if (clip.frameworkClass !== mapEntry.marker) {
        failures.push(`entry ${i + 1} marker=${mapEntry.marker} but clipIndex=${clipIndex} frameworkClass=${clip.frameworkClass}`);
      }
    }
  }

  for (const clipIndex of duplicateClipIndices) {
    failures.push(`clipIndex=${clipIndex} is mapped by more than one framework entry`);
  }

  const missingClipIndices = [...packetClipIndices].filter(clipIndex => !seenClipIndices.has(clipIndex));
  if (missingClipIndices.length > 0) {
    failures.push(`clip-map is missing ${missingClipIndices.length} packet clip(s): ${previewList(missingClipIndices)}`);
  }

  const extraClipIndices = allMappedClipIndices.filter(clipIndex => !packetClipIndices.has(clipIndex));
  if (extraClipIndices.length > 0) {
    failures.push(`clip-map references ${extraClipIndices.length} non-packet clip(s): ${previewList(extraClipIndices)}`);
  }

  const expectedNonSpeech = clips.filter(clip => !clip.hasSubtitle).map(clip => clip.index);
  const missingNonSpeech = expectedNonSpeech.filter(clipIndex => !nonSpeechMappedClipIndices.includes(clipIndex));
  const extraNonSpeech = nonSpeechMappedClipIndices.filter(clipIndex => !expectedNonSpeech.includes(clipIndex));
  if (missingNonSpeech.length > 0) {
    failures.push(`framework is missing ${missingNonSpeech.length} no-subtitle clip entry/entries: ${previewList(missingNonSpeech)}`);
  }
  if (extraNonSpeech.length > 0) {
    failures.push(`framework maps ${extraNonSpeech.length} subtitle clip(s) as narration entries: ${previewList(extraNonSpeech)}`);
  }
}

function validatePacket(packet, failures) {
  if (!isPlainObject(packet)) {
    failures.push('clip-level packet must be a JSON object');
    return;
  }
  if (packet.schemaVersion !== VALID_PACKET_SCHEMA) {
    failures.push(`clip-level packet schemaVersion must be ${VALID_PACKET_SCHEMA}; got ${String(packet.schemaVersion)}`);
  }
  if (Array.isArray(packet.groups) && packet.groups.length > 0) {
    failures.push('group-level packets are forbidden for narration-framework generation; use packet.clips only');
  }
  if (!Array.isArray(packet.clips) || packet.clips.length === 0) {
    failures.push('clip-level packet must contain a non-empty clips[] array');
    return;
  }

  const seen = new Set();
  for (let i = 0; i < packet.clips.length; i += 1) {
    const clip = packet.clips[i];
    const prefix = `packet.clips[${i}]`;
    if (!isPlainObject(clip)) {
      failures.push(`${prefix} must be an object`);
      continue;
    }
    if (!Number.isInteger(clip.index) || clip.index <= 0) {
      failures.push(`${prefix}.index must be a positive integer`);
    }
    if (seen.has(clip.index)) {
      failures.push(`duplicate clip index in packet: ${clip.index}`);
    }
    seen.add(clip.index);
    if (typeof clip.hasSubtitle !== 'boolean') {
      failures.push(`${prefix}.hasSubtitle must be boolean`);
    }
    if (!VALID_MARKERS.has(clip.frameworkClass)) {
      failures.push(`${prefix}.frameworkClass must be one of ${[...VALID_MARKERS].join(', ')}`);
    }
    validatePacketConsumableTextFields({ clip, prefix, failures });
    if (clip.hasSubtitle === true && clip.frameworkClass !== 'speech') {
      failures.push(`${prefix} has subtitle but frameworkClass=${clip.frameworkClass}; expected speech`);
    }
    if (clip.hasSubtitle === false && clip.frameworkClass === 'speech') {
      failures.push(`${prefix} has no subtitle but frameworkClass=speech`);
    }
    if (Object.prototype.hasOwnProperty.call(clip, 'materialPatterns')) {
      failures.push(`${prefix}.materialPatterns is forbidden in packet v2; post-lock narration facts must use visualObservation only`);
    }
    if (clip.hasSubtitle === false) {
      validateNarrationVisualEvidence({ clip, prefix, failures });
    }
  }
}

function validatePacketConsumableTextFields({ clip, prefix, failures }) {
  const fields = [
    ['eventTitle', clip.eventTitle],
    ['description', clip.description],
    ['visualObservation', clip.visualObservation],
    ['subtitleText', clip.subtitleText],
    ['subtitleSummary', clip.subtitleSummary],
    ['chronologyContext.title', clip.chronologyContext?.title],
    ['chronologyContext.location', clip.chronologyContext?.location],
    ['chronologyContext.route', clip.chronologyContext?.route],
    ['geoContext.label', clip.geoContext?.label],
    ['geoContext.rawLocationText', clip.geoContext?.rawLocationText],
    ['geoContext.terrain', clip.geoContext?.terrain],
  ];
  for (const [field, value] of fields) {
    if (containsMojibakeText(value)) {
      failures.push(`${prefix}.${field} contains mojibake or replacement characters; Resolve display labels must not be consumed as narration facts`);
    }
  }
  for (let index = 0; index < (clip.subtitleOverlaps ?? []).length; index += 1) {
    if (containsMojibakeText(clip.subtitleOverlaps[index]?.text)) {
      failures.push(`${prefix}.subtitleOverlaps[${index}].text contains mojibake or replacement characters`);
    }
  }
}

function validateNoMojibakeText(label, text, failures) {
  if (containsMojibakeText(text)) {
    failures.push(`${label} contains mojibake or replacement characters`);
  }
}

function validateNarrationVisualEvidence({ clip, prefix, failures }) {
  const evidence = clip.narrationVisualEvidence;
  if (!isPlainObject(evidence)) {
    failures.push(`${prefix}.narrationVisualEvidence must be present for no-subtitle clips`);
    return;
  }
  if (typeof evidence.visualObservation !== 'string' || !evidence.visualObservation.trim()) {
    failures.push(`${prefix}.narrationVisualEvidence.visualObservation must be a non-empty string`);
  }
  if (typeof evidence.source !== 'string' || !evidence.source.trim()) {
    failures.push(`${prefix}.narrationVisualEvidence.source must be a non-empty string`);
  }
  if (/^(speech|mixed)$/i.test(String(clip.semanticKind || '')) && !NO_SUBTITLE_SPEECH_EVIDENCE_SOURCES.has(evidence.source)) {
    failures.push(`${prefix} is no-subtitle semanticKind=${clip.semanticKind}; narrationVisualEvidence.source must be ${[...NO_SUBTITLE_SPEECH_EVIDENCE_SOURCES].join(' or ')}`);
  }
}

function validateClipMap(clipMap, failures) {
  if (!isPlainObject(clipMap)) {
    failures.push('framework clip-map must be a JSON object');
    return;
  }
  const topLevelKeys = new Set(['schemaVersion', 'format', 'sourcePacket', 'entries', 'packs']);
  for (const key of Object.keys(clipMap)) {
    if (!topLevelKeys.has(key)) failures.push(`clip-map v2 must not contain top-level field "${key}"`);
  }
  if (clipMap.schemaVersion !== VALID_MAP_SCHEMA) {
    failures.push(`clip-map schemaVersion must be ${VALID_MAP_SCHEMA}; got ${String(clipMap.schemaVersion)}`);
  }
  if (clipMap.format !== VALID_FRAMEWORK_FORMAT) {
    failures.push(`clip-map format must be ${VALID_FRAMEWORK_FORMAT}; got ${String(clipMap.format)}`);
  }
  if (clipMap.sourcePacket !== '.tmp/edit-flow/<editId>/postlock/current-timeline-clip-packet.json') {
    failures.push('clip-map sourcePacket must point to the postlock clip packet placeholder path');
  }
  if (!Array.isArray(clipMap.entries) || clipMap.entries.length === 0) {
    failures.push('clip-map must contain a non-empty entries[] array');
    return;
  }
  for (let i = 0; i < clipMap.entries.length; i += 1) {
    const entry = clipMap.entries[i];
    const prefix = `clipMap.entries[${i}]`;
    if (!isPlainObject(entry)) {
      failures.push(`${prefix} must be an object`);
      continue;
    }
    const entryKeys = new Set(['marker', 'clips']);
    for (const key of Object.keys(entry)) {
      if (!entryKeys.has(key)) failures.push(`${prefix} must not contain field "${key}" in clip-map v2`);
    }
    if (!VALID_MARKERS.has(entry.marker)) {
      failures.push(`${prefix}.marker must be one of ${[...VALID_MARKERS].join(', ')}`);
    }
    if (!Array.isArray(entry.clips) || entry.clips.length === 0) {
      failures.push(`${prefix}.clips must be a non-empty array`);
      continue;
    }
    for (const clipIndex of entry.clips) {
      if (!Number.isInteger(clipIndex) || clipIndex <= 0) {
        failures.push(`${prefix}.clips contains invalid clip index: ${String(clipIndex)}`);
      }
    }
  }
  if (!Array.isArray(clipMap.packs) || clipMap.packs.length === 0) {
    failures.push('pack-list framework clip-map must contain non-empty packs[]');
    return;
  }
  const mappedEntryIndices = [];
  for (let i = 0; i < clipMap.packs.length; i += 1) {
    const pack = clipMap.packs[i];
    const prefix = `clipMap.packs[${i}]`;
    if (!isPlainObject(pack)) {
      failures.push(`${prefix} must be an object`);
      continue;
    }
    const packKeys = new Set(['title', 'entries']);
    for (const key of Object.keys(pack)) {
      if (!packKeys.has(key)) failures.push(`${prefix} must not contain field "${key}" in clip-map v2`);
    }
    if (typeof pack.title !== 'string' || pack.title.trim().length === 0) {
      failures.push(`${prefix}.title must be a non-empty string`);
    }
    if (!Array.isArray(pack.entries) || pack.entries.length === 0) {
      failures.push(`${prefix}.entries must be a non-empty array`);
      continue;
    }
    for (const entryIndex of pack.entries) {
      if (!Number.isInteger(entryIndex) || entryIndex <= 0 || entryIndex > clipMap.entries.length) {
        failures.push(`${prefix}.entries contains invalid entry index: ${String(entryIndex)}`);
      } else {
        mappedEntryIndices.push(entryIndex);
      }
    }
  }
  const duplicateEntryIndices = new Set();
  const seenEntryIndices = new Set();
  for (const entryIndex of mappedEntryIndices) {
    if (seenEntryIndices.has(entryIndex)) duplicateEntryIndices.add(entryIndex);
    seenEntryIndices.add(entryIndex);
  }
  for (const entryIndex of duplicateEntryIndices) {
    failures.push(`clip-map pack entries reference entry ${entryIndex} more than once`);
  }
  const missingEntryIndices = [];
  for (let entryIndex = 1; entryIndex <= clipMap.entries.length; entryIndex += 1) {
    if (!seenEntryIndices.has(entryIndex)) missingEntryIndices.push(entryIndex);
  }
  if (missingEntryIndices.length > 0) {
    failures.push(`clip-map packs are missing ${missingEntryIndices.length} entry reference(s): ${previewList(missingEntryIndices)}`);
  }
}

function validateExplicitSpeechMerge({ entryIndex, clipIndices, clips, clipByIndex, failures }) {
  const mappedClips = clipIndices.map(clipIndex => clipByIndex.get(clipIndex)).filter(Boolean);
  const groupIds = new Set(mappedClips.map(clip => clip.frameworkSpeechMergeGroupId).filter(value => typeof value === 'string' && value.trim()));
  if (groupIds.size !== 1 || mappedClips.length !== clipIndices.length) {
    failures.push(`speech entry ${entryIndex} maps multiple clips without one explicit frameworkSpeechMergeGroupId`);
    return;
  }
  const positions = clipIndices.map(clipIndex => clips.findIndex(clip => clip.index === clipIndex)).sort((a, b) => a - b);
  for (let i = 1; i < positions.length; i += 1) {
    if (positions[i] !== positions[i - 1] + 1) {
      failures.push(`speech entry ${entryIndex} maps non-adjacent clips; merged speech clips must be adjacent in packet order`);
      return;
    }
  }
  const reasons = new Set(mappedClips.map(clip => clip.frameworkSpeechMergeReason).filter(Boolean));
  const approvedSummaryOnly = reasons.has('approved-framework-mouth-pack-summary-only');
  if (approvedSummaryOnly) return;
  for (let i = 1; i < mappedClips.length; i += 1) {
    const left = mappedClips[i - 1];
    const right = mappedClips[i];
    if (!hasValidSpeechMergeContinuity(left, right)) {
      failures.push(`speech entry ${entryIndex} merges clipIndex=${left.index} and clipIndex=${right.index} without subtitle-expression continuity`);
    }
  }
  if (reasons.size === 0) {
    failures.push(`speech entry ${entryIndex} merge group is missing frameworkSpeechMergeReason`);
  }
}

function validateExplicitPhotoSequence({ entryIndex, markdownEntry, clipIndices, clips, clipByIndex, failures }) {
  const mappedClips = clipIndices.map(clipIndex => clipByIndex.get(clipIndex)).filter(Boolean);
  if (mappedClips.length !== clipIndices.length || mappedClips.some(clip => !isPhotoFrameworkClip(clip))) {
    failures.push(`visual entry ${entryIndex} maps multiple clips but not all mapped clips are no-subtitle photos`);
    return;
  }
  const positions = clipIndices.map(clipIndex => clips.findIndex(clip => clip.index === clipIndex)).sort((a, b) => a - b);
  for (let i = 1; i < positions.length; i += 1) {
    if (positions[i] !== positions[i - 1] + 1) {
      failures.push(`visual entry ${entryIndex} maps non-adjacent photo clips; merged photo sequences must be adjacent in packet order`);
      return;
    }
  }
  const groupIds = new Set(mappedClips.map(clip => clip.frameworkPhotoSequenceGroupId).filter(value => typeof value === 'string' && value.trim()));
  if (groupIds.size !== 1) {
    failures.push(`visual entry ${entryIndex} maps multiple photo clips without one explicit frameworkPhotoSequenceGroupId`);
  }
  const text = extractEntryInnerText(markdownEntry.text, 'visual');
  if (!/照片|照片序列/u.test(text)) {
    failures.push(`visual entry ${entryIndex} merges photo clips but does not explicitly mark the entry as photos`);
  }
}

function validateExplicitTimelapseSequence({ entryIndex, markdownEntry, clipIndices, clips, clipByIndex, failures }) {
  const mappedClips = clipIndices.map(clipIndex => clipByIndex.get(clipIndex)).filter(Boolean);
  if (mappedClips.length !== clipIndices.length || mappedClips.some(clip => !isTimelapseFrameworkClip(clip))) {
    failures.push(`timelapse entry ${entryIndex} maps multiple clips but not all mapped clips are no-subtitle timelapse clips`);
    return;
  }
  const positions = clipIndices.map(clipIndex => clips.findIndex(clip => clip.index === clipIndex)).sort((a, b) => a - b);
  for (let i = 1; i < positions.length; i += 1) {
    if (positions[i] !== positions[i - 1] + 1) {
      failures.push(`timelapse entry ${entryIndex} maps non-adjacent clips; merged timelapse sequences must be adjacent in packet order`);
      return;
    }
  }
  const groupIds = new Set(mappedClips.map(clip => clip.frameworkTimelapseSequenceGroupId).filter(value => typeof value === 'string' && value.trim()));
  if (groupIds.size !== 1) {
    failures.push(`timelapse entry ${entryIndex} maps multiple timelapse clips without one explicit frameworkTimelapseSequenceGroupId`);
  }
  const eventIds = new Set(mappedClips.map(clip => clip.chronologyContext?.eventId).filter(Boolean));
  if (eventIds.size !== 1) {
    failures.push(`timelapse entry ${entryIndex} must merge clips from one chronology event; got ${eventIds.size || 0}`);
  }
  const text = extractEntryInnerText(markdownEntry.text, 'timelapse');
  if (!/延时序列/u.test(text)) {
    failures.push(`timelapse entry ${entryIndex} merges timelapse clips but does not explicitly mark the entry as 延时序列`);
  }
  validateTimelapseChronologyText({ entryIndex, text, mappedClips, failures });
}

function validateSpeechEntryText({ entryIndex, markdownEntry, clipIndices, clipByIndex, failures }) {
  const text = extractEntryInnerText(markdownEntry.text, 'speech');
  for (const phrase of FORBIDDEN_SPEECH_PHRASES) {
    if (text.includes(phrase)) {
      failures.push(`speech entry ${entryIndex} contains forbidden placeholder "${phrase}"; speech brackets must summarize actual subtitle content`);
    }
  }
  if (text.length > 140) {
    failures.push(`speech entry ${entryIndex} is too long (${text.length} chars); speech brackets should summarize the spoken section, not paste subtitles`);
  }
  if (text.includes(' / ')) {
    failures.push(`speech entry ${entryIndex} looks like a subtitle fragment list; speech brackets must be a concise framework description`);
  }
  if (/^[^：:]{0,100}口播$/u.test(text.replace(/\s+/g, ''))) {
    failures.push(`speech entry ${entryIndex} is an empty shell ("place/event + 口播"); summarize the current subtitle content`);
  }
  const subtitleFragments = clipIndices
    .map(clipIndex => clipByIndex.get(clipIndex))
    .filter(Boolean)
    .flatMap(clip => {
      if (Array.isArray(clip.subtitleOverlaps)) {
        return clip.subtitleOverlaps.map(item => item?.text).filter(Boolean);
      }
      if (typeof clip.subtitleText === 'string') {
        return clip.subtitleText.split(/\s*\/\s*/u);
      }
      return [];
    })
    .map(normalizeComparisonText)
    .filter(fragment => fragment.length >= 4);
  const normalizedText = normalizeComparisonText(text);
  const summaryPart = normalizeComparisonText(text.includes('：') || text.includes(':')
    ? text.split(/[：:]/u).slice(1).join('：')
    : text.replace(/^.*?口播/u, ''));
  if (subtitleFragments.length > 0 && summaryPart.length < 6) {
    failures.push(`speech entry ${entryIndex} does not contain enough subtitle-derived summary detail`);
  }
  const matchedFragments = subtitleFragments.filter(fragment => normalizedText.includes(fragment));
  const matchedCharCount = matchedFragments.reduce((total, fragment) => total + fragment.length, 0);
  const summaryLength = Math.max(1, summaryPart.length);
  const looksLikeBulkPaste = matchedFragments.length >= 5
    || (matchedFragments.length >= 3 && matchedCharCount >= 24)
    || (subtitleFragments.length <= 2 && matchedFragments.length === subtitleFragments.length && matchedCharCount / summaryLength > 0.72 && summaryLength <= 22);
  if (looksLikeBulkPaste) {
    failures.push(`speech entry ${entryIndex} appears to paste subtitle text (${matchedFragments.length} matched subtitle fragment(s)); use a content description instead`);
  }
}

function validateNonSpeechEntryText({ entryIndex, markdownEntry, marker, clipIndices, clipByIndex, failures }) {
  const text = extractEntryInnerText(markdownEntry.text, marker);
  const speechLeakPhrases = [
    '口播',
    '有口播语音',
    '讨论',
    '抱怨',
    '吐槽',
    '对话',
    '声音',
    '提到',
    '说到',
    '说明',
    '介绍',
    '交代',
    '闲聊',
  ];
  const leaked = speechLeakPhrases.filter(phrase => text.includes(phrase));
  if (leaked.length > 0) {
    failures.push(`non-speech entry ${entryIndex} leaks speech-like wording (${leaked.join(', ')}); visual/timelapse/aerial brackets must describe observable picture facts only`);
  }
  const templateHits = FORBIDDEN_VISUAL_TEMPLATE_PHRASES.filter(phrase => text.includes(phrase));
  if (templateHits.length > 0) {
    failures.push(`non-speech entry ${entryIndex} repeats pack-level template wording (${templateHits.join(', ')}); leaf clip descriptions must use clip-specific GPS/visual facts`);
  }
  if (isEnglishHeavyVisualText(text)) {
    failures.push(`non-speech entry ${entryIndex} appears to contain untranslated English visualObservation text; framework visual entries must be written in Chinese`);
  }
  if (isTagListVisualFrameworkText(text)) {
    failures.push(`non-speech entry ${entryIndex} looks like a comma-separated visual tag list; rewrite it as an appendix-style scene/action phrase instead of stacking labels`);
  }
  if (marker === 'timelapse') {
    const mappedClips = clipIndices.map(clipIndex => clipByIndex.get(clipIndex)).filter(Boolean);
    validateTimelapseChronologyText({ entryIndex, text, mappedClips, failures });
  }
}

function isEnglishHeavyVisualText(text) {
  if (/缺少可用视觉观察/u.test(String(text || ''))) return false;
  const words = String(text || '').match(/[A-Za-z][A-Za-z-]{2,}/g) ?? [];
  const meaningful = words.filter(word => !/^(GPS|DJI|MP4|MOV|CINE|LOG)$/i.test(word));
  if (meaningful.length >= 4) return true;
  const cjkCount = (String(text || '').match(/[\u3400-\u9fff]/g) ?? []).length;
  const latinCount = meaningful.join('').length;
  return latinCount >= 24 && latinCount > cjkCount;
}

function isTagListVisualFrameworkText(text) {
  const clean = String(text || '').trim();
  if (!clean || /缺少可用视觉观察/u.test(clean)) return false;
  const parts = clean
    .split(/[，,、]/u)
    .map(part => sanitizeListPart(part))
    .filter(Boolean)
    .filter(part => !/^(开车|画面|航拍|延时|延时序列|照片序列|\d+张|照片集|普通视觉素材)$/u.test(part));
  const evidenceParts = parts.filter(part => !looksLikeRouteOrPlaceTail(part));
  if (evidenceParts.length < 5) return false;
  const stockTagParts = evidenceParts.filter(isStockVisualTagPart);
  const naturalParts = evidenceParts.filter(part => hasAppendixStyleActionCue(part) && !isStockVisualTagPart(part));
  return stockTagParts.length >= 5
    && stockTagParts.length / Math.max(1, evidenceParts.length) >= 0.58
    && naturalParts.length <= 1;
}

function sanitizeListPart(value) {
  return String(value || '')
    .replace(/[【】《》{}（）()]/g, '')
    .replace(/\s+/g, '')
    .trim();
}

function looksLikeRouteOrPlaceTail(part) {
  return /→|->|－|—/u.test(part) || part.length >= 18;
}

function isStockVisualTagPart(part) {
  const text = String(part || '');
  if (!text) return false;
  if (STOCK_VISUAL_TAGS.has(text)) return true;
  if (hasAppendixStyleActionCue(text)) return false;
  return text.length <= 10 && /路|道|桥|车流|山|峰|林|村|田|河|水|云|雾|雨|雪|光|夜|收费|隧道|护栏|人物|停车|风机|草|湖|冰|高空|建筑|植被|路牌|场景|灯/u.test(text);
}

function hasAppendixStyleActionCue(part) {
  return /从|前往|出发|离开|到达|抵达|穿过|穿越|驶入|驶出|行驶|经过|路过|绕过|转入|沿着|继续|一路|终于|遇到|下起|出现|看见|看到|显出|变成|铺开|压过|贴近|贴着|贴住|罩住|串起|连在|带出|回到|准备|展开|拉开|拉长|接入|掠过|越过|展示|上升|拉升|平移|记录|走在|走上|站在|下坡|上坡|转弯|停车|返程|返回/u.test(String(part || ''));
}

function hasValidSpeechMergeContinuity(left, right) {
  const gapFrames = Number(right.timelineStartFrame) - Number(left.timelineEndFrame);
  if (!Number.isFinite(gapFrames) || gapFrames < -1 || gapFrames > 4) return false;
  const sameEvent = sameSpeechEvent(left, right);
  const contextCompatible = sameEvent || !hasSpeechEventConflict(left, right);
  if (sameEvent) {
    if (hasSharedSubtitleFragment(left, right)) return true;
    if (sameEventSpeechContinuityReason(left, right)) return true;
  }
  if (!contextCompatible) return false;
  if (hasSharedSubtitleFragment(left, right)) return true;
  const topicScore = speechTopicContinuityScore(left, right);
  if (topicScore >= 0.46 && startsWithContinuationCue(right)) return true;
  return topicScore >= 0.62 && gapFrames <= 2;
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
  return normalizeComparisonText(String(clip?.eventTitle || clip?.chronologyContext?.title || '').replace(/口播$/u, ''));
}

function sameEventSpeechContinuityReason(left, right) {
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

  const leftWeak = isWeakSpeechOnly(leftClauses);
  const rightWeak = isWeakSpeechOnly(rightClauses);
  if (leftWeak !== rightWeak) return 'same-event-brief-reaction';
  if (isShortSituationalSpeech(leftClauses) || isShortSituationalSpeech(rightClauses)) return 'same-event-short-situational';
  return '';
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
  return common.length / Math.min(leftTokens.size, rightTokens.size);
}

function startsWithContinuationCue(clip) {
  const first = uniqueSubtitleClauses(subtitleTextsForClip(clip))[0] || '';
  return /^(然后|但是|但|不过|而且|所以|因为|只不过|这边|那边|它|这个|那个|还有|也|就|要|现在|最后|虽然)/u.test(first);
}

function extractSpeechTopicTokens(texts) {
  const tokens = [];
  for (const clause of uniqueSubtitleClauses(texts)) {
    const normalized = normalizeComparisonText(clause)
      .replace(/现在|然后|因为|所以|还是|就是|感觉|非常|这个|那个|我们|它|这里|那里|一种|一点|已经|没有|时候|上次|这次|可以|好像|其实|起来/g, '');
    for (let size = 2; size <= 3; size += 1) {
      for (let index = 0; index <= normalized.length - size; index += 1) {
        const token = normalized.slice(index, index + size);
        if (!/^[\u3400-\u9fff]+$/u.test(token) || isGenericSpeechToken(token)) continue;
        if (!tokens.includes(token)) tokens.push(token);
        if (tokens.length >= 16) return tokens;
      }
    }
  }
  return tokens;
}

function uniqueSubtitleClauses(texts) {
  const seen = new Set();
  const result = [];
  for (const text of texts) {
    for (const rawClause of String(text || '').split(/\s*\/\s*|[。！？!?；;]/u)) {
      const clause = String(rawClause || '').replace(/\r?\n/g, ' ').trim();
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

function isPhotoFrameworkClip(clip) {
  return Boolean(
    clip
    && clip.hasSubtitle !== true
    && clip.frameworkClass === 'visual'
    && clip.contentKind === 'photo'
  );
}

function isTimelapseFrameworkClip(clip) {
  return Boolean(
    clip
    && clip.hasSubtitle !== true
    && clip.frameworkClass === 'timelapse'
    && clip.contentKind === 'timelapse'
  );
}

function validateTimelapseChronologyText({ entryIndex, text, mappedClips, failures }) {
  if (mappedClips.length === 0 || mappedClips.some(clip => !clip?.chronologyContext?.eventId)) {
    failures.push(`timelapse entry ${entryIndex} is missing chronologyContext; timelapse framework text must be based on chronology`);
    return;
  }
  const normalizedText = normalizeComparisonText(text);
  const candidates = [];
  for (const clip of mappedClips) {
    const context = clip.chronologyContext;
    candidates.push(context.title);
    candidates.push(shortLocationLabel(context.location));
    candidates.push(context.route);
  }
  const tokens = [...new Set(candidates
    .map(value => normalizeComparisonText(value))
    .filter(value => value.length >= 2))];
  if (tokens.length > 0 && !tokens.some(token => normalizedText.includes(token) || token.includes(normalizedText))) {
    failures.push(`timelapse entry ${entryIndex} does not include its chronology event/location context`);
  }
}

function shortLocationLabel(value) {
  const clean = String(value || '').replace(/\s+/g, ' ').trim();
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
    return parent && parent !== last ? `${parent} · ${last}` : last;
  }
  const commaParts = clean.split(/[，,]/u).map(part => part.trim()).filter(Boolean);
  if (commaParts.length >= 2) return commaParts.slice(-2).join('，');
  return clean;
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

function isGenericSpeechToken(value) {
  return /^(这个|那个|现在|然后|因为|所以|还是|就是|感觉|非常|一点|一种|这里|那里|上次|这次|时候|没有|可以|好像|其实|起来|看到|提到|说明|交代|描述|记录|表达|评价|口播|沿途|现场|感受|风光|待人工复核|信息待复核|现场口播片段)$/.test(String(value || ''));
}

function extractEntryInnerText(text, marker) {
  const raw = String(text || '').trim();
  if (marker === 'speech' && raw.startsWith('（') && raw.endsWith('）')) return raw.slice(1, -1);
  if (marker === 'visual' && raw.startsWith('【') && raw.endsWith('】')) return raw.slice(1, -1);
  if (marker === 'aerial' && raw.startsWith('《') && raw.endsWith('》')) return raw.slice(1, -1);
  if (marker === 'timelapse' && raw.startsWith('{') && raw.endsWith('}')) return raw.slice(1, -1);
  return raw;
}

function normalizeComparisonText(value) {
  return String(value || '')
    .replace(/[^\p{Letter}\p{Number}\u3400-\u9fff]+/gu, '')
    .trim();
}

function containsMojibakeText(value) {
  const text = String(value ?? '');
  if (!text) return false;
  if (text.includes('\uFFFD')) return true;
  if (/[ÃÂ][\u0080-\u00ff]|â[\u0080-\u00ff]/u.test(text)) return true;
  const latinRuns = text.match(/[A-Za-zÀ-ÿ]{8,}/g) ?? [];
  return latinRuns.some(run => /[À-ÿ]/u.test(run));
}

function parseFrameworkEntries(text, failures) {
  const lines = text.split(/\r?\n/u);
  const hasPackList = lines.some(line => /^\s*\d+\.\s+(口播|行车|航拍|照片序列|延时|延时序列|视觉|普通视觉)(\s|｜|$)/u.test(line));
  if (hasPackList) return parsePackListFrameworkEntries(lines, failures);
  return parseLegacyBracketFrameworkEntries(lines, failures);
}

function validatePackMapAlignment(frameworkText, clipMap, failures) {
  if (clipMap?.format !== VALID_FRAMEWORK_FORMAT) return;
  const markdownPacks = extractPackListPacks(frameworkText);
  const mapPacks = Array.isArray(clipMap.packs) ? clipMap.packs : [];
  if (markdownPacks.length !== mapPacks.length) {
    failures.push(`framework pack count (${markdownPacks.length}) must equal clip-map pack count (${mapPacks.length})`);
    return;
  }
  for (let i = 0; i < markdownPacks.length; i += 1) {
    const markdownPack = markdownPacks[i];
    const mapPack = mapPacks[i];
    if (String(mapPack.title || '').trim() !== markdownPack.title) {
      failures.push(`clip-map pack ${markdownPack.packIndex} title mismatch: markdown=${markdownPack.title}, clip-map=${String(mapPack.title || '').trim()}`);
    }
    if (!Array.isArray(mapPack.entries) || mapPack.entries.length !== markdownPack.entryCount) {
      failures.push(`clip-map pack ${markdownPack.packIndex} entry count mismatch: markdown=${markdownPack.entryCount}, clip-map=${Array.isArray(mapPack.entries) ? mapPack.entries.length : 'missing'}`);
    }
  }
}

function extractPackListPacks(frameworkText) {
  const packs = [];
  let inBody = false;
  let currentPack = null;
  for (const line of String(frameworkText || '').split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.includes('下面是粗剪时间线正文')) {
      inBody = true;
      continue;
    }
    if (!inBody) continue;
    if (trimmed.startsWith('## 人工审查点')) break;
    const match = trimmed.match(/^(\d+)\.\s+(.+)$/u);
    if (match) {
      currentPack = {
        packIndex: Number(match[1]),
        title: sanitizeFrameworkListText(match[2]),
        entryCount: 0,
      };
      packs.push(currentPack);
      continue;
    }
    if (!currentPack) continue;
    if (/^-\s*clips：\s*\S+/u.test(trimmed) || /^-\s*[^｜|]+[｜|]\s*.+$/u.test(trimmed)) {
      currentPack.entryCount += 1;
    }
  }
  return packs;
}

function parsePackListFrameworkEntries(lines, failures) {
  const entries = [];
  let inBody = false;
  let inReview = false;
  let currentPack = null;
  let inClips = false;

  for (let i = 0; i < lines.length; i += 1) {
    const lineNumber = i + 1;
    const trimmed = lines[i].trim();
    if (trimmed.includes('下面是粗剪时间线正文')) {
      inBody = true;
      continue;
    }
    if (!inBody) continue;
    if (trimmed.startsWith('## 人工审查点')) {
      inReview = true;
      continue;
    }
    if (inReview || trimmed.length === 0) continue;

    if (/^#{1,6}\s/u.test(trimmed)) {
      failures.push(`line ${lineNumber}: narration framework body must not introduce markdown headings such as DAY/event sections`);
      continue;
    }
    for (const phrase of FORBIDDEN_BODY_PHRASES) {
      if (trimmed.includes(phrase)) {
        failures.push(`line ${lineNumber}: narration framework body contains forbidden process/report phrase "${phrase}"`);
      }
    }

    const packMatch = trimmed.match(/^(\d+)\.\s+(.+)$/u);
    if (packMatch) {
      const expectedPackIndex = entries.length === 0 && !currentPack ? 1 : null;
      if (currentPack && currentPack.entryCountAtStart === entries.length) {
        failures.push(`pack starting line ${currentPack.lineNumber} has no parsed clip entry`);
      }
      const title = sanitizeFrameworkListText(packMatch[2]);
      const marker = markerFromPackTitle(title);
      if (!marker) {
        failures.push(`line ${lineNumber}: pack title must start with a known type prefix: ${title}`);
      }
      if (/[（）【】《》{}]/u.test(title)) {
        failures.push(`line ${lineNumber}: pack-list title must not use legacy bracket wrappers`);
      }
      currentPack = {
        lineNumber,
        title,
        marker: marker || 'visual',
        summary: '',
        hasClips: false,
        entryCountAtStart: entries.length,
      };
      inClips = false;
      if (expectedPackIndex && Number(packMatch[1]) !== expectedPackIndex) {
        failures.push(`line ${lineNumber}: first pack index must be 1`);
      }
      continue;
    }

    if (!currentPack) {
      failures.push(`line ${lineNumber}: timeline body line must belong to a numbered pack item: ${trimmed}`);
      continue;
    }

    const summaryMatch = trimmed.match(/^-\s*(摘要|整体)：\s*(.+)$/u);
    if (summaryMatch) {
      currentPack.summary = sanitizeFrameworkListText(summaryMatch[2]);
      inClips = false;
      continue;
    }

    const clipsMatch = trimmed.match(/^-\s*clips：\s*(.*)$/u);
    if (clipsMatch) {
      currentPack.hasClips = true;
      inClips = true;
      const inlineClips = sanitizeFrameworkListText(clipsMatch[1]);
      if (inlineClips) {
        entries.push({
          entryIndex: entries.length + 1,
          marker: currentPack.marker,
          lineNumber,
          text: packEntryText(currentPack),
          packTitle: currentPack.title,
          clipLabel: inlineClips,
        });
      }
      continue;
    }

    const childMatch = trimmed.match(/^-\s*([^｜|]+)[｜|]\s*(.+)$/u);
    if (inClips && childMatch) {
      const description = sanitizeFrameworkListText(childMatch[2]);
      const childMarker = markerFromDescription(description) || currentPack.marker;
      entries.push({
        entryIndex: entries.length + 1,
        marker: childMarker,
        lineNumber,
        text: description,
        packTitle: currentPack.title,
        clipLabel: sanitizeFrameworkListText(childMatch[1]),
      });
      continue;
    }

    failures.push(`line ${lineNumber}: unrecognized pack-list body line: ${trimmed}`);
  }

  if (!inBody) {
    failures.push('narration framework must include "下面是粗剪时间线正文：" before pack entries');
  }
  if (currentPack && currentPack.entryCountAtStart === entries.length) {
    failures.push(`pack starting line ${currentPack.lineNumber} has no parsed clip entry`);
  }
  if (entries.length === 0) {
    failures.push('narration framework body contains no pack-list clip entries');
  }
  return entries;
}

function parseLegacyBracketFrameworkEntries(lines, failures) {
  const entries = [];
  let inBody = false;
  let inReview = false;

  for (let i = 0; i < lines.length; i += 1) {
    const lineNumber = i + 1;
    const trimmed = lines[i].trim();
    if (trimmed.includes('下面是粗剪时间线正文')) {
      inBody = true;
      continue;
    }
    if (!inBody) continue;
    if (trimmed.startsWith('## 人工审查点')) {
      inReview = true;
      continue;
    }
    if (inReview || trimmed.length === 0) continue;

    if (/^#{1,6}\s/u.test(trimmed)) {
      failures.push(`line ${lineNumber}: narration framework body must not introduce markdown headings such as DAY/event sections`);
      continue;
    }
    for (const phrase of FORBIDDEN_BODY_PHRASES) {
      if (trimmed.includes(phrase)) {
        failures.push(`line ${lineNumber}: narration framework body contains forbidden process/report phrase "${phrase}"`);
      }
    }

    const marker = MARKER_FROM_OPEN.get(trimmed[0]);
    if (!marker) {
      failures.push(`line ${lineNumber}: timeline body line must be one bracket item: ${trimmed}`);
      continue;
    }
    if (!hasMatchingClose(trimmed, marker)) {
      failures.push(`line ${lineNumber}: malformed ${marker} bracket item`);
      continue;
    }
    entries.push({
      entryIndex: entries.length + 1,
      marker,
      lineNumber,
      text: trimmed,
    });
  }

  if (!inBody) {
    failures.push('narration framework must include "下面是粗剪时间线正文：" before bracket entries');
  }
  if (entries.length === 0) {
    failures.push('narration framework body contains no bracket entries');
  }
  return entries;
}

function markerFromPackTitle(title) {
  const text = String(title || '').trim();
  if (/^口播/u.test(text)) return 'speech';
  if (/^航拍/u.test(text)) return 'aerial';
  if (/^延时/u.test(text)) return 'timelapse';
  if (/^(行车|视觉|普通视觉|照片序列|照片|画面)/u.test(text)) return 'visual';
  return '';
}

function markerFromDescription(description) {
  const text = String(description || '').trim();
  if (/^航拍/u.test(text)) return 'aerial';
  if (/^延时/u.test(text)) return 'timelapse';
  return '';
}

function packEntryText(pack) {
  return sanitizeFrameworkListText(`${pack.title}：${pack.summary || pack.title}`);
}

function sanitizeFrameworkListText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function hasMatchingClose(text, marker) {
  if (marker === 'speech') return text.endsWith('）');
  if (marker === 'visual') return text.endsWith('】');
  if (marker === 'aerial') return text.endsWith('》');
  if (marker === 'timelapse') return text.endsWith('}');
  return false;
}

function parseArgs(rawArgs) {
  const parsed = {};
  const positional = [];
  for (let i = 0; i < rawArgs.length; i += 1) {
    const arg = rawArgs[i];
    if (arg === '--packet') {
      parsed.packet = rawArgs[++i];
      continue;
    }
    if (arg === '--framework') {
      parsed.framework = rawArgs[++i];
      continue;
    }
    if (arg === '--map') {
      parsed.map = rawArgs[++i];
      continue;
    }
    if (arg === '-h' || arg === '--help') {
      usage();
      process.exit(0);
    }
    positional.push(arg);
  }
  parsed.projectRoot = positional[0];
  parsed.editId = positional[1] ?? 'main';
  return parsed;
}

function usage() {
  console.error('Usage: node scripts/validate-postlock-narration-framework.mjs <projectRoot> [editId] [--packet path] [--framework path] [--map path]');
}

async function readJson(path, label, failures) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  }
  catch (error) {
    failures.push(`failed to read ${label} at ${path}: ${error.message}`);
    return null;
  }
}

async function readText(path, label, failures) {
  try {
    return await readFile(path, 'utf8');
  }
  catch (error) {
    failures.push(`failed to read ${label} at ${path}: ${error.message}`);
    return null;
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function previewList(values) {
  const unique = [...new Set(values)];
  const preview = unique.slice(0, 12).join(', ');
  return unique.length > 12 ? `${preview}, ...` : preview;
}
