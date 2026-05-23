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
export {
  buildProjectTimeline,
  buildTimelineSourceSpeechSubtitles,
  syncProjectResolveMedia,
  type IBuildProjectTimelineInput,
  type IBuildProjectTimelineResult,
  type ISyncProjectResolveMediaInput,
  type ISyncProjectResolveMediaResult,
} from './project-timeline.js';
export {
  deriveResolveRoughCutProjectName,
  deriveResolveRoughCutTimelineName,
  resolveEditDrpLatestFilename,
} from './resolve-edit-naming.js';
export {
  snapshotProjectEditDrp,
  registerExternalEditDrpSnapshot,
  resolveLatestEditDrpSnapshot,
  ProjectEditDrpBlockedError,
  type ISnapshotProjectEditDrpInput,
  type ISnapshotProjectEditDrpResult,
  type IRegisterExternalEditDrpSnapshotInput,
  type IRegisterExternalEditDrpSnapshotResult,
} from './edit-resolve-snapshot.js';
export {
  buildDeterministicRoughCutBase,
  buildTimelineScriptFromSegmentCuts,
  findSegmentCutBeat,
} from './segment-cuts.js';
