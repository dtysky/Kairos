/**
 * Workflow progress reporting — read/write `.tmp/<pipeline>/<scope>/progress.json`.
 *
 * Designed for long-running pipelines (style analysis, media analysis, etc.)
 * to expose structured progress that local dashboards can poll.
 */
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { IWorkflowProgress, EWorkflowStatus } from '../protocol/schema.js';
import { IWorkflowProgress as IWorkflowProgressSchema } from '../protocol/schema.js';
import { readJsonOrNull, writeJson } from './writer.js';

function progressDir(projectRoot: string, pipeline: string, scope: string): string {
  return join(projectRoot, '.tmp', pipeline, scope);
}

function progressPath(projectRoot: string, pipeline: string, scope: string): string {
  return join(progressDir(projectRoot, pipeline, scope), 'progress.json');
}

export async function readProgress(
  projectRoot: string,
  pipeline: string,
  scope: string,
): Promise<IWorkflowProgress | null> {
  return readJsonOrNull(progressPath(projectRoot, pipeline, scope), IWorkflowProgressSchema);
}

export async function writeProgress(
  projectRoot: string,
  pipeline: string,
  scope: string,
  progress: IWorkflowProgress,
): Promise<void> {
  const dir = progressDir(projectRoot, pipeline, scope);
  await mkdir(dir, { recursive: true });
  await writeJson(join(dir, 'progress.json'), progress);
}

export interface IProgressInit {
  pipelineKey: string;
  pipelineLabel: string;
  totalSteps: number;
  totalFiles?: number;
}

export function createProgress(init: IProgressInit): IWorkflowProgress {
  return {
    pipelineKey: init.pipelineKey,
    pipelineLabel: init.pipelineLabel,
    phaseKey: 'init',
    phaseLabel: '初始化',
    status: 'queued',
    currentStep: 0,
    totalSteps: init.totalSteps,
    totalFiles: init.totalFiles,
    updatedAt: new Date().toISOString(),
  };
}

export interface IProgressUpdate {
  phaseKey?: string;
  phaseLabel?: string;
  status?: EWorkflowStatus;
  currentStep?: number;
  currentFileIndex?: number;
  totalFiles?: number;
  currentFrameIndex?: number;
  totalFrames?: number;
  etaSeconds?: number;
  currentFile?: string;
  note?: string;
}

export function updateProgress(
  prev: IWorkflowProgress,
  update: IProgressUpdate,
): IWorkflowProgress {
  return {
    ...prev,
    ...update,
    updatedAt: new Date().toISOString(),
  };
}

export async function advanceProgress(
  projectRoot: string,
  pipeline: string,
  scope: string,
  prev: IWorkflowProgress,
  update: IProgressUpdate,
): Promise<IWorkflowProgress> {
  const next = updateProgress(prev, update);
  await writeProgress(projectRoot, pipeline, scope, next);
  return next;
}

export function tmpDir(projectRoot: string, pipeline: string, scope: string): string {
  return progressDir(projectRoot, pipeline, scope);
}
