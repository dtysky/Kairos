import {
  loadEditUnitConfig,
  loadIngestRoots,
  loadProjectBriefConfig,
  loadProject,
  normalizeEditId,
  resolveWorkspaceProjectRoot,
} from '../../store/index.js';
import { ResolveColorHostError } from '../color/resolve-executor.js';
import {
  buildRootPathCandidates,
  resolveMediaRoot,
} from '../media/root-resolver.js';
import {
  deriveResolveRoughCutProjectName,
  deriveResolveRoughCutTimelineName,
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
  editId?: string;
}

export interface IRelinkProjectEditMediaResult extends IResolveEditMediaRelinkResult {
  projectId?: string;
  editId: string;
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

const CEDIT_MEDIA_NAMESPACE = 'Kairos Project Media';
const CVOICEOVER_MEDIA_NAMESPACE = 'Kairos Voiceover';
const CAUDIO_MEDIA_NAMESPACE = 'Kairos Audio';

export async function relinkProjectEditMedia(
  input: IRelinkProjectEditMediaInput,
  config: IResolveTimelineHostConfig = {},
): Promise<IRelinkProjectEditMediaResult> {
  const projectRoot = resolveRelinkProjectRoot(input);
  const editId = normalizeEditId(input.editId);
  const [project, ingestRoots, editUnit, projectBrief] = await Promise.all([
    loadProject(projectRoot),
    loadIngestRoots(projectRoot),
    loadEditUnitConfig(projectRoot, editId),
    loadProjectBriefConfig(projectRoot),
  ]);
  const resolveProjectName = deriveResolveRoughCutProjectName(project.name, project.id);
  const timelineName = deriveResolveRoughCutTimelineName(editId);
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
  if (mappings.length === 0 || blockers.length > 0) {
    throw new ProjectEditMediaRelinkBlockedError(
      blockers.length > 0 ? blockers : ['没有可用于 Resolve 剪辑工程重链的可读素材 Root。'],
    );
  }

  const result = await relinkResolveEditMedia({
    projectId: input.projectId ?? project.id,
    resolveProjectName,
    namespace: CEDIT_MEDIA_NAMESPACE,
    timelineName,
    roots: mappings,
  }, config);
  const voiceoverSummary = await relinkVoiceoverMedia({
    projectId: input.projectId ?? project.id,
    resolveProjectName,
    timelineName,
    voiceoverMedia: projectBrief.voiceoverMedia,
  }, config);
  const audioSummary = await relinkAudioMedia({
    projectId: input.projectId ?? project.id,
    resolveProjectName,
    timelineName,
    audioMedia: projectBrief.audioMedia,
  }, config);
  const hostSummary = {
    ...(result.hostSummary ?? {}),
    voiceover: voiceoverSummary,
    audio: audioSummary,
  };
  return {
    ...result,
    hostSummary,
    projectId: input.projectId,
    editId: editUnit.editId || editId,
    rootMappingCount: mappings.length,
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

async function relinkVoiceoverMedia(
  input: {
    projectId: string;
    resolveProjectName: string;
    timelineName: string;
    voiceoverMedia?: TProjectAudioMediaConfig;
  },
  config: IResolveTimelineHostConfig,
): Promise<Record<string, unknown> & { mappingCount: number }> {
  return relinkExternalAudioMedia({
    projectId: input.projectId,
    resolveProjectName: input.resolveProjectName,
    timelineName: input.timelineName,
    media: input.voiceoverMedia,
    namespace: CVOICEOVER_MEDIA_NAMESPACE,
    defaultRootId: 'voiceover',
    defaultLabel: CVOICEOVER_MEDIA_NAMESPACE,
    notConfiguredReason: 'voiceover_media_not_configured',
    unreadableReason: 'voiceover_media_unreadable',
    unreadableFallback: '配音媒体 Root 路径不可读',
    missingNamespaceReason: 'voiceover_media_pool_bin_missing',
  }, config);
}

async function relinkAudioMedia(
  input: {
    projectId: string;
    resolveProjectName: string;
    timelineName: string;
    audioMedia?: TProjectAudioMediaConfig;
  },
  config: IResolveTimelineHostConfig,
): Promise<Record<string, unknown> & { mappingCount: number }> {
  return relinkExternalAudioMedia({
    projectId: input.projectId,
    resolveProjectName: input.resolveProjectName,
    timelineName: input.timelineName,
    media: input.audioMedia,
    namespace: CAUDIO_MEDIA_NAMESPACE,
    defaultRootId: 'audio',
    defaultLabel: CAUDIO_MEDIA_NAMESPACE,
    notConfiguredReason: 'audio_media_not_configured',
    unreadableReason: 'audio_media_unreadable',
    unreadableFallback: '项目音频媒体 Root 路径不可读',
    missingNamespaceReason: 'audio_media_pool_bin_missing',
  }, config);
}

async function relinkExternalAudioMedia(
  input: {
    projectId: string;
    resolveProjectName: string;
    timelineName: string;
    media?: TProjectAudioMediaConfig;
    namespace: string;
    defaultRootId: string;
    defaultLabel: string;
    notConfiguredReason: string;
    unreadableReason: string;
    unreadableFallback: string;
    missingNamespaceReason: string;
  },
  config: IResolveTimelineHostConfig,
): Promise<Record<string, unknown> & { mappingCount: number }> {
  const rootMapping = buildExternalAudioRelinkMapping(input.media, {
    defaultRootId: input.defaultRootId,
    defaultLabel: input.defaultLabel,
    unreadableFallback: input.unreadableFallback,
  });
  if (!rootMapping.configured) {
    return {
      configured: false,
      namespace: input.namespace,
      mappingCount: 0,
      skipped: true,
      reason: input.notConfiguredReason,
    };
  }
  if (rootMapping.blocker || !rootMapping.mapping) {
    return {
      configured: true,
      namespace: input.namespace,
      mappingCount: 0,
      skipped: true,
      reason: input.unreadableReason,
      blocker: rootMapping.blocker,
    };
  }
  try {
    const result = await relinkResolveEditMedia({
      projectId: input.projectId,
      resolveProjectName: input.resolveProjectName,
      namespace: input.namespace,
      timelineName: input.timelineName,
      timelineTrackTypes: ['audio'],
      timelineCountUnmapped: false,
      roots: [rootMapping.mapping],
    }, config);
    return {
      configured: true,
      namespace: input.namespace,
      mappingCount: 1,
      skipped: false,
      ...(result.hostSummary ?? {}),
    };
  } catch (error) {
    if (error instanceof ResolveColorHostError && error.code === 'resolve_edit_media_namespace_missing') {
      return {
        configured: true,
        namespace: input.namespace,
        mappingCount: 1,
        skipped: true,
        reason: input.missingNamespaceReason,
      };
    }
    throw error;
  }
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
