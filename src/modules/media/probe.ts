import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { toExecutableInputPath } from './tool-path.js';

const exec = promisify(execFile);

export interface IMediaToolConfig {
  ffmpegPath?: string;
  ffprobePath?: string;
  ffmpegHwaccel?: string;
  analysisProxyWidth?: number;
  analysisProxyPixelFormat?: string;
  sceneDetectFps?: number;
  sceneDetectScaleWidth?: number;
}

export interface IProbeResult {
  durationMs: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  codec: string | null;
  creationTime: string | null;
  rawTags: Record<string, string>;
}

export async function probe(filePath: string, tools?: IMediaToolConfig): Promise<IProbeResult> {
  const ffprobe = tools?.ffprobePath?.trim() || 'ffprobe';
  const inputPath = toExecutableInputPath(filePath, ffprobe);
  const { stdout } = await exec(ffprobe, [
    '-v', 'quiet',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    inputPath,
  ]);

  const data = JSON.parse(stdout);
  const video = data.streams?.find((s: any) => s.codec_type === 'video');
  const fmt = data.format ?? {};
  const tags = { ...fmt.tags, ...video?.tags };

  return {
    durationMs: fmt.duration ? Math.round(parseFloat(fmt.duration) * 1000) : null,
    width: video?.width ?? null,
    height: video?.height ?? null,
    fps: parseFps(video?.r_frame_rate),
    codec: video?.codec_name ?? null,
    creationTime: tags?.creation_time ?? tags?.date ?? null,
    rawTags: flattenTags(tags),
  };
}

function parseFps(rate: string | undefined): number | null {
  if (!rate) return null;
  const [num, den] = rate.split('/').map(Number);
  if (!num || !den) return null;
  return Math.round((num / den) * 100) / 100;
}

function flattenTags(tags: Record<string, any> | undefined): Record<string, string> {
  if (!tags) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(tags)) {
    if (typeof v === 'string') out[k.toLowerCase()] = v;
  }
  return out;
}
