import { describe, expect, it } from 'vitest';
import { classifyRgbFrameColorCast } from '../../src/modules/color/color-cast-classifier.js';

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

describe('color cast classifier', () => {
  it('keeps a neutral gray frame neutral', () => {
    const result = classifyRgbFrameColorCast({
      buffer: frame(40, 20, () => [0.5, 0.5, 0.5]),
      width: 40,
      height: 20,
    });

    expect(result.colorCastClass).toBe('neutral');
    expect(result.candidatePixelRatio).toBeGreaterThan(0.9);
    expect(Math.abs(result.medianA)).toBeLessThan(1);
    expect(Math.abs(result.medianB)).toBeLessThan(1);
  });

  it('classifies low-saturation road pixels with a cyan cast', () => {
    const result = classifyRgbFrameColorCast({
      buffer: frame(40, 20, () => [0.42, 0.58, 0.68]),
      width: 40,
      height: 20,
    });

    expect(result.colorCastClass).toBe('cool-cyan');
    expect(result.confidence).toBeGreaterThan(0.65);
    expect(result.medianA).toBeLessThan(0);
    expect(result.medianB).toBeLessThan(-6);
  });

  it('classifies a weak cool-blue neutral region as cool-cyan', () => {
    const result = classifyRgbFrameColorCast({
      buffer: frame(40, 20, () => [0.46, 0.51, 0.56]),
      width: 40,
      height: 20,
    });

    expect(result.colorCastClass).toBe('cool-cyan');
    expect(result.confidence).toBeGreaterThan(0.65);
    expect(result.medianB).toBeLessThanOrEqual(-4);
  });

  it('classifies mixed green-cyan neutral pixels separately from pure green', () => {
    const result = classifyRgbFrameColorCast({
      buffer: frame(40, 20, () => [0.42, 0.54, 0.54]),
      width: 40,
      height: 20,
    });

    expect(result.colorCastClass).toBe('green-cyan');
    expect(result.confidence).toBeGreaterThan(0.65);
    expect(result.medianA).toBeLessThanOrEqual(-5);
    expect(result.medianB).toBeGreaterThan(-6);
    expect(result.medianB).toBeLessThanOrEqual(-2);
  });

  it('keeps strong blue priority over the green-cyan bucket', () => {
    const result = classifyRgbFrameColorCast({
      buffer: frame(40, 20, (_x, y) => (y < 3 ? [0.5, 0.5, 0.5] : [0.45, 0.54, 0.58])),
      width: 40,
      height: 20,
    });

    expect(result.colorCastClass).toBe('cool-cyan');
    expect(result.medianB).toBeLessThanOrEqual(-6);
  });

  it('does not let a large blue sky dominate a neutral road frame', () => {
    const result = classifyRgbFrameColorCast({
      buffer: frame(40, 20, (_x, y) => (y < 10 ? [0.12, 0.58, 0.92] : [0.5, 0.5, 0.5])),
      width: 40,
      height: 20,
    });

    expect(result.colorCastClass).toBe('neutral');
    expect(result.skyMaskRatio).toBeGreaterThan(0.4);
    expect(result.candidatePixelRatio).toBeGreaterThan(0.4);
  });

  it('masks a bottom yellow hood while preserving the road color cast', () => {
    const result = classifyRgbFrameColorCast({
      buffer: frame(40, 20, (_x, y) => (y >= 14 ? [0.95, 0.75, 0.08] : [0.42, 0.58, 0.68])),
      width: 40,
      height: 20,
    });

    expect(result.colorCastClass).toBe('cool-cyan');
    expect(result.yellowMaskRatio).toBeGreaterThan(0.2);
    expect(result.medianB).toBeLessThan(-6);
  });

  it('classifies a green-biased neutral region before it reaches strong cyan', () => {
    const result = classifyRgbFrameColorCast({
      buffer: frame(40, 20, () => [0.40, 0.52, 0.46]),
      width: 40,
      height: 20,
    });

    expect(result.colorCastClass).toBe('green');
    expect(result.confidence).toBeGreaterThan(0.65);
    expect(result.medianA).toBeLessThan(-5.5);
  });

  it('returns unknown when too few usable candidate pixels remain', () => {
    const result = classifyRgbFrameColorCast({
      buffer: frame(40, 20, (x, y) => (((y * 40) + x) < 10 ? [0.5, 0.5, 0.5] : [0, 0, 0])),
      width: 40,
      height: 20,
    });

    expect(result.colorCastClass).toBe('unknown');
    expect(result.candidatePixelRatio).toBeLessThan(0.03);
  });
});
