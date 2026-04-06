import { afterEach, describe, expect, it } from 'vitest';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareProjectScriptForAgent } from '../../src/modules/script/project-script.js';
import {
  getApprovedSegmentPlanPath,
  getCurrentScriptPath,
  getOutlinePath,
  getOutlinePromptPath,
  getProjectMaterialDigestPath,
  getScriptBriefConfigPath,
  getScriptBriefPath,
  getSegmentCandidatesPath,
  getSegmentPlanDraftsPath,
  initWorkspaceProject,
  loadScriptBriefConfig,
  saveScriptBriefConfig,
  saveStyleSourcesConfig,
  writeJson,
} from '../../src/store/index.js';

const workspaces: string[] = [];

afterEach(async () => {
  await Promise.all(
    workspaces.splice(0).map(path => rm(path, { recursive: true, force: true })),
  );
});

async function createWorkspace(): Promise<string> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'kairos-script-prep-test-'));
  workspaces.push(workspaceRoot);
  return workspaceRoot;
}

async function seedScriptPrepProject(workspaceRoot: string, projectId = 'script-prep-project'): Promise<string> {
  const projectRoot = await initWorkspaceProject(workspaceRoot, projectId, 'Script Prep Project');
  const now = '2026-04-06T08:00:00.000Z';

  await saveStyleSourcesConfig(workspaceRoot, {
    defaultCategory: 'travel-doc',
    categories: [{
      categoryId: 'travel-doc',
      displayName: 'Travel Doc',
      overwriteExisting: false,
      sources: [],
    }],
  });

  await writeJson(join(projectRoot, 'store', 'assets.json'), [{
    id: 'asset-1',
    kind: 'video',
    sourcePath: 'clip-1.mp4',
    displayName: 'clip-1.mp4',
    ingestRootId: 'root-1',
    durationMs: 12_000,
    capturedAt: now,
  }]);
  await writeJson(join(projectRoot, 'store', 'slices.json'), [{
    id: 'slice-1',
    assetId: 'asset-1',
    type: 'broll',
    sourceInMs: 1_000,
    sourceOutMs: 5_000,
    editSourceInMs: 500,
    editSourceOutMs: 5_500,
    summary: '海边步行镜头',
    transcript: '海边很安静。',
    labels: ['coast', 'walk'],
    placeHints: ['Auckland'],
    evidence: [],
  }]);
  await writeJson(join(projectRoot, 'media', 'chronology.json'), [{
    id: 'chronology-1',
    assetId: 'asset-1',
    ingestRootId: 'root-1',
    capturedAt: now,
    sortCapturedAt: now,
    summary: '海边步行镜头',
    labels: ['coast', 'walk'],
    placeHints: ['Auckland'],
    evidence: [],
  }]);
  await writeJson(join(projectRoot, 'analysis', 'asset-reports', 'asset-1.json'), {
    assetId: 'asset-1',
    ingestRootId: 'root-1',
    durationMs: 12_000,
    clipTypeGuess: 'broll',
    densityScore: 0.5,
    summary: '海边步行镜头',
    transcript: '海边很安静。',
    labels: ['coast', 'walk'],
    placeHints: ['Auckland'],
    rootNotes: [],
    sampleFrames: [],
    interestingWindows: [],
    shouldFineScan: false,
    fineScanMode: 'skip',
    fineScanReasons: [],
    createdAt: now,
    updatedAt: now,
  });

  await saveScriptBriefConfig(projectRoot, {
    projectName: 'Script Prep Project',
    styleCategory: 'travel-doc',
    workflowState: 'await_brief_draft',
    goalDraft: [],
    constraintDraft: [],
    planReviewDraft: [],
    segments: [],
  });
  await saveScriptBriefConfig(projectRoot, {
    projectName: 'Script Prep Project',
    styleCategory: 'travel-doc',
    workflowState: 'review_brief',
    goalDraft: ['从海边步行的观察感进入旅程。'],
    constraintDraft: ['保持克制，不要写成导览。'],
    planReviewDraft: ['先保留开场留白。'],
    segments: [{
      segmentId: 'intro',
      title: '进入海边',
      role: 'intro',
      targetDurationMs: 30000,
      intent: '先建立空间与呼吸感。',
      preferredClipTypes: ['broll'],
      preferredPlaceHints: ['Auckland'],
      notes: ['少解释，多观察'],
    }],
  });
  const draftedBrief = await loadScriptBriefConfig(projectRoot);
  await saveScriptBriefConfig(projectRoot, {
    ...draftedBrief,
    workflowState: 'ready_to_prepare',
  });

  return projectRoot;
}

describe('prepareProjectScriptForAgent', () => {
  it('writes digest and script brief without touching agent-owned script outputs', async () => {
    const workspaceRoot = await createWorkspace();
    const projectRoot = await seedScriptPrepProject(workspaceRoot);
    const sentinelScript = '{\n  "sentinel": true\n}\n';

    await writeFile(getCurrentScriptPath(projectRoot), sentinelScript, 'utf-8');

    const result = await prepareProjectScriptForAgent({
      projectRoot,
      workspaceRoot,
      styleCategory: 'travel-doc',
    });

    expect(result.status).toBe('awaiting_agent');
    expect(result.digestPath).toBe(getProjectMaterialDigestPath(projectRoot));
    expect(result.scriptBriefPath).toBe(getScriptBriefPath(projectRoot));

    const digest = JSON.parse(
      await readFile(getProjectMaterialDigestPath(projectRoot), 'utf-8'),
    ) as {
      totalAssets: number;
      topLabels: string[];
      topPlaceHints: string[];
    };
    expect(digest.totalAssets).toBe(1);
    expect(digest.topLabels).toContain('coast');
    expect(digest.topPlaceHints).toContain('Auckland');

    const scriptBrief = await loadScriptBriefConfig(projectRoot);
    const scriptBriefJson = JSON.parse(
      await readFile(getScriptBriefConfigPath(projectRoot), 'utf-8'),
    ) as {
      styleCategory?: string;
      workflowState?: string;
      statusText?: string;
    };
    const scriptBriefMarkdown = await readFile(getScriptBriefPath(projectRoot), 'utf-8');

    expect(scriptBrief.styleCategory).toBe('travel-doc');
    expect(scriptBrief.workflowState).toBe('ready_for_agent');
    expect(scriptBrief.statusText).toMatch(/脚本准备已完成/u);
    expect(scriptBriefJson.styleCategory).toBe('travel-doc');
    expect(scriptBriefJson.workflowState).toBe('ready_for_agent');
    expect(scriptBriefMarkdown).toContain('当前状态：脚本准备已完成');
    expect(scriptBriefMarkdown).toContain('workflowState=ready_for_agent');

    expect(await readFile(getCurrentScriptPath(projectRoot), 'utf-8')).toBe(sentinelScript);
    await expect(access(getSegmentPlanDraftsPath(projectRoot))).rejects.toBeTruthy();
    await expect(access(getApprovedSegmentPlanPath(projectRoot))).rejects.toBeTruthy();
    await expect(access(getSegmentCandidatesPath(projectRoot))).rejects.toBeTruthy();
    await expect(access(getOutlinePath(projectRoot))).rejects.toBeTruthy();
    await expect(access(getOutlinePromptPath(projectRoot))).rejects.toBeTruthy();
  });

  it('requires a selected style category before preparing script materials', async () => {
    const workspaceRoot = await createWorkspace();
    const projectRoot = await initWorkspaceProject(workspaceRoot, 'missing-style', 'Missing Style');

    await expect(prepareProjectScriptForAgent({
      projectRoot,
      workspaceRoot,
    })).rejects.toThrow(/styleCategory/u);
  });

  it('requires reviewed brief state before deterministic prep can run', async () => {
    const workspaceRoot = await createWorkspace();
    const projectRoot = await seedScriptPrepProject(workspaceRoot, 'not-ready');
    const readyBrief = await loadScriptBriefConfig(projectRoot);

    await saveScriptBriefConfig(projectRoot, {
      ...readyBrief,
      workflowState: 'review_brief',
    });

    await expect(prepareProjectScriptForAgent({
      projectRoot,
      workspaceRoot,
      styleCategory: 'travel-doc',
    })).rejects.toThrow(/ready_to_prepare/u);
  });
});
