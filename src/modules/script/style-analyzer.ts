import type { IStyleProfile } from '../../protocol/schema.js';
import type { ILlmClient } from '../llm/client.js';
import { randomUUID } from 'node:crypto';

const CPROMPT = `你是一个视频风格分析专家。根据以下成片的 ASR 转写文本，分析视频的叙事结构和旁白风格。
返回 JSON 格式：
{
  "narrative": {
    "introRatio": 0.0-1.0 (片头占比),
    "outroRatio": 0.0-1.0 (片尾占比),
    "avgSegmentDurationSec": number (平均段落时长秒),
    "brollFrequency": 0.0-1.0 (空镜/B-roll 频率),
    "pacePattern": "用中文描述整体节奏，如：缓起→中段密集→结尾回归平静"
  },
  "voice": {
    "person": "1st" | "2nd" | "3rd" (人称),
    "tone": "用中文描述语气风格",
    "density": "low" | "moderate" | "high" (旁白密度),
    "sampleTexts": ["2-3 句最能代表风格的原文"]
  }
}`;

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
  ], { jsonMode: true, temperature: 0.3 });

  const parsed = JSON.parse(raw);
  const now = new Date().toISOString();

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
    createdAt: now,
    updatedAt: now,
  };
}
