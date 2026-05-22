import type { IAgentPacket } from '../../protocol/schema.js';
import { MlClient } from '../media/ml-client.js';
import { getAgentPrompt } from './prompt-registry.js';
import type { TAgentPromptId } from './prompt-registry.js';
import {
  buildSpanMaterialPatternsMlPrompt,
  CSPAN_MATERIAL_PATTERN_MAX_TOKENS,
} from './span-material-pattern-spec.js';
import {
  buildSpanMaterializationReviewMlPrompt,
  CSPAN_MATERIALIZATION_REVIEW_MAX_TOKENS,
} from './span-materialization-review-spec.js';

export interface IAgentModelOptions {
  jsonMode?: boolean;
  temperature?: number;
  maxTokens?: number;
}

export interface IJsonPacketAgentInvocation {
  promptId: TAgentPromptId;
  packet: IAgentPacket;
  llm?: IAgentModelOptions;
}

export interface IJsonPacketAgentRunner {
  run<T>(input: IJsonPacketAgentInvocation): Promise<T>;
}

export class AgentRunnerUnavailableError extends Error {
  constructor(message = 'formal agent execution requires a direct Agent runner') {
    super(message);
    this.name = 'AgentRunnerUnavailableError';
  }
}

export class MlJsonPacketAgentRunner implements IJsonPacketAgentRunner {
  constructor(private readonly client: MlClient) {}

  async run<T>(input: IJsonPacketAgentInvocation): Promise<T> {
    const prompt = buildMlPacketPrompt(input);
    const response = await this.client.textGenerate(prompt, {
      keepOtherModelsLoaded: false,
      maxTokens: input.llm?.maxTokens ?? (
        input.promptId === 'media/span-material-patterns'
          ? CSPAN_MATERIAL_PATTERN_MAX_TOKENS
          : input.promptId === 'media/span-materialization-review'
            ? CSPAN_MATERIALIZATION_REVIEW_MAX_TOKENS
          : 2048
      ),
    });
    return parseJsonValue<T>(response.text, 'local text LM');
  }
}

export function isJsonPacketAgentRunner(value: unknown): value is IJsonPacketAgentRunner {
  return typeof value === 'object'
    && value != null
    && typeof (value as IJsonPacketAgentRunner).run === 'function';
}

export function resolveJsonPacketAgentRunner(input: {
  agentRunner?: IJsonPacketAgentRunner;
  mlClient?: MlClient;
}): IJsonPacketAgentRunner {
  if (input.agentRunner) {
    return input.agentRunner;
  }
  if (input.mlClient) {
    return new MlJsonPacketAgentRunner(input.mlClient);
  }
  throw new AgentRunnerUnavailableError();
}

function buildMlPacketPrompt(input: IJsonPacketAgentInvocation): string {
  if (input.promptId === 'media/span-material-patterns') {
    return buildSpanMaterialPatternsMlPrompt(input.packet);
  }
  if (input.promptId === 'media/span-materialization-review') {
    return buildSpanMaterializationReviewMlPrompt(input.packet);
  }
  return [
    getAgentPrompt(input.promptId),
    '下面是本次 stage packet。你只能使用 packet 里的内容。',
    JSON.stringify(input.packet, null, 2),
    input.llm?.jsonMode === false
      ? '请返回任务要求的内容。'
      : '请严格返回一个 JSON 对象，不要 Markdown 代码块，不要解释文字。',
  ].join('\n\n');
}

function parseJsonValue<T>(raw: string, source: string): T {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) {
    throw new Error(`${source} returned empty output`);
  }
  const unfenced = trimmed
    .replace(/^```(?:json)?\s*/iu, '')
    .replace(/\s*```$/u, '')
    .trim();
  const objectStart = unfenced.indexOf('{');
  const arrayStart = unfenced.indexOf('[');
  const starts = [objectStart, arrayStart].filter(index => index >= 0);
  const start = starts.length > 0 ? Math.min(...starts) : -1;
  const open = start >= 0 ? unfenced[start] : '';
  const close = open === '[' ? ']' : '}';
  const end = start >= 0 ? unfenced.lastIndexOf(close) : -1;
  const jsonText = start >= 0 && end >= start
    ? unfenced.slice(start, end + 1)
    : unfenced;
  try {
    return JSON.parse(jsonText) as T;
  } catch (error) {
    const snippet = jsonText.length > 500 ? `${jsonText.slice(0, 500)}...` : jsonText;
    throw new Error(
      `${source} returned invalid JSON: ${error instanceof Error ? error.message : 'unknown parse error'}; output=${snippet}`,
    );
  }
}
