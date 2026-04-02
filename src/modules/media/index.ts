export { scanDirectory, classifyExt, type IScannedFile } from './scanner.js';
export { buildAssetCoarseReport, type IBuildAssetCoarseReportInput } from './asset-report.js';
export { buildMediaChronology } from './chronology.js';
export {
  resolveMediaRootsForDevice,
  resolveAssetLocalPath,
  toPortableRelativePath,
  type IResolvedMediaRoot,
  type IMediaRootResolution,
} from './root-resolver.js';
export { probe, type IProbeResult, type IMediaToolConfig } from './probe.js';
export { toExecutableInputPath } from './tool-path.js';
export { resolveCaptureTime } from './capture-time.js';
export { detectShots, computeRhythmStats, type IShotBoundary, type IRhythmStats } from './shot-detect.js';
export {
  extractKeyframes,
  extractImageProxy,
  uniformTimestamps,
  buildShotWindows,
  planShotKeyframes,
  flattenShotKeyframePlans,
  groupKeyframesByShot,
  type IKeyframeResult,
  type IShotWindow,
  type IShotKeyframePlan,
  type IShotKeyframeGroup,
} from './keyframe.js';
export { slicePhoto, sliceVideo, sliceInterestingWindows } from './slicer.js';
export {
  applyTypeAwareWindowExpansion,
  buildDriveSpeedCandidate,
  hasExplicitEditRange,
  mergeInterestingWindowsByPreferredBounds,
  resolveSlicePreferredRange,
  resolveWindowPreferredRange,
  type ITypeAwareWindowExpansionInput,
} from './window-policy.js';
export { MlClient, type IAsrSegment, type IOcrResult, type IVlmResult, type IMlHealth } from './ml-client.js';
export { transcribe, type ITranscription } from './transcriber.js';
export { extractOcr, type IOcrExtraction } from './ocr.js';
export { estimateDensity, type IDensityInput, type IDensityResult } from './density.js';
export {
  buildAnalysisPlan,
  pickCoarseSampleCount,
  type ISamplerInput,
} from './sampler.js';
export { evidenceFromPath } from './evidence.js';
export { recognizeFrames, recognizeShotGroups, type IRecognition, type IShotRecognition } from './recognizer.js';
export {
  ingestWorkspaceProjectMedia,
  type IIngestWorkspaceProjectInput,
  type IIngestWorkspaceProjectResult,
  type IIngestedRootSummary,
} from './project-ingest.js';
export {
  analyzeWorkspaceProjectMedia,
  type IAnalyzeWorkspaceProjectInput,
  type IAnalyzeWorkspaceProjectResult,
} from './project-analyze.js';
export {
  inferManualItineraryGps,
  type IManualSpatialContext,
  type IInferManualItineraryGpsInput,
} from './manual-spatial.js';
export {
  resolveEmbeddedGpsContext,
  type IEmbeddedGpsContext,
} from './gps-embedded.js';
export {
  prepareRootSameSourceGpsContext,
  resolveAssetSameSourceGpsBinding,
  resolveSidecarSrtBinding,
  bindAssetToFlightRecordPoints,
  loadSameSourceTrackPoints,
  loadEmbeddedGpsBindingPoints,
  pickNearestEmbeddedGpsBindingPoint,
  type IPreparedRootGpsContext,
  type IResolveAssetSameSourceGpsBindingInput,
} from './same-source-gps.js';
export {
  resolveGpxSpatialContext,
  loadGpxPoints,
  loadGpxPointsFromPaths,
  type IGpxSpatialContext,
  type IGpxPoint,
  type IResolveGpxSpatialContextInput,
} from './gpx-spatial.js';
export {
  importProjectGpxTracks,
  refreshProjectGpsCache,
  getDefaultProjectGpxPaths,
  resolveProjectGpxPaths,
  type IImportProjectGpxTracksInput,
  type IImportProjectGpxTracksResult,
  type IResolveProjectGpxPathsInput,
} from './project-gps.js';
export {
  refreshProjectDerivedTrackCache,
  type IRefreshProjectDerivedTrackCacheInput,
} from './project-derived-track.js';
export {
  resolveAssetSpatialContext,
  type IResolveAssetSpatialContextInput,
} from './spatial-resolver.js';
