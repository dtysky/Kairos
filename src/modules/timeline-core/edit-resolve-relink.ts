import {
  loadIngestRoots,
  loadProjectBriefConfig,
  loadProject,
  resolveWorkspaceProjectRoot,
} from '../../store/index.js';
import {
  buildRootPathCandidates,
  resolveMediaRoot,
} from '../media/root-resolver.js';
import {
  deriveResolveRoughCutProjectName,
} from './resolve-edit-naming.js';
import {
  relinkResolveEditMedia,
  type IResolveEditMediaRelinkResult,
  type IResolveEditMediaRelinkRoot,
  type IResolveTimelineHostConfig,
} from './resolve-rough-cut.js';

export interface IRelinkProjectEditMediaInput {
  workspaceRoot?: string;
  projectRoot?: string;
  projectId?: string;
}

export interface IRelinkProjectEditMediaResult extends IResolveEditMediaRelinkResult {
  projectId?: string;
  rootMappingCount: number;
  voiceoverRootMappingCount?: number;
  audioRootMappingCount?: number;
  blockingReasons: string[];
}

export class ProjectEditMediaRelinkBlockedError extends Error {
  constructor(readonly blockers: string[]) {
    super(blockers.join('；'));
    this.name = 'ProjectEditMediaRelinkBlockedError';
  }
}

export async function relinkProjectEditMedia(
  input: IRelinkProjectEditMediaInput,
  config: IResolveTimelineHostConfig = {},
): Promise<IRelinkProjectEditMediaResult> {
  const projectRoot = resolveRelinkProjectRoot(input);
  const [project, ingestRoots, projectBrief] = await Promise.all([
    loadProject(projectRoot),
    loadIngestRoots(projectRoot),
    loadProjectBriefConfig(projectRoot),
  ]);
  const resolveProjectName = deriveResolveRoughCutProjectName(project.name, project.id);
  const rootMappings = ingestRoots.roots
    .filter(root => root.enabled)
    .map(root => {
      const resolved = resolveMediaRoot(root);
      const localPath = resolved.localPath?.trim();
      if (!localPath) {
        return {
          blocker: `素材 Root ${root.id} 没有当前可读路径：${resolved.localPathResolution.blocker ?? '路径不可读'}`,
        };
      }
      const candidates = dedupeStrings([
        localPath,
        ...buildRootPathCandidates(root, 'path').map(candidate => candidate.path),
      ]);
      return {
        mapping: {
          rootId: root.id,
          ...(root.label ? { label: root.label } : {}),
          localPath,
          candidates,
        },
      };
    });
  const blockers = rootMappings
    .map(item => item.blocker)
    .filter((value): value is string => Boolean(value));
  const mappings = rootMappings
    .map(item => item.mapping)
    .filter((value): value is IResolveEditMediaRelinkRoot => Boolean(value));
  if (blockers.length > 0) {
    throw new ProjectEditMediaRelinkBlockedError(blockers);
  }

  const voiceover = prepareExternalAudioRelink(projectBrief.voiceoverMedia, 'voiceover', '配音');
  const audio = prepareExternalAudioRelink(projectBrief.audioMedia, 'audio', '音频');
  const allMappings = [...mappings, ...[voiceover.mapping, audio.mapping].filter(
    (mapping): mapping is IResolveEditMediaRelinkRoot => Boolean(mapping),
  )];
  if (allMappings.length === 0) {
    throw new ProjectEditMediaRelinkBlockedError(['没有可用于 Resolve 剪辑工程重链的可读素材或音频 Root。']);
  }
  if (new Set(allMappings.map(mapping => mapping.rootId)).size !== allMappings.length) {
    throw new ProjectEditMediaRelinkBlockedError(['素材、配音和音频的重链 rootId 必须互不重复。']);
  }
  const result = await relinkResolveEditMedia({
    projectId: input.projectId ?? project.id,
    resolveProjectName,
    roots: allMappings,
  }, config);
  const rootSummaries = (result.hostSummary?.rootSummaries ?? {}) as Record<string, Record<string, unknown>>;
  const voiceoverSummary = { ...voiceover.summary, ...(voiceover.mapping ? rootSummaries[voiceover.mapping.rootId] : {}) };
  const audioSummary = { ...audio.summary, ...(audio.mapping ? rootSummaries[audio.mapping.rootId] : {}) };
  const hostSummary = {
    ...(result.hostSummary ?? {}),
    voiceover: voiceoverSummary,
    audio: audioSummary,
  };
  return {
    ...result,
    hostSummary,
    projectId: input.projectId ?? project.id,
    rootMappingCount: allMappings.length,
    voiceoverRootMappingCount: voiceoverSummary.mappingCount,
    audioRootMappingCount: audioSummary.mappingCount,
    blockingReasons: [],
  };
}

type TProjectAudioMediaConfig = {
  rootId?: string;
  path?: string;
  alternatePaths?: Array<{ path?: string; rawPath?: string }>;
  description?: string;
};

function prepareExternalAudioRelink(
  media: TProjectAudioMediaConfig | undefined,
  kind: 'voiceover' | 'audio',
  label: string,
): { mapping?: IResolveEditMediaRelinkRoot; summary: Record<string, unknown> & { mappingCount: number } } {
  const prepared = buildExternalAudioRelinkMapping(media, {
    defaultRootId: kind,
    defaultLabel: label,
    unreadableFallback: `${label}媒体 Root 路径不可读`,
  });
  return {
    mapping: prepared.mapping,
    summary: {
      configured: prepared.configured,
      mappingCount: prepared.mapping ? 1 : 0,
      skipped: !prepared.mapping,
      ...(!prepared.configured ? { reason: `${kind}_media_not_configured` } : {}),
      ...(prepared.blocker ? { reason: `${kind}_media_unreadable`, blocker: prepared.blocker } : {}),
    },
  };
}

function buildExternalAudioRelinkMapping(
  media: TProjectAudioMediaConfig | undefined,
  defaults: {
    defaultRootId: string;
    defaultLabel: string;
    unreadableFallback: string;
  },
): {
  configured: boolean;
  mapping?: IResolveEditMediaRelinkRoot;
  blocker?: string;
} {
  const path = media?.path?.trim();
  if (!path) return { configured: false };
  const root = {
    id: media?.rootId?.trim() || defaults.defaultRootId,
    path,
    alternatePaths: media?.alternatePaths,
    enabled: true,
  };
  const resolved = resolveMediaRoot(root);
  const localPath = resolved.localPath?.trim();
  if (!localPath) {
    return {
      configured: true,
      blocker: resolved.localPathResolution.blocker ?? defaults.unreadableFallback,
    };
  }
  return {
    configured: true,
    mapping: {
      rootId: root.id,
      label: media?.description?.trim() || defaults.defaultLabel,
      localPath,
      candidates: dedupeStrings([
        localPath,
        ...buildRootPathCandidates(root, 'path').map(candidate => candidate.path),
      ]),
    },
  };
}

function resolveRelinkProjectRoot(input: IRelinkProjectEditMediaInput): string {
  if (input.projectRoot?.trim()) return input.projectRoot.trim();
  if (input.workspaceRoot?.trim() && input.projectId?.trim()) {
    return resolveWorkspaceProjectRoot(input.workspaceRoot.trim(), input.projectId.trim());
  }
  throw new ProjectEditMediaRelinkBlockedError([
    'relinkProjectEditMedia requires projectRoot or workspaceRoot + projectId。',
  ]);
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}
