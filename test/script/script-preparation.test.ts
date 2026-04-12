import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ILlmClient, ILlmMessage, ILlmOptions } from '../../src/modules/llm/client.js';
import {
  buildMaterialSlotsDocument,
  buildProjectOutlineFromPlanning,
  generateProjectScriptFromPlanning,
  prepareProjectScriptForAgent,
} from '../../src/modules/script/project-script.js';
import {
  getCurrentScriptPath,
  getMaterialBundlesPath,
  getMaterialOverviewFactsPath,
  getMaterialSlotsPath,
  getOutlinePath,
  getScriptBriefPath,
  getSegmentPlanPath,
  initWorkspaceProject,
  loadCurrentScript,
  loadMaterialBundles,
  loadMaterialOverviewFacts,
  loadScriptBriefConfig,
  saveScriptBriefConfig,
  saveStyleSourcesConfig,
  writeJson,
} from '../../src/store/index.js';

class FakeLlm implements ILlmClient {
  messages: ILlmMessage[] = [];

  async chat(messages: ILlmMessage[], _opts?: ILlmOptions): Promise<string> {
    this.messages = messages;
    return JSON.stringify([{
      id: 'segment-opening',
      role: 'intro',
      title: '进入海边',
      narration: '风一进来，路才真的开始。',
      beats: [{
        id: 'beat-1',
        text: '风一进来，路才真的开始。',
        selections: [{
          assetId: 'asset-1',
          spanId: 'span-coast',
          sourceInMs: 1_000,
          sourceOutMs: 7_000,
        }],
        linkedSpanIds: ['span-coast'],
      }],
    }]);
  }
}

const workspaces: string[] = [];

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function createWorkspace(): Promise<string> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'kairos-model-arrangement-'));
  workspaces.push(workspaceRoot);
  return workspaceRoot;
}

async function seedProject(workspaceRoot: string): Promise<string> {
  const projectRoot = await initWorkspaceProject(workspaceRoot, 'script-prep-project', 'Script Prep Project');
  const styleRoot = join(workspaceRoot, 'config', 'styles');
  const now = '2026-04-09T08:00:00.000Z';

  await saveStyleSourcesConfig(workspaceRoot, {
    defaultCategory: 'travel-doc',
    categories: [{
      categoryId: 'travel-doc',
      displayName: 'Travel Doc',
      overwriteExisting: false,
      sources: [],
      profilePath: 'travel-doc.md',
    }],
  });
  await writeFile(join(styleRoot, 'travel-doc.md'), `
# Travel Doc

## 叙事结构
- 先建立空间，再进入人物。

## 参数
主轴: 路线推进
辅助轴: 地点观察 / 情绪回落
章节程序1: opening | 先建立空间和旅程起点 | establishing / anchor | 建场 / 海边 | smooth-intro | 先少解释
章节切分原则: 先空间后人物
章节转场: 用环境音做桥
旁白视角: 第一人称贴身观察
旁白备注: 少解释 / 留白
照片使用策略: 少量点缀
照片编排方式: 与视频交替
延时使用关系: 用于时间推进
航拍插入时机: 开场建场
空镜/B-roll 关系: 做呼吸
节奏抬升触发点: 空间切换
`, 'utf-8');

  await writeJson(join(projectRoot, 'store', 'assets.json'), [{
    id: 'asset-1',
    kind: 'video',
    sourcePath: 'clip-1.mp4',
    displayName: 'clip-1.mp4',
    ingestRootId: 'root-1',
    durationMs: 12_000,
    capturedAt: now,
  }]);
  await writeJson(join(projectRoot, 'store', 'spans.json'), [{
    id: 'span-coast',
    assetId: 'asset-1',
    type: 'broll',
    sourceInMs: 1_000,
    sourceOutMs: 7_000,
    transcript: '海边很安静。',
    materialPatterns: [{
      phrase: '高辨识度地点快速建场',
      confidence: 0.82,
      evidenceRefs: [],
    }],
    grounding: {
      speechMode: 'available',
      speechValue: 'emotional',
      spatialEvidence: [{
        tier: 'strong-inference',
        confidence: 0.8,
        sourceKinds: ['vision'],
        reasons: ['coastal-walk'],
        locationText: 'Auckland',
      }],
      pharosRefs: [],
    },
    narrativeFunctions: { core: [], extra: [], evidence: [] },
    shotGrammar: { core: [], extra: [], evidence: [] },
    viewpointRoles: { core: [], extra: [], evidence: [] },
    subjectStates: { core: [], extra: [], evidence: [] },
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

  await saveScriptBriefConfig(projectRoot, {
    projectName: 'Script Prep Project',
    styleCategory: 'travel-doc',
    workflowState: 'review_brief',
    lastAgentDraftAt: '2026-04-09T07:30:00.000Z',
    goalDraft: ['从海边步行的观察感进入旅程。'],
    constraintDraft: ['保持克制，不要写成导览。'],
    planReviewDraft: ['先保留开场留白。'],
    segments: [{
      segmentId: 'segment-opening',
      title: '进入海边',
      roleHint: 'intro',
      targetDurationMs: 18_000,
      intent: '先建立空间与呼吸感。',
      notes: ['少解释，多观察'],
    }],
  });
  await saveScriptBriefConfig(projectRoot, {
    projectName: 'Script Prep Project',
    styleCategory: 'travel-doc',
    workflowState: 'ready_to_prepare',
    lastAgentDraftAt: '2026-04-09T07:30:00.000Z',
    goalDraft: ['从海边步行的观察感进入旅程。'],
    constraintDraft: ['保持克制，不要写成导览。'],
    planReviewDraft: ['先保留开场留白。'],
    segments: [{
      segmentId: 'segment-opening',
      title: '进入海边',
      roleHint: 'intro',
      targetDurationMs: 18_000,
      intent: '先建立空间与呼吸感。',
      notes: ['少解释，多观察'],
    }],
  });

  return projectRoot;
}

async function writeOverview(projectRoot: string): Promise<void> {
  await writeFile(
    join(projectRoot, 'script', 'material-overview.md'),
    '# Material Overview\n\n- 海边作为开场建场材料。\n',
    'utf-8',
  );
}

describe('model-driven script preparation', () => {
  it('requires material-overview.md before deterministic prep can advance to ready_for_agent', async () => {
    const workspaceRoot = await createWorkspace();
    const projectRoot = await seedProject(workspaceRoot);

    await expect(prepareProjectScriptForAgent({
      projectRoot,
      workspaceRoot,
      styleCategory: 'travel-doc',
    })).rejects.toThrow(/script prep requires script\/material-overview\.md/u);

    const brief = await loadScriptBriefConfig(projectRoot);
    expect(brief.workflowState).toBe('ready_to_prepare');
  });

  it('prepares only material facts and bundles, without touching current script', async () => {
    const workspaceRoot = await createWorkspace();
    const projectRoot = await seedProject(workspaceRoot);
    const sentinelScript = '{\n  "sentinel": true\n}\n';

    await writeOverview(projectRoot);
    await writeFile(getCurrentScriptPath(projectRoot), sentinelScript, 'utf-8');

    const result = await prepareProjectScriptForAgent({
      projectRoot,
      workspaceRoot,
      styleCategory: 'travel-doc',
    });

    expect(result.status).toBe('awaiting_agent');
    expect(result.materialOverviewFactsPath).toBe(getMaterialOverviewFactsPath(projectRoot));
    expect(result.materialBundlesPath).toBe(getMaterialBundlesPath(projectRoot));
    expect(result.scriptBriefPath).toBe(getScriptBriefPath(projectRoot));

    const facts = await loadMaterialOverviewFacts(projectRoot);
    expect(facts?.topMaterialPatterns).toContain('高辨识度地点快速建场');

    const bundles = await loadMaterialBundles(projectRoot);
    expect(bundles[0]?.memberSpanIds).toContain('span-coast');

    expect(await readFile(getCurrentScriptPath(projectRoot), 'utf-8')).toBe(sentinelScript);

    const brief = await loadScriptBriefConfig(projectRoot);
    expect(brief.workflowState).toBe('ready_for_agent');
  });

  it('writes segment-plan, material-slots and script/current from the new chain', async () => {
    const workspaceRoot = await createWorkspace();
    const projectRoot = await seedProject(workspaceRoot);
    await writeOverview(projectRoot);

    await prepareProjectScriptForAgent({
      projectRoot,
      workspaceRoot,
      styleCategory: 'travel-doc',
    });

    const built = await buildProjectOutlineFromPlanning({
      projectRoot,
      workspaceRoot,
      styleCategory: 'travel-doc',
    });

    expect(built.segmentPlan.segments[0]?.id).toBe('segment-opening');
    expect(built.materialSlots.segments[0]?.slots[0]?.chosenSpanIds).toEqual(['span-coast']);

    const llm = new FakeLlm();
    await generateProjectScriptFromPlanning({
      projectRoot,
      llm,
      style: {
        id: 'style-1',
        name: 'Travel Doc',
        category: 'travel-doc',
        sourceFiles: [],
        narrative: {
          introRatio: 0.1,
          outroRatio: 0.08,
          avgSegmentDurationSec: 24,
          brollFrequency: 0.5,
          pacePattern: '前段缓入，中段推进，尾段抬升。',
        },
        voice: {
          person: '1st',
          tone: '克制',
          density: 'moderate',
          sampleTexts: [],
        },
        sections: [],
        parameters: {},
        arrangementStructure: {
          primaryAxis: '路线推进',
          secondaryAxes: [],
          chapterPrograms: [],
          chapterSplitPrinciples: [],
          chapterTransitionNotes: [],
        },
        narrationConstraints: {
          perspective: '第一人称贴身观察',
          tone: '克制',
          informationDensity: '少解释，多留白',
          explanationBias: '让材料自己成立',
          forbiddenPatterns: [],
          notes: [],
        },
        createdAt: '2026-04-09T00:00:00.000Z',
        updatedAt: '2026-04-09T00:00:00.000Z',
      },
    });

    expect(JSON.parse(await readFile(getSegmentPlanPath(projectRoot), 'utf-8')).segments).toHaveLength(1);
    expect(JSON.parse(await readFile(getMaterialSlotsPath(projectRoot), 'utf-8')).segments[0].slots[0].chosenSpanIds).toEqual(['span-coast']);
    expect(JSON.parse(await readFile(getOutlinePath(projectRoot), 'utf-8'))[0].beats[0].linkedSpanIds).toEqual(['span-coast']);
    expect((await loadCurrentScript(projectRoot))?.[0]?.linkedSpanIds).toContain('span-coast');
  });

  it('requires ready_for_agent before final script generation can run', async () => {
    const workspaceRoot = await createWorkspace();
    const projectRoot = await seedProject(workspaceRoot);
    await writeOverview(projectRoot);

    const llm = new FakeLlm();
    await expect(generateProjectScriptFromPlanning({
      projectRoot,
      llm,
      style: {
        id: 'style-1',
        name: 'Travel Doc',
        category: 'travel-doc',
        sourceFiles: [],
        narrative: {
          introRatio: 0.1,
          outroRatio: 0.08,
          avgSegmentDurationSec: 24,
          brollFrequency: 0.5,
          pacePattern: '前段缓入，中段推进，尾段抬升。',
        },
        voice: {
          person: '1st',
          tone: '克制',
          density: 'moderate',
          sampleTexts: [],
        },
        sections: [],
        parameters: {},
        arrangementStructure: {
          primaryAxis: '路线推进',
          secondaryAxes: [],
          chapterPrograms: [],
          chapterSplitPrinciples: [],
          chapterTransitionNotes: [],
        },
        narrationConstraints: {
          perspective: '第一人称贴身观察',
          tone: '克制',
          informationDensity: '少解释，多留白',
          explanationBias: '让材料自己成立',
          forbiddenPatterns: [],
          notes: [],
        },
        createdAt: '2026-04-09T00:00:00.000Z',
        updatedAt: '2026-04-09T00:00:00.000Z',
      },
    })).rejects.toThrow(/script-brief\.workflowState=ready_for_agent/u);
  });

  it('retrieves chosenSpanIds from material patterns first and then chronology/location evidence', () => {
    const slots = buildMaterialSlotsDocument({
      projectId: 'project-1',
      segmentPlan: {
        id: 'plan-1',
        projectId: 'project-1',
        generatedAt: '2026-04-09T00:00:00.000Z',
        summary: 'test',
        notes: [],
        segments: [{
          id: 'segment-1',
          title: '进入海边',
          intent: '用海边建场打开旅程。',
          roleHint: 'intro',
          targetDurationMs: 18_000,
          notes: ['Auckland'],
        }],
      },
      bundles: [{
        id: 'bundle-coast',
        key: '高辨识度地点快速建场',
        label: '高辨识度地点快速建场 / Auckland',
        memberSpanIds: ['span-coast'],
        representativeSpanIds: ['span-coast'],
        placeHints: ['Auckland'],
        pharosTripIds: [],
        notes: ['海边', '建场'],
      }],
      spans: [{
        id: 'span-coast',
        assetId: 'asset-1',
        type: 'broll',
        sourceInMs: 1_000,
        sourceOutMs: 7_000,
        transcript: '海边很安静。',
        materialPatterns: [{
          phrase: '高辨识度地点快速建场',
          confidence: 0.82,
          evidenceRefs: [],
        }],
        grounding: {
          speechMode: 'available',
          speechValue: 'emotional',
          spatialEvidence: [{
            tier: 'strong-inference',
            confidence: 0.8,
            sourceKinds: ['vision'],
            reasons: ['test'],
            locationText: 'Auckland',
          }],
          pharosRefs: [],
        },
        narrativeFunctions: { core: [], extra: [], evidence: [] },
        shotGrammar: { core: [], extra: [], evidence: [] },
        viewpointRoles: { core: [], extra: [], evidence: [] },
        subjectStates: { core: [], extra: [], evidence: [] },
      }],
      chronology: [{
        id: 'chronology-1',
        assetId: 'asset-1',
        ingestRootId: 'root-1',
        capturedAt: '2026-04-09T08:00:00.000Z',
        sortCapturedAt: '2026-04-09T08:00:00.000Z',
        labels: ['coast'],
        placeHints: ['Auckland'],
        evidence: [],
      }],
      pharosContext: null,
      style: {
        id: 'style-1',
        name: 'Travel Doc',
        sourceFiles: [],
        narrative: {
          introRatio: 0.1,
          outroRatio: 0.08,
          avgSegmentDurationSec: 24,
          brollFrequency: 0.5,
          pacePattern: '前段缓入，中段推进，尾段抬升。',
        },
        voice: {
          person: '1st',
          tone: '克制',
          density: 'moderate',
          sampleTexts: [],
        },
        sections: [],
        parameters: {},
        arrangementStructure: {
          primaryAxis: '路线推进',
          secondaryAxes: [],
          chapterPrograms: [],
          chapterSplitPrinciples: [],
          chapterTransitionNotes: [],
        },
        narrationConstraints: {
          forbiddenPatterns: [],
          notes: [],
        },
        createdAt: '2026-04-09T00:00:00.000Z',
        updatedAt: '2026-04-09T00:00:00.000Z',
      },
    });

    expect(slots.segments[0]?.slots[0]?.targetBundles).toEqual(['bundle-coast']);
    expect(slots.segments[0]?.slots[0]?.chosenSpanIds).toEqual(['span-coast']);
  });
});
