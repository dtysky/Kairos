import { describe, expect, it } from 'vitest';
import type { IJsonPacketAgentRunner } from '../src/modules/agents/runtime.js';
import { generateScript } from '../src/modules/script/script-generator.js';
import type { IOutlineSegment } from '../src/modules/script/outline-builder.js';
import { createSelection, createStyleProfile } from './helpers/fixtures.js';

describe('generateScript', () => {
  it('keeps deterministic recall facts locked while allowing expression edits', async () => {
    const lockedSelection = createSelection({
      assetId: 'asset-1',
      spanId: 'span-1',
      sourceInMs: 1_000,
      sourceOutMs: 2_000,
    });
    const outline: IOutlineSegment[] = [{
      id: 'segment-1',
      role: 'scene',
      title: 'Locked Segment',
      narrativeSketch: 'Keep the recalled material stable.',
      estimatedDurationMs: 4_000,
      notes: ['segment fallback note'],
      selections: [lockedSelection],
      spanIds: ['span-1'],
      beats: [{
        id: 'beat-1',
        title: 'Locked Beat',
        summary: 'Original beat summary',
        query: 'locked beat query',
        audioSelections: [lockedSelection],
        visualSelections: [lockedSelection],
        linkedSpanIds: ['span-1'],
        transcript: 'Original transcript',
        materialPatterns: [],
        locations: [],
        sourceSpeechDecision: 'preserve',
      }],
    }];
    const runner: IJsonPacketAgentRunner = {
      async run() {
        return {
          segments: [{
            id: 'hijacked-segment',
            role: 'outro',
            title: 'Should be ignored',
            narration: 'Updated narration is allowed.',
            notes: 'Updated segment note',
            beats: [{
              id: 'beat-1',
              text: 'Updated beat text',
              notes: 'Updated beat note',
              actions: {
                speed: 9,
                muteSource: true,
                preserveNatSound: false,
              },
              audioSelections: [{
                assetId: 'asset-evil',
                spanId: 'span-evil',
                sliceId: 'span-evil',
                sourceInMs: 0,
                sourceOutMs: 9_999,
              }],
              visualSelections: [{
                assetId: 'asset-evil',
                spanId: 'span-evil',
                sliceId: 'span-evil',
                sourceInMs: 0,
                sourceOutMs: 9_999,
              }],
              linkedSpanIds: ['span-evil'],
              linkedSliceIds: ['span-evil'],
            }, {
              id: 'extra-beat',
              text: 'Should not be appended',
            }],
          }],
        };
      },
    };

    const script = await generateScript(runner, outline, createStyleProfile());

    expect(script).toHaveLength(1);
    expect(script[0]?.id).toBe('segment-1');
    expect(script[0]?.targetDurationMs).toBe(4_000);
    expect(script[0]?.notes).toBe('Updated segment note');
    expect(script[0]?.beats).toHaveLength(1);
    expect(script[0]?.beats[0]?.text).toBe('Updated beat text');
    expect(script[0]?.beats[0]?.notes).toBe('Updated beat note');
    expect(script[0]?.beats[0]?.audioSelections).toEqual([lockedSelection]);
    expect(script[0]?.beats[0]?.visualSelections).toEqual([lockedSelection]);
    expect(script[0]?.beats[0]?.linkedSpanIds).toEqual(['span-1']);
    expect(script[0]?.beats[0]?.linkedSliceIds).toEqual(['span-1']);
    expect(script[0]?.beats[0]?.actions).toEqual({
      muteSource: true,
      preserveNatSound: false,
    });
  });
});
