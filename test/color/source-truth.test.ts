import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const execFileMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({
  execFile: execFileMock,
}));

afterEach(() => {
  execFileMock.mockReset();
  vi.resetModules();
});

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe('extractColorSourceTruth', () => {
  it('does not deep-scan embedded private telemetry by default', async () => {
    const { extractColorSourceTruth } = await import('../../src/modules/color/source-truth.js');
    const result = await extractColorSourceTruth('/tmp/sample.mp4', { exiftoolPath: 'exiftool' });

    expect(execFileMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      logProfile: undefined,
      gyro: undefined,
      deviceFamilyKeys: [],
      sourceKinds: [],
    });
  });

  it('ignores DJI dvtm telemetry unless the user supplies an explicit sidecar or root fallback', async () => {
    execFileMock.mockImplementation(() => {
      throw new Error('exiftool should not run for DJI private telemetry');
    });

    const { extractColorSourceTruth } = await import('../../src/modules/color/source-truth.js');
    const result = await extractColorSourceTruth('/tmp/DJI_0001.MP4');

    expect(execFileMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      logProfile: undefined,
      gyro: undefined,
      deviceFamilyKeys: [],
      sourceKinds: [],
    });
  });

  it('extracts Sony truth from explicit sidecar XML', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'kairos-source-truth-sidecar-'));
    tempDirs.push(tempDir);
    const filePath = join(tempDir, 'C0340.MP4');
    await writeFile(join(tempDir, 'C0340M01.XML'), [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<NonRealTimeMeta>',
      '  <Device manufacturer="Sony" modelName="ZV-E1"/>',
      '  <AcquisitionRecord>',
      '    <Group name="CameraUnitMetadataSet">',
      '      <Item name="CaptureGammaEquation" value="s-log3-cine"/>',
      '      <Item name="CodingEquations" value="rec709"/>',
      '    </Group>',
      '    <ChangeTable name="Gyroscope">',
      '      <Event frameCount="0" status="start"/>',
      '    </ChangeTable>',
      '  </AcquisitionRecord>',
      '</NonRealTimeMeta>',
    ].join('\n'), 'utf-8');

    const { extractColorSourceTruth } = await import('../../src/modules/color/source-truth.js');
    const result = await extractColorSourceTruth(filePath);

    expect(execFileMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      logProfile: 'slog3',
      gyro: true,
      deviceFamilyKeys: [],
      sourceKinds: ['sony-sidecar-xml'],
    });
  });

  it('does not enable gyro for unsupported Sony devices even when sidecar Gyroscope exists', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'kairos-source-truth-unsupported-sony-'));
    tempDirs.push(tempDir);
    const filePath = join(tempDir, 'C0341.MP4');
    await writeFile(join(tempDir, 'C0341M01.XML'), [
      '<NonRealTimeMeta>',
      '  <Device manufacturer="Sony" modelName="ILCE-6000"/>',
      '  <AcquisitionRecord>',
      '    <ChangeTable name="Gyroscope"/>',
      '  </AcquisitionRecord>',
      '</NonRealTimeMeta>',
    ].join('\n'), 'utf-8');

    const { extractColorSourceTruth } = await import('../../src/modules/color/source-truth.js');
    const result = await extractColorSourceTruth(filePath);

    expect(execFileMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      logProfile: undefined,
      gyro: undefined,
      deviceFamilyKeys: [],
      sourceKinds: ['sony-sidecar-xml'],
    });
  });

  it('enables gyro when a matching Gyroflow project is present', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'kairos-source-truth-gyroflow-'));
    tempDirs.push(tempDir);
    const filePath = join(tempDir, 'clip.mp4');
    await writeFile(join(tempDir, 'clip.gyroflow'), '{}', 'utf-8');

    const { extractColorSourceTruth } = await import('../../src/modules/color/source-truth.js');
    const result = await extractColorSourceTruth(filePath);

    expect(execFileMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      logProfile: undefined,
      gyro: true,
      deviceFamilyKeys: [],
      sourceKinds: ['gyroflow-project'],
    });
  });

  it('uses Sony sidecar truth without embedded metadata priority', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'kairos-source-truth-priority-'));
    tempDirs.push(tempDir);
    const filePath = join(tempDir, 'C1493.MP4');
    await writeFile(join(tempDir, 'C1493M01.XML'), [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<NonRealTimeMeta>',
      '  <AcquisitionRecord>',
      '    <Group name="CameraUnitMetadataSet">',
      '      <Item name="CaptureGammaEquation" value="s-log3-cine"/>',
      '    </Group>',
      '  </AcquisitionRecord>',
      '</NonRealTimeMeta>',
    ].join('\n'), 'utf-8');

    const { extractColorSourceTruth } = await import('../../src/modules/color/source-truth.js');
    const result = await extractColorSourceTruth(filePath);

    expect(execFileMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      logProfile: 'slog3',
      gyro: undefined,
      deviceFamilyKeys: [],
      sourceKinds: ['sony-sidecar-xml'],
    });
  });
});
