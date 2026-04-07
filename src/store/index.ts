export { readJson, readJsonOrNull, writeJson } from './writer.js';
export {
  buildProjectBriefTemplate,
  parseProjectBrief,
  normalizeProjectBriefLocalPath,
  type IProjectBriefTemplateInput,
  type IProjectBriefPathMapping,
  type IParsedProjectBrief,
} from './project-brief.js';
export {
  getScriptBriefPath,
  buildScriptBriefTemplate,
  writeScriptBriefTemplate,
  syncScriptBriefSegments,
  seedScriptBriefDraft,
  loadScriptBrief,
  extractSegmentBrief,
  loadOptionalMarkdown,
  type IScriptBriefTemplateInput,
  type IScriptBriefSegmentTemplateInput,
} from './script-brief.js';
export {
  syncProjectBriefMappings,
  buildProjectBriefWithMappings,
  type ISyncProjectBriefInput,
  type ISyncProjectBriefResult,
} from './project-brief-sync.js';
export {
  initProject,
  loadManifest,
  loadProject,
  loadIngestRoots,
  loadRuntimeConfig,
  touchProjectUpdatedAt,
  type IRuntimeConfig,
} from './project.js';
export {
  IKairosProgress,
  IKairosProgressStep,
  getProjectProgressPath,
  writeKairosProgress,
  estimateRemainingSeconds,
  type IWriteKairosProgressInput,
} from './progress.js';
export {
  resolveProjectsRoot,
  resolveWorkspaceProjectRoot,
  initWorkspaceProject,
  syncWorkspaceProjectBrief,
  writeWorkspaceProjectBrief,
  listWorkspaceProjects,
  type IWorkspaceProjectEntry,
} from './workspace.js';
export {
  getGlobalDeviceMediaMapPath,
  getProjectDeviceMediaMapPath,
  getDefaultDeviceMediaMapPath,
  loadDeviceMediaMaps,
  loadProjectDeviceMediaMaps,
  saveDeviceMediaMaps,
  saveDeviceProjectMap,
  saveProjectDeviceMap,
  assignDeviceMediaRoot,
  assignProjectDeviceMediaRoot,
} from './device-media-maps.js';
export {
  getAssetReportsRoot,
  getAssetReportPath,
  loadAssetReport,
  loadAssetReports,
  writeAssetReport,
  appendAssetReports,
  findUnreportedAssets,
} from './analysis.js';
export {
  getPreparedAssetCheckpointRoot,
  getPreparedAssetCheckpointPath,
  loadPreparedAssetCheckpoint,
  writePreparedAssetCheckpoint,
  removePreparedAssetCheckpoint,
  type IPreparedAssetCheckpoint,
} from './analyze-prepared.js';
export {
  getAudioAnalysisCheckpointRoot,
  getAudioAnalysisCheckpointPath,
  loadAudioAnalysisCheckpoint,
  writeAudioAnalysisCheckpoint,
  removeAudioAnalysisCheckpoint,
  type IAudioAnalysisCheckpoint,
} from './analyze-audio.js';
export {
  getFineScanCheckpointRoot,
  getFineScanCheckpointPath,
  loadFineScanCheckpoint,
  writeFineScanCheckpoint,
  removeFineScanCheckpoint,
  type EFineScanCheckpointStatus,
  type IFineScanCheckpoint,
} from './analyze-fine-scan.js';
export {
  getChronologyPath,
  loadChronology,
  writeChronology,
} from './chronology.js';
export {
  getOutlinePath,
  getOutlinePromptPath,
  getCurrentScriptPath,
  loadOutline,
  writeOutline,
  loadCurrentScript,
  writeCurrentScript,
} from './script-store.js';
export {
  getProjectMaterialDigestPath,
  getSegmentPlanDraftsPath,
  getApprovedSegmentPlanPath,
  getSegmentCandidatesPath,
  loadProjectMaterialDigest,
  writeProjectMaterialDigest,
  loadSegmentPlanDrafts,
  writeSegmentPlanDrafts,
  loadApprovedSegmentPlan,
  writeApprovedSegmentPlan,
  loadSegmentCandidates,
  writeSegmentCandidates,
} from './segment-plan.js';
export {
  getAssetsPath,
  getSlicesPath,
  loadAssets,
  loadSlices,
  buildAssetMergeKey,
  mergeAssets,
  findUnanalyzedAssets,
  mergeSlices,
  appendAssets,
  appendSlices,
  type IMergeResult,
} from './incremental.js';
export {
  getManualItineraryPath,
  loadManualItinerary,
  type IManualItinerarySegment,
  type ILoadedManualItinerary,
} from './spatial-context.js';
export {
  getManualItineraryGeoCachePath,
  loadManualItineraryGeoCache,
  writeManualItineraryGeoCache,
  findManualItineraryGeoCacheEntry,
  normalizeManualItineraryGeoQuery,
  type IManualItineraryGeoCache,
  type IManualItineraryGeoCacheEntry,
} from './manual-itinerary-geo.js';
export {
  getProjectGpsRoot,
  getProjectGpsTracksRoot,
  getProjectSameSourceGpsRoot,
  getProjectSameSourceGpsTracksRoot,
  getProjectGpsMergedPath,
  getProjectSameSourceGpsIndexPath,
  getProjectSameSourceGpsTrackPath,
  getProjectDerivedTrackPath,
  ensureProjectGpsDirs,
  listProjectGpsTrackPaths,
  loadProjectGpsMerged,
  loadProjectGpsMergedByPath,
  loadProjectSameSourceGpsIndex,
  loadProjectSameSourceGpsIndexByPath,
  loadProjectDerivedTrack,
  loadProjectDerivedTrackByPath,
  writeProjectGpsMerged,
  writeProjectSameSourceGpsIndex,
  writeProjectDerivedTrack,
  type IProjectGpsPoint,
  type IProjectGpsTrackSummary,
  type IProjectGpsMerged,
  EProjectSameSourceGpsOriginType,
  type IProjectSameSourceGpsTrackSummary,
  type IProjectSameSourceGpsIndex,
  EProjectDerivedTrackMatchKind,
  type IProjectDerivedTrackEntry,
  type IProjectDerivedTrack,
} from './gps.js';
export {
  getProjectPharosRoot,
  getProjectPharosContextPath,
  loadProjectPharosContext,
  writeProjectPharosContext,
} from './pharos.js';
export {
  getReviewQueuePath,
  loadReviewQueue,
  saveReviewQueue,
  upsertReviewItems,
  replaceReviewItemsByMatcher,
  resolveReviewItem,
} from './review-queue.js';
export {
  getProjectBriefConfigPath,
  getManualItineraryConfigPath,
  getScriptBriefConfigPath,
  getWorkspaceStyleSourcesConfigPath,
  loadProjectBriefConfig,
  saveProjectBriefConfig,
  loadManualItineraryConfig,
  saveManualItineraryConfig,
  loadScriptBriefConfig,
  saveScriptBriefConfig,
  loadStyleSourcesConfig,
  saveStyleSourcesConfig,
} from './workspace-config.js';
