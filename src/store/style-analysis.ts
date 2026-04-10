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
