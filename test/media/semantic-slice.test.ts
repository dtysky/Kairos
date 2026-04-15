import { describe, expect, it } from 'vitest';
import { createEmptySliceSemantics, decorateSliceWithSemanticTags } from '../../src/modules/media/semantic-slice.js';
import type { IKtepSlice } from '../../src/protocol/schema.js';

function buildBaseSlice(): IKtepSlice {
  return {
    id: 'span-1',
    assetId: 'asset-1',
    type: 'drive',
    sourceInMs: 0,
    sourceOutMs: 10_000,
    editSourceInMs: 0,
    editSourceOutMs: 10_000,
    transcript: '我们继续往前开，先去看看下一站。',
    transcriptSegments: [],
    ...createEmptySliceSemantics(),
    evidence: [],
    pharosRefs: [],
  };
}

describe('decorateSliceWithSemanticTags', () => {
  it('keeps only material patterns, grounding and semantic tag sets', () => {
    const result = decorateSliceWithSemanticTags({
      slice: buildBaseSlice(),
      clipType: 'drive',
      semanticWindow: {
        semanticKind: 'speech',
        reason: '车内解释接下来行程',
      },
      recognition: {
        description: 'car interior forward view',
        sceneType: 'road',
        subjects: [],
        placeHints: [],
      },
      report: {
        transcript: '我们继续往前开，先去看看下一站。',
        speechCoverage: 0.72,
        inferredGps: undefined,
        pharosMatches: [],
      },
      vocabulary: {
        materialPatternPhrases: [
          '车内向前行进视角（项目口径）',
          '道路、桥梁、河流或海岸在证明路线',
          '现场人声可以直接使用',
        ],
      },
    });

    expect(result.materialPatterns.map(item => item.phrase)).toContain('车内向前行进视角（项目口径）');
    expect(result.materialPatterns.every(item => item.excerpt == null)).toBe(true);
    expect(result.grounding.speechMode).toBe('preferred');
    expect(result.narrativeFunctions.core).toContain('路上自述');
    expect(result.viewpointRoles.core).toContain('行进中的观察者');
    expect('localEditingIntent' in result).toBe(false);
  });
});
