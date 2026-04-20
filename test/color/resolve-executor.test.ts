import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PythonResolveColorExecutor,
  ResolveColorExecutorUnavailableError,
  ResolveColorHostError,
} from '../../src/modules/color/resolve-executor.js';

const tempPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempPaths.splice(0).map(path => rm(path, { recursive: true, force: true })),
  );
});

describe('PythonResolveColorExecutor', () => {
  it('requires an explicit runtime python path', async () => {
    const executor = new PythonResolveColorExecutor();
    await expect(executor.prepareRoot({
      projectId: 'project-color',
      rootId: 'root-camera',
      resolveProjectName: 'kairos__project-color',
      rootNamespace: 'root__root-camera',
      gradingTimelineName: 'root__root-camera__grading',
      rawPath: '/media/raw/camera',
      rawLocalPath: '/tmp/raw-camera',
    })).rejects.toBeInstanceOf(ResolveColorExecutorUnavailableError);
  });

  it('writes a structured request file and parses JSON stdout', async () => {
    const requestRoot = await mkdtemp(join(tmpdir(), 'kairos-resolve-executor-'));
    tempPaths.push(requestRoot);

    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const executor = new PythonResolveColorExecutor(
      {
        pythonPath: 'python-mock',
        scriptPath: join(requestRoot, 'resolve-color-host.py'),
      },
      async (file, args) => {
        calls.push({ file, args });
        const requestPath = String(args[2]);
        const request = JSON.parse(await readFile(requestPath, 'utf-8')) as {
          operation: string;
          input: {
            resolveProjectName: string;
          };
        };
        expect(request.operation).toBe('prepare_root');
        expect(request.input.resolveProjectName).toBe('kairos__project-color');
        return {
          stdout: JSON.stringify({
            resolveProjectName: request.input.resolveProjectName,
            gradingTimelineName: 'root__root-camera__grading',
            mirrorStatus: 'synced',
            timelineStatus: 'ready',
          }),
          stderr: '',
        };
      },
    );

    const result = await executor.prepareRoot({
      projectId: 'project-color',
      rootId: 'root-camera',
      resolveProjectName: 'kairos__project-color',
      rootNamespace: 'root__root-camera',
      gradingTimelineName: 'root__root-camera__grading',
      rawPath: '/media/raw/camera',
      rawLocalPath: '/tmp/raw-camera',
    });

    expect(calls[0]?.file).toBe('python-mock');
    expect(calls[0]?.args[1]).toBe('--request');
    expect(result.mirrorStatus).toBe('synced');
    expect(result.timelineStatus).toBe('ready');
  });

  it('maps structured stderr into a typed host error', async () => {
    const executor = new PythonResolveColorExecutor(
      {
        pythonPath: 'python-mock',
        scriptPath: '/tmp/resolve-color-host.py',
      },
      async () => {
        const error = new Error('child process failed') as Error & {
          stdout?: string;
          stderr?: string;
        };
        error.stderr = JSON.stringify({
          code: 'resolve_render_failed',
          message: 'render failed',
        });
        throw error;
      },
    );

    await expect(executor.syncGroups({
      projectId: 'project-color',
      rootId: 'root-camera',
      resolveProjectName: 'kairos__project-color',
      gradingTimelineName: 'root__root-camera__grading',
      rawPath: '/media/raw/camera',
      rawLocalPath: '/tmp/raw-camera',
    })).rejects.toMatchObject<Partial<ResolveColorHostError>>({
      code: 'resolve_render_failed',
      message: 'render failed',
    });
  });
});
