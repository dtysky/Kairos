import type { IAgentPacket } from '../../protocol/schema.js';
import type { ILlmClient, ILlmOptions } from '../llm/client.js';
import { getAgentPrompt, type TAgentPromptId } from './prompt-registry.js';

export async function runJsonPacketAgent<T>(
  llm: ILlmClient,
  promptId: TAgentPromptId,
  packet: IAgentPacket,
  options?: {
    revisionBrief?: string[];
    previousDraft?: unknown;
    llm?: ILlmOptions;
  },
): Promise<T> {
  const raw = await llm.chat([
    { role: 'system', content: getAgentPrompt(promptId) },
    {
      role: 'user',
      content: JSON.stringify({
        packet,
        revisionBrief: options?.revisionBrief ?? [],
        previousDraft: options?.previousDraft,
      }, null, 2),
    },
  ], {
    jsonMode: true,
    temperature: 0.2,
    maxTokens: 4000,
    ...options?.llm,
  });

  return JSON.parse(raw) as T;
}
