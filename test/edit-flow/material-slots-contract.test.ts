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
];

const EVENTS: IChronologyEvent[] = [{
  id: 'event-1',
  kind: 'event',
  reviewStatus: 'confirmed',
  title: '出发口播',
  startAt: '2026-05-01T08:00:00.000Z',
  spanIds: ['span-talk', 'span-broll', 'span-drive', 'span-photo'],
}];

describe('material-slots contract', () => {
  it('rejects muted speech-backed non-photo spans', () => {
    expect(() => assertMaterialSlotsContract({
      materialSlots: slotsDocument({
        'span-talk': { audio: -100, speed: 1 },
      }, ['span-talk']),
      spans: SPANS,
      assets: ASSETS,
    })).toThrow(/speech-backed non-photo spans cannot be muted/u);

    expect(() => assertMaterialSlotsContract({
      materialSlots: slotsDocument({
        'span-broll': { audio: -100, speed: 1 },
      }, ['span-broll']),
      spans: SPANS,
      assets: ASSETS,
    })).toThrow(/speech-backed non-photo spans cannot be muted/u);

    expect(() => assertMaterialSlotsContract({
      materialSlots: slotsDocument({
        'span-drive': { audio: -100, speed: 1 },
      }, ['span-drive']),
      spans: SPANS,
      assets: ASSETS,
    })).toThrow(/speech-backed non-photo spans cannot be muted/u);
  });

  it('allows muted photos and builds coverage audit rows', () => {
    const materialSlots = slotsDocument({
      'span-talk': { audio: 0, speed: 1 },
      'span-photo': { audio: -100, speed: 1 },
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
      available: 4,
      chosen: 2,
      dropped: 2,
    });
  });

});

function slotsDocument(
  treatments: Record<string, { audio: number; speed: number }>,
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
