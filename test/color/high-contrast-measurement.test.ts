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

describe('experimental high-contrast evidence', () => {
  it('requires coherent bright and dark areas rather than a wide histogram alone', () => {
    expect(broad().broadRegions).toBe(true);
    const checker = frame((x, y) => (x + y) % 2 ? 0.8 : 0.1);
    expect(checker.brightArea).toBeCloseTo(0.5);
    expect(checker.darkArea).toBeCloseTo(0.5);
    expect(checker.paths).toEqual([]);
    for (const v of [0.05, 0.45, 0.95]) expect(frame(() => v).paths).toEqual([]);
  });

  it('accepts a small core with surrounding light and dark foreground, but rejects isolated lamps', () => {
    const sun = frame((x, y) => Math.hypot(x - 80, y - 20) < 3 ? 0.98 : y < 50 ? 0.4 : 0.1);
    expect(sun.broadRegions).toBe(false);
    expect(sun.compactSource).toBe(true);
    expect(sun.sources[0]!.area).toBeLessThan(0.01);
    const lamp = frame((x, y) => Math.hypot(x - 80, y - 20) < 3 ? 0.98 : 0.05);
    expect(lamp.paths).toEqual([]);
    // A source alone is insufficient if the scene has no substantial dark region.
    expect(frame((x, y) => Math.hypot(x - 80, y - 20) < 3 ? 0.98 : 0.4).paths).toEqual([]);
  });

  it('reports candidates, not physical illumination or light-source identity', () => {
    // A flat black/white object can have the same pixels as a lit foreground/background.
    const m = broad();
    const rows = [0, 1000, 2000].map(startMs => ({ startMs, endMs: startMs + 1000, metrics: m }));
    expect(summarizeHighContrastTrial(rows, 3000).state).toBe('candidate');
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

  it('requires sustained whole-clip coverage for production and preserves partial intervals for review', () => {
    const a = broad(), b = normal();
    const rows = Array.from({ length: 10 }, (_, i) => ({ startMs: i * 1000, endMs: (i + 1) * 1000, metrics: i < 8 ? a : b }));
    expect(summarizeHighContrast(rows, 10000)).toMatchObject({ state: 'detected', intervals: [{ startMs: 0, endMs: 8000 }] });
    rows[7]!.metrics = b;
    expect(summarizeHighContrast(rows, 10000).state).toBe('needs-review');
    rows[8]!.metrics = a; rows[9]!.metrics = a;
    expect(summarizeHighContrast(rows, 10000)).toMatchObject({ state: 'detected', intervals: [{ startMs: 0, endMs: 7000 }, { startMs: 8000, endMs: 10000 }] });
    expect(summarizeHighContrast(rows.slice(0, 8), 10000).state).toBe('unknown');
    const sourceOnly = frame((x, y) => Math.hypot(x - 80, y - 20) < 3 ? 0.98 : y < 50 ? 0.4 : 0.1);
    expect(summarizeHighContrast(rows.map(r => ({ ...r, metrics: sourceOnly })), 10000).state).toBe('not-observed');
  });

  it('excludes confirmed night scenes even with sustained broad contrast or a light with a halo', () => {
    const halo = frame((x, y) => Math.hypot(x - 80, y - 20) < 3 ? 0.98 : y < 50 ? 0.4 : 0.1);
    for (const metrics of [broad(), halo]) {
      const rows = Array.from({ length: 10 }, (_, i) => ({ startMs: i * 1000, endMs: (i + 1) * 1000, metrics }));
      const measurement = summarizeHighContrastTrial(rows, 10000), saved = structuredClone(measurement);
      expect(measurement.state).toBe('candidate');
      expect(applyHighContrastScenePolicy(measurement, 'night').state).toBe('excluded');
      expect(applyHighContrastScenePolicy(measurement, 'unknown').state).toBe('needs-review');
      expect(applyHighContrastScenePolicy(measurement, 'non-night').state).toBe('candidate');
      expect(measurement).toEqual(saved);
    }
  });
});
