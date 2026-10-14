import { describe, expect, it } from 'vitest';
import {
  selectAvailableLoopbackPort,
  shouldReuseExistingMlService,
  shouldStopExistingMlService,
} from '../../src/supervisor/runtime.js';
import { assertMediaPreparationJobAvailable, progressBelongsToSupervisorJob } from '../../src/supervisor/state.js';
import { createServer } from 'node:net';

describe('supervisor runtime ML lifecycle helpers', () => {
  it('isolates media preparation progress and prevents overlapping Resolve or project fact jobs', () => {
    const job = { jobId: 'media-2', jobType: 'resolve-media-sync', executionMode: 'deterministic' as const,
      projectId: 'trip', args: {}, status: 'running' as const, updatedAt: '2026-10-14', blockers: [] };
    expect(progressBelongsToSupervisorJob(job, { status: 'running' })).toBe(false);
    expect(progressBelongsToSupervisorJob(job, { extra: { jobId: 'media-1' } })).toBe(false);
    expect(progressBelongsToSupervisorJob(job, { extra: { jobId: 'media-2' } })).toBe(true);
    for (const [type, project] of [['resolve-media-sync', 'other'], ['color', 'other'], ['resolve-maintenance', 'other'], ['analyze', 'trip']]) {
      expect(() => assertMediaPreparationJobAvailable(type, project, [job])).toThrow('请先等待');
    }
    expect(() => assertMediaPreparationJobAvailable('analyze', 'other', [job])).not.toThrow();
    expect(() => assertMediaPreparationJobAvailable('resolve-media-sync', 'trip', [{ ...job, status: 'completed' }])).not.toThrow();
    expect(() => assertMediaPreparationJobAvailable('resolve-media-sync', 'trip', [{ ...job, jobType: 'chronology-build' }])).toThrow();
    expect(() => assertMediaPreparationJobAvailable('resolve-media-sync', undefined, [])).toThrow('projectId');
  });

  it('associates durable terminal progress only with the job that wrote it', () => {
    const job = {
      jobId: 'span-job-2',
      jobType: 'span-rebuild',
      executionMode: 'deterministic' as const,
      projectId: 'trip',
      args: {},
      status: 'failed' as const,
      updatedAt: '2026-09-05T00:00:00.000Z',
      blockers: [],
    };
    expect(progressBelongsToSupervisorJob(job, {
      phaseKey: 'span-rebuild',
      status: 'failed',
      extra: { jobId: 'span-job-2' },
    })).toBe(true);
    expect(progressBelongsToSupervisorJob(job, {
      phaseKey: 'span-rebuild',
      status: 'failed',
      extra: { jobId: 'span-job-1' },
    })).toBe(false);
    expect(progressBelongsToSupervisorJob(job, {
      phaseKey: 'chronology-build',
      status: 'failed',
      extra: { jobId: 'span-job-2' },
    })).toBe(false);
    expect(progressBelongsToSupervisorJob({ ...job, status: 'running' }, {
      phaseKey: 'span-rebuild',
      status: 'failed',
      extra: { jobId: 'span-job-1' },
    })).toBe(false);
  });

  it('reuses an existing listener only when a healthy Kairos ML endpoint is present', () => {
    expect(shouldReuseExistingMlService({
      listenerPid: 654,
      health: {
        status: 'ok',
        device: 'mps',
      },
    })).toBe(true);

    expect(shouldReuseExistingMlService({
      listenerPid: 654,
      health: null,
    })).toBe(false);

    expect(shouldReuseExistingMlService({
      listenerPid: null,
      health: {
        status: 'ok',
      },
    })).toBe(false);
  });

  it('stops only tracked or health-verified Kairos ML listeners', () => {
    expect(shouldStopExistingMlService({
      recordListenerPid: 321,
      listenerPid: 321,
      health: null,
    })).toBe(true);

    expect(shouldStopExistingMlService({
      recordListenerPid: undefined,
      listenerPid: 321,
      health: {
        status: 'ok',
      },
    })).toBe(true);

    expect(shouldStopExistingMlService({
      recordListenerPid: undefined,
      listenerPid: 321,
      health: null,
    })).toBe(false);
  });

  it('selects another loopback port when the preferred ASR worker port cannot be bound', async () => {
    const blocker = createServer();
    await new Promise<void>((resolve, reject) => {
      blocker.once('error', reject);
      blocker.listen({ host: '127.0.0.1', port: 0, exclusive: true }, resolve);
    });
    const address = blocker.address();
    const occupiedPort = typeof address === 'object' && address ? address.port : 0;

    try {
      const selectedPort = await selectAvailableLoopbackPort(occupiedPort);
      expect(selectedPort).toBeGreaterThan(0);
      expect(selectedPort).not.toBe(occupiedPort);
    } finally {
      await new Promise<void>((resolve, reject) => blocker.close(error => error ? reject(error) : resolve()));
    }
  });
});
