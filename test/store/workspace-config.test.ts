import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
        correctedDate: '2026-02-08',
        correctedTime: '19:55:05',
        timezone: 'Pacific/Auckland',
        note: 'TS 时间映射（用户提供）',
      }],
    });

    const loaded = await loadManualItineraryConfig(projectRoot);
    const markdown = await readFile(join(projectRoot, 'config', 'manual-itinerary.md'), 'utf-8');
    expect(loaded.prose).toContain('奥克兰出发');
    expect(loaded.segments[0]?.location).toContain('维多利亚山');
    expect(markdown).toContain('## 结构化行程');
    expect(markdown).toContain('## 素材时间校正');
    expect(markdown).toContain('20260208_奥克兰维多利亚山晚霞1.mp4');
  });

  it('syncs script brief and style sources without losing catalog metadata', async () => {
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
        sourceVideoCount: 2,
        createdAt: '2026-04-01T00:00:00.000Z',
        updatedAt: '2026-04-01T00:00:00.000Z',
      }],
    });
    await writeFile(join(stylesRoot, 'travel-doc.md'), '# Travel Doc\n\n## 叙事结构\n\nold body\n', 'utf-8');

    await saveScriptBriefConfig(projectRoot, {
      projectName: 'Project C',
      createdAt: '2026-04-05T00:00:00.000Z',
      styleCategory: 'travel-doc',
      statusText: '已进入脚本审查',
      goalDraft: ['表达旅途的克制感'],
      constraintDraft: ['总时长 8 分钟'],
      planReviewDraft: ['保留开场留白'],
      segments: [{
        segmentId: 'intro',
        title: '开场',
        role: 'intro',
        targetDurationMs: 45000,
        intent: '建立旅途基调',
        preferredClipTypes: ['broll', 'timelapse'],
        preferredPlaceHints: ['Auckland'],
        notes: ['少解释，多留白'],
      }],
    });

    await saveStyleSourcesConfig(workspaceRoot, projectRoot, {
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

    const brief = await loadScriptBriefConfig(projectRoot);
    const styleSources = await loadStyleSourcesConfig(workspaceRoot, projectRoot);
    const scriptMarkdown = await readFile(join(projectRoot, 'script', 'script-brief.md'), 'utf-8');
    const styleMarkdown = await readFile(join(stylesRoot, 'travel-doc.md'), 'utf-8');
    const catalog = JSON.parse(await readFile(join(stylesRoot, 'catalog.json'), 'utf-8'));

    expect(brief.styleCategory).toBe('travel-doc');
    expect(scriptMarkdown).toContain('### [intro] 开场');
    expect(styleSources.categories[0]?.sources).toHaveLength(1);
    expect(styleMarkdown).toContain('guidancePrompt: 重点看 intro 的克制感与叙事节奏。');
    expect(catalog.entries[0].name).toBe('严肃旅拍纪录片');
  });
});
