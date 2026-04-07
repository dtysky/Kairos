import { afterEach, describe, expect, it, vi } from 'vitest';

const execFileMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({
  execFile: execFileMock,
}));

type ExecCallback = (error: Error | null, stdout?: string, stderr?: string) => void;

const originalPlatform = process.platform;

afterEach(() => {
  execFileMock.mockReset();
  vi.resetModules();
  Object.defineProperty(process, 'platform', {
    value: originalPlatform,
    configurable: true,
  });
});

describe('probe', () => {
  it('uses a stable locale env for photo exiftool probes', async () => {
    execFileMock.mockImplementation((
      file: string,
      _args: string[],
      optionsOrCallback: { env?: NodeJS.ProcessEnv } | ExecCallback,
      maybeCallback?: ExecCallback,
    ) => {
      const options = typeof optionsOrCallback === 'function'
        ? undefined
        : optionsOrCallback;
      const callback = typeof optionsOrCallback === 'function'
        ? optionsOrCallback
        : maybeCallback;

      if (file === 'exiftool') {
        callback?.(null, {
          stdout: JSON.stringify([{
            ImageWidth: 6135,
            ImageHeight: 4090,
            DateTimeOriginal: '2026:02:17 05:19:03',
            OffsetTimeOriginal: '+08:00',
          }]),
          stderr: '',
        } as unknown as string, '');
        return;
      }

      callback?.(new Error(`unexpected command: ${file}`));
    });

    const { probe } = await import('../../src/modules/media/probe.js');
    const result = await probe('/tmp/sample.jpg');

    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(execFileMock.mock.calls[0]?.[0]).toBe('exiftool');
    expect((execFileMock.mock.calls[0]?.[2] as { env?: NodeJS.ProcessEnv } | undefined)?.env).toMatchObject({
      LC_ALL: 'C',
      LANG: 'C',
      LC_CTYPE: 'C',
    });
    expect(result.width).toBe(6135);
    expect(result.height).toBe(4090);
    expect(result.rawTags['datetimeoriginal']).toBe('2026:02:17 05:19:03');
    expect(result.rawTags['offsettimeoriginal']).toBe('+08:00');
  });

  it('falls back to mdls on darwin when exiftool fails for photos', async () => {
    Object.defineProperty(process, 'platform', {
      value: 'darwin',
      configurable: true,
    });

    execFileMock.mockImplementation((
      file: string,
      _args: string[],
      optionsOrCallback: { env?: NodeJS.ProcessEnv } | ExecCallback,
      maybeCallback?: ExecCallback,
    ) => {
      const callback = typeof optionsOrCallback === 'function'
        ? optionsOrCallback
        : maybeCallback;
      if (file === 'exiftool') {
        callback?.(new Error('locale panic'));
        return;
      }
      if (file === 'mdls') {
        callback?.(null, {
          stdout: [
            'kMDItemContentCreationDate = 2026-02-16 21:19:03 +0000',
            'kMDItemPixelHeight = 4090',
            'kMDItemPixelWidth = 6135',
          ].join('\n'),
          stderr: '',
        } as unknown as string, '');
        return;
      }
      callback?.(new Error(`unexpected command: ${file}`));
    });

    const { probe } = await import('../../src/modules/media/probe.js');
    const result = await probe('/tmp/sample.jpg');

    expect(execFileMock.mock.calls.map(call => call[0])).toEqual(['exiftool', 'mdls']);
    expect(result.creationTime).toBe('2026-02-16 21:19:03 +0000');
    expect(result.width).toBe(6135);
    expect(result.height).toBe(4090);
    expect(result.rawTags).toEqual({});
  });
});
