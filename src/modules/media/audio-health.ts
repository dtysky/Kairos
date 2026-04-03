import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  IAudioHealthSummary,
  IProtectedAudioAssessment,
  IProtectionAudioBinding,
} from '../../protocol/schema.js';
import type { IMediaToolConfig } from './probe.js';
import { toExecutableInputPath } from './tool-path.js';

const exec = promisify(execFile);
const CMEAN_VOLUME_RE = /mean_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/iu;
const CMAX_VOLUME_RE = /max_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/iu;
const CSILENCE_DURATION_RE = /silence_duration:\s*(\d+(?:\.\d+)?)/giu;
const CLOW_LEVEL_DB = -30;
const CVERY_LOW_LEVEL_DB = -36;
const CCLIPPING_DB = -1;
const CHIGH_SILENCE_RATIO = 0.55;
const CWEAK_SPEECH_COVERAGE = 0.08;
const CPROTECTION_MARGIN = 0.15;

export interface IAudioHealthTelemetry {
  meanVolumeDb?: number;
  maxVolumeDb?: number;
  silenceRatio?: number;
}

export async function analyzeAudioHealth(
  localPath: string,
  durationMs: number | undefined,
  tools?: IMediaToolConfig,
): Promise<IAudioHealthTelemetry | null> {
  const ffmpeg = tools?.ffmpegPath?.trim() || 'ffmpeg';
  const inputPath = toExecutableInputPath(localPath, ffmpeg);

  try {
    const { stderr } = await exec(ffmpeg, [
      '-v', 'info',
      '-i', inputPath,
      '-vn',
      '-ac', '1',
      '-ar', '16000',
      '-af', 'volumedetect,silencedetect=n=-45dB:d=0.4',
      '-f', 'null',
      '-',
    ], { maxBuffer: 10 * 1024 * 1024 });

    const meanVolumeDb = parseMatchNumber(stderr, CMEAN_VOLUME_RE);
    const maxVolumeDb = parseMatchNumber(stderr, CMAX_VOLUME_RE);
    const silenceRatio = sumSilenceRatio(stderr, durationMs);

    return {
      ...(meanVolumeDb != null && { meanVolumeDb }),
      ...(maxVolumeDb != null && { maxVolumeDb }),
      ...(silenceRatio != null && { silenceRatio }),
    };
  } catch {
    return null;
  }
}

export function summarizeAudioHealth(input: {
  telemetry?: IAudioHealthTelemetry | null;
  speechCoverage?: number;
  transcript?: string;
  notes?: string[];
}): IAudioHealthSummary {
  const notes = [...new Set((input.notes ?? []).map(note => note.trim()).filter(Boolean))];
  const issues: string[] = [];
  const transcriptChars = input.transcript
    ? input.transcript.replace(/\s+/g, '').length
    : undefined;
  const hasAnySignal = Boolean(
    input.telemetry
    || typeof input.speechCoverage === 'number'
    || transcriptChars != null,
  );

  if ((input.telemetry?.meanVolumeDb ?? Number.POSITIVE_INFINITY) <= CLOW_LEVEL_DB) {
    issues.push('low-level');
  }
  if ((input.telemetry?.meanVolumeDb ?? Number.POSITIVE_INFINITY) <= CVERY_LOW_LEVEL_DB) {
    notes.push('整体语音电平偏低，可能需要保护音轨兜底。');
  }
  if ((input.telemetry?.maxVolumeDb ?? Number.NEGATIVE_INFINITY) >= CCLIPPING_DB) {
    issues.push('clipping-risk');
  }
  if ((input.telemetry?.silenceRatio ?? 0) >= CHIGH_SILENCE_RATIO) {
    issues.push('silence-heavy');
  }
  if (typeof input.speechCoverage === 'number' && input.speechCoverage < CWEAK_SPEECH_COVERAGE) {
    issues.push('speech-coverage-weak');
  }
  if ((transcriptChars ?? 0) === 0 && typeof input.speechCoverage === 'number' && input.speechCoverage < CWEAK_SPEECH_COVERAGE) {
    issues.push('transcript-empty');
  }
  if (
    issues.includes('speech-coverage-weak')
    && (input.telemetry?.meanVolumeDb ?? Number.POSITIVE_INFINITY) > -45
  ) {
    issues.push('speech-clarity-suspect');
    notes.push('有明显音频但语音线索偏弱，可能偏闷、被摩擦声覆盖，或清晰度不足。');
  }

  if (!hasAnySignal) {
    notes.push('未能获得足够的音频健康指标。');
  }

  const score = hasAnySignal
    ? clampScore(
      1
      - (issues.includes('low-level') ? 0.3 : 0)
      - (issues.includes('silence-heavy') ? 0.2 : 0)
      - (issues.includes('speech-coverage-weak') ? 0.25 : 0)
      - (issues.includes('speech-clarity-suspect') ? 0.15 : 0)
      - (issues.includes('clipping-risk') ? 0.1 : 0),
    )
    : 0.5;

  return {
    ...(input.telemetry?.meanVolumeDb != null && { meanVolumeDb: input.telemetry.meanVolumeDb }),
    ...(input.telemetry?.maxVolumeDb != null && { maxVolumeDb: input.telemetry.maxVolumeDb }),
    ...(input.telemetry?.silenceRatio != null && { silenceRatio: input.telemetry.silenceRatio }),
    ...(typeof input.speechCoverage === 'number' && { speechCoverage: input.speechCoverage }),
    ...(transcriptChars != null && { transcriptChars }),
    score,
    ...(issues.length > 0 && { issues }),
    ...(notes.length > 0 && { notes }),
  };
}

export function recommendProtectedAudioFallback(input: {
  binding?: IProtectionAudioBinding | null;
  embedded: IAudioHealthSummary;
  protection?: IAudioHealthSummary | null;
  comparedProtectionTranscript?: boolean;
}): IProtectedAudioAssessment | undefined {
  if (!input.binding) return undefined;

  const base = {
    comparedProtectionTranscript: input.comparedProtectionTranscript || undefined,
    embedded: input.embedded,
    ...(input.protection && { protection: input.protection }),
  };

  if (input.binding.alignment === 'mismatch') {
    return {
      ...base,
      recommendedSource: 'embedded',
      reason: '保护音轨与视频时长差异过大，当前不适合作为自动兜底来源。',
    };
  }

  if (!input.protection) {
    return {
      ...base,
      recommendedSource: 'embedded',
      reason: '已绑定保护音轨，但暂未获得可用的保护音轨健康指标。',
    };
  }

  const embeddedScore = input.embedded.score ?? 0.5;
  const protectionScore = input.protection.score ?? 0.5;
  const embeddedWeak = hasWeakSpeechSignals(input.embedded);
  const protectionWeak = hasWeakSpeechSignals(input.protection);

  if (
    input.binding.alignment !== 'unknown'
    && embeddedWeak
    && !protectionWeak
    && protectionScore >= embeddedScore + CPROTECTION_MARGIN
  ) {
    return {
      ...base,
      recommendedSource: 'protection',
      reason: '主无线麦音轨疑似偏弱或清晰度不足，保护音轨更适合作为原声兜底。',
    };
  }

  if (
    input.binding.alignment === 'unknown'
    && embeddedWeak
    && !protectionWeak
    && input.comparedProtectionTranscript
    && protectionScore >= embeddedScore + (CPROTECTION_MARGIN + 0.05)
  ) {
    return {
      ...base,
      recommendedSource: 'protection',
      reason: '保护音轨对比后明显更稳，但由于对齐信息未确认，后续仍建议人工抽查。',
    };
  }

  if (embeddedScore >= protectionScore - 0.05) {
    return {
      ...base,
      recommendedSource: 'embedded',
      reason: '当前主无线麦音轨仍是更稳妥的默认来源。',
    };
  }

  return {
    ...base,
    recommendedSource: 'undecided',
    reason: '保护音轨和主音轨差异不足以自动切换，建议后续按具体 beat 再确认。',
  };
}

function hasWeakSpeechSignals(summary: IAudioHealthSummary): boolean {
  const issues = new Set(summary.issues ?? []);
  return (
    issues.has('low-level')
    || issues.has('speech-coverage-weak')
    || issues.has('speech-clarity-suspect')
    || issues.has('silence-heavy')
  );
}

function parseMatchNumber(output: string, pattern: RegExp): number | undefined {
  const match = output.match(pattern);
  if (!match?.[1]) return undefined;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function sumSilenceRatio(output: string, durationMs?: number): number | undefined {
  if (typeof durationMs !== 'number' || durationMs <= 0) return undefined;

  let totalSilenceMs = 0;
  const matches = output.matchAll(CSILENCE_DURATION_RE);
  for (const match of matches) {
    if (!match[1]) continue;
    const seconds = Number(match[1]);
    if (!Number.isFinite(seconds) || seconds <= 0) continue;
    totalSilenceMs += seconds * 1000;
  }

  return Math.max(0, Math.min(totalSilenceMs / durationMs, 1));
}

function clampScore(score: number): number {
  if (!Number.isFinite(score)) return 0;
  if (score <= 0) return 0;
  if (score >= 1) return 1;
  return Math.round(score * 1000) / 1000;
}
