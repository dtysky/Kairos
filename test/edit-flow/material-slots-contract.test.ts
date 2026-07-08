import { describe, expect, it } from 'vitest';
import {
  assertMaterialSlotsContract,
  buildMaterialRecallCoverageAudit,
} from '../../src/modules/edit-flow/material-slots-contract.js';
import type { IChronologyEvent, IKtepAsset, IKtepSpan, IMaterialSlotsDocument } from '../../src/protocol/schema.js';

const ASSETS: IKtepAsset[] = [
  { id: 'asset-talk', kind: 'video', sourcePath: 'talk.mp4', displayName: 'talk.mp4' },
  { id: 'asset-broll', kind: 'video', sourcePath: 'broll.mp4', displayName: 'broll.mp4' },
  { id: 'asset-drive', kind: 'video', sourcePath: 'drive.mp4', displayName: 'drive.mp4' },
  { id: 'asset-aerial', kind: 'video', sourcePath: 'aerial.mp4', displayName: 'aerial.mp4' },
  { id: 'asset-photo', kind: 'photo', sourcePath: 'photo.jpg', displayName: 'photo.jpg' },
];

const SPANS: IKtepSpan[] = [
  {
    id: 'span-talk',
    assetId: 'asset-talk',
    type: 'talking-head',
    semanticKind: 'speech',
    transcript: '现场口播。',
    transcriptSegments: [{ startMs: 0, endMs: 1000, text: '现场口播。' }],
    materialPatterns: ['车内自拍口播', '车内', '晴天', '有口播语音'],
  },
  {
    id: 'span-broll',
    assetId: 'asset-broll',
    type: 'broll',
    semanticKind: 'mixed',
    transcript: '这里能看到路边的村庄。',
    materialPatterns: ['固定机位观察', '道路', '晴天', '有口播语音'],
  },
  {
    id: 'span-drive',
    assetId: 'asset-drive',
    type: 'drive',
    semanticKind: 'speech',
    transcriptSegments: [{ startMs: 0, endMs: 1000, text: '前面开始堵车了。' }],
    materialPatterns: ['第一人称行车', '道路', '晴天', '有口播语音'],
  },
  {
    id: 'span-photo',
    assetId: 'asset-photo',
    type: 'photo',
    materialPatterns: ['照片远景', '山地', '晴天', '无口播语音'],
  },
  {
    id: 'span-aerial',
    assetId: 'asset-aerial',
    type: 'aerial',
    semanticKind: 'speech',
    transcript: '航拍里的风噪被误识别成口播。',
    transcriptSegments: [{ startMs: 0, endMs: 1000, text: '航拍里的风噪被误识别成口播。' }],
    materialPatterns: ['航拍运动', '山谷', '晴天', '有口播语音'],
  },
];

const EVENTS: IChronologyEvent[] = [{
  id: 'event-1',
  kind: 'event',
  reviewStatus: 'confirmed',
  title: '出发口播',
  startAt: '2026-05-01T08:00:00.000Z',
  spanIds: ['span-talk', 'span-broll', 'span-drive', 'span-photo', 'span-aerial'],
}];

describe('material-slots contract', () => {
  it('rejects muted speech-backed non-photo spans', () => {
    expect(() => assertMaterialSlotsContract({
      materialSlots: slotsDocument({
        'span-talk': { audio: -100 },
      }, ['span-talk']),
      spans: SPANS,
      assets: ASSETS,
    })).toThrow(/speech-backed non-photo spans cannot be muted/u);

    expect(() => assertMaterialSlotsContract({
      materialSlots: slotsDocument({
        'span-broll': { audio: -100 },
      }, ['span-broll']),
      spans: SPANS,
      assets: ASSETS,
    })).toThrow(/speech-backed non-photo spans cannot be muted/u);

    expect(() => assertMaterialSlotsContract({
      materialSlots: slotsDocument({
        'span-drive': { audio: -100 },
      }, ['span-drive']),
      spans: SPANS,
      assets: ASSETS,
    })).toThrow(/speech-backed non-photo spans cannot be muted/u);
  });

  it('resolves missing treatment entries and fields as default audio=0 speed=1', () => {
    expect(() => assertMaterialSlotsContract({
      materialSlots: slotsDocument({}, ['span-talk']),
      spans: SPANS,
      assets: ASSETS,
    })).not.toThrow();

    expect(() => assertMaterialSlotsContract({
      materialSlots: slotsDocument({
        'span-drive': { speed: 2 },
      }, ['span-drive']),
      spans: SPANS,
      assets: ASSETS,
    })).not.toThrow();

    expect(() => assertMaterialSlotsContract({
      materialSlots: slotsDocument({
        'span-broll': { speed: 2 },
      }, ['span-broll']),
      spans: SPANS,
      assets: ASSETS,
    })).toThrow(/speed > 1 is only allowed/u);
  });

  it('allows muted aerial spans even when ASR produced speech truth', () => {
    expect(() => assertMaterialSlotsContract({
      materialSlots: slotsDocument({
        'span-aerial': { audio: -100 },
      }, ['span-aerial']),
      spans: SPANS,
      assets: ASSETS,
    })).not.toThrow();
  });

  it('still requires explicit mute overrides for selected photos', () => {
    expect(() => assertMaterialSlotsContract({
      materialSlots: slotsDocument({}, ['span-photo']),
      spans: SPANS,
      assets: ASSETS,
    })).toThrow(/photo spans must use audio=-100/u);
  });

  it('allows muted photos and builds coverage audit rows', () => {
    const materialSlots = slotsDocument({
      'span-photo': { audio: -100 },
    }, ['span-talk', 'span-photo']);

    expect(() => assertMaterialSlotsContract({
      materialSlots,
      spans: SPANS,
      assets: ASSETS,
    })).not.toThrow();

    const audit = buildMaterialRecallCoverageAudit({
      materialSlots,
      spans: SPANS,
      assets: ASSETS,
      chronologyEvents: EVENTS,
      now: '2026-05-19T00:00:00.000Z',
    });

    expect(audit.speechProtected).toMatchObject({
      available: 3,
      chosen: 1,
      dropped: 2,
      droppedSpanIds: ['span-broll', 'span-drive'],
    });
    expect(audit.byType.find(row => row.key === 'broll')).toMatchObject({
      available: 1,
      chosen: 0,
      dropped: 1,
      droppedSpanIds: ['span-broll'],
    });
    expect(audit.byDay[0]).toMatchObject({
      key: '2026-05-01',
      available: 5,
      chosen: 2,
      dropped: 3,
    });
  });

  it('rejects treatment overrides for non-chosen spans', () => {
    expect(() => assertMaterialSlotsContract({
      materialSlots: slotsDocument({
        'span-broll': { audio: -100 },
      }, ['span-talk']),
      spans: SPANS,
      assets: ASSETS,
    })).toThrow(/treatment references non-chosen span/u);
  });

});

function slotsDocument(
  treatments: IMaterialSlotsDocument['segments'][number]['slots'][number]['treatments'],
  chosenSpanIds: string[],
): IMaterialSlotsDocument {
  return {
    id: 'slots-1',
    projectId: 'project-1',
    generatedAt: '2026-05-19T00:00:00.000Z',
    segments: [{
      segmentId: 'segment-1',
      slots: [{
        id: 'slot-1',
        query: 'test',
        requirement: 'required',
        targetBundles: [],
        chosenSpanIds,
        treatments,
      }],
    }],
  };
}
