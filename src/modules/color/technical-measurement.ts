import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { probe, type IMediaToolConfig } from '../media/probe.js';
import { toExecutableInputPath } from '../media/tool-path.js';
import { HIGH_CONTRAST_THRESHOLDS, IContrastFrame, measureHighContrastFrame, summarizeHighContrast } from './high-contrast-measurement.js';

export const COLOR_MEASUREMENT_VERSION = 'color-measurement-v4' as const;
// Conservative engineering thresholds, not camera calibration or physical sensor limits.
export const COLOR_THRESHOLDS = {
  version: 'real-samples-v4', highContrast: HIGH_CONTRAST_THRESHOLDS, overviewFps: 1, white: 0.985, whiteArea: 0.72,
  lowerWhiteArea: 0.65, whiteTiles: 12,
  bottomWhiteArea: 0.65,
  darkLevel: 0.12, darkArea: 0.75, darkMedian: 0.08,
  // Display-normalized temporal luminance sigma; calibrated against labeled C4248 and controls.
  noiseSigma: 0.004, sourceNoiseSigma: 0.00075, noisePersistence: 0.8,
  brightLevel: 0.7, brightArea: 0.55, brightMedian: 0.74, lowerMedian: 0.65,
  lowerP10: 0.35, bottomMedian: 0.6, brightTileMean: 0.65, brightTiles: 10,
  minExposureIntervalMs: 3000, uniformLumaSpread: 0.03,
  textureSpread: 0.06, meanDrift: 0.015, minNoisePatches: 12, minNoiseRegions: 4,
  residualCorrelationLag: 8, maxResidualCorrelation: 0.3,
  sourceWhiteToleranceCodes: 1,
} as const;
const W = 192, H = 108, CROP = 96, MOSAIC = CROP * 3, BURST = 6;
const interval = z.object({ startMs: z.number(), endMs: z.number() });
const diagnosis = z.object({ state: z.enum(['detected', 'not-observed', 'needs-review', 'unknown']),
  reasons: z.array(z.string()), intervals: z.array(interval) });
const frameMetrics = z.object({ whiteFraction: z.number(), lowerWhiteFraction: z.number(), whiteTiles: z.number(),
  bottomWhiteFraction: z.number().optional(), topBandDominated: z.boolean().optional(),
  brightFraction: z.number(), lowerMedian: z.number(), lowerP10: z.number(), bottomMedian: z.number(),
  brightTiles: z.number(), brightTopBandDominated: z.boolean(), broadOverbright: z.boolean(), lumaSpread: z.number(),
  darkFraction: z.number(), median: z.number(), mean: z.number(), broadWhite: z.boolean(), veryDark: z.boolean() });
export const IColorTechnicalReport = z.object({
  version: z.literal(COLOR_MEASUREMENT_VERSION), thresholdVersion: z.literal(COLOR_THRESHOLDS.version),
  status: z.enum(['complete', 'partial', 'unavailable']),
  decoder: z.string().optional(),
  signal: z.object({ pixelFormat: z.string().optional(), range: z.string().optional(), matrix: z.string().optional(),
    transfer: z.string().optional(), primaries: z.string().optional(), hwaccel: z.string().optional(), clipProofMode: z.string().optional() }).optional(),
  source: z.object({ role: z.literal('raw'), contentHash: z.string(), profile: z.string().optional(),
    lutHash: z.string().optional(), lutPath: z.string().optional(), blocker: z.string().optional() }),
  probe: z.object({ width: z.number(), height: z.number(), displayWidth: z.number(), displayHeight: z.number(), fps: z.number(), durationMs: z.number(), rotationDegrees: z.number().nullable() }).optional(),
  coverage: z.object({ mode: z.literal('1fps-full-duration'), durationMs: z.number(), sampledBins: z.number(), expectedBins: z.number(), ratio: z.number(), expectedNoiseBursts: z.number() }),
  overview: z.array(z.object({ startMs: z.number(), endMs: z.number(), source: frameMetrics, display: frameMetrics,
    sourceWhitePlateauFraction: z.number().optional() })),
  noiseSamples: z.array(z.object({ startMs: z.number(), endMs: z.number(), validPatches: z.number(), regions: z.number(),
    rejections: z.record(z.number()).optional(),
    displaySigma: z.number().nullable(), sourceSigma: z.number().nullable(), state: z.enum(['noisy', 'not-observed', 'unknown']) })),
  contrastSampling: z.object({ width: z.number(), height: z.number(), fps: z.literal(1), round: z.literal('up') }).optional(),
  contrastOverview: z.array(z.object({ startMs: z.number(), endMs: z.number(), metrics: IContrastFrame })),
  exposure: diagnosis, sourceClipping: diagnosis, noise: diagnosis,
  highContrast: diagnosis.extend({ state: z.enum(['detected', 'not-observed', 'not-dominant', 'needs-review', 'unknown']),
    aggregation: z.object({ policyVersion: z.literal('dominant-duration-v1'), positiveDurationMs: z.number(), negativeDurationMs: z.number(),
      unobservedDurationMs: z.number(), positiveFraction: z.number(), negativeFraction: z.number() }).optional() }),
  deferred: z.array(z.string()), warnings: z.array(z.string()),
});
export type ColorTechnicalReport = z.infer<typeof IColorTechnicalReport>;
export type FrameMetrics = z.infer<typeof frameMetrics>;
export type NoiseSample = ColorTechnicalReport['noiseSamples'][number];
const median = (values: number[]) => {
  if (!values.length) return 0;
  const a = [...values].sort((x, y) => x - y), m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m]! : (a[m - 1]! + a[m]!) / 2;
};
function quantile(values: number[], q: number) {
  if (!values.length) return 0;
  const a = [...values].sort((x, y) => x - y);
  return a[Math.floor((a.length - 1) * q)]!;
}
function luma(frame: Buffer, offset: number) {
  return (0.2126 * frame.readUInt16LE(offset) + 0.7152 * frame.readUInt16LE(offset + 2) + 0.0722 * frame.readUInt16LE(offset + 4)) / 65535;
}

/** RGB16 full-range decoded signal. Spatial coverage excludes sky-only top-band clipping. */
export function measureFrame(frame: Buffer, width: number, height: number, byteOffset = 0): FrameMetrics {
  let white = 0, lowerWhite = 0, lowerCount = 0, bottomWhite = 0, bottomCount = 0, dark = 0, sum = 0;
  const rowWhite = new Array<number>(height).fill(0), rowBright = new Array<number>(height).fill(0);
  const values: number[] = [], lower: number[] = [], bottom: number[] = [];
  const tiles = Array.from({ length: 16 }, () => ({ white: 0, n: 0, total: 0 }));
  let brightPixels = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = byteOffset + (y * width + x) * 6;
    const bright = Math.min(frame.readUInt16LE(offset), frame.readUInt16LE(offset + 2), frame.readUInt16LE(offset + 4)) / 65535 >= COLOR_THRESHOLDS.white;
    const v = luma(frame, offset); sum += v; values.push(v);
    if (v >= COLOR_THRESHOLDS.brightLevel) { brightPixels++; rowBright[y] = rowBright[y]! + 1; }
    if (v < COLOR_THRESHOLDS.darkLevel) dark++;
    if (bright) { white++; rowWhite[y] = rowWhite[y]! + 1; }
    if (y >= height / 3) { lowerCount++; lower.push(v); if (bright) lowerWhite++; }
    if (y >= height * 3 / 4) { bottomCount++; bottom.push(v); if (bright) bottomWhite++; }
    const tile = tiles[Math.min(3, Math.floor(y * 4 / height)) * 4 + Math.min(3, Math.floor(x * 4 / width))]!;
    tile.n++; tile.total += v; if (bright) tile.white++;
  }
  const whiteFraction = white / values.length, lowerWhiteFraction = lowerWhite / lowerCount;
  const whiteTiles = tiles.filter(t => t.white / t.n >= 0.6).length;
  let bandRows = 0, bandWhite = 0;
  for (const count of rowWhite) { if (count / width < 0.95) break; bandRows++; bandWhite += count; }
  const topBandDominated = bandRows > 0 && bandRows < height && bandWhite / Math.max(1, white) > 0.9;
  const bottomWhiteFraction = bottomWhite / bottomCount;
  const darkFraction = dark / values.length, mid = median(values);
  let brightBandRows = 0, bandBright = 0;
  for (const count of rowBright) { if (count / width < 0.95) break; brightBandRows++; bandBright += count; }
  const brightTopBandDominated = brightBandRows > 0 && brightBandRows < height && bandBright / Math.max(1, brightPixels) > 0.9;
  const brightFraction = brightPixels / values.length, lowerMedian = median(lower), lowerP10 = quantile(lower, 0.1), bottomMedian = median(bottom);
  const brightTiles = tiles.filter(t => t.total / t.n >= COLOR_THRESHOLDS.brightTileMean).length;
  return { whiteFraction, lowerWhiteFraction, bottomWhiteFraction, topBandDominated, whiteTiles, darkFraction, median: mid, mean: sum / values.length,
    brightFraction, lowerMedian, lowerP10, bottomMedian, brightTiles, brightTopBandDominated,
    lumaSpread: quantile(values, 0.95) - quantile(values, 0.05),
    broadOverbright: !brightTopBandDominated && brightFraction >= COLOR_THRESHOLDS.brightArea && mid >= COLOR_THRESHOLDS.brightMedian
      && lowerMedian >= COLOR_THRESHOLDS.lowerMedian && lowerP10 >= COLOR_THRESHOLDS.lowerP10
      && bottomMedian >= COLOR_THRESHOLDS.bottomMedian && brightTiles >= COLOR_THRESHOLDS.brightTiles,
    broadWhite: !topBandDominated && whiteFraction >= COLOR_THRESHOLDS.whiteArea && lowerWhiteFraction >= COLOR_THRESHOLDS.lowerWhiteArea
      && bottomWhiteFraction >= COLOR_THRESHOLDS.bottomWhiteArea && whiteTiles >= COLOR_THRESHOLDS.whiteTiles,
    veryDark: darkFraction >= COLOR_THRESHOLDS.darkArea && mid < COLOR_THRESHOLDS.darkMedian };
}

/** Consecutive native-resolution patches. Excludes textured/drifting patches before estimating temporal MAD. */
export function measureNoiseBurst(frames: Buffer[], startMs: number, fps: number): NoiseSample {
  const empty: NoiseSample = { startMs, endMs: startMs + frames.length / fps * 1000, validPatches: 0, regions: 0,
    displaySigma: null, sourceSigma: null, state: 'unknown' };
  if (frames.length < BURST) return empty;
  const rejections = { meanDrift: 0, coarseTexture: 0, localMotion: 0, fineTexture: 0, coherentResidual: 0 };
  empty.rejections = rejections;
  const sigmas: { source: number; display: number; region: number }[] = [];
  for (let region = 0; region < 9; region++) for (let py = 0; py < 3; py++) for (let px = 0; px < 3; px++) {
    const x0 = (region % 3) * CROP + px * 32, y0 = Math.floor(region / 3) * CROP + py * 32;
    const src: number[][] = [], dis: number[][] = [];
    for (const f of frames) {
      const s: number[] = [], d: number[] = [];
      for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
        const offset = ((y0 + y) * MOSAIC + x0 + x) * 6;
        s.push(luma(f, offset)); d.push(luma(f, offset + MOSAIC * MOSAIC * 6));
      }
      src.push(s); dis.push(d);
    }
    // 8x8 spatial averages remove random grain before texture and motion guards.
    const blocks = dis.map(f => Array.from({ length: 16 }, (_, b) => {
      let total = 0;
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) total += f[(Math.floor(b / 4) * 8 + y) * 32 + (b % 4) * 8 + x]!;
      return total / 64;
    }));
    const means = blocks.map(b => b.reduce((a, v) => a + v, 0) / b.length);
    if (Math.max(...means) - Math.min(...means) > COLOR_THRESHOLDS.meanDrift) { rejections.meanDrift++; continue; }
    if (blocks.some(b => quantile(b, 0.95) - quantile(b, 0.05) > COLOR_THRESHOLDS.textureSpread)) { rejections.coarseTexture++; continue; }
    if (Array.from({ length: 16 }, (_, i) => Math.max(...blocks.map(b => b[i]!)) - Math.min(...blocks.map(b => b[i]!)))
      .some(d => d > COLOR_THRESHOLDS.meanDrift * 2)) { rejections.localMotion++; continue; }
    if (dis.some(f => quantile(f, 0.95) - quantile(f, 0.05) > 0.12)) { rejections.fineTexture++; continue; }
    // Native camera/codec noise may correlate at neighboring pixels. Test a wider lag for coherent motion.
    const delta = dis[1]!.map((v, i) => v - dis[0]![i]!);
    const center = median(delta);
    let energy = 0, horizontal = 0, vertical = 0;
    const lag = COLOR_THRESHOLDS.residualCorrelationLag;
    for (let y = 0; y < 32 - lag; y++) for (let x = 0; x < 32 - lag; x++) {
      const i = y * 32 + x, d = delta[i]! - center;
      energy += d * d;
      horizontal += d * (delta[i + lag]! - center); vertical += d * (delta[i + lag * 32]! - center);
    }
    if (energy > 1e-8 && Math.max(Math.abs(horizontal), Math.abs(vertical)) / energy > COLOR_THRESHOLDS.maxResidualCorrelation) { rejections.coherentResidual++; continue; }
    // A frozen image is measurable, but not evidence for temporal noise.
    const sigma = (seq: number[][]) => median(seq.slice(1).map((f, i) => {
      const diff = f.map((v, p) => v - seq[i]![p]!);
      const center = median(diff);
      return median(diff.map(d => Math.abs(d - center))) * 1.4826 / Math.sqrt(2);
    }));
    sigmas.push({ source: sigma(src), display: sigma(dis), region });
  }
  const regions = new Set(sigmas.map(s => s.region)).size;
  if (sigmas.length < COLOR_THRESHOLDS.minNoisePatches || regions < COLOR_THRESHOLDS.minNoiseRegions) return { ...empty, validPatches: sigmas.length, regions };
  const sourceSigma = median(sigmas.map(s => s.source)), displaySigma = median(sigmas.map(s => s.display));
  return { ...empty, validPatches: sigmas.length, regions, sourceSigma, displaySigma,
    state: displaySigma >= COLOR_THRESHOLDS.noiseSigma && sourceSigma >= COLOR_THRESHOLDS.sourceNoiseSigma ? 'noisy' : 'not-observed' };
}

function intervals(rows: { startMs: number; endMs: number }[]) {
  const out: typeof rows = [];
  for (const row of rows) {
    const last = out.at(-1);
    if (last && row.startMs <= last.endMs + 1) last.endMs = Math.max(last.endMs, row.endMs);
    else out.push({ startMs: row.startMs, endMs: row.endMs });
  }
  return out;
}

export function summarizeTechnical(report: ColorTechnicalReport): ColorTechnicalReport {
  const { overview, noiseSamples: noise, coverage } = report;
  coverage.sampledBins = overview.length;
  coverage.ratio = Math.min(1, overview.reduce((total, s) => total + s.endMs - s.startMs, 0) / Math.max(1, coverage.durationMs));
  const broad = overview.filter(s => s.display.broadWhite);
  const sourceBroad = broad.filter(s => s.source.broadWhite && (s.sourceWhitePlateauFraction ?? 0) >= COLOR_THRESHOLDS.whiteArea);
  const totalDuration = coverage.durationMs;
  const complete = coverage.ratio >= 0.98 && overview.length >= Math.min(3, coverage.expectedBins);
  const sustained = (rows: typeof overview) => intervals(rows).filter(i => i.endMs - i.startMs >= Math.min(COLOR_THRESHOLDS.minExposureIntervalMs, totalDuration));
  const exposureRows = overview.filter(s => s.display.broadWhite || s.display.broadOverbright);
  const exposureIntervals = sustained(exposureRows);
  report.exposure = { state: !complete ? 'unknown' : exposureIntervals.length ? 'detected' : 'not-observed',
    reasons: [!complete ? '全片概览覆盖不足' : exposureIntervals.length
      ? '持续区间内画面大面积偏亮，覆盖中下部、底部与多数网格；不以源端不可恢复剪切为前提'
      : '未检出持续的大面积整体偏亮；局部高光和短暂亮闪不触发'], intervals: exposureIntervals };
  const sustainedRows = exposureRows.filter(s => exposureIntervals.some(i => s.startMs >= i.startMs && s.endMs <= i.endMs));
  if (complete && sustainedRows.length && sustainedRows.filter(s => s.display.lumaSpread < COLOR_THRESHOLDS.uniformLumaSpread).length / sustainedRows.length >= 0.8) {
    report.exposure = { ...report.exposure, state: 'needs-review', reasons: ['大面积近均匀亮色，需区分白色/雾雪场景与曝光问题'] };
  }
  // Source-code clipping is a separate audit, never a prerequisite for an over-bright display image.
  report.sourceClipping = { state: 'unknown', reasons: [], intervals: sustained(sourceBroad) };
  if (!complete) report.sourceClipping.reasons = ['全片概览覆盖不足'];
  else if (report.source.profile !== 'rec709') report.sourceClipping.reasons = ['LOG 源传感器剪切点未标定，不推定不可恢复的细节丢失'];
  else if (!['tv', 'pc'].includes(report.signal?.range ?? '')) report.sourceClipping.reasons = ['源编码范围未标记，不能确认源白端裁切'];
  else if (!sustained(broad).length) report.sourceClipping = { ...report.sourceClipping, state: 'not-observed', reasons: ['未见持续广域白端平台；不排除局部或单通道裁切'] };
  else if (!report.sourceClipping.intervals.length) report.sourceClipping = { ...report.sourceClipping, state: 'needs-review', reasons: ['显示白化缺少源编码白端平台支持，可能仍有可恢复数据'] };
  else if (overview.every(s => s.source.whiteFraction > 0.995)) report.sourceClipping = { ...report.sourceClipping, state: 'needs-review', reasons: ['近乎纯白，白色场景与源曝光丢失有歧义'] };
  else report.sourceClipping = { ...report.sourceClipping, state: 'detected', reasons: ['持续区间存在大面积源编码白端平台'] };
  const valid = noise.filter(n => n.state !== 'unknown');
  report.noise.intervals = noise.filter(n => n.state === 'noisy').map(({ startMs, endMs }) => ({ startMs, endMs }));
  if (!noise.length || noise.length !== coverage.expectedNoiseBursts || valid.length < Math.max(3, Math.ceil(noise.length * 0.8))) report.noise = { ...report.noise, state: 'unknown', reasons: ['静态低纹理连续帧样本不足，不能排除运动、纹理或压缩影响'] };
  else if (valid.filter(n => n.state === 'noisy').length / noise.length >= COLOR_THRESHOLDS.noisePersistence) report.noise = { ...report.noise, state: 'detected', reasons: ['多个原分辨率位置及分布式连续帧存在显著时间残差噪声'] };
  else report.noise = { ...report.noise, state: 'not-observed', reasons: ['有效连续帧局部未见跨片持续的高随机噪声；不排除固定图样/局部噪声'] };
  report.highContrast = summarizeHighContrast(report.contrastOverview, totalDuration);
  report.status = complete && report.noise.state !== 'unknown' && report.highContrast.state !== 'unknown' ? 'complete' : 'partial';
  return report;
}

export function emptyTechnical(source: ColorTechnicalReport['source'], durationMs = 0, reason = '未检测'): ColorTechnicalReport {
  return { version: COLOR_MEASUREMENT_VERSION, thresholdVersion: COLOR_THRESHOLDS.version, status: 'unavailable', source,
    coverage: { mode: '1fps-full-duration', durationMs, sampledBins: 0, expectedBins: Math.ceil(durationMs / 1000), ratio: 0, expectedNoiseBursts: 0 },
    overview: [], contrastOverview: [], noiseSamples: [], exposure: { state: 'unknown', reasons: [reason], intervals: [] },
    sourceClipping: { state: 'unknown', reasons: [reason], intervals: [] },
    noise: { state: 'unknown', reasons: [reason], intervals: [] }, highContrast: { state: 'unknown', reasons: [reason], intervals: [] },
    deferred: ['white-balance', 'flicker'], warnings: [] };
}

// Stream fixed-size raw frames; no shell, unbounded stdout buffer or temporary decoded movie.
async function decodeFrames(ffmpeg: string, args: string[], bytes: number, consume: (frame: Buffer) => void, timeoutMs: number): Promise<void> {
  const child = spawn(ffmpeg, ['-hide_banner', '-v', 'error', '-nostdin', '-threads', '2', '-filter_complex_threads', '1', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let errorText = '', timedOut = false;
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal }));
  });
  // Attach a rejection handler immediately, including spawn failures before stream consumption.
  void closed.catch(() => undefined);
  child.stderr.on('data', chunk => { errorText = (errorText + chunk.toString()).slice(-6000); });
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
  let pending = Buffer.alloc(0);
  try {
    for await (const chunk of child.stdout) {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      while (pending.length >= bytes) { consume(Buffer.from(pending.subarray(0, bytes))); pending = pending.subarray(bytes); }
    }
    const { code, signal } = await closed;
    if (code !== 0 || timedOut || pending.length) throw new Error(timedOut ? '技术解码超时' : `技术解码失败 (${signal ?? code}): ${errorText.trim()}`);
  } finally { clearTimeout(timer); if (child.exitCode === null) child.kill('SIGKILL'); }
}

function displayFilter(lutPath: string | undefined, ffmpeg: string) {
  if (!lutPath) return 'null';
  const path = toExecutableInputPath(lutPath, ffmpeg).replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "'\\''");
  return `lut3d=file='${path}':interp=tetrahedral`;
}

/** Build the white-code mask BEFORE range conversion or resizing, so recoverable superwhite is not source clipping. */
function sourceClipMask(pixelFormat: string, range: string, bitDepth: number | null | undefined) {
  if (!bitDepth || bitDepth < 8 || bitDepth > 16 || !['pc', 'tv'].includes(range)) return { mode: 'unavailable', filter: 'format=gbrp16le,lutrgb=r=0:g=0:b=0' };
  const eps = COLOR_THRESHOLDS.sourceWhiteToleranceCodes * 65535 / (2 ** bitDepth - 1);
  if (/^(?:yuv|yuva|nv12|p010|p016|yuyv|uyvy)/i.test(pixelFormat)) {
    const white = range === 'tv' ? 235 * 2 ** (bitDepth - 8) / (2 ** bitDepth - 1) * 65535 : 65535;
    // VideoToolbox can output semi-planar 10-bit surfaces. Planarize explicitly before extractplanes.
    return { mode: 'native-y-white-code-plateau', filter: `format=yuv444p16le,extractplanes=y,setrange=full,format=gray16le,lut=y='if(between(val,${white - eps},${white + eps}),65535,0)',setrange=full,format=gbrp16le` };
  }
  if (/^(?:gbrp|gbrap|rgb|bgr|rgba|bgra)/i.test(pixelFormat) && !/f32|f16/.test(pixelFormat) && range === 'pc') {
    const expr = `if(gte(r(X,Y),${65535 - eps})*gte(g(X,Y),${65535 - eps})*gte(b(X,Y),${65535 - eps}),65535,0)`;
    return { mode: 'native-rgb-code-ceiling', filter: `format=gbrp16le,geq=r='${expr}':g='${expr}':b='${expr}'` };
  }
  return { mode: 'unavailable', filter: 'format=gbrp16le,lutrgb=r=0:g=0:b=0' };
}

export async function measureColorTechnical(path: string, source: ColorTechnicalReport['source'], tools: IMediaToolConfig = {},
  onProgress?: (detail: string) => void): Promise<ColorTechnicalReport> {
  const report = emptyTechnical(source);
  if (source.blocker || !source.profile) return emptyTechnical(source, 0, source.blocker ?? '原片色彩解释未知');
  const ffmpeg = tools.ffmpegPath?.trim() || 'ffmpeg';
  try {
    const p = await probe(path, tools);
    if (!p.durationMs || !p.width || !p.height || !p.fps) return emptyTechnical(source, 0, '缺少视频时长/尺寸/帧率');
    report.probe = { width: p.width, height: p.height, displayWidth: p.displayWidth ?? p.width, displayHeight: p.displayHeight ?? p.height,
      fps: p.fps, durationMs: p.durationMs, rotationDegrees: p.rotationDegrees };
    report.decoder = (await promisify(execFile)(ffmpeg, ['-version'], { timeout: 10000 })).stdout.split('\n')[0];
    const input = toExecutableInputPath(path, ffmpeg), display = displayFilter(source.lutPath, ffmpeg);
    const ffprobe = tools.ffprobePath?.trim() || 'ffprobe';
    const stream = JSON.parse((await promisify(execFile)(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries',
      'stream=pix_fmt,color_range,color_space,color_transfer,color_primaries', '-of', 'json', toExecutableInputPath(path, ffprobe)], { timeout: 30000 })).stdout).streams?.[0];
    const hwaccel = tools.ffmpegHwaccel?.trim();
    const decodeInput = [...(hwaccel && hwaccel !== 'none' ? ['-hwaccel', hwaccel] : []), '-i', input];
    report.signal = { pixelFormat: stream?.pix_fmt, range: stream?.color_range, matrix: stream?.color_space,
      transfer: stream?.color_transfer, primaries: stream?.color_primaries, hwaccel: hwaccel || 'none' };
    if (source.profile === 'rec709' && ['smpte2084', 'arib-std-b67'].includes(stream?.color_transfer)) {
      return { ...emptyTechnical(source, p.durationMs, 'HDR transfer 元数据与 Rec.709 诊断解释冲突'), probe: report.probe, signal: report.signal, decoder: report.decoder };
    }
    const clipMask = sourceClipMask(stream?.pix_fmt ?? '', stream?.color_range ?? '', p.bitDepth);
    report.signal.clipProofMode = clipMask.mode;
    report.coverage.durationMs = p.durationMs; report.coverage.expectedBins = Math.ceil(p.durationMs / 1000);
    // Downsampling is only for broad spatial coverage. Native noise frames are decoded separately below.
    const overviewGraph = `[0:v:0]setpts=PTS-STARTPTS,fps=1:start_time=0:round=up,split=2[c][r];`
      + `[c]${clipMask.filter},scale=${W}:${H}:flags=area:in_range=full:out_range=full[mask];`
      + `[r]scale=${W}:${H}:flags=area,format=gbrp16le,split=2[s][d];[d]${display}[v];[s][v][mask]vstack=inputs=3,format=rgb48le[out]`;
    onProgress?.('全片曝光概览');
    await decodeFrames(ffmpeg, [...decodeInput, '-filter_complex', overviewGraph, '-map', '[out]', '-an', '-fps_mode', 'passthrough', '-f', 'rawvideo', '-pix_fmt', 'rgb48le', 'pipe:1'], W * H * 18, frame => {
      const startMs = report.overview.length * 1000;
      if (startMs >= p.durationMs!) return;
      let maskSum = 0;
      for (let i = 0; i < W * H; i++) maskSum += frame.readUInt16LE(W * H * 12 + i * 6) / 65535;
      report.overview.push({ startMs, endMs: Math.min(startMs + 1000, p.durationMs!), source: measureFrame(frame, W, H),
        display: measureFrame(frame, W, H, W * H * 6), sourceWhitePlateauFraction: maskSum / (W * H) });
      if (report.overview.length % 60 === 0) onProgress?.(`曝光概览 ${Math.min(startMs + 1000, p.durationMs!)} / ${p.durationMs} ms`);
    }, Math.max(120000, p.durationMs * 3));
    report.coverage.sampledBins = report.overview.length;
    report.coverage.ratio = Math.min(1, report.overview.reduce((total, s) => total + s.endMs - s.startMs, 0) / p.durationMs);
    const displayW = p.displayWidth ?? p.width, displayH = p.displayHeight ?? p.height;
    const scale = Math.min(1, HIGH_CONTRAST_THRESHOLDS.longEdge / Math.max(displayW, displayH));
    const contrastW = Math.max(2, Math.round(displayW * scale / 2) * 2), contrastH = Math.max(2, Math.round(displayH * scale / 2) * 2);
    report.contrastSampling = { width: contrastW, height: contrastH, fps: 1, round: 'up' };
    const contrastGraph = `[0:v:0]setpts=PTS-STARTPTS,fps=1:start_time=0:round=up,scale=${contrastW}:${contrastH}:flags=area,format=gbrp16le,${display},format=rgb48le[out]`;
    onProgress?.('全片逆光／大光比区域测量');
    await decodeFrames(ffmpeg, [...decodeInput, '-filter_complex', contrastGraph, '-map', '[out]', '-an', '-fps_mode', 'passthrough', '-f', 'rawvideo', 'pipe:1'], contrastW * contrastH * 6, frame => {
      const startMs = report.contrastOverview.length * 1000;
      if (startMs >= p.durationMs!) return;
      report.contrastOverview.push({ startMs, endMs: Math.min(startMs + 1000, p.durationMs!), metrics: measureHighContrastFrame(frame, contrastW, contrastH) });
      if (report.contrastOverview.length % 60 === 0) onProgress?.(`反差区域 ${Math.min(startMs + 1000, p.durationMs!)} / ${p.durationMs} ms`);
    }, Math.max(120000, p.durationMs * 4));
    if (displayW < CROP * 3 || displayH < CROP * 3 || p.durationMs < BURST / p.fps * 1000) {
      report.warnings.push('原片尺寸/长度不足以取得分离的原分辨率连续帧局部');
      return summarizeTechnical(report);
    }
    const crops = Array.from({ length: 9 }, (_, i) => {
      const x = Math.round((displayW - CROP) * (i % 3) / 2), y = Math.round((displayH - CROP) * Math.floor(i / 3) / 2);
      return `[c${i}]crop=${CROP}:${CROP}:${x}:${y}[p${i}]`;
    });
    const graph = `[0:v:0]format=gbrp16le,split=9${Array.from({ length: 9 }, (_, i) => `[c${i}]`).join('')};${crops.join(';')};`
      + `${Array.from({ length: 9 }, (_, i) => `[p${i}]`).join('')}xstack=inputs=9:layout=0_0|96_0|192_0|0_96|96_96|192_96|0_192|96_192|192_192,split=2[s][d];[d]${display}[v];[s][v]vstack=inputs=2,format=rgb48le[out]`;
    const count = Math.min(12, Math.max(3, Math.ceil(p.durationMs / 10000)));
    report.coverage.expectedNoiseBursts = count;
    for (let i = 0; i < count; i++) {
      const startMs = Math.max(0, Math.min(p.durationMs - BURST / p.fps * 1000, (i + 0.5) / count * p.durationMs));
      onProgress?.(`原分辨率噪声连续帧 ${i + 1}/${count}`);
      const frames: Buffer[] = [];
      await decodeFrames(ffmpeg, ['-ss', (startMs / 1000).toFixed(6), ...decodeInput, '-filter_complex', graph, '-map', '[out]', '-frames:v', String(BURST), '-an', '-fps_mode', 'passthrough', '-f', 'rawvideo', '-pix_fmt', 'rgb48le', 'pipe:1'], MOSAIC * MOSAIC * 12, frame => frames.push(frame), 90000);
      report.noiseSamples.push(measureNoiseBurst(frames, startMs, p.fps));
    }
    return summarizeTechnical(report);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    report.warnings.push(message);
    if (report.overview.length) return summarizeTechnical(report);
    report.exposure.reasons = [message]; report.noise.reasons = [message]; return report;
  }
}
