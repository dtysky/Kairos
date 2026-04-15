import { describe, expect, it } from 'vitest';
import type { ILlmClient, ILlmMessage, ILlmOptions } from '../../src/modules/llm/client.js';
import { analyzeStyleFromReports } from '../../src/modules/script/style-analyzer.js';

class FakeLlm implements ILlmClient {
  calls: ILlmMessage[][] = [];

  constructor(private response: string) {}

  async chat(messages: ILlmMessage[], _opts?: ILlmOptions): Promise<string> {
    this.calls.push(messages);
    return this.response;
  }
}

describe('analyzeStyleFromReports', () => {
  it('derives arrangement structure and narration constraints from llm output', async () => {
    const llm = new FakeLlm(JSON.stringify({
      narrative: {
        introRatio: 0.12,
        outroRatio: 0.08,
        avgSegmentDurationSec: 18,
        brollFrequency: 0.4,
        pacePattern: '前段克制，中段推进，尾段抬升。',
      },
      voice: {
        person: '1st',
        tone: '冷静克制',
        density: 'high',
        sampleTexts: [],
      },
      sections: [
        { title: '叙事结构', content: '从空间进入，再转向自我。' },
      ],
      parameters: {
        '主轴': '路线推进',
        '辅助轴': '地点观察 / 个人状态',
        '章节程序1': 'opening | 先建场 | establishing / anchor | 建场 / 地理重置 | smooth-intro',
        '照片使用策略': '少量点缀，用于回望或停顿。',
        '照片编排方式': '常与运动镜头交替，避免连续堆叠。',
        '延时使用关系': '多用于建场之后的节奏切换。',
        '航拍插入时机': '开场建场或地理重置时进入。',
        '空镜/B-roll 关系': '承担呼吸与空间建立，不直接解释文本。',
        '节奏抬升触发点': '进入内心独白高潮时明显加速。',
        '旁白视角': '第一人称贴身观察',
      },
      antiPatterns: ['不要导游腔'],
    }));

    const profile = await analyzeStyleFromReports(llm, [{
      sourceFile: 'reference-1.mp4',
      transcript: '我们重新回到海边。',
    }]);

    expect(llm.calls[0]?.[0]?.content).toMatch(/style-profile-synthesizer/u);
    expect(llm.calls[0]?.[1]?.content).toMatch(/agentInputReports/u);
    expect(llm.calls[1]?.[0]?.content).toMatch(/style-profile-reviewer/u);
    expect(profile.arrangementStructure.primaryAxis).toBe('路线推进');
    expect(profile.arrangementStructure.chapterPrograms[0]?.type).toBe('opening');
    expect(profile.narrationConstraints.perspective).toBe('第一人称贴身观察');
    expect(profile.narrationConstraints.forbiddenPatterns).toContain('不要导游腔');
  });
});
