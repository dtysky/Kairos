import { afterEach, describe, expect, it } from 'vitest';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  initWorkspaceProject,
  loadManualItineraryConfig,
  loadProjectBriefConfig,
  loadScriptBriefConfig,
  loadStyleSourcesConfig,
  saveManualItineraryConfig,
  saveProjectBriefConfig,
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
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'kairos-workspace-config-test-'));
  workspaces.push(workspaceRoot);
  return workspaceRoot;
}

describe('workspace config sync', () => {
  it('does not create project-level styles directories during project init', async () => {
    const workspaceRoot = await createWorkspace();
    const projectRoot = await initWorkspaceProject(workspaceRoot, 'project-init', 'Project Init');

    await expect(access(join(projectRoot, 'config', 'styles'))).rejects.toBeTruthy();
    await expect(access(join(projectRoot, 'analysis', 'reference-transcripts'))).rejects.toBeTruthy();
  });

  it('roundtrips project brief into markdown and json', async () => {
    const workspaceRoot = await createWorkspace();
    const projectRoot = await initWorkspaceProject(workspaceRoot, 'project-a', 'Project A');

    await saveProjectBriefConfig(projectRoot, {
      name: 'Project A',
      description: 'A documentary project',
      createdAt: '2026-04-05T00:00:00.000Z',
      mappings: [{
        path: 'F:\\media\\camera',
        description: '主机位',
        flightRecordPath: 'F:\\media\\camera\\FlightRecord',
      }],
    });

    const loaded = await loadProjectBriefConfig(projectRoot);
    const markdown = await readFile(join(projectRoot, 'config', 'project-brief.md'), 'utf-8');
    expect(loaded.mappings).toHaveLength(1);
    expect(markdown).toContain('路径：F:\\media\\camera');
    expect(markdown).toContain('飞行记录路径：F:\\media\\camera\\FlightRecord');
  });

  it('preserves prose, structured itinerary, and capture overrides', async () => {
    const workspaceRoot = await createWorkspace();
    const projectRoot = await initWorkspaceProject(workspaceRoot, 'project-b', 'Project B');

    await saveManualItineraryConfig(projectRoot, {
      prose: '2026-02-08 下午从奥克兰出发，傍晚在维多利亚山等晚霞。',
      segments: [{
        id: 'segment-1',
        date: '2026-02-08',
        startLocalTime: '15:00',
        endLocalTime: '20:00',
        location: '奥克兰 / 维多利亚山',
        transport: 'drive',
        notes: '傍晚等晚霞',
      }],
      captureTimeOverrides: [{
        rootRef: 'root-ts',
        sourcePath: '20260208_奥克兰维多利亚山晚霞1.mp4',
        suggestedDate: '2026-02-08',
        suggestedTime: '19:55:05',
        correctedDate: '',
        correctedTime: '19:55:05',
        timezone: 'Pacific/Auckland',
        note: 'TS 时间映射（用户提供）',
      }],
    });

    const loaded = await loadManualItineraryConfig(projectRoot);
    const markdown = await readFile(join(projectRoot, 'config', 'manual-itinerary.md'), 'utf-8');
    expect(loaded.prose).toContain('奥克兰出发');
    expect(loaded.segments[0]?.location).toContain('维多利亚山');
    expect(loaded.captureTimeOverrides[0]?.correctedDate).toBe('2026-02-08');
    expect(markdown).toContain('## 结构化行程');
    expect(markdown).toContain('## 素材时间校正');
    expect(markdown).toContain('20260208_奥克兰维多利亚山晚霞1.mp4');
  });

  it('treats scaffold style placeholder as undefined when loading script brief', async () => {
    const workspaceRoot = await createWorkspace();
    const projectRoot = await initWorkspaceProject(workspaceRoot, 'project-placeholder', 'Placeholder Project');

    const brief = await loadScriptBriefConfig(projectRoot);

    expect(brief.styleCategory).toBeUndefined();
    expect(brief.workflowState).toBe('choose_style');
  });

  it('requires style-sources.json as the only workspace style index', async () => {
    const workspaceRoot = await createWorkspace();

    await expect(loadStyleSourcesConfig(workspaceRoot)).rejects.toThrow('style-sources.json');
  });

  it('syncs script brief and style sources while removing stale catalog files', async () => {
    const workspaceRoot = await createWorkspace();
    const projectRoot = await initWorkspaceProject(workspaceRoot, 'project-c', 'Project C');
    const stylesRoot = join(workspaceRoot, 'config', 'styles');

    await writeJson(join(stylesRoot, 'catalog.json'), {
      defaultCategory: 'travel-doc',
      entries: [{
        id: 'travel-doc',
        category: 'travel-doc',
        name: 'Travel Doc',
        profilePath: 'travel-doc.md',
        createdAt: '2026-04-01T00:00:00.000Z',
        updatedAt: '2026-04-01T00:00:00.000Z',
      }],
    });
    await writeFile(join(stylesRoot, 'travel-doc.md'), '# Travel Doc\n\n## 叙事结构\n\nold body\n', 'utf-8');

    await saveStyleSourcesConfig(workspaceRoot, {
      defaultCategory: 'travel-doc',
      categories: [{
        categoryId: 'travel-doc',
        displayName: '严肃旅拍纪录片',
        guidancePrompt: '重点看 intro 的克制感与叙事节奏。',
        overwriteExisting: false,
        profilePath: 'travel-doc.md',
        sources: [{
          id: 'source-1',
          type: 'directory',
          path: 'F:\\style-analysis\\travel-doc',
          rangeStart: '00:00',
          rangeEnd: '01:15',
        }],
      }],
    });

    await saveScriptBriefConfig(projectRoot, {
      projectName: 'Project C',
      createdAt: '2026-04-05T00:00:00.000Z',
      styleCategory: 'travel-doc',
      workflowState: 'await_brief_draft',
      goalDraft: [],
      constraintDraft: [],
      planReviewDraft: [],
      segments: [],
    });

    await saveScriptBriefConfig(projectRoot, {
      projectName: 'Project C',
      createdAt: '2026-04-05T00:00:00.000Z',
      styleCategory: 'travel-doc',
      workflowState: 'review_brief',
      goalDraft: ['表达旅途的克制感'],
      constraintDraft: ['总时长 8 分钟'],
      planReviewDraft: ['保留开场留白'],
      segments: [{
        segmentId: 'intro',
        title: '开场',
        roleHint: 'intro',
        targetDurationMs: 45000,
        intent: '建立旅途基调',
        notes: ['少解释，多留白', 'Auckland'],
      }],
    });

    const brief = await loadScriptBriefConfig(projectRoot);
    const styleSources = await loadStyleSourcesConfig(workspaceRoot);
    const scriptMarkdown = await readFile(join(projectRoot, 'script', 'script-brief.md'), 'utf-8');
    const styleMarkdown = await readFile(join(stylesRoot, 'travel-doc.md'), 'utf-8');
    await rm(join(projectRoot, 'script', 'script-brief.json'), { force: true });
    const parsedFromMarkdown = await loadScriptBriefConfig(projectRoot);

    expect(brief.styleCategory).toBe('travel-doc');
    expect(brief.workflowState).toBe('review_brief');
    expect(parsedFromMarkdown.styleCategory).toBe('travel-doc');
    expect(parsedFromMarkdown.workflowState).toBe('review_brief');
    expect(scriptMarkdown).toContain('风格参考：严肃旅拍纪录片（travel-doc）');
    expect(scriptMarkdown).toContain('workflowState=review_brief');
    expect(scriptMarkdown).toContain('### [intro] 开场');
    expect(styleSources.categories[0]?.sources).toHaveLength(1);
    expect(styleSources.categories[0]?.profilePath).toBe('travel-doc.md');
    expect(styleMarkdown).toContain('guidancePrompt: 重点看 intro 的克制感与叙事节奏。');
    await expect(access(join(stylesRoot, 'catalog.json'))).rejects.toBeTruthy();
  });

  it('clears stale script artifacts when styleCategory changes', async () => {
    const workspaceRoot = await createWorkspace();
    const projectRoot = await initWorkspaceProject(workspaceRoot, 'project-style-reset', 'Project Style Reset');
    const stylesRoot = join(workspaceRoot, 'config', 'styles');

    await saveStyleSourcesConfig(workspaceRoot, {
      defaultCategory: 'travel-doc',
      categories: [
        {
          categoryId: 'travel-doc',
          displayName: 'Travel Doc',
          overwriteExisting: false,
          profilePath: 'travel-doc.md',
          sources: [],
        },
        {
          categoryId: 'event-doc',
          displayName: 'Event Doc',
          overwriteExisting: false,
          profilePath: 'event-doc.md',
          sources: [],
        },
      ],
    });
    await writeFile(join(stylesRoot, 'travel-doc.md'), '# Travel Doc\n', 'utf-8');
    await writeFile(join(stylesRoot, 'event-doc.md'), '# Event Doc\n', 'utf-8');

    await saveScriptBriefConfig(projectRoot, {
      projectName: 'Project Style Reset',
      styleCategory: 'travel-doc',
      workflowState: 'script_generated',
      lastAgentDraftAt: '2026-04-05T00:00:00.000Z',
      lastUserReviewAt: '2026-04-05T01:00:00.000Z',
      goalDraft: ['旧目标'],
      constraintDraft: ['旧约束'],
      planReviewDraft: ['旧审查'],
      segments: [{
        segmentId: 'intro',
        title: '旧开场',
        notes: ['旧笔记'],
      }],
    });
    await writeFile(join(projectRoot, 'script', 'material-overview.md'), '# old overview', 'utf-8');
    await writeJson(join(projectRoot, 'script', 'material-overview.facts.json'), { sentinel: true });
    await writeJson(join(projectRoot, 'analysis', 'material-bundles.json'), [{ id: 'bundle-1' }]);
    await writeJson(join(projectRoot, 'script', 'segment-plan.json'), { segments: [] });
    await writeJson(join(projectRoot, 'script', 'material-slots.json'), { segments: [] });
    await writeJson(join(projectRoot, 'analysis', 'outline.json'), []);
    await writeFile(join(projectRoot, 'analysis', 'outline-prompt.txt'), 'old prompt', 'utf-8');
    await writeJson(join(projectRoot, 'script', 'current.json'), []);

    const next = await saveScriptBriefConfig(projectRoot, {
      projectName: 'Project Style Reset',
      createdAt: '2026-04-05T00:00:00.000Z',
      styleCategory: 'event-doc',
      workflowState: 'await_brief_draft',
      goalDraft: ['should be cleared'],
      constraintDraft: ['should be cleared'],
      planReviewDraft: ['should be cleared'],
      segments: [{
        segmentId: 'new-intro',
        title: '新开场',
      }],
    });

    expect(next.styleCategory).toBe('event-doc');
    expect(next.workflowState).toBe('await_brief_draft');
    expect(next.goalDraft).toEqual([]);
    expect(next.constraintDraft).toEqual([]);
    expect(next.planReviewDraft).toEqual([]);
    expect(next.segments).toEqual([]);
    await expect(access(join(projectRoot, 'script', 'material-overview.md'))).rejects.toBeTruthy();
    await expect(access(join(projectRoot, 'script', 'material-overview.facts.json'))).rejects.toBeTruthy();
    await expect(access(join(projectRoot, 'analysis', 'material-bundles.json'))).rejects.toBeTruthy();
    await expect(access(join(projectRoot, 'script', 'segment-plan.json'))).rejects.toBeTruthy();
    await expect(access(join(projectRoot, 'script', 'material-slots.json'))).rejects.toBeTruthy();
    await expect(access(join(projectRoot, 'analysis', 'outline.json'))).rejects.toBeTruthy();
    await expect(access(join(projectRoot, 'analysis', 'outline-prompt.txt'))).rejects.toBeTruthy();
    await expect(access(join(projectRoot, 'script', 'current.json'))).rejects.toBeTruthy();
  });
});
