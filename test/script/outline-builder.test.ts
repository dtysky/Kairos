import { describe, expect, it } from 'vitest';
import { buildOutline } from '../../src/modules/script/outline-builder.js';

describe('buildOutline', () => {
  it('builds beats from material slots and chosen spans', () => {
    const segmentPlan = {
      id: 'plan-1',
      projectId: 'project-1',
      generatedAt: '2026-04-09T00:00:00.000Z',
      segments: [{
        id: 'segment-opening',
        title: '进入海边',
        intent: '先建立海边空间与呼吸感。',
        targetDurationMs: 18_000,
        roleHint: 'intro',
        notes: ['先留白'],
      }],
      notes: [],
    };

    const materialSlots = {
      id: 'slots-1',
      projectId: 'project-1',
      generatedAt: '2026-04-09T00:00:00.000Z',
      segments: [{
        segmentId: 'segment-opening',
        slots: [{
          id: 'slot-1',
          query: '海边建场 / 留白',
          requirement: 'required',
          targetBundles: ['bundle-coast'],
          chosenSpanIds: ['span-coast'],
        }],
      }],
    };

    const spansById = new Map([
      ['span-coast', {
        id: 'span-coast',
        assetId: 'asset-1',
        type: 'broll',
        sourceInMs: 1_000,
        sourceOutMs: 7_000,
        transcript: '海边很安静。',
        visualObservation: '海边空镜很安静。',
        materialPatterns: ['高辨识度地点快速建场'],
        grounding: {
          speechMode: 'available',
          speechValue: 'emotional',
          spatialEvidence: [{
            tier: 'strong-inference',
            confidence: 0.8,
            sourceKinds: ['vision'],
            locationText: 'Auckland',
          }],
          pharosRefs: [],
        },
      }],
    ]);

    const outline = buildOutline({
      segmentPlan,
      materialSlots,
      spansById,
    });

    expect(outline).toHaveLength(1);
    expect(outline[0]?.role).toBe('intro');
    expect(outline[0]?.beats[0]?.linkedSpanIds).toEqual(['span-coast']);
    expect(outline[0]?.beats[0]?.audioSelections).toEqual([{
      assetId: 'asset-1',
      spanId: 'span-coast',
      sliceId: 'span-coast',
      sourceInMs: 1_000,
      sourceOutMs: 7_000,
    }]);
    expect(outline[0]?.beats[0]?.visualSelections).toEqual([{
      assetId: 'asset-1',
      spanId: 'span-coast',
      sliceId: 'span-coast',
      sourceInMs: 1_000,
      sourceOutMs: 7_000,
    }]);
    expect(outline[0]?.beats[0]?.sourceSpeechDecision).toBe('preserve');
    expect(outline[0]?.beats[0]?.locations).toContain('Auckland');
  });
});
