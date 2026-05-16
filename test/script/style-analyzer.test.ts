import { describe, expect, it } from 'vitest';
import type { IJsonPacketAgentInvocation, IJsonPacketAgentRunner } from '../../src/modules/agents/runtime.js';
import { analyzeStyleFromReports } from '../../src/modules/script/style-analyzer.js';

class FakeAgentRunner implements IJsonPacketAgentRunner {
  calls: IJsonPacketAgentInvocation[] = [];

  constructor(private readonly draft: unknown) {}

  async run<T>(input: IJsonPacketAgentInvocation): Promise<T> {
    this.calls.push(input);
    if (input.promptId === 'style/style-profile-reviewer') {
      return {
        verdict: 'pass',
        issues: [],
        revisionBrief: [],
      } as T;
    }
    return this.draft as T;
  }
}

describe('analyzeStyleFromReports', () => {
  it('derives arrangement structure and narration constraints from llm output', async () => {
    const agentRunner = new FakeAgentRunner({
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
      layers: {
        literary: {
          summary: '第一人称贴身观察，冷静克制，少解释多留白。',
          confidence: 'high',
          evidenceNotes: ['旁白以自我观察推进。'],
          parameters: { voice: '第一人称贴身观察' },
          antiPatterns: ['不要导游腔'],
        },
        artistic: {
          summary: '从空间进入，再转向自我，审美上保持克制。',
          confidence: 'moderate',
          evidenceNotes: ['海边空间作为情绪入口。'],
          parameters: { mood: '克制' },
          antiPatterns: [],
        },
        editingTechnical: {
          summary: '前段克制，中段推进，尾段抬升；空镜承担呼吸与空间建立。',
          confidence: 'high',
          evidenceNotes: ['节奏抬升触发点明确。'],
          parameters: { pace: '前段克制，中段推进，尾段抬升' },
          antiPatterns: [],
        },
      },
    });

    const profile = await analyzeStyleFromReports(agentRunner, [{
      sourceFile: 'reference-1.mp4',
      transcript: '我们重新回到海边。',
    }]);

    expect(agentRunner.calls[0]?.promptId).toBe('style/style-profile-synthesizer');
    expect(agentRunner.calls[0]?.packet.inputArtifacts[0]?.content).toHaveProperty('agentInputReports');
    expect(agentRunner.calls[0]?.packet.hardConstraints.join('\n')).toContain('风格生成法则');
    expect(agentRunner.calls[0]?.packet.hardConstraints.join('\n')).toContain('文学风格必须重点分析旁白写法');
    expect(agentRunner.calls[0]?.packet.hardConstraints.join('\n')).toContain('艺术风格必须抽象到审美母题');
    expect(agentRunner.calls[1]?.promptId).toBe('style/style-profile-reviewer');
    expect(agentRunner.calls[1]?.packet.reviewRubric).toContain('sample_recap_instead_of_style');
    expect(agentRunner.calls[1]?.packet.reviewRubric).toContain('literary_mechanics_missing');
    expect(agentRunner.calls[1]?.packet.reviewRubric).toContain('artistic_abstraction_missing');
    expect(agentRunner.calls[1]?.packet.hardConstraints.join('\n')).toContain('复述样本内容');
    expect(profile.arrangementStructure.primaryAxis).toBe('路线推进');
    expect(profile.arrangementStructure.chapterPrograms[0]?.type).toBe('opening');
    expect(profile.narrationConstraints.perspective).toBe('第一人称贴身观察');
    expect(profile.narrationConstraints.forbiddenPatterns).toContain('不要导游腔');
    expect(profile.styleProfileVersion).toBe('layered-v1');
    expect(profile.layers?.literary.summary).toMatch(/冷静克制/u);
    expect(profile.layers?.editingTechnical.summary).toMatch(/前段克制/u);
  });
});
