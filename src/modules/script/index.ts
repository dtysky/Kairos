export {
  analyzeStyle,
  analyzeStyleFromReports,
  runStyleProfileAgentPipeline,
  type IStyleReferenceVideoAnalysis,
  type IAnalyzeStyleOptions,
  type IAnalyzeStylePipelineResult,
} from './style-analyzer.js';
export {
  prepareWorkspaceStyleAnalysisForAgent,
  type IPrepareWorkspaceStyleAnalysisInput,
  type IPrepareWorkspaceStyleAnalysisResult,
  type TStylePreparationStatus,
} from './style-preparation.js';
export {
  loadStyleFromMarkdown,
  loadStyleByCategory,
  listStyleCategories,
  parseStyleMarkdown,
  buildFrontMatter,
  deriveStyleProtocolV2Fields,
  type IStyleLoadOptions,
} from './style-loader.js';
export {
  buildOutline,
  type IBuildOutlineInput,
  type IOutlineBeat,
  type IOutlineSegment,
} from './outline-builder.js';
export {
  draftProjectScriptOverviewAndBrief,
  buildProjectOutlineFromPlanning,
  generateProjectScriptFromPlanning,
  prepareProjectScriptForAgent,
  loadProjectStyleByCategory,
  buildProjectMaterialOverviewFacts,
  buildMaterialOverviewMarkdown,
  buildMaterialBundles,
  buildSpatialStoryContext,
  buildSpatialStoryMarkdown,
  buildScriptAgentContract,
  buildSegmentPlanDocument,
  buildMaterialSlotsDocument,
  resolveChosenSpanIds,
  type IBuildProjectOutlineInput,
  type IBuildProjectOutlineResult,
  type IDraftProjectScriptOverviewAndBriefInput,
  type IDraftProjectScriptOverviewAndBriefResult,
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
