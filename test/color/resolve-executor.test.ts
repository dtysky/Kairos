import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  PythonResolveColorExecutor,
  ResolveColorExecutorUnavailableError,
  ResolveColorHostError,
  getVendoredResolveColorPythonPath,
  inspectResolveColorBackend,
  resolveColorPythonInvocation,
  resolveColorScriptPath,
} from '../../src/modules/color/resolve-executor.js';

const tempPaths: string[] = [];
const boundedWaitOption = ['time', 'out'].join('');

afterEach(async () => {
  await Promise.all(
    tempPaths.splice(0).map(path => rm(path, { recursive: true, force: true })),
  );
});

describe('PythonResolveColorExecutor', () => {
  it('resolves the fixed vendored backend paths and fails when the .venv is missing', async () => {
    const backendRoot = await mkdtemp(join(tmpdir(), 'kairos-resolve-executor-missing-venv-'));
    tempPaths.push(backendRoot);
    const scriptPath = resolveColorScriptPath(undefined, backendRoot);
    await writeFile(scriptPath, '# mock resolve host\n', 'utf-8');

    const status = inspectResolveColorBackend(backendRoot);
    expect(status.available).toBe(false);
    expect(status.pythonPath).toBe(getVendoredResolveColorPythonPath(backendRoot));

    expect(() => resolveColorPythonInvocation({ backendRoot })).toThrow(ResolveColorExecutorUnavailableError);
    expect(() => resolveColorPythonInvocation({ backendRoot })).toThrow(/vendored Resolve backend/);
  });

  it('writes a structured preflight request and parses JSON stdout', async () => {
    const backend = await createVendoredBackendRoot('kairos-resolve-executor-preflight-');

    const executor = new PythonResolveColorExecutor(
      {
        backendRoot: backend.backendRoot,
      },
      async (file, args, options) => {
        expect(file).toBe(backend.pythonPath);
        expect(args[0]).toBe(backend.scriptPath);
        expect(options).not.toHaveProperty(boundedWaitOption);
        const requestPath = String(args[2]);
        const request = JSON.parse(await readFile(requestPath, 'utf-8')) as {
          operation: string;
          input: { resolveProjectName: string };
          scriptApiRoot?: string;
        };
        expect(request.operation).toBe('preflight');
        expect(request.input.resolveProjectName).toBe('kairos__project-color');
        expect(request).not.toHaveProperty('scriptApiRoot');
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
    const backend = await createVendoredBackendRoot('kairos-resolve-executor-');

    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const executor = new PythonResolveColorExecutor(
      {
        backendRoot: backend.backendRoot,
      },
      async (file, args, options) => {
        calls.push({ file, args });
        expect(options).not.toHaveProperty(boundedWaitOption);
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

    expect(calls[0]?.file).toBe(backend.pythonPath);
    expect(calls[0]?.args[0]).toBe(backend.scriptPath);
    expect(calls[0]?.args[1]).toBe('--request');
    expect(result.mirrorStatus).toBe('synced');
    expect(result.timelineStatus).toBe('ready');
  });

  it('passes optional latestFilename through save_drp_snapshot requests', async () => {
    const backend = await createVendoredBackendRoot('kairos-resolve-executor-dpr-latest-');
    const executor = new PythonResolveColorExecutor(
      {
        backendRoot: backend.backendRoot,
      },
      async (_file, args) => {
        const requestPath = String(args[2]);
        const request = JSON.parse(await readFile(requestPath, 'utf-8')) as {
          operation: string;
          input: {
            resolveProjectName: string;
            latestFilename?: string;
            snapshotRoot: string;
          };
        };
        expect(request.operation).toBe('save_drp_snapshot');
        expect(request.input.latestFilename).toBe('Project [Edit].drp');
        return {
          stdout: JSON.stringify({
            snapshot: {
              projectName: request.input.resolveProjectName,
              snapshotPath: `${request.input.snapshotRoot}/snapshots/manual.drp`,
              latestPath: `${request.input.snapshotRoot}/${request.input.latestFilename}`,
              createdAt: '2026-05-21T10:00:00.000Z',
              mode: 'manual',
            },
          }),
          stderr: '',
        };
      },
    );

    const result = await executor.saveDrpSnapshot({
      projectId: 'project-edit',
      resolveProjectName: 'Project [Edit]',
      snapshotRoot: '/tmp/project-edit',
      snapshotLabel: 'manual',
      latestFilename: 'Project [Edit].drp',
    });

    expect(result.snapshot.latestPath).toBe('/tmp/project-edit/Project [Edit].drp');
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
});

async function createVendoredBackendRoot(prefix: string) {
  const backendRoot = await mkdtemp(join(tmpdir(), prefix));
  tempPaths.push(backendRoot);

  const scriptPath = resolveColorScriptPath(undefined, backendRoot);
  const pythonPath = getVendoredResolveColorPythonPath(backendRoot);
  await mkdir(dirname(scriptPath), { recursive: true });
  await mkdir(dirname(pythonPath), { recursive: true });
  await writeFile(scriptPath, '# mock resolve host\n', 'utf-8');
  await writeFile(pythonPath, '', 'utf-8');

  return {
    backendRoot,
    scriptPath,
    pythonPath,
  };
}
