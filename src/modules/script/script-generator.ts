import { randomUUID } from 'node:crypto';
import type { IKtepScript, IKtepScriptSelection, IStyleProfile } from '../../protocol/schema.js';
import type { ILlmClient } from '../llm/client.js';
import type { IOutlineSegment } from './outline-builder.js';

const CSYSTEM = `你是一个旅拍纪录片脚本创作者。根据给定的叙事骨架、风格档案和切片证据，为每个段落撰写旁白文案。

要求：
1. 严格遵循风格档案中的人称、语气、句式和情绪表达方式
2. 严格遵守风格禁区，禁区中列出的表达方式绝对不要使用
3. 旁白长度与段落时长匹配
4. 每个段落必须从提供的候选切片中选择 1 到若干条，写入 selections
5. actions 可包含 speed, preserveNatSound, muteSource, transitionHint, holdMs
6. 返回 JSON 数组，每个元素包含 id, role, title, narration, targetDurationMs, actions, selections, linkedSliceIds`;

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
      const selections = normalizeSelections(s.selections, fallbackSelections);
      const linkedSliceIds = takeLinkedSliceIds(
        s.linkedSliceIds,
        selections,
        outline[i]?.sliceIds ?? [],
      );
      return {
        id: s.id ?? randomUUID(),
        role: s.role ?? outline[i]?.role ?? 'scene',
        title: s.title ?? outline[i]?.title,
        narration: s.narration ?? s.text ?? '',
        targetDurationMs: s.targetDurationMs ?? outline[i]?.estimatedDurationMs,
        actions: normalizeActions(s.actions),
        selections,
        linkedSliceIds,
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
    const sliceLines = seg.context.sliceContexts
      .slice(0, 8)
      .map((slice, index) => {
        const sliceRange = formatTimeRange(slice.sourceInMs, slice.sourceOutMs);
        const uniqueLabels = slice.labels.filter(label => !repeatedLabels.has(label));
        const uniquePlaceHints = slice.placeHints.filter(place => !repeatedPlaceHints.has(place));
        const details = [
          slice.summary,
          uniqueLabels.length > 0 ? `标签: ${uniqueLabels.join(', ')}` : '',
          uniquePlaceHints.length > 0 ? `地点: ${uniquePlaceHints.join(', ')}` : '',
        ].filter(Boolean).join(' | ');
        return `   - ${index + 1}. ${sliceRange}${details ? ` ${details}` : ''}`;
      })
      .join('\n');

    return `${i + 1}. [${seg.role}] ${seg.title} (${Math.round(seg.estimatedDurationMs / 1000)}s)\n   时间范围: ${timeRange}\n   素材切片: ${seg.sliceIds.length} 个\n   段落摘要: ${seg.context.summary}${sliceLines ? `\n${sliceLines}` : ''}`;
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
    normalized.push({
      assetId,
      sliceId: raw?.sliceId ?? fallback?.sliceId,
      sourceInMs: pickOptionalNumber(raw?.sourceInMs, fallback?.sourceInMs),
      sourceOutMs: pickOptionalNumber(raw?.sourceOutMs, fallback?.sourceOutMs),
      notes: typeof raw?.notes === 'string' ? raw.notes : undefined,
    });
  }

  return normalized.length > 0 ? normalized : fallbackSelections;
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
