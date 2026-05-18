import { spawn } from 'node:child_process';
import type { IAgentPacket } from '../../protocol/schema.js';
import { MlClient } from '../media/ml-client.js';
import { getAgentPrompt } from './prompt-registry.js';
import type { TAgentPromptId } from './prompt-registry.js';
import {
  buildSpanMaterialPatternsMlPrompt,
  CSPAN_MATERIAL_PATTERN_MAX_TOKENS,
} from './span-material-pattern-spec.js';

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

export interface ICommandJsonPacketAgentRunnerConfig {
  command: string;
  args?: string[];
  cwd?: string;
}

export class AgentRunnerUnavailableError extends Error {
  constructor(message = 'formal stage execution requires a host packet runner; external llm fallback is disabled') {
    super(message);
    this.name = 'AgentRunnerUnavailableError';
  }
}

export interface IAgentHandoffDetails {
  promptId: TAgentPromptId;
  packetPath: string;
  handoffPath?: string;
  handoffMode?: 'single' | 'sharded';
  shardBy?: string;
  shardCount?: number;
  stage: string;
  action?: string;
  editId?: string;
  capabilityId?: string;
  stepId?: string;
}

export class AgentHandoffRequiredError extends Error {
  constructor(
    public readonly details: IAgentHandoffDetails,
    message = `agent handoff required: ${details.stage} packet is ready at ${details.packetPath}`,
  ) {
    super(message);
    this.name = 'AgentHandoffRequiredError';
  }
}

export class CommandJsonPacketAgentRunner implements IJsonPacketAgentRunner {
  constructor(private readonly config: ICommandJsonPacketAgentRunnerConfig) {}

  async run<T>(input: IJsonPacketAgentInvocation): Promise<T> {
    const request = JSON.stringify({
      promptId: input.promptId,
      packet: input.packet,
      llm: input.llm ?? {},
    });

    const stdout = await new Promise<string>((resolve, reject) => {
      const child = spawn(
        this.config.command,
        this.config.args ?? [],
        {
          cwd: this.config.cwd,
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        },
      );
      let output = '';
      let errorOutput = '';

      child.stdout.setEncoding('utf-8');
      child.stdout.on('data', chunk => {
        output += chunk;
      });

      child.stderr.setEncoding('utf-8');
      child.stderr.on('data', chunk => {
        errorOutput += chunk;
      });

      child.on('error', error => {
        reject(error);
      });

      child.on('close', code => {
        if (code !== 0) {
          reject(new Error(
            `packet runner exited with code ${code}: ${(errorOutput || output).trim() || 'no output'}`,
          ));
          return;
        }
        if (!output.trim()) {
          reject(new Error('packet runner returned empty stdout'));
          return;
        }
        resolve(output.trim());
      });

      child.stdin.end(request);
    });

    try {
      return JSON.parse(stdout) as T;
    } catch (error) {
      throw new Error(
        `packet runner returned invalid JSON: ${error instanceof Error ? error.message : 'unknown parse error'}`,
      );
    }
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
  commandRunner?: ICommandJsonPacketAgentRunnerConfig | null;
  mlClient?: MlClient;
}): IJsonPacketAgentRunner {
  if (input.agentRunner) {
    return input.agentRunner;
  }
  if (input.commandRunner?.command?.trim()) {
    return new CommandJsonPacketAgentRunner(input.commandRunner);
  }
  if (input.mlClient) {
    return new MlJsonPacketAgentRunner(input.mlClient);
  }
  throw new AgentRunnerUnavailableError();
}

export function buildCommandJsonPacketAgentRunnerConfig(input: {
  agentPacketRunnerCommand?: string;
  agentPacketRunnerArgs?: string[];
  agentPacketRunnerCwd?: string;
}): ICommandJsonPacketAgentRunnerConfig | null {
  const command = input.agentPacketRunnerCommand?.trim();
  if (!command) {
    return null;
  }
  return {
    command,
    args: (input.agentPacketRunnerArgs ?? []).map(arg => arg.trim()).filter(Boolean),
    cwd: input.agentPacketRunnerCwd?.trim() || undefined,
  };
}

function buildMlPacketPrompt(input: IJsonPacketAgentInvocation): string {
  if (input.promptId === 'media/span-material-patterns') {
    return buildSpanMaterialPatternsMlPrompt(input.packet);
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
