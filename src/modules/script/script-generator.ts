import { randomUUID } from 'node:crypto';
import type {
  IAgentPacket,
  IAgentContract,
  IKtepBeatUtterance,
  IKtepScript,
  IKtepScriptBeat,
  IKtepScriptSelection,
  ISpatialStoryContext,
  IStyleProfile,
} from '../../protocol/schema.js';
import type { IJsonPacketAgentRunner } from '../agents/runtime.js';
import type { IOutlineBeat, IOutlineSegment } from './outline-builder.js';
import { buildRhythmMaterialPromptLines } from './style-rhythm.js';

export interface IScriptGenerationContext {
  materialOverview?: string;
  brief?: {
    goals?: string[];
    constraints?: string[];
    planReviewNotes?: string[];
  };
  contract?: IAgentContract;
  spatialStory?: ISpatialStoryContext;
  stage?: string;
}

export async function generateScript(
  agentRunner: IJsonPacketAgentRunner,
  outline: IOutlineSegment[],
  style: IStyleProfile,
  context?: IScriptGenerationContext,
): Promise<IKtepScript[]> {
  const styleText = buildStylePrompt(style);
  const outlineText = buildOutlinePrompt(outline);
  const contextText = buildGenerationContextPrompt(context);
  const packet: IAgentPacket = {
    stage: context?.stage ?? 'script-current',
    identity: 'beat-writer',
    mission: '只根据 outline、style、contract 与 material overview 写 beat/script。',
    hardConstraints: [
      '必须严格遵循 contract、outline 和 style 中已给出的约束。',
      '缺证据时必须保守，不脑补地点、事件和情绪。',
      '不要通过删 beat 来掩盖材料密度。',
      '不得改写 outline 已锁定的 audioSelections[]、visualSelections[]、linkedSpanIds 或 linkedSliceIds。',
      '只允许改写表达层字段：text、utterances、notes、muteSource、preserveNatSound。',
    ],
    allowedInputs: [
      'material overview',
      'script brief',
      'agent contract',
      'spatial story',
      'style profile',
      'outline',
    ],
    inputArtifacts: [
      {
        label: 'generation-context',
        summary: 'material overview + brief + contract + spatial story + style + outline',
        content: {
          contextText,
          styleText,
          outlineText,
          contract: context?.contract,
          spatialStory: context?.spatialStory,
        },
      },
    ],
    outputSchema: {
      segments: 'IKtepScript[]',
    },
    reviewRubric: [],
  };
  let raw: unknown;
  try {
    raw = await agentRunner.run<unknown>({
      promptId: 'script/beat-writer',
      packet,
      llm: { temperature: 0.7, maxTokens: 4000 },
    });
  } catch {
    return buildFallbackScript(outline);
  }

  const segments = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as Record<string, unknown>)?.segments)
      ? (raw as Record<string, unknown>).segments as unknown[]
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
          beat.audioSelections.length > 0 ? `原声锚点: ${beat.audioSelections.length}` : '',
          beat.visualSelections.length > 0 ? `画面选择: ${beat.visualSelections.length}` : '',
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
  const linkedSpanIds = dedupeStrings([
    ...beats.flatMap(beat => beat.linkedSpanIds),
    ...fallback.spanIds,
  ]);
  const linkedSliceIds = dedupeStrings([
    ...beats.flatMap(beat => beat.linkedSliceIds),
    ...linkedSpanIds,
  ]);

  return {
    id: fallback.id,
    role: fallback.role,
    title: fallback.title,
    narration: stringValue(source.narration) ?? mergeBeatNarration(beats),
    targetDurationMs: fallback.estimatedDurationMs,
    actions: mergeExpressionActions(source.actions, undefined),
    selections: fallback.selections.length > 0 ? fallback.selections : undefined,
    linkedSpanIds,
    linkedSliceIds,
    pharosRefs: mergePharosRefs(beats.flatMap(beat => collectBeatSelections(beat))),
    beats,
    notes: stringValue(source.notes) ?? (fallback.notes.join(' / ') || undefined),
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
  return fallbackBeats.map((fallback, index) => {
    const matchedIndex = consumeMatchedBeatIndex(fallback.id, index, rawItems, rawIndexesById, usedIndexes);
    return normalizeBeatRecord(
      matchedIndex != null ? rawItems[matchedIndex] : undefined,
      fallback,
    );
  });
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
  const audioSelections = fallback?.audioSelections ?? [];
  const visualSelections = fallback?.visualSelections ?? [];
  const linkedSpanIds = dedupeStrings([
    ...(fallback?.linkedSpanIds ?? []),
  ]);
  const linkedSliceIds = dedupeStrings([
    ...linkedSpanIds,
  ]);
  const utterances = normalizeUtterances(safeSource.utterances);

  return {
    id: fallback?.id ?? stringValue(safeSource.id) ?? randomUUID(),
    text: stringValue(safeSource.text) ?? resolveFallbackBeatText(fallback),
    utterances: utterances.length > 0 ? utterances : undefined,
    targetDurationMs: undefined,
    actions: mergeExpressionActions(safeSource.actions, fallback?.sourceSpeechDecision === 'preserve'
      ? { preserveNatSound: true, muteSource: undefined }
      : undefined),
    audioSelections,
    visualSelections,
    linkedSpanIds,
    linkedSliceIds,
    pharosRefs: mergePharosRefs([
      ...audioSelections,
      ...visualSelections,
    ]),
    notes: stringValue(safeSource.notes),
  };
}

export function buildFallbackScript(outline: IOutlineSegment[]): IKtepScript[] {
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
    audioSelections: beat.audioSelections,
    visualSelections: beat.visualSelections,
    linkedSpanIds: beat.linkedSpanIds,
    linkedSliceIds: beat.linkedSpanIds,
    pharosRefs: mergePharosRefs(collectBeatSelections(beat)),
    notes: beat.query,
  };
}

function resolveFallbackBeatText(beat: IOutlineBeat | undefined): string {
  const transcript = beat?.transcript?.trim();
  if (transcript) return transcript;
  return '';
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

function mergeExpressionActions(
  raw: unknown,
  fallback?: Pick<NonNullable<IKtepScript['actions']>, 'preserveNatSound' | 'muteSource'>,
): IKtepScript['actions'] | undefined {
  if (!raw || typeof raw !== 'object') {
    return fallback && (
      typeof fallback.preserveNatSound === 'boolean'
      || typeof fallback.muteSource === 'boolean'
    )
      ? {
        preserveNatSound: fallback.preserveNatSound,
        muteSource: fallback.muteSource,
      }
      : undefined;
  }
  const source = raw as Record<string, unknown>;
  const rawPreserveNatSound = source.preserveNatSound;
  const rawMuteSource = source.muteSource;
  const preserveNatSound = typeof rawPreserveNatSound === 'boolean' ? rawPreserveNatSound : undefined;
  const muteSource = typeof rawMuteSource === 'boolean' ? rawMuteSource : undefined;
  const nextPreserveNatSound = typeof preserveNatSound === 'boolean'
    ? preserveNatSound
    : fallback?.preserveNatSound;
  const nextMuteSource = typeof muteSource === 'boolean'
    ? muteSource
    : fallback?.muteSource;

  if (
    typeof nextPreserveNatSound !== 'boolean'
    && typeof nextMuteSource !== 'boolean'
  ) {
    return undefined;
  }

  return {
    preserveNatSound: nextPreserveNatSound,
    muteSource: nextMuteSource,
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

function collectBeatSelections(
  beat: Pick<IKtepScriptBeat, 'audioSelections' | 'visualSelections'>,
): IKtepScriptSelection[] {
  return dedupeSelections([
    ...beat.audioSelections,
    ...beat.visualSelections,
  ]);
}

function dedupeSelections(values: IKtepScriptSelection[]): IKtepScriptSelection[] {
  const seen = new Set<string>();
  const result: IKtepScriptSelection[] = [];
  for (const value of values) {
    const key = [
      value.assetId,
      value.spanId ?? '',
      value.sliceId ?? '',
      value.sourceInMs ?? '',
      value.sourceOutMs ?? '',
    ].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
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
