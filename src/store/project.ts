import { mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { IStoreManifest, IMediaRoot, IKtepProject } from '../protocol/schema.js';
import { readJson, readJsonOrNull, writeJson } from './writer.js';
import { z } from 'zod';
import { buildProjectBriefTemplate } from './project-brief.js';

const CDIRS = [
  'config',
  'config/styles',
  'store',
  'media',
  '.tmp',
  'script',
  'script/versions',
  'timeline',
  'timeline/versions',
  'subtitles',
  'adapters',
  'analysis',
  'analysis/asset-reports',
  'analysis/reference-transcripts',
] as const;

const IIngestRoots = z.object({ roots: z.array(IMediaRoot) });
type IIngestRoots = z.infer<typeof IIngestRoots>;

const IRuntimeConfig = z.object({
  ffmpegPath: z.string().optional(),
  ffprobePath: z.string().optional(),
  ffmpegHwaccel: z.string().optional(),
  analysisProxyWidth: z.number().int().positive().optional(),
  analysisProxyPixelFormat: z.string().optional(),
  sceneDetectFps: z.number().positive().optional(),
  sceneDetectScaleWidth: z.number().int().positive().optional(),
  mlServerUrl: z.string().optional(),
});
export type IRuntimeConfig = z.infer<typeof IRuntimeConfig>;

export async function initProject(
  root: string,
  name: string,
  description?: string,
): Promise<void> {
  for (const dir of CDIRS) {
    await mkdir(join(root, dir), { recursive: true });
  }

  const now = new Date().toISOString();

  const project: IKtepProject = {
    id: randomUUID(),
    name,
    createdAt: now,
    updatedAt: now,
  };
  await writeJson(join(root, 'store/project.json'), project);

  const manifest: IStoreManifest = {
    storeSchemaVersion: '1.0',
    currentRevisionId: randomUUID(),
    updatedAt: now,
  };
  await writeJson(join(root, 'store/manifest.json'), manifest);

  const ingestRoots: IIngestRoots = { roots: [] };
  await writeJson(join(root, 'config/ingest-roots.json'), ingestRoots);

  await writeFile(
    join(root, 'config/project-brief.md'),
    buildProjectBriefTemplate({
      name,
      description,
      createdAt: now,
    }),
    'utf-8',
  );
}

export async function loadManifest(root: string): Promise<IStoreManifest> {
  return readJson(join(root, 'store/manifest.json'), IStoreManifest);
}

export async function loadProject(root: string): Promise<IKtepProject> {
  return readJson(join(root, 'store/project.json'), IKtepProject);
}

export async function loadIngestRoots(root: string): Promise<IIngestRoots> {
  const data = await readJsonOrNull(join(root, 'config/ingest-roots.json'), IIngestRoots);
  return data ?? { roots: [] };
}

export async function loadRuntimeConfig(root: string): Promise<IRuntimeConfig> {
  for (const candidate of getRuntimeConfigCandidates(root)) {
    const data = await readJsonOrNull(candidate, IRuntimeConfig);
    if (data) return data;
  }
  return {};
}

export async function touchProjectUpdatedAt(root: string): Promise<IKtepProject> {
  const project = await loadProject(root);
  const updated: IKtepProject = {
    ...project,
    updatedAt: new Date().toISOString(),
  };
  await writeJson(join(root, 'store/project.json'), updated);
  return updated;
}

function getRuntimeConfigCandidates(root: string): string[] {
  const normalizedRoot = resolve(root);
  const candidates = [join(normalizedRoot, 'config/runtime.json')];

  const parent = dirname(normalizedRoot);
  if (basename(parent) === 'projects') {
    candidates.push(join(dirname(parent), 'config/runtime.json'));
  }

  return [...new Set(candidates)];
}
