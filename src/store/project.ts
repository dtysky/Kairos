import { mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  IColorCurrent,
  IColorConfig,
  IStoreManifest,
  IMediaRoot,
  IKtepProject,
} from '../protocol/schema.js';
import { readJson, readJsonOrNull, writeJson } from './writer.js';
import { z } from 'zod';
import { buildProjectBriefTemplate } from './project-brief.js';
import { loadPersistedLegacyProjectRoots } from './project-root-compat.js';
import { mediaRootsToProjectBriefMappings, projectBriefToMediaRoots } from './project-root-truth.js';
import {
  loadProjectBriefConfig,
  saveProjectBriefConfig,
} from './workspace-config.js';
import { writeScriptBriefTemplate } from './script-brief.js';
import { ensureProjectEditDirs } from './edit-store.js';

const CDIRS = [
  'config',
  'store',
  'media',
  '.tmp',
  'script',
  'script/versions',
  'timeline',
  'timeline/versions',
  'edits',
  'edits/resolve-projects',
  'edits/main',
  'edits/main/script',
  'edits/main/script/versions',
  'edits/main/timeline',
  'edits/main/timeline/versions',
  'edits/main/subtitles',
  'color',
  'color/groups',
  'color/batches',
  'subtitles',
  'adapters',
  'analysis',
  'analysis/asset-reports',
  'analysis/fine-scan-checkpoints',
  'analysis/speech-boundaries',
  'pharos',
  'gps',
  'gps/tracks',
  'gps/same-source',
  'gps/same-source/tracks',
] as const;

const IProjectRoots = z.object({ roots: z.array(IMediaRoot) });
export type IProjectRoots = z.infer<typeof IProjectRoots>;
export type IIngestRoots = IProjectRoots;

const IRuntimeConfig = z.object({
  ffmpegPath: z.string().optional(),
  ffprobePath: z.string().optional(),
  exiftoolPath: z.string().optional(),
  ffmpegHwaccel: z.string().optional(),
  analysisProxyWidth: z.number().int().positive().optional(),
  analysisProxyPixelFormat: z.string().optional(),
  sceneDetectFps: z.number().positive().optional(),
  sceneDetectScaleWidth: z.number().int().positive().optional(),
  keyframeExtractConcurrency: z.number().int().positive().optional(),
  coarseScanBaseConcurrency: z.number().int().positive().optional(),
  coarseScanMaxConcurrency: z.number().int().positive().optional(),
  coarseScanMinFreeMemoryMb: z.number().int().positive().optional(),
  audioAnalysisLocalBaseConcurrency: z.number().int().positive().optional(),
  audioAnalysisLocalMaxConcurrency: z.number().int().positive().optional(),
  audioAnalysisLocalMinFreeMemoryMb: z.number().int().positive().optional(),
  audioAnalysisAsrBaseConcurrency: z.number().int().positive().optional(),
  audioAnalysisAsrMaxConcurrency: z.number().int().positive().optional(),
  audioAnalysisAsrMinFreeMemoryMb: z.number().int().positive().optional(),
  fineScanPrefetchBaseConcurrency: z.number().int().positive().optional(),
  fineScanPrefetchMaxConcurrency: z.number().int().positive().optional(),
  fineScanPrefetchMinFreeMemoryMb: z.number().int().positive().optional(),
  fineScanPrefetchMaxReadyAssets: z.number().int().positive().optional(),
  fineScanPrefetchMaxReadyFrameMb: z.number().int().positive().optional(),
  asr: z.object({
    backend: z.enum(['qwen3', 'whisper']),
  }).optional(),
  mlServerUrl: z.string().optional(),
  djiOpenAPIKey: z.string().optional(),
  amapWebServiceKey: z.string().optional(),
  geoapifyApiKey: z.string().optional(),
  timelineWidth: z.number().int().positive().optional(),
  timelineHeight: z.number().int().positive().optional(),
  timelineFps: z.number().positive().optional(),
  timelineStillDurationMs: z.number().int().positive().optional(),
  jianyingDraftRoot: z.string().optional(),
  jianyingPythonPath: z.string().optional(),
  jianyingPyProjectRoot: z.string().optional(),
  voiceover: z.object({
    volcApiKey: z.string().optional(),
    defaultProfile: z.string().optional(),
    profiles: z.array(z.object({
      name: z.string(),
      displayName: z.string().optional(),
      resourceId: z.string().optional(),
      speakerId: z.string().optional(),
      language: z.string().optional(),
      model: z.string().optional(),
      defaultSpeed: z.number().optional(),
      defaultLoudness: z.number().optional(),
      contextText: z.string().optional(),
    })).optional(),
  }).optional(),
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
  await ensureProjectEditDirs(root, 'main');

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

  await writeJson(join(root, 'color/current.json'), IColorCurrent.parse({ roots: [] }));

  await writeFile(
    join(root, 'config/project-brief.md'),
    buildProjectBriefTemplate({
      name,
      description,
      createdAt: now,
    }),
    'utf-8',
  );

  await writeScriptBriefTemplate(root, {
    projectName: name,
    createdAt: now,
    editId: 'main',
    editLabel: 'Main',
  });
}

export async function loadManifest(root: string): Promise<IStoreManifest> {
  return readJson(join(root, 'store/manifest.json'), IStoreManifest);
}

export async function loadProject(root: string): Promise<IKtepProject> {
  return readJson(join(root, 'store/project.json'), IKtepProject);
}

export async function loadIngestRoots(root: string): Promise<IIngestRoots> {
  return loadProjectRoots(root);
}

export async function saveIngestRoots(root: string, ingestRoots: IIngestRoots): Promise<IIngestRoots> {
  return saveProjectRoots(root, ingestRoots);
}

export async function loadProjectRoots(root: string): Promise<IProjectRoots> {
  const [projectBrief, legacyRoots, legacyColorConfig] = await Promise.all([
    loadProjectBriefConfig(root).catch(() => null),
    loadPersistedLegacyProjectRoots(root),
    readJsonOrNull(join(root, 'color', 'config.json'), IColorConfig)
      .then(config => (config ? IColorConfig.parse(config) : null)),
  ]);
  if (projectBrief?.mappings?.length) {
    return IProjectRoots.parse({
      roots: applyLegacyColorConfig(projectBriefToMediaRoots(projectBrief), legacyColorConfig),
    });
  }
  return IProjectRoots.parse({
    roots: applyLegacyColorConfig(legacyRoots.roots, legacyColorConfig),
  });
}

export async function saveProjectRoots(root: string, projectRoots: IProjectRoots): Promise<IProjectRoots> {
  const currentBrief = await loadProjectBriefConfig(root).catch(() => null);
  const project = currentBrief ? null : await loadProject(root).catch(() => null);
  const savedBrief = await saveProjectBriefConfig(root, {
    name: currentBrief?.name ?? project?.name ?? 'Untitled Project',
    description: currentBrief?.description,
    createdAt: currentBrief?.createdAt ?? project?.createdAt,
    mappings: mediaRootsToProjectBriefMappings(projectRoots.roots, currentBrief?.mappings),
    pharos: currentBrief?.pharos,
    voiceoverMedia: currentBrief?.voiceoverMedia,
    audioMedia: currentBrief?.audioMedia,
    materialPatternPhrases: currentBrief?.materialPatternPhrases ?? [],
  });
  return IProjectRoots.parse({
    roots: projectBriefToMediaRoots(savedBrief),
  });
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

function applyLegacyColorConfig(
  roots: IMediaRoot[],
  legacyColorConfig: IColorConfig | null,
): IMediaRoot[] {
  const legacyColorRootById = new Map((legacyColorConfig?.roots ?? []).map(colorRoot => [colorRoot.rootId, colorRoot]));
  return roots.map(root => {
    const legacyColorRoot = legacyColorRootById.get(root.id);
    const legacyRenderPreset = legacyColorRoot?.renderPreset;
    if (!legacyRenderPreset || !hasRenderPresetValue(legacyRenderPreset) || root.color?.renderPreset) {
      return root;
    }
    return {
      ...root,
      color: {
        ...(root.color ?? {}),
        renderPreset: legacyRenderPreset,
      },
    };
  });
}

function hasRenderPresetValue(renderPreset: NonNullable<IColorConfig['roots'][number]['renderPreset']>): boolean {
  return Boolean(
    renderPreset.container
    || renderPreset.videoCodec
    || renderPreset.audioCodec
    || typeof renderPreset.bitrateKbps === 'number',
  );
}
