import { describe, expect, it } from 'vitest';
import { applyHighContrastScenePolicy, measureHighContrastFrame, summarizeHighContrastTrial, summarizeHighContrast } from '../../src/modules/color/high-contrast-measurement.js';

const width = 160, height = 90;
function frame(pixel: (x: number, y: number) => number) {
  const buffer = Buffer.alloc(width * height * 6);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const v = Math.round(pixel(x, y) * 65535), offset = (y * width + x) * 6;
    for (let c = 0; c < 3; c++) buffer.writeUInt16LE(v, offset + c * 2);
  }
  return measureHighContrastFrame(buffer, width, height);
}
const normal = () => frame(() => 0.45);
const broad = () => frame((_x, y) => y < 35 ? 0.8 : 0.1);

describe('unified high-contrast evidence', () => {
  it('requires coherent bright and dark areas rather than a wide histogram alone', () => {
    expect(broad().hasContrast).toBe(true);
    const checker = frame((x, y) => (x + y) % 2 ? 0.8 : 0.1);
    expect(checker.brightArea).toBeCloseTo(0.5);
    expect(checker.darkArea).toBeCloseTo(0.5);
    expect(checker.hasContrast).toBe(false);
    for (const v of [0.05, 0.45, 0.95]) expect(frame(() => v).hasContrast).toBe(false);
  });

  it('uses one predicate for small and large sources, leaving night exclusion to scene policy', () => {
    const sun = frame((x, y) => Math.hypot(x - 80, y - 20) < 3 ? 0.98 : y < 50 ? 0.4 : 0.1);
    expect(sun.hasContrast).toBe(true);
    expect(sun.brightRegions[0]!.area).toBeLessThan(0.01);
    const lamp = frame((x, y) => Math.hypot(x - 80, y - 20) < 3 ? 0.98 : 0.05);
    expect(lamp.hasContrast).toBe(true);
    // A source alone is insufficient if the scene has no substantial dark region.
    expect(frame((x, y) => Math.hypot(x - 80, y - 20) < 3 ? 0.98 : 0.4).hasContrast).toBe(false);
    // A tiny reflection plus incidental shadows is not a supported dark foreground.
    expect(frame((x, y) => y < 4 ? 0.1 : Math.hypot(x - 80, y - 20) < 3 ? 0.98 : 0.4).hasContrast).toBe(false);
    // Isolated sampling noise cannot create a coherent bright region.
    expect(frame((x, y) => x === 80 && y === 20 ? 1 : 0.1).hasContrast).toBe(false);
  });

  it('reports candidates, not physical illumination or light-source identity', () => {
    // A flat black/white object can have the same pixels as a lit foreground/background.
    const m = broad();
    const rows = [0, 1000, 2000].map(startMs => ({ startMs, endMs: startMs + 1000, metrics: m }));
    expect(summarizeHighContrastTrial(rows, 3000).state).toBe('candidate');
  });

  it('covers a small sunset highlight and coherent foreground without the old area quotas', () => {
    const sunset = frame((_x, y) => y < 3 ? 0.72 : y >= 80 ? 0.12 : 0.4);
    expect(sunset.brightArea).toBeLessThan(0.06);
    expect(sunset.darkArea).toBeLessThan(0.2);
    expect(sunset.hasContrast).toBe(true);
    expect(summarizeHighContrast([0, 1000, 2000].map(startMs => ({ startMs, endMs: startMs + 1000, metrics: sunset })), 3000).state).toBe('detected');
  });

  it('preserves sustained intervals and does not bridge isolated flashes or missing samples', () => {
    const a = broad(), b = normal();
    const rows = Array.from({ length: 8 }, (_, i) => ({ startMs: i * 1000, endMs: (i + 1) * 1000, metrics: [0, 2, 3, 4, 7].includes(i) ? a : b }));
    expect(summarizeHighContrastTrial(rows.reverse(), 8000)).toMatchObject({
      state: 'candidate', coverage: 1, intervals: [{ startMs: 2000, endMs: 5000 }],
    });
    const missing = rows.filter(r => r.startMs !== 3000);
    missing.push(rows.find(r => r.startMs === 0)!);
    expect(summarizeHighContrastTrial(missing, 8000)).toMatchObject({ state: 'unknown', coverage: 0.875, intervals: [] });
    expect(summarizeHighContrastTrial([], 8000).state).toBe('unknown');
    expect(summarizeHighContrastTrial([{ startMs: 0, endMs: 750, metrics: a }], 750).state).toBe('candidate');
  });

  it('rejects invalid buffers and out-of-bounds sample ranges', () => {
    expect(() => measureHighContrastFrame(Buffer.alloc(6), 1.5, 1)).toThrow();
    expect(() => measureHighContrastFrame(Buffer.alloc(5), 1, 1)).toThrow();
    expect(() => summarizeHighContrastTrial([], 0)).toThrow();
    expect(() => summarizeHighContrastTrial([{ startMs: 0, endMs: 1100, metrics: normal() }], 1000)).toThrow();
  });

  it('uses dominant source duration and retains minority intervals without forcing review', () => {
    const a = broad(), b = normal();
    const rows = Array.from({ length: 10 }, (_, i) => ({ startMs: i * 1000, endMs: (i + 1) * 1000, metrics: i < 6 ? a : b }));
    expect(summarizeHighContrast(rows, 10000)).toMatchObject({ state: 'detected', intervals: [{ startMs: 0, endMs: 6000 }],
      aggregation: { policyVersion: 'dominant-duration-v1', positiveFraction: 0.6, negativeFraction: 0.4, unobservedDurationMs: 0 } });
    rows[5]!.metrics = b;
    expect(summarizeHighContrast(rows, 10000)).toMatchObject({ state: 'not-dominant', aggregation: { positiveFraction: 0.5 } });
    rows[4]!.metrics = b;
    expect(summarizeHighContrast(rows, 10000)).toMatchObject({ state: 'not-dominant', intervals: [{ startMs: 0, endMs: 4000 }],
      aggregation: { positiveFraction: 0.4, negativeFraction: 0.6 } });
    rows[8]!.metrics = a; rows[9]!.metrics = a;
    expect(summarizeHighContrast(rows, 10000)).toMatchObject({ state: 'detected', intervals: [{ startMs: 0, endMs: 4000 }, { startMs: 8000, endMs: 10000 }] });
    expect(summarizeHighContrast(rows.slice(0, 8), 10000).state).toBe('unknown');
    const sourceOnly = frame((x, y) => Math.hypot(x - 80, y - 20) < 3 ? 0.98 : y < 50 ? 0.4 : 0.1);
    expect(summarizeHighContrast(rows.map(r => ({ ...r, metrics: sourceOnly })), 10000).state).toBe('detected');
  });

  it('counts time unions, not frame counts or duplicate bins, and requires sustained evidence', () => {
    const a = broad(), b = normal();
    const rows = Array.from({ length: 9 }, (_, i) => ({ startMs: i * 1000, endMs: Math.min((i + 1) * 1000, 8100), metrics: i < 4 || i === 8 ? a : b }));
    // Five positive frames out of nine, but the final positive bin is only 100 ms.
    expect(summarizeHighContrast(rows, 8100)).toMatchObject({ state: 'detected', aggregation: { positiveDurationMs: 4100, negativeDurationMs: 4000 } });
    rows[7]!.metrics = a; rows[0]!.metrics = b;
    rows[8]!.metrics = b;
    expect(summarizeHighContrast([...rows, ...rows.filter(r => r.metrics.hasContrast)], 8100)).toMatchObject({
      state: 'not-dominant', aggregation: { positiveDurationMs: 4000, negativeDurationMs: 4100 } });
    const flashes = Array.from({ length: 10 }, (_, i) => ({ startMs: i * 1000, endMs: (i + 1) * 1000, metrics: i % 3 < 2 ? a : b }));
    expect(summarizeHighContrast(flashes, 10000)).toMatchObject({ state: 'not-observed', aggregation: { positiveFraction: 0.7 } });
  });

  it('does not turn missing coverage into votes for normal footage or bridge a gap', () => {
    const a = broad(), b = normal();
    const rows = [{ startMs: 0, endMs: 4900, metrics: a }, { startMs: 5100, endMs: 10000, metrics: b }];
    expect(summarizeHighContrast(rows, 10000)).toMatchObject({ state: 'unknown', aggregation: { unobservedDurationMs: 200 } });
    rows[0]!.endMs = 5100; rows[1]!.startMs = 5300;
    expect(summarizeHighContrast(rows, 10000).state).toBe('detected');
    rows[0]!.endMs = 4700; rows[1]!.startMs = 4900;
    expect(summarizeHighContrast(rows, 10000).state).toBe('not-dominant');
    expect(summarizeHighContrast([{ startMs: 0, endMs: 1499.5, metrics: a }, { startMs: 1500, endMs: 3000, metrics: a }], 3000))
      .toMatchObject({ state: 'not-observed', aggregation: { positiveDurationMs: 2999.5, unobservedDurationMs: 0.5 } });
  });

  it('excludes confirmed night scenes even with sustained broad contrast or a light with a halo', () => {
    const halo = frame((x, y) => Math.hypot(x - 80, y - 20) < 3 ? 0.98 : y < 50 ? 0.4 : 0.1);
    for (const metrics of [broad(), halo]) {
      const rows = Array.from({ length: 10 }, (_, i) => ({ startMs: i * 1000, endMs: (i + 1) * 1000, metrics }));
      const measurement = summarizeHighContrast(rows, 10000), saved = structuredClone(measurement);
      expect(measurement.state).toBe('detected');
      expect(applyHighContrastScenePolicy(measurement, 'night').state).toBe('excluded');
      expect(applyHighContrastScenePolicy(measurement, 'unknown').state).toBe('needs-review');
      expect(applyHighContrastScenePolicy(measurement, 'non-night').state).toBe('detected');
      expect(measurement).toEqual(saved);
    }
  });
});
