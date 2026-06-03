import {
  loadEditUnitConfig,
  loadIngestRoots,
  loadProject,
  normalizeEditId,
  resolveWorkspaceProjectRoot,
} from '../../store/index.js';
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
  blockingReasons: string[];
}

export class ProjectEditMediaRelinkBlockedError extends Error {
  constructor(readonly blockers: string[]) {
    super(blockers.join('；'));
    this.name = 'ProjectEditMediaRelinkBlockedError';
  }
}

const CEDIT_MEDIA_NAMESPACE = 'Kairos Project Media';

export async function relinkProjectEditMedia(
  input: IRelinkProjectEditMediaInput,
  config: IResolveTimelineHostConfig = {},
): Promise<IRelinkProjectEditMediaResult> {
  const projectRoot = resolveRelinkProjectRoot(input);
  const editId = normalizeEditId(input.editId);
  const [project, ingestRoots, editUnit] = await Promise.all([
    loadProject(projectRoot),
    loadIngestRoots(projectRoot),
    loadEditUnitConfig(projectRoot, editId),
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
  return {
    ...result,
    projectId: input.projectId,
    editId: editUnit.editId || editId,
    rootMappingCount: mappings.length,
    blockingReasons: [],
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
