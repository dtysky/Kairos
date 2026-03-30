import { randomUUID } from 'node:crypto';
import type { IKtepSubtitle, IKtepScript, IKtepClip, IKtepScriptBeat } from '../../protocol/schema.js';

export interface ISubtitleConfig {
  maxCharsPerCue: number;
  language: string;
}

const CDEFAULTS: ISubtitleConfig = {
  maxCharsPerCue: 20,
  language: 'zh',
};

/**
 * 字幕默认直接来自 beat.text。
 * 仅当脚本仍是旧结构、没有 beats 时，才回退到从整段 narration 推导伪 beat。
 */
export function planSubtitles(
  script: IKtepScript[],
  clips: IKtepClip[],
  config: Partial<ISubtitleConfig> = {},
): IKtepSubtitle[] {
  const cfg = { ...CDEFAULTS, ...config };
  const subtitles: IKtepSubtitle[] = [];

  for (const seg of script) {
    const segClips = clips.filter(c => c.linkedScriptSegmentId === seg.id);
    if (segClips.length === 0) continue;

    const beats = resolveSubtitleBeats(seg, segClips);
    for (const beat of beats) {
      const beatText = beat.text.trim();
      if (!beatText) continue;

      const beatClips = segClips
        .filter(clip => clip.linkedScriptBeatId === beat.id)
        .sort((a, b) => a.timelineInMs - b.timelineInMs);
      if (beatClips.length === 0) continue;

      const cueTexts = splitCueChunks(beatText, cfg.maxCharsPerCue);
      const windows = flattenBeatWindows(beatClips);
      if (windows.length === 0) continue;

      const totalDuration = windows.reduce((sum, window) => sum + (window.endMs - window.startMs), 0);
      let cursor = 0;

      for (let i = 0; i < cueTexts.length; i++) {
        const text = sanitizeSubtitleCueText(cueTexts[i]);
        if (!text) continue;
        const remainingTexts = cueTexts.length - i;
        const remainingDuration = totalDuration - cursor;
        const cueDuration = remainingTexts === 1
          ? remainingDuration
          : Math.max(1, Math.round(totalDuration / cueTexts.length));

        const startMs = locateTimelineOffset(windows, cursor);
        cursor += cueDuration;
        const endMs = locateTimelineOffset(windows, Math.min(cursor, totalDuration));

        subtitles.push({
          id: randomUUID(),
          startMs,
          endMs: Math.max(endMs, startMs + 1),
          text,
          language: cfg.language,
          linkedScriptSegmentId: seg.id,
          linkedScriptBeatId: beat.id,
        });
      }
    }
  }

  return subtitles;
}

function resolveSubtitleBeats(
  segment: IKtepScript,
  segClips: IKtepClip[],
): IKtepScriptBeat[] {
  if (segment.beats && segment.beats.length > 0) {
    return segment.beats;
  }

  const narration = segment.narration?.trim();
  if (!narration) return [];

  const orderedClips = [...segClips].sort((a, b) => a.timelineInMs - b.timelineInMs);
  const beatTexts = splitNarrationIntoBeats(narration, orderedClips.length);

  return orderedClips.map((clip, index) => ({
    id: `legacy-beat-${segment.id}-${index + 1}`,
    text: beatTexts[index] ?? '',
    selections: [],
    linkedSliceIds: clip.sliceId ? [clip.sliceId] : [],
  }));
}

function flattenBeatWindows(clips: IKtepClip[]): Array<{ startMs: number; endMs: number }> {
  return clips
    .map(clip => ({ startMs: clip.timelineInMs, endMs: clip.timelineOutMs }))
    .filter(window => window.endMs > window.startMs);
}

function locateTimelineOffset(
  windows: Array<{ startMs: number; endMs: number }>,
  offsetMs: number,
): number {
  let cursor = 0;
  for (const window of windows) {
    const dur = window.endMs - window.startMs;
    if (offsetMs <= cursor + dur) {
      return window.startMs + (offsetMs - cursor);
    }
    cursor += dur;
  }
  return windows[windows.length - 1]?.endMs ?? 0;
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

function sanitizeSubtitleCueText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return '';
  if (/—{2,}$/.test(trimmed)) return trimmed;

  return trimmed
    .replace(/([。！？!?；;，,：:、……\.]+)([」』”’）】〉》]*)$/u, '$2')
    .trim();
}
