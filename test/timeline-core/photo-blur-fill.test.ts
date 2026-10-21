import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

it('enforces native photo source reuse, idempotency, rollback and MediaPool invariants', async () => {
  const python = join(process.cwd(), 'vendor/resolve-color-host/.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const { stderr } = await promisify(execFile)(python, [join(process.cwd(), 'test/timeline-core/fixtures/photo_blur_fill_test.py')], { windowsHide: true });
  expect(stderr).toContain('OK');
});
