import { join } from 'node:path';
import {
  OpenAIClient,
  analyzeWorkspaceProjectMedia,
  generateProjectScriptFromPlanning,
  importProjectGpxTracks,
  ingestWorkspaceProjectMedia,
  initWorkspaceProject,
  loadProjectStyleByCategory,
  refreshProjectDerivedTrackCache,
  refreshProjectGpsCache,
  resolveWorkspaceProjectRoot,
} from '../index.js';
import {
  loadScriptBriefConfig,
  loadStyleSourcesConfig,
  writeJson,
} from '../store/index.js';
import { loadJobRecord, writeJobRecord, getSupervisorJobRoot } from './state.js';

class BlockedJobError extends Error {
  constructor(public blockers: string[]) {
    super(blockers.join('; '));
    this.name = 'BlockedJobError';
  }
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
    const result = await runJob(workspaceRoot, record.jobType, record.projectId, record.args);
    const resultPath = record.resultPath ?? join(getSupervisorJobRoot(workspaceRoot, record.jobId), 'result.json');
    await writeJson(resultPath, result ?? { ok: true });
    await writeJobRecord(workspaceRoot, {
      ...record,
      status: 'completed',
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
): Promise<unknown> {
  switch (jobType) {
    case 'project-init': {
      if (!projectId) {
        throw new BlockedJobError(['project-init requires projectId']);
      }
      const projectName = toStringValue(args.name) || projectId;
      const description = toStringValue(args.description);
      const projectRoot = await initWorkspaceProject(workspaceRoot, projectId, projectName, description);
      return { projectRoot };
    }
    case 'ingest': {
      if (!projectId) {
        throw new BlockedJobError(['ingest requires projectId']);
      }
      return ingestWorkspaceProjectMedia({
        workspaceRoot,
        projectId,
      });
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
        imported,
        merged,
        derived,
      };
    }
    case 'analyze': {
      if (!projectId) {
        throw new BlockedJobError(['analyze requires projectId']);
      }
      return analyzeWorkspaceProjectMedia({
        workspaceRoot,
        projectId,
        assetIds: toStringArray(args.assetIds),
      });
    }
    case 'script': {
      if (!projectId) {
        throw new BlockedJobError(['script requires projectId']);
      }
      const llm = resolveLlmClient();
      const projectRoot = resolveWorkspaceProjectRoot(workspaceRoot, projectId);
      const scriptConfig = await loadScriptBriefConfig(projectRoot);
      const styleCategory = toStringValue(args.styleCategory) || scriptConfig.styleCategory;
      if (!styleCategory) {
        throw new BlockedJobError(['script requires styleCategory in args or script-brief']);
      }
      const style = await loadProjectStyleByCategory(workspaceRoot, styleCategory);
      if (!style) {
        throw new BlockedJobError([`style profile not found for category "${styleCategory}"`]);
      }
      return generateProjectScriptFromPlanning({
        projectRoot,
        workspaceRoot,
        styleCategory,
        llm,
        style,
      });
    }
    case 'style-analysis': {
      if (!projectId) {
        throw new BlockedJobError(['style-analysis requires projectId']);
      }
      const projectRoot = resolveWorkspaceProjectRoot(workspaceRoot, projectId);
      const config = await loadStyleSourcesConfig(workspaceRoot, projectRoot);
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

function resolveLlmClient(): OpenAIClient {
  const apiKey = process.env.KAIROS_LLM_API_KEY || process.env.OPENAI_API_KEY;
  const baseUrl = process.env.KAIROS_LLM_BASE_URL || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
  const model = process.env.KAIROS_LLM_MODEL || process.env.OPENAI_MODEL || 'gpt-4o';
  if (!apiKey) {
    throw new BlockedJobError([
      'script job requires KAIROS_LLM_API_KEY or OPENAI_API_KEY',
    ]);
  }
  return new OpenAIClient(apiKey, baseUrl, model);
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
