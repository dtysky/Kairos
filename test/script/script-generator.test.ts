import { describe, expect, it } from 'vitest';
import type { IStyleProfile } from '../../src/protocol/schema.js';
import { buildStylePrompt } from '../../src/modules/script/script-generator.js';

describe('buildStylePrompt rhythm grammar fallback', () => {
  it('includes material-grammar rhythm cues when rawReference is absent', () => {
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
        '照片编排方式': '与视频交替而不是成串堆叠。',
        '延时使用关系': '建场之后或时间推进时进入。',
        '航拍插入时机': '开场建场、转场、情绪抬升前。',
        '空镜/B-roll 关系': '用来留白和建立空间。',
        '节奏抬升触发点': '进入内心高潮或空间切换时。',
      },
      createdAt: '2026-04-03T00:00:00.000Z',
      updatedAt: '2026-04-03T00:00:00.000Z',
    };

    const prompt = buildStylePrompt(style);

    expect(prompt).toMatch(/节奏与素材编排要点：/u);
    expect(prompt).toMatch(/照片更多出现在回望和停顿里/u);
    expect(prompt).toMatch(/节奏与素材参数：/u);
    expect(prompt).toMatch(/照片使用策略: 少量点缀，不会连续出现太久。/u);
    expect(prompt).toMatch(/航拍插入时机: 开场建场、转场、情绪抬升前。/u);
  });
});
