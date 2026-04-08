import type { IStyleProfile } from '../../protocol/schema.js';
import type { ILlmClient } from '../llm/client.js';
import type { IRhythmStats } from '../media/shot-detect.js';
import type { IShotRecognition } from '../media/recognizer.js';
import { randomUUID } from 'node:crypto';
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

要求：
- sections 中必须包含一个专门讨论“剪辑节奏与素材编排”的章节，重点回答：
  - 是否会使用照片素材，照片通常是少量点缀、成组出现，还是与视频交替
  - 延时摄影更像建立场、转场、情绪抬升，还是独立段落
  - 航拍通常在什么时候插入：开场建场、地理重置、过渡、高潮抬升、情绪释放
  - 空镜/B-roll 在节奏里承担什么作用
  - 节奏通常因什么而抬升
- parameters 里至少给出以下稳定 key；如果某项不明显，也要用中文短句明确写“少用 / 不明显 / 偶尔出现”等：
${CRHYTHM_PARAMETER_GUIDE}
- 这些 key 的值应是简短但可执行的规则，而不是抽象空话

请至少分析以下维度并放入 sections：
1. 叙事结构（段落组织方式、开头结尾惯例）
2. 语言风格（句式特征、用词偏好）
3. 情绪层次（情绪光谱、表达克制度）
4. 视觉语言（画面描写惯例、运镜/光线词汇）
5. 剪辑节奏与素材编排（照片、延时、航拍、空镜/B-roll、节奏抬升）`;

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
  const sections = normalizeSections((parsed.sections ?? []).map((s: any, i: number) => ({
    id: `section-${i + 1}`,
    title: s.title ?? `分析 ${i + 1}`,
    content: s.content ?? '',
    tags: s.tags,
  })), parameters, parsed.narrative?.pacePattern);
  const derived = deriveStyleProtocolV2Fields(sections, parameters, parsed.antiPatterns ?? []);

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
    parameters,
    arrangementBias: derived.arrangementBias,
    arrangementStructure: derived.arrangementStructure,
    segmentArchetypes: derived.segmentArchetypes,
    transitionRules: derived.transitionRules,
    functionBlocks: derived.functionBlocks,
    globalConstraints: derived.globalConstraints,
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
    const materialGrammar = formatMaterialGrammarEvidence(report.shotRecognitions);
    if (materialGrammar.length > 0) {
      blocks.push(materialGrammar.join('\n'));
    }
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
  const contractBlock = buildRhythmMaterialContractBlock(parameters, pacePattern);
  const rhythmIndex = normalized.findIndex(section =>
    section.title.includes('节奏') || section.title.includes('素材编排'),
  );

  if (rhythmIndex >= 0) {
    const current = normalized[rhythmIndex]!;
    if (!containsRhythmMaterialContract(current.content)) {
      normalized[rhythmIndex] = {
        ...current,
        content: `${current.content.trim()}\n\n${contractBlock}`.trim(),
      };
    }
    return normalized;
  }

  normalized.push({
    id: `section-${normalized.length + 1}`,
    title: '剪辑节奏与素材编排',
    content: contractBlock,
    tags: ['rhythm', 'editing', 'material-grammar'],
  });
  return normalized;
}

function buildRhythmMaterialContractBlock(
  parameters: Record<string, string>,
  pacePattern?: string,
): string {
  return [
    pacePattern ? `整体节奏：${pacePattern}` : undefined,
    '素材编排语法：',
    `- 照片素材：${parameters['照片使用策略'] ?? '未明确'}`,
    `- 照片编排方式：${parameters['照片编排方式'] ?? '未明确'}`,
    `- 延时摄影：${parameters['延时使用关系'] ?? '未明确'}`,
    `- 航拍插入时机：${parameters['航拍插入时机'] ?? '未明确'}`,
    `- 空镜/B-roll：${parameters['空镜/B-roll 关系'] ?? '未明确'}`,
    `- 节奏抬升触发点：${parameters['节奏抬升触发点'] ?? '未明确'}`,
  ].filter(Boolean).join('\n');
}

function containsRhythmMaterialContract(content: string): boolean {
  return [
    '照片素材',
    '照片编排方式',
    '延时摄影',
    '航拍插入时机',
    '空镜/B-roll',
    '节奏抬升触发点',
  ].every(keyword => content.includes(keyword));
}

function formatMaterialGrammarEvidence(
  shotRecognitions: IShotRecognition[],
): string[] {
  if (shotRecognitions.length === 0) return [];

  const totalDurationMs = Math.max(
    ...shotRecognitions.map(item => Math.max(item.endMs, item.startMs)),
    1,
  );
  const aerialShots = shotRecognitions.filter(item => item.recognition.sceneType === 'aerial');
  const establishingShots = shotRecognitions.filter(item =>
    item.recognition.narrativeRole === 'establishing' || item.recognition.narrativeRole === 'intro',
  );
  const transitionShots = shotRecognitions.filter(item => item.recognition.narrativeRole === 'transition');
  const photoLikeShots = filterRecognitionCandidates(shotRecognitions, [
    'photo',
    'photograph',
    'still image',
    'still frame',
    'archival',
    'archive',
    'snapshot',
    'postcard',
    '照片',
    '相片',
    '静帧',
  ]);
  const timelapseShots = filterRecognitionCandidates(shotRecognitions, [
    'timelapse',
    'time-lapse',
    'time lapse',
    'star trail',
    'light trail',
    'fast-moving cloud',
    'sped-up',
    'accelerated',
    '延时',
    '车流',
    '星轨',
  ]);
  const contextBrollShots = shotRecognitions.filter(item =>
    item.recognition.narrativeRole === 'detail'
    || item.recognition.narrativeRole === 'transition'
    || item.recognition.narrativeRole === 'filler'
    || item.recognition.narrativeRole === 'establishing',
  );

  return [
    '素材编排线索：',
    `- aerialShots: ${aerialShots.length}${formatPhaseDistribution(aerialShots, totalDurationMs)}`,
    `- establishingShots: ${establishingShots.length}${formatPhaseDistribution(establishingShots, totalDurationMs)}`,
    `- transitionShots: ${transitionShots.length}${formatPhaseDistribution(transitionShots, totalDurationMs)}`,
    `- timelapseCandidates: ${timelapseShots.length}${formatPhaseDistribution(timelapseShots, totalDurationMs)}`,
    `- stillPhotoLikeCandidates: ${photoLikeShots.length}${formatPhaseDistribution(photoLikeShots, totalDurationMs)}`,
    `- contextBrollLikeShots: ${contextBrollShots.length}`,
    ...formatCandidateExamples('航拍样本', aerialShots),
    ...formatCandidateExamples('延时候选样本', timelapseShots),
    ...formatCandidateExamples('照片候选样本', photoLikeShots),
  ];
}

function filterRecognitionCandidates(
  shots: IShotRecognition[],
  keywords: string[],
): IShotRecognition[] {
  return shots.filter(item => {
    const haystack = [
      item.recognition.description,
      ...item.recognition.subjects,
      item.recognition.narrativeRole,
      item.recognition.sceneType,
    ].join(' ').toLowerCase();
    return keywords.some(keyword => haystack.includes(keyword.toLowerCase()));
  });
}

function formatPhaseDistribution(
  shots: IShotRecognition[],
  totalDurationMs: number,
): string {
  if (shots.length === 0 || totalDurationMs <= 0) return '';
  const counts = { intro: 0, body: 0, outro: 0 };
  const third = totalDurationMs / 3;

  for (const shot of shots) {
    const pivot = shot.startMs;
    if (pivot < third) counts.intro += 1;
    else if (pivot < third * 2) counts.body += 1;
    else counts.outro += 1;
  }

  return ` (intro:${counts.intro}, body:${counts.body}, outro:${counts.outro})`;
}

function formatCandidateExamples(
  label: string,
  shots: IShotRecognition[],
): string[] {
  if (shots.length === 0) return [];
  const examples = shots
    .slice(0, 3)
    .map(item => `${item.shotId}:${item.recognition.description}`);
  return [`- ${label}: ${examples.join(' | ')}`];
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
