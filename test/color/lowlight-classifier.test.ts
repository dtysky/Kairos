import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyMidpointLowlight } from '../../src/modules/color/lowlight-classifier.js';

describe('lowlight classifier', () => {
  it('samples the clip midpoint when duration is known', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kairos-lowlight-test-'));
    const argsPath = join(root, 'args.json');
    const ffmpegPath = join(root, 'fake-ffmpeg.js');
    await writeFile(ffmpegPath, [
      '#!/usr/bin/env node',
      'const fs = require("node:fs");',
      `fs.writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(process.argv.slice(2)));`,
      'process.stdout.write(Buffer.from([0, 0, 0]));',
    ].join('\n'), 'utf-8');
    await chmod(ffmpegPath, 0o755);

    try {
      await classifyMidpointLowlight('/tmp/sample.mp4', { ffmpegPath }, { durationMs: 10_000 });
      const args = JSON.parse(await readFile(argsPath, 'utf-8')) as string[];
      expect(args.slice(0, 4)).toEqual(['-v', 'error', '-ss', '5.000']);
      expect(args).not.toContain('select=eq(n\\,0)');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
