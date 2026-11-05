import { describe, expect, it } from 'vitest';
import { resolveRcmInput } from '../../src/modules/color/rcm-input.js';
import type { IMediaRoot, IMediaVersion } from '../../src/protocol/schema.js';
const root: IMediaRoot = { id: 'camera', enabled: true, path: '/target', rawPath: '/raw', color: { colorSpaceProfile: 'slog3' } };
const version: IMediaVersion = { relativePath: 'C001.MP4', available: true, contentHash: 'hash', sizeBytes: 1, mtimeMs: 1, ctimeMs: 1 };
describe('RCM input identity', () => {
  it('distinguishes Sony gamuts and respects explicit Rec709 over a LOG root', () => {
    const sony = { ...version, sourceProfile: 'slog3', transferFunction: 's-log3-cine', colorPrimaries: 's-gamut3-cine' };
    expect(resolveRcmInput(sony, root).inputColorSpace).toBe('S-Gamut3.Cine/S-Log3');
    expect(resolveRcmInput({ ...sony, colorPrimaries: 's-gamut3' }, root).inputColorSpace).toBe('S-Gamut3/S-Log3');
    expect(resolveRcmInput({ ...version, transferFunction: 'rec709', colorPrimaries: 'rec709' }, root).inputColorSpace).toBe('Rec.709 (Scene)');
  });
  it('requires the missing gamut and rejects conflicting explicit settings', () => {
    const sony = { ...version, sourceProfile: 'slog3', transferFunction: 's-log3' };
    expect(() => resolveRcmInput(sony, root)).toThrow('不完整');
    expect(resolveRcmInput(sony, { ...root, color: { inputColorSpace: 'S-Gamut3.Cine/S-Log3' } }).inputColorSource).toBe('root-input-color-space');
    expect(() => resolveRcmInput(sony, { ...root, color: { inputColorSpace: 'Rec.709 Gamma 2.4' } })).toThrow('冲突');
  });
  it('never maps D-Log M or generic HLG to a guessed D-Log/2020 input', () => {
    expect(resolveRcmInput({ ...version, sourceProfile: 'dlog', profileSource: 'root-fallback' }, root).inputColorSpace).toBe('DJI D-Gamut/D-Log');
    for (const sourceProfile of ['dlog-m', 'hlg']) expect(() => resolveRcmInput({ ...version, sourceProfile }, root)).toThrow('尚未验证');
    expect(() => resolveRcmInput({ ...version, sourceProfile: 'dlog-m' }, { ...root, color: { inputColorSpace: 'DJI D-Gamut/D-Log' } })).toThrow('D-Log M');
  });
});
