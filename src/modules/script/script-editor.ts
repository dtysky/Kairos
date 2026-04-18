import type { IAgentPacket, IKtepScript } from '../../protocol/schema.js';
import type { IJsonPacketAgentRunner } from '../agents/runtime.js';

export function reorderSegments(
  segments: IKtepScript[],
  order: string[],
): IKtepScript[] {
  const map = new Map(segments.map(s => [s.id, s]));
  return order.map(id => {
    const seg = map.get(id);
    if (!seg) throw new Error(`Segment not found: ${id}`);
    return seg;
  });
}

export function updateNarration(
  segments: IKtepScript[],
  segmentId: string,
  narration: string,
): IKtepScript[] {
  return segments.map(s =>
    s.id === segmentId ? { ...s, narration } : s,
  );
}

export function removeSegment(
  segments: IKtepScript[],
  segmentId: string,
): IKtepScript[] {
  return segments.filter(s => s.id !== segmentId);
}

export function insertSegment(
  segments: IKtepScript[],
  afterId: string | null,
  segment: IKtepScript,
): IKtepScript[] {
  if (afterId === null) return [segment, ...segments];
  const idx = segments.findIndex(s => s.id === afterId);
  if (idx === -1) return [...segments, segment];
  const result = [...segments];
  result.splice(idx + 1, 0, segment);
  return result;
}

export async function rewriteNarration(
  agentRunner: IJsonPacketAgentRunner,
  segment: IKtepScript,
  instruction: string,
): Promise<string> {
  const packet: IAgentPacket = {
    stage: 'rewrite-narration',
    identity: 'narration-rewriter',
    mission: '只根据当前 segment 的 narration 和明确 instruction 改写旁白文本。',
    hardConstraints: [
      '不能改写 beat、selection、linked ids 或其他召回事实。',
      '不能引入 instruction 之外的新事实。',
      '只返回改写后的 narration。',
    ],
    allowedInputs: [
      'current script segment',
      'rewrite instruction',
    ],
    inputArtifacts: [
      {
        label: 'script-segment',
        summary: segment.title ?? segment.id,
        content: segment,
      },
      {
        label: 'rewrite-instruction',
        summary: instruction,
        content: { instruction },
      },
    ],
    outputSchema: {
      narration: 'string',
    },
    reviewRubric: [],
  };
  const raw = await agentRunner.run<unknown>({
    promptId: 'script/narration-rewriter',
    packet,
    llm: { temperature: 0.5, maxTokens: 1200 },
  });

  if (typeof raw === 'string' && raw.trim()) {
    return raw.trim();
  }
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const narration = (raw as { narration?: unknown }).narration;
    if (typeof narration === 'string' && narration.trim()) {
      return narration.trim();
    }
  }
  throw new Error('narration rewrite returned invalid JSON');
}
