import { afterEach, describe, expect, it } from 'vitest';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  detectResolveDefaultLutRoot,
  resolveClipTransformSeeds,
  resolveEffectiveColorProfile,
  syncReferencedResolveLuts,
} from '../../src/modules/color/transform-presets.js';

const tempPaths: string[] = [];

afterEach(async () => {
  await Promise.all(tempPaths.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe('color transform presets', () => {
  it('resolves detected/root-fallback profiles and honors root override first', () => {
    const detected = resolveEffectiveColorProfile('slog3', 'rec709');
    expect(detected).toEqual({
      detectedProfile: 'slog3',
      effectiveProfile: 'slog3',
      profileSource: 'detected',
      logProfile: 'slog3',
    });

    const fallback = resolveEffectiveColorProfile(undefined, 'D-Log M');
    expect(fallback).toEqual({
      effectiveProfile: 'dlog-m',
      profileSource: 'root-fallback',
      logProfile: 'dlog-m',
    });

    const config = {
      profiles: {
        slog3: {
          default: 'sony/SLog3_to_709.cube',
        },
      },
      discoveredPresets: {},
    };
    const resolved = resolveClipTransformSeeds([{
      rawRelativePath: 'day1/A001.mov',
      detectedProfile: 'slog3',
      effectiveProfile: 'slog3',
      profileSource: 'detected',
      logProfile: 'slog3',
      deviceFamilyKeys: [],
    }], config, 'custom/root-override');

    expect(resolved.blockers).toEqual([]);
    expect(resolved.clips[0]).toMatchObject({
      resolvedTransformPresetKey: 'custom/root-override.cube',
      resolvedLutRelativePath: 'custom/root-override.cube',
    });
  });

  it('matches profile/device routes and does not force a preset for unknown profile', () => {
    const config = {
      profiles: {
        dlog: {
          Mavic4: 'DJI/DJI Mavic 4 Pro D-Log to Rec.709 V1.cube',
          default: '',
        },
        slog3: {
          default: 'Sony/SLog3SGamut3.CineToLC-709.cube',
        },
      },
      discoveredPresets: {},
    };

    const unknown = resolveClipTransformSeeds([{
      rawRelativePath: 'day1/A001.mov',
      effectiveProfile: undefined,
      profileSource: 'unknown',
      deviceFamilyKeys: [],
    }], config);
    expect(unknown.blockers).toEqual([]);
    expect(unknown.clips[0]?.resolvedTransformPresetKey).toBeUndefined();

    const matched = resolveClipTransformSeeds([{
      rawRelativePath: 'day1/A001.mov',
      detectedProfile: 'dlog',
      effectiveProfile: 'dlog',
      profileSource: 'detected',
      logProfile: 'dlog',
      deviceFamilyKeys: ['Mavic4'],
    }], config);
    expect(matched.blockers).toEqual([]);
    expect(matched.clips[0]).toMatchObject({
      resolvedTransformPresetKey: 'DJI/DJI Mavic 4 Pro D-Log to Rec.709 V1.cube',
      resolvedLutRelativePath: 'DJI/DJI Mavic 4 Pro D-Log to Rec.709 V1.cube',
    });
  });

  it('treats an invalid explicit root override as blocker', () => {
    const config = {
      profiles: {},
      discoveredPresets: {},
    };
    const resolved = resolveClipTransformSeeds([{
      rawRelativePath: 'day1/A001.mov',
      effectiveProfile: 'slog3',
      profileSource: 'root-fallback',
      logProfile: 'slog3',
      deviceFamilyKeys: [],
    }], config, '../outside');

    expect(resolved.blockers).toEqual([
      '当前 root 显式配置的 transformPresetKey 非法：../outside',
    ]);
  });

  it('copies only missing same-path workspace LUTs into the resolve default root while preserving structure', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'kairos-transform-sync-workspace-'));
    const resolveLutRoot = await mkdtemp(join(tmpdir(), 'kairos-transform-sync-resolve-'));
    tempPaths.push(workspaceRoot, resolveLutRoot);

    const sourceLutPath = join(workspaceRoot, 'config', 'luts', 'sony', 'SLog3_to_709.cube');
    const sourceExistingPath = join(workspaceRoot, 'config', 'luts', 'sony', 'Existing.cube');
    await mkdir(join(workspaceRoot, 'config', 'luts', 'sony'), { recursive: true });
    await writeFile(sourceLutPath, 'lut-data', 'utf-8');
    await writeFile(sourceExistingPath, 'workspace-existing-lut', 'utf-8');

    const existingTargetPath = join(resolveLutRoot, 'sony', 'Existing.cube');
    await mkdir(join(resolveLutRoot, 'sony'), { recursive: true });
    await writeFile(existingTargetPath, 'existing-lut', 'utf-8');

    const result = await syncReferencedResolveLuts({
      workspaceRoot,
      relativeLutPaths: ['sony/SLog3_to_709.cube', 'sony/Existing.cube', 'DJI/Missing.cube'],
      resolveLutRoot,
    });

    expect(result.status).toBe('copied');
    expect(result.copiedLuts).toEqual(['sony/SLog3_to_709.cube']);
    expect(result.reusedLuts).toEqual(['sony/Existing.cube']);
    await expect(access(join(resolveLutRoot, 'sony', 'SLog3_to_709.cube'))).resolves.toBeUndefined();
    expect(await readFile(join(resolveLutRoot, 'sony', 'SLog3_to_709.cube'), 'utf-8')).toBe('lut-data');
  });

  it('keeps a stable default resolve LUT root shape', () => {
    const lutRoot = detectResolveDefaultLutRoot();
    expect(typeof lutRoot).toBe('string');
    expect(lutRoot.length).toBeGreaterThan(0);
    expect(lutRoot.toLowerCase()).toContain('lut');
  });
});
