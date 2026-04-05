import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdirSync, writeFileSync } from 'node:fs';

const execFileMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({
  execFile: execFileMock,
}));

const workspaces: string[] = [];

type ExecCallback = (error: Error | null, stdout?: string, stderr?: string) => void;

interface IPendingExecCall {
  args: string[];
  finish: () => void;
}

afterEach(async () => {
  execFileMock.mockReset();
  vi.resetModules();
  await Promise.all(
    workspaces.splice(0).map(path => rm(path, { recursive: true, force: true })),
  );
});

async function createWorkspace(): Promise<string> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'kairos-keyframe-test-'));
  workspaces.push(workspaceRoot);
  return workspaceRoot;
}

function writeOutputs(paths: string[]): void {
  for (const path of paths) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, 'frame');
  }
}

function collectImageOutputs(args: unknown[]): string[] {
  return args
    .filter((value): value is string => typeof value === 'string')
    .filter(value => value.endsWith('.jpg'));
}

async function waitForPendingCount(
  pending: IPendingExecCall[],
  expectedCount: number,
): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (pending.length >= expectedCount) return;
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  expect(pending.length).toBeGreaterThanOrEqual(expectedCount);
}

describe('extractKeyframes', () => {
  it('reuses existing coarse keyframes and only extracts missing timestamps', async () => {
    const workspaceRoot = await createWorkspace();
    const outputDir = join(workspaceRoot, 'frames');
    writeOutputs([
      join(outputDir, 'kf_1000.jpg'),
      join(outputDir, 'kf_3000.jpg'),
    ]);

    execFileMock.mockImplementation((
      _file: string,
      args: string[],
      callback: ExecCallback,
    ) => {
      writeOutputs(collectImageOutputs(args));
      callback(null, '', '');
    });

    const { extractKeyframes } = await import('../../src/modules/media/keyframe.js');
    const result = await extractKeyframes('/tmp/input.mp4', outputDir, [1000, 2000, 3000]);

    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(execFileMock.mock.calls[0]?.[1]).toContain(join(outputDir, 'kf_2000.jpg'));
    expect(result.map(frame => frame.timeMs)).toEqual([1000, 2000, 3000]);
    expect(result.map(frame => frame.path)).toEqual([
      join(outputDir, 'kf_1000.jpg'),
      join(outputDir, 'kf_2000.jpg'),
      join(outputDir, 'kf_3000.jpg'),
    ]);
  });

  it('skips ffmpeg entirely when all requested coarse keyframes already exist', async () => {
    const workspaceRoot = await createWorkspace();
    const outputDir = join(workspaceRoot, 'frames');
    writeOutputs([
      join(outputDir, 'kf_1000.jpg'),
      join(outputDir, 'kf_2000.jpg'),
      join(outputDir, 'kf_3000.jpg'),
    ]);

    const { extractKeyframes } = await import('../../src/modules/media/keyframe.js');
    const result = await extractKeyframes('/tmp/input.mp4', outputDir, [1000, 2000, 3000]);

    expect(execFileMock).not.toHaveBeenCalled();
    expect(result.map(frame => frame.timeMs)).toEqual([1000, 2000, 3000]);
  });

  it('uses a conservative default concurrency of three and preserves timestamp order', async () => {
    const workspaceRoot = await createWorkspace();
    const outputDir = join(workspaceRoot, 'frames');
    const pending: IPendingExecCall[] = [];
    let activeCalls = 0;
    let maxActiveCalls = 0;

    execFileMock.mockImplementation((
      _file: string,
      args: string[],
      callback: ExecCallback,
    ) => {
      activeCalls += 1;
      maxActiveCalls = Math.max(maxActiveCalls, activeCalls);
      const outputs = collectImageOutputs(args);
      pending.push({
        args,
        finish: () => {
          writeOutputs(outputs);
          activeCalls -= 1;
          callback(null, '', '');
        },
      });
    });

    const { extractKeyframes } = await import('../../src/modules/media/keyframe.js');
    const extraction = extractKeyframes('/tmp/input.mp4', outputDir, [1000, 2000, 3000, 4000]);

    await waitForPendingCount(pending, 3);
    expect(pending).toHaveLength(3);
    expect(maxActiveCalls).toBe(3);

    pending[0]!.finish();
    await waitForPendingCount(pending, 4);
    expect(maxActiveCalls).toBe(3);

    pending[1]!.finish();
    pending[2]!.finish();
    pending[3]!.finish();

    const result = await extraction;
    expect(result.map(frame => frame.timeMs)).toEqual([1000, 2000, 3000, 4000]);
    expect(result.every(frame => frame.path.endsWith('.jpg'))).toBe(true);
  });

  it('allows runtime config to force serial extraction when CPU overhead matters', async () => {
    const workspaceRoot = await createWorkspace();
    const outputDir = join(workspaceRoot, 'frames');
    const pending: IPendingExecCall[] = [];
    let activeCalls = 0;
    let maxActiveCalls = 0;

    execFileMock.mockImplementation((
      _file: string,
      args: string[],
      callback: ExecCallback,
    ) => {
      activeCalls += 1;
      maxActiveCalls = Math.max(maxActiveCalls, activeCalls);
      const outputs = collectImageOutputs(args);
      pending.push({
        args,
        finish: () => {
          writeOutputs(outputs);
          activeCalls -= 1;
          callback(null, '', '');
        },
      });
    });

    const { extractKeyframes } = await import('../../src/modules/media/keyframe.js');
    const extraction = extractKeyframes(
      '/tmp/input.mp4',
      outputDir,
      [1000, 2000, 3000],
      { keyframeExtractConcurrency: 1 },
    );

    await waitForPendingCount(pending, 1);
    expect(pending).toHaveLength(1);
    expect(maxActiveCalls).toBe(1);

    pending[0]!.finish();
    await waitForPendingCount(pending, 2);
    expect(maxActiveCalls).toBe(1);

    pending[1]!.finish();
    await waitForPendingCount(pending, 3);
    expect(maxActiveCalls).toBe(1);

    pending[2]!.finish();

    const result = await extraction;
    expect(result.map(frame => frame.timeMs)).toEqual([1000, 2000, 3000]);
    expect(result.every(frame => frame.path.endsWith('.jpg'))).toBe(true);
  });

  it('allows more aggressive runtime concurrency for benchmark sweeps', async () => {
    const workspaceRoot = await createWorkspace();
    const outputDir = join(workspaceRoot, 'frames');
    const pending: IPendingExecCall[] = [];
    let activeCalls = 0;
    let maxActiveCalls = 0;

    execFileMock.mockImplementation((
      _file: string,
      args: string[],
      callback: ExecCallback,
    ) => {
      activeCalls += 1;
      maxActiveCalls = Math.max(maxActiveCalls, activeCalls);
      const outputs = collectImageOutputs(args);
      pending.push({
        args,
        finish: () => {
          writeOutputs(outputs);
          activeCalls -= 1;
          callback(null, '', '');
        },
      });
    });

    const { extractKeyframes } = await import('../../src/modules/media/keyframe.js');
    const extraction = extractKeyframes(
      '/tmp/input.mp4',
      outputDir,
      [1000, 2000, 3000, 4000],
      { keyframeExtractConcurrency: 4 },
    );

    await waitForPendingCount(pending, 4);
    expect(pending).toHaveLength(4);
    expect(maxActiveCalls).toBe(4);

    pending.forEach(call => call.finish());

    const result = await extraction;
    expect(result.map(frame => frame.timeMs)).toEqual([1000, 2000, 3000, 4000]);
    expect(result.every(frame => frame.path.endsWith('.jpg'))).toBe(true);
  });
});
