import { describe, expect, it } from 'vitest';
import type { IStyleProfile } from '../../src/protocol/schema.js';
import { buildStylePrompt } from '../../src/modules/script/script-generator.js';

describe('buildStylePrompt', () => {
  it('includes arrangement structure and narration constraints', () => {
    const style: IStyleProfile = {
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

    const prompt = buildStylePrompt(style);

    expect(prompt).toMatch(/编排主轴: 路线推进与空间打开/u);
    expect(prompt).toMatch(/章节程序/u);
    expect(prompt).toMatch(/opening: 先建立空间和旅程起点/u);
    expect(prompt).toMatch(/Narration Constraints/u);
    expect(prompt).toMatch(/forbidden: 不要导游腔/u);
  });
});
