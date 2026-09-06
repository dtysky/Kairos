import { describe, expect, it } from 'vitest';
import {
  planAdaptiveSpeechWindows,
  CSPEECH_WINDOW_POLICY_VERSION,
} from '../../src/modules/media/speech-windowing.js';

interface IGapFixtureOptions {
  tokenDurationMs?: number;
  startMs?: number;
}

function tokensFromGaps(
  gapsMs: number[],
  options: IGapFixtureOptions = {},
) {
  const tokenDurationMs = options.tokenDurationMs ?? 200;
  let startMs = options.startMs ?? 0;
  const tokens = gapsMs.map((gapMs, index) => {
    const token = {
      startMs,
      endMs: startMs + tokenDurationMs,
      text: String(index),
    };
    startMs = token.endMs + gapMs;
    return token;
  });
  tokens.push({
    startMs,
    endMs: startMs + tokenDurationMs,
    text: String(gapsMs.length),
  });
  return tokens;
}

describe('adaptive speech windowing', () => {
  it('keeps a dense continuous recording in one window without a duration cap', () => {
    const ordinaryGaps = [
      80, 160, 240, 320, 480, 560, 720, 960,
      1_280, 1_680, 2_160, 2_640, 3_360, 4_160,
      5_200, 5_280, 5_520, 5_680, 6_000,
    ];
    const tokens = tokensFromGaps([
      ...ordinaryGaps,
      ...ordinaryGaps,
      ...ordinaryGaps,
    ], { tokenDurationMs: 4_000 });
    const durationMs = tokens.at(-1)!.endMs;

    const result = planAdaptiveSpeechWindows(durationMs, tokens);

    expect(durationMs).toBeGreaterThan(180_000);
    expect(result.groups).toEqual([{ startMs: 0, endMs: durationMs }]);
    expect(result.diagnostics.policyVersion).toBe(CSPEECH_WINDOW_POLICY_VERSION);
    expect(result.diagnostics.boundaryGapsMs).toEqual([]);
  });

  it('uses repeated asset-local upper-tail pauses as deterministic boundaries', () => {
    const ordinaryGaps = Array.from({ length: 40 }, (_, index) =>
      80 + (index % 10) * 240,
    );
    const tokens = tokensFromGaps([
      ...ordinaryGaps,
      12_000,
      ...ordinaryGaps,
      18_000,
      ...ordinaryGaps,
      24_000,
    ]);
    const result = planAdaptiveSpeechWindows(tokens.at(-1)!.endMs, tokens);

    expect(result.groups).toHaveLength(4);
    expect(result.diagnostics.mode).toBe('upper-tail');
    expect(result.diagnostics.boundaryGapsMs).toEqual([12_000, 18_000, 24_000]);
  });

  it('rejects one weak upper-tail pause that is not distinct from the next pause', () => {
    const tokens = tokensFromGaps([
      80, 160, 240, 320, 400, 480, 560, 640,
      720, 800, 800, 1_440,
    ]);
    const result = planAdaptiveSpeechWindows(tokens.at(-1)!.endMs, tokens);

    expect(result.groups).toHaveLength(1);
    expect(result.diagnostics.boundaryGapsMs).toEqual([]);
  });

  it('accepts a single pause when it clearly separates from the remaining gaps', () => {
    const tokens = tokensFromGaps([
      80, 160, 240, 320, 480, 640, 1_360, 1_680,
      2_720, 3_440, 4_560, 17_920,
    ]);
    const result = planAdaptiveSpeechWindows(tokens.at(-1)!.endMs, tokens);

    expect(result.groups).toHaveLength(2);
    expect(result.diagnostics.boundaryGapsMs).toEqual([17_920]);
  });

  it('keeps too few pause samples together instead of inferring an unstable boundary', () => {
    const tokens = tokensFromGaps([
      80,
      560,
      1_280,
      1_360,
      1_680,
      30_040,
    ]);
    const result = planAdaptiveSpeechWindows(tokens.at(-1)!.endMs, tokens);

    expect(result.groups).toHaveLength(1);
    expect(result.diagnostics.mode).toBe('single-window');
  });

  it('finds the first cadence-safe natural break in a sparse multimodal tail', () => {
    const tokens = tokensFromGaps([
      80, 160, 240, 320, 400, 480, 560, 800, 880,
      960, 1_600, 2_960, 3_440, 9_600, 13_520,
      19_993, 57_927, 58_560, 133_109,
    ]);
    const result = planAdaptiveSpeechWindows(tokens.at(-1)!.endMs, tokens);

    expect(result.diagnostics.mode).toBe('natural-break');
    expect(result.diagnostics.effectiveBoundaryMs).toBe(9_600);
    expect(result.diagnostics.boundaryGapsMs).toEqual([
      9_600,
      13_520,
      19_993,
      57_927,
      58_560,
      133_109,
    ]);
    expect(result.groups).toHaveLength(7);
  });

  it('uses zero-width weak tokens as timing anchors without inventing a window from them', () => {
    const result = planAdaptiveSpeechWindows(10_000, [
      { startMs: 0, endMs: 500 },
      { startMs: 500, endMs: 500 },
      { startMs: 700, endMs: 1_000 },
    ]);

    expect(result.groups).toEqual([{ startMs: 0, endMs: 1_000 }]);
    expect(result.diagnostics.timedTokenCount).toBe(3);

    const zeroOnly = planAdaptiveSpeechWindows(10_000, [
      { startMs: 500, endMs: 500 },
      { startMs: 2_000, endMs: 2_000 },
    ]);
    expect(zeroOnly.groups).toEqual([]);
  });
});
