import { access, readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import {
  getAudioAnalysisCheckpointRoot,
  getFineScanCheckpointRoot,
  getPreparedAssetCheckpointRoot,
  getStyleReferenceReportsRoot,
  getWorkspaceStyleAnalysisProgressPath,
  listWorkspaceProjects,
  loadFineScanCheckpoint,
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

export interface IMonitorSectionItem {
  label: string;
  value: string;
  sub?: string;
}

export interface IMonitorSection {
  title: string;
  items: IMonitorSectionItem[];
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

export interface IMonitorPipelineSummary {
  kind: 'coarse-scan' | 'audio-analysis' | 'fine-scan';
  total?: number;
  completed?: number;
  pending?: number;
  active?: number;
  targetConcurrency?: number;
  checkpointed?: number;
  activeAssetNames?: string[];
  activeLocal?: number;
  targetLocalConcurrency?: number;
  queuedAsr?: number;
  activeAsr?: number;
  targetAsrConcurrency?: number;
  prefetched?: number;
  recognized?: number;
  ready?: number;
  persisted?: number;
  activePrefetch?: number;
  activeRecognition?: number;
  readyFrameBytes?: number;
  checkpointPlanOrPrefetch?: number;
  checkpointReady?: number;
  checkpointRecognizing?: number;
}

export interface IMonitorModel {
  title: string;
  subtitle: string;
  chips: IMonitorChip[];
  metrics: IMonitorMetric[];
  progress: IMonitorProgress;
  pipelines?: IMonitorPipelineSummary[];
  sections?: IMonitorSection[];
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
    pipelineKind?: string;
    activeAssetNames?: string[];
    coarseTotal?: number;
    coarseCompletedCount?: number;
    coarsePendingCount?: number;
    coarseActiveCount?: number;
    coarseTargetConcurrency?: number;
    coarseCheckpointedCount?: number;
    audioTotal?: number;
    audioCompletedCount?: number;
    audioPendingCount?: number;
    audioActiveLocalCount?: number;
    audioTargetLocalConcurrency?: number;
    audioQueuedAsrCount?: number;
    audioActiveAsrCount?: number;
    audioTargetAsrConcurrency?: number;
    audioCheckpointedCount?: number;
    fineScanAssetTotal?: number;
    prefetchedAssetCount?: number;
    recognizedAssetCount?: number;
    readyAssetCount?: number;
    readyFrameBytes?: number;
    activePrefetchCount?: number;
    activeRecognitionCount?: number;
    persistedAssetCount?: number;
  };
}

interface IStyleProgressPayload {
  status?: string;
  stage?: string;
  updatedAt?: string;
  current?: number;
  total?: number;
  percent?: number;
  fileName?: string;
  videoIndex?: number;
  videoTotal?: number;
  detail?: {
    totalVideos?: number;
    currentVideo?: string;
    currentSourcePath?: string;
    clipPath?: string;
    reportPath?: string;
    summaryPath?: string;
    transcriptPath?: string;
    message?: string;
    outputLinks?: Array<{ label?: string; path?: string; description?: string }>;
  };
  extra?: {
    activeVideo?: {
      displayName?: string;
      sourcePath?: string;
      clipPath?: string;
      index?: number;
      total?: number;
    };
    stageStartedAt?: string;
    stageMetrics?: {
      shotDetect?: {
        durationMs?: number;
        sceneDetectFps?: number;
        detectedShots?: number;
      };
      transcribe?: {
        segmentCount?: number;
        textChars?: number;
        roundTripMs?: number;
      };
      keyframes?: {
        plannedCount?: number;
        extractedCount?: number;
        activeWorkers?: number;
        outputDir?: string;
      };
      vlm?: {
        totalGroups?: number;
        completedGroups?: number;
        currentShotId?: string;
        currentFrameCount?: number;
        lastRoundTripMs?: number;
      };
    };
    queue?: {
      completedCount?: number;
      pendingCount?: number;
      completedNames?: string[];
      pendingNames?: string[];
    };
  };
  category?: {
    categoryId?: string;
    slug?: string;
    name?: string;
  };
}

const CANALYZE_STEP_DESCRIPTIONS: Record<string, string> = {
  prepare: '装载项目上下文并准备素材分析工作目录。',
  'coarse-scan': '按素材级 worker 抽取粗扫关键帧；单素材同一时刻最多一个 ffmpeg，多素材按内存动态并发。',
  'audio-analysis': '先做 embedded/protection 双健康检查，再将选中的单一路径送入 ASR 队列，按内存动态并发。',
  finalize: '统一完成视觉总结、clip type 判断与 fine-scan 策略决策。',
  'fine-scan-prefetch': '为待细扫素材预抽关键帧，并准备识别所需中间态。',
  'fine-scan-recognition': '消费已准备好的关键帧，生成细扫切片与视觉理解结果。',
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
  const liveJob = jobs.find(job =>
    job.projectId === projectId
      && job.jobType === 'analyze'
      && isLiveJobStatus(job.status),
  ) ?? null;
  const [reportCount, preparedCount, audioCheckpointCount] = await Promise.all([
    countChildren(join(projectRoot, 'analysis', 'asset-reports')),
    countChildren(getPreparedAssetCheckpointRoot(projectRoot)),
    countChildren(getAudioAnalysisCheckpointRoot(projectRoot)),
  ]);
  const fineScanCheckpointSummary = await summarizeFineScanCheckpoints(projectRoot);
  const total = progress?.total ?? progress?.fileTotal ?? 0;
  const current = progress?.current ?? progress?.fileIndex ?? 0;
  const percent = total > 0
    ? Math.min(100, Math.max(0, Math.round((current / total) * 1000) / 10))
    : undefined;
  const stepDefinitions = buildAnalyzeSteps(progress);
  const projectName = progress?.extra?.projectName ?? projectEntry?.project.name ?? projectId;
  const monitorStatus = resolveMonitorStatus({
    liveJobStatus: liveJob?.status,
    latestJobStatus: latestJob?.status,
    hasCachedProgress: Boolean(progress),
  });
  const isFineScanPipelineStep = progress?.step === 'fine-scan-prefetch' || progress?.step === 'fine-scan-recognition';
  const fineScanTotal = progress?.extra?.fineScanAssetTotal ?? total;
  const fineScanPrefetched = progress?.extra?.prefetchedAssetCount;
  const fineScanRecognized = progress?.extra?.recognizedAssetCount;
  const fineScanReady = progress?.extra?.readyAssetCount;
  const coarsePipeline = progress?.extra?.coarseTotal || progress?.step === 'coarse-scan'
    ? {
      kind: 'coarse-scan' as const,
      total: progress?.extra?.coarseTotal ?? total,
      completed: progress?.extra?.coarseCompletedCount,
      pending: progress?.extra?.coarsePendingCount,
      active: progress?.extra?.coarseActiveCount,
      targetConcurrency: progress?.extra?.coarseTargetConcurrency,
      checkpointed: progress?.extra?.coarseCheckpointedCount,
      activeAssetNames: progress?.extra?.activeAssetNames,
    }
    : null;
  const audioPipeline = progress?.extra?.audioTotal || progress?.step === 'audio-analysis'
    ? {
      kind: 'audio-analysis' as const,
      total: progress?.extra?.audioTotal ?? total,
      completed: progress?.extra?.audioCompletedCount,
      pending: progress?.extra?.audioPendingCount,
      activeLocal: progress?.extra?.audioActiveLocalCount,
      targetLocalConcurrency: progress?.extra?.audioTargetLocalConcurrency,
      queuedAsr: progress?.extra?.audioQueuedAsrCount,
      activeAsr: progress?.extra?.audioActiveAsrCount,
      targetAsrConcurrency: progress?.extra?.audioTargetAsrConcurrency,
      checkpointed: progress?.extra?.audioCheckpointedCount,
      activeAssetNames: progress?.extra?.activeAssetNames,
    }
    : null;
  const fineScanPipeline = progress?.extra?.fineScanAssetTotal || fineScanCheckpointSummary.total > 0
    ? {
      kind: 'fine-scan' as const,
      total: fineScanTotal || undefined,
      prefetched: fineScanPrefetched,
      recognized: fineScanRecognized,
      ready: fineScanReady,
      persisted: progress?.extra?.persistedAssetCount,
      activePrefetch: progress?.extra?.activePrefetchCount,
      activeRecognition: progress?.extra?.activeRecognitionCount,
      readyFrameBytes: progress?.extra?.readyFrameBytes,
      checkpointPlanOrPrefetch: fineScanCheckpointSummary.planOrPrefetch,
      checkpointReady: fineScanCheckpointSummary.ready,
      checkpointRecognizing: fineScanCheckpointSummary.recognizing,
    }
    : null;
  const pipelines = [coarsePipeline, audioPipeline, fineScanPipeline]
    .filter(Boolean) as IMonitorPipelineSummary[];
  const completionMetric = isFineScanPipelineStep && typeof fineScanRecognized === 'number'
    ? {
      value: `识别 ${fineScanRecognized}/${fineScanTotal}`,
      sub: [
        typeof fineScanPrefetched === 'number' ? `预抽 ${fineScanPrefetched}/${fineScanTotal}` : null,
        typeof fineScanReady === 'number' ? `就绪 ${fineScanReady}` : null,
      ].filter((part): part is string => Boolean(part)).join(' · '),
    }
    : {
      value: total > 0 ? `${current}/${total}` : '暂无',
      sub: percent != null ? `${percent.toFixed(1)}%` : '等待进度写入',
    };

  return {
    title: '素材分析',
    subtitle: `${projectName} · 粗扫优先的项目级素材理解与细扫恢复监控`,
    chips: [
      { label: `项目 ${projectName}` },
      { label: '流程 media-analyze' },
      { label: statusLabel(monitorStatus), tone: toneForStatus(monitorStatus) },
    ],
    metrics: [
      {
        label: '完成进度',
        value: completionMetric.value,
        sub: completionMetric.sub || (percent != null ? `${percent.toFixed(1)}%` : '等待进度写入'),
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
      {
        label: '细扫中间态',
        value: String(fineScanCheckpointSummary.total),
        sub: fineScanCheckpointSummary.total > 0
          ? `plan/prefetch ${fineScanCheckpointSummary.planOrPrefetch} · ready ${fineScanCheckpointSummary.ready} · recognizing ${fineScanCheckpointSummary.recognizing}`
          : '当前没有 fine-scan checkpoint',
      },
    ],
    progress: {
      status: monitorStatus,
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
    pipelines: pipelines.length > 0 ? pipelines : undefined,
    stepDefinitions,
    outputs: await Promise.all([
      outputItem('资产报告目录', join(projectRoot, 'analysis', 'asset-reports'), '每条素材的正式分析结果。', reportCount > 0),
      outputItem('prepared-assets', getPreparedAssetCheckpointRoot(projectRoot), 'coarse-scan 阶段生成的 prepared inputs checkpoint。', preparedCount > 0),
      outputItem('audio-checkpoints', getAudioAnalysisCheckpointRoot(projectRoot), 'audio-analysis 阶段可恢复的 transcript / protection 决策辅助 checkpoint。', audioCheckpointCount > 0),
      outputItem('fine-scan-checkpoints', getFineScanCheckpointRoot(projectRoot), '细扫预抽帧与识别阶段的恢复 checkpoint。', fineScanCheckpointSummary.total > 0),
      outputItem('chronology.json', join(projectRoot, 'media', 'chronology.json'), '项目时间视图与后续编辑的时序基础。'),
    ]),
    raw: progress,
    latestJob,
  };
}

export async function buildStyleMonitorModel(
  workspaceRoot: string,
  requestedCategoryId?: string,
): Promise<IMonitorModel> {
  const styleSources = await loadStyleSourcesConfig(workspaceRoot);
  const jobs = await listJobRecords(workspaceRoot);
  const latestLiveJob = jobs.find(job => job.jobType === 'style-analysis' && isLiveJobStatus(job.status)) ?? null;
  const latestStyleJob = jobs.find(job => job.jobType === 'style-analysis') ?? null;
  const latestProgressCategoryId = await resolveLatestStyleProgressCategoryId(workspaceRoot, styleSources);
  const category = resolveStyleMonitorCategory(
    styleSources,
    requestedCategoryId,
    getStyleJobCategoryId(latestLiveJob),
    getStyleJobCategoryId(latestStyleJob),
    latestProgressCategoryId,
  );
  const categoryId = category.categoryId;
  const progressPath = getWorkspaceStyleAnalysisProgressPath(workspaceRoot, categoryId);
  const progress = await readJsonFile<IStyleProgressPayload>(progressPath);
  const latestJob = jobs.find(job =>
    job.jobType === 'style-analysis'
      && getStyleJobCategoryId(job) === categoryId,
  ) ?? null;
  const liveJob = jobs.find(job =>
    job.jobType === 'style-analysis'
      && getStyleJobCategoryId(job) === categoryId
      && isLiveJobStatus(job.status),
  ) ?? null;
  const monitorStatus = resolveMonitorStatus({
    liveJobStatus: liveJob?.status,
    latestJobStatus: latestJob?.status,
    hasCachedProgress: Boolean(progress),
  });
  const stepDefinitions = buildStyleSteps(progress?.stage, monitorStatus);
  const outputs = await buildStyleOutputs(workspaceRoot, category, progress);
  const sections = buildStyleSections(progress);
  const totalVideos = progress?.total ?? progress?.videoTotal ?? progress?.detail?.totalVideos ?? category?.sources.length ?? 0;
  const workspaceName = basename(workspaceRoot);

  return {
    title: '风格分析',
    subtitle: `${workspaceName} · Workspace 风格库、deterministic prep 与 Agent 风格分析交接监控`,
    chips: [
      { label: `工作区 ${workspaceName}` },
      { label: category.displayName },
      { label: `${category.sources.length} 个来源` },
      { label: statusLabel(monitorStatus), tone: toneForStatus(monitorStatus) },
    ],
    metrics: [
      {
        label: '参考视频',
        value: String(totalVideos),
        sub: category.categoryId,
      },
      {
        label: '当前阶段',
        value: styleStageLabel(progress?.stage),
        sub: progress?.updatedAt
          ? `${monitorStatus === 'cached' ? 'cached progress' : '更新于'} ${formatShortTime(progress.updatedAt)}`
          : '等待运行',
      },
      {
        label: '来源条目',
        value: String(category.sources.length),
        sub: category.profilePath ? `profile -> ${category.profilePath}` : '尚未绑定 profilePath',
      },
    ],
    progress: {
      status: monitorStatus,
      stepKey: progress?.stage,
      stepLabel: styleStageLabel(progress?.stage),
      detail: progress?.detail?.message
        || category.guidancePrompt
        || category.inclusionNotes
        || '等待运行或查看当前分类说明。',
      current: progress?.current ?? progress?.videoIndex ?? (progress?.stage === 'complete' ? totalVideos : undefined),
      total: totalVideos || undefined,
      percent: progress?.percent ?? (progress?.stage === 'complete' ? 100 : undefined),
      fileName: progress?.fileName ?? progress?.detail?.currentVideo,
      etaSeconds: undefined,
      updatedAt: progress?.updatedAt ?? latestJob?.updatedAt,
    },
    sections,
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
      { key: 'finalize', label: '统一完成素材分析' },
      { key: 'fine-scan-prefetch', label: '预抽细扫关键帧' },
      { key: 'fine-scan-recognition', label: '识别细扫素材' },
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

function buildStyleSteps(stage?: string, status = 'idle'): IMonitorStepDefinition[] {
  const activeIndex = stage ? CSTYLE_STAGE_ORDER.findIndex(item => item.key === stage) : -1;
  const isComplete = stage === 'complete';
  const isError = status === 'failed';
  return CSTYLE_STAGE_ORDER.map((item, index) => ({
    ...item,
    state: isComplete
      ? 'completed'
      : isError && index === activeIndex
        ? 'error'
        : activeIndex >= 0 && index < activeIndex
        ? 'completed'
        : activeIndex >= 0 && index === activeIndex
          ? 'active'
          : 'pending',
  }));
}

function buildStyleSections(progress: IStyleProgressPayload | null): IMonitorSection[] | undefined {
  if (!progress) return undefined;

  const sections: IMonitorSection[] = [];
  const activeVideo = progress.extra?.activeVideo;
  if (activeVideo?.displayName || progress.detail?.currentVideo) {
    sections.push({
      title: '当前视频',
      items: [
        {
          label: '视频',
          value: activeVideo?.displayName || progress.detail?.currentVideo || '暂无',
          sub: activeVideo?.index && activeVideo?.total
            ? `第 ${activeVideo.index}/${activeVideo.total} 条`
            : undefined,
        },
        {
          label: '来源路径',
          value: activeVideo?.sourcePath || progress.detail?.currentSourcePath || '暂无',
        },
        {
          label: 'Clip 路径',
          value: activeVideo?.clipPath || progress.detail?.clipPath || '尚未生成',
        },
        {
          label: '阶段开始',
          value: formatDateTime(progress.extra?.stageStartedAt),
        },
      ],
    });
  }

  const stageItems = buildStyleStageSectionItems(progress);
  if (stageItems.length > 0) {
    sections.push({
      title: '当前阶段细节',
      items: stageItems,
    });
  }

  const queue = progress.extra?.queue;
  if (queue) {
    sections.push({
      title: '视频队列',
      items: [
        {
          label: '已完成',
          value: String(queue.completedCount ?? 0),
          sub: joinNames(queue.completedNames),
        },
        {
          label: '待处理',
          value: String(queue.pendingCount ?? 0),
          sub: joinNames(queue.pendingNames),
        },
      ],
    });
  }

  return sections.length > 0 ? sections : undefined;
}

function buildStyleStageSectionItems(progress: IStyleProgressPayload): IMonitorSectionItem[] {
  const stageMetrics = progress.extra?.stageMetrics;
  const items: IMonitorSectionItem[] = [];

  if (progress.stage === 'shot-detect' || stageMetrics?.shotDetect?.detectedShots != null) {
    items.push({
      label: '场景检测',
      value: stageMetrics?.shotDetect?.detectedShots != null
        ? `${stageMetrics.shotDetect.detectedShots} 个镜头边界`
        : '运行中',
      sub: [
        stageMetrics?.shotDetect?.durationMs != null ? `时长 ${formatDurationMs(stageMetrics.shotDetect.durationMs)}` : '',
        stageMetrics?.shotDetect?.sceneDetectFps != null ? `sceneDetectFps=${stageMetrics.shotDetect.sceneDetectFps}` : '',
      ].filter(Boolean).join(' · ') || undefined,
    });
  }
  if (progress.stage === 'transcribe' || stageMetrics?.transcribe?.segmentCount != null) {
    items.push({
      label: '语音转写',
      value: stageMetrics?.transcribe?.segmentCount != null
        ? `${stageMetrics.transcribe.segmentCount} 段`
        : '运行中',
      sub: [
        stageMetrics?.transcribe?.textChars != null ? `${stageMetrics.transcribe.textChars} 字` : '',
        stageMetrics?.transcribe?.roundTripMs != null ? `round-trip ${formatDurationMs(stageMetrics.transcribe.roundTripMs)}` : '',
      ].filter(Boolean).join(' · ') || undefined,
    });
  }
  if (progress.stage === 'keyframes' || stageMetrics?.keyframes?.plannedCount != null) {
    items.push({
      label: '抽取关键帧',
      value: `${stageMetrics?.keyframes?.extractedCount ?? 0}/${stageMetrics?.keyframes?.plannedCount ?? 0}`,
      sub: [
        stageMetrics?.keyframes?.activeWorkers != null ? `${stageMetrics.keyframes.activeWorkers} 个 worker` : '',
        stageMetrics?.keyframes?.outputDir ? stageMetrics.keyframes.outputDir : '',
      ].filter(Boolean).join(' · ') || undefined,
    });
  }
  if (progress.stage === 'vlm' || stageMetrics?.vlm?.totalGroups != null) {
    items.push({
      label: '视觉理解',
      value: `${stageMetrics?.vlm?.completedGroups ?? 0}/${stageMetrics?.vlm?.totalGroups ?? 0} 组镜头`,
      sub: [
        stageMetrics?.vlm?.currentShotId ? `当前 ${stageMetrics.vlm.currentShotId}` : '',
        stageMetrics?.vlm?.currentFrameCount != null ? `${stageMetrics.vlm.currentFrameCount} 帧` : '',
        stageMetrics?.vlm?.lastRoundTripMs != null ? `round-trip ${formatDurationMs(stageMetrics.vlm.lastRoundTripMs)}` : '',
      ].filter(Boolean).join(' · ') || undefined,
    });
  }

  return items;
}

async function buildStyleOutputs(
  workspaceRoot: string,
  category: {
    categoryId: string;
    profilePath?: string;
    sources: Array<{ path: string }>;
  },
  progress: IStyleProgressPayload | null,
): Promise<IMonitorOutput[]> {
  const outputs: IMonitorOutput[] = [];
  if (category.profilePath) {
    outputs.push(await outputItem(
    '风格档案 Markdown',
    join(workspaceRoot, 'config', 'styles', category.profilePath),
    '风格 profile/front-matter 同步产物。',
  ));
  }
  outputs.push(await outputItem(
    'style-references',
    getStyleReferenceReportsRoot(workspaceRoot, category.categoryId),
    '参考视频分析中间结果与汇总目录。',
  ));
  outputs.push(await outputItem(
    'style-sources.json',
    join(workspaceRoot, 'config', 'style-sources.json'),
    'Workspace 级 style 分类与来源配置。',
  ));
  if (progress?.detail?.summaryPath) {
    outputs.push(await outputItem('combined summary', progress.detail.summaryPath, '分类级汇总 JSON。'));
  }
  if (progress?.detail?.reportPath) {
    outputs.push(await outputItem('current report', progress.detail.reportPath, '当前或最近一个参考视频分析结果。'));
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

function resolveStyleMonitorCategory(
  config: Awaited<ReturnType<typeof loadStyleSourcesConfig>>,
  requestedCategoryId?: string,
  activeCategoryId?: string,
  latestJobCategoryId?: string,
  latestProgressCategoryId?: string,
): Awaited<ReturnType<typeof loadStyleSourcesConfig>>['categories'][number] {
  const resolveById = (categoryId: string, reason: string) => {
    const matched = config.categories.find(item => item.categoryId === categoryId);
    if (!matched) {
      throw new Error(`${reason} "${categoryId}" is not defined in config/style-sources.json`);
    }
    return matched;
  };

  if (requestedCategoryId?.trim()) {
    return resolveById(requestedCategoryId.trim(), 'requested style category');
  }
  if (activeCategoryId?.trim()) {
    return resolveById(activeCategoryId.trim(), 'active style-analysis category');
  }
  if (latestJobCategoryId?.trim()) {
    return resolveById(latestJobCategoryId.trim(), 'latest style-analysis category');
  }
  if (latestProgressCategoryId?.trim()) {
    return resolveById(latestProgressCategoryId.trim(), 'latest style-analysis progress category');
  }
  if (config.defaultCategory?.trim()) {
    return resolveById(config.defaultCategory.trim(), 'style-sources.json defaultCategory');
  }

  const first = config.categories[0];
  if (!first) {
    throw new Error('style-sources.json does not define any style categories');
  }
  return first;
}

async function resolveLatestStyleProgressCategoryId(
  workspaceRoot: string,
  config: Awaited<ReturnType<typeof loadStyleSourcesConfig>>,
): Promise<string | undefined> {
  let latestCategoryId: string | undefined;
  let latestTimestamp = '';
  for (const category of config.categories) {
    const progress = await readJsonFile<IStyleProgressPayload>(
      getWorkspaceStyleAnalysisProgressPath(workspaceRoot, category.categoryId),
    );
    if (!progress?.updatedAt) continue;
    if (progress.updatedAt > latestTimestamp) {
      latestTimestamp = progress.updatedAt;
      latestCategoryId = category.categoryId;
    }
  }
  return latestCategoryId;
}

async function summarizeFineScanCheckpoints(projectRoot: string): Promise<{
  total: number;
  planOrPrefetch: number;
  ready: number;
  recognizing: number;
}> {
  const root = getFineScanCheckpointRoot(projectRoot);
  try {
    const entries = await readdir(root, { withFileTypes: true });
    let total = 0;
    let planOrPrefetch = 0;
    let ready = 0;
    let recognizing = 0;

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const assetId = entry.name.replace(/\.json$/u, '');
      const checkpoint = await loadFineScanCheckpoint(projectRoot, assetId);
      if (!checkpoint) continue;
      total += 1;
      if (checkpoint.status === 'frame-plan-ready' || checkpoint.status === 'prefetching') {
        planOrPrefetch += 1;
      } else if (checkpoint.status === 'frames-ready') {
        ready += 1;
      } else if (checkpoint.status === 'recognizing') {
        recognizing += 1;
      }
    }

    return {
      total,
      planOrPrefetch,
      ready,
      recognizing,
    };
  } catch {
    return {
      total: 0,
      planOrPrefetch: 0,
      ready: 0,
      recognizing: 0,
    };
  }
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
  if (normalized === 'awaiting_agent') return '等待 Agent';
  if (normalized === 'completed' || normalized === 'succeeded') return '已完成';
  if (normalized === 'cached') return '缓存进度';
  if (normalized === 'blocked') return '已阻塞';
  if (normalized === 'failed') return '失败';
  if (normalized === 'queued') return '排队中';
  if (normalized === 'stopped') return '已停止';
  if (normalized === 'idle') return '待启动';
  return status;
}

function toneForStatus(status: string): IMonitorChip['tone'] {
  const normalized = status.toLowerCase();
  if (normalized === 'completed' || normalized === 'succeeded' || normalized === 'running') return 'ok';
  if (normalized === 'awaiting_agent') return 'warn';
  if (normalized === 'cached') return 'warn';
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

function formatDateTime(value?: string): string {
  if (!value) return '暂无';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('zh-CN', {
    hour12: false,
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function formatDurationMs(value?: number): string {
  const totalMs = Math.max(0, Number(value) || 0);
  if (totalMs >= 60_000) {
    return `${Math.round((totalMs / 1000 / 60) * 10) / 10}m`;
  }
  if (totalMs >= 1_000) {
    return `${Math.round((totalMs / 1000) * 10) / 10}s`;
  }
  return `${Math.round(totalMs)}ms`;
}

function joinNames(names?: string[]): string | undefined {
  if (!Array.isArray(names) || names.length === 0) return undefined;
  return names.join('、');
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

function isLiveJobStatus(status?: string): boolean {
  return status === 'queued' || status === 'running' || status === 'blocked';
}

function resolveMonitorStatus(input: {
  liveJobStatus?: string;
  latestJobStatus?: string;
  hasCachedProgress: boolean;
}): string {
  if (input.liveJobStatus) return input.liveJobStatus;
  if (input.latestJobStatus) return input.latestJobStatus;
  if (input.hasCachedProgress) return 'cached';
  return 'idle';
}

function getStyleJobCategoryId(job: ISupervisorJobRecord | null): string | undefined {
  const value = job?.args?.categoryId;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
