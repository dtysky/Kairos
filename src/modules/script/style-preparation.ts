import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { promisify } from 'node:util';
import type {
  IStyleSourceCategoryConfig,
  IStyleSourceItem,
} from '../../protocol/schema.js';
import {
  getStyleAgentSummaryPath,
  getStyleReferenceReportsRoot,
  getStyleReferenceTranscriptsRoot,
  getWorkspaceStyleAnalysisClipsRoot,
  getWorkspaceStyleAnalysisKeyframesRoot,
  getWorkspaceStyleAnalysisProgressPath,
  getWorkspaceStyleAnalysisSummaryPath,
  loadRuntimeConfig,
  loadStyleSourcesConfig,
  writeJson,
} from '../../store/index.js';
import {
  scanDirectory,
  classifyExt,
} from '../media/scanner.js';
import { probe, type IProbeResult } from '../media/probe.js';
import {
  detectShots,
  computeRhythmStats,
  resolveEffectiveSceneDetectFps,
  type IRhythmStats,
  type IShotBoundary,
} from '../media/shot-detect.js';
import {
  extractKeyframes,
  flattenShotKeyframePlans,
  groupKeyframesByShot,
  planShotKeyframes,
  type IKeyframeExtractProgress,
  type IShotKeyframePlan,
} from '../media/keyframe.js';
import { MlClient, type IAsrSegment, type IMlHealth } from '../media/ml-client.js';
import { transcribe } from '../media/transcriber.js';
import {
  recognizeShotGroups,
  type IRecognizeShotGroupsProgress,
  type IShotRecognition,
} from '../media/recognizer.js';
import { toExecutableInputPath } from '../media/tool-path.js';
import type { IStyleReferenceVideoAnalysis } from './style-analyzer.js';

const execFile = promisify(execFileCallback);

export type TStylePreparationStatus = 'running' | 'awaiting_agent' | 'completed' | 'failed' | 'stopped';

export interface IPrepareWorkspaceStyleAnalysisInput {
  workspaceRoot: string;
  categoryId?: string;
  progressPath?: string;
}

export interface IPrepareWorkspaceStyleAnalysisResult {
  status: Extract<TStylePreparationStatus, 'awaiting_agent' | 'completed'>;
  categoryId: string;
  displayName: string;
  progressPath: string;
  summaryPath: string;
  reportPaths: string[];
  transcriptPaths: string[];
  videoCount: number;
  profilePath?: string;
}

interface IResolvedStyleVideoSource {
  source: IStyleSourceItem;
  sourcePath: string;
  displayName: string;
  fileKey: string;
}

interface IStyleTranscriptDocument {
  sourcePath: string;
  clipPath: string;
  fullText: string;
  segments: IAsrSegment[];
  generatedAt: string;
}

interface IStyleVideoReport {
  categoryId: string;
  displayName: string;
  generatedAt: string;
  source: {
    id: string;
    path: string;
    displayName: string;
    rangeStart?: string;
    rangeEnd?: string;
    note?: string;
    includeNotes?: string;
    excludeNotes?: string;
  };
  clip: {
    path: string;
    rangeApplied: boolean;
  };
  probe: IProbeResult;
  shots: IShotBoundary[];
  rhythm: IRhythmStats;
  transcriptPath: string;
  transcript: IStyleTranscriptDocument;
  shotRecognitions: IShotRecognition[];
  agentInput: IStyleReferenceVideoAnalysis;
}

interface IStylePreparationSummary {
  categoryId: string;
  displayName: string;
  generatedAt: string;
  guidancePrompt?: string;
  inclusionNotes?: string;
  exclusionNotes?: string;
  profilePath?: string;
  videoCount: number;
  reportPaths: string[];
  transcriptPaths: string[];
  aggregate: {
    totalShotCount: number;
    averageCutsPerMinute: number;
    commonSceneTypes: string[];
    commonMoods: string[];
    commonNarrativeRoles: string[];
  };
  agentInputReports: IStyleReferenceVideoAnalysis[];
}

interface IStyleProgressPayload {
  status: TStylePreparationStatus;
  stage: string;
  updatedAt: string;
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
    health?: IMlHealth;
    message?: string;
    outputLinks?: Array<{ label?: string; path?: string; description?: string }>;
  };
  extra?: {
    activeVideo?: {
      displayName: string;
      sourcePath: string;
      clipPath?: string;
      index: number;
      total: number;
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
      completedCount: number;
      pendingCount: number;
      completedNames: string[];
      pendingNames: string[];
    };
  };
  category: {
    slug: string;
    name: string;
  };
}

interface IWriteStyleProgressInput extends Omit<IStyleProgressPayload, 'updatedAt' | 'category'> {
  category: IStyleSourceCategoryConfig;
}

type TStyleProgressExtra = NonNullable<IStyleProgressPayload['extra']>;
type TStyleProgressStageMetrics = NonNullable<TStyleProgressExtra['stageMetrics']>;

export async function prepareWorkspaceStyleAnalysisForAgent(
  input: IPrepareWorkspaceStyleAnalysisInput,
): Promise<IPrepareWorkspaceStyleAnalysisResult> {
  const styleSources = await loadStyleSourcesConfig(input.workspaceRoot);
  const category = resolveStyleCategory(styleSources, input.categoryId);
  const videoSources = await resolveStyleVideoSources(category);
  if (videoSources.length === 0) {
    throw new Error(`style-analysis requires at least one video source for category "${category.categoryId}"`);
  }

  const progressPath = input.progressPath
    ?? getWorkspaceStyleAnalysisProgressPath(input.workspaceRoot, category.categoryId);
  const runtimeConfig = await loadRuntimeConfig(input.workspaceRoot);
  const ml = new MlClient(runtimeConfig.mlServerUrl);
  const reportPaths: string[] = [];
  const transcriptPaths: string[] = [];
  const agentInputReports: IStyleReferenceVideoAnalysis[] = [];
  let currentStage = 'health-check';
  let currentStageStartedAt = new Date().toISOString();
  let latestCompletedStageMetrics: TStyleProgressStageMetrics | undefined;

  const enterStage = (stage: string) => {
    currentStage = stage;
    currentStageStartedAt = new Date().toISOString();
  };
  const buildQueueState = (current?: number, stage?: string) => {
    const total = videoSources.length;
    if (!current || current <= 0) {
      return {
        completedCount: 0,
        pendingCount: total,
        completedNames: [],
        pendingNames: videoSources.map(item => item.displayName),
      };
    }
    const zeroIndex = Math.max(0, current - 1);
    const completedCount = stage === 'video-complete' || stage === 'complete'
      ? Math.min(total, current)
      : Math.max(0, current - 1);
    return {
      completedCount,
      pendingCount: Math.max(0, total - completedCount - (stage === 'complete' ? 0 : stage === 'video-complete' ? 0 : 1)),
      completedNames: videoSources.slice(0, completedCount).map(item => item.displayName),
      pendingNames: stage === 'complete'
        ? []
        : videoSources.slice(zeroIndex + 1).map(item => item.displayName),
    };
  };
  const buildStyleExtra = (input: {
    current?: number;
    video?: IResolvedStyleVideoSource;
    clipPath?: string;
    stageMetrics?: TStyleProgressStageMetrics;
    stage?: string;
  }): TStyleProgressExtra => ({
    activeVideo: input.video && input.current
      ? {
        displayName: input.video.displayName,
        sourcePath: input.video.sourcePath,
        clipPath: input.clipPath,
        index: input.current,
        total: videoSources.length,
      }
      : undefined,
    stageStartedAt: currentStageStartedAt,
    stageMetrics: input.stageMetrics,
    queue: buildQueueState(input.current, input.stage ?? currentStage),
  });

  try {
    enterStage('health-check');
    const health = await ml.health();
    await writeStyleProgress(progressPath, {
      status: 'running',
      stage: 'health-check',
      current: 0,
      total: videoSources.length,
      category,
      detail: {
        totalVideos: videoSources.length,
        health,
        message: 'ML health-check 已完成，开始准备参考视频分析。',
      },
      extra: buildStyleExtra({ stage: 'health-check' }),
    });

    for (let index = 0; index < videoSources.length; index += 1) {
      const video = videoSources[index]!;
      const current = index + 1;
      const stageMetrics: TStyleProgressStageMetrics = {};
      const clipPath = await prepareStyleClip({
        workspaceRoot: input.workspaceRoot,
        categoryId: category.categoryId,
        video,
        runtimeConfig,
        current,
        total: videoSources.length,
        progressPath,
        category,
      });

      enterStage('probe');
      await writeStyleProgress(progressPath, {
        status: 'running',
        stage: currentStage,
        current,
        total: videoSources.length,
        fileName: video.displayName,
        category,
        detail: {
          totalVideos: videoSources.length,
          currentVideo: video.displayName,
          currentSourcePath: video.sourcePath,
          clipPath,
          message: '读取参考视频元数据。',
        },
        extra: buildStyleExtra({ current, video, clipPath, stageMetrics }),
      });
      const probed = await probe(clipPath, runtimeConfig);
      const durationMs = probed.durationMs ?? 0;

      enterStage('shot-detect');
      await writeStyleProgress(progressPath, {
        status: 'running',
        stage: currentStage,
        current,
        total: videoSources.length,
        fileName: video.displayName,
        category,
        detail: {
          totalVideos: videoSources.length,
          currentVideo: video.displayName,
          currentSourcePath: video.sourcePath,
          clipPath,
          message: '建立镜头级结构。',
        },
        extra: buildStyleExtra({ current, video, clipPath, stageMetrics }),
      });
      const shots = durationMs > 0
        ? await detectShots(clipPath, 0.3, runtimeConfig, { durationMs })
        : [];
      const rhythm = computeRhythmStats(shots, durationMs);
      stageMetrics.shotDetect = {
        durationMs,
        sceneDetectFps: resolveEffectiveSceneDetectFps({ tools: runtimeConfig, context: { durationMs } }),
        detectedShots: shots.length,
      };

      enterStage('transcribe');
      await writeStyleProgress(progressPath, {
        status: 'running',
        stage: currentStage,
        current,
        total: videoSources.length,
        fileName: video.displayName,
        category,
        detail: {
          totalVideos: videoSources.length,
          currentVideo: video.displayName,
          currentSourcePath: video.sourcePath,
          clipPath,
          message: '转写参考视频中的语音内容。',
        },
        extra: buildStyleExtra({ current, video, clipPath, stageMetrics }),
      });
      const transcriptResult = await transcribe(ml, clipPath, 'zh');
      stageMetrics.transcribe = {
        segmentCount: transcriptResult.segments.length,
        textChars: transcriptResult.fullText.length,
        roundTripMs: transcriptResult.roundTripMs,
      };
      const transcriptPath = join(
        getStyleReferenceTranscriptsRoot(input.workspaceRoot, category.categoryId),
        `${video.fileKey}.json`,
      );
      const transcriptDocument: IStyleTranscriptDocument = {
        sourcePath: video.sourcePath,
        clipPath,
        fullText: transcriptResult.fullText,
        segments: transcriptResult.segments,
        generatedAt: new Date().toISOString(),
      };
      await writeJson(transcriptPath, transcriptDocument);
      transcriptPaths.push(transcriptPath);

      enterStage('keyframes');
      const keyframeOutputDir = join(
        getWorkspaceStyleAnalysisKeyframesRoot(input.workspaceRoot, category.categoryId),
        video.fileKey,
      );
      const keyframePlans = durationMs > 0 ? planShotKeyframes(shots, durationMs, 3) : [];
      const plannedKeyframes = flattenShotKeyframePlans(keyframePlans);
      stageMetrics.keyframes = {
        plannedCount: plannedKeyframes.length,
        extractedCount: 0,
        activeWorkers: 0,
        outputDir: keyframeOutputDir,
      };
      await writeStyleProgress(progressPath, {
        status: 'running',
        stage: currentStage,
        current,
        total: videoSources.length,
        fileName: video.displayName,
        category,
        detail: {
          totalVideos: videoSources.length,
          currentVideo: video.displayName,
          currentSourcePath: video.sourcePath,
          clipPath,
          transcriptPath,
          message: '抽取镜头关键帧。',
        },
        extra: buildStyleExtra({ current, video, clipPath, stageMetrics }),
      });
      const keyframes = keyframePlans.length > 0
        ? await extractKeyframes(
          clipPath,
          keyframeOutputDir,
          plannedKeyframes,
          runtimeConfig,
          {
            onProgress: async (progress: IKeyframeExtractProgress) => {
              stageMetrics.keyframes = {
                plannedCount: progress.plannedCount,
                extractedCount: progress.extractedCount,
                activeWorkers: progress.activeWorkers,
                outputDir: keyframeOutputDir,
              };
              await writeStyleProgress(progressPath, {
                status: 'running',
                stage: currentStage,
                current,
                total: videoSources.length,
                fileName: video.displayName,
                category,
                detail: {
                  totalVideos: videoSources.length,
                  currentVideo: video.displayName,
                  currentSourcePath: video.sourcePath,
                  clipPath,
                  transcriptPath,
                  message: '抽取镜头关键帧。',
                },
                extra: buildStyleExtra({ current, video, clipPath, stageMetrics }),
              });
            },
          },
        )
        : [];
      const keyframeGroups = groupKeyframesByShot(keyframePlans, keyframes);
      stageMetrics.keyframes = {
        plannedCount: plannedKeyframes.length,
        extractedCount: keyframes.length,
        activeWorkers: 0,
        outputDir: keyframeOutputDir,
      };

      enterStage('vlm');
      stageMetrics.vlm = {
        totalGroups: keyframeGroups.length,
        completedGroups: 0,
      };
      await writeStyleProgress(progressPath, {
        status: 'running',
        stage: currentStage,
        current,
        total: videoSources.length,
        fileName: video.displayName,
        category,
        detail: {
          totalVideos: videoSources.length,
          currentVideo: video.displayName,
          currentSourcePath: video.sourcePath,
          clipPath,
          transcriptPath,
          message: '按镜头分析视觉语言与画面调性。',
        },
        extra: buildStyleExtra({ current, video, clipPath, stageMetrics }),
      });
      const shotRecognitions = keyframeGroups.length > 0
        ? await recognizeShotGroups(ml, keyframeGroups, {
          onProgress: async (progress: IRecognizeShotGroupsProgress) => {
            stageMetrics.vlm = {
              totalGroups: progress.totalGroups,
              completedGroups: progress.completedGroups,
              currentShotId: progress.currentShotId,
              currentFrameCount: progress.currentFrameCount,
              lastRoundTripMs: progress.lastRoundTripMs,
            };
            await writeStyleProgress(progressPath, {
              status: 'running',
              stage: currentStage,
              current,
              total: videoSources.length,
              fileName: video.displayName,
              category,
              detail: {
                totalVideos: videoSources.length,
                currentVideo: video.displayName,
                currentSourcePath: video.sourcePath,
                clipPath,
                transcriptPath,
                message: '按镜头分析视觉语言与画面调性。',
              },
              extra: buildStyleExtra({ current, video, clipPath, stageMetrics }),
            });
          },
        })
        : [];
      stageMetrics.vlm = {
        ...stageMetrics.vlm,
        totalGroups: keyframeGroups.length,
        completedGroups: shotRecognitions.length,
      };

      const reportPath = join(
        getStyleReferenceReportsRoot(input.workspaceRoot, category.categoryId),
        `${video.fileKey}.json`,
      );
      const agentInput = buildAgentInput({
        category,
        video,
        clipPath,
        probed,
        rhythm,
        shotRecognitions,
        transcript: transcriptDocument.fullText,
      });
      const report: IStyleVideoReport = {
        categoryId: category.categoryId,
        displayName: category.displayName,
        generatedAt: new Date().toISOString(),
        source: {
          id: video.source.id,
          path: video.sourcePath,
          displayName: video.displayName,
          rangeStart: video.source.rangeStart,
          rangeEnd: video.source.rangeEnd,
          note: video.source.note,
          includeNotes: video.source.includeNotes,
          excludeNotes: video.source.excludeNotes,
        },
        clip: {
          path: clipPath,
          rangeApplied: clipPath !== video.sourcePath,
        },
        probe: probed,
        shots,
        rhythm,
        transcriptPath,
        transcript: transcriptDocument,
        shotRecognitions,
        agentInput,
      };
      await writeJson(reportPath, report);
      reportPaths.push(reportPath);
      agentInputReports.push(agentInput);

      enterStage('video-complete');
      await writeStyleProgress(progressPath, {
        status: 'running',
        stage: currentStage,
        current,
        total: videoSources.length,
        percent: computePercent(current, videoSources.length),
        fileName: video.displayName,
        category,
        detail: {
          totalVideos: videoSources.length,
          currentVideo: video.displayName,
          currentSourcePath: video.sourcePath,
          clipPath,
          reportPath,
          transcriptPath,
          message: `已完成 ${current}/${videoSources.length} 个参考视频。`,
          outputLinks: [
            { label: 'report', path: reportPath, description: '单视频风格分析结果。' },
            { label: 'transcript', path: transcriptPath, description: '单视频 ASR 结果。' },
          ],
        },
        extra: buildStyleExtra({ current, video, clipPath, stageMetrics, stage: 'video-complete' }),
      });
      latestCompletedStageMetrics = {
        ...stageMetrics,
      };
    }

    const legacySummaryPath = getWorkspaceStyleAnalysisSummaryPath(input.workspaceRoot, category.categoryId);
    const agentSummaryPath = getStyleAgentSummaryPath(input.workspaceRoot, category.categoryId);
    const summary: IStylePreparationSummary = {
      categoryId: category.categoryId,
      displayName: category.displayName,
      generatedAt: new Date().toISOString(),
      guidancePrompt: category.guidancePrompt,
      inclusionNotes: category.inclusionNotes,
      exclusionNotes: category.exclusionNotes,
      profilePath: category.profilePath,
      videoCount: videoSources.length,
      reportPaths,
      transcriptPaths,
      aggregate: buildSummaryAggregate(agentInputReports),
      agentInputReports,
    };
    await Promise.all([
      writeJson(agentSummaryPath, summary),
      writeJson(legacySummaryPath, summary),
    ]);

    enterStage('complete');
    await writeStyleProgress(progressPath, {
      status: 'awaiting_agent',
      stage: 'complete',
      current: videoSources.length,
      total: videoSources.length,
      percent: 100,
      category,
      detail: {
        totalVideos: videoSources.length,
        summaryPath: legacySummaryPath,
        message: 'Deterministic prep 已完成，请回到 Agent 生成最终风格档案。',
        outputLinks: [
          { label: 'combined summary', path: legacySummaryPath, description: '兼容旧流程的 combined summary。' },
          { label: 'agent summary', path: agentSummaryPath, description: '供 clean-context subagent 汇总风格 profile 的结构化摘要。' },
          ...reportPaths.map(path => ({ label: basename(path), path, description: '单视频分析结果。' })),
        ],
      },
      extra: buildStyleExtra({
        current: videoSources.length,
        stage: 'complete',
        stageMetrics: latestCompletedStageMetrics,
      }),
    });

    return {
      status: 'awaiting_agent',
      categoryId: category.categoryId,
      displayName: category.displayName,
      progressPath,
      summaryPath: legacySummaryPath,
      reportPaths,
      transcriptPaths,
      videoCount: videoSources.length,
      profilePath: category.profilePath,
    };
  } catch (error) {
    await writeStyleProgress(progressPath, {
      status: 'failed',
      stage: currentStage,
      category,
      detail: {
        totalVideos: videoSources.length,
        message: error instanceof Error ? error.message : String(error),
      },
      extra: {
        stageStartedAt: currentStageStartedAt,
      },
    }).catch(() => undefined);
    throw error;
  }
}

function resolveStyleCategory(
  config: { defaultCategory?: string; categories: IStyleSourceCategoryConfig[] },
  requestedCategoryId?: string,
) : IStyleSourceCategoryConfig {
  if (requestedCategoryId) {
    const matched = config.categories.find(item => item.categoryId === requestedCategoryId);
    if (!matched) {
      throw new Error(`style-analysis category "${requestedCategoryId}" is not defined in config/style-sources.json`);
    }
    return matched;
  }
  if (config.defaultCategory) {
    const matched = config.categories.find(item => item.categoryId === config.defaultCategory);
    if (!matched) {
      throw new Error(`style-sources.json defaultCategory "${config.defaultCategory}" is not defined in categories`);
    }
    return matched;
  }
  const first = config.categories[0];
  if (!first) {
    throw new Error('style-sources.json does not define any style categories');
  }
  return first;
}

async function resolveStyleVideoSources(
  category: IStyleSourceCategoryConfig,
): Promise<IResolvedStyleVideoSource[]> {
  const resolved: IResolvedStyleVideoSource[] = [];
  const seen = new Set<string>();

  for (const source of category.sources) {
    if (source.type === 'file') {
      if (classifyExt(extname(source.path)) !== 'video') continue;
      if (seen.has(source.path)) continue;
      resolved.push({
        source,
        sourcePath: source.path,
        displayName: basename(source.path),
        fileKey: buildSourceFileKey(source, basename(source.path)),
      });
      seen.add(source.path);
      continue;
    }

    const scanned = await scanDirectory(source.path);
    const videos = scanned
      .filter(item => item.kind === 'video')
      .sort((left, right) => left.path.localeCompare(right.path));
    for (const video of videos) {
      if (seen.has(video.path)) continue;
      resolved.push({
        source,
        sourcePath: video.path,
        displayName: basename(video.path),
        fileKey: buildSourceFileKey(source, basename(video.path)),
      });
      seen.add(video.path);
    }
  }

  return resolved;
}

async function prepareStyleClip(input: {
  workspaceRoot: string;
  categoryId: string;
  video: IResolvedStyleVideoSource;
  runtimeConfig: Awaited<ReturnType<typeof loadRuntimeConfig>>;
  current: number;
  total: number;
  progressPath: string;
  category: IStyleSourceCategoryConfig;
}): Promise<string> {
  const { rangeStart, rangeEnd } = input.video.source;
  if (!rangeStart?.trim() && !rangeEnd?.trim()) {
    await writeStyleProgress(input.progressPath, {
      status: 'running',
      stage: 'clip',
      current: input.current,
      total: input.total,
      fileName: input.video.displayName,
      category: input.category,
      detail: {
        totalVideos: input.total,
        currentVideo: input.video.displayName,
        currentSourcePath: input.video.sourcePath,
        clipPath: input.video.sourcePath,
        message: '未指定 clip range，直接复用原始参考视频。',
      },
    });
    return input.video.sourcePath;
  }

  const startMs = parseStyleTimestampToMs(rangeStart);
  const endMs = parseStyleTimestampToMs(rangeEnd);
  if (typeof endMs === 'number' && typeof startMs === 'number' && endMs <= startMs) {
    throw new Error(`Invalid style-analysis range for ${input.video.displayName}: rangeEnd must be greater than rangeStart`);
  }

  const clipsRoot = getWorkspaceStyleAnalysisClipsRoot(input.workspaceRoot, input.categoryId);
  await mkdir(clipsRoot, { recursive: true });
  const clipPath = join(clipsRoot, `${input.video.fileKey}.mp4`);
  const existing = await stat(clipPath).then(() => clipPath).catch(() => null);
  if (existing) {
    await writeStyleProgress(input.progressPath, {
      status: 'running',
      stage: 'clip',
      current: input.current,
      total: input.total,
      fileName: input.video.displayName,
      category: input.category,
      detail: {
        totalVideos: input.total,
        currentVideo: input.video.displayName,
        currentSourcePath: input.video.sourcePath,
        clipPath,
        message: '复用已存在的 clipped input。',
      },
    });
    return clipPath;
  }

  await writeStyleProgress(input.progressPath, {
    status: 'running',
    stage: 'clip',
    current: input.current,
    total: input.total,
    fileName: input.video.displayName,
    category: input.category,
    detail: {
      totalVideos: input.total,
      currentVideo: input.video.displayName,
      currentSourcePath: input.video.sourcePath,
      clipPath,
      message: '按 style source 的 range 裁切参考视频片段。',
    },
  });

  const ffmpeg = input.runtimeConfig.ffmpegPath?.trim() || 'ffmpeg';
  const sourcePath = toExecutableInputPath(input.video.sourcePath, ffmpeg);
  const targetPath = toExecutableInputPath(clipPath, ffmpeg);
  const analysisWidth = input.runtimeConfig.analysisProxyWidth && input.runtimeConfig.analysisProxyWidth > 0
    ? Math.round(input.runtimeConfig.analysisProxyWidth)
    : 1024;
  const pixelFormat = input.runtimeConfig.analysisProxyPixelFormat?.trim() || 'yuv420p';
  const args = [
    ...(typeof startMs === 'number' ? ['-ss', formatSeconds(startMs)] : []),
    '-i', sourcePath,
    ...(typeof endMs === 'number' && typeof startMs === 'number'
      ? ['-t', formatSeconds(endMs - startMs)]
      : typeof endMs === 'number'
        ? ['-to', formatSeconds(endMs)]
        : []),
    '-vf', `scale=w='min(iw,${analysisWidth})':h=-2:flags=fast_bilinear,format=pix_fmts=${pixelFormat}`,
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '22',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-movflags', '+faststart',
    '-y',
    targetPath,
  ];
  await execFile(ffmpeg, args, { maxBuffer: 50 * 1024 * 1024 });
  return clipPath;
}

async function writeStyleProgress(
  progressPath: string,
  input: IWriteStyleProgressInput,
): Promise<void> {
  const total = input.total ?? input.detail?.totalVideos;
  const current = input.current ?? input.videoIndex;
  await writeJson(progressPath, {
    ...input,
    updatedAt: new Date().toISOString(),
    category: {
      slug: input.category.categoryId,
      name: input.category.displayName,
    },
    videoIndex: input.videoIndex ?? current,
    videoTotal: input.videoTotal ?? total,
    percent: typeof input.percent === 'number'
      ? input.percent
      : typeof current === 'number' && typeof total === 'number' && total > 0
        ? computePercent(current, total)
        : undefined,
  } satisfies IStyleProgressPayload);
}

function buildAgentInput(input: {
  category: IStyleSourceCategoryConfig;
  video: IResolvedStyleVideoSource;
  clipPath: string;
  probed: IProbeResult;
  rhythm: IRhythmStats;
  shotRecognitions: IShotRecognition[];
  transcript: string;
}): IStyleReferenceVideoAnalysis {
  const contentInsights = [
    input.video.source.note ? `来源备注：${input.video.source.note}` : null,
    input.video.source.includeNotes ? `纳入说明：${input.video.source.includeNotes}` : null,
    input.video.source.excludeNotes ? `排除说明：${input.video.source.excludeNotes}` : null,
    typeof input.probed.durationMs === 'number' ? `片段时长：${Math.round(input.probed.durationMs / 1000)} 秒` : null,
    input.probed.width && input.probed.height ? `分辨率：${input.probed.width}x${input.probed.height}` : null,
    `镜头数量：${input.rhythm.shotCount}`,
    `剪辑密度：${input.rhythm.cutsPerMinute.toFixed(2)} cuts/min`,
  ].filter((item): item is string => Boolean(item));

  return {
    sourceFile: input.clipPath,
    transcript: input.transcript,
    guidancePrompt: input.category.guidancePrompt,
    contentInsights,
    rhythm: input.rhythm,
    shotRecognitions: input.shotRecognitions,
  };
}

function buildSummaryAggregate(
  reports: IStyleReferenceVideoAnalysis[],
): IStylePreparationSummary['aggregate'] {
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

function buildSourceFileKey(source: IStyleSourceItem, displayName: string): string {
  const stem = displayName.replace(/\.[^.]+$/u, '');
  return `${sanitizeFileName(source.id)}-${sanitizeFileName(stem)}`;
}

function sanitizeFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '').toLowerCase() || 'item';
}

function parseStyleTimestampToMs(value?: string): number | undefined {
  if (!value?.trim()) return undefined;
  const trimmed = value.trim();
  if (/^\d+(?:\.\d+)?$/u.test(trimmed)) {
    return Math.round(Number(trimmed) * 1000);
  }

  const parts = trimmed.split(':').map(part => Number(part));
  if (parts.some(part => !Number.isFinite(part) || part < 0)) {
    throw new Error(`Invalid style-analysis timestamp: ${value}`);
  }
  if (parts.length === 2) {
    const [minutes, seconds] = parts;
    return Math.round((minutes * 60 + seconds) * 1000);
  }
  if (parts.length === 3) {
    const [hours, minutes, seconds] = parts;
    return Math.round((hours * 3600 + minutes * 60 + seconds) * 1000);
  }
  throw new Error(`Invalid style-analysis timestamp: ${value}`);
}

function formatSeconds(ms: number): string {
  return (Math.max(0, ms) / 1000).toFixed(3);
}

function computePercent(current: number, total: number): number {
  if (!total || total <= 0) return 0;
  return roundTo((current / total) * 100, 1);
}

function roundTo(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
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
