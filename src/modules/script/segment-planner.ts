import { randomUUID } from 'node:crypto';
import type {
  IAssetCoarseReport,
  IKtepAsset,
  IKtepProject,
  IMediaChronology,
  IProjectPharosContext,
  IProjectMaterialDigest,
  ISegmentPlanDraft,
  ISegmentPlanSegment,
  EScriptRole,
  IStyleProfile,
} from '../../protocol/schema.js';
import type { ILlmClient } from '../llm/client.js';
import {
  loadAssetReports,
  loadAssets,
  loadChronology,
  loadProject,
  loadProjectBriefConfig,
  loadScriptBrief,
  seedScriptBriefDraft,
  writeProjectMaterialDigest,
  writeSegmentPlanDrafts,
} from '../../store/index.js';
import { loadOrBuildProjectPharosContext } from '../pharos/context.js';
import { loadStyleByCategory } from './style-loader.js';
import { buildRhythmMaterialPromptLines } from './style-rhythm.js';

export interface IPrepareSegmentPlanningInput {
  projectRoot: string;
  workspaceRoot?: string;
  styleCategory?: string;
  llm?: ILlmClient;
}

export interface IPrepareProjectMaterialDigestInput {
  projectRoot: string;
}

export interface IPrepareProjectMaterialDigestResult {
  project: IKtepProject;
  digest: IProjectMaterialDigest;
  scriptBrief?: string;
}

export interface IPrepareSegmentPlanningResult {
  project: IKtepProject;
  digest: IProjectMaterialDigest;
  drafts: ISegmentPlanDraft[];
}

export async function prepareProjectMaterialDigest(
  input: IPrepareProjectMaterialDigestInput,
): Promise<IPrepareProjectMaterialDigestResult> {
  const [project, assets, reports, chronology, scriptBrief, projectBriefConfig] = await Promise.all([
    loadProject(input.projectRoot),
    loadAssets(input.projectRoot),
    loadAssetReports(input.projectRoot),
    loadChronology(input.projectRoot),
    loadScriptBrief(input.projectRoot),
    loadProjectBriefConfig(input.projectRoot),
  ]);
  const pharosContext = await loadOrBuildProjectPharosContext({
    projectRoot: input.projectRoot,
    includedTripIds: projectBriefConfig.pharos?.includedTripIds ?? [],
  });

  const digest = buildProjectMaterialDigest({
    project,
    assets,
    reports,
    chronology,
    projectBrief: scriptBrief,
    pharosContext,
  });

  await writeProjectMaterialDigest(input.projectRoot, digest);

  return {
    project,
    digest,
    scriptBrief,
  };
}

export async function prepareSegmentPlanning(
  input: IPrepareSegmentPlanningInput,
): Promise<IPrepareSegmentPlanningResult> {
  const stylePromise = input.styleCategory && input.workspaceRoot
    ? loadStyleByCategory(`${input.workspaceRoot}/config/styles`, input.styleCategory)
    : Promise.resolve(null);

  const [{ project, digest, scriptBrief }, style] = await Promise.all([
    prepareProjectMaterialDigest({
      projectRoot: input.projectRoot,
    }),
    stylePromise,
  ]);
  const drafts = input.llm
    ? await generateSegmentPlanDraftsWithLlm({
      llm: input.llm,
      digest,
      reviewBrief: scriptBrief,
      style,
    })
    : buildSegmentPlanDrafts({
      digest,
      reviewBrief: scriptBrief,
      style,
    });

  await writeSegmentPlanDrafts(input.projectRoot, drafts);
  await seedScriptBriefDraft(input.projectRoot, {
    projectName: project.name,
    styleCategory: input.styleCategory ?? style?.category,
    statusText: '系统已基于你指定的风格档案和当前素材分析生成一版初稿，请先审查再继续。',
    goalDraft: buildProjectGoalDraft(digest, style),
    constraintDraft: buildConstraintDraft(digest, drafts[0], style),
    planReviewDraft: buildPlanReviewDraft(digest, drafts, style),
    segments: drafts[0]?.segments ?? [],
  });

  return {
    project,
    digest,
    drafts,
  };
}

const SEGMENT_PLAN_SYSTEM = `你是纪录片剪辑策划。你的任务不是直接写旁白，而是先根据素材归纳、风格档案和项目 brief，提出 2 到 3 套可审查的段落方案。

要求：
1. 先想“这段素材最适合被组织成什么章节”，不要先想字幕句子。
2. 每套方案都要有清晰的策略、章节顺序、每章作用和目标时长。
3. 章节 should reflect real editing intent, not generic filler.
4. 必须考虑素材总时长、素材类型、地点线索和用户指定的风格。
5. 如果当前风格是 intro 风格，就优先给出更短、更集中、更有抓力的方案。
6. 返回 JSON 对象，格式为 { "drafts": [...] }。
7. 每个 draft 包含: name, strategy, description, notes, segments。
8. strategy 只能是 chronology-first / location-first / emotion-first 之一。
9. 每个 segment 包含: role, title, targetDurationMs, intent, mood, preferredClipTypes, preferredLabels, preferredPlaceHints, notes。`;

async function generateSegmentPlanDraftsWithLlm(input: {
  llm: ILlmClient;
  digest: IProjectMaterialDigest;
  reviewBrief?: string;
  style?: IStyleProfile | null;
}): Promise<ISegmentPlanDraft[]> {
  const fallback = buildSegmentPlanDrafts({
    digest: input.digest,
    reviewBrief: input.reviewBrief,
    style: input.style,
  });

  const prompt = buildSegmentPlanningPrompt(input.digest, input.reviewBrief, input.style);

  try {
    const raw = await input.llm.chat([
      { role: 'system', content: SEGMENT_PLAN_SYSTEM },
      { role: 'user', content: prompt },
    ], {
      jsonMode: true,
      temperature: 0.7,
      maxTokens: 4000,
    });

    const parsed = JSON.parse(raw);
    const drafts = normalizeSegmentPlanDrafts(
      Array.isArray(parsed) ? parsed : parsed.drafts,
      input.digest,
      input.reviewBrief,
      fallback,
    );
    return drafts.length > 0 ? drafts : fallback;
  } catch {
    return fallback;
  }
}

export function buildProjectMaterialDigest(input: {
  project: IKtepProject;
  assets: IKtepAsset[];
  reports: IAssetCoarseReport[];
  chronology: IMediaChronology[];
  projectBrief?: string;
  pharosContext?: IProjectPharosContext | null;
}): IProjectMaterialDigest {
  const now = new Date().toISOString();
  const reportMap = new Map(input.reports.map(report => [report.assetId, report]));
  const totalDurationMs = input.assets.reduce((sum, asset) => sum + (asset.durationMs ?? 0), 0);
  const topLabels = topStrings(input.reports.flatMap(report => report.labels), 8);
  const topPlaceHints = topStrings(input.reports.flatMap(report => report.placeHints), 6);
  const clipTypeDistribution = buildClipTypeDistribution(input.reports);
  const roots = buildRootDigests(input.assets, reportMap);
  const sortedChronology = [...input.chronology].sort(compareChronology);
  const capturedStartAt = sortedChronology[0]?.sortCapturedAt ?? sortedChronology[0]?.capturedAt;
  const capturedEndAt = sortedChronology[sortedChronology.length - 1]?.sortCapturedAt
    ?? sortedChronology[sortedChronology.length - 1]?.capturedAt;
  const mainThemes = dedupeStrings([
    ...topLabels.slice(0, 4),
    ...topPlaceHints.slice(0, 3),
  ]).slice(0, 6);
  const recommendedNarrativeAxes = inferNarrativeAxes({
    projectBrief: input.projectBrief,
    chronology: sortedChronology,
    topPlaceHints,
    topLabels,
    clipTypeDistribution,
  });
  const pharos = buildPharosDigest(input.assets, input.reports, input.pharosContext ?? null);

  return {
    id: randomUUID(),
    projectId: input.project.id,
    generatedAt: now,
    projectBrief: input.projectBrief,
    totalAssets: input.assets.length,
    totalDurationMs,
    capturedStartAt,
    capturedEndAt,
    roots,
    topLabels,
    topPlaceHints,
    clipTypeDistribution,
    mainThemes,
    recommendedNarrativeAxes,
    pharos,
    summary: buildDigestSummary({
      project: input.project,
      assetCount: input.assets.length,
      totalDurationMs,
      topLabels,
      topPlaceHints,
      recommendedNarrativeAxes,
      pharos,
    }),
  };
}

export function buildSegmentPlanningPrompt(
  digest: IProjectMaterialDigest,
  reviewBrief?: string,
  style?: IStyleProfile | null,
): string {
  const styleLines = style ? [
    `风格名称：${style.name}`,
    `风格分类：${style.category ?? ''}`,
    `叙述视角：${style.voice.person}`,
    `语言密度：${style.voice.density}`,
    `语气：${style.voice.tone}`,
    `节奏：${style.narrative.pacePattern}`,
    ...buildRhythmMaterialPromptLines(style, {
      sectionHeading: '节奏与素材编排：',
      parameterHeading: '节奏编排参数：',
      antiPatternHeading: '节奏相关禁区：',
      maxSectionLength: 180,
    }),
    ...(style.antiPatterns ?? []).slice(0, 5).map(item => `避免：${item}`),
  ] : ['风格：未指定'];

  const rootLines = digest.roots.map(root => [
    `- root: ${root.ingestRootId ?? 'unknown'}`,
    `素材数: ${root.assetCount}`,
    root.durationMs != null ? `时长: ${Math.round(root.durationMs / 1000)}s` : '',
    root.summary ? `摘要: ${root.summary}` : '',
  ].filter(Boolean).join(' | '));
  const pharosLines = buildDigestPharosPromptLines(digest.pharos);

  return [
    '## 项目级素材归纳',
    digest.summary,
    `总素材数: ${digest.totalAssets}`,
    `总时长(ms): ${digest.totalDurationMs ?? 0}`,
    digest.mainThemes.length > 0 ? `主要母题: ${digest.mainThemes.join(' / ')}` : '',
    digest.topPlaceHints.length > 0 ? `地点线索: ${digest.topPlaceHints.join(' / ')}` : '',
    digest.recommendedNarrativeAxes.length > 0 ? `建议轴线: ${digest.recommendedNarrativeAxes.join(' / ')}` : '',
    '',
    '## 素材源摘要',
    ...rootLines,
    '',
    '## 用户当前 brief',
    reviewBrief ?? '（暂无）',
    '',
    '## Pharos',
    ...pharosLines,
    '',
    '## 指定风格',
    ...styleLines,
    '',
    '请基于以上信息，输出 2 到 3 套真正可审查的段落方案，不要机械平均分段。',
  ].filter(Boolean).join('\n');
}

export function buildSegmentPlanDrafts(input: {
  digest: IProjectMaterialDigest;
  reviewBrief?: string;
  style?: IStyleProfile | null;
}): ISegmentPlanDraft[] {
  const totalDurationMs = inferTargetDurationMs(input.digest.projectBrief)
    ?? inferTargetDurationFromMaterial(input.digest, input.style);
  const now = new Date().toISOString();
  const strategies: Array<{
    name: string;
    strategy: ISegmentPlanDraft['strategy'];
    description: string;
  }> = [
    {
      name: '时间推进版',
      strategy: 'chronology-first',
      description: '按拍摄时间顺序推进，优先建立旅程推进感。',
    },
    {
      name: '地点展开版',
      strategy: 'location-first',
      description: '按地点和空间变化组织段落，优先强调从哪里到哪里。',
    },
    {
      name: '情绪起伏版',
      strategy: 'emotion-first',
      description: '按情绪和节奏强弱组织段落，优先照顾观看体验与情绪曲线。',
    },
  ];

  return strategies.map((strategy, index) => ({
    id: randomUUID(),
    projectId: input.digest.projectId,
    name: strategy.name,
    strategy: strategy.strategy,
    description: strategy.description,
    generatedAt: now,
    sourceDigestId: input.digest.id,
    reviewBrief: input.reviewBrief,
    segments: buildDraftSegments(input.digest, strategy.strategy, totalDurationMs, index),
    notes: buildDraftNotes(input.digest, strategy.strategy),
  }));
}

function normalizeSegmentPlanDrafts(
  rawDrafts: unknown,
  digest: IProjectMaterialDigest,
  reviewBrief: string | undefined,
  fallback: ISegmentPlanDraft[],
): ISegmentPlanDraft[] {
  if (!Array.isArray(rawDrafts) || rawDrafts.length === 0) {
    return [];
  }

  return rawDrafts.slice(0, 3).map((draft, index) => {
    const source = (draft ?? {}) as Record<string, unknown>;
    const base = fallback[index] ?? fallback[0];
    const strategy = normalizeDraftStrategy(source.strategy, index, base?.strategy);
    const segments = normalizeSegmentPlanSegments(
      source.segments,
      digest,
      strategy,
      base?.segments ?? [],
    );

    return {
      id: typeof source.id === 'string' ? source.id : randomUUID(),
      projectId: digest.projectId,
      name: typeof source.name === 'string' && source.name.trim() ? source.name.trim() : base?.name ?? `方案 ${index + 1}`,
      strategy,
      description: typeof source.description === 'string' && source.description.trim()
        ? source.description.trim()
        : base?.description ?? '',
      generatedAt: new Date().toISOString(),
      sourceDigestId: digest.id,
      reviewBrief,
      segments,
      notes: normalizeStringArray(source.notes, base?.notes ?? []),
    };
  });
}

function normalizeDraftStrategy(
  raw: unknown,
  index: number,
  fallback?: ISegmentPlanDraft['strategy'],
): ISegmentPlanDraft['strategy'] {
  if (raw === 'chronology-first' || raw === 'location-first' || raw === 'emotion-first') {
    return raw;
  }
  return fallback ?? (index === 1 ? 'location-first' : index === 2 ? 'emotion-first' : 'chronology-first');
}

function normalizeSegmentPlanSegments(
  rawSegments: unknown,
  digest: IProjectMaterialDigest,
  strategy: ISegmentPlanDraft['strategy'],
  fallbackSegments: ISegmentPlanSegment[],
): ISegmentPlanSegment[] {
  if (!Array.isArray(rawSegments) || rawSegments.length === 0) {
    return fallbackSegments;
  }

  return rawSegments.map((segment, index) => {
    const source = (segment ?? {}) as Record<string, unknown>;
    const fallback = fallbackSegments[index] ?? fallbackSegments[0];
    return {
      id: typeof source.id === 'string' ? source.id : `seg-plan-${strategy}-${index + 1}`,
      role: normalizeRole(source.role, fallback?.role),
      title: typeof source.title === 'string' && source.title.trim() ? source.title.trim() : fallback?.title ?? `段落 ${index + 1}`,
      targetDurationMs: normalizeDuration(source.targetDurationMs, fallback?.targetDurationMs, digest.totalDurationMs),
      intent: typeof source.intent === 'string' && source.intent.trim() ? source.intent.trim() : fallback?.intent ?? '',
      mood: typeof source.mood === 'string' && source.mood.trim() ? source.mood.trim() : fallback?.mood,
      preferredClipTypes: normalizeClipTypes(source.preferredClipTypes, fallback?.preferredClipTypes ?? ['unknown']),
      preferredLabels: normalizeStringArray(source.preferredLabels, fallback?.preferredLabels ?? digest.topLabels.slice(0, 3)),
      preferredPlaceHints: normalizeStringArray(source.preferredPlaceHints, fallback?.preferredPlaceHints ?? digest.topPlaceHints.slice(0, 3)),
      notes: normalizeStringArray(source.notes, fallback?.notes ?? []),
    };
  });
}

function buildDraftSegments(
  digest: IProjectMaterialDigest,
  strategy: ISegmentPlanDraft['strategy'],
  totalDurationMs: number,
  variantIndex: number,
): ISegmentPlanSegment[] {
  const majorLabel = digest.topLabels[0] ?? '旅程';
  const secondaryLabel = digest.topLabels[1] ?? majorLabel;
  const majorPlace = digest.topPlaceHints[0] ?? '沿途地点';
  const secondaryPlace = digest.topPlaceHints[1] ?? majorPlace;
  const segmentSpecs = pickSegmentSpecs(strategy, variantIndex);

  return segmentSpecs.map((spec, index) => {
    const targetDurationMs = Math.round(totalDurationMs * spec.ratio);
    const preferredLabels = dedupeStrings([
      index === 0 ? majorLabel : secondaryLabel,
      ...digest.topLabels.slice(index, index + 2),
    ]).slice(0, 3);
    const preferredPlaceHints = dedupeStrings([
      index % 2 === 0 ? majorPlace : secondaryPlace,
      ...digest.topPlaceHints.slice(index, index + 2),
    ]).slice(0, 3);

    return {
      id: `seg-plan-${strategy}-${index + 1}`,
      role: spec.role,
      title: spec.title,
      targetDurationMs,
      intent: renderIntent(spec.role, strategy, majorLabel, majorPlace),
      mood: spec.mood,
      preferredClipTypes: spec.preferredClipTypes,
      preferredLabels,
      preferredPlaceHints,
      notes: buildSegmentNotes(strategy, preferredLabels, preferredPlaceHints),
    };
  });
}

function pickSegmentSpecs(
  strategy: ISegmentPlanDraft['strategy'],
  variantIndex: number,
): Array<{
  role: EScriptRole;
  title: string;
  ratio: number;
  mood: string;
  preferredClipTypes: Array<'drive' | 'talking-head' | 'aerial' | 'timelapse' | 'broll' | 'unknown'>;
}> {
  if (strategy === 'location-first') {
    return [
      { role: 'intro', title: '空间建立', ratio: 0.15, mood: '克制', preferredClipTypes: ['aerial', 'broll', 'drive'] },
      { role: 'scene', title: '地点展开', ratio: 0.35, mood: '观察', preferredClipTypes: ['drive', 'broll', 'talking-head'] },
      { role: 'highlight', title: '重点地点', ratio: 0.3, mood: '打开', preferredClipTypes: ['aerial', 'timelapse', 'broll'] },
      { role: 'outro', title: '离场收束', ratio: 0.2, mood: '沉静', preferredClipTypes: ['drive', 'broll'] },
    ];
  }

  if (strategy === 'emotion-first') {
    return [
      { role: 'intro', title: '缓慢进入', ratio: 0.18, mood: '压低', preferredClipTypes: ['drive', 'broll'] },
      { role: 'transition', title: '情绪抬升', ratio: 0.22, mood: '不安', preferredClipTypes: ['drive', 'talking-head', 'broll'] },
      { role: 'highlight', title: '情绪峰值', ratio: 0.34, mood: '打开', preferredClipTypes: ['aerial', 'timelapse', 'broll'] },
      { role: 'outro', title: '回到克制', ratio: 0.26, mood: '收束', preferredClipTypes: ['drive', 'broll'] },
    ];
  }

  if (variantIndex % 2 === 0) {
    return [
      { role: 'intro', title: '旅程起点', ratio: 0.12, mood: '建立', preferredClipTypes: ['drive', 'broll'] },
      { role: 'scene', title: '沿途推进', ratio: 0.38, mood: '观察', preferredClipTypes: ['drive', 'talking-head', 'broll'] },
      { role: 'highlight', title: '中段亮点', ratio: 0.28, mood: '打开', preferredClipTypes: ['aerial', 'timelapse', 'broll'] },
      { role: 'outro', title: '段落收束', ratio: 0.22, mood: '沉静', preferredClipTypes: ['drive', 'broll'] },
    ];
  }

  return [
    { role: 'intro', title: '进入状态', ratio: 0.15, mood: '克制', preferredClipTypes: ['drive', 'broll'] },
    { role: 'scene', title: '路上观察', ratio: 0.33, mood: '平静', preferredClipTypes: ['drive', 'broll', 'talking-head'] },
    { role: 'scene', title: '空间变化', ratio: 0.27, mood: '推进', preferredClipTypes: ['aerial', 'drive', 'broll'] },
    { role: 'outro', title: '落回人身上', ratio: 0.25, mood: '回落', preferredClipTypes: ['drive', 'talking-head'] },
  ];
}

function renderIntent(
  role: EScriptRole,
  strategy: ISegmentPlanDraft['strategy'],
  label: string,
  place: string,
): string {
  if (strategy === 'location-first') {
    return `${place} 作为这一段的主要空间锚点，用来交代地点变化和行程推进。`;
  }
  if (strategy === 'emotion-first') {
    return `${label} 作为主要情绪母题，这一段负责建立或推高情绪曲线。`;
  }
  if (role === 'intro') {
    return `用 ${label} 建立旅程起点与观看预期。`;
  }
  if (role === 'highlight') {
    return `把 ${place} 或相关亮点推到观众面前，形成记忆点。`;
  }
  if (role === 'outro') {
    return '把段落重新收回到更克制、更可持续的观看节奏。';
  }
  return `围绕 ${label} 推进行程观察，并为后续段落留出承接空间。`;
}

function buildSegmentNotes(
  strategy: ISegmentPlanDraft['strategy'],
  labels: string[],
  placeHints: string[],
): string[] {
  const notes = [
    `策略：${strategy}`,
  ];
  if (labels.length > 0) {
    notes.push(`优先母题：${labels.join(' / ')}`);
  }
  if (placeHints.length > 0) {
    notes.push(`优先地点线索：${placeHints.join(' / ')}`);
  }
  return notes;
}

function buildDraftNotes(
  digest: IProjectMaterialDigest,
  strategy: ISegmentPlanDraft['strategy'],
): string[] {
  return dedupeStrings([
    `全量素材数：${digest.totalAssets}`,
    digest.summary,
    `建议轴线：${digest.recommendedNarrativeAxes.join(' / ')}`,
    `当前方案：${strategy}`,
  ]);
}

function buildProjectGoalDraft(
  digest: IProjectMaterialDigest,
  style?: IStyleProfile | null,
): string[] {
  const goal = digest.topPlaceHints.length > 0
    ? `先把这段素材里的空间线索建立起来，重点围绕 ${digest.topPlaceHints.slice(0, 2).join('、')} 展开。`
    : '先把这段素材里的空间和行程关系建立起来。';
  const feeling = digest.clipTypeDistribution.drive
    ? '整体气质建议偏观察和推进感，不要写成密集解释或日常 vlog 口播。'
    : '整体气质建议偏克制观察，不要急着把所有信息一次说满。';
  const section = digest.recommendedNarrativeAxes.includes('journey')
    ? '当前更适合先做“正片中段 / 路上推进段”一类的内容。'
    : '当前更适合先做一段独立章节试写，再决定是否扩成 intro 或整片结构。';
  const styleHint = style
    ? `风格参考采用「${style.name}」，建议沿用其 ${style.voice.tone} 的语气，并保持 ${style.narrative.pacePattern}。`
    : undefined;
  const introHint = style?.category?.includes('intro')
    ? '由于当前选用的是 intro 风格，建议默认把这一轮当成“开场试写”，优先考虑命题抛出、快速建场和进入正片的引导感。'
    : undefined;
  return [goal, feeling, section, styleHint, introHint].filter(Boolean) as string[];
}

function buildConstraintDraft(
  digest: IProjectMaterialDigest,
  primaryDraft?: ISegmentPlanDraft,
  style?: IStyleProfile | null,
): string[] {
  const totalSeconds = primaryDraft?.segments.reduce((sum, segment) => sum + (segment.targetDurationMs ?? 0), 0);
  const durationHint = totalSeconds && totalSeconds > 0
    ? `结合当前素材总时长约 ${Math.round((digest.totalDurationMs ?? 0) / 1000)} 秒，首轮试写建议先控制在 ${Math.round(totalSeconds / 1000)} 秒上下，后续再按审查意见压缩。`
    : '目标总时长建议先按一个短章节来试写，再根据段落方案微调。';
  const audienceHint = digest.clipTypeDistribution.drive
    ? '受众建议默认面向愿意跟着路线慢慢进入状态的纪录片观众。'
    : '受众建议默认面向能接受慢热观察感的纪录片观众。';
  const styleLines = style ? [
    `叙述视角：优先保持 ${style.voice.person} 人称`,
    `语言密度：${style.voice.density}`,
    `语气：${style.voice.tone}`,
    ...((style.antiPatterns ?? []).slice(0, 3).map(item => `避免：${item}`)),
  ] : [];
  return [
    durationHint,
    audienceHint,
    '禁区建议：不要把素材里已经能被画面说明的内容再解释一遍；不要写成打卡式导览。',
    ...styleLines,
  ];
}

function buildPlanReviewDraft(
  digest: IProjectMaterialDigest,
  drafts: ISegmentPlanDraft[],
  style?: IStyleProfile | null,
): string[] {
  const recommended = drafts[0];
  const mustHave = recommended?.segments.slice(0, 3).map(segment => segment.title).join('、') || '（待确认）';
  const styleReview = style
    ? `当前风格参考是「${style.name}」，请确认这次是否真的要按这份风格来写，而不是只借用其中一部分。`
    : undefined;
  return [
    `系统建议优先按 ${digest.recommendedNarrativeAxes.join(' / ') || 'chronology'} 组织。`,
    `首选方案：${recommended?.name ?? '（待确认）'}。`,
    `建议保留的章节：${mustHave}。`,
    '如果某个章节你觉得太“像 AI 编出来的”，直接在这里删掉或改名即可。',
    '选择方案：',
    '修改说明：',
    styleReview,
  ].filter(Boolean) as string[];
}

function buildRootDigests(
  assets: IKtepAsset[],
  reportMap: Map<string, IAssetCoarseReport>,
): IProjectMaterialDigest['roots'] {
  const groups = new Map<string, IKtepAsset[]>();
  for (const asset of assets) {
    const key = asset.ingestRootId ?? '__unknown__';
    const list = groups.get(key) ?? [];
    list.push(asset);
    groups.set(key, list);
  }

  return [...groups.entries()].map(([ingestRootId, group]) => {
    const reports = group
      .map(asset => reportMap.get(asset.id))
      .filter((report): report is IAssetCoarseReport => Boolean(report));
    const topLabels = topStrings(reports.flatMap(report => report.labels), 4);
    const topPlaceHints = topStrings(reports.flatMap(report => report.placeHints), 3);
    const durationMs = group.reduce((sum, asset) => sum + (asset.durationMs ?? 0), 0);
    return {
      ingestRootId: ingestRootId === '__unknown__' ? undefined : ingestRootId,
      assetCount: group.length,
      durationMs,
      topLabels,
      topPlaceHints,
      summary: summarizeRoot(group.length, topLabels, topPlaceHints),
    };
  }).sort((a, b) => (b.durationMs ?? 0) - (a.durationMs ?? 0));
}

function summarizeRoot(assetCount: number, labels: string[], placeHints: string[]): string {
  const parts = [`${assetCount} 条素材`];
  if (labels.length > 0) parts.push(`标签偏向 ${labels.join(' / ')}`);
  if (placeHints.length > 0) parts.push(`地点线索 ${placeHints.join(' / ')}`);
  return parts.join('，');
}

function buildClipTypeDistribution(reports: IAssetCoarseReport[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const report of reports) {
    out[report.clipTypeGuess] = (out[report.clipTypeGuess] ?? 0) + 1;
  }
  return out;
}

function inferNarrativeAxes(input: {
  projectBrief?: string;
  chronology: IMediaChronology[];
  topPlaceHints: string[];
  topLabels: string[];
  clipTypeDistribution: Record<string, number>;
}): string[] {
  const axes: string[] = [];
  const brief = input.projectBrief ?? '';

  if (/时间|chronology|时间顺序/u.test(brief) || input.chronology.length >= 3) {
    axes.push('chronology');
  }
  if (/地点|路线|空间|location/u.test(brief) || input.topPlaceHints.length >= 2) {
    axes.push('location');
  }
  if (/情绪|氛围|mood|emotion/u.test(brief)) {
    axes.push('emotion');
  }
  if ((input.clipTypeDistribution.drive ?? 0) > 0) {
    axes.push('journey');
  }
  if (input.topLabels.length > 0) {
    axes.push('theme');
  }

  return dedupeStrings(axes).slice(0, 4);
}

function buildDigestSummary(input: {
  project: IKtepProject;
  assetCount: number;
  totalDurationMs: number;
  topLabels: string[];
  topPlaceHints: string[];
  recommendedNarrativeAxes: string[];
  pharos?: IProjectMaterialDigest['pharos'];
}): string {
  const totalMinutes = Math.round(input.totalDurationMs / 60000);
  const parts = [
    `项目《${input.project.name}》当前包含 ${input.assetCount} 条素材`,
  ];
  if (totalMinutes > 0) {
    parts.push(`总时长约 ${totalMinutes} 分钟`);
  }
  if (input.topLabels.length > 0) {
    parts.push(`主要母题包括 ${input.topLabels.slice(0, 4).join('、')}`);
  }
  if (input.topPlaceHints.length > 0) {
    parts.push(`地点线索集中在 ${input.topPlaceHints.slice(0, 3).join('、')}`);
  }
  if (input.pharos) {
    const pharosSummary = buildPharosDigestSummarySentence(input.pharos);
    if (pharosSummary) parts.push(pharosSummary);
  }
  if (input.recommendedNarrativeAxes.length > 0) {
    parts.push(`建议优先按 ${input.recommendedNarrativeAxes.join(' / ')} 组织段落`);
  }
  return parts.join('，') + '。';
}

function buildPharosDigest(
  assets: IKtepAsset[],
  reports: IAssetCoarseReport[],
  context: IProjectPharosContext | null,
): IProjectMaterialDigest['pharos'] | undefined {
  if (!context) return undefined;

  const matchedAssetIds = new Set(
    reports
      .filter(report => report.pharosMatches.length > 0)
      .map(report => report.assetId),
  );
  const matchedRefs = new Set(
    reports
      .flatMap(report => report.pharosMatches)
      .map(match => `${match.ref.tripId}::${match.ref.shotId}`),
  );

  return {
    status: context.status,
    fallbackMode: context.status !== 'success',
    discoveredTripCount: context.discoveredTripIds.length,
    includedTripCount: context.trips.length,
    matchedAssetCount: matchedAssetIds.size,
    unmatchedAssetCount: Math.max(0, assets.length - matchedAssetIds.size),
    pendingShotCount: context.shots.filter(shot =>
      shot.status === 'pending'
      && !matchedRefs.has(`${shot.ref.tripId}::${shot.ref.shotId}`),
    ).length,
    abandonedShotCount: context.shots.filter(shot => shot.status === 'abandoned').length,
    warnings: context.warnings,
    errors: context.errors,
    trips: context.trips.map(trip => ({
      tripId: trip.tripId,
      title: trip.title,
      tripKind: trip.tripKind,
      revision: trip.revision,
      dateStart: trip.dateStart,
      dateEnd: trip.dateEnd,
      mustCount: trip.mustCount,
      optionalCount: trip.optionalCount,
      pendingCount: trip.pendingCount,
      abandonedCount: trip.abandonedCount,
      matchedAssetCount: new Set(
        reports
          .filter(report => report.pharosMatches.some(match => match.ref.tripId === trip.tripId))
          .map(report => report.assetId),
      ).size,
    })),
  };
}

function buildDigestPharosPromptLines(
  pharos: IProjectMaterialDigest['pharos'] | undefined,
): string[] {
  if (!pharos) {
    return ['当前项目没有可用的 Pharos 规划上下文；请按 fallback 路径组织。'];
  }

  const lines = [
    `状态: ${pharos.status}`,
    `已发现 Trip: ${pharos.discoveredTripCount}`,
    `已纳入 Trip: ${pharos.includedTripCount}`,
    `已匹配素材: ${pharos.matchedAssetCount}`,
    `未匹配素材: ${pharos.unmatchedAssetCount}`,
    `待补镜头: ${pharos.pendingShotCount}`,
    `已放弃镜头: ${pharos.abandonedShotCount}`,
  ];

  for (const trip of pharos.trips.slice(0, 6)) {
    lines.push([
      `- ${trip.title}`,
      trip.dateStart && trip.dateEnd ? `${trip.dateStart} -> ${trip.dateEnd}` : '',
      trip.revision != null ? `rev ${trip.revision}` : '',
      `must ${trip.mustCount}`,
      `pending ${trip.pendingCount}`,
      `abandoned ${trip.abandonedCount}`,
      `matched-assets ${trip.matchedAssetCount}`,
    ].filter(Boolean).join(' | '));
  }

  if (pharos.errors.length > 0) {
    lines.push(`错误: ${pharos.errors[0]}`);
  } else if (pharos.warnings.length > 0) {
    lines.push(`警告: ${pharos.warnings[0]}`);
  }

  return lines;
}

function buildPharosDigestSummarySentence(
  pharos: NonNullable<IProjectMaterialDigest['pharos']>,
): string | undefined {
  if (pharos.status === 'empty') {
    return '当前没有可用的 Pharos 规划镜头，脚本需要按 fallback 路径组织';
  }
  return `Pharos 当前纳入 ${pharos.includedTripCount} 个 trip，已匹配 ${pharos.matchedAssetCount} 条素材，仍有 ${pharos.pendingShotCount} 个 pending 镜头待补位`;
}

function inferTargetDurationMs(brief?: string): number | undefined {
  if (!brief) return undefined;
  const compact = brief.replace(/\s+/g, '');
  const minuteMatch = compact.match(/目标总时长[:：]?(\d+(?:\.\d+)?)分钟/u);
  if (minuteMatch) {
    return Math.round(Number(minuteMatch[1]) * 60 * 1000);
  }
  const secondMatch = compact.match(/目标总时长[:：]?(\d+(?:\.\d+)?)秒/u);
  if (secondMatch) {
    return Math.round(Number(secondMatch[1]) * 1000);
  }
  return undefined;
}

function inferTargetDurationFromMaterial(
  digest: IProjectMaterialDigest,
  style?: IStyleProfile | null,
): number {
  const total = Math.max(digest.totalDurationMs ?? 0, 1);
  const isIntro = style?.category?.includes('intro')
    || style?.name?.toLowerCase().includes('intro');

  if (isIntro) {
    return clamp(Math.round(total * 0.1), 45_000, 90_000);
  }

  if ((digest.clipTypeDistribution.drive ?? 0) > 0) {
    return clamp(Math.round(total * 0.18), 60_000, 180_000);
  }

  return clamp(Math.round(total * 0.2), 60_000, 240_000);
}

function topStrings(values: string[], limit: number): string[] {
  const counts = new Map<string, number>();
  const ignored = new Set([
    'container',
    'sky',
    'grass',
    'trees',
    'power lines',
    'road',
  ]);
  for (const raw of values) {
    const value = raw.trim();
    if (!value) continue;
    if (ignored.has(value.toLowerCase())) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([value]) => value);
}

function normalizeRole(
  raw: unknown,
  fallback: EScriptRole | undefined,
): EScriptRole {
  if (raw === 'intro' || raw === 'scene' || raw === 'transition' || raw === 'highlight' || raw === 'outro') {
    return raw;
  }
  return fallback ?? 'scene';
}

function normalizeDuration(
  raw: unknown,
  fallback: number | undefined,
  projectTotalDurationMs: number | undefined,
): number | undefined {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
    return Math.round(raw);
  }
  if (typeof fallback === 'number' && Number.isFinite(fallback) && fallback > 0) {
    return fallback;
  }
  if (typeof projectTotalDurationMs === 'number' && projectTotalDurationMs > 0) {
    return Math.round(projectTotalDurationMs * 0.2);
  }
  return undefined;
}

function normalizeClipTypes(
  raw: unknown,
  fallback: ISegmentPlanSegment['preferredClipTypes'],
): ISegmentPlanSegment['preferredClipTypes'] {
  if (!Array.isArray(raw)) return fallback;
  const allowed = new Set(['drive', 'talking-head', 'aerial', 'timelapse', 'broll', 'unknown']);
  const values = raw
    .filter((value): value is string => typeof value === 'string')
    .map(value => value.trim())
    .filter(value => allowed.has(value));
  return values.length > 0
    ? values as ISegmentPlanSegment['preferredClipTypes']
    : fallback;
}

function normalizeStringArray(raw: unknown, fallback: string[]): string[] {
  if (!Array.isArray(raw)) return fallback;
  const values = raw
    .filter((value): value is string => typeof value === 'string')
    .map(value => value.trim())
    .filter(Boolean);
  return values.length > 0 ? dedupeStrings(values) : fallback;
}

function dedupeStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.map(value => value?.trim()).filter((value): value is string => Boolean(value)))];
}

function compareChronology(a: IMediaChronology, b: IMediaChronology): number {
  const aSort = a.sortCapturedAt ?? a.capturedAt ?? '';
  const bSort = b.sortCapturedAt ?? b.capturedAt ?? '';
  if (aSort !== bSort) return aSort.localeCompare(bSort);
  return a.assetId.localeCompare(b.assetId);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
