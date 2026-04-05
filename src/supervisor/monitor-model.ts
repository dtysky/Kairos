import { access, readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import {
  getAudioAnalysisCheckpointRoot,
  getPreparedAssetCheckpointRoot,
  listWorkspaceProjects,
  loadProjectBriefConfig,
  loadStyleSourcesConfig,
} from '../store/index.js';
import { listJobRecords, type ISupervisorJobRecord } from './state.js';

export interface IMonitorChip {
  label: string;
  tone?: 'default' | 'ok' | 'warn' | 'error';
}

export interface IMonitorMetric {
  label: string;
  value: string;
  sub?: string;
}

export interface IMonitorStepDefinition {
  key: string;
  label: string;
  description?: string;
  state: 'completed' | 'active' | 'pending' | 'error';
}

export interface IMonitorOutput {
  label: string;
  path: string;
  description?: string;
  exists: boolean;
}

export interface IMonitorProgress {
  status: string;
  stepKey?: string;
  stepLabel?: string;
  detail?: string;
  current?: number;
  total?: number;
  percent?: number;
  fileName?: string;
  etaSeconds?: number;
  updatedAt?: string;
}

export interface IMonitorModel {
  title: string;
  subtitle: string;
  chips: IMonitorChip[];
  metrics: IMonitorMetric[];
  progress: IMonitorProgress;
  stepDefinitions: IMonitorStepDefinition[];
  outputs: IMonitorOutput[];
  raw: unknown;
  latestJob: ISupervisorJobRecord | null;
}

interface IAnalyzeProgressPayload {
  status?: string;
  step?: string;
  stepLabel?: string;
  detail?: string;
  current?: number;
  total?: number;
  fileIndex?: number;
  fileTotal?: number;
  percent?: number;
  fileName?: string;
  etaSeconds?: number;
  updatedAt?: string;
  stepIndex?: number;
  stepDefinitions?: Array<{ key: string; label: string }>;
  extra?: {
    projectName?: string;
  };
}

interface IStyleProgressPayload {
  stage?: string;
  updatedAt?: string;
  detail?: {
    totalVideos?: number;
    summaryPath?: string;
    transcriptPath?: string;
    outputLinks?: Array<{ label?: string; path?: string; description?: string }>;
  };
  category?: {
    slug?: string;
    name?: string;
  };
}

const CANALYZE_STEP_DESCRIPTIONS: Record<string, string> = {
  prepare: '装载项目上下文并准备素材分析工作目录。',
  'coarse-scan': '抽取粗扫关键帧，完成首轮视觉理解与初筛。',
  'audio-analysis': '分析素材音轨、转录语音并生成语音驱动信息。',
  'fine-scan': '对重点素材补做细扫切片与结构化片段理解。',
  chronology: '刷新 chronology 与项目级时间视图。',
};

const CSTYLE_STAGE_ORDER = [
  { key: 'health-check', label: '检查 ML 服务', description: '确认本地 ML 服务可用并准备本轮任务。' },
  { key: 'clip', label: '裁切 Intro 片段', description: '按来源配置裁出要分析的片段范围。' },
  { key: 'probe', label: '读取元数据', description: '读取时长、编码和基础媒体信息。' },
  { key: 'shot-detect', label: '场景检测', description: '切分场景，建立镜头粒度的结构。' },
  { key: 'transcribe', label: '语音转写', description: '转录片段内语音并补足文本上下文。' },
  { key: 'keyframes', label: '抽取关键帧', description: '生成视觉采样帧，供后续风格总结使用。' },
  { key: 'vlm', label: '视觉理解', description: '用视觉模型总结镜头语言与素材编排规律。' },
  { key: 'video-complete', label: '单视频完成', description: '完成单个参考视频的分析与汇总。' },
  { key: 'complete', label: '分析完成', description: '汇总分类结果并产出最终 style profile。' },
];

export async function buildAnalyzeMonitorModel(
  workspaceRoot: string,
  projectId: string,
): Promise<IMonitorModel> {
  const projectRoot = join(workspaceRoot, 'projects', projectId);
  const progressPath = join(projectRoot, '.tmp', 'media-analyze', 'progress.json');
  const progress = await readJsonFile<IAnalyzeProgressPayload>(progressPath);
  const projectEntry = (await listWorkspaceProjects(workspaceRoot))
    .find(item => item.projectId === projectId);
  const jobs = await listJobRecords(workspaceRoot);
  const latestJob = jobs.find(job => job.projectId === projectId && job.jobType === 'analyze') ?? null;
  const [reportCount, preparedCount, audioCheckpointCount] = await Promise.all([
    countChildren(join(projectRoot, 'analysis', 'asset-reports')),
    countChildren(getPreparedAssetCheckpointRoot(projectRoot)),
    countChildren(getAudioAnalysisCheckpointRoot(projectRoot)),
  ]);
  const total = progress?.total ?? progress?.fileTotal ?? 0;
  const current = progress?.current ?? progress?.fileIndex ?? 0;
  const percent = total > 0
    ? Math.min(100, Math.max(0, Math.round((current / total) * 1000) / 10))
    : undefined;
  const stepDefinitions = buildAnalyzeSteps(progress);
  const projectName = progress?.extra?.projectName ?? projectEntry?.project.name ?? projectId;

  return {
    title: '素材分析',
    subtitle: `${projectName} · 粗扫优先的项目级素材理解与细扫恢复监控`,
    chips: [
      { label: `项目 ${projectName}` },
      { label: '流程 media-analyze' },
      { label: statusLabel(progress?.status ?? latestJob?.status ?? 'idle'), tone: toneForStatus(progress?.status ?? latestJob?.status ?? 'idle') },
    ],
    metrics: [
      {
        label: '完成进度',
        value: total > 0 ? `${current}/${total}` : '暂无',
        sub: percent != null ? `${percent.toFixed(1)}%` : '等待进度写入',
      },
      {
        label: '已落盘报告',
        value: String(reportCount),
        sub: preparedCount > 0 ? `${preparedCount} 条 prepared checkpoint` : '没有 prepared checkpoint',
      },
      {
        label: '音频中间态',
        value: String(audioCheckpointCount),
        sub: audioCheckpointCount > 0 ? '可恢复 audio checkpoint' : '当前没有 audio checkpoint',
      },
    ],
    progress: {
      status: progress?.status ?? latestJob?.status ?? 'idle',
      stepKey: progress?.step,
      stepLabel: progress?.stepLabel,
      detail: progress?.detail,
      current,
      total,
      percent,
      fileName: progress?.fileName,
      etaSeconds: progress?.etaSeconds,
      updatedAt: progress?.updatedAt ?? latestJob?.updatedAt,
    },
    stepDefinitions,
    outputs: await Promise.all([
      outputItem('资产报告目录', join(projectRoot, 'analysis', 'asset-reports'), '每条素材的正式分析结果。', reportCount > 0),
      outputItem('prepared-assets', getPreparedAssetCheckpointRoot(projectRoot), '粗扫完成后的 checkpoint。', preparedCount > 0),
      outputItem('audio-checkpoints', getAudioAnalysisCheckpointRoot(projectRoot), '音频阶段可恢复 checkpoint。', audioCheckpointCount > 0),
      outputItem('chronology.json', join(projectRoot, 'media', 'chronology.json'), '项目时间视图与后续编辑的时序基础。'),
    ]),
    raw: progress,
    latestJob,
  };
}

export async function buildStyleMonitorModel(
  workspaceRoot: string,
  projectId: string,
  requestedCategoryId?: string,
): Promise<IMonitorModel> {
  const projectRoot = join(workspaceRoot, 'projects', projectId);
  const projectBrief = await loadProjectBriefConfig(projectRoot).catch(() => null);
  const styleSources = await loadStyleSourcesConfig(workspaceRoot, projectRoot);
  const fallbackCategory = requestedCategoryId
    || styleSources.defaultCategory
    || styleSources.categories[0]?.categoryId
    || 'style-analysis';
  const category = styleSources.categories.find(item => item.categoryId === fallbackCategory)
    ?? styleSources.categories[0]
    ?? null;
  const categoryId = category?.categoryId ?? fallbackCategory;
  const progressPath = join(workspaceRoot, '.tmp', 'style-analysis', categoryId, 'progress.json');
  const progress = await readJsonFile<IStyleProgressPayload>(progressPath);
  const jobs = await listJobRecords(workspaceRoot);
  const latestJob = jobs.find(job => job.projectId === projectId && job.jobType === 'style-analysis') ?? null;
  const stepDefinitions = buildStyleSteps(progress?.stage);
  const outputs = await buildStyleOutputs(workspaceRoot, category, progress);
  const totalVideos = progress?.detail?.totalVideos ?? category?.sources.length ?? 0;

  return {
    title: '风格分析',
    subtitle: `${projectBrief?.name ?? projectId} · 参考来源配置与 agent 风格分析监控`,
    chips: [
      { label: category?.displayName ?? categoryId },
      { label: `${category?.sources.length ?? 0} 个来源` },
      { label: statusLabel(progress?.stage === 'complete' ? 'completed' : latestJob?.status ?? 'idle'), tone: toneForStatus(progress?.stage === 'complete' ? 'completed' : latestJob?.status ?? 'idle') },
    ],
    metrics: [
      {
        label: '参考视频',
        value: String(totalVideos),
        sub: category ? `${category.categoryId}` : '未配置分类',
      },
      {
        label: '当前阶段',
        value: styleStageLabel(progress?.stage),
        sub: progress?.updatedAt ? `更新于 ${formatShortTime(progress.updatedAt)}` : '等待运行',
      },
      {
        label: '来源条目',
        value: String(category?.sources.length ?? 0),
        sub: category?.profilePath ? `profile -> ${category.profilePath}` : '尚未绑定 profilePath',
      },
    ],
    progress: {
      status: progress?.stage === 'complete' ? 'completed' : latestJob?.status ?? 'idle',
      stepKey: progress?.stage,
      stepLabel: styleStageLabel(progress?.stage),
      detail: category?.guidancePrompt || category?.inclusionNotes || '等待运行或查看当前分类说明。',
      current: progress?.stage === 'complete' ? totalVideos : undefined,
      total: totalVideos || undefined,
      percent: progress?.stage === 'complete' ? 100 : undefined,
      etaSeconds: undefined,
      updatedAt: progress?.updatedAt ?? latestJob?.updatedAt,
    },
    stepDefinitions,
    outputs,
    raw: {
      category,
      progress,
    },
    latestJob,
  };
}

function buildAnalyzeSteps(progress: IAnalyzeProgressPayload | null): IMonitorStepDefinition[] {
  const definitions = progress?.stepDefinitions ?? [
    { key: 'prepare', label: '准备素材分析' },
    { key: 'coarse-scan', label: '粗扫素材' },
    { key: 'audio-analysis', label: '分析视频内音轨' },
    { key: 'fine-scan', label: '自动细扫重点内容' },
    { key: 'chronology', label: '刷新时间视图' },
  ];
  const activeIndex = Math.max(0, Number(progress?.stepIndex ?? 1) - 1);
  const isComplete = progress?.status === 'completed';
  const isError = progress?.status === 'failed';
  return definitions.map((item, index) => ({
    key: item.key,
    label: item.label,
    description: CANALYZE_STEP_DESCRIPTIONS[item.key],
    state: isComplete
      ? 'completed'
      : isError && index === activeIndex
        ? 'error'
        : index < activeIndex
          ? 'completed'
          : index === activeIndex
            ? 'active'
            : 'pending',
  }));
}

function buildStyleSteps(stage?: string): IMonitorStepDefinition[] {
  const activeIndex = Math.max(0, CSTYLE_STAGE_ORDER.findIndex(item => item.key === stage));
  const isComplete = stage === 'complete';
  return CSTYLE_STAGE_ORDER.map((item, index) => ({
    ...item,
    state: isComplete
      ? 'completed'
      : index < activeIndex
        ? 'completed'
        : index === activeIndex
          ? 'active'
          : 'pending',
  }));
}

async function buildStyleOutputs(
  workspaceRoot: string,
  category: {
    categoryId: string;
    profilePath?: string;
    sources: Array<{ path: string }>;
  } | null,
  progress: IStyleProgressPayload | null,
): Promise<IMonitorOutput[]> {
  const outputs: IMonitorOutput[] = [];
  if (category?.profilePath) {
    outputs.push(await outputItem(
      '风格档案 Markdown',
      join(workspaceRoot, 'config', 'styles', category.profilePath),
      '风格 profile/front-matter 同步产物。',
    ));
  }
  outputs.push(await outputItem(
    'style-references',
    join(workspaceRoot, 'analysis', 'style-references', category?.categoryId ?? 'style-analysis'),
    '参考视频分析中间结果与汇总目录。',
  ));
  outputs.push(await outputItem(
    'catalog.json',
    join(workspaceRoot, 'config', 'styles', 'catalog.json'),
    '全局 style 分类目录。',
  ));
  if (progress?.detail?.summaryPath) {
    outputs.push(await outputItem('combined summary', progress.detail.summaryPath, '分类级汇总 JSON。'));
  }
  if (progress?.detail?.transcriptPath) {
    outputs.push(await outputItem('transcript', progress.detail.transcriptPath, '本轮分析输出的转录文件。'));
  }
  for (const link of progress?.detail?.outputLinks ?? []) {
    if (!link.path) continue;
    outputs.push(await outputItem(link.label ?? basename(link.path), link.path, link.description));
  }
  return outputs;
}

async function outputItem(
  label: string,
  path: string,
  description?: string,
  forcedExists?: boolean,
): Promise<IMonitorOutput> {
  return {
    label,
    path,
    description,
    exists: forcedExists ?? await canRead(path),
  };
}

function statusLabel(status: string): string {
  const normalized = status.toLowerCase();
  if (normalized === 'running') return '运行中';
  if (normalized === 'completed') return '已完成';
  if (normalized === 'blocked') return '已阻塞';
  if (normalized === 'failed') return '失败';
  if (normalized === 'queued') return '排队中';
  if (normalized === 'stopped') return '已停止';
  if (normalized === 'idle') return '待启动';
  return status;
}

function toneForStatus(status: string): IMonitorChip['tone'] {
  const normalized = status.toLowerCase();
  if (normalized === 'completed' || normalized === 'running') return 'ok';
  if (normalized === 'blocked' || normalized === 'queued') return 'warn';
  if (normalized === 'failed' || normalized === 'error') return 'error';
  return 'default';
}

function styleStageLabel(stage?: string): string {
  return CSTYLE_STAGE_ORDER.find(item => item.key === stage)?.label ?? (stage || '等待启动');
}

function formatShortTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('zh-CN', {
    hour12: false,
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

async function countChildren(path: string): Promise<number> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.length;
  } catch {
    return 0;
  }
}

async function canRead(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readJsonFile<T>(path: string): Promise<T | null> {
  try {
    const { readFile } = await import('node:fs/promises');
    return JSON.parse(await readFile(path, 'utf-8')) as T;
  } catch {
    return null;
  }
}
