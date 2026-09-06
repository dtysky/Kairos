import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applyProjectChronologyEventConsolidation,
  prepareProjectChronologyEventConsolidation,
} from '../../src/modules/media/chronology-event-consolidation.js';
import type { IChronologyEvent, IProjectChronology } from '../../src/protocol/schema.js';
import {
  confirmChronology,
  resolveWorkspaceProjectRoot,
  writeChronology,
} from '../../src/store/index.js';

describe('chronology event consolidation', () => {
  it('allows Agent to merge adjacent ordinary events across midnight', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'kairos-event-consolidation-'));
    const projectId = 'cross-midnight';
    const projectRoot = resolveWorkspaceProjectRoot(workspaceRoot, projectId);
    try {
      const chronology = projectChronology([
        event('event-a', '2026-08-22T23:59:00.000Z', '2026-08-22T23:59:50.000Z', '早餐开场', ['span-a']),
        event('event-b', '2026-08-23T00:01:00.000Z', '2026-08-23T00:04:00.000Z', '继续早餐', ['span-b']),
        { ...event('route-c', '2026-08-23T00:10:00.000Z', '2026-08-23T00:20:00.000Z', '离开', ['span-c']), kind: 'route', route: { from: '甲地', to: '乙地' } },
      ]);
      await writeChronology(projectRoot, chronology);
      const prepared = await prepareProjectChronologyEventConsolidation({
        workspaceRoot,
        projectId,
        chronology,
        now: '2026-09-06T08:00:00.000Z',
      });

      const applied = await applyProjectChronologyEventConsolidation({
        workspaceRoot,
        projectId,
        now: '2026-09-06T08:05:00.000Z',
        submission: {
          schemaVersion: '1.0',
          projectId,
          inputsHash: chronology.inputsHash,
          candidateHash: prepared.state.candidateHash,
          decisions: [{
            sourceEventIds: ['event-a', 'event-b'],
            title: '跨零点早餐记录',
            summary: '同一地点连续进行的早餐活动。',
            reason: '日期变化只是零点换日，人物、地点和活动连续。',
          }],
        },
      });

      expect(applied.state.status).toBe('completed');
      expect(applied.chronology.events).toHaveLength(2);
      expect(applied.chronology.events[0]).toMatchObject({
        kind: 'event',
        reviewStatus: 'pending',
        title: '跨零点早餐记录',
        startAt: '2026-08-22T23:59:00.000Z',
        endAt: '2026-08-23T00:04:00.000Z',
        location: '同一地点',
        spanIds: ['span-a', 'span-b'],
      });
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('absorbs adjacent ordinary events into one confirmed Pharos anchor', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'kairos-event-consolidation-pharos-'));
    const projectId = 'pharos-absorption';
    const projectRoot = resolveWorkspaceProjectRoot(workspaceRoot, projectId);
    try {
      const chronology = projectChronology([
        { ...event('event-before', '2026-08-21T09:41:00.000Z', '2026-08-21T10:12:00.000Z', '拍摄准备', ['span-before']), location: 'GPS 机位入口' },
        {
          ...event('event-pharos-anchor', '2026-08-21T10:15:00.000Z', '2026-08-21T11:31:00.000Z', '阳朔漓江边机位', ['span-anchor']),
          reviewStatus: 'confirmed',
          location: '阳朔漓江边机位',
        },
        { ...event('event-after', '2026-08-21T11:32:00.000Z', '2026-08-21T11:58:00.000Z', '拍摄收尾', ['span-after']), location: 'GPS 热气球体验区' },
        { ...event('route-next', '2026-08-21T12:00:00.000Z', '2026-08-21T12:30:00.000Z', '离开', ['span-route']), kind: 'route', route: { from: '甲地', to: '乙地' } },
      ]);
      await writeChronology(projectRoot, chronology);
      const prepared = await prepareProjectChronologyEventConsolidation({ workspaceRoot, projectId, chronology });

      const applied = await applyProjectChronologyEventConsolidation({
        workspaceRoot,
        projectId,
        submission: {
          schemaVersion: '1.0',
          projectId,
          inputsHash: chronology.inputsHash,
          candidateHash: prepared.state.candidateHash,
          decisions: [{
            sourceEventIds: ['event-before', 'event-pharos-anchor', 'event-after'],
            anchorEventId: 'event-pharos-anchor',
            title: '阳朔漓江边机位',
            summary: '从准备到收尾的完整漓江晚霞拍摄。',
            reason: '前后普通事件属于同一 Pharos 行程。',
          }],
        },
      });

      expect(applied.chronology.events).toHaveLength(2);
      expect(applied.chronology.events[0]).toMatchObject({
        id: 'event-pharos-anchor',
        kind: 'event',
        reviewStatus: 'confirmed',
        title: '阳朔漓江边机位',
        location: '阳朔漓江边机位',
        startAt: '2026-08-21T09:41:00.000Z',
        endAt: '2026-08-21T11:58:00.000Z',
        summary: '从准备到收尾的完整漓江晚霞拍摄。',
        spanIds: ['span-before', 'span-anchor', 'span-after'],
      });
      expect(applied.state.auditPath).toContain(prepared.state.candidateHash.slice(0, 8));
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('rejects a Pharos absorption group containing another Pharos event', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'kairos-event-consolidation-two-pharos-'));
    const projectId = 'two-pharos';
    const projectRoot = resolveWorkspaceProjectRoot(workspaceRoot, projectId);
    try {
      const chronology = projectChronology([
        event('event-before', '2026-08-21T09:00:00.000Z', '2026-08-21T09:10:00.000Z', '准备', ['span-before']),
        { ...event('event-pharos-a', '2026-08-21T09:11:00.000Z', '2026-08-21T09:20:00.000Z', 'Pharos A', ['span-a']), reviewStatus: 'confirmed' },
        { ...event('event-pharos-b', '2026-08-21T09:21:00.000Z', '2026-08-21T09:30:00.000Z', 'Pharos B', ['span-b']), reviewStatus: 'confirmed' },
      ]);
      await writeChronology(projectRoot, chronology);
      const prepared = await prepareProjectChronologyEventConsolidation({ workspaceRoot, projectId, chronology });

      await expect(applyProjectChronologyEventConsolidation({
        workspaceRoot,
        projectId,
        submission: {
          schemaVersion: '1.0',
          projectId,
          inputsHash: chronology.inputsHash,
          candidateHash: prepared.state.candidateHash,
          decisions: [{
            sourceEventIds: ['event-before', 'event-pharos-a', 'event-pharos-b'],
            anchorEventId: 'event-pharos-a',
            title: 'Pharos A',
            summary: '非法跨越两个 Pharos。',
            reason: '用于验证边界。',
          }],
        },
      })).rejects.toThrow(/exactly one Pharos event/u);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('rejects merges that cross a route boundary', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'kairos-event-consolidation-route-'));
    const projectId = 'route-boundary';
    const projectRoot = resolveWorkspaceProjectRoot(workspaceRoot, projectId);
    try {
      const chronology = projectChronology([
        event('event-a', '2026-08-22T08:00:00.000Z', '2026-08-22T08:01:00.000Z', '出发前', ['span-a']),
        { ...event('route-b', '2026-08-22T08:02:00.000Z', '2026-08-22T08:20:00.000Z', '行车', ['span-b']), kind: 'route', route: { from: '甲地', to: '乙地' } },
        event('event-c', '2026-08-22T08:21:00.000Z', '2026-08-22T08:22:00.000Z', '到达后', ['span-c']),
        event('event-d', '2026-08-22T08:23:00.000Z', '2026-08-22T08:24:00.000Z', '到达后续', ['span-d']),
      ]);
      await writeChronology(projectRoot, chronology);
      const prepared = await prepareProjectChronologyEventConsolidation({ workspaceRoot, projectId, chronology });

      await expect(applyProjectChronologyEventConsolidation({
        workspaceRoot,
        projectId,
        submission: {
          schemaVersion: '1.0',
          projectId,
          inputsHash: chronology.inputsHash,
          candidateHash: prepared.state.candidateHash,
          decisions: [{
            sourceEventIds: ['event-a', 'event-c'],
            title: '错误跨路线合并',
            summary: '不应成功。',
            reason: '测试非法边界。',
          }],
        },
      })).rejects.toThrow(/adjacent events/u);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('blocks human confirmation until Agent consolidation is applied', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'kairos-event-consolidation-gate-'));
    const projectId = 'human-gate';
    const projectRoot = resolveWorkspaceProjectRoot(workspaceRoot, projectId);
    try {
      const chronology = projectChronology([
        event('event-a', '2026-08-22T08:00:00.000Z', '2026-08-22T08:01:00.000Z', '片段一', ['span-a']),
        event('event-b', '2026-08-22T08:02:00.000Z', '2026-08-22T08:03:00.000Z', '片段二', ['span-b']),
      ]);
      await writeChronology(projectRoot, chronology);
      await expect(confirmChronology(projectRoot)).rejects.toThrow(/requires completed Agent event consolidation/u);

      const prepared = await prepareProjectChronologyEventConsolidation({ workspaceRoot, projectId, chronology });
      await applyProjectChronologyEventConsolidation({
        workspaceRoot,
        projectId,
        submission: {
          schemaVersion: '1.0',
          projectId,
          inputsHash: chronology.inputsHash,
          candidateHash: prepared.state.candidateHash,
          decisions: [],
        },
      });
      await expect(confirmChronology(projectRoot)).resolves.toMatchObject({ status: 'confirmed' });
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});

function projectChronology(events: IChronologyEvent[]): IProjectChronology {
  return {
    schemaVersion: '2.0',
    status: 'draft',
    generatedAt: '2026-09-06T08:00:00.000Z',
    updatedAt: '2026-09-06T08:00:00.000Z',
    inputsHash: 'chronology-inputs-hash',
    assetIndex: [],
    events,
  };
}

function event(
  id: string,
  startAt: string,
  endAt: string,
  title: string,
  spanIds: string[],
): IChronologyEvent {
  return {
    id,
    kind: 'event',
    reviewStatus: 'pending',
    title,
    summary: `${title}摘要`,
    startAt,
    endAt,
    location: '同一地点',
    spanIds,
  };
}
