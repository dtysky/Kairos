import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type {
  EScriptBriefWorkflowState as TScriptBriefWorkflowState,
  IScriptBriefConfig as TScriptBriefConfig,
  ISegmentPlanSegment,
} from '../protocol/schema.js';

const CSCRIPT_BRIEF_META_PREFIX = '<!-- kairos:script-brief-meta';
const CSCRIPT_BRIEF_META_SUFFIX = '-->';

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
  workflowState?: TScriptBriefWorkflowState;
  lastAgentDraftAt?: string;
  lastUserReviewAt?: string;
  lastAgentDraftFingerprint?: string;
  briefOverwriteApprovedAt?: string;
  styleReferenceLabel?: string;
  statusText?: string;
  goalDraft?: string[];
  constraintDraft?: string[];
  planReviewDraft?: string[];
  segments?: Array<IScriptBriefSegmentTemplateInput | ISegmentPlanSegment>;
}

export interface IScriptBriefWorkflowMetadata {
  workflowState?: TScriptBriefWorkflowState;
  lastAgentDraftAt?: string;
  lastUserReviewAt?: string;
  lastAgentDraftFingerprint?: string;
  briefOverwriteApprovedAt?: string;
}

type TScriptBriefFingerprintInput = Pick<
  TScriptBriefConfig,
  'goalDraft' | 'constraintDraft' | 'planReviewDraft' | 'segments'
>;

export function getScriptBriefPath(projectRoot: string): string {
  return join(projectRoot, 'script', 'script-brief.md');
}

export function describeScriptBriefWorkflowState(
  workflowState: TScriptBriefWorkflowState,
): string {
  switch (workflowState) {
    case 'choose_style':
      return '请先在 /script 选择风格分类。';
    case 'await_brief_draft':
      return '风格已保存，请回到 Agent 生成初版 brief。';
    case 'review_brief':
      return '初版 brief 已生成，请在 /script 审查并保存。';
    case 'ready_to_prepare':
      return 'brief 已保存，请点击 准备给 Agent。';
    case 'ready_for_agent':
      return '脚本准备已完成，请回到 Agent 继续生成 script/current.json。';
    case 'script_generated':
      return '脚本已生成，可继续审稿或进入 Timeline。';
    default:
      return '请先在 /script 选择风格分类。';
  }
}

export function inferScriptBriefWorkflowState(input: {
  workflowState?: string;
  styleCategory?: string;
  statusText?: string;
  lastAgentDraftAt?: string;
  lastUserReviewAt?: string;
  lastAgentDraftFingerprint?: string;
  briefOverwriteApprovedAt?: string;
}): TScriptBriefWorkflowState {
  if (isScriptBriefWorkflowState(input.workflowState)) {
    return input.workflowState;
  }

  if (!input.styleCategory?.trim()) {
    return 'choose_style';
  }

  const normalizedStatus = input.statusText?.trim() ?? '';
  if (/脚本已生成/u.test(normalizedStatus)) {
    return 'script_generated';
  }
  if (/准备已完成/u.test(normalizedStatus) || /回到 Agent .*script\/current\.json/u.test(normalizedStatus)) {
    return 'ready_for_agent';
  }
  if (input.briefOverwriteApprovedAt?.trim()) {
    return 'await_brief_draft';
  }
  if (input.lastUserReviewAt?.trim()) {
    return 'ready_to_prepare';
  }
  if (input.lastAgentDraftAt?.trim() || input.lastAgentDraftFingerprint?.trim()) {
    return 'review_brief';
  }
  if (/审查/u.test(normalizedStatus) || /review/u.test(normalizedStatus)) {
    return 'review_brief';
  }
  return 'await_brief_draft';
}

export function computeScriptBriefFingerprint(
  input: TScriptBriefFingerprintInput,
): string {
  const payload = normalizeScriptBriefFingerprintPayload(input);
  return hashScriptBriefFingerprintPayload(JSON.stringify(payload));
}

export function parseScriptBriefWorkflowMetadata(
  markdown: string,
): IScriptBriefWorkflowMetadata {
  const match = markdown.match(
    /<!--\s*kairos:script-brief-meta\s*\n([\s\S]*?)\n-->/u,
  );
  if (!match?.[1]) {
    return {};
  }

  const metadata: IScriptBriefWorkflowMetadata = {};
  for (const rawLine of match[1].split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const separatorIndex = line.indexOf('=');
    if (separatorIndex < 0) continue;
    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim();
    if (!value) continue;
    switch (key) {
      case 'workflowState':
        if (isScriptBriefWorkflowState(value)) {
          metadata.workflowState = value;
        }
        break;
      case 'lastAgentDraftAt':
        metadata.lastAgentDraftAt = value;
        break;
      case 'lastUserReviewAt':
        metadata.lastUserReviewAt = value;
        break;
      case 'lastAgentDraftFingerprint':
        metadata.lastAgentDraftFingerprint = value;
        break;
      case 'briefOverwriteApprovedAt':
        metadata.briefOverwriteApprovedAt = value;
        break;
      default:
        break;
    }
  }
  return metadata;
}

export function buildScriptBriefTemplate(
  input: IScriptBriefTemplateInput,
): string {
  const createdAt = input.createdAt ?? new Date().toISOString();
  const workflowState = input.workflowState
    ?? inferScriptBriefWorkflowState({
      styleCategory: input.styleCategory,
      statusText: input.statusText,
      lastAgentDraftAt: input.lastAgentDraftAt,
      lastUserReviewAt: input.lastUserReviewAt,
      lastAgentDraftFingerprint: input.lastAgentDraftFingerprint,
      briefOverwriteApprovedAt: input.briefOverwriteApprovedAt,
    });
  const styleReference = input.styleReferenceLabel?.trim()
    || input.styleCategory?.trim()
    || '（待指定）';
  const statusText = input.statusText?.trim() || describeScriptBriefWorkflowState(workflowState);
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
    buildScriptBriefWorkflowMetadataBlock({
      workflowState,
      lastAgentDraftAt: input.lastAgentDraftAt,
      lastUserReviewAt: input.lastUserReviewAt,
      lastAgentDraftFingerprint: input.lastAgentDraftFingerprint,
      briefOverwriteApprovedAt: input.briefOverwriteApprovedAt,
    }),
    '',
    `- 创建日期：${createdAt}`,
    `- 风格参考：${styleReference}`,
    `- 当前状态：${statusText}`,
    '',
    '## 全片目标',
    '',
    ...goalDraft,
    '',
    '## 叙事约束',
    '',
    ...constraintDraft,
    '',
    '## 段落方案审查（请直接修改）',
    '',
    ...planReviewDraft,
    '',
    '## 章节备注',
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

function buildScriptBriefWorkflowMetadataBlock(
  metadata: Required<Pick<IScriptBriefWorkflowMetadata, 'workflowState'>> & IScriptBriefWorkflowMetadata,
): string {
  const lines = [
    `workflowState=${metadata.workflowState}`,
    metadata.lastAgentDraftAt ? `lastAgentDraftAt=${metadata.lastAgentDraftAt}` : '',
    metadata.lastUserReviewAt ? `lastUserReviewAt=${metadata.lastUserReviewAt}` : '',
    metadata.lastAgentDraftFingerprint ? `lastAgentDraftFingerprint=${metadata.lastAgentDraftFingerprint}` : '',
    metadata.briefOverwriteApprovedAt ? `briefOverwriteApprovedAt=${metadata.briefOverwriteApprovedAt}` : '',
  ].filter(Boolean);
  return `${CSCRIPT_BRIEF_META_PREFIX}\n${lines.join('\n')}\n${CSCRIPT_BRIEF_META_SUFFIX}`;
}

function normalizeScriptBriefFingerprintPayload(
  input: TScriptBriefFingerprintInput,
): TScriptBriefFingerprintInput {
  return {
    goalDraft: normalizeLines(input.goalDraft),
    constraintDraft: normalizeLines(input.constraintDraft),
    planReviewDraft: normalizeLines(input.planReviewDraft),
    segments: (input.segments ?? []).map(segment => ({
      segmentId: segment.segmentId.trim(),
      title: segment.title?.trim() || undefined,
      role: segment.role?.trim() || undefined,
      targetDurationMs: segment.targetDurationMs,
      intent: segment.intent?.trim() || undefined,
      preferredClipTypes: normalizeList(segment.preferredClipTypes),
      preferredPlaceHints: normalizeList(segment.preferredPlaceHints),
      notes: normalizeList(segment.notes),
    })),
  };
}

function normalizeLines(lines?: string[]): string[] {
  return (lines ?? [])
    .map(line => line.trim())
    .filter(Boolean);
}

function normalizeList(values?: string[]): string[] {
  return (values ?? [])
    .map(value => value.trim())
    .filter(Boolean);
}

function hashScriptBriefFingerprintPayload(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a:${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function isScriptBriefWorkflowState(value: unknown): value is TScriptBriefWorkflowState {
  return value === 'choose_style'
    || value === 'await_brief_draft'
    || value === 'review_brief'
    || value === 'ready_to_prepare'
    || value === 'ready_for_agent'
    || value === 'script_generated';
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isScriptBriefScaffold(content: string): boolean {
  return content.includes('当前状态：待填写脚本创作 brief')
    || content.includes('当前状态：等待用户指定风格后再开始脚本阶段')
    || content.includes('当前状态：请先在 /script 选择风格分类。')
    || content.includes('当前状态：风格已保存，请回到 Agent 生成初版 brief。')
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
