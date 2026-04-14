import { randomUUID } from 'node:crypto';
import type {
  IKtepBeatUtterance,
  IKtepScript,
  IKtepScriptBeat,
  IKtepScriptSelection,
  IStyleProfile,
} from '../../protocol/schema.js';
import type { ILlmClient } from '../llm/client.js';
import type { IOutlineBeat, IOutlineSegment } from './outline-builder.js';
import { buildRhythmMaterialPromptLines } from './style-rhythm.js';

const CSYSTEM = `你是一个旅拍纪录片脚本创作者。根据给定的 material overview、段落规划和素材选用结果，为每个段落撰写旁白与 beat。

要求：
1. 严格遵循风格档案中的编排主轴、章节程序和 narrationConstraints。
2. beats 是正式编排单元；每个 segment 必须返回 beats 数组。
3. 每个 beat 至少返回 id, text, selections, linkedSpanIds。
4. 如果候选素材里带有可用 transcriptSegments / 原声边界，默认把该 beat 写成 source-speech，并设置 preserveNatSound=true；不要再额外写解释性旁白。
5. 照片 beat 默认静默：可以保留内部说明文字，但不要写 utterances，不要把照片写成需要字幕或口播的段落。
6. 只有无可用原声的视频，才允许尽可能用 beat.text / utterances 组织旁白。
7. preserveNatSound=true 时不要再给这个 beat 写 speed。
8. speed 只能用于纯 drive / aerial montage。
9. targetDurationMs 是可选审阅提示；除非用户明确要求，否则不要臆造 segment 或 beat 的时长预算。
10. narration 是整段聚合预览，可选，但必须与 beats 内容一致。
11. 允许润色和补充，但不要通过删 beat 来压缩召回结果；如果 outline 已给出 beat，就默认保留这些 beat。
12. 返回 JSON 数组，每个元素包含 id, role, title, narration, targetDurationMs, actions, selections, linkedSpanIds, linkedSliceIds, beats。`;

export interface IScriptGenerationContext {
  materialOverview?: string;
  brief?: {
    goals?: string[];
    constraints?: string[];
    planReviewNotes?: string[];
  };
}

export async function generateScript(
  llm: ILlmClient,
  outline: IOutlineSegment[],
  style: IStyleProfile,
  context?: IScriptGenerationContext,
): Promise<IKtepScript[]> {
  const styleText = buildStylePrompt(style);
  const outlineText = buildOutlinePrompt(outline);
  const contextText = buildGenerationContextPrompt(context);

  const raw = await llm.chat([
    { role: 'system', content: CSYSTEM },
    { role: 'user', content: `${contextText}\n\n## 风格档案\n\n${styleText}\n\n## 段落规划\n\n${outlineText}`.trim() },
  ], { jsonMode: true, temperature: 0.7, maxTokens: 4000 });

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return buildFallbackScript(outline);
  }

  const segments = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as Record<string, unknown>)?.segments)
      ? (parsed as Record<string, unknown>).segments as unknown[]
      : [];

  if (segments.length === 0) {
    return buildFallbackScript(outline);
  }

  return outline.map((segment, index) =>
    normalizeSegment(segments[index], segment),
  );
}

function buildGenerationContextPrompt(context?: IScriptGenerationContext): string {
  const sections: string[] = [];
  const materialOverview = context?.materialOverview?.trim();
  if (materialOverview) {
    sections.push(`## Material Overview\n\n${materialOverview}`);
  }

  const goals = dedupeStrings(context?.brief?.goals ?? []);
  const constraints = dedupeStrings(context?.brief?.constraints ?? []);
  const planReviewNotes = dedupeStrings(context?.brief?.planReviewNotes ?? []);
  if (goals.length > 0 || constraints.length > 0 || planReviewNotes.length > 0) {
    sections.push([
      '## Script Brief',
      goals.length > 0 ? '\n### Goals\n' : '',
      ...goals.map(item => `- ${item}`),
      constraints.length > 0 ? '\n### Constraints\n' : '',
      ...constraints.map(item => `- ${item}`),
      planReviewNotes.length > 0 ? '\n### Plan Review Notes\n' : '',
      ...planReviewNotes.map(item => `- ${item}`),
    ].filter(Boolean).join('\n'));
  }

  return sections.join('\n\n');
}

export function buildStylePrompt(style: IStyleProfile): string {
  const parts: string[] = [
    `人称: ${style.voice.person === '1st' ? '第一人称' : style.voice.person === '2nd' ? '第二人称' : '第三人称'}`,
    `语气: ${style.voice.tone}`,
    `旁白密度: ${style.voice.density}`,
    `节奏: ${style.narrative.pacePattern}`,
    `编排主轴: ${style.arrangementStructure.primaryAxis ?? '未明确'}`,
  ];

  if (style.arrangementStructure.secondaryAxes.length > 0) {
    parts.push(`辅助轴: ${style.arrangementStructure.secondaryAxes.join(' / ')}`);
  }
  if (style.arrangementStructure.chapterSplitPrinciples.length > 0) {
    parts.push(`章节切分原则: ${style.arrangementStructure.chapterSplitPrinciples.join(' / ')}`);
  }
  if (style.arrangementStructure.chapterTransitionNotes.length > 0) {
    parts.push(`章节转场备注: ${style.arrangementStructure.chapterTransitionNotes.join(' / ')}`);
  }
  if (style.arrangementStructure.chapterPrograms.length > 0) {
    parts.push('\n### 章节程序');
    for (const program of style.arrangementStructure.chapterPrograms.slice(0, 8)) {
      parts.push(`- ${program.type}: ${program.intent} | materialRoles=${program.materialRoles.join('/') || '-'} | promotionSignals=${program.promotionSignals.join('/') || '-'} | transitionBias=${program.transitionBias}`);
      if (program.localNarrationNote) {
        parts.push(`  narrationNote=${program.localNarrationNote}`);
      }
    }
  }

  const rhythmLines = buildRhythmMaterialPromptLines(style, {
    sectionHeading: '节奏与素材编排：',
    parameterHeading: '节奏参数：',
    antiPatternHeading: '节奏禁区：',
    maxSectionLength: 220,
  });
  if (rhythmLines.length > 0) {
    parts.push(...rhythmLines);
  }

  parts.push('\n### Narration Constraints');
  if (style.narrationConstraints.perspective) {
    parts.push(`- perspective: ${style.narrationConstraints.perspective}`);
  }
  if (style.narrationConstraints.tone) {
    parts.push(`- tone: ${style.narrationConstraints.tone}`);
  }
  if (style.narrationConstraints.informationDensity) {
    parts.push(`- informationDensity: ${style.narrationConstraints.informationDensity}`);
  }
  if (style.narrationConstraints.explanationBias) {
    parts.push(`- explanationBias: ${style.narrationConstraints.explanationBias}`);
  }
  for (const item of style.narrationConstraints.notes) {
    parts.push(`- note: ${item}`);
  }
  for (const item of style.narrationConstraints.forbiddenPatterns) {
    parts.push(`- forbidden: ${item}`);
  }

  if (style.voice.sampleTexts.length > 0) {
    parts.push('\n### 示例文案');
    parts.push(...style.voice.sampleTexts.map(text => `- ${text}`));
  }

  if (style.antiPatterns?.length) {
    parts.push('\n### 风格禁区');
    parts.push(...style.antiPatterns.map(item => `- ${item}`));
  }

  if (style.sections?.length) {
    parts.push('\n### 解释性补充');
    for (const section of style.sections.slice(0, 4)) {
      parts.push(`- ${section.title}: ${section.content.slice(0, 180)}`);
    }
  }

  return parts.join('\n').trim();
}

export function buildOutlinePrompt(outline: IOutlineSegment[]): string {
  return outline.map((segment, index) => {
    const beatLines = segment.beats
      .map((beat, beatIndex) => {
        const details = [
          beat.summary,
          beat.transcript ? `原声: ${beat.transcript}` : '',
          beat.materialPatterns.length > 0 ? `材料模式: ${beat.materialPatterns.join(', ')}` : '',
          beat.locations.length > 0 ? `地点: ${beat.locations.join(', ')}` : '',
          beat.sourceSpeechDecision ? `原声建议: ${beat.sourceSpeechDecision}` : '',
          beat.speedCandidate
            ? `速度候选: ${beat.speedCandidate.suggestedSpeeds.join('x / ')}x`
            : '',
        ].filter(Boolean).join(' | ');
        return `   - ${beatIndex + 1}. ${beat.title}${details ? ` | ${details}` : ''}`;
      })
      .join('\n');

    return [
      `${index + 1}. [${segment.role}] ${segment.title}`,
      `   段落意图: ${segment.narrativeSketch}`,
      `   备注: ${segment.notes.join(' / ') || '无'}`,
      `   已选 spans: ${segment.spanIds.length}`,
      `   beats: ${segment.beats.length}`,
      beatLines,
    ].filter(Boolean).join('\n');
  }).join('\n');
}

function normalizeSegment(raw: unknown, fallback: IOutlineSegment): IKtepScript {
  const source = typeof raw === 'object' && raw ? raw as Record<string, unknown> : {};
  const beats = normalizeBeats(source.beats, fallback.beats);
  const selections = normalizeSelections(source.selections, fallback.selections);
  const linkedSpanIds = dedupeStrings([
    ...normalizeStringArray(source.linkedSpanIds),
    ...beats.flatMap(beat => beat.linkedSpanIds),
    ...fallback.spanIds,
  ]);
  const linkedSliceIds = dedupeStrings([
    ...normalizeStringArray(source.linkedSliceIds),
    ...linkedSpanIds,
  ]);

  return {
    id: stringValue(source.id) ?? fallback.id,
    role: normalizeRole(stringValue(source.role), fallback.role),
    title: stringValue(source.title) ?? fallback.title,
    narration: stringValue(source.narration) ?? mergeBeatNarration(beats),
    targetDurationMs: positiveNumber(source.targetDurationMs),
    actions: normalizeActions(source.actions),
    selections: selections.length > 0 ? selections : undefined,
    linkedSpanIds,
    linkedSliceIds,
    pharosRefs: mergePharosRefs(selections),
    beats,
    notes: stringValue(source.notes),
  };
}

function normalizeBeats(raw: unknown, fallbackBeats: IOutlineBeat[]): IKtepScriptBeat[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    return fallbackBeats.map(buildFallbackBeat);
  }

  const rawItems = raw
    .map(item => (typeof item === 'object' && item ? item as Record<string, unknown> : {}));
  const rawIndexesById = new Map<string, number[]>();
  rawItems.forEach((item, index) => {
    const id = stringValue(item.id);
    if (!id) return;
    const current = rawIndexesById.get(id) ?? [];
    current.push(index);
    rawIndexesById.set(id, current);
  });

  const usedIndexes = new Set<number>();
  const coveredSpanIds = new Set<string>();
  const beats = fallbackBeats.map((fallback, index) => {
    const matchedIndex = consumeMatchedBeatIndex(fallback.id, index, rawItems, rawIndexesById, usedIndexes);
    const normalized = normalizeBeatRecord(
      matchedIndex != null ? rawItems[matchedIndex] : undefined,
      fallback,
    );
    normalized.linkedSpanIds.forEach(spanId => coveredSpanIds.add(spanId));
    return normalized;
  });

  rawItems.forEach((item, index) => {
    if (usedIndexes.has(index)) return;
    const normalized = normalizeBeatRecord(item);
    const freshSpanIds = normalized.linkedSpanIds.filter(spanId => !coveredSpanIds.has(spanId));
    if (freshSpanIds.length === 0) return;
    const freshSelections = normalized.selections.filter(selection =>
      selection.spanId != null && freshSpanIds.includes(selection.spanId),
    );
    beats.push({
      ...normalized,
      selections: freshSelections.length > 0 ? freshSelections : normalized.selections,
      linkedSpanIds: freshSpanIds,
      linkedSliceIds: dedupeStrings([
        ...normalized.linkedSliceIds,
        ...freshSpanIds,
      ]),
      pharosRefs: mergePharosRefs(freshSelections.length > 0 ? freshSelections : normalized.selections),
    });
    freshSpanIds.forEach(spanId => coveredSpanIds.add(spanId));
  });

  return beats;
}

function consumeMatchedBeatIndex(
  fallbackId: string,
  fallbackIndex: number,
  rawItems: Array<Record<string, unknown>>,
  rawIndexesById: Map<string, number[]>,
  usedIndexes: Set<number>,
): number | null {
  const matchedById = rawIndexesById.get(fallbackId)?.find(index => !usedIndexes.has(index));
  if (matchedById != null) {
    usedIndexes.add(matchedById);
    return matchedById;
  }
  if (!usedIndexes.has(fallbackIndex) && fallbackIndex < rawItems.length) {
    usedIndexes.add(fallbackIndex);
    return fallbackIndex;
  }
  return null;
}

function normalizeBeatRecord(
  source: Record<string, unknown> | undefined,
  fallback?: IOutlineBeat,
): IKtepScriptBeat {
  const safeSource = source ?? {};
  const selections = normalizeSelections(safeSource.selections, fallback?.selections ?? []);
  const linkedSpanIds = dedupeStrings([
    ...normalizeStringArray(safeSource.linkedSpanIds),
    ...selections.map(selection => selection.spanId),
    ...(fallback?.linkedSpanIds ?? []),
  ]);
  const linkedSliceIds = dedupeStrings([
    ...normalizeStringArray(safeSource.linkedSliceIds),
    ...linkedSpanIds,
  ]);
  const utterances = normalizeUtterances(safeSource.utterances);

  return {
    id: stringValue(safeSource.id) ?? fallback?.id ?? randomUUID(),
    text: stringValue(safeSource.text) ?? resolveFallbackBeatText(fallback),
    utterances: utterances.length > 0 ? utterances : undefined,
    targetDurationMs: positiveNumber(safeSource.targetDurationMs),
    actions: normalizeActions(safeSource.actions),
    selections,
    linkedSpanIds,
    linkedSliceIds,
    pharosRefs: mergePharosRefs(selections),
    notes: stringValue(safeSource.notes),
  };
}

function buildFallbackScript(outline: IOutlineSegment[]): IKtepScript[] {
  return outline.map(segment => {
    const beats = segment.beats.map(buildFallbackBeat);
    return {
      id: segment.id,
      role: segment.role,
      title: segment.title,
      narration: mergeBeatNarration(beats),
      targetDurationMs: undefined,
      selections: segment.selections.length > 0 ? segment.selections : undefined,
      linkedSpanIds: segment.spanIds,
      linkedSliceIds: segment.spanIds,
      pharosRefs: mergePharosRefs(segment.selections),
      beats,
      notes: segment.notes.join(' / ') || undefined,
    };
  });
}

function buildFallbackBeat(beat: IOutlineBeat): IKtepScriptBeat {
  return {
    id: beat.id,
    text: resolveFallbackBeatText(beat),
    targetDurationMs: undefined,
    selections: beat.selections,
    linkedSpanIds: beat.linkedSpanIds,
    linkedSliceIds: beat.linkedSpanIds,
    pharosRefs: mergePharosRefs(beat.selections),
    notes: beat.query,
  };
}

function resolveFallbackBeatText(beat: IOutlineBeat | undefined): string {
  const transcript = beat?.transcript?.trim();
  if (transcript) return transcript;
  return '';
}

function normalizeSelections(raw: unknown, fallback: IKtepScriptSelection[]): IKtepScriptSelection[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    return fallback;
  }

  const result: IKtepScriptSelection[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const source = item as Record<string, unknown>;
    const assetId = stringValue(source.assetId);
    if (!assetId) continue;
    result.push({
      assetId,
      spanId: stringValue(source.spanId) ?? stringValue(source.sliceId),
      sliceId: stringValue(source.sliceId) ?? stringValue(source.spanId),
      sourceInMs: positiveNumber(source.sourceInMs),
      sourceOutMs: positiveNumber(source.sourceOutMs),
      notes: stringValue(source.notes),
      pharosRefs: normalizePharosRefs(source.pharosRefs),
    });
  }

  return result.length > 0 ? result : fallback;
}

function normalizeUtterances(raw: unknown): IKtepBeatUtterance[] {
  if (!Array.isArray(raw)) return [];
  const utterances: IKtepBeatUtterance[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const source = item as Record<string, unknown>;
    const text = stringValue(source.text);
    if (!text) continue;
    utterances.push({
      text,
      pauseBeforeMs: positiveNumber(source.pauseBeforeMs),
      pauseAfterMs: positiveNumber(source.pauseAfterMs),
    });
  }
  return utterances;
}

function normalizeActions(raw: unknown): IKtepScript['actions'] | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const source = raw as Record<string, unknown>;
  const speed = positiveNumber(source.speed);
  const holdMs = positiveNumber(source.holdMs);
  const transitionHint = stringValue(source.transitionHint);
  const preserveNatSound = typeof source.preserveNatSound === 'boolean' ? source.preserveNatSound : undefined;
  const muteSource = typeof source.muteSource === 'boolean' ? source.muteSource : undefined;

  if (
    typeof speed !== 'number'
    && typeof holdMs !== 'number'
    && !transitionHint
    && typeof preserveNatSound !== 'boolean'
    && typeof muteSource !== 'boolean'
  ) {
    return undefined;
  }

  return {
    speed,
    holdMs,
    transitionHint: transitionHint === 'cut'
      || transitionHint === 'cross-dissolve'
      || transitionHint === 'fade'
      || transitionHint === 'wipe'
      ? transitionHint
      : undefined,
    preserveNatSound,
    muteSource,
  };
}

function normalizeRole(raw: string | undefined, fallback: IKtepScript['role']): IKtepScript['role'] {
  return raw === 'intro' || raw === 'scene' || raw === 'transition' || raw === 'highlight' || raw === 'outro'
    ? raw
    : fallback;
}

function normalizeStringArray(raw: unknown): string[] {
  return Array.isArray(raw)
    ? raw.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
}

function normalizePharosRefs(raw: unknown): IKtepScriptSelection['pharosRefs'] {
  if (!Array.isArray(raw)) return undefined;
  const refs = raw
    .filter((item): item is { tripId: string; shotId: string } =>
      Boolean(item)
      && typeof item === 'object'
      && typeof (item as { tripId?: unknown }).tripId === 'string'
      && typeof (item as { shotId?: unknown }).shotId === 'string')
    .map(item => ({ tripId: item.tripId, shotId: item.shotId }));
  return refs.length > 0 ? refs : undefined;
}

function mergePharosRefs(selections: IKtepScriptSelection[]): IKtepScript['pharosRefs'] {
  const refs = dedupeStrings(
    selections.flatMap(selection =>
      (selection.pharosRefs ?? []).map(ref => `${ref.tripId}:${ref.shotId}`),
    ),
  ).map(item => {
    const [tripId, shotId] = item.split(':');
    return { tripId, shotId };
  });
  return refs.length > 0 ? refs : undefined;
}

function mergeBeatNarration(beats: IKtepScriptBeat[]): string | undefined {
  const text = beats
    .map(beat => beat.text.trim())
    .filter(Boolean)
    .join(' ');
  return text || undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function dedupeStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.map(value => value?.trim()).filter(Boolean) as string[])];
}
