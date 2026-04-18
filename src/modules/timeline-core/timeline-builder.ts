import { randomUUID } from 'node:crypto';
import type {
  IAssetCoarseReport,
  IKtepTimeline, IKtepDoc, IKtepAsset, IKtepSlice,
  IKtepScript, IKtepProject, IKtepSubtitle,
  IMediaChronology,
  ISegmentRoughCutPlan,
} from '../../protocol/schema.js';
import { CPROTOCOL, CVERSION } from '../../protocol/schema.js';
import type { IRuntimeConfig } from '../../store/project.js';
import { placeClips, type IPlacementConfig } from './placement.js';
import { planTransitions, type ITransitionConfig } from './transition.js';
import { planSubtitles, type ISubtitleConfig } from './subtitle.js';
import { normalizeScriptTiming } from './pacing.js';
import { validateKtepDoc } from '../../protocol/validator.js';
import { buildTimelineScriptFromSegmentCuts } from './segment-cuts.js';

export interface IBuildConfig {
  fps: number;
  width: number;
  height: number;
  name: string;
  assetReports?: IAssetCoarseReport[];
  chronology?: IMediaChronology[];
  reviewedSegmentCuts?: ISegmentRoughCutPlan[];
  placement?: Partial<IPlacementConfig>;
  transition?: Partial<ITransitionConfig>;
  subtitle?: Partial<ISubtitleConfig>;
}

export type ITimelineRuntimeConfig = Pick<
  IRuntimeConfig,
  'timelineFps' | 'timelineWidth' | 'timelineHeight'
>;

const CDEFAULTS: IBuildConfig = {
  fps: 30,
  width: 3840,
  height: 2160,
  name: 'Untitled',
};

export function resolveTimelineBuildConfig(
  runtimeConfig: Partial<ITimelineRuntimeConfig> = {},
  overrides: Partial<IBuildConfig> = {},
): IBuildConfig {
  return {
    ...CDEFAULTS,
    ...(runtimeConfig.timelineFps != null && { fps: runtimeConfig.timelineFps }),
    ...(runtimeConfig.timelineWidth != null && { width: runtimeConfig.timelineWidth }),
    ...(runtimeConfig.timelineHeight != null && { height: runtimeConfig.timelineHeight }),
    ...overrides,
  };
}

/**
 * 完整时间线构建流水线：
 *   脚本时长归一化 → 摆放 → 转场 → 字幕 → 校验 → KtepDoc
 */
export function buildTimeline(
  project: IKtepProject,
  assets: IKtepAsset[],
  slices: IKtepSlice[],
  script: IKtepScript[],
  config: Partial<IBuildConfig> = {},
): IKtepDoc {
  const cfg = resolveTimelineBuildConfig({}, config);
  const effectiveScript = cfg.reviewedSegmentCuts?.length
    ? buildTimelineScriptFromSegmentCuts(script, cfg.reviewedSegmentCuts)
    : normalizeScriptTiming(script, slices, cfg.subtitle);

  // 1. Place clips
  const { tracks, clips: rawClips } = placeClips(
    effectiveScript,
    slices,
    assets,
    { ...cfg.placement, chronology: cfg.chronology, reviewedSegmentCuts: cfg.reviewedSegmentCuts },
    cfg.assetReports,
  );

  // 2. Plan transitions
  const clips = planTransitions(rawClips, cfg.transition);

  // 3. Build timeline object
  const timeline: IKtepTimeline = {
    id: randomUUID(),
    name: cfg.name,
    fps: cfg.fps,
    resolution: { width: cfg.width, height: cfg.height },
    tracks,
    clips,
  };

  // 4. Plan subtitles
  const subtitles: IKtepSubtitle[] = planSubtitles(
    effectiveScript,
    clips,
    slices,
    { ...cfg.subtitle, reviewedSegmentCuts: cfg.reviewedSegmentCuts },
  );

  // 5. Assemble document
  const doc: IKtepDoc = {
    protocol: CPROTOCOL,
    version: CVERSION,
    project,
    assets,
    spans: slices,
    slices,
    script: effectiveScript,
    timeline,
    subtitles,
  };

  // 6. Validate
  const result = validateKtepDoc(doc);
  if (!result.ok) {
    const msg = result.errors.map(e => `[${e.rule}] ${e.message}`).join('\n');
    throw new Error(`Timeline validation failed:\n${msg}`);
  }

  return doc;
}
