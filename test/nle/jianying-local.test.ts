import { afterEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  JianyingLocalRunner,
  getVendoredJianyingPythonPath,
  resolveJianyingPyProjectRoot,
  resolveJianyingPythonInvocation,
  resolveJianyingScriptPath,
  type IJianyingDraftSpec,
} from '../../src/modules/nle/index.js';

const tempPaths: string[] = [];
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const pyProjectRoot = resolveJianyingPyProjectRoot(join(repoRoot, 'vendor', 'pyJianYingDraft'));
const scriptPath = resolveJianyingScriptPath(join(repoRoot, 'scripts', 'jianying-export.py'));
const vendoredPython = getVendoredJianyingPythonPath(pyProjectRoot);
const TINY_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIW2NgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==';

afterEach(async () => {
  await Promise.all(
    tempPaths.splice(0).map(path => rm(path, { recursive: true, force: true })),
  );
});

describe('JianyingLocalRunner', () => {
  it('requires an explicit python path or vendored venv', async () => {
    const missingPyProjectRoot = await mkdtemp(join(tmpdir(), 'kairos-jianying-no-venv-'));
    tempPaths.push(missingPyProjectRoot);

    await expect(resolveJianyingPythonInvocation({
      pyProjectRoot: missingPyProjectRoot,
    })).rejects.toThrow(/Cannot find Jianying backend Python/);
  });

  it('writes a one-shot manifest and parses the CLI response', async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), 'kairos-jianying-local-test-'));
    const outputPath = join(outputRoot, 'Mock Draft');
    tempPaths.push(outputRoot);

    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const runner = new JianyingLocalRunner(
      {
        outputPath,
        pythonPath: 'python-mock',
        pyProjectRoot,
        scriptPath,
      },
      async (file, args) => {
        calls.push({ file, args });
        return {
          stdout: JSON.stringify({
            outputPath,
            messages: [{
              code: 'py_notice',
              level: 'info',
              message: 'python side ok',
            }],
          }),
          stderr: '',
        };
      },
    );

    const result = await runner.export(createTextOnlySpec());
    tempPaths.push(dirname(result.manifestPath));

    expect(calls[0]?.file).toBe('python-mock');
    expect(calls[0]?.args).toEqual([
      scriptPath,
      '--manifest',
      result.manifestPath,
    ]);

    const manifest = JSON.parse(await readFile(result.manifestPath, 'utf-8')) as {
      outputPath: string;
      spec: IJianyingDraftSpec;
    };
    expect(manifest.outputPath).toBe(outputPath);
    expect(result.stagingPath).toBe(outputPath);
    expect(result.finalPath).toBe(outputPath);
    expect(result.outputPath).toBe(outputPath);
    expect(manifest.spec.project.name).toBe('Smoke Draft');
    expect(result.messages.map(message => message.code)).toEqual([
      'pyjianyingdraft_backend',
      'py_notice',
    ]);
  });

  it('defaults to project-local staging and copies the draft into the configured Jianying root', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'kairos-jianying-stage-copy-'));
    const projectRoot = join(tempRoot, 'project');
    const finalDraftRoot = join(tempRoot, 'jianying-root');
    tempPaths.push(tempRoot);
    await mkdir(finalDraftRoot, { recursive: true });

    const runner = new JianyingLocalRunner(
      {
        draftRoot: finalDraftRoot,
        projectRoot,
        pythonPath: 'python-mock',
        pyProjectRoot,
        scriptPath,
      },
      async (_file, args) => {
        const manifestPath = String(args[2]);
        const manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as {
          outputPath: string;
        };
        await mkdir(manifest.outputPath, { recursive: true });
        await writeFile(join(manifest.outputPath, 'draft_info.json'), '{}', 'utf-8');
        return {
          stdout: JSON.stringify({
            outputPath: manifest.outputPath,
          }),
          stderr: '',
        };
      },
    );

    const result = await runner.export(createTextOnlySpec());
    tempPaths.push(dirname(result.manifestPath));

    expect(result.stagingPath).toContain(join('project', 'adapters', 'jianying-staging'));
    expect(result.finalPath).toBe(join(finalDraftRoot, basename(result.stagingPath)));
    expect(result.outputPath).toBe(result.finalPath);
    expect(existsSync(join(result.stagingPath, 'draft_info.json'))).toBe(true);
    expect(existsSync(join(result.finalPath, 'draft_info.json'))).toBe(true);
    expect(result.messages.some(message => message.code === 'staging_draft_copied')).toBe(true);
  });

  it('refuses to export into an existing directory', async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), 'kairos-jianying-local-test-'));
    const outputPath = join(outputRoot, 'Existing Draft');
    tempPaths.push(outputRoot);

    await mkdir(outputPath, { recursive: true });
    await writeFile(join(outputPath, 'draft_info.json'), '{}', 'utf-8');

    let invoked = false;
    const runner = new JianyingLocalRunner(
      {
        outputPath,
        pythonPath: 'python-mock',
        pyProjectRoot,
        scriptPath,
      },
      async () => {
        invoked = true;
        return {
          stdout: '{}',
          stderr: '',
        };
      },
    );

    await expect(runner.export(createTextOnlySpec())).rejects.toMatchObject({
      code: 'unsafe_output_path',
      outputPath,
    });
    expect(invoked).toBe(false);
  });

  it.skipIf(!existsSync(vendoredPython))(
    'exports a text-only draft with vendored pyJianYingDraft',
    async () => {
      const outputRoot = await mkdtemp(join(tmpdir(), 'kairos-jianying-smoke-'));
      const outputPath = join(outputRoot, 'Smoke Draft');
      tempPaths.push(outputRoot);

      const runner = new JianyingLocalRunner({
        outputPath,
        pythonPath: vendoredPython,
        pyProjectRoot,
        scriptPath,
      });
      const result = await runner.export(createTextOnlySpec());
      tempPaths.push(dirname(result.manifestPath));

      const draftInfo = await readFile(join(outputPath, 'draft_info.json'), 'utf-8');
      const draftMeta = await readFile(join(outputPath, 'draft_meta_info.json'), 'utf-8');

      expect(draftInfo).toContain('"tracks"');
      expect(draftMeta).toContain('"draft_name": "Smoke Draft"');
      expect(result.messages.some(message => message.code === 'pyjianyingdraft_backend')).toBe(true);
    },
  );

  it.skipIf(!existsSync(vendoredPython))(
    'writes Jianying local material registry files for media drafts',
    async () => {
      const outputRoot = await mkdtemp(join(tmpdir(), 'kairos-jianying-media-smoke-'));
      const outputPath = join(outputRoot, 'Media Smoke Draft');
      const imagePath = join(outputRoot, 'pixel.png');
      tempPaths.push(outputRoot);

      await writeFile(imagePath, Buffer.from(TINY_PNG_BASE64, 'base64'));

      const runner = new JianyingLocalRunner({
        outputPath,
        pythonPath: vendoredPython,
        pyProjectRoot,
        scriptPath,
      });
      const result = await runner.export(createSingleImageSpec(imagePath));
      tempPaths.push(dirname(result.manifestPath));

      const keyValue = JSON.parse(await readFile(join(outputPath, 'key_value.json'), 'utf-8')) as Record<string, {
        materialId?: string;
        segmentId?: string;
      }>;
      const draftMeta = JSON.parse(await readFile(join(outputPath, 'draft_meta_info.json'), 'utf-8')) as {
        draft_materials: Array<{
          type: number;
          value: Array<{
            file_Path: string;
            metetype: string;
            duration: number;
          }>;
        }>;
      };
      const draftVirtualStore = JSON.parse(
        await readFile(join(outputPath, 'draft_virtual_store.json'), 'utf-8'),
      ) as {
        draft_virtual_store: Array<{ type: number; value: Array<{ child_id: string; parent_id: string }> }>;
      };
      const expectedImagePath = await realpath(imagePath);

      const materialEntries = Object.entries(keyValue).filter(([, value]) => !value.segmentId);
      const segmentEntries = Object.entries(keyValue).filter(([, value]) => !!value.segmentId);
      const draftMaterialGroup = draftMeta.draft_materials.find(entry => entry.type === 0);
      const typeOneStore = draftVirtualStore.draft_virtual_store.find(entry => entry.type === 1);

      expect(materialEntries).toHaveLength(1);
      expect(segmentEntries).toHaveLength(1);
      expect(materialEntries[0]?.[1].materialId).toBe(materialEntries[0]?.[0]);
      expect(segmentEntries[0]?.[1].materialId).toBe(materialEntries[0]?.[0]);
      expect(draftMaterialGroup?.value).toHaveLength(1);
      expect(draftMaterialGroup?.value[0]?.file_Path).toBe(expectedImagePath);
      expect(draftMaterialGroup?.value[0]?.metetype).toBe('photo');
      expect(draftMaterialGroup?.value[0]?.duration).toBe(5_000_000);
      expect(typeOneStore?.value).toHaveLength(1);
      expect(typeOneStore?.value[0]?.child_id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(result.messages.some(message => message.code === 'draft_material_library_written')).toBe(true);
      expect(result.messages.some(message => message.code === 'local_material_registry_written')).toBe(true);
    },
  );

  it('normalizes retimed clip timing in the manifest before invoking python', async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), 'kairos-jianying-retimed-'));
    const outputPath = join(outputRoot, 'Retimed Draft');
    tempPaths.push(outputRoot);

    let capturedManifest: {
      outputPath: string;
      spec: IJianyingDraftSpec;
    } | null = null;
    const runner = new JianyingLocalRunner(
      {
        outputPath,
        pythonPath: 'python-mock',
        pyProjectRoot,
        scriptPath,
      },
      async (_file, args) => {
        capturedManifest = JSON.parse(await readFile(String(args[2]), 'utf-8')) as {
          outputPath: string;
          spec: IJianyingDraftSpec;
        };
        return {
          stdout: JSON.stringify({
            outputPath,
          }),
          stderr: '',
        };
      },
    );

    const result = await runner.export(createRetimedSpec());
    tempPaths.push(dirname(result.manifestPath));

    expect(capturedManifest?.outputPath).toBe(outputPath);
    expect(capturedManifest?.spec.clips[0]?.targetEndMs).toBe(3587);
    expect(capturedManifest?.spec.clips[1]?.targetStartMs).toBe(3587);
    expect(result.messages.some(message => message.code === 'pyjianying_timing_normalized')).toBe(true);
  });
});

function createTextOnlySpec(): IJianyingDraftSpec {
  return {
    version: '1.0',
    backend: 'pyjianyingdraft',
    compatibility: 'legacy-draft-format',
    project: {
      name: 'Smoke Draft',
    },
    timeline: {
      name: 'Smoke Timeline',
      fps: 30,
      resolution: {
        width: 1920,
        height: 1080,
      },
    },
    tracks: [{
      id: 'track-subtitles',
      kind: 'text',
      role: 'caption',
      index: 0,
      name: 'subtitles',
      relativeIndex: 999,
    }],
    clips: [],
    subtitles: [{
      id: 'subtitle-1',
      trackName: 'subtitles',
      text: 'Kairos smoke test',
      startMs: 0,
      endMs: 1_200,
      style: { size: 6 },
      clipSettings: { transform_y: -0.8 },
    }],
  };
}

function createSingleImageSpec(materialPath: string): IJianyingDraftSpec {
  return {
    version: '1.0',
    backend: 'pyjianyingdraft',
    compatibility: 'legacy-draft-format',
    project: {
      name: 'Media Smoke Draft',
    },
    timeline: {
      name: 'Media Smoke Timeline',
      fps: 30,
      resolution: {
        width: 1920,
        height: 1080,
      },
    },
    tracks: [{
      id: 'track-video-1',
      kind: 'video',
      role: 'main',
      index: 0,
      name: 'main',
      relativeIndex: 0,
    }],
    clips: [{
      id: 'clip-1',
      trackId: 'track-video-1',
      trackName: 'main',
      kind: 'video',
      materialPath,
      targetStartMs: 0,
      targetEndMs: 1_000,
    }],
    subtitles: [],
  };
}

function createRetimedSpec(): IJianyingDraftSpec {
  return {
    version: '1.0',
    backend: 'pyjianyingdraft',
    compatibility: 'legacy-draft-format',
    project: {
      name: 'Retimed Draft',
    },
    timeline: {
      name: 'Retimed Timeline',
      fps: 30,
      resolution: {
        width: 1920,
        height: 1080,
      },
    },
    tracks: [{
      id: 'track-video-1',
      kind: 'video',
      role: 'main',
      index: 0,
      name: 'main',
      relativeIndex: 0,
    }],
    clips: [
      {
        id: 'clip-1',
        trackId: 'track-video-1',
        trackName: 'main',
        kind: 'video',
        materialPath: 'clip-1.mp4',
        targetStartMs: 0,
        targetEndMs: 3586,
        sourceInMs: 0,
        sourceOutMs: 5200,
        speed: 1.45,
      },
      {
        id: 'clip-2',
        trackId: 'track-video-1',
        trackName: 'main',
        kind: 'video',
        materialPath: 'clip-2.mp4',
        targetStartMs: 3586,
        targetEndMs: 6069,
        sourceInMs: 0,
        sourceOutMs: 3600,
        speed: 1.45,
      },
    ],
    subtitles: [],
  };
}
