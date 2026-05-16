import { describe, expect, it } from 'vitest';
import { MlJsonPacketAgentRunner } from '../../src/modules/agents/runtime.js';
import { CSPAN_MATERIAL_PATTERN_MAX_TOKENS } from '../../src/modules/agents/span-material-pattern-spec.js';
import type { MlClient } from '../../src/modules/media/ml-client.js';
import type { IAgentPacket } from '../../src/protocol/schema.js';

describe('MlJsonPacketAgentRunner', () => {
  it('parses ordered materialPatterns rows from a top-level JSON array', async () => {
    let capturedPrompt = '';
    let capturedOptions: Record<string, unknown> | undefined;
    const mlClient = {
      async textGenerate(prompt: string, options?: Record<string, unknown>) {
        capturedPrompt = prompt;
        capturedOptions = options;
        return {
          text: JSON.stringify([
            ['第一人称行车', '山路', '天气光线不明', '无口播语音'],
            ['手持自拍口播', '环境不明', '天气光线不明', '有口播语音'],
          ]),
        };
      },
    } as unknown as MlClient;
    const runner = new MlJsonPacketAgentRunner(mlClient);
    const packet: IAgentPacket = {
      stage: 'media/span-material-patterns',
      identity: 'span-material-patterns',
      mission: 'test',
      hardConstraints: [],
      allowedInputs: [],
      inputArtifacts: [{
        label: 'span-material-pattern-items',
        content: {
          attempt: 1,
          items: [
            { type: 'drive', visualObservation: '山路行车画面' },
            { type: 'talking-head', semanticKind: 'speech', transcript: '我们到了。' },
          ],
        },
      }],
      outputSchema: {},
      reviewRubric: [],
    };

    const result = await runner.run<string[][]>({
      promptId: 'media/span-material-patterns',
      packet,
      llm: { jsonMode: true },
    });

    expect(result).toEqual([
      ['第一人称行车', '山路', '天气光线不明', '无口播语音'],
      ['手持自拍口播', '环境不明', '天气光线不明', '有口播语音'],
    ]);
    expect(capturedOptions).toMatchObject({ maxTokens: CSPAN_MATERIAL_PATTERN_MAX_TOKENS });
    expect(capturedPrompt).toContain('顶层 JSON 数组');
    expect(capturedPrompt).toContain('每行是 4 到 6 个中文短标签');
    expect(capturedPrompt).not.toContain('"id"');
  });
});
