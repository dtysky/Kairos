import { randomUUID } from 'node:crypto';
import type { IKtepSubtitle, IKtepScript, IKtepClip } from '../../protocol/schema.js';

export interface ISubtitleConfig {
  maxCharsPerCue: number;
  language: string;
}

const CDEFAULTS: ISubtitleConfig = {
  maxCharsPerCue: 20,
  language: 'zh',
};

/**
 * 从脚本旁白生成字幕 cue。
 * 按标点/字数切分，时间均匀分布在段落对应的时间线范围内。
 */
export function planSubtitles(
  script: IKtepScript[],
  clips: IKtepClip[],
  config: Partial<ISubtitleConfig> = {},
): IKtepSubtitle[] {
  const cfg = { ...CDEFAULTS, ...config };
  const subtitles: IKtepSubtitle[] = [];

  for (const seg of script) {
    if (!seg.narration.trim()) continue;

    const segClips = clips.filter(c => c.linkedScriptSegmentId === seg.id);
    if (segClips.length === 0) continue;

    const segStart = Math.min(...segClips.map(c => c.timelineInMs));
    const segEnd = Math.max(...segClips.map(c => c.timelineOutMs));
    const segDur = segEnd - segStart;

    const chunks = splitNarration(seg.narration, cfg.maxCharsPerCue);
    const chunkDur = segDur / chunks.length;

    for (let i = 0; i < chunks.length; i++) {
      subtitles.push({
        id: randomUUID(),
        startMs: Math.round(segStart + i * chunkDur),
        endMs: Math.round(segStart + (i + 1) * chunkDur),
        text: chunks[i],
        language: cfg.language,
        linkedScriptSegmentId: seg.id,
      });
    }
  }

  return subtitles;
}

function splitNarration(text: string, maxChars: number): string[] {
  const sentences = text.split(/(?<=[。！？，；、\.\!\?\,\;])/);
  const chunks: string[] = [];
  let buffer = '';

  for (const s of sentences) {
    if (buffer.length + s.length > maxChars && buffer.length > 0) {
      chunks.push(buffer.trim());
      buffer = s;
    } else {
      buffer += s;
    }
  }
  if (buffer.trim()) chunks.push(buffer.trim());

  return chunks.length > 0 ? chunks : [text];
}
