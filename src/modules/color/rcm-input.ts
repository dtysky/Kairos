import type { IMediaRoot, IMediaVersion } from '../../protocol/schema.js';

export const CRCM_POLICY = 'rcm-dwg-v1' as const;

/** Explicit camera encoding, not a look LUT or a camera-model guess. */
export function resolveRcmInput(version: IMediaVersion, root: IMediaRoot): { inputColorSpace: string; inputColorSource: string } {
  const normalize = (value?: string) => value?.toLowerCase().replace(/[\s._-]/g, '') ?? '';
  const gamut = normalize(version.colorPrimaries);
  const gamma = normalize(version.transferFunction);
  const result = (inputColorSpace: string, inputColorSource: string) => ({ inputColorSpace, inputColorSource });
  if (gamma.startsWith('slog3') && ['sgamut3cine', 'sgamut3'].includes(gamut)) {
    return result(gamut === 'sgamut3cine' ? 'S-Gamut3.Cine/S-Log3' : 'S-Gamut3/S-Log3', 'sony-sidecar-xml');
  }
  if (gamma === 'rec709' && (!gamut || gamut === 'rec709')) return result('Rec.709 (Scene)', 'sony-sidecar-xml');
  const explicit = root.color?.inputColorSpace?.trim();
  if (explicit) {
    if (gamma.startsWith('slog3') && !explicit.endsWith('/S-Log3')) throw new Error('RCM 输入设置与素材明确的 S-Log3 元数据冲突');
    if (version.sourceProfile === 'dlog-m' && explicit === 'DJI D-Gamut/D-Log') throw new Error('D-Log M 不得按 D-Log 处理');
    return result(explicit, 'root-input-color-space');
  }
  if (version.sourceProfile === 'dlog') return result('DJI D-Gamut/D-Log', `${version.profileSource ?? 'unknown'}:dlog`);
  if (version.sourceProfile === 'rec709' && !gamut && !gamma) return result('Rec.709 (Scene)', `${version.profileSource ?? 'unknown'}:rec709`);
  throw new Error(`原片 RCM 输入色域/Gamma 不完整或尚未验证（${version.sourceProfile ?? 'unknown'} / ${version.colorPrimaries ?? 'unknown'}），请补齐元数据或 root inputColorSpace；D-Log M 不得按 D-Log 处理`);
}
