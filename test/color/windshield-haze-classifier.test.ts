import { describe, expect, it } from 'vitest';
import { classifyRgbFrameWindshieldHaze } from '../../src/modules/color/windshield-haze-classifier.js';

function buildRgbFrame(width: number, height: number, pixel: (x: number, y: number) => [number, number, number]): Buffer {
  const buffer = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 3;
      const [red, green, blue] = pixel(x, y);
      buffer[offset] = red;
      buffer[offset + 1] = green;
      buffer[offset + 2] = blue;
    }
  }
  return buffer;
}

describe('windshield haze classifier', () => {
  it('flags compressed gray daylight driving footage with a dark lower windshield foreground', () => {
    const width = 120;
    const height = 72;
    const buffer = buildRgbFrame(width, height, (_x, y) => {
      const ratioY = y / height;
      if (ratioY > 0.84) return [28, 34, 38];
      if (ratioY > 0.76) return [68, 78, 84];
      if (ratioY > 0.55) return [108, 118, 120];
      return [144, 154, 158];
    });

    const result = classifyRgbFrameWindshieldHaze({ buffer, width, height });

    expect(result.windshieldHaze).toBe(true);
    expect(result.confidence).toBeGreaterThanOrEqual(0.58);
    expect(result.vehicleForegroundScore).toBeGreaterThan(0.6);
    expect(result.grayCompressionScore).toBeGreaterThan(0.6);
  });

  it('does not flag open bright daylight footage without a windshield foreground band', () => {
    const width = 120;
    const height = 72;
    const buffer = buildRgbFrame(width, height, (_x, y) => {
      const ratioY = y / height;
      if (ratioY > 0.66) return [92, 112, 92];
      if (ratioY > 0.50) return [178, 184, 178];
      return [224, 232, 238];
    });

    const result = classifyRgbFrameWindshieldHaze({ buffer, width, height });

    expect(result.windshieldHaze).toBe(false);
    expect(result.vehicleForegroundScore).toBeLessThan(0.6);
  });
});
