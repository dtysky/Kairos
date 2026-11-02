import { basename } from 'node:path';
import { createMediaProgressReporter } from '../media/ingest-progress.js';
import { loadProject, loadProjectBriefConfig, getProjectProgressPath } from '../../store/index.js';
import { resolveMediaRoot, toPortableRelativePath } from '../media/root-resolver.js';
import { scanDirectory } from '../media/scanner.js';
import { deriveResolveRoughCutProjectName } from './resolve-edit-naming.js';
import { syncResolveRoughCutMedia, type IResolveTimelineHostConfig } from './resolve-rough-cut.js';

/** Manual editing media deliberately bypasses the analyzed asset/span/chronology indexes. */
export async function syncProjectExtraMedia(input: {
  projectRoot: string; jobId?: string; progressPath?: string; signal?: AbortSignal;
}, config: IResolveTimelineHostConfig = {}) {
  const progressPath = input.progressPath ?? getProjectProgressPath(input.projectRoot, 'resolve-extra-media-sync');
  const identity = { pipelineKey: 'resolve-extra-media-sync', pipelineLabel: '额外素材导入', extra: { jobId: input.jobId } };
  const reporter = createMediaProgressReporter(input.projectRoot, input.jobId, progressPath, identity);
  await reporter.report({ phaseKey: 'prepare', phaseLabel: '读取额外素材目录' }, true);
  const [project, brief] = await Promise.all([loadProject(input.projectRoot), loadProjectBriefConfig(input.projectRoot)]);
  if (!brief.extraMedia?.path) throw new Error('请先在“导入与 GPS”保存额外素材目录。');
  const root = resolveMediaRoot({ ...brief.extraMedia, id: brief.extraMedia.rootId || 'extra', enabled: true });
  if (!root.localPath) throw new Error(`额外素材目录不可读：${root.localPathResolution.blocker}`);
  let discovered = 0;
  const localPath = root.localPath;
  const files = await scanDirectory(localPath, {
    onDirectory: directory => {
      input.signal?.throwIfAborted();
      return reporter.report({ phaseKey: 'scan', phaseLabel: '扫描额外素材', current: discovered,
        fileName: toPortableRelativePath(localPath, directory) || '当前目录' });
    },
    onFile: file => {
      input.signal?.throwIfAborted(); discovered++;
      return reporter.report({ phaseKey: 'scan', phaseLabel: '扫描额外素材', current: discovered,
        fileName: toPortableRelativePath(localPath, file.path) });
    },
  }).catch(async error => { await reporter.fail(error).catch(() => undefined); throw error; });
  const resolveProjectName = deriveResolveRoughCutProjectName(project.name, project.id);
  await reporter.report({ phaseKey: 'connect', phaseLabel: '连接 Resolve', current: 0, total: files.length }, true);
  input.signal?.throwIfAborted();
  const resolveMedia = await syncResolveRoughCutMedia({
    projectId: project.id, resolveProjectName, namespace: '额外素材', mode: 'extra-media', progressPath, jobId: input.jobId,
    clips: files.map(file => {
      const relativePath = toPortableRelativePath(localPath, file.path);
      return { assetId: relativePath, rawRelativePath: relativePath, assetKind: file.kind,
        sourceAbsolutePath: file.path, sourceStem: basename(file.path) };
    }),
  }, { ...config, signal: input.signal ?? config.signal });
  await reporter.report({ status: 'succeeded', phaseKey: 'complete', phaseLabel: '额外素材导入完成',
    current: files.length, total: files.length, extra: { ...resolveMedia.hostSummary } }, true);
  return { resolveProjectName, resolveMedia, hostSummary: resolveMedia.hostSummary };
}
