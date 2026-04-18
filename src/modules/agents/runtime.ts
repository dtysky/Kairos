import { spawn } from 'node:child_process';
import type { IAgentPacket } from '../../protocol/schema.js';
import type { TAgentPromptId } from './prompt-registry.js';

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

export function isJsonPacketAgentRunner(value: unknown): value is IJsonPacketAgentRunner {
  return typeof value === 'object'
    && value != null
    && typeof (value as IJsonPacketAgentRunner).run === 'function';
}

export function resolveJsonPacketAgentRunner(input: {
  agentRunner?: IJsonPacketAgentRunner;
  commandRunner?: ICommandJsonPacketAgentRunnerConfig | null;
}): IJsonPacketAgentRunner {
  if (input.agentRunner) {
    return input.agentRunner;
  }
  if (input.commandRunner?.command?.trim()) {
    return new CommandJsonPacketAgentRunner(input.commandRunner);
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
