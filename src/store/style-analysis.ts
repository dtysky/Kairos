import { join } from 'node:path';

export function getWorkspaceStyleAnalysisRoot(
  workspaceRoot: string,
  categoryId: string,
): string {
  return join(workspaceRoot, '.tmp', 'style-analysis', categoryId);
}

export function getWorkspaceStyleAnalysisProgressPath(
  workspaceRoot: string,
  categoryId: string,
): string {
  return join(getWorkspaceStyleAnalysisRoot(workspaceRoot, categoryId), 'progress.json');
}

export function getWorkspaceStyleAnalysisClipsRoot(
  workspaceRoot: string,
  categoryId: string,
): string {
  return join(getWorkspaceStyleAnalysisRoot(workspaceRoot, categoryId), 'clips');
}

export function getWorkspaceStyleAnalysisKeyframesRoot(
  workspaceRoot: string,
  categoryId: string,
): string {
  return join(getWorkspaceStyleAnalysisRoot(workspaceRoot, categoryId), 'keyframes');
}

export function getWorkspaceStyleAnalysisSummaryPath(
  workspaceRoot: string,
  categoryId: string,
): string {
  return join(getWorkspaceStyleAnalysisRoot(workspaceRoot, categoryId), 'combined-summary.json');
}

export function getStyleAgentSummaryPath(
  workspaceRoot: string,
  categoryId: string,
): string {
  return join(getStyleReferenceReportsRoot(workspaceRoot, categoryId), 'agent-summary.json');
}

export function getStyleDraftPath(
  workspaceRoot: string,
  categoryId: string,
): string {
  return join(getStyleReferenceReportsRoot(workspaceRoot, categoryId), 'style-draft.json');
}

export function getStyleReviewPath(
  workspaceRoot: string,
  categoryId: string,
): string {
  return join(getStyleReferenceReportsRoot(workspaceRoot, categoryId), 'style-review.json');
}

export function getStyleAgentPacketsRoot(
  workspaceRoot: string,
  categoryId: string,
): string {
  return join(getStyleReferenceReportsRoot(workspaceRoot, categoryId), 'packets');
}

export function getStyleAgentPacketPath(
  workspaceRoot: string,
  categoryId: string,
  stage: string,
): string {
  return join(getStyleAgentPacketsRoot(workspaceRoot, categoryId), `${stage}.json`);
}

export function getStyleReferenceReportsRoot(
  workspaceRoot: string,
  categoryId: string,
): string {
  return join(workspaceRoot, 'analysis', 'style-references', categoryId);
}

export function getStyleReferenceTranscriptsRoot(
  workspaceRoot: string,
  categoryId: string,
): string {
  return join(workspaceRoot, 'analysis', 'reference-transcripts', categoryId);
}
