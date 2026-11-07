import { z } from 'zod';
/** Unified spatial contrast evidence; scene-level night exclusion is applied separately. */
export const HIGH_CONTRAST_TRIAL_VERSION = 'high-contrast-trial-v2';
export const HIGH_CONTRAST_THRESHOLDS = {
  version: 'unified-regions-v1', longEdge: 768, fps: 1, dark: 0.18, bright: 0.68,
  darkRegionArea: 0.1, regionGap: 0.5, minRegionPixels: 3,
} as const;
export const HIGH_CONTRAST_AGGREGATION_POLICY = {
  version: 'dominant-duration-v1', minIntervalMs: 3000, minimumCoverage: 0.98, majorityFraction: 0.5,
} as const;
export interface ContrastRegion {
  area: number; x: number; y: number; width: number; height: number; mean: number;
}
export interface ContrastFrame {
  darkArea: number; brightArea: number; midArea: number;
  darkMedian: number; brightMedian: number; p10: number; p50: number; p90: number;
  darkRegions: ContrastRegion[]; brightRegions: ContrastRegion[];
  regionGap: number | null; hasContrast: boolean;
}
const region = z.object({ area: z.number(), x: z.number(), y: z.number(), width: z.number(), height: z.number(), mean: z.number() });
export const IContrastFrame = z.object({
  darkArea: z.number(), brightArea: z.number(), midArea: z.number(), darkMedian: z.number(), brightMedian: z.number(),
  p10: z.number(), p50: z.number(), p90: z.number(), darkRegions: z.array(region), brightRegions: z.array(region),
  regionGap: z.number().nullable(), hasContrast: z.boolean(),
});
function quantile(values: Float32Array | number[], q: number) {
  if (!values.length) return 0;
  const histogram = new Uint32Array(1024);
  for (const v of values) histogram[Math.max(0, Math.min(1023, Math.floor(v * 1023)))]!++;
  const target = Math.floor((values.length - 1) * q); let count = 0;
  for (let i = 0; i < histogram.length; i++) { count += histogram[i]!; if (count > target) return i / 1023; }
  return 1;
}
function regions(mask: Uint8Array, luma: Float32Array, width: number, height: number): ContrastRegion[] {
  const seen = new Uint8Array(mask.length), queue = new Int32Array(mask.length), result: ContrastRegion[] = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;
    let head = 0, tail = 1, total = 0, left = width, right = 0, top = height, bottom = 0;
    queue[0] = start; seen[start] = 1;
    while (head < tail) {
      const i = queue[head++]!, x = i % width, y = Math.floor(i / width);
      left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y); total += luma[i]!;
      const visit = (n: number) => { if (mask[n] && !seen[n]) { seen[n] = 1; queue[tail++] = n; } };
      if (x) visit(i - 1); if (x + 1 < width) visit(i + 1);
      if (y) visit(i - width); if (y + 1 < height) visit(i + width);
    }
    if (tail >= HIGH_CONTRAST_THRESHOLDS.minRegionPixels) result.push({ area: tail / mask.length, x: left / width, y: top / height,
      width: (right - left + 1) / width, height: (bottom - top + 1) / height, mean: total / tail });
  }
  return result.sort((a, b) => b.area - a.area);
}

/** Shared predicate also permits read-only comparison against recorded region statistics. */
export function evaluateContrastRegions(darkRegions: ContrastRegion[], brightRegions: ContrastRegion[]) {
  const darkRegion = darkRegions[0], brightRegion = brightRegions[0];
  const regionGap = darkRegion && brightRegion ? brightRegion.mean - darkRegion.mean : null;
  const hasContrast = Boolean(darkRegion && brightRegion && darkRegion.area >= HIGH_CONTRAST_THRESHOLDS.darkRegionArea
    && regionGap !== null && regionGap >= HIGH_CONTRAST_THRESHOLDS.regionGap);
  return { regionGap, hasContrast };
}

/** Full-range RGB48LE after a known diagnostic display transform. No filename or semantic labels. */
export function measureHighContrastFrame(frame: Buffer, width: number, height: number): ContrastFrame {
  const n = width * height;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || frame.length !== n * 6) throw new Error('Invalid RGB48 contrast frame');
  const t = HIGH_CONTRAST_THRESHOLDS, luma = new Float32Array(n);
  const dark = new Uint8Array(n), bright = new Uint8Array(n);
  const darkValues: number[] = [], brightValues: number[] = []; let mid = 0;
  for (let i = 0; i < n; i++) {
    const o = i * 6, v = (0.2126 * frame.readUInt16LE(o) + 0.7152 * frame.readUInt16LE(o + 2) + 0.0722 * frame.readUInt16LE(o + 4)) / 65535;
    luma[i] = v;
    if (v < t.dark) { dark[i] = 1; darkValues.push(v); }
    if (v >= t.bright) { bright[i] = 1; brightValues.push(v); }
    if (v >= 0.3 && v < t.bright) mid++;
  }
  const darkRegions = regions(dark, luma, width, height), brightRegions = regions(bright, luma, width, height);
  const darkArea = darkValues.length / n, brightArea = brightValues.length / n;
  const darkMedian = quantile(darkValues, 0.5), brightMedian = quantile(brightValues, 0.5);
  const { regionGap, hasContrast } = evaluateContrastRegions(darkRegions, brightRegions);
  return { darkArea, brightArea, midArea: mid / n, darkMedian, brightMedian,
    p10: quantile(luma, 0.1), p50: quantile(luma, 0.5), p90: quantile(luma, 0.9),
    darkRegions: darkRegions.slice(0, 3), brightRegions: brightRegions.slice(0, 3), regionGap, hasContrast };
}

export function summarizeHighContrastTrial(rows: Array<{ startMs: number; endMs: number; metrics: ContrastFrame }>, durationMs: number) {
  if (!Number.isFinite(durationMs) || durationMs <= 0) throw new Error('Invalid contrast duration');
  if (rows.some(r => !Number.isFinite(r.startMs) || !Number.isFinite(r.endMs) || r.startMs < 0
    || r.endMs <= r.startMs || r.endMs > durationMs)) throw new Error('Invalid contrast sample range');
  const ordered = [...rows].sort((a, b) => a.startMs - b.startMs);
  // Coverage is the union of actual sampled bins. Duplicates must never hide a missing section.
  let covered = 0, coveredEnd = 0;
  for (const r of ordered) {
    covered += Math.max(0, r.endMs - Math.max(coveredEnd, r.startMs));
    coveredEnd = Math.max(coveredEnd, r.endMs);
  }
  const intervals: Array<{ startMs: number; endMs: number }> = [];
  for (const r of ordered.filter(r => r.metrics.hasContrast)) {
    const last = intervals.at(-1);
    if (last && r.startMs <= last.endMs) last.endMs = Math.max(last.endMs, r.endMs);
    else intervals.push({ startMs: r.startMs, endMs: r.endMs });
  }
  const sustained = intervals.filter(r => r.endMs - r.startMs >= Math.min(durationMs, HIGH_CONTRAST_AGGREGATION_POLICY.minIntervalMs));
  const coverage = Math.min(1, covered / durationMs);
  return { state: coverage < HIGH_CONTRAST_AGGREGATION_POLICY.minimumCoverage ? 'unknown' : sustained.length ? 'candidate' : 'not-observed',
    coverage, coveredDurationMs: covered, sampledFrames: rows.length, candidateFrames: rows.filter(r => r.metrics.hasContrast).length,
    candidateFraction: rows.filter(r => r.metrics.hasContrast).length / Math.max(1, rows.length), intervals: sustained };
}

/** Classify by dominant duration; minority intervals remain supplemental evidence. */
export function summarizeHighContrast(rows: Array<{ startMs: number; endMs: number; metrics: ContrastFrame }>, durationMs: number) {
  if (!(durationMs > 0)) return { state: 'unknown' as const, reasons: ['反差采样时长未知'], intervals: [] };
  const summary = summarizeHighContrastTrial(rows, durationMs);
  const positiveRanges: Array<{ startMs: number; endMs: number }> = [];
  for (const row of rows.filter(r => r.metrics.hasContrast).sort((a, b) => a.startMs - b.startMs)) {
    const last = positiveRanges.at(-1);
    if (last && row.startMs <= last.endMs) last.endMs = Math.max(last.endMs, row.endMs);
    else positiveRanges.push({ startMs: row.startMs, endMs: row.endMs });
  }
  const positiveDurationMs = positiveRanges.reduce((n, r) => n + r.endMs - r.startMs, 0);
  const observedDurationMs = summary.coveredDurationMs;
  const negativeDurationMs = Math.max(0, observedDurationMs - positiveDurationMs);
  const positiveFraction = positiveDurationMs / durationMs, negativeFraction = negativeDurationMs / durationMs;
  const majority = HIGH_CONTRAST_AGGREGATION_POLICY.majorityFraction;
  // Missing time is unknown, never counted as normal footage to manufacture a majority.
  const ambiguousCoverage = summary.coverage < 1 && positiveFraction <= majority && negativeFraction <= majority;
  const state = summary.state === 'unknown' || ambiguousCoverage ? 'unknown' : !summary.intervals.length ? 'not-observed'
    : positiveFraction > majority ? 'detected' : 'not-dominant';
  return { state: state as 'unknown' | 'not-observed' | 'detected' | 'not-dominant', intervals: positiveRanges,
    aggregation: { policyVersion: HIGH_CONTRAST_AGGREGATION_POLICY.version, positiveDurationMs, negativeDurationMs,
      unobservedDurationMs: Math.max(0, durationMs - observedDurationMs), positiveFraction, negativeFraction },
    reasons: [state === 'unknown' ? '反差采样覆盖不足或缺测区间可能改变多数结论' : state === 'not-observed' ? '未检出有连贯暗部支持的持续亮暗反差'
      : state === 'detected' ? `持续亮暗反差占多数（${(positiveFraction * 100).toFixed(1)}%）；分类仍须排除夜景并检查上下文`
        : `亮暗反差未占多数（${(positiveFraction * 100).toFixed(1)}%）；按基础场景归类，局部区间保留为附加问题`] };
}

/** Category eligibility, separate from pixels. Context must be resolved from existing scene facts;
 * night capture time alone is insufficient (e.g. a normally lit interior). Unknown includes conflicts/transitions.
 * Night is excluded regardless of measured contrast or source size. Never overwrite the raw measurements.
 */
export function applyHighContrastScenePolicy<T extends { state: string }>(
  measurement: T,
  context: 'night' | 'non-night' | 'unknown',
) {
  return {
    policyVersion: 'high-contrast-scene-v1' as const,
    context,
    state: context === 'night' ? 'excluded' : context === 'unknown' ? 'needs-review' : measurement.state,
    reason: context === 'night' ? '夜景不纳入逆光／大光比，数值反差不覆盖该排除规则'
      : context === 'unknown' ? '日夜场景未知、冲突或存在变化，不能默认非夜景'
        : '已确认非夜景，继续采用测量候选状态；不代表需要调色修正',
    measurement,
  };
}
