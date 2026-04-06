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
  prepareProjectMaterialDigest,
  prepareSegmentPlanning,
  buildProjectMaterialDigest,
  buildSegmentPlanDrafts,
  type IPrepareProjectMaterialDigestInput,
  type IPrepareProjectMaterialDigestResult,
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
  prepareProjectScriptForAgent,
  loadProjectStyleByCategory,
  type IBuildProjectOutlineInput,
  type IBuildProjectOutlineResult,
  type IGenerateProjectScriptInput,
  type IPrepareProjectScriptForAgentInput,
  type IPrepareProjectScriptForAgentResult,
} from './project-script.js';
export { generateScript, buildStylePrompt, buildOutlinePrompt } from './script-generator.js';
export {
  reorderSegments,
  updateNarration,
  removeSegment,
  insertSegment,
  rewriteNarration,
} from './script-editor.js';
