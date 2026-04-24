import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const execFileMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({
  execFile: execFileMock,
}));

type ExecCallback = (error: Error | null, stdout?: string, stderr?: string) => void;

afterEach(() => {
  execFileMock.mockReset();
  vi.resetModules();
});

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

function mockExiftoolOutput(lines: string[], inputPath = '/tmp/sample.mp4') {
  execFileMock.mockImplementation((
    file: string,
    args: string[],
    optionsOrCallback: { env?: NodeJS.ProcessEnv } | ExecCallback,
    maybeCallback?: ExecCallback,
  ) => {
    const options = typeof optionsOrCallback === 'function'
      ? undefined
      : optionsOrCallback;
    const callback = typeof optionsOrCallback === 'function'
      ? optionsOrCallback
      : maybeCallback;

    expect(file).toBe('exiftool');
    expect(args).toEqual(['-ee', '-a', '-u', '-G1', '-s', inputPath]);
    expect(options?.env).toMatchObject({
      LC_ALL: 'C',
      LANG: 'C',
      LC_CTYPE: 'C',
    });
    callback?.(null, {
      stdout: lines.join('\n'),
      stderr: '',
    } as unknown as string, '');
  });
}

function mockExiftoolFailure(inputPath: string) {
  execFileMock.mockImplementation((
    file: string,
    args: string[],
    _optionsOrCallback: { env?: NodeJS.ProcessEnv } | ExecCallback,
    maybeCallback?: ExecCallback,
  ) => {
    const callback = typeof _optionsOrCallback === 'function'
      ? _optionsOrCallback
      : maybeCallback;

    expect(file).toBe('exiftool');
    expect(args).toEqual(['-ee', '-a', '-u', '-G1', '-s', inputPath]);
    callback?.(new Error('stdout maxBuffer length exceeded'));
  });
}

describe('extractColorSourceTruth', () => {
  it('extracts Sony log and gyro truth from acquisition record metadata', async () => {
    mockExiftoolOutput([
      '[XML] AcquisitionRecordGroupItemName : CaptureGammaEquation',
      '[XML] AcquisitionRecordGroupItemValue : s-log3-cine',
      '[XML] AcquisitionRecordChangeTableName : Gyroscope',
    ]);

    const { extractColorSourceTruth } = await import('../../src/modules/color/source-truth.js');
    const result = await extractColorSourceTruth('/tmp/sample.mp4');

    expect(result).toEqual({
      logProfile: 'slog3',
      gyro: true,
      lowlight: undefined,
      deviceFamilyKeys: [],
      sourceKinds: ['sony-acquisition-record'],
    });
  });

  it('extracts DJI log truth only when private metadata is explicit and marks dvtm telemetry gyro-eligible', async () => {
    mockExiftoolOutput([
      '[DJI] Protocol : dvtm_Mavic4.proto',
      '[DJI] Dvtm_Mavic4_ColorMode : D-Log M',
    ]);

    const { extractColorSourceTruth } = await import('../../src/modules/color/source-truth.js');
    const result = await extractColorSourceTruth('/tmp/sample.mp4');

    expect(result).toEqual({
      logProfile: 'dlog-m',
      gyro: true,
      lowlight: undefined,
      deviceFamilyKeys: ['Mavic4'],
      sourceKinds: ['dji-private-video-metadata'],
    });
  });

  it('does not guess DJI log profile when private metadata is present but unresolved', async () => {
    mockExiftoolOutput([
      '[DJI] Protocol : dvtm_Mavic4.proto',
      '[DJI] Dvtm_Mavic4_SomeOtherField : Standard',
    ]);

    const { extractColorSourceTruth } = await import('../../src/modules/color/source-truth.js');
    const result = await extractColorSourceTruth('/tmp/sample.mp4');

    expect(result).toEqual({
      logProfile: undefined,
      gyro: true,
      lowlight: undefined,
      deviceFamilyKeys: ['Mavic4'],
      sourceKinds: ['dji-private-video-metadata'],
    });
  });

  it('extracts Sony truth from sidecar XML even when exiftool probing fails', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'kairos-source-truth-sidecar-'));
    tempDirs.push(tempDir);
    const filePath = join(tempDir, 'C0340.MP4');
    await writeFile(join(tempDir, 'C0340M01.XML'), [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<NonRealTimeMeta>',
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
    mockExiftoolFailure(filePath);

    const { extractColorSourceTruth } = await import('../../src/modules/color/source-truth.js');
    const result = await extractColorSourceTruth(filePath);

    expect(result).toEqual({
      logProfile: 'slog3',
      gyro: true,
      lowlight: undefined,
      deviceFamilyKeys: [],
      sourceKinds: ['sony-sidecar-xml'],
    });
  });

  it('prefers source metadata over Sony XML sidecar when both are present', async () => {
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
    mockExiftoolOutput([
      '[XML] AcquisitionRecordGroupItemName : CaptureGammaEquation',
      '[XML] AcquisitionRecordGroupItemValue : HLG',
    ], filePath);

    const { extractColorSourceTruth } = await import('../../src/modules/color/source-truth.js');
    const result = await extractColorSourceTruth(filePath);

    expect(result).toEqual({
      logProfile: 'hlg',
      gyro: undefined,
      lowlight: undefined,
      deviceFamilyKeys: [],
      sourceKinds: ['sony-acquisition-record', 'sony-sidecar-xml'],
    });
  });
});
