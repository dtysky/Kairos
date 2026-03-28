import type { IStyleProfile } from '../../protocol/schema.js';
import type { ILlmClient } from '../llm/client.js';
import { randomUUID } from 'node:crypto';

const CPROMPT = `你是一个视频风格分析专家。根据以下成片的 ASR 转写文本，分析视频的叙事结构和旁白风格。
返回 JSON 格式：
{
  "narrative": {
    "introRatio": 0.0-1.0,
    "outroRatio": 0.0-1.0,
    "avgSegmentDurationSec": number,
    "brollFrequency": 0.0-1.0,
    "pacePattern": "用中文描述整体节奏"
  },
  "voice": {
    "person": "1st" | "2nd" | "3rd",
    "tone": "用中文描述语气风格",
    "density": "low" | "moderate" | "high",
    "sampleTexts": ["2-3 句最能代表风格的原文"]
  },
  "sections": [
    { "title": "章节名", "content": "该维度的详细分析" }
  ],
  "antiPatterns": ["应避免的表达方式，每条一个字符串"],
  "parameters": { "参数名": "参数值" }
}

请至少分析以下维度并放入 sections：
1. 叙事结构（段落组织方式、开头结尾惯例）
2. 语言风格（句式特征、用词偏好）
3. 情绪层次（情绪光谱、表达克制度）
4. 视觉语言（画面描写惯例、运镜/光线词汇）`;

export async function analyzeStyle(
  llm: ILlmClient,
  sourceFiles: string[],
  transcripts: string[],
): Promise<IStyleProfile> {
  const combined = transcripts
    .map((t, i) => `--- 成片 ${i + 1}: ${sourceFiles[i]} ---\n${t}`)
    .join('\n\n');

  const raw = await llm.chat([
    { role: 'system', content: CPROMPT },
    { role: 'user', content: combined },
  ], { jsonMode: true, temperature: 0.3, maxTokens: 4000 });

  const parsed = JSON.parse(raw);
  const now = new Date().toISOString();

  const sections = (parsed.sections ?? []).map((s: any, i: number) => ({
    id: `section-${i + 1}`,
    title: s.title ?? `分析 ${i + 1}`,
    content: s.content ?? '',
    tags: s.tags,
  }));

  return {
    id: randomUUID(),
    name: '自动分析风格',
    sourceFiles,
    narrative: {
      introRatio: parsed.narrative?.introRatio ?? 0.08,
      outroRatio: parsed.narrative?.outroRatio ?? 0.05,
      avgSegmentDurationSec: parsed.narrative?.avgSegmentDurationSec ?? 25,
      brollFrequency: parsed.narrative?.brollFrequency ?? 0.3,
      pacePattern: parsed.narrative?.pacePattern ?? '均匀',
    },
    voice: {
      person: parsed.voice?.person ?? '1st',
      tone: parsed.voice?.tone ?? '平实',
      density: parsed.voice?.density ?? 'moderate',
      sampleTexts: parsed.voice?.sampleTexts ?? [],
    },
    sections,
    antiPatterns: parsed.antiPatterns ?? [],
    parameters: parsed.parameters ?? {},
    createdAt: now,
    updatedAt: now,
  };
}
