import { randomUUID } from 'node:crypto';
import type { IStyleProfile } from '../../protocol/schema.js';
import type { ILlmClient } from '../llm/client.js';
import type { IRhythmStats } from '../media/shot-detect.js';
import type { IShotRecognition } from '../media/recognizer.js';
import {
  CRHYTHM_MATERIAL_PARAMETER_KEYS,
  ensureRhythmMaterialParameterKeys,
} from './style-rhythm.js';
import { deriveStyleProtocolV2Fields } from './style-loader.js';

const CRHYTHM_PARAMETER_GUIDE = CRHYTHM_MATERIAL_PARAMETER_KEYS
  .map(key => `- ${key}`)
  .join('\n');

const CPROMPT = `你是一个视频风格分析专家。你会先阅读每个参考视频的单独分析，再综合归纳出共同风格。

输入中的每个视频报告可能包含：
- 内容洞察
- 剪辑节奏统计
- 逐镜头视觉分析
- ASR 转写文本
- 用户给的指导词

请返回 JSON：
{
  "narrative": {
    "introRatio": 0.0-1.0,
    "outroRatio": 0.0-1.0,
    "avgSegmentDurationSec": number,
    "brollFrequency": 0.0-1.0,
    "pacePattern": "中文短句"
  },
  "voice": {
    "person": "1st" | "2nd" | "3rd",
    "tone": "中文短句",
    "density": "low" | "moderate" | "high",
    "sampleTexts": ["示例句子"]
  },
  "sections": [
    { "title": "章节名", "content": "该维度分析", "tags": ["可选标签"] }
  ],
  "antiPatterns": ["应避免的表达方式"],
  "parameters": {
    "主轴": "一句话说明主要编排轴",
    "辅助轴": "可选，多个用 / 分隔",
    "章节切分原则": "一句可执行规则",
    "章节转场": "一句可执行规则",
    "旁白视角": "一句可执行规则",
    "旁白备注": "可选，多个用 / 分隔"
  }
}

要求：
- sections 中必须包含一个专门讨论“剪辑节奏与素材编排”的章节。
- parameters 至少补齐下面这些节奏素材参数；不明显时也要明确写“少用 / 不明显 / 偶尔出现”：
${CRHYTHM_PARAMETER_GUIDE}
- 不要输出旧的 arrangementBias / segmentArchetypes / transitionRules / functionBlocks。`;

export interface IStyleReferenceVideoAnalysis {
  sourceFile: string;
  transcript?: string;
  guidancePrompt?: string;
  contentInsights?: string[];
  rhythm?: Partial<IRhythmStats>;
  shotRecognitions?: IShotRecognition[];
}

export async function analyzeStyle(
  llm: ILlmClient,
  sourceFiles: string[],
  transcripts: string[],
): Promise<IStyleProfile> {
  const reports: IStyleReferenceVideoAnalysis[] = sourceFiles.map((sourceFile, index) => ({
    sourceFile,
    transcript: transcripts[index],
  }));
  return analyzeStyleFromReports(llm, reports);
}

export async function analyzeStyleFromReports(
  llm: ILlmClient,
  reports: IStyleReferenceVideoAnalysis[],
): Promise<IStyleProfile> {
  const combined = reports
    .map((report, index) => formatReferenceReport(report, index))
    .join('\n\n');

  const raw = await llm.chat([
    { role: 'system', content: CPROMPT },
    { role: 'user', content: combined },
  ], { jsonMode: true, temperature: 0.3, maxTokens: 4000 });

  const parsed = JSON.parse(raw);
  const now = new Date().toISOString();
  const parameters = ensureRhythmMaterialParameterKeys(
    normalizeParameters(parsed.parameters),
    '未明确',
  );
  const sections = normalizeSections(
    Array.isArray(parsed.sections)
      ? parsed.sections.map((section: any, index: number) => ({
        id: `section-${index + 1}`,
        title: section.title ?? `分析 ${index + 1}`,
        content: section.content ?? '',
        tags: Array.isArray(section.tags) ? section.tags : undefined,
      }))
      : [],
    parameters,
    parsed.narrative?.pacePattern,
  );
  const antiPatterns = Array.isArray(parsed.antiPatterns)
    ? parsed.antiPatterns.filter((item: unknown): item is string => typeof item === 'string')
    : [];
  const voice = {
    person: normalizeVoicePerson(parsed.voice?.person),
    tone: typeof parsed.voice?.tone === 'string' ? parsed.voice.tone : '平实克制',
    density: normalizeVoiceDensity(parsed.voice?.density),
    sampleTexts: Array.isArray(parsed.voice?.sampleTexts)
      ? parsed.voice.sampleTexts.filter((item: unknown): item is string => typeof item === 'string')
      : [],
  } satisfies IStyleProfile['voice'];
  const derived = deriveStyleProtocolV2Fields(sections, parameters, antiPatterns, voice);

  return {
    id: randomUUID(),
    name: '自动分析风格',
    sourceFiles: reports.map(report => report.sourceFile),
    narrative: {
      introRatio: typeof parsed.narrative?.introRatio === 'number' ? parsed.narrative.introRatio : 0.08,
      outroRatio: typeof parsed.narrative?.outroRatio === 'number' ? parsed.narrative.outroRatio : 0.05,
      avgSegmentDurationSec: typeof parsed.narrative?.avgSegmentDurationSec === 'number' ? parsed.narrative.avgSegmentDurationSec : 25,
      brollFrequency: typeof parsed.narrative?.brollFrequency === 'number' ? parsed.narrative.brollFrequency : 0.3,
      pacePattern: typeof parsed.narrative?.pacePattern === 'string' ? parsed.narrative.pacePattern : '均匀推进',
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

function formatReferenceReport(
  report: IStyleReferenceVideoAnalysis,
  index: number,
): string {
  const blocks: string[] = [
    `--- 参考视频 ${index + 1}: ${report.sourceFile} ---`,
  ];

  if (report.guidancePrompt?.trim()) {
    blocks.push(`指导词：\n${report.guidancePrompt.trim()}`);
  }

  if (report.contentInsights?.length) {
    blocks.push([
      '内容洞察：',
      ...report.contentInsights.map(item => `- ${item}`),
    ].join('\n'));
  }

  if (report.rhythm) {
    blocks.push([
      '剪辑节奏统计：',
      `- shotCount: ${report.rhythm.shotCount ?? 'unknown'}`,
      `- cutsPerMinute: ${report.rhythm.cutsPerMinute ?? 'unknown'}`,
      `- shotDurationMs.mean: ${report.rhythm.shotDurationMs?.mean ?? 'unknown'}`,
      `- shotDurationMs.median: ${report.rhythm.shotDurationMs?.median ?? 'unknown'}`,
      `- introRhythm: ${report.rhythm.introRhythm ?? 'unknown'}`,
      `- bodyRhythm: ${report.rhythm.bodyRhythm ?? 'unknown'}`,
      `- outroRhythm: ${report.rhythm.outroRhythm ?? 'unknown'}`,
    ].join('\n'));
  }

  if (report.shotRecognitions?.length) {
    const sceneCounts = countBy(report.shotRecognitions.map(item => item.recognition.sceneType));
    const moodCounts = countBy(report.shotRecognitions.map(item => item.recognition.mood));
    const narrativeRoleCounts = countBy(report.shotRecognitions.map(item => item.recognition.narrativeRole));
    const samples = report.shotRecognitions
      .slice(0, 12)
      .map(item => `- ${item.shotId} (${item.startMs}-${item.endMs}): ${item.recognition.description}`);
    blocks.push([
      '逐镜头视觉分析摘要：',
      `- sceneTypes: ${formatCounts(sceneCounts)}`,
      `- moods: ${formatCounts(moodCounts)}`,
      `- narrativeRoles: ${formatCounts(narrativeRoleCounts)}`,
      '镜头样本：',
      ...samples,
    ].join('\n'));
  }

  if (report.transcript?.trim()) {
    blocks.push(`ASR 转写：\n${report.transcript.trim()}`);
  }

  return blocks.join('\n\n');
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

function countBy(values: Array<string | undefined>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) {
    const normalized = value?.trim();
    if (!normalized) continue;
    counts[normalized] = (counts[normalized] ?? 0) + 1;
  }
  return counts;
}

function formatCounts(counts: Record<string, number>): string {
  const entries = Object.entries(counts);
  if (entries.length === 0) return 'none';
  return entries
    .sort((left, right) => right[1] - left[1])
    .slice(0, 8)
    .map(([key, value]) => `${key}:${value}`)
    .join(', ');
}
