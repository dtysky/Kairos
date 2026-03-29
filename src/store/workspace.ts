import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { IKtepProject } from '../protocol/schema.js';
import { initProject } from './project.js';
import { readJsonOrNull } from './writer.js';

export interface IWorkspaceProjectEntry {
  projectId: string;
  projectRoot: string;
  project: IKtepProject;
}

export function resolveProjectsRoot(workspaceRoot: string): string {
  return join(workspaceRoot, 'projects');
}

export function resolveWorkspaceProjectRoot(
  workspaceRoot: string,
  projectId: string,
): string {
  return join(resolveProjectsRoot(workspaceRoot), projectId);
}

export async function initWorkspaceProject(
  workspaceRoot: string,
  projectId: string,
  name: string,
): Promise<string> {
  const projectRoot = resolveWorkspaceProjectRoot(workspaceRoot, projectId);
  await initProject(projectRoot, name);
  return projectRoot;
}

export async function listWorkspaceProjects(
  workspaceRoot: string,
): Promise<IWorkspaceProjectEntry[]> {
  const projectsRoot = resolveProjectsRoot(workspaceRoot);
  const entries = await readdir(projectsRoot, { withFileTypes: true }).catch(() => []);
  const results: IWorkspaceProjectEntry[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const projectId = entry.name;
    const projectRoot = join(projectsRoot, projectId);
    const project = await readJsonOrNull(
      join(projectRoot, 'store/project.json'),
      IKtepProject,
    );
    if (!project) continue;
    results.push({
      projectId,
      projectRoot,
      project,
    });
  }

  return results.sort((a, b) => b.project.updatedAt.localeCompare(a.project.updatedAt));
}
