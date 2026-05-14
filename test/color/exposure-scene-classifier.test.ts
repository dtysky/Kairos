import { describe, expect, it } from 'vitest';
import { classifyRgbFrameExposureScene } from '../../src/modules/color/exposure-scene-classifier.js';

type TRgb = [number, number, number];

function frame(width: number, height: number, fill: (x: number, y: number) => TRgb): Buffer {
  const buffer = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [red, green, blue] = fill(x, y);
      const offset = ((y * width) + x) * 3;
      buffer[offset] = toByte(red);
      buffer[offset + 1] = toByte(green);
      buffer[offset + 2] = toByte(blue);
    }
  }
  return buffer;
}

function toByte(value: number): number {
  return Math.round(Math.min(1, Math.max(0, value)) * 255);
}

describe('exposure scene classifier', () => {
  it('keeps a midtone frame normal', () => {
    const result = classifyRgbFrameExposureScene({
      buffer: frame(40, 20, () => [0.5, 0.5, 0.5]),
      width: 40,
      height: 20,
    });

    expect(result.exposureSceneClass).toBe('normal');
    expect(result.midtoneFraction).toBeGreaterThan(0.9);
  });

  it('classifies obvious high dynamic range frames as high contrast', () => {
    const result = classifyRgbFrameExposureScene({
      buffer: frame(40, 20, (_x, y) => (y < 10 ? [0.05, 0.05, 0.05] : [0.92, 0.92, 0.92])),
      width: 40,
      height: 20,
    });

    expect(result.exposureSceneClass).toBe('high-contrast');
    expect(result.confidence).toBeGreaterThan(0.65);
    expect(result.shadowFraction).toBeGreaterThan(0.4);
    expect(result.brightFraction).toBeGreaterThan(0.4);
  });

  it('classifies backlit frames with narrow highlights as high contrast', () => {
    const result = classifyRgbFrameExposureScene({
      buffer: frame(40, 20, (_x, y) => {
        if (y < 4) return [0.04, 0.04, 0.04];
        if (y >= 18) return [0.79, 0.79, 0.77];
        return [0.50, 0.52, 0.50];
      }),
      width: 40,
      height: 20,
    });

    expect(result.exposureSceneClass).toBe('high-contrast');
    expect(result.exposureSceneReason).toBe('backlit-high-contrast');
    expect(result.confidence).toBeGreaterThan(0.65);
    expect(result.brightFraction).toBeLessThan(0.05);
    expect(result.lumaSpread).toBeGreaterThan(0.70);
  });

  it('classifies cabin window backlight with compact tails as high contrast', () => {
    const result = classifyRgbFrameExposureScene({
      buffer: frame(40, 20, (_x, y) => {
        if (y < 2) return [0.06, 0.06, 0.06];
        if (y < 5) return [0.14, 0.14, 0.14];
        if (y >= 16) return [0.96, 0.96, 0.94];
        return [0.45, 0.45, 0.44];
      }),
      width: 40,
      height: 20,
    });

    expect(result.exposureSceneClass).toBe('high-contrast');
    expect(result.exposureSceneReason).toBeUndefined();
    expect(result.lumaSpread).toBeGreaterThan(0.86);
    expect(result.brightFraction).toBeGreaterThan(0.10);
  });

  it('classifies obvious clipped bright frames as overexposed', () => {
    const result = classifyRgbFrameExposureScene({
      buffer: frame(40, 20, () => [0.95, 0.95, 0.95]),
      width: 40,
      height: 20,
    });

    expect(result.exposureSceneClass).toBe('overexposed');
    expect(result.confidence).toBeGreaterThan(0.65);
    expect(result.brightFraction).toBeGreaterThan(0.9);
  });

  it('classifies obvious dark frames as underexposed', () => {
    const result = classifyRgbFrameExposureScene({
      buffer: frame(40, 20, () => [0.05, 0.05, 0.05]),
      width: 40,
      height: 20,
    });

    expect(result.exposureSceneClass).toBe('underexposed');
    expect(result.confidence).toBeGreaterThan(0.65);
    expect(result.darkFraction).toBeGreaterThan(0.9);
  });

  it('classifies compressed white-reference scenes as underexposed', () => {
    const result = classifyRgbFrameExposureScene({
      buffer: frame(40, 20, (_x, y) => (y < 14 ? [0.70, 0.70, 0.69] : [0.28, 0.30, 0.29])),
      width: 40,
      height: 20,
    });

    expect(result.exposureSceneClass).toBe('underexposed');
    expect(result.exposureSceneReason).toBe('white-reference-underexposed');
    expect(result.whiteReferenceCandidateFraction).toBeGreaterThan(0.6);
    expect(result.whiteReferenceP98Luma).toBeLessThan(0.82);
    expect(result.brightFraction).toBe(0);
  });

  it('classifies broad gray-white snow references as underexposed', () => {
    const result = classifyRgbFrameExposureScene({
      buffer: frame(40, 20, (_x, y) => {
        if (y < 2) return [0.72, 0.72, 0.70];
        if (y < 12) return [0.60, 0.60, 0.58];
        return [0.24, 0.32, 0.42];
      }),
      width: 40,
      height: 20,
    });

    expect(result.exposureSceneClass).toBe('underexposed');
    expect(result.exposureSceneReason).toBe('white-reference-underexposed');
    expect(result.whiteReferenceCandidateFraction).toBeGreaterThan(0.4);
    expect(result.whiteReferenceP98Luma).toBeLessThan(0.86);
    expect(result.brightFraction).toBe(0);
  });

  it('classifies flat gray-white snow references as underexposed', () => {
    const result = classifyRgbFrameExposureScene({
      buffer: frame(40, 20, (_x, y) => {
        if (y < 16) return [0.57, 0.57, 0.56];
        if (y < 18) return [0.46, 0.47, 0.48];
        return [0.18, 0.22, 0.26];
      }),
      width: 40,
      height: 20,
    });

    expect(result.exposureSceneClass).toBe('underexposed');
    expect(result.exposureSceneReason).toBe('white-reference-underexposed');
    expect(result.whiteReferenceCandidateFraction).toBeGreaterThan(0.7);
    expect(result.whiteReferenceEvLiftToTarget).toBeGreaterThan(0.25);
    expect(result.whiteReferencePredictedP98AfterLift).toBeLessThan(0.96);
    expect(result.whiteReferenceUnderexposedScore).toBeGreaterThan(0.25);
    expect(result.brightFraction).toBe(0);
  });

  it('keeps white-reference scenes with a real highlight tail normal', () => {
    const result = classifyRgbFrameExposureScene({
      buffer: frame(40, 20, (_x, y) => {
        if (y < 12) return [0.70, 0.70, 0.69];
        if (y < 14) return [0.95, 0.95, 0.94];
        return [0.42, 0.44, 0.45];
      }),
      width: 40,
      height: 20,
    });

    expect(result.exposureSceneClass).toBe('normal');
    expect(result.whiteReferenceCandidateFraction).toBeGreaterThan(0.6);
    expect(result.p98Luma).toBeGreaterThan(0.9);
    expect(result.brightFraction).toBeGreaterThan(0.05);
  });
});
