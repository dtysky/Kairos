import { describe, expect, it } from 'vitest';
import { measureHighContrastFrame } from '../../src/modules/color/high-contrast-measurement.js';
import type { IColorInput } from '../../src/store/color-inputs.js';
import { classifyAnalyzedColor as classify } from '../../src/modules/color/classification.js';
import { buildSolarContext, solarDay, solarElevation } from '../../src/modules/color/solar-context.js';
import { emptyTechnical, measureFrame, measureNoiseBurst, summarizeTechnical, type ColorTechnicalReport } from '../../src/modules/color/technical-measurement.js';

const classifyAnalyzedColor = (a: IColorInput, t: ColorTechnicalReport = report('normal-day')) => classify(a, t);

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
  r.signal = { range: 'pc' };
  r.coverage = { mode: '1fps-full-duration', durationMs: 10000, sampledBins: 10, expectedBins: 10, ratio: 1, expectedNoiseBursts: 3 };
  r.overview = Array.from({ length: 10 }, (_, i) => ({ startMs: i * 1000, endMs: (i + 1) * 1000, source: m, display: m, sourceWhitePlateauFraction: kind === 'wide' ? 0.8 : 0 }));
  r.contrastOverview = r.overview.map(s => ({ startMs: s.startMs, endMs: s.endMs, metrics: measureHighContrastFrame(frame, 192, 108) }));
  r.noiseSamples = [1, 5, 9].map(i => ({ startMs: i * 1000, endMs: i * 1000 + 200, validPatches: 81, regions: 9, sourceSigma: 0, displaySigma: 0, state: 'not-observed' as const }));
  return summarizeTechnical(r);
}

describe('material scene rules', () => {
  it('routes measured high contrast through actual lighting context and preserves category priorities', () => {
    const measured = report('normal-day');
    measured.highContrast = { state: 'detected', reasons: ['whole-clip regions'], intervals: [{ startMs: 0, endMs: 10000 }] };
    const daylight = input('白天户外山坡，远处明亮天空。');
    expect(classifyAnalyzedColor(daylight, measured).category).toBe('high-contrast');
    const twilight = input('日出时户外山坡。'); twilight.facts!.gps = undefined;
    expect(classifyAnalyzedColor(twilight, measured).category).toBe('high-contrast');
    const night = input('夜间道路与路灯。', 'drive'); night.media.capturedAt = '2026-10-01T14:00:00Z';
    const decision = classifyAnalyzedColor(night, measured);
    expect(decision.category).toBe('night'); expect(decision.highContrast.state).toBe('excluded');
    expect(decision.highContrast.measurement.state).toBe('detected');
    const conflict = structuredClone(daylight); conflict.media.capturedAt = night.media.capturedAt;
    expect(classifyAnalyzedColor(conflict, measured).category).toBeNull();
    const interior = input('正常照明室内。'); interior.media.capturedAt = night.media.capturedAt;
    expect(classifyAnalyzedColor(interior, measured).highContrast.context).toBe('non-night');
    const partial = structuredClone(measured); partial.highContrast.state = 'needs-review';
    partial.highContrast.intervals = [{ startMs: 2000, endMs: 5000 }];
    expect(classifyAnalyzedColor(daylight, partial).category).toBeNull();
    expect(classifyAnalyzedColor(night, partial).category).toBe('night');
    expect(classifyAnalyzedColor(input('男子对着镜头讲述。', 'drive', true), measured).category).toBe('presenter');
    const portrait = structuredClone(daylight); portrait.media.displayWidth = 2160; portrait.media.displayHeight = 3840; portrait.media.rotationDegrees = 90;
    expect(classifyAnalyzedColor(portrait, measured).category).toBe('portrait');
    measured.noise.state = 'detected';
    expect(classifyAnalyzedColor(daylight, measured).category).toBe('noisy');
    expect(classifyAnalyzedColor(night, measured).category).toBe('noisy');
    measured.exposure.state = 'detected';
    expect(classifyAnalyzedColor(daylight, measured).category).toBe('overexposed');
  });
  it('recognizes externally filmed presenters and resolves drive/person conflict with description and speech', () => {
    expect(classifyAnalyzedColor(input('别人拍摄，男子正在讲解沿途的风景。', 'broll', true)).category).toBe('presenter');
    expect(classifyAnalyzedColor(input('A man is explaining the valley to his companion.', 'broll', true)).category).toBe('presenter');
    expect(classifyAnalyzedColor(input('车内男子对着镜头讲述旅行经历。', 'drive', true)).category).toBe('presenter');
    expect(classifyAnalyzedColor(input('A man in the driver’s seat is speaking directly to the camera.', 'drive', true)).category).toBe('presenter');
    expect(classifyAnalyzedColor(input('A presenter stands beside camera equipment on a mountain summit, speaking as the sun rises.', 'talking-head', true)).category).toBe('presenter');
  });
  it('does not confuse voiceover, silent people, negation or speculative eating footage with presenter', () => {
    expect(classifyAnalyzedColor(input('白天前方道路，伴随画外旁白。', 'drive', true)).category).toBe('day-drive-cast');
    expect(classifyAnalyzedColor(input('白天从车内透过挡风玻璃拍摄前方道路。', 'drive')).category).toBe('day-drive-cast');
    expect(classifyAnalyzedColor(input('白天街道上男子背影。', 'broll', true)).category).toBe('day');
    expect(classifyAnalyzedColor(input('A man appears to be explaining dishes to the camera.', 'broll', true)).category).toBeNull();
    expect(classifyAnalyzedColor(input('A man is not speaking to the camera.', 'talking-head', true)).category).toBeNull();
    expect(classifyAnalyzedColor(input('男子对着镜头说话。', 'broll', false)).category).toBeNull();
    expect(classifyAnalyzedColor(input('A presenter stands beside equipment, not speaking.', 'talking-head', true)).category).toBeNull();
    expect(classifyAnalyzedColor(input('A presenter stands beside equipment. Speaking is heard in voiceover.', 'talking-head', true)).category).toBeNull();
    expect(classifyAnalyzedColor(input('A presenter stands beside equipment, speaking.', 'broll', false)).category).toBeNull();
    expect(classifyAnalyzedColor(input('白天前方道路，只有旁白。', 'talking-head', true)).category).toBeNull();
    const partial = input('白天室外风景。');
    partial.facts!.visualWindows = [{ windowId: 'short', sourceInMs: 1000, sourceOutMs: 2000,
      visualObservation: '男子对着镜头说话。', speech: { hasTranscript: true, ranges: [{ startMs: 1000, endMs: 2000 }] } }];
    expect(classifyAnalyzedColor(partial).category).toBeNull();
  });
  it('uses portrait exclusively, flags orientation conflicts and never guesses a windshield from drive alone', () => {
    const a = input('男子对着镜头说话。', 'talking-head', true);
    a.media.displayWidth = 2160; a.media.displayHeight = 3840; a.media.rotationDegrees = 90;
    expect(classifyAnalyzedColor(a).category).toBe('portrait');
    a.media.rotationDegrees = 0; expect(classifyAnalyzedColor(a).category).toBeNull();
    expect(classifyAnalyzedColor(input('白天城市街道。', 'drive')).category).toBeNull();
  });
  it('does not turn indoor night into outdoor night and preserves transitions', () => {
    const a = input('灯光明亮的室内。'); a.media.capturedAt = '2026-10-01T14:00:00Z';
    expect(classifyAnalyzedColor(a).category).toBe('day');
    expect(classifyAnalyzedColor(input('白天车辆驶入地下停车库。', 'drive')).category).toBeNull();
    a.facts!.summary = '室外街道。'; expect(classifyAnalyzedColor(a).category).toBe('night');
    a.facts!.summary = '白天室外街道。'; expect(classifyAnalyzedColor(a).category).toBeNull();
  });
  it('does not turn technical words into measurements into high-contrast measurements', () => {
    const a = input('明显过曝、高噪点、强逆光、严重偏色。');
    const result = classifyAnalyzedColor(a);
    expect(result.category).toBeNull(); expect(result.status).toBe('needs-review');
    expect(result.reviewFlags.join(' ')).toContain('未检测');
  });
});

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
    expect(classifyAnalyzedColor(input('白墙背景。'), report('wide')).category).toBeNull();
    const uniform = report('bright-textured');
    uniform.overview.forEach(s => { s.display = measureFrame(image(192, 108, () => 0.87), 192, 108); });
    expect(summarizeTechnical(uniform).exposure.state).toBe('needs-review');
  });
  it('retains sustained partial exposure intervals instead of requiring 98% of the entire clip', () => {
    const r = report('normal-day'), bright = report('bright-textured');
    for (const i of [3, 4, 5]) r.overview[i] = bright.overview[i]!;
    expect(summarizeTechnical(r).exposure).toMatchObject({state: 'detected', intervals: [{ startMs: 3000, endMs: 6000 }]});
    expect(classifyAnalyzedColor(input('白天前方道路。', 'drive'), r).category).toBe('overexposed');
  });
  it('classifies measured noise independently of brightness and does not call an incomplete scan negative', () => {
    const a = input('夜间室外道路。'); a.media.capturedAt = '2026-10-01T14:00:00Z';
    const clean = report('clean-dark'); expect(classifyAnalyzedColor(a, clean).category).toBe('night');
    clean.noise.state = 'detected'; expect(classifyAnalyzedColor(a, clean).category).toBe('noisy');
    const daylight = report('normal-day'); daylight.noise.state = 'detected';
    expect(classifyAnalyzedColor(input('白天前方道路。', 'drive'), daylight).category).toBe('noisy');
    expect(classifyAnalyzedColor(input('日出时室外山坡。'), daylight).category).toBe('noisy');
    expect(classifyAnalyzedColor(input('男子对着镜头说话。', 'talking-head', true), daylight).category).toBe('presenter');
    const portrait = input('白天前方道路。', 'drive'); portrait.media.displayWidth = 2160; portrait.media.displayHeight = 3840; portrait.media.rotationDegrees = 90;
    expect(classifyAnalyzedColor(portrait, daylight).category).toBe('portrait');
    const overbright = report('bright-textured'); overbright.noise.state = 'detected';
    expect(classifyAnalyzedColor(input('白天前方道路。', 'drive'), overbright).category).toBe('overexposed');
    clean.noise.state = 'unknown'; expect(classifyAnalyzedColor(a, clean).reviewFlags).toContain('噪声测量未知');
    clean.overview = clean.overview.slice(0, 2); expect(summarizeTechnical(clean).exposure.state).toBe('unknown');
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
