import { randomUUID } from 'node:crypto';
import type { IKtepSubtitle, IKtepScript, IKtepClip, IKtepScriptBeat, IKtepSlice } from '../../protocol/schema.js';
import {
  buildNarrationBeatPlan,
  buildSourceSpeechContext,
  sanitizeSubtitleCueText,
  shouldPreferSourceSpeech,
  type ISpeechPacingConfig,
} from './pacing.js';

export interface ISubtitleConfig extends ISpeechPacingConfig {
  language: string;
}

const CDEFAULTS: ISubtitleConfig = {
  maxCharsPerCue: 20,
  cjkCharsPerSecond: 3.8,
  latinWordsPerSecond: 2.8,
  digitGroupsPerSecond: 2.4,
  shortPauseMs: 180,
  longPauseMs: 320,
  minCueDurationMs: 1100,
  language: 'zh',
};

/**
 * 字幕默认直接来自 beat.text。
 * 仅当脚本仍是旧结构、没有 beats 时，才回退到从整段 narration 推导伪 beat。
 */
export function planSubtitles(
  script: IKtepScript[],
  clips: IKtepClip[],
  slices: IKtepSlice[],
  config: Partial<ISubtitleConfig> = {},
): IKtepSubtitle[] {
  const cfg = { ...CDEFAULTS, ...config };
  const subtitles: IKtepSubtitle[] = [];
  const sliceMap = new Map(slices.map(slice => [slice.id, slice]));

  for (const seg of script) {
    const segClips = clips.filter(c => c.linkedScriptSegmentId === seg.id);
    if (segClips.length === 0) continue;

    const beats = resolveSubtitleBeats(seg, segClips);
    for (const beat of beats) {
      const beatClips = segClips
        .filter(clip => clip.linkedScriptBeatId === beat.id)
        .sort((a, b) => a.timelineInMs - b.timelineInMs);
      if (beatClips.length === 0) continue;

      const sourceSpeechSubtitles = planSourceSpeechSubtitles(seg, beat, beatClips, sliceMap, cfg);
      if (sourceSpeechSubtitles.length > 0) {
        subtitles.push(...sourceSpeechSubtitles);
        continue;
      }

      subtitles.push(...planNarrationSubtitles(seg, beat, beatClips, cfg));
    }
  }

  return subtitles;
}

function planNarrationSubtitles(
  segment: IKtepScript,
  beat: IKtepScriptBeat,
  beatClips: IKtepClip[],
  config: ISubtitleConfig,
): IKtepSubtitle[] {
  const windows = flattenBeatWindows(beatClips);
  if (windows.length === 0) return [];

  const totalDuration = windows.reduce((sum, window) => sum + (window.endMs - window.startMs), 0);
  if (totalDuration <= 0) return [];

  const narrationPlan = buildNarrationBeatPlan(beat, config);
  const subtitles: IKtepSubtitle[] = [];

  for (const utterance of narrationPlan.utterances) {
    if (utterance.startOffsetMs >= totalDuration) break;

    let cursor = utterance.startOffsetMs;
    for (const cue of utterance.cuePlans) {
      if (cursor >= totalDuration) break;

      const text = sanitizeSubtitleCueText(cue.text);
      if (!text) continue;

      const startMs = locateTimelineOffset(windows, cursor);
      cursor = Math.min(cursor + cue.durationMs, totalDuration);
      const endMs = locateTimelineOffset(windows, cursor);

      subtitles.push({
        id: randomUUID(),
        startMs,
        endMs: Math.max(endMs, startMs + 1),
        text,
        language: config.language,
        linkedScriptSegmentId: segment.id,
        linkedScriptBeatId: beat.id,
      });
    }
  }

  return subtitles;
}

function planSourceSpeechSubtitles(
  segment: IKtepScript,
  beat: IKtepScriptBeat,
  beatClips: IKtepClip[],
  sliceMap: Map<string, IKtepSlice>,
  config: ISubtitleConfig,
): IKtepSubtitle[] {
  const speechContext = buildSourceSpeechContext(beatClips, sliceMap);
  if (!shouldPreferSourceSpeech(segment, beat, speechContext)) return [];

  const subtitles: IKtepSubtitle[] = [];
  for (const clip of beatClips) {
    const slice = clip.sliceId ? sliceMap.get(clip.sliceId) : undefined;
    const transcriptSegments = slice?.transcriptSegments ?? [];
    if (transcriptSegments.length === 0) continue;

    const sourceInMs = clip.sourceInMs;
    const sourceOutMs = clip.sourceOutMs;
    if (typeof sourceInMs !== 'number' || typeof sourceOutMs !== 'number' || sourceOutMs <= sourceInMs) {
      continue;
    }

    for (const segmentText of transcriptSegments) {
      const overlapStart = Math.max(sourceInMs, segmentText.startMs);
      const overlapEnd = Math.min(sourceOutMs, segmentText.endMs);
      if (overlapEnd <= overlapStart) continue;

      const rawText = sanitizeSubtitleCueText(segmentText.text);
      if (!rawText) continue;

      const cueTexts = splitCueChunks(rawText, config.maxCharsPerCue);
      const totalDuration = overlapEnd - overlapStart;
      let cursor = 0;

      for (let index = 0; index < cueTexts.length; index++) {
        const text = sanitizeSubtitleCueText(cueTexts[index]);
        if (!text) continue;

        const remaining = cueTexts.length - index;
        const chunkDuration = remaining === 1
          ? totalDuration - cursor
          : Math.max(1, Math.round(totalDuration / cueTexts.length));
        const chunkStart = overlapStart + cursor;
        cursor += chunkDuration;
        const chunkEnd = Math.min(overlapEnd, overlapStart + cursor);

        subtitles.push({
          id: randomUUID(),
          startMs: clip.timelineInMs + (chunkStart - sourceInMs),
          endMs: Math.max(
            clip.timelineInMs + (chunkEnd - sourceInMs),
            clip.timelineInMs + (chunkStart - sourceInMs) + 1,
          ),
          text,
          language: config.language,
          linkedScriptSegmentId: segment.id,
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

function splitWithDelimiters(text: string, delimiter: RegExp): string[] {
  const parts = text.split(delimiter);
  const result: string[] = [];

  for (let index = 0; index < parts.length; index += 2) {
    const body = parts[index] ?? '';
    const tail = parts[index + 1] ?? '';
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
