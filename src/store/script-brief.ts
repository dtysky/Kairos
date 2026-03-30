import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ISegmentPlanSegment } from '../protocol/schema.js';

export interface IScriptBriefSegmentTemplateInput {
  segmentId: string;
  title?: string;
  role?: string;
  targetDurationMs?: number;
  intent?: string;
  preferredClipTypes?: string[];
  preferredPlaceHints?: string[];
  notes?: string[];
}

export interface IScriptBriefTemplateInput {
  projectName: string;
  createdAt?: string;
  styleCategory?: string;
  statusText?: string;
  goalDraft?: string[];
  constraintDraft?: string[];
  planReviewDraft?: string[];
  segments?: Array<IScriptBriefSegmentTemplateInput | ISegmentPlanSegment>;
}

export function getScriptBriefPath(projectRoot: string): string {
  return join(projectRoot, 'script', 'script-brief.md');
}

export function buildScriptBriefTemplate(
  input: IScriptBriefTemplateInput,
): string {
  const createdAt = input.createdAt ?? new Date().toISOString();
  const styleCategory = input.styleCategory?.trim() || '（待指定）';
  const statusText = input.statusText?.trim() || '系统已根据素材分析生成一版初稿，请在此基础上审查和修改。';
  const segmentEntries = (input.segments ?? [])
    .map(normalizeSegmentTemplateInput)
    .map(buildSegmentBriefEntry)
    .join('\n\n');
  const goalDraft = (input.goalDraft?.length ? input.goalDraft : [
    '这支片想表达什么？',
    '观众看完后应该留下什么感觉？',
    '这次先做 intro / 正片中段 / 结尾中的哪一部分？',
  ]).map(line => `- ${line}`);
  const constraintDraft = (input.constraintDraft?.length ? input.constraintDraft : [
    '目标总时长：',
    '受众：',
    '禁区：',
  ]).map(line => `- ${line}`);
  const planReviewDraft = (input.planReviewDraft?.length ? input.planReviewDraft : [
    '更偏时间顺序 / 地点顺序 / 情绪顺序：',
    '哪些章节必须存在：',
    '哪些章节不要出现：',
    '哪些地方宁可留白，不要解释太满：',
    '选择方案：',
    '修改说明：',
  ]).map(line => `- ${line}`);

  return [
    `# ${input.projectName} — Script Brief`,
    '',
    `- 创建日期：${createdAt}`,
    `- 风格参考：${styleCategory}`,
    `- 当前状态：${statusText}`,
    '',
    '## 全片目标（系统初稿）',
    '',
    ...goalDraft,
    '',
    '## 叙事约束（系统初稿）',
    '',
    ...constraintDraft,
    '',
    '## 段落方案审查（请直接修改）',
    '',
    ...planReviewDraft,
    '',
    '## 章节备注（系统初稿）',
    '',
    segmentEntries || [
      '### [segment-id] 段落标题',
      '- 角色：scene',
      '- 目标时长：30s',
      '- 简单说明：',
      '- 画面/声音偏好：',
      '- 文案约束：',
    ].join('\n'),
    '',
  ].join('\n');
}

export async function writeScriptBriefTemplate(
  projectRoot: string,
  input: IScriptBriefTemplateInput,
): Promise<string> {
  const path = getScriptBriefPath(projectRoot);
  const content = buildScriptBriefTemplate(input);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, 'utf-8');
  return content;
}

export async function syncScriptBriefSegments(
  projectRoot: string,
  segments: Array<IScriptBriefSegmentTemplateInput | ISegmentPlanSegment>,
): Promise<string> {
  const path = getScriptBriefPath(projectRoot);
  const existing = await loadOptionalMarkdown(path);
  if (!existing) {
    const projectName = projectRoot.split(/[\\/]/).pop() ?? 'Kairos Project';
    return writeScriptBriefTemplate(projectRoot, {
      projectName,
      segments: segments.map(normalizeSegmentTemplateInput),
    });
  }

  const missing = segments
    .map(normalizeSegmentTemplateInput)
    .filter(segment => !hasSegmentBrief(existing, segment.segmentId));

  if (missing.length === 0) {
    return existing;
  }

  const next = appendSegmentBriefs(existing, missing);
  await writeFile(path, next, 'utf-8');
  return next;
}

export async function loadScriptBrief(projectRoot: string): Promise<string | undefined> {
  return loadOptionalMarkdown(getScriptBriefPath(projectRoot));
}

export async function seedScriptBriefDraft(
  projectRoot: string,
  input: IScriptBriefTemplateInput,
): Promise<string> {
  const existing = await loadScriptBrief(projectRoot);
  if (!existing || isScriptBriefScaffold(existing)) {
    return writeScriptBriefTemplate(projectRoot, input);
  }
  return syncScriptBriefSegments(projectRoot, input.segments ?? []);
}

export function extractSegmentBrief(
  scriptBrief: string | undefined,
  segmentId: string,
): string | undefined {
  if (!scriptBrief) return undefined;
  const escapedId = escapeRegExp(segmentId);
  const pattern = new RegExp(
    String.raw`^### \[${escapedId}\][^\n]*\n([\s\S]*?)(?=^### \[|^## |\Z)`,
    'm',
  );
  const match = scriptBrief.match(pattern);
  return match ? match[0].trim() : undefined;
}

export async function loadOptionalMarkdown(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf-8');
  } catch {
    return undefined;
  }
}

function buildSegmentBriefEntry(
  input: IScriptBriefSegmentTemplateInput,
): string {
  const title = input.title?.trim() || input.segmentId;
  const role = input.role?.trim() || 'scene';
  const targetSeconds = typeof input.targetDurationMs === 'number'
    ? `${Math.round(input.targetDurationMs / 1000)}s`
    : '（待定）';

  return [
    `### [${input.segmentId}] ${title}`,
    `- 角色：${role}`,
    `- 目标时长：${targetSeconds}`,
    `- 简单说明：${input.intent?.trim() || ''}`,
    `- 画面/声音偏好：${buildVisualPreference(input)}`,
    `- 文案约束：${buildConstraintHint(input)}`,
  ].join('\n');
}

function normalizeSegmentTemplateInput(
  input: IScriptBriefSegmentTemplateInput | ISegmentPlanSegment,
): IScriptBriefSegmentTemplateInput {
  const segmentId = 'segmentId' in input ? input.segmentId : input.id;
  return {
    segmentId,
    title: input.title,
    role: input.role,
    targetDurationMs: input.targetDurationMs,
    intent: 'intent' in input ? input.intent : undefined,
    preferredClipTypes: 'preferredClipTypes' in input ? input.preferredClipTypes : undefined,
    preferredPlaceHints: 'preferredPlaceHints' in input ? input.preferredPlaceHints : undefined,
    notes: 'notes' in input ? input.notes : undefined,
  };
}

function hasSegmentBrief(scriptBrief: string, segmentId: string): boolean {
  const escapedId = escapeRegExp(segmentId);
  return new RegExp(String.raw`^### \[${escapedId}\]`, 'm').test(scriptBrief);
}

function appendSegmentBriefs(
  scriptBrief: string,
  segments: IScriptBriefSegmentTemplateInput[],
): string {
  const entries = segments.map(buildSegmentBriefEntry).join('\n\n');
  const trimmed = scriptBrief.trimEnd();

  if (/^## 章节备注/m.test(trimmed)) {
    return `${trimmed}\n\n${entries}\n`;
  }

  return `${trimmed}\n\n## 章节备注\n\n${entries}\n`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isScriptBriefScaffold(content: string): boolean {
  return content.includes('当前状态：待填写脚本创作 brief')
    || content.includes('当前状态：等待用户指定风格后再开始脚本阶段')
    || (content.includes('## 当前输入') && content.includes('## 需要用户指定'))
    || content.includes('这支片想表达什么？')
    || content.includes('### [segment-id] 段落标题');
}

function buildVisualPreference(input: IScriptBriefSegmentTemplateInput): string {
  const parts: string[] = [];
  if (input.preferredClipTypes?.length) {
    parts.push(`优先 ${input.preferredClipTypes.join(' / ')}`);
  }
  if (input.preferredPlaceHints?.length) {
    parts.push(`地点线索 ${input.preferredPlaceHints.join(' / ')}`);
  }
  return parts.join('；') || '';
}

function buildConstraintHint(input: IScriptBriefSegmentTemplateInput): string {
  return input.notes?.join('；') || '';
}
