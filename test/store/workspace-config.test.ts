import { afterEach, describe, expect, it } from 'vitest';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  initWorkspaceProject,
  loadColorCurrent,
  loadColorTransformPresetsConfig,
  loadIngestRoots,
  loadManualItineraryConfig,
  loadProjectBriefConfig,
  loadScriptBriefConfig,
  loadStyleSourcesConfig,
  saveColorCurrent,
  saveColorTransformPresetsConfig,
  saveIngestRoots,
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
    await expect(access(join(projectRoot, 'config', 'project-roots.json'))).rejects.toBeTruthy();
    await expect(access(join(projectRoot, 'analysis', 'reference-transcripts'))).rejects.toBeTruthy();
    await expect(access(join(projectRoot, 'color', 'config.json'))).rejects.toBeTruthy();
    await expect(access(join(projectRoot, 'color', 'current.json'))).resolves.toBeUndefined();
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
        rawPath: 'F:\\media\\camera\\raw',
        alternatePaths: [
          {
            path: '/Volumes/Media/camera',
            rawPath: '/Volumes/Media/camera/raw',
          },
          {
            path: '/mnt/media/camera',
            rawPath: '/mnt/media/camera/raw',
          },
        ],
        description: '主机位',
        flightRecordPath: 'F:\\media\\camera\\FlightRecord',
      }],
    });

    const loaded = await loadProjectBriefConfig(projectRoot);
    const markdown = await readFile(join(projectRoot, 'config', 'project-brief.md'), 'utf-8');
    expect(loaded.mappings).toHaveLength(1);
    expect(loaded.mappings[0]?.alternatePaths).toEqual([
      {
        path: '/Volumes/Media/camera',
        rawPath: '/Volumes/Media/camera/raw',
      },
      {
        path: '/mnt/media/camera',
        rawPath: '/mnt/media/camera/raw',
      },
    ]);
    expect(markdown).toContain('路径：F:\\media\\camera');
    expect(markdown).toContain('原始路径：F:\\media\\camera\\raw');
    expect(markdown).toContain('备选路径1：/Volumes/Media/camera');
    expect(markdown).toContain('原始路径1：/Volumes/Media/camera/raw');
    expect(markdown).toContain('备选路径2：/mnt/media/camera');
    expect(markdown).toContain('原始路径2：/mnt/media/camera/raw');
    expect(markdown).toContain('飞行记录路径：F:\\media\\camera\\FlightRecord');
  });

  it('does not treat empty init template rows as configured project brief mappings', async () => {
    const workspaceRoot = await createWorkspace();
    const projectRoot = await initWorkspaceProject(workspaceRoot, 'project-blank-brief', 'Project Blank Brief');

    const loaded = await loadProjectBriefConfig(projectRoot);

    expect(loaded.mappings).toEqual([]);
  });

  it('migrates legacy project roots metadata into project brief json and removes legacy roots file on save', async () => {
    const workspaceRoot = await createWorkspace();
    const projectRoot = await initWorkspaceProject(workspaceRoot, 'project-legacy-roots', 'Project Legacy Roots');

    await writeFile(join(projectRoot, 'config', 'project-brief.md'), [
      '# Project Legacy Roots',
      '',
      '- 项目说明：legacy roots migration',
      '- 创建日期：2026-04-20T00:00:00.000Z',
      '',
      '## 路径映射',
      '',
      '路径：/media/current/camera',
      '原始路径：/media/raw/camera',
      '说明：主机位',
      '',
      '## Pharos',
      '',
      '包含 Trip：',
      '',
      '## 材料模式短语',
      '',
      '- ',
      '',
    ].join('\n'), 'utf-8');
    await writeJson(join(projectRoot, 'config', 'project-roots.json'), {
      roots: [{
        id: 'root-camera',
        path: '/media/current/camera',
        rawPath: '/media/raw/camera',
        enabled: false,
        label: 'Sony Main',
        description: '旧配置主机位',
        priority: 9,
        clockOffsetMs: -611_000,
        color: {
          renderPreset: {
            container: 'mp4',
            videoCodec: 'h265',
            audioCodec: 'aac',
            bitrateKbps: 120_000,
          },
          colorSpaceProfile: 'slog3',
        },
      }],
    });

    const loaded = await loadProjectBriefConfig(projectRoot);
    expect(loaded.mappings).toEqual([
      expect.objectContaining({
        rootId: 'root-camera',
        path: '/media/current/camera',
        rawPath: '/media/raw/camera',
        description: '主机位',
        enabled: false,
        label: 'Sony Main',
        priority: 9,
        clockOffsetMs: -611_000,
        color: {
          renderPreset: {
            container: 'mp4',
            videoCodec: 'h265',
            audioCodec: 'aac',
            bitrateKbps: 120_000,
          },
          colorSpaceProfile: 'slog3',
        },
      }),
    ]);

    await saveProjectBriefConfig(projectRoot, loaded);

    await expect(access(join(projectRoot, 'config', 'project-roots.json'))).rejects.toBeTruthy();
    const ingestRoots = await loadIngestRoots(projectRoot);
    expect(ingestRoots.roots).toEqual([
      expect.objectContaining({
        id: 'root-camera',
        clockOffsetMs: -611_000,
        label: 'Sony Main',
      }),
    ]);
  });

  it('keeps rootId stable when a saved project brief mapping path changes', async () => {
    const workspaceRoot = await createWorkspace();
    const projectRoot = await initWorkspaceProject(workspaceRoot, 'project-root-id-stable', 'Project RootId Stable');

    await writeFile(join(projectRoot, 'config', 'project-brief.md'), [
      '# Project RootId Stable',
      '',
      '- 项目说明：path rename test',
      '- 创建日期：2026-04-20T00:00:00.000Z',
      '',
      '## 路径映射',
      '',
      '路径：/media/current/camera-a',
      '说明：主机位 A',
      '',
      '## Pharos',
      '',
      '包含 Trip：',
      '',
      '## 材料模式短语',
      '',
      '- ',
      '',
    ].join('\n'), 'utf-8');

    const loaded = await loadProjectBriefConfig(projectRoot);
    const originalRootId = loaded.mappings[0]?.rootId;

    await saveProjectBriefConfig(projectRoot, {
      ...loaded,
      mappings: loaded.mappings.map(mapping => ({
        ...mapping,
        path: '/media/current/camera-b',
      })),
    });

    const updated = await loadProjectBriefConfig(projectRoot);
    expect(updated.mappings[0]?.rootId).toBe(originalRootId);
    expect(updated.mappings[0]?.path).toBe('/media/current/camera-b');
  });

  it('removes legacy root files when saving an empty structured project brief', async () => {
    const workspaceRoot = await createWorkspace();
    const projectRoot = await initWorkspaceProject(workspaceRoot, 'project-empty-brief', 'Project Empty Brief');

    await writeJson(join(projectRoot, 'config', 'project-roots.json'), {
      roots: [{
        id: 'root-camera',
        path: '/media/current/camera',
        description: 'legacy root',
        enabled: true,
      }],
    });

    await saveProjectBriefConfig(projectRoot, {
      name: 'Project Empty Brief',
      mappings: [],
      materialPatternPhrases: [],
    });

    await expect(access(join(projectRoot, 'config', 'project-roots.json'))).rejects.toBeTruthy();
    const ingestRoots = await loadIngestRoots(projectRoot);
    expect(ingestRoots.roots).toEqual([]);
  });

  it('roundtrips root-level color renderPreset and color current store', async () => {
    const workspaceRoot = await createWorkspace();
    const projectRoot = await initWorkspaceProject(workspaceRoot, 'project-color', 'Project Color');

    await saveIngestRoots(projectRoot, {
      roots: [{
        id: 'root-camera',
        path: '/media/current/camera',
        rawPath: '/media/raw/camera',
        enabled: true,
        color: {
          renderPreset: {
            container: 'mp4',
            videoCodec: 'h265',
            audioCodec: 'aac',
            bitrateKbps: 120_000,
          },
          colorSpaceProfile: 'S-Log3',
          transformPresetKey: 'Sony / SLog3_to_709',
        },
      }],
    });

    await saveColorCurrent(projectRoot, {
      selectedRootId: 'root-camera',
      roots: [{
        rootId: 'root-camera',
        mirrorStatus: 'ready',
        timelineStatus: 'missing',
        latestBatchId: 'batch-1',
        groups: [{
          groupKey: 'camera-log-day',
          status: 'ready',
        }],
      }],
    });

    const loadedRoots = await loadIngestRoots(projectRoot);
    const loadedCurrent = await loadColorCurrent(projectRoot);

    expect(loadedRoots.roots[0]?.color?.renderPreset?.bitrateKbps).toBe(120_000);
    expect(loadedRoots.roots[0]?.color?.colorSpaceProfile).toBe('slog3');
    expect(loadedRoots.roots[0]?.color?.transformPresetKey).toBe('Sony/SLog3_to_709.cube');
    expect(loadedCurrent.selectedRootId).toBe('root-camera');
    expect(loadedCurrent.roots[0]?.groups[0]?.status).toBe('ready');
  });

  it('roundtrips workspace color transform presets and normalizes keys/paths', async () => {
    const workspaceRoot = await createWorkspace();
    await mkdir(join(workspaceRoot, 'config', 'luts', 'sony'), { recursive: true });
    await writeFile(join(workspaceRoot, 'config', 'luts', 'sony', 'SLog3_to_709.cube'), 'lut-data', 'utf-8');

    await saveColorTransformPresetsConfig(workspaceRoot, {
      profiles: {
        'S-Log3': {
          default: 'Sony / SLog3_to_709',
        },
      },
    });

    const loaded = await loadColorTransformPresetsConfig(workspaceRoot);
    expect(loaded).toEqual({
      profiles: {
        slog3: {
          default: 'Sony/SLog3_to_709.cube',
        },
      },
      discoveredPresets: {
        'sony/SLog3_to_709.cube': {
          kind: 'lut',
          displayName: 'sony/SLog3_to_709.cube',
          lutPath: 'sony/SLog3_to_709.cube',
        },
      },
    });
    expect(await readFile(join(workspaceRoot, 'config', 'color-transform-presets.json'), 'utf-8')).toContain('"profiles"');
    expect(await readFile(join(workspaceRoot, 'config', 'color-transform-presets.json'), 'utf-8')).not.toContain('discoveredPresets');
  });

  it('migrates legacy color config renderPreset into project roots on load', async () => {
    const workspaceRoot = await createWorkspace();
    const projectRoot = await initWorkspaceProject(workspaceRoot, 'project-color-migrate', 'Project Color Migrate');

    await saveIngestRoots(projectRoot, {
      roots: [{
        id: 'root-camera',
        path: '/media/current/camera',
        rawPath: '/media/raw/camera',
        enabled: true,
      }],
    });

    await writeJson(join(projectRoot, 'color', 'config.json'), {
      roots: [{
        rootId: 'root-camera',
        renderPreset: {
          container: 'mp4',
          videoCodec: 'h265',
          audioCodec: 'aac',
          bitrateKbps: 150_000,
        },
      }],
    });

    const loaded = await loadIngestRoots(projectRoot);
    expect(loaded.roots).toHaveLength(1);
    expect(loaded.roots[0]?.id).toBe('root-camera');
    expect(loaded.roots[0]?.color?.renderPreset?.bitrateKbps).toBe(150_000);
    expect(loaded.roots[0]?.color?.renderPreset?.container).toBe('mp4');
  });

  it('preserves unmatched color current roots when saving one root', async () => {
    const workspaceRoot = await createWorkspace();
    const projectRoot = await initWorkspaceProject(workspaceRoot, 'project-color-current-preserve', 'Project Color Current Preserve');

    await saveColorCurrent(projectRoot, {
      selectedRootId: 'root-active',
      roots: [{
        rootId: 'root-active',
        mirrorStatus: 'ready',
        timelineStatus: 'ready',
        groups: [],
      }, {
        rootId: 'root-legacy',
        mirrorStatus: 'blocked',
        timelineStatus: 'blocked',
        detail: 'legacy blocked',
        groups: [{
          groupKey: 'legacy-group',
          status: 'blocked',
        }],
      }],
    });

    await saveColorCurrent(projectRoot, {
      selectedRootId: 'root-active',
      roots: [{
        rootId: 'root-active',
        mirrorStatus: 'running',
        timelineStatus: 'idle',
        groups: [],
      }],
    });

    const loaded = await loadColorCurrent(projectRoot);
    expect(loaded.roots).toHaveLength(2);
    expect(loaded.selectedRootId).toBe('root-active');
    expect(loaded.roots[0]?.rootId).toBe('root-active');
    expect(loaded.roots[0]?.mirrorStatus).toBe('running');
    expect(loaded.roots[1]?.rootId).toBe('root-legacy');
    expect(loaded.roots[1]?.detail).toBe('legacy blocked');
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
