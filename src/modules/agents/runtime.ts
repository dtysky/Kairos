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
      temperature: input.llm?.temperature,
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
  const jsonText = extractJsonText(unfenced);
  try {
    return JSON.parse(jsonText) as T;
  } catch (error) {
    const snippet = jsonText.length > 500 ? `${jsonText.slice(0, 500)}...` : jsonText;
    throw new Error(
      `${source} returned invalid JSON: ${error instanceof Error ? error.message : 'unknown parse error'}; output=${snippet}`,
    );
  }
}

function extractJsonText(input: string): string {
  const objectStart = input.indexOf('{');
  const arrayStart = input.indexOf('[');
  const starts = [objectStart, arrayStart].filter(index => index >= 0);
  const start = starts.length > 0 ? Math.min(...starts) : -1;
  if (start < 0) return input;

  const scanned = scanFirstJsonValue(input, start);
  if (scanned.complete) return scanned.text;
  if (scanned.completedText) return scanned.completedText;

  const open = input[start];
  const close = open === '[' ? ']' : '}';
  const end = close ? input.lastIndexOf(close) : -1;
  return end >= start ? input.slice(start, end + 1) : input.slice(start);
}

function scanFirstJsonValue(
  input: string,
  start: number,
): { complete: true; text: string } | { complete: false; completedText?: string } {
  const stack: string[] = [];
  let inString = false;
  let escape = false;

  for (let index = start; index < input.length; index += 1) {
    const char = input[index]!;
    if (inString) {
      if (escape) {
        escape = false;
      } else if (char === '\\') {
        escape = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') {
      stack.push('}');
      continue;
    }
    if (char === '[') {
      stack.push(']');
      continue;
    }
    if (char !== '}' && char !== ']') {
      continue;
    }

    if (stack.length === 0) {
      return { complete: false };
    }
    const expected = stack.pop();
    if (char !== expected) {
      return { complete: false };
    }
    if (stack.length === 0) {
      return { complete: true, text: input.slice(start, index + 1) };
    }
  }

  if (inString || stack.length === 0) {
    return { complete: false };
  }

  return {
    complete: false,
    completedText: `${input.slice(start).trimEnd()}${[...stack].reverse().join('')}`,
  };
}
