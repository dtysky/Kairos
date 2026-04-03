import { describe, expect, it } from 'vitest';
import type { ILlmClient, ILlmMessage, ILlmOptions } from '../../src/modules/llm/client.js';
import { analyzeStyleFromReports } from '../../src/modules/script/style-analyzer.js';

class FakeLlm implements ILlmClient {
  messages: ILlmMessage[] = [];

  constructor(private response: string) {}

  async chat(messages: ILlmMessage[], _opts?: ILlmOptions): Promise<string> {
    this.messages = messages;
    return this.response;
  }
}

describe('style-analyzer rhythm grammar', () => {
  it('asks for material-grammar rhythm cues and feeds enriched report evidence to the LLM', async () => {
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
        '照片使用策略': '少量点缀，用于回望或停顿。',
        '照片编排方式': '常与运动镜头交替，避免连续堆叠。',
        '延时使用关系': '多用于建场之后的节奏切换。',
        '航拍插入时机': '开场建场或地理重置时进入。',
        '空镜/B-roll 关系': '承担呼吸与空间建立，不直接解释文本。',
        '节奏抬升触发点': '进入内心独白高潮时明显加速。',
      },
    }));

    const profile = await analyzeStyleFromReports(llm, [{
      sourceFile: 'reference-1.mp4',
      transcript: '我们重新回到海边。',
      rhythm: {
        shotCount: 20,
        cutsPerMinute: 8,
        shotDurationMs: {
          min: 800,
          max: 10_000,
          median: 2_000,
          mean: 3_200,
        },
        introRhythm: 5,
        bodyRhythm: 8,
        outroRhythm: 11,
      },
      shotRecognitions: [
        {
          shotId: 'shot-aerial',
          startMs: 1_000,
          endMs: 3_000,
          framePaths: [],
          recognition: {
            sceneType: 'aerial',
            subjects: ['coastline'],
            mood: 'calm',
            placeHints: [],
            narrativeRole: 'establishing',
            description: 'An aerial establishing view of the coast.',
            evidence: [],
          },
        },
        {
          shotId: 'shot-timelapse',
          startMs: 21_000,
          endMs: 24_000,
          framePaths: [],
          recognition: {
            sceneType: 'cityscape',
            subjects: ['traffic', 'light trails'],
            mood: 'dramatic',
            placeHints: [],
            narrativeRole: 'transition',
            description: 'A time-lapse of city traffic with bright light trails.',
            evidence: [],
          },
        },
        {
          shotId: 'shot-photo',
          startMs: 41_000,
          endMs: 43_000,
          framePaths: [],
          recognition: {
            sceneType: 'interior',
            subjects: ['printed photo'],
            mood: 'melancholic',
            placeHints: [],
            narrativeRole: 'detail',
            description: 'A still photo lying on a desk.',
            evidence: [],
          },
        },
      ],
    }]);

    expect(llm.messages[0]?.content).toMatch(/剪辑节奏与素材编排/u);
    expect(llm.messages[0]?.content).toMatch(/照片使用策略/u);
    expect(llm.messages[0]?.content).toMatch(/航拍插入时机/u);

    expect(llm.messages[1]?.content).toMatch(/素材编排线索/u);
    expect(llm.messages[1]?.content).toMatch(/aerialShots:/u);
    expect(llm.messages[1]?.content).toMatch(/timelapseCandidates:/u);
    expect(llm.messages[1]?.content).toMatch(/stillPhotoLikeCandidates:/u);

    expect(profile.parameters?.['照片编排方式']).toBe('常与运动镜头交替，避免连续堆叠。');
    expect(profile.sections?.some(section => section.title.includes('节奏'))).toBe(true);
    expect(profile.sections?.find(section => section.title.includes('节奏'))?.content)
      .toMatch(/照片素材/u);
  });

  it('backfills the rhythm material contract when the llm omits it', async () => {
    const llm = new FakeLlm(JSON.stringify({
      narrative: {
        pacePattern: '均匀推进',
      },
      voice: {
        person: '1st',
        tone: '平实',
        density: 'moderate',
        sampleTexts: [],
      },
      sections: [
        { title: '叙事结构', content: '线性展开。' },
      ],
      parameters: {},
    }));

    const profile = await analyzeStyleFromReports(llm, [{
      sourceFile: 'reference-2.mp4',
      transcript: '沿着公路继续走。',
    }]);

    expect(profile.parameters?.['照片使用策略']).toBe('未明确');
    expect(profile.parameters?.['延时使用关系']).toBe('未明确');
    const rhythmSection = profile.sections?.find(section => section.title.includes('节奏'));
    expect(rhythmSection?.content).toMatch(/素材编排语法/u);
    expect(rhythmSection?.content).toMatch(/航拍插入时机/u);
  });
});
