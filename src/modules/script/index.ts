export { analyzeStyle, analyzeStyleFromReports, type IStyleReferenceVideoAnalysis } from './style-analyzer.js';
export {
  loadStyleFromMarkdown,
  loadStyleByCategory,
  listStyleCategories,
  parseStyleMarkdown,
  buildFrontMatter,
  type IStyleLoadOptions,
} from './style-loader.js';
export { buildOutline, type IOutlineBeat, type IOutlineSegment } from './outline-builder.js';
export { buildOutlineFromApprovedPlan } from './outline-builder.js';
export {
  prepareSegmentPlanning,
  buildProjectMaterialDigest,
  buildSegmentPlanDrafts,
  type IPrepareSegmentPlanningInput,
  type IPrepareSegmentPlanningResult,
} from './segment-planner.js';
export {
  approveSegmentPlan,
  recallSegmentCandidates,
  loadExistingOrRecallSegmentCandidates,
  type IApproveSegmentPlanInput,
  type IRecallSegmentCandidatesInput,
} from './candidate-recall.js';
export {
  buildProjectOutlineFromPlanning,
  generateProjectScriptFromPlanning,
  loadProjectStyleByCategory,
  type IBuildProjectOutlineInput,
  type IBuildProjectOutlineResult,
  type IGenerateProjectScriptInput,
} from './project-script.js';
export { generateScript, buildStylePrompt, buildOutlinePrompt } from './script-generator.js';
export {
  reorderSegments,
  updateNarration,
  removeSegment,
  insertSegment,
  rewriteNarration,
} from './script-editor.js';
