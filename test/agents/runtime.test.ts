import { describe, expect, it } from 'vitest';
import { MlJsonPacketAgentRunner } from '../../src/modules/agents/runtime.js';
import { CSPAN_MATERIAL_PATTERN_MAX_TOKENS } from '../../src/modules/agents/span-material-pattern-spec.js';
import { CSPAN_MATERIALIZATION_REVIEW_MAX_TOKENS } from '../../src/modules/agents/span-materialization-review-spec.js';
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
            ['第一人称行车', '山路', '天气光线不明', '无口播语音', '山路连续推进', '连续弯道', '道路推进'],
            ['手持自拍口播', '环境不明', '天气光线不明', '有口播语音', '到达现场说明', '到达说明', '口播说明'],
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
      ['第一人称行车', '山路', '天气光线不明', '无口播语音', '山路连续推进', '连续弯道', '道路推进'],
      ['手持自拍口播', '环境不明', '天气光线不明', '有口播语音', '到达现场说明', '到达说明', '口播说明'],
    ]);
    expect(capturedOptions).toMatchObject({ maxTokens: CSPAN_MATERIAL_PATTERN_MAX_TOKENS });
    expect(capturedPrompt).toContain('顶层 JSON 数组');
    expect(capturedPrompt).toContain('每行必须正好 7 个中文短标签');
    expect(capturedPrompt).toContain('情景故事');
    expect(capturedPrompt).toContain('情景不明');
    expect(capturedPrompt).not.toContain('"id"');
  });

  it('builds the span-builder materialization prompt with pattern rows only', async () => {
    let capturedPrompt = '';
    let capturedOptions: Record<string, unknown> | undefined;
    const mlClient = {
      async textGenerate(prompt: string, options?: Record<string, unknown>) {
        capturedPrompt = prompt;
        capturedOptions = options;
        return {
          text: JSON.stringify([
            ['车内自拍口播', '车内', '下雨', '有口播语音', '雨天出发说明', '出发说明', '雨天行程'],
          ]),
        };
      },
    } as unknown as MlClient;
    const runner = new MlJsonPacketAgentRunner(mlClient);
    const packet: IAgentPacket = {
      stage: 'media/span-materialization-review',
      identity: 'span-materialization-patterns',
      mission: 'test',
      hardConstraints: [],
      allowedInputs: [],
      inputArtifacts: [{
        label: 'span-materialization-review-items',
        content: {
          attempt: 1,
          items: [{
            type: 'drive',
            semanticKind: 'speech',
            transcriptSegments: [
              { index: 1, startMs: 0, endMs: 1000, text: '录制开始' },
              { index: 2, startMs: 1200, endMs: 4000, text: '雨天出发' },
            ],
            visualObservation: '车内雨天行车画面',
          }],
        },
      }],
      outputSchema: {},
      reviewRubric: [],
    };

    const result = await runner.run<string[][]>({
      promptId: 'media/span-materialization-review',
      packet,
      llm: { jsonMode: true },
    });

    expect(result).toEqual([
      ['车内自拍口播', '车内', '下雨', '有口播语音', '雨天出发说明', '出发说明', '雨天行程'],
    ]);
    expect(capturedOptions).toMatchObject({ maxTokens: CSPAN_MATERIALIZATION_REVIEW_MAX_TOKENS });
    expect(capturedPrompt).not.toContain('keepSegmentIndexes');
    expect(capturedPrompt).not.toContain('keepVisualOnly');
    expect(capturedPrompt).toContain('只输出一行顶层 JSON 数组');
    expect(capturedPrompt).toContain('每行必须正好 7 个中文短标签');
    expect(capturedPrompt).toContain('不能决定 speech keep/drop');
  });
});
