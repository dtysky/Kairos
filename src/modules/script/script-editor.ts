import type { IKtepScript } from '../../protocol/schema.js';
import type { ILlmClient } from '../llm/client.js';

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
  llm: ILlmClient,
  segment: IKtepScript,
  instruction: string,
): Promise<string> {
  const raw = await llm.chat([
    {
      role: 'system',
      content: '你是旁白文案编辑。根据用户指令修改旁白。只返回修改后的旁白文本，不要解释。',
    },
    {
      role: 'user',
      content: `原文: ${segment.narration}\n\n修改指令: ${instruction}`,
    },
  ], { temperature: 0.5 });

  return raw.trim();
}
