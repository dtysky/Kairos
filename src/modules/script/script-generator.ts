import { randomUUID } from 'node:crypto';
import type {
  IKtepBeatUtterance,
  IKtepScript,
  IKtepScriptSelection,
  IKtepScriptBeat,
  IStyleProfile,
} from '../../protocol/schema.js';
import type { ILlmClient } from '../llm/client.js';
import type { IOutlineBeat, IOutlineSegment } from './outline-builder.js';

const CSYSTEM = `你是一个旅拍纪录片脚本创作者。根据给定的叙事骨架、风格档案和切片证据，为每个段落撰写旁白文案。

要求：
1. 严格遵循风格档案中的人称、语气、句式和情绪表达方式
2. 严格遵守风格禁区，禁区中列出的表达方式绝对不要使用
3. 段落长度与目标时长匹配
4. 正式编排单元是 beats，不是把一整段 narration 事后切字幕
5. 每个段落必须返回 beats 数组；每个 beat 至少包含 id, text, selections, linkedSliceIds
6. 如果一个 beat 内本来就有多段配音和明确停顿，可额外返回 utterances: [{ text, pauseBeforeMs?, pauseAfterMs? }]；没有显式 pause 时可省略
7. 每个 beat 应只绑定 1 到若干条真正要使用的 selections，必要时可以只取候选 slice 内的一小段
8. actions 可包含 speed, preserveNatSound, muteSource, transitionHint, holdMs
8a. 如果候选切片里带有明确口播/人物原声 transcript，且这段话本身值得直接进入正片，优先保留原声并设置 preserveNatSound=true
8b. 对于 preserveNatSound=true 的 beat，text 应尽量贴近要保留的原话或其可读字幕版本，不要再额外改写成旁白
8c. 如果一个带语音的素材主要承担 intro、transition、铺垫、空间建立或情绪过门画面，而不打算直接使用它的原话，就不要因为它有 transcript 就保留原声；这类 beat 应优先设置 muteSource=true，并把 text 正常写成旁白
8d. 如果候选 beat 标出了速度候选（例如 2x/5x/10x），只有在你明确想做速度蒙太奇时才填写 actions.speed；不要靠把 source 裁得很短或默认慢放去贴时长
9. narration 是整段的聚合预览，可选；若提供，应与 beats 内容一致
10. 返回 JSON 数组，每个元素包含 id, role, title, narration, targetDurationMs, actions, selections, linkedSliceIds, beats`;

export async function generateScript(
  llm: ILlmClient,
  outline: IOutlineSegment[],
  style: IStyleProfile,
): Promise<IKtepScript[]> {
  const styleText = buildStylePrompt(style);
  const outlineText = buildOutlinePrompt(outline);

  const raw = await llm.chat([
    { role: 'system', content: CSYSTEM },
    { role: 'user', content: `## 风格档案\n\n${styleText}\n\n## 叙事骨架\n\n${outlineText}` },
  ], { jsonMode: true, temperature: 0.7, maxTokens: 4000 });

  const parsed = JSON.parse(raw);
  const segments: IKtepScript[] = (Array.isArray(parsed) ? parsed : parsed.segments ?? [])
    .map((s: any, i: number) => {
      const fallbackSelections = outline[i]?.selections ?? [];
      const fallbackBeats = outline[i]?.beats ?? [];
      const beats = normalizeBeats(
        s.beats,
        fallbackBeats,
        s.narration ?? s.text,
        s.targetDurationMs ?? outline[i]?.estimatedDurationMs,
      );
      const selections = normalizeSelections(
        s.selections,
        beats.length > 0 ? flattenBeatSelections(beats) : fallbackSelections,
      );
      const normalizedSelections = selections.length > 0
        ? selections
        : flattenBeatSelections(beats);
      const linkedSliceIds = takeLinkedSliceIds(
        s.linkedSliceIds,
        normalizedSelections,
        outline[i]?.sliceIds ?? [],
      );
      return {
        id: s.id ?? randomUUID(),
        role: s.role ?? outline[i]?.role ?? 'scene',
        title: s.title ?? outline[i]?.title,
        narration: normalizeNarration(s.narration ?? s.text, beats),
        targetDurationMs: s.targetDurationMs ?? outline[i]?.estimatedDurationMs,
        actions: normalizeActions(s.actions),
        selections: normalizedSelections.length > 0 ? normalizedSelections : undefined,
        linkedSliceIds,
        beats,
        notes: s.notes,
      };
    });

  return segments;
}

export function buildStylePrompt(style: IStyleProfile): string {
  // If rawReference exists, use it directly — it's the richest source
  if (style.rawReference) {
    const parts = [style.rawReference];
    if (style.antiPatterns?.length) {
      parts.push(`\n### 风格禁区（绝对不要使用）\n${style.antiPatterns.map((p, i) => `${i + 1}. ${p}`).join('\n')}`);
    }
    return parts.join('\n');
  }

  // Fallback: build from structured fields
  const parts: string[] = [
    `人称: ${style.voice.person === '1st' ? '第一人称' : style.voice.person === '2nd' ? '第二人称' : '第三人称'}`,
    `语气: ${style.voice.tone}`,
    `旁白密度: ${style.voice.density}`,
    `节奏: ${style.narrative.pacePattern}`,
  ];

  if (style.voice.sampleTexts.length > 0) {
    parts.push(`示例文案:\n${style.voice.sampleTexts.map(t => `  > ${t}`).join('\n')}`);
  }

  if (style.sections?.length) {
    for (const sec of style.sections) {
      parts.push(`\n### ${sec.title}\n${sec.content}`);
    }
  }

  if (style.antiPatterns?.length) {
    parts.push(`\n### 风格禁区（绝对不要使用）\n${style.antiPatterns.map((p, i) => `${i + 1}. ${p}`).join('\n')}`);
  }

  if (style.parameters && Object.keys(style.parameters).length > 0) {
    const paramLines = Object.entries(style.parameters)
      .map(([k, v]) => `- ${k}: ${v}`);
    parts.push(`\n### 关键参数\n${paramLines.join('\n')}`);
  }

  return parts.join('\n');
}

export function buildOutlinePrompt(outline: IOutlineSegment[]): string {
  return outline.map((seg, i) => {
    const timeRange = formatTimeRange(seg.context.startMs, seg.context.endMs);
    const repeatedLabels = findRepeatedTokens(seg.context.sliceContexts.map(slice => slice.labels));
    const repeatedPlaceHints = findRepeatedTokens(seg.context.sliceContexts.map(slice => slice.placeHints));
    const beatLines = seg.beats
      .slice(0, 8)
      .map((beat, index) => {
        const beatRange = formatTimeRange(beat.sourceInMs, beat.sourceOutMs);
        const uniqueLabels = beat.labels.filter(label => !repeatedLabels.has(label));
        const uniquePlaceHints = beat.placeHints.filter(place => !repeatedPlaceHints.has(place));
        const details = [
          beat.summary,
          beat.transcript ? `原声: ${beat.transcript}` : '',
          uniqueLabels.length > 0 ? `标签: ${uniqueLabels.join(', ')}` : '',
          uniquePlaceHints.length > 0 ? `地点: ${uniquePlaceHints.join(', ')}` : '',
          beat.speedCandidate
            ? `速度候选: ${beat.speedCandidate.suggestedSpeeds.join('x / ')}x`
            : '',
        ].filter(Boolean).join(' | ');
        return `   - ${index + 1}. ${beat.title} ${beatRange}${details ? ` ${details}` : ''}`;
      })
      .join('\n');

    return `${i + 1}. [${seg.role}] ${seg.title} (${Math.round(seg.estimatedDurationMs / 1000)}s)\n   时间范围: ${timeRange}\n   素材切片: ${seg.sliceIds.length} 个\n   预规划 beats: ${seg.beats.length} 个\n   段落摘要: ${seg.context.summary}\n   输出要求: 先参考预规划 beats，再在每个 beat 中从候选切片里截取真正要用的子区间${beatLines ? `\n${beatLines}` : ''}`;
  }).join('\n');
}

function normalizeSelections(
  rawSelections: unknown,
  fallbackSelections: IKtepScriptSelection[],
): IKtepScriptSelection[] {
  if (!Array.isArray(rawSelections) || rawSelections.length === 0) {
    return fallbackSelections;
  }

  const normalized: IKtepScriptSelection[] = [];
  for (let i = 0; i < rawSelections.length; i++) {
    const raw = rawSelections[i] as any;
    const fallback = fallbackSelections[i] ?? fallbackSelections[0];
    const assetId = raw?.assetId ?? fallback?.assetId;
    if (typeof assetId !== 'string' || assetId.length === 0) continue;
    const normalizedWindow = normalizeSelectionWindow(
      pickOptionalNumber(raw?.sourceInMs, fallback?.sourceInMs),
      pickOptionalNumber(raw?.sourceOutMs, fallback?.sourceOutMs),
      fallback?.sourceInMs,
      fallback?.sourceOutMs,
    );
    normalized.push({
      assetId,
      sliceId: raw?.sliceId ?? fallback?.sliceId,
      sourceInMs: normalizedWindow?.sourceInMs,
      sourceOutMs: normalizedWindow?.sourceOutMs,
      notes: typeof raw?.notes === 'string' ? raw.notes : undefined,
    });
  }

  return normalized.length > 0 ? normalized : fallbackSelections;
}

function normalizeBeats(
  rawBeats: unknown,
  fallbackBeats: IOutlineBeat[],
  rawNarration: unknown,
  targetDurationMs?: number,
): IKtepScriptBeat[] {
  if (!Array.isArray(rawBeats) || rawBeats.length === 0) {
    return buildFallbackBeats(rawNarration, fallbackBeats, targetDurationMs);
  }

  const beats: IKtepScriptBeat[] = [];
  const fallbackTexts = buildFallbackBeatTexts(rawNarration, fallbackBeats, rawBeats.length);

  for (let i = 0; i < rawBeats.length; i++) {
    const rawBeat = rawBeats[i] as any;
    const beatFallback = pickBeatFallback(fallbackBeats, i);
    const beatFallbackSelections = beatFallback ? [beatFallback.selection] : [];
    const selections = normalizeSelections(rawBeat?.selections, beatFallbackSelections);
    const linkedSliceIds = takeLinkedSliceIds(
      rawBeat?.linkedSliceIds,
      selections,
      beatFallbackSelections
        .map(selection => selection.sliceId)
        .filter((sliceId): sliceId is string => typeof sliceId === 'string' && sliceId.length > 0),
    );
    const utterances = normalizeUtterances(rawBeat?.utterances);
    const text = resolveBeatText(
      rawBeat?.text,
      utterances,
      fallbackTexts[i] ?? '',
    );

    if (!text && utterances.length === 0 && selections.length === 0) continue;

    beats.push({
      id: rawBeat?.id ?? beatFallback?.id ?? randomUUID(),
      text,
      ...(utterances.length > 0 && { utterances }),
      targetDurationMs: pickOptionalNumber(rawBeat?.targetDurationMs, beatFallback?.estimatedDurationMs),
      actions: normalizeActions(rawBeat?.actions),
      selections,
      linkedSliceIds,
      notes: typeof rawBeat?.notes === 'string' ? rawBeat.notes : undefined,
    });
  }

  return beats.length > 0 ? beats : buildFallbackBeats(rawNarration, fallbackBeats, targetDurationMs);
}

function buildFallbackBeats(
  rawNarration: unknown,
  fallbackBeats: IOutlineBeat[],
  targetDurationMs?: number,
): IKtepScriptBeat[] {
  if (fallbackBeats.length === 0) return [];

  const beatTexts = buildFallbackBeatTexts(rawNarration, fallbackBeats, fallbackBeats.length);
  const defaultBeatDuration = typeof targetDurationMs === 'number' && fallbackBeats.length > 0
    ? Math.round(targetDurationMs / fallbackBeats.length)
    : undefined;

  return fallbackBeats.map((beat, index) => ({
    id: beat.id,
    text: beatTexts[index] ?? beat.summary ?? '',
    targetDurationMs: beat.estimatedDurationMs ?? defaultBeatDuration,
    selections: [beat.selection],
    linkedSliceIds: typeof beat.sliceId === 'string' ? [beat.sliceId] : [],
  }));
}


function normalizeUtterances(rawUtterances: unknown): IKtepBeatUtterance[] {
  if (!Array.isArray(rawUtterances)) return [];

  const utterances: IKtepBeatUtterance[] = [];
  for (const rawUtterance of rawUtterances) {
    if (!rawUtterance || typeof rawUtterance !== 'object') continue;
    const source = rawUtterance as Record<string, unknown>;
    const text = typeof source.text === 'string' ? source.text.trim() : '';
    if (!text) continue;

    const pauseBeforeMs = pickOptionalNumber(source.pauseBeforeMs);
    const pauseAfterMs = pickOptionalNumber(source.pauseAfterMs);
    utterances.push({
      text,
      ...(pauseBeforeMs != null && { pauseBeforeMs }),
      ...(pauseAfterMs != null && { pauseAfterMs }),
    });
  }

  return utterances;
}

function resolveBeatText(
  rawText: unknown,
  utterances: IKtepBeatUtterance[],
  fallbackText: string,
): string {
  if (typeof rawText === 'string' && rawText.trim().length > 0) {
    return rawText.trim();
  }

  const utteranceText = utterances
    .map(utterance => utterance.text.trim())
    .filter(Boolean)
    .join('');
  if (utteranceText.length > 0) return utteranceText;

  return fallbackText.trim();
}

function flattenBeatSelections(beats: IKtepScriptBeat[]): IKtepScriptSelection[] {
  const seen = new Set<string>();
  const flattened: IKtepScriptSelection[] = [];

  for (const beat of beats) {
    for (const selection of beat.selections) {
      const key = [
        selection.assetId,
        selection.sliceId ?? '',
        selection.sourceInMs ?? '',
        selection.sourceOutMs ?? '',
      ].join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      flattened.push(selection);
    }
  }

  return flattened;
}

function normalizeNarration(
  rawNarration: unknown,
  beats: IKtepScriptBeat[],
): string | undefined {
  if (typeof rawNarration === 'string' && rawNarration.trim().length > 0) {
    return rawNarration.trim();
  }

  const combined = beats
    .map(beat => resolveBeatText(beat.text, beat.utterances ?? [], ''))
    .filter(Boolean)
    .join('');

  return combined.length > 0 ? combined : undefined;
}

function pickBeatFallback(
  fallbackBeats: IOutlineBeat[],
  index: number,
): IOutlineBeat | undefined {
  if (fallbackBeats.length === 0) return undefined;
  if (index < fallbackBeats.length) return fallbackBeats[index];
  return fallbackBeats[fallbackBeats.length - 1];
}

function normalizeActions(rawActions: unknown): IKtepScript['actions'] {
  if (!rawActions || typeof rawActions !== 'object') return undefined;
  const source = rawActions as Record<string, unknown>;
  const speed = pickPositiveNumber(source.speed);
  const holdMs = pickOptionalNumber(source.holdMs);
  const transitionHint = typeof source.transitionHint === 'string'
    ? source.transitionHint
    : undefined;

  const actions: NonNullable<IKtepScript['actions']> = {
    speed,
    preserveNatSound: typeof source.preserveNatSound === 'boolean' ? source.preserveNatSound : undefined,
    muteSource: typeof source.muteSource === 'boolean' ? source.muteSource : undefined,
    transitionHint: isTransitionHint(transitionHint) ? transitionHint : undefined,
    holdMs,
  };

  if (Object.values(actions).every(value => value == null)) return undefined;
  return actions;
}

function takeLinkedSliceIds(
  rawLinkedSliceIds: unknown,
  selections: IKtepScriptSelection[],
  fallbackSliceIds: string[],
): string[] {
  if (Array.isArray(rawLinkedSliceIds) && rawLinkedSliceIds.every(value => typeof value === 'string')) {
    return rawLinkedSliceIds;
  }
  const derived = selections
    .map(selection => selection.sliceId)
    .filter((sliceId): sliceId is string => typeof sliceId === 'string' && sliceId.length > 0);
  return derived.length > 0 ? derived : fallbackSliceIds;
}

function splitNarrationIntoBeats(
  rawNarration: unknown,
  beatCount: number,
): string[] {
  const narration = typeof rawNarration === 'string' ? rawNarration.trim() : '';
  if (!narration) {
    return Array.from({ length: beatCount }, () => '');
  }
  if (beatCount <= 1) return [narration];

  let units = splitWithDelimiters(narration, /([。！？!?])/);
  if (units.length < beatCount) {
    units = splitWithDelimiters(narration, /([。！？!?，,])/);
  }
  if (units.length <= beatCount) {
    const padded = [...units];
    while (padded.length < beatCount) padded.push('');
    return padded;
  }

  const totalLength = units.reduce((sum, unit) => sum + unit.length, 0);
  const targetPerBeat = Math.max(1, Math.ceil(totalLength / beatCount));
  const beats: string[] = [];
  let buffer = '';
  let remainingBeats = beatCount;

  for (let index = 0; index < units.length; index++) {
    const unit = units[index];
    const remainingUnits = units.length - index;
    const shouldFlush =
      buffer.length > 0
      && (
        buffer.length + unit.length > targetPerBeat
        || remainingUnits <= remainingBeats
      );

    if (shouldFlush) {
      beats.push(buffer.trim());
      buffer = '';
      remainingBeats = beatCount - beats.length;
    }

    buffer += unit;
  }

  if (buffer.trim()) {
    beats.push(buffer.trim());
  }

  while (beats.length < beatCount) {
    beats.push('');
  }

  if (beats.length > beatCount) {
    const merged = beats.slice(0, beatCount - 1);
    merged.push(beats.slice(beatCount - 1).join(''));
    return merged;
  }

  return beats;
}

function buildFallbackBeatTexts(
  rawNarration: unknown,
  fallbackBeats: IOutlineBeat[],
  beatCount: number,
): string[] {
  const splitTexts = splitNarrationIntoBeats(rawNarration, beatCount);
  return splitTexts.map((text, index) => {
    if (text.trim().length > 0) return text;
    return fallbackBeats[index]?.transcript
      ?? fallbackBeats[index]?.summary
      ?? fallbackBeats[index]?.title
      ?? '';
  });
}

function splitWithDelimiters(text: string, delimiter: RegExp): string[] {
  const parts = text.split(delimiter);
  const result: string[] = [];

  for (let i = 0; i < parts.length; i += 2) {
    const body = parts[i] ?? '';
    const tail = parts[i + 1] ?? '';
    const combined = `${body}${tail}`.trim();
    if (combined) {
      result.push(combined);
    }
  }

  return result;
}

function normalizeSelectionWindow(
  sourceInMs: number | undefined,
  sourceOutMs: number | undefined,
  fallbackInMs: number | undefined,
  fallbackOutMs: number | undefined,
): Pick<IKtepScriptSelection, 'sourceInMs' | 'sourceOutMs'> | undefined {
  if (typeof sourceInMs !== 'number' || typeof sourceOutMs !== 'number' || sourceOutMs <= sourceInMs) {
    if (typeof fallbackInMs === 'number' || typeof fallbackOutMs === 'number') {
      return {
        sourceInMs: fallbackInMs,
        sourceOutMs: fallbackOutMs,
      };
    }
    return {
      sourceInMs,
      sourceOutMs,
    };
  }

  let normalizedInMs = sourceInMs;
  let normalizedOutMs = sourceOutMs;
  const hasFallbackWindow = typeof fallbackInMs === 'number' && typeof fallbackOutMs === 'number' && fallbackOutMs > fallbackInMs;
  if (hasFallbackWindow) {
    normalizedInMs = Math.max(fallbackInMs as number, normalizedInMs);
    normalizedOutMs = Math.min(fallbackOutMs as number, normalizedOutMs);
    if (normalizedOutMs <= normalizedInMs) {
      return {
        sourceInMs: fallbackInMs,
        sourceOutMs: fallbackOutMs,
      };
    }

    const fallbackDurationMs = (fallbackOutMs as number) - (fallbackInMs as number);
    const requestedDurationMs = normalizedOutMs - normalizedInMs;
    const minSafeDurationMs = Math.min(
      Math.max(2_500, Math.round(fallbackDurationMs * 0.4)),
      fallbackDurationMs,
    );

    if (fallbackDurationMs >= 4_000 && requestedDurationMs < minSafeDurationMs) {
      const center = normalizedInMs + requestedDurationMs / 2;
      normalizedInMs = Math.round(center - minSafeDurationMs / 2);
      normalizedOutMs = normalizedInMs + minSafeDurationMs;

      if (normalizedInMs < (fallbackInMs as number)) {
        normalizedInMs = fallbackInMs as number;
        normalizedOutMs = normalizedInMs + minSafeDurationMs;
      }
      if (normalizedOutMs > (fallbackOutMs as number)) {
        normalizedOutMs = fallbackOutMs as number;
        normalizedInMs = normalizedOutMs - minSafeDurationMs;
      }
    }
  }

  return {
    sourceInMs: normalizedInMs,
    sourceOutMs: normalizedOutMs,
  };
}

function findRepeatedTokens(tokenGroups: string[][]): Set<string> {
  if (tokenGroups.length <= 1) return new Set();
  const firstGroup = new Set(tokenGroups[0]);
  const repeated = new Set<string>();

  for (const token of firstGroup) {
    if (tokenGroups.every(group => group.includes(token))) {
      repeated.add(token);
    }
  }

  return repeated;
}

function pickOptionalNumber(primary: unknown, fallback?: number): number | undefined {
  if (typeof primary === 'number' && Number.isFinite(primary)) return primary;
  if (typeof fallback === 'number' && Number.isFinite(fallback)) return fallback;
  return undefined;
}

function pickPositiveNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  return undefined;
}

function isTransitionHint(
  value: string | undefined,
): value is NonNullable<NonNullable<IKtepScript['actions']>['transitionHint']> {
  return value === 'cut'
    || value === 'cross-dissolve'
    || value === 'fade'
    || value === 'wipe';
}

function formatTimeRange(startMs?: number, endMs?: number): string {
  if (typeof startMs !== 'number' && typeof endMs !== 'number') return '-';
  const start = formatSeconds(startMs ?? 0);
  const end = formatSeconds(endMs ?? startMs ?? 0);
  return `${start} - ${end}`;
}

function formatSeconds(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}
