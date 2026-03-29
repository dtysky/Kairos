import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { IStoreManifest, IMediaRoot, IKtepProject } from '../protocol/schema.js';
import { readJson, readJsonOrNull, writeJson } from './writer.js';
import { z } from 'zod';

const CDIRS = [
  'config',
  'config/styles',
  'store',
  'media',
  'script',
  'script/versions',
  'timeline',
  'timeline/versions',
  'subtitles',
  'adapters',
  'analysis',
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

export async function initProject(root: string, name: string): Promise<void> {
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

  const runtimeConfig: IRuntimeConfig = {
    analysisProxyWidth: 1024,
    analysisProxyPixelFormat: 'yuv420p',
    sceneDetectFps: 4,
  };
  await writeJson(join(root, 'config/runtime.json'), runtimeConfig);
}

export async function loadManifest(root: string): Promise<IStoreManifest> {
  return readJson(join(root, 'store/manifest.json'), IStoreManifest);
}

export async function loadIngestRoots(root: string): Promise<IIngestRoots> {
  const data = await readJsonOrNull(join(root, 'config/ingest-roots.json'), IIngestRoots);
  return data ?? { roots: [] };
}

export async function loadRuntimeConfig(root: string): Promise<IRuntimeConfig> {
  const data = await readJsonOrNull(join(root, 'config/runtime.json'), IRuntimeConfig);
  return data ?? {};
}
