import { randomUUID } from 'node:crypto';
import type { IKtepSubtitle, IKtepScript, IKtepClip, IKtepScriptBeat, IKtepSlice } from '../../protocol/schema.js';

export interface ISubtitleConfig {
  maxCharsPerCue: number;
  language: string;
}

interface ISourceSpeechContext {
  dominantSliceType?: IKtepSlice['type'];
  speechCoverage: number;
  transcriptSegmentCount: number;
  transcriptText: string;
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

      const beatText = beat.text.trim();
      if (!beatText) continue;

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

function shouldPreferSourceSpeech(
  segment: IKtepScript,
  beat: IKtepScriptBeat,
  speechContext: ISourceSpeechContext,
): boolean {
  if (beat.actions?.muteSource === true || segment.actions?.muteSource === true) {
    return false;
  }
  if (beat.actions?.preserveNatSound === true) return true;
  if (segment.actions?.preserveNatSound === true) return true;
  if (speechContext.transcriptSegmentCount === 0) return false;
  if (speechContext.speechCoverage < 0.18) return false;

  const beatText = normalizeComparisonText(beat.text);
  if (!beatText) return true;

  const transcriptText = normalizeComparisonText(speechContext.transcriptText);
  if (!transcriptText) return false;

  if (hasStrongTranscriptContainment(beatText, transcriptText)) {
    return true;
  }

  const matchScore = computeTranscriptMatchScore(beatText, transcriptText);
  if (beatText.length >= 6 && matchScore >= 0.6) return true;

  if (segment.role === 'intro' || segment.role === 'transition' || segment.role === 'outro') {
    return false;
  }

  if (speechContext.dominantSliceType === 'talking-head') {
    return speechContext.speechCoverage >= 0.42 && matchScore >= 0.18;
  }

  return speechContext.speechCoverage >= 0.72 && matchScore >= 0.3;
}

function buildSourceSpeechContext(
  beatClips: IKtepClip[],
  sliceMap: Map<string, IKtepSlice>,
): ISourceSpeechContext {
  const transcriptParts: string[] = [];
  const typeWeights = new Map<IKtepSlice['type'], number>();
  let transcriptSegmentCount = 0;
  let totalWindowMs = 0;
  let spokenWindowMs = 0;

  for (const clip of beatClips) {
    const slice = clip.sliceId ? sliceMap.get(clip.sliceId) : undefined;
    if (!slice) continue;

    const sourceInMs = clip.sourceInMs ?? slice.sourceInMs ?? 0;
    const sourceOutMs = clip.sourceOutMs ?? slice.sourceOutMs ?? sourceInMs;
    const windowDurationMs = Math.max(0, sourceOutMs - sourceInMs);

    if (windowDurationMs > 0) {
      totalWindowMs += windowDurationMs;
      typeWeights.set(slice.type, (typeWeights.get(slice.type) ?? 0) + windowDurationMs);
    }

    const transcriptSegments = slice.transcriptSegments ?? [];
    if (transcriptSegments.length === 0) continue;

    for (const transcriptSegment of transcriptSegments) {
      const overlapStart = Math.max(sourceInMs, transcriptSegment.startMs);
      const overlapEnd = Math.min(sourceOutMs, transcriptSegment.endMs);
      if (overlapEnd <= overlapStart) continue;

      const normalizedText = sanitizeSubtitleCueText(transcriptSegment.text);
      if (!normalizedText) continue;

      transcriptParts.push(normalizedText);
      transcriptSegmentCount += 1;
      spokenWindowMs += overlapEnd - overlapStart;
    }
  }

  let dominantSliceType: IKtepSlice['type'] | undefined;
  let dominantWeight = -1;
  for (const [sliceType, weight] of typeWeights.entries()) {
    if (weight > dominantWeight) {
      dominantSliceType = sliceType;
      dominantWeight = weight;
    }
  }

  return {
    dominantSliceType,
    speechCoverage: totalWindowMs > 0 ? Math.min(1, spokenWindowMs / totalWindowMs) : 0,
    transcriptSegmentCount,
    transcriptText: transcriptParts.join(' '),
  };
}

function computeTranscriptMatchScore(beatText: string, transcriptText: string): number {
  const beatTokens = tokenizeComparisonText(beatText);
  const transcriptTokens = tokenizeComparisonText(transcriptText);
  const tokenScore = computeDirectionalOverlap(beatTokens, transcriptTokens);

  const beatNgrams = buildCharacterNgrams(beatText);
  const transcriptNgrams = buildCharacterNgrams(transcriptText);
  const ngramScore = computeDirectionalOverlap(beatNgrams, transcriptNgrams);

  return Math.max(tokenScore, ngramScore);
}

function hasStrongTranscriptContainment(beatText: string, transcriptText: string): boolean {
  const shorterLength = Math.min(beatText.length, transcriptText.length);
  if (shorterLength < 6) return false;
  return transcriptText.includes(beatText) || beatText.includes(transcriptText);
}

function tokenizeComparisonText(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fa5]+/u)
    .map(token => token.trim())
    .filter(token => token.length >= 2);
}

function buildCharacterNgrams(text: string, size = 2): string[] {
  const normalized = text
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/gu, '');
  if (normalized.length === 0) return [];
  if (normalized.length <= size) return [normalized];

  const grams: string[] = [];
  for (let index = 0; index <= normalized.length - size; index++) {
    grams.push(normalized.slice(index, index + size));
  }
  return grams;
}

function computeDirectionalOverlap(source: string[], target: string[]): number {
  if (source.length === 0 || target.length === 0) return 0;

  const targetSet = new Set(target);
  const uniqueSource = Array.from(new Set(source));
  let hitCount = 0;

  for (const item of uniqueSource) {
    if (targetSet.has(item)) hitCount += 1;
  }

  return hitCount / uniqueSource.length;
}

function normalizeComparisonText(text: string | undefined): string {
  return (text ?? '')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .trim();
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
