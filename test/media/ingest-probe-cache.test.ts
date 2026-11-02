import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as probeModule from '../../src/modules/media/probe.js';
import { createIngestProbeCache } from '../../src/modules/media/ingest-probe-cache.js';
import { mapWithConcurrency } from '../../src/modules/media/concurrency.js';
import { testProbeResult } from './fixtures/ingest-probe.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'kairos-ingest-cache-'));
  roots.push(root);
  const file = join(root, 'clip.mp4');
  await writeFile(file, 'media');
  const warnings = vi.fn();
  const probe = vi.spyOn(probeModule, 'probe').mockResolvedValue(testProbeResult());
  const cache = () => createIngestProbeCache(root, {}, warnings);
  return { root, file, probe, cache, warnings };
}

describe('ingest probe cache', () => {
  it('reuses successful reads across runs and only probes new or changed files', async () => {
    const { root, file, probe, cache } = await setup();
    await expect(cache().probe(file)).resolves.toEqual(testProbeResult());
    const second = cache();
    await second.probe(file);
    expect(second.stats).toEqual({ probedFileCount: 0, reusedFileCount: 1, failedFileCount: 0 });
    expect(probe).toHaveBeenCalledTimes(1);

    const added = join(root, 'new.mp4');
    await writeFile(added, 'new media');
    await second.probe(added);
    await writeFile(file, 'changed media');
    await second.probe(file);
    expect(probe).toHaveBeenCalledTimes(3);

    // Restoring mtime after a same-size replacement must still invalidate by ctime.
    const before = await stat(file);
    await writeFile(file, 'another media');
    await utimes(file, before.atime, before.mtime);
    await cache().probe(file);
    expect(probe).toHaveBeenCalledTimes(4);
    await createIngestProbeCache(root, { ffprobePath: 'different-ffprobe' }, vi.fn()).probe(file);
    expect(probe).toHaveBeenCalledTimes(5);
  });

  it.each(['broken-json', 'old-version', 'invalid-result'])('rebuilds a %s cache', async damage => {
    const { root, file, probe, cache } = await setup();
    await cache().probe(file);
    const folder = join(root, '.tmp/ingest/metadata');
    const files = await readdir(folder);
    expect(files).toHaveLength(1);
    const cachePath = join(folder, files[0]!);
    const entry = JSON.parse(await readFile(cachePath, 'utf-8'));
    if (damage === 'old-version') entry.version = 0;
    if (damage === 'invalid-result') entry.result = {};
    await writeFile(cachePath, damage === 'broken-json' ? '{' : JSON.stringify(entry));
    await expect(cache().probe(file)).resolves.toEqual(testProbeResult());
    expect(probe).toHaveBeenCalledTimes(2);
    await cache().probe(file);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('retries failed probes instead of caching the ingest fallback', async () => {
    const { file, probe, cache } = await setup();
    probe.mockRejectedValueOnce(new Error('temporary read failure'));
    const first = cache();
    await expect(first.probe(file)).rejects.toThrow('temporary read failure');
    expect(first.stats).toEqual({ probedFileCount: 0, reusedFileCount: 0, failedFileCount: 1 });
    await expect(cache().probe(file)).resolves.toEqual(testProbeResult());
    await cache().probe(file);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('does not cache metadata for a file changing during the read', async () => {
    const { file, probe, cache } = await setup();
    probe.mockImplementationOnce(async () => {
      await writeFile(file, 'still being copied');
      return testProbeResult();
    });
    await cache().probe(file);
    await cache().probe(file);
    expect(probe).toHaveBeenCalledTimes(2);
    await cache().probe(file);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('keeps usable probe results when the optional cache cannot be written', async () => {
    const { root, file, cache, warnings } = await setup();
    await writeFile(join(root, '.tmp'), 'not a directory');
    await expect(cache().probe(file)).resolves.toEqual(testProbeResult());
    expect(warnings).toHaveBeenCalledWith(expect.stringContaining('元数据缓存写入失败'));
  });
});

describe('bounded media reads', () => {
  it('runs concurrently within the limit and preserves input order', async () => {
    let active = 0;
    let peak = 0;
    const output = await mapWithConcurrency([5, 1, 3, 2, 4, 0], 3, async value => {
      peak = Math.max(peak, ++active);
      await new Promise(resolve => setTimeout(resolve, value));
      active--;
      return value * 2;
    });
    expect(peak).toBe(3);
    expect(active).toBe(0);
    expect(output).toEqual([10, 2, 6, 4, 8, 0]);
  });

  it('drains already-started reads and stops scheduling when one fails', async () => {
    const started: number[] = [];
    let drained = false;
    await expect(mapWithConcurrency([0, 1, 2, 3], 2, async value => {
      started.push(value);
      if (value === 0) throw new Error('read failed');
      await new Promise(resolve => setTimeout(resolve, 5));
      drained = true;
      return value;
    })).rejects.toThrow('read failed');
    expect(started).toEqual([0, 1]);
    expect(drained).toBe(true);
  });
});
