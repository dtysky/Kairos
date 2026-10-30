import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

it('validates native edit targets, recovery, frame exports and source-preserving speed', async () => {
  const python = join(process.cwd(), 'vendor/resolve-color-host/.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const { stderr } = await promisify(execFile)(python, [join(process.cwd(), 'test/timeline-core/fixtures/resolve_edit_tools_test.py')], { windowsHide: true });
  expect(stderr).toContain('OK');
});
