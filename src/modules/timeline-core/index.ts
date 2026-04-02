export { placeClips, type IPlacementConfig } from './placement.js';
export { planTransitions, type ITransitionConfig } from './transition.js';
export { planSubtitles, type ISubtitleConfig } from './subtitle.js';
export {
  estimateNarrationBeatDurationMs,
  estimateNarrationDurationMs,
  normalizeScriptTiming,
  type ISpeechPacingConfig,
} from './pacing.js';
export {
  buildTimeline,
  resolveTimelineBuildConfig,
  type IBuildConfig,
  type ITimelineRuntimeConfig,
} from './timeline-builder.js';
