import { randomUUID } from 'node:crypto';
import type { IKtepScript, IStyleProfile } from '../../protocol/schema.js';
import type { ILlmClient } from '../llm/client.js';
import type { IOutlineSegment } from './outline-builder.js';

const CSYSTEM = `你是一个旅拍纪录片脚本创作者。根据给定的叙事骨架、风格档案和切片证据，为每个段落撰写旁白文案。

要求：
1. 严格遵循风格档案中的人称、语气、句式和情绪表达方式
2. 严格遵守风格禁区，禁区中列出的表达方式绝对不要使用
3. 旁白长度与段落时长匹配
4. 返回 JSON 数组，每个元素包含 id, role, title, narration, targetDurationMs, linkedSliceIds`;

export async function generateScript(
  llm: ILlmClient,
  outline: IOutlineSegment[],
  style: IStyleProfile,
): Promise<IKtepScript[]> {
  const styleText = buildStylePrompt(style);
  const outlineText = buildOutlinePrompt(outline);

  const raw = await llm.chat([
    { role: 'system', content: CSYSTEM },
    { role: 'user', content: `## 风格档案\n\n${styleText}\n\n## 叙事骨架\n\n${outlineText}` },
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

export function buildStylePrompt(style: IStyleProfile): string {
  // If rawReference exists, use it directly — it's the richest source
  if (style.rawReference) {
    const parts = [style.rawReference];
    if (style.antiPatterns?.length) {
      parts.push(`\n### 风格禁区（绝对不要使用）\n${style.antiPatterns.map((p, i) => `${i + 1}. ${p}`).join('\n')}`);
    }
    return parts.join('\n');
  }

  // Fallback: build from structured fields
  const parts: string[] = [
    `人称: ${style.voice.person === '1st' ? '第一人称' : style.voice.person === '2nd' ? '第二人称' : '第三人称'}`,
    `语气: ${style.voice.tone}`,
    `旁白密度: ${style.voice.density}`,
    `节奏: ${style.narrative.pacePattern}`,
  ];

  if (style.voice.sampleTexts.length > 0) {
    parts.push(`示例文案:\n${style.voice.sampleTexts.map(t => `  > ${t}`).join('\n')}`);
  }

  if (style.sections?.length) {
    for (const sec of style.sections) {
      parts.push(`\n### ${sec.title}\n${sec.content}`);
    }
  }

  if (style.antiPatterns?.length) {
    parts.push(`\n### 风格禁区（绝对不要使用）\n${style.antiPatterns.map((p, i) => `${i + 1}. ${p}`).join('\n')}`);
  }

  if (style.parameters && Object.keys(style.parameters).length > 0) {
    const paramLines = Object.entries(style.parameters)
      .map(([k, v]) => `- ${k}: ${v}`);
    parts.push(`\n### 关键参数\n${paramLines.join('\n')}`);
  }

  return parts.join('\n');
}

export function buildOutlinePrompt(outline: IOutlineSegment[]): string {
  return outline.map((seg, i) => {
    const evidenceStr = seg.evidence
      .slice(0, 10)
      .map(e => `[${e.source}] ${e.value}`)
      .join('; ');
    return `${i + 1}. [${seg.role}] ${seg.title} (${Math.round(seg.estimatedDurationMs / 1000)}s)\n   切片: ${seg.sliceIds.length} 个\n   证据: ${evidenceStr}`;
  }).join('\n');
}
