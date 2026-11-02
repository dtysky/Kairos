import { afterEach, describe, expect, it, vi } from 'vitest';
import * as progressStore from '../../src/store/progress.js';
import { createIngestProgressReporter } from '../../src/modules/media/ingest-progress.js';

afterEach(() => vi.restoreAllMocks());

describe('Ingest progress writer', () => {
  it('coalesces fast updates but publishes the latest active file even without a completion', async () => {
    const write = vi.spyOn(progressStore, 'writeKairosProgress').mockImplementation(async (_, progress) => ({
      ...progress, updatedAt: progress.updatedAt || new Date().toISOString(),
    }));
    const reporter = createIngestProgressReporter('/test', 'job-1');
    await reporter.report({ phaseKey: 'metadata', current: 0, total: 200 }, true);
    for (let index = 1; index <= 100; index++) {
      await reporter.report({ phaseKey: 'metadata', current: index, total: 200, fileName: `C${index}.mp4` });
    }
    expect(write).toHaveBeenCalledTimes(1);
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(write).toHaveBeenCalledTimes(2);
    expect(write.mock.calls[1]?.[1]).toMatchObject({ current: 100, fileName: 'C100.mp4', extra: { jobId: 'job-1' } });
    await reporter.report({ phaseKey: 'complete', status: 'succeeded', current: 200, total: 200 }, true);
    expect(write).toHaveBeenCalledTimes(3);
    expect(write.mock.calls[2]?.[1].status).toBe('succeeded');
  });

  it('serializes forced writes and preserves the last counts and file on failure', async () => {
    let active = 0;
    let peak = 0;
    const committed: number[] = [];
    const write = vi.spyOn(progressStore, 'writeKairosProgress').mockImplementation(async (_, progress) => {
      peak = Math.max(peak, ++active);
      await new Promise(resolve => setTimeout(resolve, 5));
      committed.push(progress.current!);
      active--;
      return { ...progress, updatedAt: new Date().toISOString() };
    });
    const reporter = createIngestProgressReporter('/test', 'job-2');
    await Promise.all([1, 2, 3].map(current => reporter.report({ phaseKey: 'bind', current, total: 5,
      fileName: 'last.mp4', extra: { reusedFileCount: 3 } }, true)));
    await reporter.fail(new Error('disk disconnected'));
    expect(peak).toBe(1);
    expect(committed).toEqual([1, 2, 3, 3]);
    expect(write.mock.calls[3]?.[1]).toMatchObject({ status: 'failed', current: 3, fileName: 'last.mp4',
      detail: 'disk disconnected', extra: { reusedFileCount: 3, jobId: 'job-2' } });
  });
});
