import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const interpreter = process.env.KAIROS_FUSCRIPT_PATH
  ?? '/Applications/DaVinci Resolve/DaVinci Resolve.app/Contents/Libraries/Fusion/fuscript';

describe('Resolve voiceover Lua insertion', () => {
  it.skipIf(!existsSync(interpreter))('validates insertion, cache reuse, locks, target changes and rollback in Lua 5.1', () => {
    const output = execFileSync(interpreter, ['-l', 'lua', '-x', 'dofile("test/voiceover/fixtures/aligned-insertion.lua")'], {
      encoding: 'utf8', timeout: 20000,
    });
    // fuscript can exit zero even on a Lua assertion, so require the final sentinel.
    expect(output).toContain('VOICEOVER_LUA_OK');
  });
});
