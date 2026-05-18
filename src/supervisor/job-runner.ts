import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
	  AgentRunnerUnavailableError,
	  analyzeWorkspaceProjectMedia,
	  createProjectReverseGeocodeService,
	  importProjectGpxTracks,
	  ingestWorkspaceProjectMedia,
	  initWorkspaceProject,
	  loadProjectBriefConfig,
	  loadRuntimeConfig,
  buildProjectChronology,
  rebuildProjectSpans,
  runEditFlowAction,
	  prepareWorkspaceStyleAnalysisForAgent,
	  ColorPrepBlockedError,
	  ProjectColorBlockedError,
	  refreshAnalyzeSpatialResults,
	  runProjectColorAction,
	  refreshProjectDerivedTrackCache,
  refreshProjectGpsCache,
  MlClient,
  MlJsonPacketAgentRunner,
  resolveWorkspaceProjectRoot,
} from '../index.js';
import {
  writeKairosProgress,
  writeJson,
} from '../store/index.js';
import {
  loadJobRecord,
  writeJobRecord,
  getSupervisorJobRoot,
  type TSupervisorJobStatus,
} from './state.js';
import { ensureMlServiceRunning, stopMlService } from './runtime.js';
import { loadOrBuildProjectPharosContext } from '../modules/pharos/context.js';

class BlockedJobError extends Error {
  constructor(public blockers: string[]) {
    super(blockers.join('; '));
    this.name = 'BlockedJobError';
  }
}

interface IJobExecutionResult {
  result?: unknown;
  finalStatus?: Extract<TSupervisorJobStatus, 'completed' | 'awaiting_agent' | 'failed'>;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const workspaceRoot = args.workspaceRoot ?? process.cwd();
  const jobId = args.jobId;
  if (!jobId) {
    throw new Error('Missing --jobId');
  }

  const record = await loadJobRecord(workspaceRoot, jobId);
  if (!record) {
    throw new Error(`Missing job record: ${jobId}`);
  }

  const startedAt = new Date().toISOString();
  await writeJobRecord(workspaceRoot, {
    ...record,
    status: 'running',
    startedAt: record.startedAt ?? startedAt,
    updatedAt: startedAt,
  });

  let shouldStopMlAfterRun = false;
  try {
    const shouldManageMl = await shouldEnsureManagedMl(workspaceRoot, record.jobType, record.projectId);
    if (shouldManageMl) {
      shouldStopMlAfterRun = true;
      await ensureMlServiceRunning(workspaceRoot);
    }

    const execution = await runJob(
      workspaceRoot,
      record.jobType,
      record.projectId,
      record.args,
      record.jobId,
      record.progressPath,
    );
    const resultPath = record.resultPath ?? join(getSupervisorJobRoot(workspaceRoot, record.jobId), 'result.json');
    await writeJson(resultPath, execution.result ?? { ok: true });
    await writeJobRecord(workspaceRoot, {
      ...record,
      status: execution.finalStatus ?? 'completed',
      resultPath,
      startedAt: record.startedAt ?? startedAt,
      finishedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      blockers: [],
    });
  } catch (error) {
    if (error instanceof BlockedJobError) {
      await writeJobFailureProgress(record, 'blocked', error.message).catch(() => undefined);
      await writeJobRecord(workspaceRoot, {
        ...record,
        status: 'blocked',
        startedAt: record.startedAt ?? startedAt,
        finishedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        blockers: error.blockers,
        lastError: error.message,
      });
      return;
    }

    await writeJobFailureProgress(
      record,
      'failed',
      error instanceof Error ? error.message : String(error),
    ).catch(() => undefined);
    await writeJobRecord(workspaceRoot, {
      ...record,
      status: 'failed',
      startedAt: record.startedAt ?? startedAt,
      finishedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastError: error instanceof Error ? error.stack ?? error.message : String(error),
    });
    throw error;
  } finally {
    if (shouldStopMlAfterRun) {
      await stopMlService(workspaceRoot).catch(() => undefined);
    }
  }
}

async function runJob(
  workspaceRoot: string,
  jobType: string,
  projectId: string | undefined,
  args: Record<string, unknown>,
  jobId?: string,
  progressPath?: string,
): Promise<IJobExecutionResult> {
  switch (jobType) {
    case 'project-init': {
      if (!projectId) {
        throw new BlockedJobError(['project-init requires projectId']);
      }
      const projectName = toStringValue(args.name) || projectId;
      const description = toStringValue(args.description);
      const projectRoot = await initWorkspaceProject(workspaceRoot, projectId, projectName, description);
      return { result: { projectRoot } };
    }
    case 'ingest': {
      if (!projectId) {
        throw new BlockedJobError(['ingest requires projectId']);
      }
      const projectRoot = resolveWorkspaceProjectRoot(workspaceRoot, projectId);
      const runtimeConfig = await loadRuntimeConfig(projectRoot);
      const reverseGeocodeService = await createProjectReverseGeocodeService({
        projectRoot,
        runtimeConfig,
      });
      return {
        result: await ingestWorkspaceProjectMedia({
          workspaceRoot,
          projectId,
          reverseGeocodeService,
        }),
      };
    }
    case 'gps-refresh': {
      if (!projectId) {
        throw new BlockedJobError(['gps-refresh requires projectId']);
      }
      const projectRoot = resolveWorkspaceProjectRoot(workspaceRoot, projectId);
      const runtimeConfig = await loadRuntimeConfig(projectRoot);
      const reverseGeocodeService = await createProjectReverseGeocodeService({
        projectRoot,
        runtimeConfig,
      });
      const importedGpx = toStringArray(args.gpxPaths);
      const imported = importedGpx.length > 0
        ? await importProjectGpxTracks({
          projectRoot,
          sourcePaths: importedGpx,
        })
        : null;
      const merged = await refreshProjectGpsCache(projectRoot);
      const derived = await refreshProjectDerivedTrackCache({
        projectRoot,
        reverseGeocodeService,
      });
      const projectBrief = await loadProjectBriefConfig(projectRoot);
      const pharos = await loadOrBuildProjectPharosContext({
        projectRoot,
        includedTripIds: projectBrief.pharos?.includedTripIds ?? [],
      });
      if (pharos.status === 'failure') {
        throw new BlockedJobError(pharos.errors.length > 0
          ? pharos.errors
          : ['Pharos context 解析失败']);
      }
      return {
        result: {
          imported,
          merged,
          derived,
          pharos,
        },
      };
    }
	    case 'analyze': {
	      if (!projectId) {
	        throw new BlockedJobError(['analyze requires projectId']);
	      }
      const projectRoot = resolveWorkspaceProjectRoot(workspaceRoot, projectId);
      const runtimeConfig = await loadRuntimeConfig(projectRoot);
      const reverseGeocodeService = await createProjectReverseGeocodeService({
        projectRoot,
        runtimeConfig,
      });
      return {
        result: await analyzeWorkspaceProjectMedia({
          workspaceRoot,
          projectId,
          assetIds: toStringArray(args.assetIds),
          reverseGeocodeService,
	        }),
	      };
	    }
	    case 'spatial-refresh': {
	      if (!projectId) {
	        throw new BlockedJobError(['spatial-refresh requires projectId']);
	      }
	      const projectRoot = resolveWorkspaceProjectRoot(workspaceRoot, projectId);
	      const runtimeConfig = await loadRuntimeConfig(projectRoot);
	      const reverseGeocodeService = await createProjectReverseGeocodeService({
	        projectRoot,
	        runtimeConfig,
	      });
	      return {
	        result: await refreshAnalyzeSpatialResults({
	          workspaceRoot,
	          projectId,
	          reverseGeocodeService,
	        }),
	      };
	    }
    case 'span-rebuild': {
      if (!projectId) {
        throw new BlockedJobError(['span-rebuild requires projectId']);
      }
      const projectRoot = resolveWorkspaceProjectRoot(workspaceRoot, projectId);
      const runtimeConfig = await loadRuntimeConfig(projectRoot);
      try {
        return {
          result: await rebuildProjectSpans({
            workspaceRoot,
            projectId,
            agentRunner: new MlJsonPacketAgentRunner(new MlClient(runtimeConfig.mlServerUrl)),
          }),
        };
      } catch (error) {
        if (error instanceof AgentRunnerUnavailableError) {
          throw new BlockedJobError([error.message]);
        }
        throw error;
      }
    }
    case 'chronology-build': {
      if (!projectId) {
        throw new BlockedJobError(['chronology-build requires projectId']);
      }
      const projectRoot = resolveWorkspaceProjectRoot(workspaceRoot, projectId);
      const runtimeConfig = await loadRuntimeConfig(projectRoot);
      const reverseGeocodeService = await createProjectReverseGeocodeService({
        projectRoot,
        runtimeConfig,
        uncachedRequestDelayMs: 350,
      });
      return {
        result: await buildProjectChronology({
          workspaceRoot,
          projectId,
          progressPath,
          reverseGeocodeService,
        }),
      };
    }
    case 'edit-flow': {
      if (!projectId) {
        throw new BlockedJobError(['edit-flow requires projectId']);
      }
      const action = toEditFlowAction(args.action);
      const projectRoot = resolveWorkspaceProjectRoot(workspaceRoot, projectId);
      try {
        const result = await runEditFlowAction({
          workspaceRoot,
          projectRoot,
          editId: toStringValue(args.editId),
          action,
          editRuleCategory: toStringValue(args.editRuleCategory) || undefined,
          styleCategory: toStringValue(args.styleCategory) || undefined,
          stepId: toStringValue(args.stepId) || undefined,
          runner: toEditFlowRunner(args.runner) || undefined,
        });
        return {
          finalStatus: 'completed',
          result,
        };
      } catch (error) {
        if (error instanceof AgentRunnerUnavailableError) {
          throw new BlockedJobError([error.message]);
        }
        throw error;
      }
    }
    case 'style-analysis': {
      const result = await prepareWorkspaceStyleAnalysisForAgent({
        workspaceRoot,
        categoryId: toStringValue(args.categoryId),
      });
      return {
        finalStatus: result.status,
        result,
      };
    }
    case 'color': {
      if (!projectId) {
        throw new BlockedJobError(['color requires projectId']);
      }
      const action = toStringValue(args.action) as
        | 'prepare_root'
        | 'sync_groups'
        | 'execute_root'
        | 'sync_batch_metadata'
        | 'sync_batch_sidecars'
        | 'validate_batch'
        | 'promote_batch'
        | 'prepare_all_roots'
        | 'export_all_roots'
        | 'save_drp_snapshot'
        | undefined;
      const rootId = toStringValue(args.rootId);
      if (!rootId && !['prepare_all_roots', 'export_all_roots', 'save_drp_snapshot'].includes(action || '')) {
        throw new BlockedJobError(['color requires args.rootId for root-scoped actions']);
      }
      try {
        const result = await runProjectColorAction({
          workspaceRoot,
          projectId,
          rootId: rootId || undefined,
          action,
          clipKeys: Array.isArray(args.clipKeys)
            ? args.clipKeys.filter((item): item is string => typeof item === 'string' && Boolean(item.trim()))
            : undefined,
          batchId: toStringValue(args.batchId) || undefined,
          overwriteConfirmed: args.overwriteConfirmed === true,
          overwritePlanHash: toStringValue(args.overwritePlanHash) || undefined,
          jobId,
        });
        return {
          result,
          finalStatus: ['prepare_all_roots', 'export_all_roots'].includes(action || '')
            && Array.isArray(result.roots)
            && result.roots.some(root => root.status === 'failed')
            ? 'failed'
            : 'completed',
        };
      } catch (error) {
        if (error instanceof ProjectColorBlockedError || error instanceof ColorPrepBlockedError) {
          throw new BlockedJobError(error.blockers);
        }
        throw error;
      }
    }
    case 'export-jianying':
    case 'export-resolve':
      throw new BlockedJobError([`${jobType} runner is not wired yet in this Supervisor iteration.`]);
    default:
      throw new BlockedJobError([`Unsupported job type: ${jobType}`]);
  }
}

async function shouldEnsureManagedMl(
  workspaceRoot: string,
  jobType: string,
  projectId?: string,
): Promise<boolean> {
  if (!['analyze', 'span-rebuild', 'style-analysis'].includes(jobType)) {
    return false;
  }

  const runtimeRoot = projectId
    ? resolveWorkspaceProjectRoot(workspaceRoot, projectId)
    : workspaceRoot;
  const runtimeConfig = await loadRuntimeConfig(runtimeRoot);
  return isLocalMlUrl(runtimeConfig.mlServerUrl);
}

function isLocalMlUrl(value?: string): boolean {
  if (!value?.trim()) return true;
  try {
    const parsed = new URL(value);
    return ['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname);
  } catch {
    return true;
  }
}

async function writeJobFailureProgress(
  record: NonNullable<Awaited<ReturnType<typeof loadJobRecord>>>,
  status: 'blocked' | 'failed',
  detail: string,
): Promise<void> {
  if (!record.progressPath) return;
  const existing = await readExistingProgress(record.progressPath);
  const identity = inferProgressIdentity(record.jobType);
  await writeKairosProgress(record.progressPath, {
    status: 'failed',
    pipelineKey: getStringField(existing, 'pipelineKey') ?? identity.pipelineKey,
    pipelineLabel: getStringField(existing, 'pipelineLabel') ?? identity.pipelineLabel,
    phaseKey: getStringField(existing, 'phaseKey') ?? identity.phaseKey,
    phaseLabel: getStringField(existing, 'phaseLabel') ?? identity.phaseLabel,
    step: getStringField(existing, 'step') ?? status,
    stepLabel: getStringField(existing, 'stepLabel') ?? (status === 'blocked' ? '已阻塞' : '已失败'),
    stepIndex: getNumberField(existing, 'stepIndex') ?? 1,
    stepTotal: getNumberField(existing, 'stepTotal') ?? 1,
    stepDefinitions: getStepDefinitions(existing),
    fileName: getStringField(existing, 'fileName'),
    fileIndex: getNumberField(existing, 'fileIndex'),
    fileTotal: getNumberField(existing, 'fileTotal'),
    current: getNumberField(existing, 'current'),
    total: getNumberField(existing, 'total'),
    unit: getStringField(existing, 'unit') ?? 'step',
    detail,
    extra: {
      ...(isRecord(existing?.extra) ? existing.extra : {}),
      jobId: record.jobId,
      jobStatus: status,
      projectId: record.projectId,
    },
  });
}

async function readExistingProgress(path: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readFile(path, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function inferProgressIdentity(jobType: string): {
  pipelineKey: string;
  pipelineLabel: string;
  phaseKey: string;
  phaseLabel: string;
} {
  if (jobType === 'span-rebuild') {
    return {
      pipelineKey: 'chronology',
      pipelineLabel: 'Chronology 生成链路',
      phaseKey: 'span-rebuild',
      phaseLabel: '生成素材片段与模式',
    };
  }
  if (jobType === 'chronology-build') {
    return {
      pipelineKey: 'chronology',
      pipelineLabel: 'Chronology 生成链路',
      phaseKey: 'chronology-build',
      phaseLabel: '生成/刷新编年史',
    };
  }
  if (jobType === 'spatial-refresh') {
    return {
      pipelineKey: 'media-analyze',
      pipelineLabel: '素材分析流程',
      phaseKey: 'spatial-refresh',
      phaseLabel: '刷新空间信息',
    };
  }
  return {
    pipelineKey: jobType === 'analyze' ? 'media-analyze' : jobType,
    pipelineLabel: jobType === 'analyze' ? '素材分析流程' : jobType,
    phaseKey: jobType,
    phaseLabel: jobType,
  };
}

function getStepDefinitions(
  record: Record<string, unknown> | null | undefined,
): Array<{ key: string; label: string }> | undefined {
  if (!Array.isArray(record?.stepDefinitions)) return undefined;
  const steps = record.stepDefinitions.filter((item): item is { key: string; label: string } => (
    isRecord(item)
    && typeof item.key === 'string'
    && typeof item.label === 'string'
  ));
  return steps.length > 0 ? steps : undefined;
}

function getStringField(record: Record<string, unknown> | null | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function getNumberField(record: Record<string, unknown> | null | undefined, key: string): number | undefined {
  const value = record?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const part = argv[index];
    if (!part.startsWith('--')) continue;
    const key = part.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      args[key] = 'true';
      continue;
    }
    args[key] = next;
    index += 1;
  }
  return args;
}

function toStringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function toEditFlowAction(value: unknown): 'plan' | 'confirm-plan' | 'run-step' | 'confirm-step' | 'run-next' {
  if (value === 'plan'
    || value === 'confirm-plan'
    || value === 'run-step'
    || value === 'confirm-step'
    || value === 'run-next') {
    return value;
  }
  throw new BlockedJobError(['edit-flow requires args.action: plan / confirm-plan / run-step / confirm-step / run-next']);
}

function toEditFlowRunner(value: unknown): 'deterministic' | 'agent' | 'script' | 'manual' | undefined {
  if (value === 'deterministic' || value === 'agent' || value === 'script' || value === 'manual') return value;
  return undefined;
}

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
  }
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) {
        return parsed.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
      }
    } catch {
      return value.split(',').map(item => item.trim()).filter(Boolean);
    }
  }
  return [];
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
