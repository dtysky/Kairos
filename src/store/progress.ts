import { join } from 'node:path';
import { z } from 'zod';
import { writeJson } from './writer.js';

export const IKairosProgressStep = z.object({
  key: z.string(),
  label: z.string(),
});
export type IKairosProgressStep = z.infer<typeof IKairosProgressStep>;

export const IKairosProgress = z.object({
  updatedAt: z.string(),
  status: z.enum(['waiting', 'running', 'succeeded', 'failed']),
  pipelineKey: z.string(),
  pipelineLabel: z.string().optional(),
  phaseKey: z.string().optional(),
  phaseLabel: z.string().optional(),
  step: z.string().optional(),
  stepLabel: z.string().optional(),
  stepIndex: z.number().int().positive().optional(),
  stepTotal: z.number().int().positive().optional(),
  stepDefinitions: z.array(IKairosProgressStep).optional(),
  fileName: z.string().optional(),
  fileIndex: z.number().int().nonnegative().optional(),
  fileTotal: z.number().int().nonnegative().optional(),
  current: z.number().nonnegative().optional(),
  total: z.number().nonnegative().optional(),
  unit: z.string().optional(),
  etaSeconds: z.number().nonnegative().optional(),
  detail: z.string().optional(),
  extra: z.record(z.unknown()).optional(),
});
export type IKairosProgress = z.infer<typeof IKairosProgress>;

export type IWriteKairosProgressInput = Omit<IKairosProgress, 'updatedAt'> & {
  updatedAt?: string;
};

export function getProjectProgressPath(projectRoot: string, pipelineKey: string): string {
  return join(projectRoot, '.tmp', pipelineKey, 'progress.json');
}

export async function writeKairosProgress(
  path: string,
  progress: IWriteKairosProgressInput,
): Promise<IKairosProgress> {
  const normalized: IKairosProgress = {
    ...progress,
    updatedAt: progress.updatedAt ?? new Date().toISOString(),
  };
  await writeJson(path, normalized);
  return normalized;
}

export function estimateRemainingSeconds(
  startedAtMs: number,
  completedCount: number,
  totalCount: number,
): number | undefined {
  if (totalCount <= 0) return 0;
  if (completedCount <= 0) return undefined;
  if (completedCount >= totalCount) return 0;

  const elapsedSeconds = Math.max(1, Math.round((Date.now() - startedAtMs) / 1000));
  const perItemSeconds = elapsedSeconds / completedCount;
  return Math.max(0, Math.round(perItemSeconds * (totalCount - completedCount)));
}
