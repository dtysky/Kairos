import { randomUUID } from 'node:crypto';
import type {
  IAgentPacket,
  IStageReview,
  IStyleProfile,
} from '../../protocol/schema.js';
import type { ILlmClient } from '../llm/client.js';
import type { IRhythmStats } from '../media/shot-detect.js';
import type { IShotRecognition } from '../media/recognizer.js';
import {
  getStyleAgentPacketPath,
  getStyleAgentSummaryPath,
  getStyleDraftPath,
  getStyleReviewPath,
  writeJson,
} from '../../store/index.js';
import { runJsonPacketAgent } from '../agents/runtime.js';
import {
  CRHYTHM_MATERIAL_PARAMETER_KEYS,
  ensureRhythmMaterialParameterKeys,
} from './style-rhythm.js';
import { deriveStyleProtocolV2Fields } from './style-loader.js';

const CSTYLE_REVIEW_CODES = [
  'guidance_ignored',
  'overclaim_style_rule',
  'missing_executable_parameters',
  'weak_evidence_generalization',
  'anti_pattern_missing',
] as const;

export interface IStyleReferenceVideoAnalysis {
  sourceFile: string;
  transcript?: string;
  guidancePrompt?: string;
  contentInsights?: string[];
  rhythm?: Partial<IRhythmStats>;
  shotRecognitions?: IShotRecognition[];
}

export interface IAnalyzeStyleOptions {
  workspaceRoot?: string;
  categoryId?: string;
  displayName?: string;
  guidancePrompt?: string;
  inclusionNotes?: string;
  exclusionNotes?: string;
  maxReviewRounds?: number;
}

export interface IAnalyzeStylePipelineResult {
  status: 'completed' | 'awaiting_user';
  profile?: IStyleProfile;
  review: IStageReview;
}

interface IStyleSynthDraft {
  narrative?: {
    introRatio?: number;
    outroRatio?: number;
    avgSegmentDurationSec?: number;
    brollFrequency?: number;
    pacePattern?: string;
  };
  voice?: {
    person?: '1st' | '2nd' | '3rd';
    tone?: string;
    density?: 'low' | 'moderate' | 'high';
    sampleTexts?: string[];
  };
  sections?: Array<{ title?: string; content?: string; tags?: string[] }>;
  antiPatterns?: string[];
  parameters?: Record<string, string>;
}

interface IStylePreparationSummaryDocument {
  categoryId: string;
  displayName: string;
  generatedAt: string;
  guidancePrompt?: string;
  inclusionNotes?: string;
  exclusionNotes?: string;
  videoCount: number;
  aggregate: {
    totalShotCount: number;
    averageCutsPerMinute: number;
    commonSceneTypes: string[];
    commonMoods: string[];
    commonNarrativeRoles: string[];
  };
  agentInputReports: IStyleReferenceVideoAnalysis[];
}

interface IStyleDraftDocument {
  generatedAt: string;
  attempt: number;
  draft: IStyleSynthDraft;
}

export async function analyzeStyle(
  llm: ILlmClient,
  sourceFiles: string[],
  transcripts: string[],
  options?: IAnalyzeStyleOptions,
): Promise<IStyleProfile> {
  const reports: IStyleReferenceVideoAnalysis[] = sourceFiles.map((sourceFile, index) => ({
    sourceFile,
    transcript: transcripts[index],
    guidancePrompt: options?.guidancePrompt,
  }));
  return analyzeStyleFromReports(llm, reports, options);
}

export async function analyzeStyleFromReports(
  llm: ILlmClient,
  reports: IStyleReferenceVideoAnalysis[],
  options?: IAnalyzeStyleOptions,
): Promise<IStyleProfile> {
  const result = await runStyleProfileAgentPipeline(llm, reports, options);
  if (result.status !== 'completed' || !result.profile) {
    const blockers = result.review.issues
      .filter(issue => issue.severity === 'blocker')
      .map(issue => `${issue.code}: ${issue.message}`);
    throw new Error(`style synthesis is awaiting user review: ${blockers.join(' | ')}`);
  }
  return result.profile;
}

export async function runStyleProfileAgentPipeline(
  llm: ILlmClient,
  reports: IStyleReferenceVideoAnalysis[],
  options?: IAnalyzeStyleOptions,
): Promise<IAnalyzeStylePipelineResult> {
  const maxAttempts = Math.max(1, (options?.maxReviewRounds ?? 2) + 1);
  const summary = buildStyleAgentSummary(reports, options);
  await persistStyleAgentSummary(summary, options);

  let revisionBrief: string[] = [];
  let previousDraft: IStyleSynthDraft | undefined;
  let lastReview: IStageReview | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const synthesisPacket = buildStyleSynthesisPacket(summary, revisionBrief, previousDraft, options);
    await persistStylePacket('style-profile-synthesizer', synthesisPacket, options);
    const draft = await runJsonPacketAgent<IStyleSynthDraft>(
      llm,
      'style/style-profile-synthesizer',
      synthesisPacket,
      { revisionBrief, previousDraft },
    );
    await persistStyleDraft({ generatedAt: new Date().toISOString(), attempt, draft }, options);

    const reviewPacket = buildStyleReviewPacket(summary, draft, attempt, options);
    await persistStylePacket('style-profile-reviewer', reviewPacket, options);
    const review = await runJsonPacketAgent<Partial<IStageReview>>(
      llm,
      'style/style-profile-reviewer',
      reviewPacket,
      { llm: { temperature: 0.1 } },
    );
    lastReview = normalizeStageReview(review, {
      stage: 'style-profile',
      identity: 'style-profile-reviewer',
      attempt,
      defaultCodes: CSTYLE_REVIEW_CODES,
    });
    await persistStyleReview(lastReview, options);

    if (lastReview.verdict === 'pass') {
      return {
        status: 'completed',
        profile: buildStyleProfileFromDraft(draft, reports),
        review: lastReview,
      };
    }

    if (attempt >= maxAttempts) {
      const awaitingUserReview: IStageReview = {
        ...lastReview,
        verdict: 'awaiting_user',
      };
      await persistStyleReview(awaitingUserReview, options);
      return {
        status: 'awaiting_user',
        review: awaitingUserReview,
      };
    }

    revisionBrief = lastReview.revisionBrief;
    previousDraft = draft;
  }

  const fallbackReview: IStageReview = {
    stage: 'style-profile',
    identity: 'style-profile-reviewer',
    attempt: maxAttempts,
    verdict: 'awaiting_user',
    issues: [{
      code: 'weak_evidence_generalization',
      severity: 'blocker',
      message: 'style synthesis exited without an approved draft.',
    }],
    revisionBrief: ['请回到参考报告与 guidance，保守重写 style profile。'],
    reviewedAt: new Date().toISOString(),
  };
  await persistStyleReview(fallbackReview, options);
  return {
    status: 'awaiting_user',
    review: fallbackReview,
  };
}

function buildStyleAgentSummary(
  reports: IStyleReferenceVideoAnalysis[],
  options?: IAnalyzeStyleOptions,
): IStylePreparationSummaryDocument {
  return {
    categoryId: options?.categoryId?.trim() || 'style-analysis',
    displayName: options?.displayName?.trim() || options?.categoryId?.trim() || '自动分析风格',
    generatedAt: new Date().toISOString(),
    guidancePrompt: options?.guidancePrompt ?? reports.find(report => report.guidancePrompt?.trim())?.guidancePrompt,
    inclusionNotes: options?.inclusionNotes,
    exclusionNotes: options?.exclusionNotes,
    videoCount: reports.length,
    aggregate: buildSummaryAggregate(reports),
    agentInputReports: reports,
  };
}

function buildStyleSynthesisPacket(
  summary: IStylePreparationSummaryDocument,
  revisionBrief: string[],
  previousDraft: IStyleSynthDraft | undefined,
  options?: IAnalyzeStyleOptions,
): IAgentPacket {
  return {
    stage: 'style-profile-synthesizer',
    identity: 'style-profile-synthesizer',
    mission: '从参考视频汇总证据中归纳共享 style profile 草稿。',
    hardConstraints: [
      '只相信 packet 提供的 summary、per-video reports、guidance、inclusion/exclusion notes。',
      '不要把偶发特征夸大成稳定规则。',
      '缺证据时必须写成“未明确 / 少用 / 不明显 / 偶尔出现”。',
      '不要输出正式 markdown 成品，只输出结构化草稿 JSON。',
    ],
    allowedInputs: [
      'analysis/style-references/{category}/agent-summary.json',
      '可选 revisionBrief',
      '可选 previousDraft',
    ],
    inputArtifacts: [
      {
        label: 'style-agent-summary',
        path: options?.workspaceRoot && options?.categoryId
          ? getStyleAgentSummaryPath(options.workspaceRoot, options.categoryId)
          : undefined,
        summary: `${summary.videoCount} 个参考视频的共享风格汇总。`,
        content: summary,
      },
      revisionBrief.length > 0 ? {
        label: 'revision-brief',
        summary: revisionBrief.join(' / '),
        content: revisionBrief,
      } : null,
      previousDraft ? {
        label: 'previous-draft',
        summary: '上一轮 style 草稿，仅用于修订，不代表正式通过。',
        content: previousDraft,
      } : null,
    ].filter((item): item is NonNullable<typeof item> => item != null),
    outputSchema: {
      narrative: {
        introRatio: 'number',
        outroRatio: 'number',
        avgSegmentDurationSec: 'number',
        brollFrequency: 'number',
        pacePattern: 'string',
      },
      voice: {
        person: '1st | 2nd | 3rd',
        tone: 'string',
        density: 'low | moderate | high',
        sampleTexts: 'string[]',
      },
      sections: 'Array<{ title, content, tags? }>',
      antiPatterns: 'string[]',
      parameters: 'Record<string, string>',
    },
    reviewRubric: [...CSTYLE_REVIEW_CODES],
  };
}

function buildStyleReviewPacket(
  summary: IStylePreparationSummaryDocument,
  draft: IStyleSynthDraft,
  attempt: number,
  options?: IAnalyzeStyleOptions,
): IAgentPacket {
  return {
    stage: 'style-profile-reviewer',
    identity: 'style-profile-reviewer',
    mission: '审查 style 草稿是否真正尊重 guidance、避免过拟合，并补齐可执行参数与 anti-pattern。',
    hardConstraints: [
      '只根据 summary、draft 和 rubric 审查，不直接改写正式 profile。',
      '存在 blocker 时必须给 revisionBrief。',
      '缺证据时必须保守地判为 blocker 或 warning。',
    ],
    allowedInputs: [
      'style-agent-summary',
      'style draft',
      'review rubric',
    ],
    inputArtifacts: [
      {
        label: 'style-agent-summary',
        path: options?.workspaceRoot && options?.categoryId
          ? getStyleAgentSummaryPath(options.workspaceRoot, options.categoryId)
          : undefined,
        summary: `${summary.videoCount} 个参考视频的共享风格汇总。`,
        content: summary,
      },
      {
        label: 'style-draft',
        path: options?.workspaceRoot && options?.categoryId
          ? getStyleDraftPath(options.workspaceRoot, options.categoryId)
          : undefined,
        summary: `第 ${attempt} 轮 synthesize 草稿。`,
        content: draft,
      },
    ],
    outputSchema: {
      verdict: 'pass | revise | awaiting_user',
      issues: 'Array<{ code, severity, message, details? }>',
      revisionBrief: 'string[]',
    },
    reviewRubric: [...CSTYLE_REVIEW_CODES],
  };
}

function buildStyleProfileFromDraft(
  draft: IStyleSynthDraft,
  reports: IStyleReferenceVideoAnalysis[],
): IStyleProfile {
  const now = new Date().toISOString();
  const parameters = ensureRhythmMaterialParameterKeys(
    normalizeParameters(draft.parameters),
    '未明确',
  );
  const sections = normalizeSections(
    Array.isArray(draft.sections)
      ? draft.sections.map((section, index) => ({
        id: `section-${index + 1}`,
        title: section.title ?? `分析 ${index + 1}`,
        content: section.content ?? '',
        tags: Array.isArray(section.tags) ? section.tags : undefined,
      }))
      : [],
    parameters,
    draft.narrative?.pacePattern,
  );
  const antiPatterns = Array.isArray(draft.antiPatterns)
    ? draft.antiPatterns.filter((item): item is string => typeof item === 'string')
    : [];
  const voice = {
    person: normalizeVoicePerson(draft.voice?.person),
    tone: typeof draft.voice?.tone === 'string' ? draft.voice.tone : '平实克制',
    density: normalizeVoiceDensity(draft.voice?.density),
    sampleTexts: Array.isArray(draft.voice?.sampleTexts)
      ? draft.voice?.sampleTexts.filter((item): item is string => typeof item === 'string')
      : [],
  } satisfies IStyleProfile['voice'];
  const derived = deriveStyleProtocolV2Fields(sections, parameters, antiPatterns, voice);

  return {
    id: randomUUID(),
    name: '自动分析风格',
    sourceFiles: reports.map(report => report.sourceFile),
    narrative: {
      introRatio: typeof draft.narrative?.introRatio === 'number' ? draft.narrative.introRatio : 0.08,
      outroRatio: typeof draft.narrative?.outroRatio === 'number' ? draft.narrative.outroRatio : 0.05,
      avgSegmentDurationSec: typeof draft.narrative?.avgSegmentDurationSec === 'number' ? draft.narrative.avgSegmentDurationSec : 25,
      brollFrequency: typeof draft.narrative?.brollFrequency === 'number' ? draft.narrative.brollFrequency : 0.3,
      pacePattern: typeof draft.narrative?.pacePattern === 'string' ? draft.narrative.pacePattern : '均匀推进',
    },
    voice,
    sections,
    antiPatterns,
    parameters,
    arrangementStructure: derived.arrangementStructure,
    narrationConstraints: derived.narrationConstraints,
    createdAt: now,
    updatedAt: now,
  };
}

function normalizeStageReview(
  raw: Partial<IStageReview> | undefined,
  input: {
    stage: string;
    identity: string;
    attempt: number;
    defaultCodes: readonly string[];
  },
): IStageReview {
  const issues = Array.isArray(raw?.issues)
    ? raw.issues
      .filter((issue): issue is NonNullable<IStageReview['issues']>[number] => Boolean(issue && typeof issue === 'object'))
      .map(issue => ({
        code: input.defaultCodes.includes(issue.code) ? issue.code : input.defaultCodes[0],
        severity: issue.severity === 'warning' ? 'warning' as const : 'blocker' as const,
        message: typeof issue.message === 'string' && issue.message.trim()
          ? issue.message.trim()
          : 'reviewer returned an empty issue message.',
        details: typeof issue.details === 'string' && issue.details.trim() ? issue.details.trim() : undefined,
      }))
    : [];
  const hasBlocker = issues.some(issue => issue.severity === 'blocker');
  const verdict = raw?.verdict === 'pass' && !hasBlocker
    ? 'pass'
    : raw?.verdict === 'awaiting_user'
      ? 'awaiting_user'
      : hasBlocker
        ? 'revise'
        : 'pass';
  const revisionBrief = Array.isArray(raw?.revisionBrief)
    ? raw.revisionBrief.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];

  return {
    stage: input.stage,
    identity: input.identity,
    attempt: input.attempt,
    verdict,
    issues,
    revisionBrief: hasBlocker && revisionBrief.length === 0
      ? ['请根据 review issues 回到 evidence-first 原则，保守重写。']
      : revisionBrief,
    reviewedAt: typeof raw?.reviewedAt === 'string' && raw.reviewedAt.trim()
      ? raw.reviewedAt
      : new Date().toISOString(),
  };
}

async function persistStyleAgentSummary(
  summary: IStylePreparationSummaryDocument,
  options?: IAnalyzeStyleOptions,
): Promise<void> {
  if (!options?.workspaceRoot || !options.categoryId) return;
  await writeJson(getStyleAgentSummaryPath(options.workspaceRoot, options.categoryId), summary);
}

async function persistStylePacket(
  stage: 'style-profile-synthesizer' | 'style-profile-reviewer',
  packet: IAgentPacket,
  options?: IAnalyzeStyleOptions,
): Promise<void> {
  if (!options?.workspaceRoot || !options.categoryId) return;
  await writeJson(getStyleAgentPacketPath(options.workspaceRoot, options.categoryId, stage), packet);
}

async function persistStyleDraft(
  draft: IStyleDraftDocument,
  options?: IAnalyzeStyleOptions,
): Promise<void> {
  if (!options?.workspaceRoot || !options.categoryId) return;
  await writeJson(getStyleDraftPath(options.workspaceRoot, options.categoryId), draft);
}

async function persistStyleReview(
  review: IStageReview,
  options?: IAnalyzeStyleOptions,
): Promise<void> {
  if (!options?.workspaceRoot || !options.categoryId) return;
  await writeJson(getStyleReviewPath(options.workspaceRoot, options.categoryId), review);
}

function buildSummaryAggregate(
  reports: IStyleReferenceVideoAnalysis[],
): IStylePreparationSummaryDocument['aggregate'] {
  const sceneTypes = new Map<string, number>();
  const moods = new Map<string, number>();
  const narrativeRoles = new Map<string, number>();
  let totalShotCount = 0;
  let totalCutsPerMinute = 0;

  for (const report of reports) {
    totalShotCount += report.rhythm?.shotCount ?? 0;
    totalCutsPerMinute += report.rhythm?.cutsPerMinute ?? 0;
    for (const recognition of report.shotRecognitions ?? []) {
      incrementCount(sceneTypes, recognition.recognition.sceneType);
      incrementCount(moods, recognition.recognition.mood);
      incrementCount(narrativeRoles, recognition.recognition.narrativeRole);
    }
  }

  return {
    totalShotCount,
    averageCutsPerMinute: reports.length > 0
      ? roundTo(totalCutsPerMinute / reports.length, 2)
      : 0,
    commonSceneTypes: topKeys(sceneTypes),
    commonMoods: topKeys(moods),
    commonNarrativeRoles: topKeys(narrativeRoles),
  };
}

function normalizeParameters(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object') return {};
  return Object.fromEntries(
    Object.entries(raw as Record<string, unknown>)
      .filter(([, value]) => typeof value === 'string' && value.trim().length > 0)
      .map(([key, value]) => [key.trim(), (value as string).trim()]),
  );
}

function normalizeSections(
  sections: IStyleProfile['sections'],
  parameters: Record<string, string>,
  pacePattern?: string,
): NonNullable<IStyleProfile['sections']> {
  const normalized = (sections ?? []).map(section => ({ ...section }));
  const rhythmIndex = normalized.findIndex(section =>
    section.title.includes('节奏') || section.title.includes('素材编排'),
  );
  const contractBlock = buildRhythmContractBlock(parameters, pacePattern);

  if (rhythmIndex >= 0) {
    const current = normalized[rhythmIndex]!;
    if (!current.content.includes('照片使用策略')) {
      normalized[rhythmIndex] = {
        ...current,
        content: `${current.content.trim()}\n\n${contractBlock}`.trim(),
      };
    }
    return normalized;
  }

  return [
    ...normalized,
    {
      id: `section-${normalized.length + 1}`,
      title: '剪辑节奏与素材编排',
      content: contractBlock,
      tags: ['material-grammar', 'rhythm'],
    },
  ];
}

function buildRhythmContractBlock(
  parameters: Record<string, string>,
  pacePattern?: string,
): string {
  return [
    pacePattern ? `整体节奏：${pacePattern}` : '',
    ...CRHYTHM_MATERIAL_PARAMETER_KEYS.map(key => `${key}：${parameters[key] ?? '未明确'}`),
  ].filter(Boolean).join('\n');
}

function normalizeVoicePerson(value: unknown): IStyleProfile['voice']['person'] {
  if (value === '2nd') return '2nd';
  if (value === '3rd') return '3rd';
  return '1st';
}

function normalizeVoiceDensity(value: unknown): IStyleProfile['voice']['density'] {
  if (value === 'low') return 'low';
  if (value === 'high') return 'high';
  return 'moderate';
}

function incrementCount(map: Map<string, number>, value?: string): void {
  const key = value?.trim();
  if (!key) return;
  map.set(key, (map.get(key) ?? 0) + 1);
}

function topKeys(map: Map<string, number>, limit = 5): string[] {
  return [...map.entries()]
    .sort((left, right) => {
      if (right[1] !== left[1]) return right[1] - left[1];
      return left[0].localeCompare(right[0]);
    })
    .slice(0, limit)
    .map(([key]) => key);
}

function roundTo(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
