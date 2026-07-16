import { spawn } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  IKtepAsset,
  IKtepSpan,
  ITranscriptSegment,
} from '../../protocol/schema.js';
import {
  getSpansPath,
  loadAssets,
  loadProjectRoots,
  loadRuntimeConfig,
  loadSpans,
  resolveWorkspaceProjectRoot,
  writeJson,
} from '../../store/index.js';
import { resolveAssetLocalPath } from './root-resolver.js';
import { toExecutableInputPath } from './tool-path.js';

const CSAMPLE_RATE = 16000;
const CFRAME_MS = 20;
const CFRAME_SAMPLES = Math.round(CSAMPLE_RATE * CFRAME_MS / 1000);
const CLOOKBACK_MS = 800;
const CLOOKAHEAD_MS = 1800;
const CSTART_SEARCH_BACK_MS = 200;
const CSTART_SEARCH_FORWARD_MS = 1400;
const CMIN_START_CORRECTION_MS = 80;
const CMAX_START_CORRECTION_MS = 1000;
const CMIN_EFFECTIVE_DURATION_MS = 240;

export interface IRefineProjectSpeechBoundariesInput {
  workspaceRoot: string;
  projectId: string;
  assetIds?: string[];
  writeSpans?: boolean;
}

export interface IRefineProjectSpeechBoundariesResult {
  projectRoot: string;
  assetCount: number;
  analyzedAssetCount: number;
  candidateSpanCount: number;
  changedSpanCount: number;
  writtenSpanCount: number;
  diagnosticsRoot: string;
  warnings: string[];
}

interface IRawSpeechRange {
  startMs: number;
  endMs: number;
}

interface ISpanBoundaryDiagnostic {
  spanId: string;
  rawStartMs?: number;
  rawEndMs?: number;
  effectiveSpeechStartMs?: number;
  effectiveSpeechEndMs?: number;
  startCorrectionMs?: number;
  endCorrectionMs?: number;
  threshold?: number;
  noiseFloor?: number;
  speechPeak?: number;
  confidence: 'high' | 'medium' | 'low' | 'none';
  status: 'refined' | 'unchanged' | 'not-reliable' | 'skipped';
  reason?: string;
}

interface IAssetBoundaryDiagnostic {
  schemaVersion: 'kairos.speech-boundaries.v1';
  generatedAt: string;
  assetId: string;
  sourcePath: string;
  resolvedLocalPath?: string;
  skippedReason?: string;
  spans: ISpanBoundaryDiagnostic[];
}

interface IAnalyzedBoundary {
  diagnostic: ISpanBoundaryDiagnostic;
  writeBoundary: boolean;
}

interface IAudioFrameAnalysis {
  rms: number[];
  threshold: number;
  noiseFloor: number;
  speechPeak: number;
  confidence: 'high' | 'medium' | 'low' | 'none';
}

export async function refineProjectSpeechBoundaries(
  input: IRefineProjectSpeechBoundariesInput,
): Promise<IRefineProjectSpeechBoundariesResult> {
  const projectRoot = resolveWorkspaceProjectRoot(input.workspaceRoot, input.projectId);
  const diagnosticsRoot = join(projectRoot, 'analysis', 'speech-boundaries');
  const assetFilter = input.assetIds?.length ? new Set(input.assetIds) : null;
  const warnings: string[] = [];

  const [assets, spans, roots, runtimeConfig] = await Promise.all([
    loadAssets(projectRoot),
    loadSpans(projectRoot),
    loadProjectRoots(projectRoot),
    loadRuntimeConfig(projectRoot),
  ]);
  const rawSpans = await loadRawSpanObjects(projectRoot, spans);

  const assetById = new Map(assets.map(asset => [asset.id, asset] as const));
  const candidateSpans = spans
    .filter(span => isSpeechBoundaryCandidate(span))
    .filter(span => !assetFilter || assetFilter.has(span.assetId));
  const spansByAssetId = groupByAssetId(candidateSpans);
  const nextRawSpansById = new Map(rawSpans.map(span => [String(span.id), span] as const));

  await mkdir(diagnosticsRoot, { recursive: true });

  let changedSpanCount = 0;
  let writtenSpanCount = 0;
  let analyzedAssetCount = 0;
  const generatedAt = new Date().toISOString();
  const ffmpegPath = runtimeConfig.ffmpegPath?.trim() || 'ffmpeg';

  for (const [assetId, assetSpans] of spansByAssetId) {
    const asset = assetById.get(assetId);
    if (!asset || asset.kind !== 'video') {
      warnings.push(`skipped ${assetId}: asset is missing or not video`);
      continue;
    }

    const diagnostic: IAssetBoundaryDiagnostic = {
      schemaVersion: 'kairos.speech-boundaries.v1',
      generatedAt,
      assetId,
      sourcePath: asset.sourcePath,
      spans: [],
    };

    const localPath = resolveAssetLocalPath(asset, roots.roots);
    if (!localPath) {
      diagnostic.skippedReason = 'asset-local-path-unresolved';
      for (const span of assetSpans) {
        diagnostic.spans.push(buildSkippedDiagnostic(span.id, 'asset-local-path-unresolved'));
      }
      warnings.push(`skipped ${assetId}: local path unresolved`);
      await writeJson(join(diagnosticsRoot, `${assetId}.json`), diagnostic);
      continue;
    }

    diagnostic.resolvedLocalPath = localPath;
    analyzedAssetCount += 1;

    for (const span of assetSpans.sort(compareSpanRange)) {
      const rawRange = resolveRawSpeechRange(span);
      if (!rawRange) {
        diagnostic.spans.push(buildSkippedDiagnostic(span.id, 'raw-speech-range-missing'));
        continue;
      }

      const analysis = await analyzeSpanBoundary({
        ffmpegPath,
        localPath,
        asset,
        span,
        rawRange,
      }).catch(error => ({
        diagnostic: {
          spanId: span.id,
          rawStartMs: rawRange.startMs,
          rawEndMs: rawRange.endMs,
          confidence: 'none',
          status: 'skipped',
          reason: error instanceof Error ? error.message : 'ffmpeg-audio-analysis-failed',
        },
        writeBoundary: false,
      }) satisfies IAnalyzedBoundary);

      diagnostic.spans.push(analysis.diagnostic);

      const current = nextRawSpansById.get(span.id);
      if (!current) continue;
      const next = { ...current };
      if (analysis.writeBoundary) {
        next.effectiveSpeechStartMs = analysis.diagnostic.effectiveSpeechStartMs;
        next.effectiveSpeechEndMs = analysis.diagnostic.effectiveSpeechEndMs;
        writtenSpanCount += 1;
      } else {
        delete next.effectiveSpeechStartMs;
        delete next.effectiveSpeechEndMs;
      }
      if (
        current.effectiveSpeechStartMs !== next.effectiveSpeechStartMs
        || current.effectiveSpeechEndMs !== next.effectiveSpeechEndMs
      ) {
        changedSpanCount += 1;
        nextRawSpansById.set(span.id, next);
      }
    }

    await writeJson(join(diagnosticsRoot, `${assetId}.json`), diagnostic);
  }

  if (input.writeSpans && changedSpanCount > 0) {
    const nextSpans = rawSpans.map(span => nextRawSpansById.get(String(span.id)) ?? span);
    await writeJson(getSpansPath(projectRoot), nextSpans);
  }

  return {
    projectRoot,
    assetCount: assets.length,
    analyzedAssetCount,
    candidateSpanCount: candidateSpans.length,
    changedSpanCount,
    writtenSpanCount,
    diagnosticsRoot,
    warnings,
  };
}

async function loadRawSpanObjects(projectRoot: string, parsedSpans: IKtepSpan[]): Promise<Array<Record<string, unknown>>> {
  try {
    const raw = JSON.parse(await readFile(getSpansPath(projectRoot), 'utf-8')) as unknown;
    if (Array.isArray(raw)) {
      return raw
        .filter(item => item && typeof item === 'object')
        .map(item => item as Record<string, unknown>);
    }
  } catch {
    // Fall back to parsed spans below.
  }
  return parsedSpans.map(span => ({ ...span }) as Record<string, unknown>);
}

function isSpeechBoundaryCandidate(span: IKtepSpan): boolean {
  return span.semanticKind === 'speech'
    || span.semanticKind === 'mixed'
    || Boolean(span.transcript?.trim())
    || (span.transcriptSegments?.some(segment => segment.text.trim()) ?? false);
}

function groupByAssetId(spans: IKtepSpan[]): Map<string, IKtepSpan[]> {
  const grouped = new Map<string, IKtepSpan[]>();
  for (const span of spans) {
    const group = grouped.get(span.assetId) ?? [];
    group.push(span);
    grouped.set(span.assetId, group);
  }
  return grouped;
}

function resolveRawSpeechRange(span: IKtepSpan): IRawSpeechRange | null {
  const transcriptRange = resolveTranscriptRange(span.transcriptSegments ?? []);
  const startMs = transcriptRange?.startMs ?? firstFiniteNumber(span.sourceInMs, span.editSourceInMs);
  const endMs = transcriptRange?.endMs ?? firstFiniteNumber(span.sourceOutMs, span.editSourceOutMs);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null;
  return {
    startMs: Math.max(0, Math.round(startMs)),
    endMs: Math.max(0, Math.round(endMs)),
  };
}

function resolveTranscriptRange(segments: ITranscriptSegment[]): IRawSpeechRange | null {
  const validSegments = segments.filter(segment =>
    segment.endMs > segment.startMs && segment.text.trim().length > 0
  );
  if (validSegments.length === 0) return null;
  return {
    startMs: Math.min(...validSegments.map(segment => segment.startMs)),
    endMs: Math.max(...validSegments.map(segment => segment.endMs)),
  };
}

async function analyzeSpanBoundary(input: {
  ffmpegPath: string;
  localPath: string;
  asset: IKtepAsset;
  span: IKtepSpan;
  rawRange: IRawSpeechRange;
}): Promise<IAnalyzedBoundary> {
  const assetDurationMs = finiteNumber(input.asset.durationMs);
  const extractStartMs = Math.max(0, input.rawRange.startMs - CLOOKBACK_MS);
  const extractEndLimitMs = assetDurationMs ?? (input.rawRange.endMs + CLOOKAHEAD_MS);
  const extractEndMs = Math.max(
    input.rawRange.endMs,
    Math.min(extractEndLimitMs, input.rawRange.endMs + CLOOKAHEAD_MS),
  );
  const durationMs = Math.max(CFRAME_MS, extractEndMs - extractStartMs);
  const pcm = await extractSpeechBandPcm({
    ffmpegPath: input.ffmpegPath,
    localPath: input.localPath,
    startMs: extractStartMs,
    durationMs,
  });
  const frameAnalysis = analyzePcmFrames(pcm);
  const baseDiagnostic = {
    spanId: input.span.id,
    rawStartMs: input.rawRange.startMs,
    rawEndMs: input.rawRange.endMs,
    threshold: roundFloat(frameAnalysis.threshold),
    noiseFloor: roundFloat(frameAnalysis.noiseFloor),
    speechPeak: roundFloat(frameAnalysis.speechPeak),
  };

  if (frameAnalysis.rms.length === 0 || frameAnalysis.confidence === 'none') {
    return {
      diagnostic: {
        ...baseDiagnostic,
        confidence: 'none',
        status: 'not-reliable',
        reason: 'audio-signal-too-weak',
      },
      writeBoundary: false,
    };
  }

  const rawStartFrame = msToFrame(input.rawRange.startMs - extractStartMs);
  const startSearchStart = Math.max(0, rawStartFrame - msToFrame(CSTART_SEARCH_BACK_MS));
  const startSearchEnd = Math.min(
    frameAnalysis.rms.length - 1,
    rawStartFrame + msToFrame(CSTART_SEARCH_FORWARD_MS),
  );
  const onsetFrame = findSustainedActiveStart(frameAnalysis.rms, startSearchStart, startSearchEnd, frameAnalysis.threshold);
  if (onsetFrame == null) {
    return {
      diagnostic: {
        ...baseDiagnostic,
        confidence: frameAnalysis.confidence,
        status: 'not-reliable',
        reason: 'speech-onset-not-found',
      },
      writeBoundary: false,
    };
  }

  const onsetSourceMs = Math.max(0, Math.round(extractStartMs + onsetFrame * CFRAME_MS));
  const rawCorrectionMs = onsetSourceMs - input.rawRange.startMs;
  if (rawCorrectionMs > CMAX_START_CORRECTION_MS) {
    return {
      diagnostic: {
        ...baseDiagnostic,
        startCorrectionMs: rawCorrectionMs,
        confidence: 'low',
        status: 'not-reliable',
        reason: 'start-correction-too-large',
      },
      writeBoundary: false,
    };
  }

  const startCorrectionMs = rawCorrectionMs >= CMIN_START_CORRECTION_MS ? rawCorrectionMs : 0;
  const effectiveStartMs = input.rawRange.startMs + startCorrectionMs;
  let effectiveEndMs = input.rawRange.endMs + startCorrectionMs;
  if (assetDurationMs != null) {
    effectiveEndMs = Math.min(assetDurationMs, effectiveEndMs);
  }

  if (effectiveEndMs - effectiveStartMs < CMIN_EFFECTIVE_DURATION_MS) {
    return {
      diagnostic: {
        ...baseDiagnostic,
        startCorrectionMs,
        confidence: 'low',
        status: 'not-reliable',
        reason: 'effective-window-too-short',
      },
      writeBoundary: false,
    };
  }

  const status = startCorrectionMs > 0 || effectiveEndMs !== input.rawRange.endMs
    ? 'refined'
    : 'unchanged';
  const confidence = startCorrectionMs > 0 ? frameAnalysis.confidence : downgradeConfidence(frameAnalysis.confidence);
  const diagnostic: ISpanBoundaryDiagnostic = {
    ...baseDiagnostic,
    effectiveSpeechStartMs: Math.round(effectiveStartMs),
    effectiveSpeechEndMs: Math.round(effectiveEndMs),
    startCorrectionMs,
    endCorrectionMs: Math.round(effectiveEndMs - input.rawRange.endMs),
    confidence,
    status,
  };

  return {
    diagnostic,
    writeBoundary: confidence !== 'low' && confidence !== 'none',
  };
}

function analyzePcmFrames(buffer: Buffer): IAudioFrameAnalysis {
  const rms: number[] = [];
  const frameBytes = CFRAME_SAMPLES * 2;
  for (let offset = 0; offset + frameBytes <= buffer.length; offset += frameBytes) {
    let sum = 0;
    for (let index = 0; index < CFRAME_SAMPLES; index += 1) {
      const sample = buffer.readInt16LE(offset + index * 2) / 32768;
      sum += sample * sample;
    }
    rms.push(Math.sqrt(sum / CFRAME_SAMPLES));
  }

  if (rms.length === 0) {
    return {
      rms,
      threshold: 0,
      noiseFloor: 0,
      speechPeak: 0,
      confidence: 'none',
    };
  }

  const noiseFloor = percentile(rms, 0.20);
  const speechPeak = percentile(rms, 0.95);
  const dynamicRange = Math.max(0, speechPeak - noiseFloor);
  const threshold = Math.max(
    0.0018,
    noiseFloor + dynamicRange * 0.28,
    speechPeak * 0.12,
  );
  const relativeDynamic = speechPeak > 0 ? dynamicRange / speechPeak : 0;
  const confidence = speechPeak < 0.0025 || relativeDynamic < 0.08
    ? 'none'
    : relativeDynamic >= 0.35
      ? 'high'
      : relativeDynamic >= 0.18
        ? 'medium'
        : 'low';

  return {
    rms,
    threshold,
    noiseFloor,
    speechPeak,
    confidence,
  };
}

function findSustainedActiveStart(
  frames: number[],
  startFrame: number,
  endFrame: number,
  threshold: number,
): number | null {
  const windowFrames = 5;
  for (let index = Math.max(0, startFrame); index <= endFrame; index += 1) {
    const window = frames.slice(index, Math.min(frames.length, index + windowFrames));
    if (window.length === 0) continue;
    const activeCount = window.filter(value => value >= threshold).length;
    const peak = Math.max(...window);
    if (activeCount >= 3 && peak >= threshold * 1.15) return index;
  }
  return null;
}

async function extractSpeechBandPcm(input: {
  ffmpegPath: string;
  localPath: string;
  startMs: number;
  durationMs: number;
}): Promise<Buffer> {
  const executableInputPath = toExecutableInputPath(input.localPath, input.ffmpegPath);
  const args = [
    '-v', 'error',
    '-nostdin',
    '-ss', secondsArg(input.startMs),
    '-t', secondsArg(input.durationMs),
    '-i', executableInputPath,
    '-vn',
    '-ac', '1',
    '-ar', String(CSAMPLE_RATE),
    '-af', 'highpass=f=120,lowpass=f=3800',
    '-f', 's16le',
    '-',
  ];

  return new Promise((resolve, reject) => {
    const child = spawn(input.ffmpegPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', chunk => stdout.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    child.stderr.on('data', chunk => stderr.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) {
        resolve(Buffer.concat(stdout));
        return;
      }
      const message = Buffer.concat(stderr).toString('utf-8').trim() || `ffmpeg exited with code ${code}`;
      reject(new Error(message));
    });
  });
}

function buildSkippedDiagnostic(spanId: string, reason: string): ISpanBoundaryDiagnostic {
  return {
    spanId,
    confidence: 'none',
    status: 'skipped',
    reason,
  };
}

function compareSpanRange(left: IKtepSpan, right: IKtepSpan): number {
  return (left.sourceInMs ?? left.editSourceInMs ?? 0) - (right.sourceInMs ?? right.editSourceInMs ?? 0)
    || left.id.localeCompare(right.id);
}

function msToFrame(ms: number): number {
  return Math.max(0, Math.round(ms / CFRAME_MS));
}

function secondsArg(ms: number): string {
  return (Math.max(0, ms) / 1000).toFixed(3);
}

function finiteNumber(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function firstFiniteNumber(...values: Array<number | undefined>): number {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return Number.NaN;
}

function percentile(values: number[], ratio: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * ratio)));
  return sorted[index] ?? 0;
}

function roundFloat(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function downgradeConfidence(confidence: IAudioFrameAnalysis['confidence']): IAudioFrameAnalysis['confidence'] {
  if (confidence === 'high') return 'medium';
  return confidence;
}
