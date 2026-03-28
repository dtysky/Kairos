import { randomUUID } from 'node:crypto';
import type { IKtepScript, IStyleProfile } from '../../protocol/schema.js';
import type { ILlmClient } from '../llm/client.js';
import type { IOutlineSegment } from './outline-builder.js';

const CSYSTEM = `你是一个旅拍纪录片脚本创作者。根据给定的叙事骨架、风格档案和切片证据，为每个段落撰写旁白文案。
要求：
1. 严格按照风格档案的人称、语气和密度要求
2. 旁白长度与段落时长匹配
3. 返回 JSON 数组，每个元素包含 id, role, title, narration, targetDurationMs, linkedSliceIds`;

export async function generateScript(
  llm: ILlmClient,
  outline: IOutlineSegment[],
  style: IStyleProfile,
): Promise<IKtepScript[]> {
  const outlineText = outline.map((seg, i) => {
    const evidenceStr = seg.evidence
      .slice(0, 10)
      .map(e => `[${e.source}] ${e.value}`)
      .join('; ');
    return `${i + 1}. [${seg.role}] ${seg.title} (${Math.round(seg.estimatedDurationMs / 1000)}s)\n   切片: ${seg.sliceIds.length} 个\n   证据: ${evidenceStr}`;
  }).join('\n');

  const styleText = [
    `人称: ${style.voice.person}`,
    `语气: ${style.voice.tone}`,
    `密度: ${style.voice.density}`,
    `节奏: ${style.narrative.pacePattern}`,
    `示例: ${style.voice.sampleTexts.join(' | ')}`,
  ].join('\n');

  const raw = await llm.chat([
    { role: 'system', content: CSYSTEM },
    { role: 'user', content: `## 风格档案\n${styleText}\n\n## 叙事骨架\n${outlineText}` },
  ], { jsonMode: true, temperature: 0.7, maxTokens: 4000 });

  const parsed = JSON.parse(raw);
  const segments: IKtepScript[] = (Array.isArray(parsed) ? parsed : parsed.segments ?? [])
    .map((s: any, i: number) => ({
      id: s.id ?? randomUUID(),
      role: s.role ?? outline[i]?.role ?? 'scene',
      title: s.title ?? outline[i]?.title,
      narration: s.narration ?? '',
      targetDurationMs: s.targetDurationMs ?? outline[i]?.estimatedDurationMs,
      linkedSliceIds: s.linkedSliceIds ?? outline[i]?.sliceIds ?? [],
    }));

  return segments;
}
