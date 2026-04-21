import type { IColorRenderPreset } from '../../protocol/schema.js';

export interface IColorRenderPresetInput {
  container?: string | null;
  videoCodec?: string | null;
  audioCodec?: string | null;
  bitrateKbps?: number | null;
}

export const CDEFAULT_COLOR_RENDER_PRESET = {
  container: 'mp4',
  videoCodec: 'h265',
  audioCodec: 'aac',
} as const;

export function normalizeColorRenderPreset(
  renderPreset?: IColorRenderPresetInput | null,
): IColorRenderPreset | undefined {
  const container = trimColorRenderPresetString(renderPreset?.container);
  const videoCodec = trimColorRenderPresetString(renderPreset?.videoCodec);
  const audioCodec = trimColorRenderPresetString(renderPreset?.audioCodec);
  const bitrateKbps = readColorRenderPresetBitrateKbps(renderPreset);
  if (!container && !videoCodec && !audioCodec && typeof bitrateKbps !== 'number') {
    return undefined;
  }
  return {
    container,
    videoCodec,
    audioCodec,
    bitrateKbps,
  };
}

export function materializeColorRenderPreset(
  renderPreset?: IColorRenderPresetInput | null,
): IColorRenderPreset {
  return {
    container: trimColorRenderPresetString(renderPreset?.container) ?? CDEFAULT_COLOR_RENDER_PRESET.container,
    videoCodec: trimColorRenderPresetString(renderPreset?.videoCodec) ?? CDEFAULT_COLOR_RENDER_PRESET.videoCodec,
    audioCodec: trimColorRenderPresetString(renderPreset?.audioCodec) ?? CDEFAULT_COLOR_RENDER_PRESET.audioCodec,
    bitrateKbps: readColorRenderPresetBitrateKbps(renderPreset),
  };
}

export function readColorRenderPresetBitrateKbps(
  renderPreset?: Pick<IColorRenderPresetInput, 'bitrateKbps'> | null,
): number | undefined {
  return normalizeColorBitrateKbps(renderPreset?.bitrateKbps);
}

export function normalizeColorBitrateKbps(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    const parsed = Number(trimmed);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return undefined;
}

function trimColorRenderPresetString(value: unknown): string | undefined {
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed || undefined;
}
