import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveAssetLocalPath, resolveMediaRoot, resolveMediaRoots } from '../../src/modules/media/root-resolver.js';
import type { IMediaRoot } from '../../src/protocol/schema.js';

const workspaces: string[] = [];

afterEach(async () => {
  await Promise.all(
    workspaces.splice(0).map(path => rm(path, { recursive: true, force: true })),
  );
});

async function createWorkspace(): Promise<string> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'kairos-root-resolver-test-'));
  workspaces.push(workspaceRoot);
  return workspaceRoot;
}

describe('media root resolver', () => {
  it('chooses the first readable alternate when the primary current path is unavailable', async () => {
    const workspaceRoot = await createWorkspace();
    const unavailable = join(workspaceRoot, 'missing-current');
    const alternateOne = join(workspaceRoot, 'alternate-one');
    const alternateTwo = join(workspaceRoot, 'alternate-two');
    await mkdir(alternateOne, { recursive: true });
    await mkdir(alternateTwo, { recursive: true });

    const root: IMediaRoot = {
      id: 'root-camera',
      path: unavailable,
      alternatePaths: [
        { path: alternateOne },
        { path: alternateTwo },
      ],
      enabled: true,
    };

    const resolved = resolveMediaRoot(root);

    expect(resolved.localPath).toBe(alternateOne);
    expect(resolved.localPathResolution.candidates.map(candidate => ({
      path: candidate.path,
      readable: candidate.readable,
    }))).toEqual([
      { path: unavailable, readable: false },
      { path: alternateOne, readable: true },
      { path: alternateTwo, readable: true },
    ]);
  });

  it('resolves current and raw paths independently from different candidate positions', async () => {
    const workspaceRoot = await createWorkspace();
    const currentAlternate = join(workspaceRoot, 'current-alternate');
    const rawPrimary = join(workspaceRoot, 'raw-primary');
    await mkdir(currentAlternate, { recursive: true });
    await mkdir(rawPrimary, { recursive: true });

    const root: IMediaRoot = {
      id: 'root-camera',
      path: join(workspaceRoot, 'missing-current'),
      rawPath: rawPrimary,
      alternatePaths: [
        {
          path: currentAlternate,
          rawPath: join(workspaceRoot, 'missing-raw-alternate'),
        },
      ],
      enabled: true,
    };

    const resolved = resolveMediaRoot(root);

    expect(resolved.localPath).toBe(currentAlternate);
    expect(resolved.rawLocalPath).toBe(rawPrimary);
  });

  it('marks enabled roots missing when no current path candidate is readable', async () => {
    const workspaceRoot = await createWorkspace();
    const root: IMediaRoot = {
      id: 'root-camera',
      path: join(workspaceRoot, 'missing-current'),
      alternatePaths: [{ path: join(workspaceRoot, 'missing-alternate') }],
      enabled: true,
    };

    const resolution = resolveMediaRoots([root]);

    expect(resolution.resolved).toEqual([]);
    expect(resolution.missing).toEqual([root]);
  });

  it('resolves an asset from an alternate path when the primary root exists but misses that file', async () => {
    const workspaceRoot = await createWorkspace();
    const primary = join(workspaceRoot, 'primary');
    const alternate = join(workspaceRoot, 'alternate');
    await mkdir(join(primary, 'day0'), { recursive: true });
    await mkdir(join(alternate, 'day0'), { recursive: true });
    await writeFile(join(alternate, 'day0', 'C0353.mp4'), 'video', 'utf-8');

    const root: IMediaRoot = {
      id: 'root-camera',
      path: primary,
      alternatePaths: [{ path: alternate }],
      enabled: true,
    };

    const resolved = resolveAssetLocalPath({
      ingestRootId: 'root-camera',
      sourcePath: 'day0/C0353.mp4',
    }, [root]);

    expect(resolved).toBe(join(alternate, 'day0', 'C0353.mp4'));
  });
});
