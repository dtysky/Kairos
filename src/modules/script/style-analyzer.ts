import type { IStyleProfile } from '../../protocol/schema.js';
import type { ILlmClient } from '../llm/client.js';
import type { IRhythmStats } from '../media/shot-detect.js';
import type { IShotRecognition } from '../media/recognizer.js';
import { randomUUID } from 'node:crypto';

const CPROMPT = `你是一个视频风格分析专家。你会先阅读每个参考视频的单独分析，再综合归纳出共同风格。

输入中的每个视频报告可能包含：
- 内容洞察（content insights）
- 剪辑节奏统计（rhythm）
- 逐镜头视觉分析（shot recognitions）
- ASR 转写文本（transcript）
- 用户给的指导词（guidance prompt）

请先在脑中完成两层工作：
1. 先理解每一个视频自己的风格特征，不要急着混合。
2. 再提炼这些视频之间反复出现的共同表达方式，形成稳定风格。

最终只返回“共同风格”，不要把多条视频简单并列复述。

返回 JSON 格式：
{
  "narrative": {
    "introRatio": 0.0-1.0,
    "outroRatio": 0.0-1.0,
    "avgSegmentDurationSec": number,
    "brollFrequency": 0.0-1.0,
    "pacePattern": "用中文描述整体节奏"
  },
  "voice": {
    "person": "1st" | "2nd" | "3rd",
    "tone": "用中文描述语气风格",
    "density": "low" | "moderate" | "high",
    "sampleTexts": ["2-3 句最能代表风格的原文"]
  },
  "sections": [
    { "title": "章节名", "content": "该维度的详细分析" }
  ],
  "antiPatterns": ["应避免的表达方式，每条一个字符串"],
  "parameters": { "参数名": "参数值" }
}

请至少分析以下维度并放入 sections：
1. 叙事结构（段落组织方式、开头结尾惯例）
2. 语言风格（句式特征、用词偏好）
3. 情绪层次（情绪光谱、表达克制度）
4. 视觉语言（画面描写惯例、运镜/光线词汇）`;

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

  const sections = (parsed.sections ?? []).map((s: any, i: number) => ({
    id: `section-${i + 1}`,
    title: s.title ?? `分析 ${i + 1}`,
    content: s.content ?? '',
    tags: s.tags,
  }));

  return {
    id: randomUUID(),
    name: '自动分析风格',
    sourceFiles: reports.map(report => report.sourceFile),
    narrative: {
      introRatio: parsed.narrative?.introRatio ?? 0.08,
      outroRatio: parsed.narrative?.outroRatio ?? 0.05,
      avgSegmentDurationSec: parsed.narrative?.avgSegmentDurationSec ?? 25,
      brollFrequency: parsed.narrative?.brollFrequency ?? 0.3,
      pacePattern: parsed.narrative?.pacePattern ?? '均匀',
    },
    voice: {
      person: parsed.voice?.person ?? '1st',
      tone: parsed.voice?.tone ?? '平实',
      density: parsed.voice?.density ?? 'moderate',
      sampleTexts: parsed.voice?.sampleTexts ?? [],
    },
    sections,
    antiPatterns: parsed.antiPatterns ?? [],
    parameters: parsed.parameters ?? {},
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

function countBy(values: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) {
    const key = value || 'unknown';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function formatCounts(counts: Map<string, number>): string {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([key, value]) => `${key}:${value}`)
    .join(', ');
}
