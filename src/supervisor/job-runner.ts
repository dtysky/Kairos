import { join } from 'node:path';
import {
  analyzeWorkspaceProjectMedia,
  importProjectGpxTracks,
  ingestWorkspaceProjectMedia,
  initWorkspaceProject,
  loadSlices,
  loadProjectStyleByCategory,
  prepareProjectScriptForAgent,
  refreshProjectDerivedTrackCache,
  refreshProjectGpsCache,
  resolveWorkspaceProjectRoot,
} from '../index.js';
import {
  getMaterialOverviewPath,
  loadOptionalMarkdown,
  loadScriptBriefConfig,
  loadStyleSourcesConfig,
  writeJson,
} from '../store/index.js';
import {
  loadJobRecord,
  writeJobRecord,
  getSupervisorJobRoot,
  type TSupervisorJobStatus,
} from './state.js';

class BlockedJobError extends Error {
  constructor(public blockers: string[]) {
    super(blockers.join('; '));
    this.name = 'BlockedJobError';
  }
}

interface IJobExecutionResult {
  result?: unknown;
  finalStatus?: Extract<TSupervisorJobStatus, 'completed' | 'awaiting_agent'>;
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

  try {
    const execution = await runJob(workspaceRoot, record.jobType, record.projectId, record.args);
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

    await writeJobRecord(workspaceRoot, {
      ...record,
      status: 'failed',
      startedAt: record.startedAt ?? startedAt,
      finishedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastError: error instanceof Error ? error.stack ?? error.message : String(error),
    });
    throw error;
  }
}

async function runJob(
  workspaceRoot: string,
  jobType: string,
  projectId: string | undefined,
  args: Record<string, unknown>,
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
      return {
        result: await ingestWorkspaceProjectMedia({
          workspaceRoot,
          projectId,
        }),
      };
    }
    case 'gps-refresh': {
      if (!projectId) {
        throw new BlockedJobError(['gps-refresh requires projectId']);
      }
      const projectRoot = resolveWorkspaceProjectRoot(workspaceRoot, projectId);
      const importedGpx = toStringArray(args.gpxPaths);
      const imported = importedGpx.length > 0
        ? await importProjectGpxTracks({
          projectRoot,
          sourcePaths: importedGpx,
        })
        : null;
      const merged = await refreshProjectGpsCache(projectRoot);
      const derived = await refreshProjectDerivedTrackCache({ projectRoot });
      return {
        result: {
          imported,
          merged,
          derived,
        },
      };
    }
    case 'analyze': {
      if (!projectId) {
        throw new BlockedJobError(['analyze requires projectId']);
      }
      return {
        result: await analyzeWorkspaceProjectMedia({
          workspaceRoot,
          projectId,
          assetIds: toStringArray(args.assetIds),
        }),
      };
    }
    case 'script': {
      if (!projectId) {
        throw new BlockedJobError(['script requires projectId']);
      }
      const projectRoot = resolveWorkspaceProjectRoot(workspaceRoot, projectId);
      const slices = await loadSlices(projectRoot);
      if (slices.length === 0) {
        throw new BlockedJobError(['script prep requires non-empty store/spans.json']);
      }
      const scriptConfig = await loadScriptBriefConfig(projectRoot);
      const styleCategory = toStringValue(args.styleCategory) || scriptConfig.styleCategory;
      if (!styleCategory) {
        throw new BlockedJobError(['script prep requires styleCategory in args or script-brief']);
      }
      if (scriptConfig.workflowState !== 'ready_to_prepare') {
        throw new BlockedJobError([
          `script prep requires script-brief.workflowState=ready_to_prepare (current: ${scriptConfig.workflowState})`,
        ]);
      }
      if (!await loadProjectStyleByCategory(workspaceRoot, styleCategory)) {
        throw new BlockedJobError([`style profile not found for category "${styleCategory}"`]);
      }
      if (!(await loadOptionalMarkdown(getMaterialOverviewPath(projectRoot)))?.trim()) {
        throw new BlockedJobError(['script prep requires existing script/material-overview.md']);
      }
      return {
        finalStatus: 'awaiting_agent',
        result: await prepareProjectScriptForAgent({
          projectRoot,
          workspaceRoot,
          styleCategory,
        }),
      };
    }
    case 'style-analysis': {
      const config = await loadStyleSourcesConfig(workspaceRoot);
      if (config.categories.length === 0) {
        throw new BlockedJobError(['style-analysis requires style-sources configuration']);
      }
      throw new BlockedJobError([
        'style-analysis is declared as an agent-backed job',
        'the Supervisor now snapshots and manages its config, but the full background reference-analysis executor is not yet wired into this runner',
      ]);
    }
    case 'timeline':
    case 'export-jianying':
    case 'export-resolve':
      throw new BlockedJobError([`${jobType} runner is not wired yet in this Supervisor iteration.`]);
    default:
      throw new BlockedJobError([`Unsupported job type: ${jobType}`]);
  }
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
