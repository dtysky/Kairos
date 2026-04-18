import { afterEach, describe, expect, it } from 'vitest';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ILlmClient, ILlmMessage, ILlmOptions } from '../../src/modules/llm/client.js';
import {
  buildMaterialBundles,
  buildMaterialSlotsDocument,
  buildSegmentPlanDocument,
  buildProjectOutlineFromPlanning,
  generateProjectScriptFromPlanning,
  prepareProjectScriptForAgent,
} from '../../src/modules/script/project-script.js';
import { resolveArrangementSignals } from '../../src/modules/script/arrangement-signals.js';
import { loadStyleFromMarkdown } from '../../src/modules/script/style-loader.js';
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
    const packetText = messages.find(message => message.role === 'user')?.content ?? '{}';
    const packet = JSON.parse(packetText) as {
      packet?: {
        stage?: string;
        inputArtifacts?: Array<{ label?: string; content?: unknown }>;
      };
    };
    const stage = packet.packet?.stage;
    const artifacts = packet.packet?.inputArtifacts ?? [];

    if (stage?.startsWith('review-')) {
      return JSON.stringify({
        verdict: 'pass',
        issues: [],
        revisionBrief: [],
      });
    }

    if (stage === 'segment-plan') {
      const brief = artifacts.find(artifact => artifact.label === 'script-brief')?.content as {
        segments?: Array<{
          segmentId: string;
          title?: string;
          intent?: string;
          targetDurationMs?: number;
          roleHint?: string;
          notes?: string[];
        }>;
      } | undefined;
      return JSON.stringify({
        id: 'plan-1',
        projectId: 'script-prep-project',
        generatedAt: '2026-04-09T08:00:00.000Z',
        summary: '测试用 segment plan',
        notes: [],
        segments: (brief?.segments ?? []).map(segment => ({
          id: segment.segmentId,
          title: segment.title ?? segment.segmentId,
          intent: segment.intent ?? '',
          targetDurationMs: segment.targetDurationMs,
          roleHint: segment.roleHint,
          notes: segment.notes ?? [],
        })),
      });
    }

    if (stage === 'material-slots') {
      const baseDraft = artifacts.find(artifact => artifact.label === 'base-draft')?.content;
      return JSON.stringify(baseDraft ?? { segments: [] });
    }

    return JSON.stringify([{
      id: 'segment-opening',
      role: 'intro',
      title: '进入海边',
      narration: '风一进来，路才真的开始。',
      beats: [{
        id: 'beat-1',
        text: '风一进来，路才真的开始。',
        audioSelections: [],
        visualSelections: [{
          assetId: 'asset-1',
          spanId: 'span-coast',
          sliceId: 'span-coast',
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
  it('resolves short-trip-photo-vlog as a chronology-driven arrangement axis', async () => {
    const style = await loadStyleFromMarkdown(
      join(process.cwd(), 'config', 'styles', 'short-trip-photo-vlog.md'),
    );

    const signals = resolveArrangementSignals(style);

    expect(signals.primaryAxisKind).toBe('time');
    expect(signals.enforceChronology).toBe(true);
    expect(signals.routeContinuityStrength).toBeGreaterThan(0.28);
  });

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

  it('forces script prep to restart from a fresh brief when styleCategory changes', async () => {
    const workspaceRoot = await createWorkspace();
    const projectRoot = await seedProject(workspaceRoot);
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
    await writeFile(join(stylesRoot, 'event-doc.md'), '# Event Doc\n', 'utf-8');

    await writeOverview(projectRoot);
    await writeFile(getCurrentScriptPath(projectRoot), '{\n  "sentinel": true\n}\n', 'utf-8');
    await writeJson(getSegmentPlanPath(projectRoot), { segments: [] });
    await writeJson(getMaterialSlotsPath(projectRoot), { segments: [] });
    await writeJson(getOutlinePath(projectRoot), []);

    await saveScriptBriefConfig(projectRoot, {
      projectName: 'Script Prep Project',
      createdAt: '2026-04-09T08:00:00.000Z',
      styleCategory: 'event-doc',
      workflowState: 'await_brief_draft',
      goalDraft: ['should be cleared'],
      constraintDraft: ['should be cleared'],
      planReviewDraft: ['should be cleared'],
      segments: [{
        segmentId: 'segment-event',
        title: 'Event Intro',
      }],
    });

    const nextBrief = await loadScriptBriefConfig(projectRoot);
    expect(nextBrief.styleCategory).toBe('event-doc');
    expect(nextBrief.workflowState).toBe('await_brief_draft');
    expect(nextBrief.goalDraft).toEqual([]);
    expect(nextBrief.constraintDraft).toEqual([]);
    expect(nextBrief.planReviewDraft).toEqual([]);
    expect(nextBrief.segments).toEqual([]);
    await expect(access(join(projectRoot, 'script', 'material-overview.md'))).rejects.toBeTruthy();
    await expect(access(getSegmentPlanPath(projectRoot))).rejects.toBeTruthy();
    await expect(access(getMaterialSlotsPath(projectRoot))).rejects.toBeTruthy();
    await expect(access(getOutlinePath(projectRoot))).rejects.toBeTruthy();
    await expect(access(getCurrentScriptPath(projectRoot))).rejects.toBeTruthy();

    await expect(prepareProjectScriptForAgent({
      projectRoot,
      workspaceRoot,
      styleCategory: 'event-doc',
    })).rejects.toThrow(/script-brief\.workflowState=ready_to_prepare/u);

    await saveScriptBriefConfig(projectRoot, {
      ...nextBrief,
      workflowState: 'review_brief',
      goalDraft: ['new brief draft'],
      constraintDraft: ['new brief constraint'],
      planReviewDraft: ['new brief review'],
      segments: [{
        segmentId: 'segment-event',
        title: 'Event Intro',
      }],
    });
    await saveScriptBriefConfig(projectRoot, {
      ...(await loadScriptBriefConfig(projectRoot)),
      workflowState: 'ready_to_prepare',
    });

    await expect(prepareProjectScriptForAgent({
      projectRoot,
      workspaceRoot,
      styleCategory: 'event-doc',
    })).rejects.toThrow(/script prep requires script\/material-overview\.md/u);
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

  it('indexes every span into material bundles instead of shortlisting a subset', () => {
    const spans = [
      {
        id: 'span-1',
        assetId: 'asset-1',
        type: 'drive',
        sourceInMs: 0,
        sourceOutMs: 2_000,
        transcript: '先出发。',
        materialPatterns: [{ phrase: '路程推进', confidence: 0.8, evidenceRefs: [] }],
        grounding: { speechMode: 'available', speechValue: 'informative', spatialEvidence: [], pharosRefs: [] },
        narrativeFunctions: { core: [], extra: [], evidence: [] },
        shotGrammar: { core: [], extra: [], evidence: [] },
        viewpointRoles: { core: [], extra: [], evidence: [] },
        subjectStates: { core: [], extra: [], evidence: [] },
      },
      {
        id: 'span-2',
        assetId: 'asset-2',
        type: 'broll',
        sourceInMs: 2_000,
        sourceOutMs: 5_000,
        transcript: '到了入口。',
        materialPatterns: [{ phrase: '到场第一眼', confidence: 0.8, evidenceRefs: [] }],
        grounding: { speechMode: 'available', speechValue: 'informative', spatialEvidence: [], pharosRefs: [] },
        narrativeFunctions: { core: [], extra: [], evidence: [] },
        shotGrammar: { core: [], extra: [], evidence: [] },
        viewpointRoles: { core: [], extra: [], evidence: [] },
        subjectStates: { core: [], extra: [], evidence: [] },
      },
      {
        id: 'span-3',
        assetId: 'asset-3',
        type: 'photo',
        materialPatterns: [{ phrase: '结果照片', confidence: 0.8, evidenceRefs: [] }],
        grounding: { speechMode: 'none', speechValue: 'none', spatialEvidence: [], pharosRefs: [] },
        narrativeFunctions: { core: [], extra: [], evidence: [] },
        shotGrammar: { core: [], extra: [], evidence: [] },
        viewpointRoles: { core: [], extra: [], evidence: [] },
        subjectStates: { core: [], extra: [], evidence: [] },
      },
    ];

    const bundles = buildMaterialBundles(spans, [
      {
        id: 'chronology-1',
        assetId: 'asset-1',
        capturedAt: '2026-04-10T08:00:00.000Z',
        sortCapturedAt: '2026-04-10T08:00:00.000Z',
        labels: [],
        placeHints: [],
        evidence: [],
      },
      {
        id: 'chronology-2',
        assetId: 'asset-2',
        capturedAt: '2026-04-10T09:00:00.000Z',
        sortCapturedAt: '2026-04-10T09:00:00.000Z',
        labels: [],
        placeHints: [],
        evidence: [],
      },
    ], null);

    const bundledSpanIds = new Set(bundles.flatMap(bundle => bundle.memberSpanIds));
    expect(bundledSpanIds).toEqual(new Set(['span-1', 'span-2', 'span-3']));
  });

  it('keeps high-recall slots and only folds near-duplicate overlaps', () => {
    const slots = buildMaterialSlotsDocument({
      projectId: 'project-1',
      segmentPlan: {
        id: 'plan-1',
        projectId: 'project-1',
        generatedAt: '2026-04-10T00:00:00.000Z',
        summary: 'test',
        notes: [],
        segments: [{
          id: 'segment-1',
          title: '主拍过程',
          intent: '把现场推进过程尽量保留下来。',
          roleHint: 'scene',
          notes: ['过程'],
        }],
      },
      bundles: [{
        id: 'bundle-process',
        key: '现场过程',
        label: '现场过程',
        memberSpanIds: ['span-1', 'span-2', 'span-3', 'span-4', 'span-5', 'span-dup'],
        representativeSpanIds: ['span-1', 'span-2', 'span-3'],
        placeHints: [],
        pharosTripIds: [],
        notes: ['过程'],
      }],
      spans: [
        {
          id: 'span-1',
          assetId: 'asset-1',
          type: 'drive',
          sourceInMs: 0,
          sourceOutMs: 4_000,
          transcript: '先从停车场过去。',
          materialPatterns: [{ phrase: '现场过程', confidence: 0.9, evidenceRefs: [] }],
          grounding: { speechMode: 'available', speechValue: 'informative', spatialEvidence: [], pharosRefs: [] },
          narrativeFunctions: { core: [], extra: [], evidence: [] },
          shotGrammar: { core: [], extra: [], evidence: [] },
          viewpointRoles: { core: [], extra: [], evidence: [] },
          subjectStates: { core: [], extra: [], evidence: [] },
        },
        {
          id: 'span-dup',
          assetId: 'asset-1',
          type: 'drive',
          sourceInMs: 800,
          sourceOutMs: 4_200,
          transcript: '',
          materialPatterns: [{ phrase: '现场过程', confidence: 0.7, evidenceRefs: [] }],
          grounding: { speechMode: 'available', speechValue: 'informative', spatialEvidence: [], pharosRefs: [] },
          narrativeFunctions: { core: [], extra: [], evidence: [] },
          shotGrammar: { core: [], extra: [], evidence: [] },
          viewpointRoles: { core: [], extra: [], evidence: [] },
          subjectStates: { core: [], extra: [], evidence: [] },
        },
        {
          id: 'span-2',
          assetId: 'asset-2',
          type: 'broll',
          sourceInMs: 0,
          sourceOutMs: 3_000,
          transcript: '已经看到人群了。',
          materialPatterns: [{ phrase: '现场过程', confidence: 0.8, evidenceRefs: [] }],
          grounding: { speechMode: 'available', speechValue: 'informative', spatialEvidence: [], pharosRefs: [] },
          narrativeFunctions: { core: [], extra: [], evidence: [] },
          shotGrammar: { core: [], extra: [], evidence: [] },
          viewpointRoles: { core: [], extra: [], evidence: [] },
          subjectStates: { core: [], extra: [], evidence: [] },
        },
        {
          id: 'span-3',
          assetId: 'asset-3',
          type: 'talking-head',
          sourceInMs: 0,
          sourceOutMs: 2_500,
          transcript: '先试一轮看看。',
          materialPatterns: [{ phrase: '现场过程', confidence: 0.8, evidenceRefs: [] }],
          grounding: { speechMode: 'available', speechValue: 'informative', spatialEvidence: [], pharosRefs: [] },
          narrativeFunctions: { core: [], extra: [], evidence: [] },
          shotGrammar: { core: [], extra: [], evidence: [] },
          viewpointRoles: { core: [], extra: [], evidence: [] },
          subjectStates: { core: [], extra: [], evidence: [] },
        },
        {
          id: 'span-4',
          assetId: 'asset-4',
          type: 'photo',
          materialPatterns: [{ phrase: '现场过程', confidence: 0.8, evidenceRefs: [] }],
          grounding: { speechMode: 'none', speechValue: 'none', spatialEvidence: [], pharosRefs: [] },
          narrativeFunctions: { core: [], extra: [], evidence: [] },
          shotGrammar: { core: [], extra: [], evidence: [] },
          viewpointRoles: { core: [], extra: [], evidence: [] },
          subjectStates: { core: [], extra: [], evidence: [] },
        },
        {
          id: 'span-5',
          assetId: 'asset-5',
          type: 'broll',
          sourceInMs: 0,
          sourceOutMs: 3_200,
          transcript: '朋友也加入了。',
          materialPatterns: [{ phrase: '现场过程', confidence: 0.8, evidenceRefs: [] }],
          grounding: { speechMode: 'available', speechValue: 'informative', spatialEvidence: [], pharosRefs: [] },
          narrativeFunctions: { core: [], extra: [], evidence: [] },
          shotGrammar: { core: [], extra: [], evidence: [] },
          viewpointRoles: { core: [], extra: [], evidence: [] },
          subjectStates: { core: [], extra: [], evidence: [] },
        },
      ],
      chronology: [
        { id: 'c-1', assetId: 'asset-1', capturedAt: '2026-04-10T08:00:00.000Z', sortCapturedAt: '2026-04-10T08:00:00.000Z', labels: [], placeHints: [], evidence: [] },
        { id: 'c-2', assetId: 'asset-2', capturedAt: '2026-04-10T08:10:00.000Z', sortCapturedAt: '2026-04-10T08:10:00.000Z', labels: [], placeHints: [], evidence: [] },
        { id: 'c-3', assetId: 'asset-3', capturedAt: '2026-04-10T08:20:00.000Z', sortCapturedAt: '2026-04-10T08:20:00.000Z', labels: [], placeHints: [], evidence: [] },
        { id: 'c-4', assetId: 'asset-4', capturedAt: '2026-04-10T08:30:00.000Z', sortCapturedAt: '2026-04-10T08:30:00.000Z', labels: [], placeHints: [], evidence: [] },
        { id: 'c-5', assetId: 'asset-5', capturedAt: '2026-04-10T08:40:00.000Z', sortCapturedAt: '2026-04-10T08:40:00.000Z', labels: [], placeHints: [], evidence: [] },
      ],
      pharosContext: null,
      style: {
        id: 'style-1',
        name: 'Process First',
        category: 'process-first',
        sourceFiles: [],
        narrative: {
          introRatio: 0.1,
          outroRatio: 0.08,
          avgSegmentDurationSec: 20,
          brollFrequency: 0.3,
          pacePattern: '过程优先。',
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
          primaryAxis: '过程推进',
          secondaryAxes: [],
          chapterPrograms: [],
          chapterSplitPrinciples: [],
          chapterTransitionNotes: [],
        },
        narrationConstraints: {
          perspective: '第一人称',
          tone: '克制',
          informationDensity: '中等',
          explanationBias: '让过程自己成立',
          forbiddenPatterns: [],
          notes: [],
        },
        createdAt: '2026-04-10T00:00:00.000Z',
        updatedAt: '2026-04-10T00:00:00.000Z',
      },
    });

    const chosenSpanIds = slots.segments[0]?.slots.flatMap(slot => slot.chosenSpanIds) ?? [];
    expect(chosenSpanIds).toEqual(['span-1', 'span-2', 'span-3', 'span-4', 'span-5']);
    expect(chosenSpanIds).not.toContain('span-dup');
    expect(chosenSpanIds).toHaveLength(5);
    expect(slots.segments[0]?.slots).toHaveLength(1);
    expect(slots.segments[0]?.slots[0]?.chosenSpanIds).toEqual(['span-1', 'span-2', 'span-3', 'span-4', 'span-5']);
  });

  it('keeps chronology-driven segments inside monotonic time bands', () => {
    const style = {
      id: 'style-chronology',
      name: 'Chronology First',
      category: 'chronology-first',
      sourceFiles: [],
      narrative: {
        introRatio: 0.1,
        outroRatio: 0.08,
        avgSegmentDurationSec: 18,
        brollFrequency: 0.3,
        pacePattern: '按当天路程推进。',
      },
      voice: {
        person: '1st',
        tone: '平实',
        density: 'moderate',
        sampleTexts: [],
      },
      sections: [],
      parameters: {
        编排主轴: '按 chronology 和 route continuity 推进',
        章节切分原则: '按出发 / 路上 / 到场切段',
      },
      arrangementStructure: {
        primaryAxis: '路线推进',
        secondaryAxes: ['地点观察'],
        chapterPrograms: [
          {
            type: 'departure',
            intent: '先交代出发。',
            materialRoles: ['anchor'],
            promotionSignals: ['chronology'],
            transitionBias: 'smooth-intro',
          },
          {
            type: 'route',
            intent: '把路上的推进做实。',
            materialRoles: ['progression'],
            promotionSignals: ['route continuity'],
            transitionBias: 'carry-forward',
          },
          {
            type: 'arrival',
            intent: '给到场后的第一眼。',
            materialRoles: ['observation'],
            promotionSignals: ['arrival'],
            transitionBias: 'settle-outro',
          },
        ],
        chapterSplitPrinciples: ['按 chronology 切段'],
        chapterTransitionNotes: ['按路程推进衔接'],
      },
      narrationConstraints: {
        perspective: '第一人称',
        tone: '平实',
        informationDensity: '中等',
        explanationBias: '先跟着时间走',
        forbiddenPatterns: [],
        notes: [],
      },
      antiPatterns: [],
      createdAt: '2026-04-10T00:00:00.000Z',
      updatedAt: '2026-04-10T00:00:00.000Z',
    } as const;

    const slots = buildMaterialSlotsDocument({
      projectId: 'project-1',
      segmentPlan: {
        id: 'plan-1',
        projectId: 'project-1',
        generatedAt: '2026-04-10T00:00:00.000Z',
        summary: 'test',
        notes: [],
        segments: [
          { id: 'seg-1', title: '出发', intent: '出发', targetDurationMs: 12_000, notes: [] },
          { id: 'seg-2', title: '路上', intent: '路上', targetDurationMs: 12_000, notes: [] },
          { id: 'seg-3', title: '到场', intent: '到场', targetDurationMs: 12_000, notes: [] },
        ],
      },
      bundles: [{
        id: 'bundle-route',
        key: '路程推进',
        label: '路程推进',
        memberSpanIds: ['span-1', 'span-2', 'span-3'],
        representativeSpanIds: ['span-1', 'span-2', 'span-3'],
        placeHints: ['A', 'B', 'C'],
        pharosTripIds: [],
        notes: ['出发', '路上', '到场'],
      }],
      spans: [
        {
          id: 'span-1',
          assetId: 'asset-1',
          type: 'drive',
          sourceInMs: 0,
          sourceOutMs: 4_000,
          transcript: '先出发。',
          materialPatterns: [{ phrase: '路程推进', confidence: 0.8, evidenceRefs: [] }],
          grounding: { speechMode: 'available', speechValue: 'informative', spatialEvidence: [], pharosRefs: [] },
          narrativeFunctions: { core: [], extra: [], evidence: [] },
          shotGrammar: { core: [], extra: [], evidence: [] },
          viewpointRoles: { core: [], extra: [], evidence: [] },
          subjectStates: { core: [], extra: [], evidence: [] },
        },
        {
          id: 'span-2',
          assetId: 'asset-2',
          type: 'drive',
          sourceInMs: 0,
          sourceOutMs: 4_000,
          transcript: '现在正在路上。',
          materialPatterns: [{ phrase: '路程推进', confidence: 0.8, evidenceRefs: [] }],
          grounding: { speechMode: 'available', speechValue: 'informative', spatialEvidence: [], pharosRefs: [] },
          narrativeFunctions: { core: [], extra: [], evidence: [] },
          shotGrammar: { core: [], extra: [], evidence: [] },
          viewpointRoles: { core: [], extra: [], evidence: [] },
          subjectStates: { core: [], extra: [], evidence: [] },
        },
        {
          id: 'span-3',
          assetId: 'asset-3',
          type: 'broll',
          sourceInMs: 0,
          sourceOutMs: 4_000,
          transcript: '已经到场了。',
          materialPatterns: [{ phrase: '路程推进', confidence: 0.8, evidenceRefs: [] }],
          grounding: { speechMode: 'available', speechValue: 'informative', spatialEvidence: [], pharosRefs: [] },
          narrativeFunctions: { core: [], extra: [], evidence: [] },
          shotGrammar: { core: [], extra: [], evidence: [] },
          viewpointRoles: { core: [], extra: [], evidence: [] },
          subjectStates: { core: [], extra: [], evidence: [] },
        },
      ],
      chronology: [
        {
          id: 'c-1',
          assetId: 'asset-1',
          capturedAt: '2026-04-10T08:00:00.000Z',
          sortCapturedAt: '2026-04-10T08:00:00.000Z',
          labels: [],
          placeHints: [],
          evidence: [],
        },
        {
          id: 'c-2',
          assetId: 'asset-2',
          capturedAt: '2026-04-10T09:00:00.000Z',
          sortCapturedAt: '2026-04-10T09:00:00.000Z',
          labels: [],
          placeHints: [],
          evidence: [],
        },
        {
          id: 'c-3',
          assetId: 'asset-3',
          capturedAt: '2026-04-10T10:00:00.000Z',
          sortCapturedAt: '2026-04-10T10:00:00.000Z',
          labels: [],
          placeHints: [],
          evidence: [],
        },
      ],
      pharosContext: null,
      style,
    });

    expect(slots.segments[0]?.slots[0]?.chosenSpanIds[0]).toBe('span-1');
    expect(slots.segments[1]?.slots[0]?.chosenSpanIds[0]).toBe('span-2');
    expect(slots.segments[2]?.slots[0]?.chosenSpanIds[0]).toBe('span-3');
  });

  it('keeps missing segment durations undefined when no reviewed duration is provided', () => {
    const style = {
      id: 'style-chronology',
      name: 'Chronology First',
      category: 'chronology-first',
      sourceFiles: [],
      narrative: {
        introRatio: 0.1,
        outroRatio: 0.08,
        avgSegmentDurationSec: 10,
        brollFrequency: 0.3,
        pacePattern: '按过程推进。',
      },
      voice: {
        person: '1st',
        tone: '平实',
        density: 'moderate',
        sampleTexts: [],
      },
      sections: [],
      parameters: {
        编排主轴: 'chronology / route continuity',
      },
      arrangementStructure: {
        primaryAxis: '路线推进',
        secondaryAxes: [],
        chapterPrograms: [
          {
            type: 'opening',
            intent: '先出发。',
            materialRoles: ['anchor'],
            promotionSignals: ['chronology'],
            transitionBias: 'smooth-intro',
          },
          {
            type: 'body',
            intent: '把过程做实。',
            materialRoles: ['progression'],
            promotionSignals: ['route continuity'],
            transitionBias: 'carry-forward',
          },
        ],
        chapterSplitPrinciples: [],
        chapterTransitionNotes: [],
      },
      narrationConstraints: {
        perspective: '第一人称',
        tone: '平实',
        informationDensity: '中等',
        explanationBias: '先跟着过程走',
        forbiddenPatterns: [],
        notes: [],
      },
      antiPatterns: [],
      createdAt: '2026-04-10T00:00:00.000Z',
      updatedAt: '2026-04-10T00:00:00.000Z',
    } as const;

    const brief = {
      projectName: 'x',
      workflowState: 'ready_for_agent',
      goalDraft: [],
      constraintDraft: [],
      planReviewDraft: [],
      segments: [
        { segmentId: 'seg-1', title: '出发', intent: '出发', notes: [] },
        { segmentId: 'seg-2', title: '主体', intent: '主体', notes: [] },
      ],
    } as Awaited<ReturnType<typeof loadScriptBriefConfig>>;

    const plan = buildSegmentPlanDocument({
      projectId: 'project-1',
      brief,
      style,
      facts: {
        id: 'facts-1',
        projectId: 'project-1',
        generatedAt: '2026-04-10T00:00:00.000Z',
        projectBrief: '',
        totalAssets: 3,
        totalDurationMs: 30_000,
        roots: [],
        topLabels: [],
        topPlaceHints: [],
        topMaterialPatterns: [],
        clipTypeDistribution: {},
        mainThemes: [],
        inferredGaps: [],
        summary: '',
      },
      overviewMarkdown: '# Material Overview',
      spans: [
        {
          id: 'span-a',
          assetId: 'asset-a',
          type: 'drive',
          sourceInMs: 0,
          sourceOutMs: 6_000,
          transcript: '先出发。',
          materialPatterns: [{ phrase: '路程推进', confidence: 0.8, evidenceRefs: [] }],
          grounding: { speechMode: 'available', speechValue: 'informative', spatialEvidence: [], pharosRefs: [] },
          narrativeFunctions: { core: [], extra: [], evidence: [] },
          shotGrammar: { core: [], extra: [], evidence: [] },
          viewpointRoles: { core: [], extra: [], evidence: [] },
          subjectStates: { core: [], extra: [], evidence: [] },
        },
        {
          id: 'span-b',
          assetId: 'asset-b',
          type: 'drive',
          sourceInMs: 0,
          sourceOutMs: 8_000,
          transcript: '路上继续推进。',
          materialPatterns: [{ phrase: '路程推进', confidence: 0.8, evidenceRefs: [] }],
          grounding: { speechMode: 'available', speechValue: 'informative', spatialEvidence: [], pharosRefs: [] },
          narrativeFunctions: { core: [], extra: [], evidence: [] },
          shotGrammar: { core: [], extra: [], evidence: [] },
          viewpointRoles: { core: [], extra: [], evidence: [] },
          subjectStates: { core: [], extra: [], evidence: [] },
        },
        {
          id: 'span-c',
          assetId: 'asset-c',
          type: 'drive',
          sourceInMs: 0,
          sourceOutMs: 8_000,
          transcript: '路上继续推进。',
          materialPatterns: [{ phrase: '路程推进', confidence: 0.8, evidenceRefs: [] }],
          grounding: { speechMode: 'available', speechValue: 'informative', spatialEvidence: [], pharosRefs: [] },
          narrativeFunctions: { core: [], extra: [], evidence: [] },
          shotGrammar: { core: [], extra: [], evidence: [] },
          viewpointRoles: { core: [], extra: [], evidence: [] },
          subjectStates: { core: [], extra: [], evidence: [] },
        },
      ],
      chronology: [
        { id: 'c-a', assetId: 'asset-a', capturedAt: '2026-04-10T08:00:00.000Z', sortCapturedAt: '2026-04-10T08:00:00.000Z', labels: [], placeHints: [], evidence: [] },
        { id: 'c-b', assetId: 'asset-b', capturedAt: '2026-04-10T09:00:00.000Z', sortCapturedAt: '2026-04-10T09:00:00.000Z', labels: [], placeHints: [], evidence: [] },
        { id: 'c-c', assetId: 'asset-c', capturedAt: '2026-04-10T09:30:00.000Z', sortCapturedAt: '2026-04-10T09:30:00.000Z', labels: [], placeHints: [], evidence: [] },
      ],
      pharosContext: null,
    });

    expect(plan.segments[0]?.targetDurationMs).toBeUndefined();
    expect(plan.segments[1]?.targetDurationMs).toBeUndefined();
  });
});
