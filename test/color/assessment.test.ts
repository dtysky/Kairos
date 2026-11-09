import { describe, expect, it } from 'vitest';
import { measureHighContrastFrame, summarizeHighContrast } from '../../src/modules/color/high-contrast-measurement.js';
import type { IColorInput } from '../../src/store/color-inputs.js';
import { buildSolarContext, solarDay, solarElevation } from '../../src/modules/color/solar-context.js';
import { emptyTechnical, measureFrame, measureNoiseBurst, summarizeTechnical, type ColorTechnicalReport } from '../../src/modules/color/technical-measurement.js';


function input(summary: string, type: NonNullable<IColorInput['facts']>['type'] = 'broll', speech = false): IColorInput {
  return { assetId: 'C001_camera', media: { kind: 'video', durationMs: 10000, capturedAt: '2026-10-01T04:00:00Z',
    width: 3840, height: 2160, displayWidth: 3840, displayHeight: 2160, rotationDegrees: 0, versions: {} },
    analysisStatus: 'current', reasons: [], facts: { type, summary, gps: { lat: 28, lng: 118, source: 'pharos', confidence: 1 },
      speech: { hasTranscript: speech, ranges: speech ? [{ startMs: 0, endMs: 10000 }] : [] }, visualWindows: [] },
    sources: { assetFingerprint: 'asset', reportPath: 'report' }, fingerprint: 'input', updatedAt: 'now' };
}
function image(width: number, height: number, value: (x: number, y: number) => number): Buffer {
  const b = Buffer.alloc(width * height * 6);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const v = Math.round(Math.max(0, Math.min(1, value(x, y))) * 65535);
    for (let c = 0; c < 3; c++) b.writeUInt16LE(v, (y * width + x) * 6 + c * 2);
  }
  return b;
}
function report(kind: 'wide' | 'sky' | 'lamp' | 'clean-dark' | 'normal-day' | 'bright-textured', profile = 'rec709') {
  const frame = image(192, 108, (x, y) => kind === 'sky' ? (y < 42 ? 1 : 0.3) : kind === 'lamp' ? (x < 12 && y < 12 ? 1 : 0.1)
    : kind === 'wide' ? (x % 16 < 13 ? 1 : 0.3) : kind === 'bright-textured' ? 0.8 + (x % 20) / 120
    : kind === 'normal-day' ? 0.2 + (x % 20) / 30 : 0.04);
  const m = measureFrame(frame, 192, 108);
  const r = emptyTechnical({ role: 'raw', contentHash: 'raw', profile }, 10000);
  r.probe = { width: 3840, height: 2160, displayWidth: 3840, displayHeight: 2160, rotationDegrees: 0, fps: 30, durationMs: 10000 };
  r.signal = { range: 'pc' };
  r.coverage = { mode: '1fps-full-duration', durationMs: 10000, sampledBins: 10, expectedBins: 10, ratio: 1, expectedNoiseBursts: 3 };
  r.overview = Array.from({ length: 10 }, (_, i) => ({ startMs: i * 1000, endMs: (i + 1) * 1000, source: m, display: m, sourceWhitePlateauFraction: kind === 'wide' ? 0.8 : 0 }));
  r.contrastOverview = r.overview.map(s => ({ startMs: s.startMs, endMs: s.endMs, metrics: measureHighContrastFrame(frame, 192, 108) }));
  r.noiseSamples = [1, 5, 9].map(i => ({ startMs: i * 1000, endMs: i * 1000 + 200, validPatches: 81, regions: 9, sourceSigma: 0, displaySigma: 0, state: 'not-observed' as const }));
  return summarizeTechnical(r);
}

describe('solar context', () => {
  it('handles timezone offsets, date boundaries, leap years and polar days without host timezone', () => {
    const a = input('室外山坡。'); a.media.capturedAt = '2026-10-02T16:50:23+08:00';
    const b = structuredClone(a); b.media.capturedAt = '2026-10-02T08:50:23Z';
    expect(buildSolarContext(a)).toEqual(buildSolarContext(b));
    const june = solarDay(Date.parse('2024-06-21T12:00:00Z'), 51.48, 0);
    expect(june.sunriseAt!.slice(11, 13)).toBe('03'); expect(june.sunsetAt!.slice(11, 13)).toBe('20');
    expect(solarDay(Date.parse('2024-06-21T12:00:00Z'), 80, 0).polar).toBe('day');
    expect(solarDay(Date.parse('2024-12-21T12:00:00Z'), 80, 0).polar).toBe('night');
    expect(solarDay(Date.parse('2026-10-01T23:00:00Z'), 28, 118).solarDate).toBe('2026-10-02');
    expect(solarElevation(Date.parse('2024-03-20T12:00:00Z'), 0, 0)).toBeGreaterThan(87);
  });
  it('refuses timezone-less times and uses an existing embedded point first', () => {
    const a = input('山坡。'); a.media.capturedAt = '2026-10-02T16:50:23';
    expect(buildSolarContext(a).status).toBe('unknown');
    a.media.capturedAt += 'Z'; a.media.embeddedGps = { originType: 'metadata', confidence: 1, representativeLat: 1, representativeLng: 2, representativeTime: a.media.capturedAt };
    expect(buildSolarContext(a).gps).toMatchObject({ lat: 1, lng: 2, source: 'embedded' });
  });
});

describe('technical scope and false positives', () => {
  it('detects broad over-brightness independently of source clipping, excluding sky/lamps/transient whites', () => {
    expect(report('wide').exposure.state).toBe('detected');
    expect(report('wide').sourceClipping.state).toBe('detected');
    expect(report('bright-textured').exposure.state).toBe('detected');
    expect(report('bright-textured').sourceClipping.state).toBe('not-observed');
    for (const k of ['sky', 'lamp', 'normal-day'] as const) expect(report(k).exposure.state).toBe('not-observed');
    for (const fraction of [0.75, 0.8, 0.9, 0.95]) {
      for (const level of [0.9, 1]) {
        const frame = measureFrame(image(192, 108, (_x, y) => y < 108 * fraction ? level : 0.3), 192, 108);
        expect(frame.broadWhite).toBe(false); expect(frame.broadOverbright).toBe(false);
      }
    }
    const r = report('sky'); r.overview[2] = report('wide').overview[2]!;
    expect(summarizeTechnical(r).exposure.state).toBe('not-observed');
    expect(report('wide', 'slog3').exposure.state).toBe('detected');
    expect(report('wide', 'slog3').sourceClipping.state).toBe('unknown');
    const transform = report('wide'); transform.overview.forEach(s => { s.source = report('bright-textured').overview[0]!.source; });
    expect(summarizeTechnical(transform).exposure.state).toBe('detected');
    expect(transform.sourceClipping.state).toBe('needs-review');
    const uniform = report('bright-textured');
    uniform.overview.forEach(s => { s.display = measureFrame(image(192, 108, () => 0.87), 192, 108); });
    expect(summarizeTechnical(uniform).exposure.state).toBe('needs-review');
  });
  it('retains sustained partial exposure intervals instead of requiring 98% of the entire clip', () => {
    const r = report('normal-day'), bright = report('bright-textured');
    for (const i of [3, 4, 5]) r.overview[i] = bright.overview[i]!;
    expect(summarizeTechnical(r).exposure).toMatchObject({state: 'detected', intervals: [{ startMs: 3000, endMs: 6000 }]});
  });
  it('estimates native temporal noise while rejecting coherent moving texture and drift', () => {
    let state = 991;
    const uniform = () => { state = (Math.imul(1664525, state) + 1013904223) >>> 0; return state / 4294967296; };
    const gaussian = () => Math.sqrt(-2 * Math.log(Math.max(1e-9, uniform()))) * Math.cos(2 * Math.PI * uniform());
    const burst = (value: (x: number, y: number, f: number) => number) => Array.from({ length: 6 }, (_, f) => {
      const native = image(288, 288, (x, y) => value(x, y, f)); return Buffer.concat([native, native]);
    });
    const noisy = measureNoiseBurst(burst(() => 0.07 + gaussian() * 0.018), 0, 30);
    expect(noisy.state).toBe('noisy'); expect(noisy.displaySigma).toBeGreaterThan(0.015);
    const correlated = Array.from({ length: 6 }, () => Array.from({ length: 144 * 144 }, () => 0.07 + gaussian() * 0.018));
    expect(measureNoiseBurst(burst((x, y, f) => correlated[f]![Math.floor(y / 2) * 144 + Math.floor(x / 2)]!), 0, 30).state).toBe('noisy');
    expect(measureNoiseBurst(burst(() => 0.05), 0, 30).state).toBe('not-observed');
    expect(measureNoiseBurst(burst(() => 0.45 + gaussian() * 0.005), 0, 30).state).toBe('noisy');
    expect(measureNoiseBurst(burst(() => 0.45 + gaussian() * 0.002), 0, 30).state).toBe('not-observed');
    expect(measureNoiseBurst(burst((x, y, f) => (x + y + f) % 2 ? 0.10 : 0.04), 0, 30).state).toBe('unknown');
    expect(measureNoiseBurst(burst((_x, _y, f) => 0.03 + f * 0.015), 0, 30).state).toBe('unknown');
  });
});
