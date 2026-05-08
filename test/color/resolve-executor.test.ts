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
    await expect(executor.preflight({
      projectId: 'project-color',
      rootId: 'root-camera',
      resolveProjectName: 'kairos__project-color',
    })).rejects.toBeInstanceOf(ResolveColorExecutorUnavailableError);
  });

  it('writes a structured preflight request and parses JSON stdout', async () => {
    const requestRoot = await mkdtemp(join(tmpdir(), 'kairos-resolve-executor-preflight-'));
    tempPaths.push(requestRoot);

    const executor = new PythonResolveColorExecutor(
      {
        pythonPath: 'python-mock',
        scriptPath: join(requestRoot, 'resolve-color-host.py'),
      },
      async (_file, args) => {
        const requestPath = String(args[2]);
        const request = JSON.parse(await readFile(requestPath, 'utf-8')) as {
          operation: string;
          input: { resolveProjectName: string };
        };
        expect(request.operation).toBe('preflight');
        expect(request.input.resolveProjectName).toBe('kairos__project-color');
        return {
          stdout: JSON.stringify({
            status: 'ready',
            checkedAt: '2026-04-20T10:00:00.000Z',
            productName: 'DaVinci Resolve Studio',
            versionString: '19.1.0',
            isStudio: true,
            warnings: [],
            blockingReasons: [],
            renderSupport: {
              containers: [{
                container: 'mp4',
                extension: 'mp4',
                videoCodecs: ['h265'],
              }],
              supportsAudioCodec: true,
              supportsVideoQuality: true,
            },
          }),
          stderr: '',
        };
      },
    );

    const result = await executor.preflight({
      projectId: 'project-color',
      rootId: 'root-camera',
      resolveProjectName: 'kairos__project-color',
    });
    expect(result.status).toBe('ready');
    expect(result.renderSupport?.containers[0]?.container).toBe('mp4');
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
            clips: Array<{ rawRelativePath: string }>;
          };
        };
        expect(request.operation).toBe('prepare_root');
        expect(request.input.resolveProjectName).toBe('kairos__project-color');
        expect(request.input.clips[0]?.rawRelativePath).toBe('day1/A001.mov');
        return {
          stdout: JSON.stringify({
            resolveProjectName: request.input.resolveProjectName,
            gradingTimelineName: 'root__root-camera__grading',
            mirrorStatus: 'synced',
            timelineStatus: 'ready',
            groupsSnapshot: {
              rootId: 'root-camera',
              groups: [],
            },
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
      clips: [{
        rawRelativePath: 'day1/A001.mov',
        sourceAbsolutePath: '/tmp/raw-camera/day1/A001.mov',
        capturedAt: '2026-04-19T10:00:00.000Z',
        width: 3840,
        height: 2160,
        fps: 30,
        codec: 'h265',
        rawTags: { model: 'Sony A7S3' },
      }],
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
      clips: [],
    })).rejects.toMatchObject<Partial<ResolveColorHostError>>({
      code: 'resolve_render_failed',
      message: 'render failed',
    });
  });

  it('maps child process timeout into a retryable host error code', async () => {
    const executor = new PythonResolveColorExecutor(
      {
        pythonPath: 'python-mock',
        scriptPath: '/tmp/resolve-color-host.py',
      },
      async () => {
        const error = new Error('Command timed out after 1000ms') as Error & {
          stdout?: string;
          stderr?: string;
          killed?: boolean;
          signal?: string | null;
        };
        error.killed = true;
        error.signal = 'SIGTERM';
        throw error;
      },
    );

    await expect(executor.preflight({
      projectId: 'project-color',
      resolveProjectName: 'kairos__project-color',
    })).rejects.toMatchObject<Partial<ResolveColorHostError>>({
      code: 'resolve_color_host_timeout',
    });
  });
});
