import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { measureColorTechnical } from '../../src/modules/color/technical-measurement.js';
const exec = promisify(execFile);
it('decodes full-duration broad clipping and native clean/noisy bursts with real FFmpeg', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kairos-technical-video-'));
  try {
    for (const kind of ['wide', 'clean', 'noisy', 'contrast'] as const) {
      const path = join(dir, `${kind}.mkv`);
      const filter = kind === 'contrast'
        ? "nullsrc=s=384x384:r=12:d=4.5,format=gbrp16le,geq=r='if(lt(Y,150),52000,6000)':g='if(lt(Y,150),52000,6000)':b='if(lt(Y,150),52000,6000)'"
        : kind === 'wide'
        ? "nullsrc=s=384x384:r=12:d=4,format=gbrp16le,geq=r='if(lt(mod(X,16),13),65535,12000)':g='if(lt(mod(X,16),13),65535,12000)':b='if(lt(mod(X,16),13),65535,12000)'"
        // lavfi color emits limited-range YUV; convert before declaring the fixture full-range.
        : `color=c=0x101010:s=384x384:r=12:d=4,scale=in_range=tv:out_range=pc,format=yuv420p${kind === 'noisy' ? ',noise=alls=18:allf=t+u:all_seed=41' : ''}`;
      await exec('ffmpeg', ['-hide_banner', '-v', 'error', '-f', 'lavfi', '-i', filter, '-c:v', 'ffv1', '-color_range', 'pc', '-y', path]);
      const result = await measureColorTechnical(path, { role: 'raw', contentHash: kind, profile: 'rec709' });
      expect(result.coverage.ratio, JSON.stringify(result.warnings)).toBe(1);
      expect(result.noiseSamples).toHaveLength(3);
      expect(result.exposure.state).toBe(kind === 'wide' ? 'detected' : 'not-observed');
      expect(result.highContrast.state).toBe(kind === 'contrast' ? 'detected' : 'not-observed');
      if (kind === 'contrast') expect(result.contrastOverview.at(-1)!.endMs).toBe(4500);
      if (kind === 'clean') expect(result.noise.state).toBe('not-observed');
      if (kind === 'noisy') {
        expect(result.noise.state, JSON.stringify(result.noiseSamples)).toBe('detected');
        expect(result.overview.every(s => s.display.veryDark)).toBe(true);
      }
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 60000);

it('checks native Y codes before conversion and does not mistake recoverable superwhite for source clipping', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kairos-superwhite-'));
  try {
    for (const kind of ['legal-white', 'superwhite'] as const) {
      const path = join(dir, `${kind}.mkv`);
      const white = kind === 'legal-white' ? '940' : '950+mod(X,10)';
      const filter = `nullsrc=s=384x384:r=12:d=4,format=yuv444p10le,geq=lum='if(lt(mod(X,16),13),${white},150)':cb='512':cr='512'`;
      await exec('ffmpeg', ['-hide_banner', '-v', 'error', '-f', 'lavfi', '-i', filter, '-c:v', 'ffv1', '-color_range', 'tv', '-colorspace', 'bt709', '-y', path]);
      const r = await measureColorTechnical(path, { role: 'raw', contentHash: kind, profile: 'rec709' });
      expect(r.coverage.ratio, JSON.stringify(r.warnings)).toBe(1);
      expect(r.signal?.clipProofMode).toBe('native-y-white-code-plateau');
      expect(r.exposure.state, JSON.stringify(r.overview[0])).toBe('detected');
      expect(r.sourceClipping.state, JSON.stringify(r.overview[0])).toBe(kind === 'legal-white' ? 'detected' : 'needs-review');
      if (kind === 'superwhite') expect(r.overview[0]!.sourceWhitePlateauFraction).toBe(0);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 60000);
