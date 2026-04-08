import { describe, expect, it } from 'vitest';
import type { IKtepSlice } from '../../src/protocol/schema.js';
import { buildMotifBundles } from '../../src/modules/script/arrangement-synthesis.js';
import { parseStyleMarkdown } from '../../src/modules/script/style-loader.js';

function buildSlice(input: {
  id: string;
  assetId: string;
  type: IKtepSlice['type'];
  sourceInMs: number;
  sourceOutMs: number;
  materialPatterns: string[];
  primaryIntent: string;
  place?: string;
  sourceAudioPolicy?: IKtepSlice['localEditingIntent']['sourceAudioPolicy'];
}): IKtepSlice {
  return {
    id: input.id,
    assetId: input.assetId,
    type: input.type,
    sourceInMs: input.sourceInMs,
    sourceOutMs: input.sourceOutMs,
    editSourceInMs: input.sourceInMs,
    editSourceOutMs: input.sourceOutMs,
    transcript: undefined,
    transcriptSegments: undefined,
    materialPatterns: input.materialPatterns.map((phrase, index) => ({
      phrase,
      confidence: 0.8 - (index * 0.05),
      evidence: [],
    })),
    grounding: {
      speechMode: 'none',
      speechValue: 'none',
      spatialEvidence: input.place ? [{
        tier: 'strong-inference',
        confidence: 0.8,
        sourceKinds: ['vision'],
        reasons: ['test'],
        locationText: input.place,
      }] : [],
      pharosRefs: [],
    },
    localEditingIntent: {
      primaryPhrase: input.primaryIntent,
      secondaryPhrases: [],
      forbiddenPhrases: [],
      sourceAudioPolicy: input.sourceAudioPolicy ?? 'optional',
      speedPolicy: 'forbid',
      confidence: 0.8,
      reasons: input.materialPatterns.slice(0, 2),
    },
    narrativeFunctions: { core: [], extra: [], evidence: [] },
    shotGrammar: { core: [], extra: [], evidence: [] },
    viewpointRoles: { core: [], extra: [], evidence: [] },
    subjectStates: { core: [], extra: [], evidence: [] },
    evidence: [],
    pharosRefs: [],
  };
}

describe('buildMotifBundles', () => {
  it('builds reusable bundles across non-adjacent spans with the same material mother-tongue', () => {
    const style = parseStyleMarkdown(`
# Travel

## 一、组织模式与段落程序
- 组织模式：叙事段落驱动
- 用持续行进的素材把旅程真正推进起来
`);

    const bundles = buildMotifBundles([
      buildSlice({
        id: 'span-route-1',
        assetId: 'asset-a',
        type: 'drive',
        sourceInMs: 0,
        sourceOutMs: 8_000,
        materialPatterns: ['车内向前行进视角', '道路、桥梁、河流或海岸在证明路线'],
        primaryIntent: '适合证明行动、路途或过程正在发生',
        place: '开罗',
      }),
      buildSlice({
        id: 'span-place-1',
        assetId: 'asset-b',
        type: 'broll',
        sourceInMs: 180_000,
        sourceOutMs: 186_000,
        materialPatterns: ['高辨识度地点快速建场'],
        primaryIntent: '适合先把观众带进一个地方',
        place: '吉萨',
      }),
      buildSlice({
        id: 'span-route-2',
        assetId: 'asset-c',
        type: 'drive',
        sourceInMs: 420_000,
        sourceOutMs: 428_000,
        materialPatterns: ['车内向前行进视角', '道路、桥梁、河流或海岸在证明路线'],
        primaryIntent: '适合证明行动、路途或过程正在发生',
        place: '红海',
      }),
    ], style);

    const routeBundle = bundles.find(bundle =>
      bundle.compatibleLocalIntentPhrases.includes('适合证明行动、路途或过程正在发生'),
    );

    expect(routeBundle).toBeTruthy();
    expect(routeBundle?.memberSpanIds).toEqual(
      expect.arrayContaining(['span-route-1', 'span-route-2']),
    );
    expect(routeBundle?.memberSpanIds).not.toContain('span-place-1');
  });
});
