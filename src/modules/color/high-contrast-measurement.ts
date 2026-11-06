/** Experimental image evidence for calibration, not a physical sun/subject detector. */
export const HIGH_CONTRAST_TRIAL_VERSION = 'high-contrast-trial-v1';
export const HIGH_CONTRAST_THRESHOLDS = {
  longEdge: 768, fps: 1, dark: 0.18, bright: 0.68, core: 0.88,
  darkArea: 0.2, brightArea: 0.06, darkRegionArea: 0.12, brightRegionArea: 0.025,
  regionGap: 0.5, coreMinPixels: 3, coreMaxArea: 0.02,
  haloMedian: 0.3, ambientMidArea: 0.15, minIntervalMs: 3000,
} as const;
export interface ContrastRegion {
  area: number; x: number; y: number; width: number; height: number; mean: number;
}
export interface ContrastFrame {
  darkArea: number; brightArea: number; midArea: number;
  darkMedian: number; brightMedian: number; p10: number; p50: number; p90: number;
  darkRegions: ContrastRegion[]; brightRegions: ContrastRegion[];
  sources: Array<ContrastRegion & { haloMedian: number; coreToHalo: number; supported: boolean }>;
  broadRegions: boolean; compactSource: boolean; compactSourceWithoutAmbient: boolean;
  paths: Array<'broad-regions' | 'compact-source'>;
}
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
    if (tail >= HIGH_CONTRAST_THRESHOLDS.coreMinPixels) result.push({ area: tail / mask.length, x: left / width, y: top / height,
      width: (right - left + 1) / width, height: (bottom - top + 1) / height, mean: total / tail });
  }
  return result.sort((a, b) => b.area - a.area);
}

/** Full-range RGB48LE after a known diagnostic display transform. No filename or semantic labels. */
export function measureHighContrastFrame(frame: Buffer, width: number, height: number): ContrastFrame {
  const n = width * height;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || frame.length !== n * 6) throw new Error('Invalid RGB48 contrast frame');
  const t = HIGH_CONTRAST_THRESHOLDS, luma = new Float32Array(n);
  const dark = new Uint8Array(n), bright = new Uint8Array(n), core = new Uint8Array(n);
  const darkValues: number[] = [], brightValues: number[] = []; let mid = 0;
  for (let i = 0; i < n; i++) {
    const o = i * 6, v = (0.2126 * frame.readUInt16LE(o) + 0.7152 * frame.readUInt16LE(o + 2) + 0.0722 * frame.readUInt16LE(o + 4)) / 65535;
    luma[i] = v;
    if (v < t.dark) { dark[i] = 1; darkValues.push(v); }
    if (v >= t.bright) { bright[i] = 1; brightValues.push(v); }
    if (v >= t.core) core[i] = 1;
    if (v >= 0.3 && v < t.bright) mid++;
  }
  const darkRegions = regions(dark, luma, width, height), brightRegions = regions(bright, luma, width, height);
  const darkArea = darkValues.length / n, brightArea = brightValues.length / n;
  const darkMedian = quantile(darkValues, 0.5), brightMedian = quantile(brightValues, 0.5);
  const broadRegions = darkArea >= t.darkArea && brightArea >= t.brightArea
    && (darkRegions[0]?.area ?? 0) >= t.darkRegionArea && (brightRegions[0]?.area ?? 0) >= t.brightRegionArea
    && brightMedian - darkMedian >= t.regionGap;
  const sources = regions(core, luma, width, height).filter(r => r.area <= t.coreMaxArea).slice(0, 8).map(r => {
    const cx = (r.x + r.width / 2) * width, cy = (r.y + r.height / 2) * height;
    const radius = Math.max(5, Math.max(r.width * width, r.height * height) / 2), halo: number[] = [];
    for (let y = Math.max(0, Math.floor(cy - radius * 3)); y < Math.min(height, cy + radius * 3); y++) {
      for (let x = Math.max(0, Math.floor(cx - radius * 3)); x < Math.min(width, cx + radius * 3); x++) {
        const distance = Math.hypot(x - cx, y - cy);
        if (distance > radius * 1.5 && distance <= radius * 3) halo.push(luma[y * width + x]!);
      }
    }
    const haloMedian = quantile(halo, 0.5);
    return { ...r, haloMedian, coreToHalo: r.mean - haloMedian,
      supported: haloMedian >= t.haloMedian && r.mean - darkMedian >= t.regionGap
        && darkArea >= t.darkArea && (darkRegions[0]?.area ?? 0) >= t.darkRegionArea };
  });
  const compactSourceWithoutAmbient = sources.some(s => s.supported), midArea = mid / n;
  const compactSource = compactSourceWithoutAmbient && midArea >= t.ambientMidArea;
  return { darkArea, brightArea, midArea, darkMedian, brightMedian, p10: quantile(luma, 0.1), p50: quantile(luma, 0.5), p90: quantile(luma, 0.9),
    darkRegions: darkRegions.slice(0, 3), brightRegions: brightRegions.slice(0, 3), sources,
    broadRegions, compactSource, compactSourceWithoutAmbient,
    paths: [...(broadRegions ? ['broad-regions' as const] : []), ...(compactSource ? ['compact-source' as const] : [])] };
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
  for (const r of ordered.filter(r => r.metrics.paths.length)) {
    const last = intervals.at(-1);
    if (last && r.startMs <= last.endMs + 1) last.endMs = Math.max(last.endMs, r.endMs);
    else intervals.push({ startMs: r.startMs, endMs: r.endMs });
  }
  const sustained = intervals.filter(r => r.endMs - r.startMs >= Math.min(durationMs, HIGH_CONTRAST_THRESHOLDS.minIntervalMs));
  const coverage = Math.min(1, covered / durationMs);
  return { state: coverage < 0.98 ? 'unknown' : sustained.length ? 'candidate' : 'not-observed',
    coverage, sampledFrames: rows.length, candidateFrames: rows.filter(r => r.metrics.paths.length).length,
    candidateFraction: rows.filter(r => r.metrics.paths.length).length / Math.max(1, rows.length), intervals: sustained };
}

/** Category eligibility, separate from pixels. Context must be resolved from existing scene facts;
 * night capture time alone is insufficient (e.g. a normally lit interior). Unknown includes conflicts/transitions.
 * Night is excluded regardless of which measurement path fired. Never overwrite the raw measurements.
 */
export function applyHighContrastScenePolicy(
  measurement: ReturnType<typeof summarizeHighContrastTrial>,
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
