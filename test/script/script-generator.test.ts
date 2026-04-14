import { describe, expect, it } from 'vitest';
import type { IStyleProfile } from '../../src/protocol/schema.js';
import type { ILlmClient, ILlmMessage, ILlmOptions } from '../../src/modules/llm/client.js';
import type { IOutlineSegment } from '../../src/modules/script/outline-builder.js';
import { buildStylePrompt, generateScript } from '../../src/modules/script/script-generator.js';

class FakeLlm implements ILlmClient {
  constructor(private readonly response: unknown) {}

  async chat(_messages: ILlmMessage[], _opts?: ILlmOptions): Promise<string> {
    return typeof this.response === 'string'
      ? this.response
      : JSON.stringify(this.response);
  }
}

function createStyle(): IStyleProfile {
  return {
    id: 'style-1',
    name: '旅行纪录片风格',
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
    sections: [{
      id: 'section-1',
      title: '剪辑节奏与素材编排',
      content: '照片更多出现在回望和停顿里。延时常接在 establishing 后。航拍主要用于开场建场和地理重置。',
      tags: ['rhythm', 'material-grammar'],
    }],
    parameters: {
      '照片使用策略': '少量点缀，不会连续出现太久。',
    },
    arrangementStructure: {
      primaryAxis: '路线推进与空间打开',
      secondaryAxes: ['人物状态', '地点呼吸'],
      chapterPrograms: [{
        type: 'opening',
        intent: '先建立空间和旅程起点',
        materialRoles: ['establishing', 'anchor'],
        promotionSignals: ['建场', '地理重置'],
        transitionBias: 'smooth-intro',
        localNarrationNote: '先少解释。',
      }],
      chapterSplitPrinciples: ['先空间后人物'],
      chapterTransitionNotes: ['用环境音做桥'],
    },
    narrationConstraints: {
      perspective: '第一人称贴身观察',
      tone: '克制冷静',
      informationDensity: '少解释，多留白',
      explanationBias: '让材料自己成立',
      forbiddenPatterns: ['不要导游腔'],
      notes: ['句子不要太满'],
    },
    createdAt: '2026-04-03T00:00:00.000Z',
    updatedAt: '2026-04-03T00:00:00.000Z',
  };
}

describe('buildStylePrompt', () => {
  it('includes arrangement structure and narration constraints', () => {
    const style = createStyle();

    const prompt = buildStylePrompt(style);

    expect(prompt).toMatch(/编排主轴: 路线推进与空间打开/u);
    expect(prompt).toMatch(/章节程序/u);
    expect(prompt).toMatch(/opening: 先建立空间和旅程起点/u);
    expect(prompt).toMatch(/Narration Constraints/u);
    expect(prompt).toMatch(/forbidden: 不要导游腔/u);
  });

  it('keeps fallback beats when the model omits part of the outline', async () => {
    const outline: IOutlineSegment[] = [{
      id: 'segment-1',
      role: 'scene',
      title: '出发',
      narrativeSketch: '从出发走到上路。',
      estimatedDurationMs: 10_000,
      notes: [],
      selections: [],
      spanIds: ['span-1', 'span-2'],
      beats: [
        {
          id: 'beat-1',
          title: '出发口播',
          summary: '先把出发交代清楚。',
          query: '出发',
          selections: [{
            assetId: 'asset-1',
            spanId: 'span-1',
            sliceId: 'span-1',
            sourceInMs: 0,
            sourceOutMs: 2_000,
          }],
          linkedSpanIds: ['span-1'],
          sourceSpeechDecision: 'preserve',
          materialPatterns: [],
          locations: [],
        },
        {
          id: 'beat-2',
          title: '路上',
          summary: '再把路上的状态接进来。',
          query: '路上',
          selections: [{
            assetId: 'asset-2',
            spanId: 'span-2',
            sliceId: 'span-2',
            sourceInMs: 3_000,
            sourceOutMs: 5_000,
          }],
          linkedSpanIds: ['span-2'],
          sourceSpeechDecision: 'rewrite',
          materialPatterns: [],
          locations: [],
        },
      ],
    }];

    const llm = new FakeLlm([{
      id: 'segment-1',
      role: 'scene',
      title: '出发',
      narration: '从出发走到上路。',
      beats: [{
        id: 'beat-1',
        text: '先把出发交代清楚。',
        selections: [{
          assetId: 'asset-1',
          spanId: 'span-1',
          sliceId: 'span-1',
          sourceInMs: 0,
          sourceOutMs: 2_000,
        }],
        linkedSpanIds: ['span-1'],
      }],
    }]);

    const script = await generateScript(llm, outline, createStyle());

    expect(script).toHaveLength(1);
    expect(script[0]?.beats).toHaveLength(2);
    expect(script[0]?.beats.map(beat => beat.id)).toEqual(['beat-1', 'beat-2']);
    expect(script[0]?.beats[1]).toMatchObject({
      id: 'beat-2',
      text: '',
      linkedSpanIds: ['span-2'],
      selections: [{
        assetId: 'asset-2',
        spanId: 'span-2',
        sliceId: 'span-2',
        sourceInMs: 3_000,
        sourceOutMs: 5_000,
      }],
    });
  });

  it('keeps source speech fallback text but silences non-source-speech fallback beats', async () => {
    const outline: IOutlineSegment[] = [{
      id: 'segment-1',
      role: 'scene',
      title: '收尾',
      narrativeSketch: '从原声收尾走到静默画面。',
      estimatedDurationMs: 10_000,
      notes: [],
      selections: [],
      spanIds: ['span-1', 'span-2'],
      beats: [
        {
          id: 'beat-1',
          title: '原声收尾',
          summary: '这里不该用到',
          query: '原声收尾',
          selections: [{
            assetId: 'asset-1',
            spanId: 'span-1',
            sliceId: 'span-1',
            sourceInMs: 0,
            sourceOutMs: 2_000,
          }],
          linkedSpanIds: ['span-1'],
          transcript: '今天差不多就到这里了',
          sourceSpeechDecision: 'preserve',
          materialPatterns: [],
          locations: [],
        },
        {
          id: 'beat-2',
          title: '静默回望',
          summary: '如果返程画面不够，不要硬补返程叙事。',
          query: '静默回望',
          selections: [{
            assetId: 'asset-2',
            spanId: 'span-2',
            sliceId: 'span-2',
            sourceInMs: 3_000,
            sourceOutMs: 5_000,
          }],
          linkedSpanIds: ['span-2'],
          sourceSpeechDecision: 'rewrite',
          materialPatterns: [],
          locations: [],
        },
      ],
    }];

    const script = await generateScript(new FakeLlm('not-json'), outline, createStyle());

    expect(script[0]?.beats).toHaveLength(2);
    expect(script[0]?.beats[0]?.text).toBe('今天差不多就到这里了');
    expect(script[0]?.beats[1]?.text).toBe('');
    expect(script[0]?.narration).toBe('今天差不多就到这里了');
  });
});
