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

    const orderedClips = [...segClips].sort((a, b) => a.timelineInMs - b.timelineInMs);
    const beatTexts = splitNarrationIntoBeats(seg.narration, orderedClips.length);

    for (let clipIndex = 0; clipIndex < orderedClips.length; clipIndex++) {
      const clip = orderedClips[clipIndex];
      const beatText = beatTexts[clipIndex]?.trim();
      if (!beatText) continue;
      const bucket = splitCueChunks(beatText, cfg.maxCharsPerCue);

      const clipDur = clip.timelineOutMs - clip.timelineInMs;
      const chunkDur = clipDur / bucket.length;

      for (let i = 0; i < bucket.length; i++) {
        subtitles.push({
          id: randomUUID(),
          startMs: Math.round(clip.timelineInMs + i * chunkDur),
          endMs: Math.round(clip.timelineInMs + (i + 1) * chunkDur),
          text: bucket[i],
          language: cfg.language,
          linkedScriptSegmentId: seg.id,
        });
      }
    }
  }

  return subtitles;
}

function splitCueChunks(text: string, maxChars: number): string[] {
  const strongUnits = splitWithDelimiters(text, /([。！？!?；;])/);
  const chunks: string[] = [];

  for (const unit of strongUnits) {
    const normalized = unit.trim();
    if (!normalized) continue;

    if (normalized.length <= maxChars) {
      chunks.push(normalized);
      continue;
    }

    const weakUnits = splitWithDelimiters(normalized, /([，,])/);
    let buffer = '';

    for (const weak of weakUnits) {
      const part = weak.trim();
      if (!part) continue;

      if (buffer.length > 0 && buffer.length + part.length > maxChars) {
        chunks.push(buffer.trim());
        buffer = part;
      } else {
        buffer += part;
      }
    }

    if (buffer.trim()) {
      chunks.push(buffer.trim());
    }
  }

  return rebalanceShortChunks(chunks, maxChars);
}

function splitNarrationIntoBeats(text: string, beatCount: number): string[] {
  if (beatCount <= 1) return [text.trim()];

  let units = splitWithDelimiters(text, /([。！？!?])/);
  if (units.length < beatCount) {
    units = splitWithDelimiters(text, /([。！？!?，,])/);
  }
  if (units.length === 0) return Array.from({ length: beatCount }, () => '');
  if (units.length <= beatCount) {
    const padded = [...units.map(unit => unit.trim())];
    while (padded.length < beatCount) padded.push('');
    return padded;
  }

  const totalLength = units.reduce((sum, unit) => sum + unit.trim().length, 0);
  const targetPerBeat = Math.max(1, Math.ceil(totalLength / beatCount));
  const beats: string[] = [];
  let buffer = '';
  let remainingBeats = beatCount;

  for (let index = 0; index < units.length; index++) {
    const unit = units[index].trim();
    if (!unit) continue;

    const remainingUnits = units.length - index;
    const shouldFlush =
      buffer.length > 0
      && (
        buffer.length + unit.length > targetPerBeat
        || remainingUnits <= remainingBeats
      );

    if (shouldFlush) {
      beats.push(buffer.trim());
      buffer = '';
      remainingBeats = beatCount - beats.length;
    }

    buffer += unit;
  }

  if (buffer.trim()) {
    beats.push(buffer.trim());
  }

  while (beats.length < beatCount) {
    beats.push('');
  }

  if (beats.length > beatCount) {
    const merged = beats.slice(0, beatCount - 1);
    merged.push(beats.slice(beatCount - 1).join(''));
    return merged;
  }

  return beats;
}

function splitWithDelimiters(text: string, delimiter: RegExp): string[] {
  const parts = text.split(delimiter);
  const result: string[] = [];

  for (let i = 0; i < parts.length; i += 2) {
    const body = parts[i] ?? '';
    const tail = parts[i + 1] ?? '';
    const combined = `${body}${tail}`.trim();
    if (combined) {
      result.push(combined);
    }
  }

  return result;
}

function rebalanceShortChunks(chunks: string[], maxChars: number): string[] {
  if (chunks.length <= 1) return chunks;

  const result: string[] = [];
  for (const chunk of chunks) {
    const current = chunk.trim();
    if (!current) continue;

    const previous = result[result.length - 1];
    if (
      previous
      && current.length <= 6
      && previous.length + current.length <= maxChars + 4
    ) {
      result[result.length - 1] = `${previous}${current}`;
      continue;
    }

    result.push(current);
  }

  return result;
}
