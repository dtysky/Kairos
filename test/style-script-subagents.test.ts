import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import type { IJsonPacketAgentInvocation, IJsonPacketAgentRunner } from '../src/modules/agents/runtime.js';
import {
  buildScriptAgentContract,
  buildSpatialStoryContext,
  runStyleProfileAgentPipeline,
  type IStyleReferenceVideoAnalysis,
} from '../src/modules/script/index.js';
import {
  getStyleAgentPacketPath,
  getStyleAgentSummaryPath,
  getStyleDraftPath,
  getStyleReviewPath,
} from '../src/store/index.js';

class MockAgentRunner implements IJsonPacketAgentRunner {
  readonly calls: IJsonPacketAgentInvocation[] = [];

  constructor(private readonly responses: string[]) {}

  async run<T>(input: IJsonPacketAgentInvocation): Promise<T> {
    this.calls.push(input);
    const next = this.responses.shift();
    if (typeof next !== 'string') {
      throw new Error('MockAgentRunner ran out of responses.');
    }
    return JSON.parse(next) as T;
  }
}

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe('style + script clean-context subagents', () => {
  it('runs style synthesis through synthesize -> review -> revise -> pass and persists agent artifacts', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'kairos-style-subagents-'));
    tempRoots.push(workspaceRoot);
    const reports: IStyleReferenceVideoAnalysis[] = [{
      sourceFile: 'ref-a.mp4',
      transcript: '我们一路沿着海岸线慢慢推进。',
      guidancePrompt: '重点看节奏和克制表达',
      contentInsights: ['旅途叙事', '空间推进'],
      rhythm: {
        shotCount: 12,
        cutsPerMinute: 8,
      },
      shotRecognitions: [{
        shotId: 'shot-1',
        startMs: 0,
        endMs: 2000,
        framePaths: ['a.jpg'],
        recognition: {
          description: '海岸公路上的缓慢前进镜头',
          sceneType: 'road',
          mood: 'calm',
          narrativeRole: 'transition',
        },
      }],
    }];

    const agentRunner = new MockAgentRunner([
      JSON.stringify({
        narrative: {
          introRatio: 0.1,
          outroRatio: 0.05,
          avgSegmentDurationSec: 24,
          brollFrequency: 0.2,
          pacePattern: '稳步推进',
        },
        voice: {
          person: '1st',
          tone: '克制',
          density: 'moderate',
          sampleTexts: ['先把路程走清楚。'],
        },
        sections: [{
          title: '剪辑节奏与素材编排',
          content: '以路线推进为主，但没有明确写 anti-pattern。',
        }],
        antiPatterns: [],
        parameters: {
          主轴: '路线推进',
        },
      }),
      JSON.stringify({
        verdict: 'revise',
        issues: [{
          code: 'anti_pattern_missing',
          severity: 'blocker',
          message: '草稿缺少明确 anti-pattern。',
        }],
        revisionBrief: ['补充至少一个明确 anti-pattern，并把节奏参数写完整。'],
      }),
      JSON.stringify({
        narrative: {
          introRatio: 0.1,
          outroRatio: 0.05,
          avgSegmentDurationSec: 24,
          brollFrequency: 0.2,
          pacePattern: '稳步推进',
        },
        voice: {
          person: '1st',
          tone: '克制',
          density: 'moderate',
          sampleTexts: ['先把路程走清楚。'],
        },
        sections: [{
          title: '剪辑节奏与素材编排',
          content: '以路线推进为主，节奏克制，尽量让地点和过程自己说话。',
        }],
        antiPatterns: ['不要为了抒情而打断路线推进'],
        parameters: {
          主轴: '路线推进',
          章节切分原则: '按空间阶段切',
          章节转场: '用地点转换收束',
          旁白视角: '第一人称',
          aerial角色: '少用',
        },
        layers: {
          literary: {
            summary: '第一人称、克制表达。',
            confidence: 'high',
            evidenceNotes: ['旁白样例保持克制。'],
            parameters: { voice: '第一人称' },
            antiPatterns: ['不要为了抒情而打断路线推进'],
          },
          artistic: {
            summary: '路线空间推进，地点和过程自己说话。',
            confidence: 'moderate',
            evidenceNotes: ['空间推进反复出现。'],
            parameters: { motif: '路线' },
            antiPatterns: [],
          },
          editingTechnical: {
            summary: '稳步推进，按空间阶段切。',
            confidence: 'high',
            evidenceNotes: ['cutsPerMinute 和 shotRecognitions 支持。'],
            parameters: { pace: '稳步推进' },
            antiPatterns: [],
          },
        },
      }),
      JSON.stringify({
        verdict: 'pass',
        issues: [],
        revisionBrief: [],
      }),
    ]);

    const result = await runStyleProfileAgentPipeline(agentRunner, reports, {
      workspaceRoot,
      categoryId: 'travel-doc',
      displayName: 'Travel Doc',
      guidancePrompt: '重点看节奏和克制表达',
    });

    expect(result.status).toBe('completed');
    expect(result.profile?.antiPatterns).toContain('不要为了抒情而打断路线推进');
    expect(result.profile?.parameters?.['aerial角色']).toBeDefined();
    expect(await readFile(getStyleAgentSummaryPath(workspaceRoot, 'travel-doc'), 'utf-8')).toContain('travel-doc');
    expect(await readFile(getStyleDraftPath(workspaceRoot, 'travel-doc'), 'utf-8')).toContain('不要为了抒情而打断路线推进');
    expect(await readFile(getStyleReviewPath(workspaceRoot, 'travel-doc'), 'utf-8')).toContain('"verdict": "pass"');
    const styleSynthPacket = await readFile(getStyleAgentPacketPath(workspaceRoot, 'travel-doc', 'style-profile-synthesizer'), 'utf-8');
    const styleReviewPacket = await readFile(getStyleAgentPacketPath(workspaceRoot, 'travel-doc', 'style-profile-reviewer'), 'utf-8');
    expect(styleSynthPacket).toContain('"identity": "style-profile-synthesizer"');
    expect(styleSynthPacket).toContain('风格生成法则');
    expect(styleSynthPacket).toContain('文学风格必须重点分析旁白写法');
    expect(styleReviewPacket).toContain('sample_recap_instead_of_style');
    expect(styleReviewPacket).toContain('literary_mechanics_missing');
    expect(styleReviewPacket).toContain('artistic_abstraction_missing');
    expect(agentRunner.calls.map(call => call.promptId)).toEqual([
      'style/style-profile-synthesizer',
      'style/style-profile-reviewer',
      'style/style-profile-synthesizer',
      'style/style-profile-reviewer',
    ]);
  });

  it('builds spatial story narrative hints and folds them into script agent contract', () => {
    const context = {
      project: { id: 'project-1', name: 'Project 1' },
      projectBrief: { name: 'Project 1', mappings: [], materialPatternPhrases: [], description: '测试项目' },
      assets: [
        { id: 'asset-a', kind: 'video', sourcePath: 'a.mp4', displayName: 'a.mp4' },
        { id: 'asset-b', kind: 'video', sourcePath: 'b.mp4', displayName: 'b.mp4' },
      ],
      spans: [
        {
          id: 'span-a',
          assetId: 'asset-a',
          type: 'drive',
          visualObservation: '公路连续推进。',
          materialPatterns: ['公路推进'],
          grounding: {
            speechMode: 'none',
            speechValue: 'none',
            spatialEvidence: [{
              tier: 'truth',
              confidence: 1,
              sourceKinds: ['gps'],
              lat: 1,
              lng: 2,
              locationText: 'Town A',
              routeRole: 'departure',
            }],
            pharosRefs: [],
          },
          pharosRefs: [{ tripId: 'trip-1', shotId: 'shot-a' }],
        },
        {
          id: 'span-b',
          assetId: 'asset-b',
          type: 'drive',
          visualObservation: '山路转场。',
          materialPatterns: ['山路转场'],
          grounding: {
            speechMode: 'none',
            speechValue: 'none',
            spatialEvidence: [{
              tier: 'truth',
              confidence: 1,
              sourceKinds: ['gps'],
              lat: 3,
              lng: 4,
              locationText: 'Town B',
              routeRole: 'arrival',
            }],
            pharosRefs: [],
          },
          pharosRefs: [{ tripId: 'trip-1', shotId: 'shot-b' }],
        },
        {
          id: 'span-c',
          assetId: 'asset-b',
          type: 'broll',
          materialPatterns: [],
          grounding: {
            speechMode: 'none',
            speechValue: 'none',
            spatialEvidence: [],
            pharosRefs: [],
          },
          pharosRefs: [],
        },
      ],
      chronology: [
        {
          id: 'chrono-a',
          assetId: 'asset-a',
          labels: [],
          placeHints: ['Town A'],
          evidence: [],
          sortCapturedAt: '2026-01-01T00:00:00.000Z',
          pharosMatches: [],
        },
        {
          id: 'chrono-b',
          assetId: 'asset-b',
          labels: [],
          placeHints: ['Town B'],
          evidence: [],
          sortCapturedAt: '2026-01-01T00:10:00.000Z',
          pharosMatches: [],
        },
      ],
      pharosContext: {
        schemaVersion: '1.0',
        generatedAt: '2026-01-01T00:00:00.000Z',
        status: 'success',
        rootPath: 'pharos',
        discoveredTripIds: ['trip-1'],
        includedTripIds: ['trip-1'],
        warnings: [],
        errors: [],
        trips: [],
        gpxFiles: [],
        shots: [
          {
            ref: { tripId: 'trip-1', shotId: 'shot-a' },
            location: 'Town A',
            description: '从 Town A 出发',
            type: 'drive',
            devices: [],
            rolls: [],
            status: 'expected',
            isExtraShot: false,
          },
          {
            ref: { tripId: 'trip-1', shotId: 'shot-b' },
            location: 'Town B',
            description: '到达 Town B',
            type: 'drive',
            devices: [],
            rolls: [],
            status: 'pending',
            isExtraShot: false,
          },
        ],
      },
    } as Parameters<typeof buildSpatialStoryContext>[0];

    const spatialStory = buildSpatialStoryContext(context);
    expect(spatialStory.anchors.map(anchor => anchor.title)).toEqual(expect.arrayContaining(['Town A', 'Town B']));
    expect(spatialStory.transitions[0]?.title).toContain('Town A');
    expect(spatialStory.narrativeHints[0]?.guidance).toContain('Town A');
    expect(spatialStory.coverageGaps.some(gap => gap.kind === 'weak-location')).toBe(true);
    expect(spatialStory.coverageGaps.some(gap => gap.kind === 'pharos-uncovered')).toBe(true);

    const contract = buildScriptAgentContract({
      brief: {
        projectName: 'Project 1',
        editRuleCategory: 'travel-doc',
        workflowState: 'ready_for_agent',
        goalDraft: ['按路线推进讲清这段旅程'],
        constraintDraft: ['不要打断 chronology'],
        planReviewDraft: ['检查地点切换是否清楚'],
        segments: [],
      } as Parameters<typeof buildScriptAgentContract>[0]['brief'],
      editRule: {
        categoryId: 'travel-doc',
        displayName: 'Travel Doc Rule',
        description: undefined,
        absolutePath: '/tmp/travel-doc.md',
        relativePath: 'travel-doc.md',
        contentHash: 'hash-a',
        frontMatter: {},
        markdown: '# Travel Doc Rule\n\n按路线推进讲清空间转换。',
      },
      spatialStory,
      chronology: context.chronology,
      pharosContext: context.pharosContext,
    });

    expect(contract.gpsNarrativeHints[0]).toContain('Town A');
    expect(contract.styleMust).toEqual(expect.arrayContaining([
      'editRuleCategory=travel-doc',
      'editRuleHash=hash-a',
    ]));
    expect(contract.styleForbidden).toContain('不要从剪辑规则 markdown 外推默认总时长、段落预算或隐藏启发式权重。');
    expect(contract.pharosPendingHints.some(item => item.includes('Town B'))).toBe(true);
    expect(contract.chronologyGuardrails.some(item => item.includes('chronology'))).toBe(true);
  });
});
