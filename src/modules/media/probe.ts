import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { extname } from 'node:path';
import { toExecutableInputPath } from './tool-path.js';

const exec = promisify(execFile);
const CPHOTO_EXT = new Set([
  '.jpg', '.jpeg', '.png', '.tiff', '.tif', '.webp',
  '.raw', '.arw', '.cr2', '.cr3', '.nef', '.dng', '.raf', '.orf',
]);

export interface IMediaToolConfig {
  ffmpegPath?: string;
  ffprobePath?: string;
  exiftoolPath?: string;
  ffmpegHwaccel?: string;
  analysisProxyWidth?: number;
  analysisProxyPixelFormat?: string;
  sceneDetectFps?: number;
  sceneDetectScaleWidth?: number;
  keyframeExtractConcurrency?: number;
}

export interface IProbeResult {
  durationMs: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  codec: string | null;
  hasAudioStream: boolean;
  audioStreamCount: number;
  audioCodec: string | null;
  audioSampleRate: number | null;
  audioChannels: number | null;
  audioBitRate: number | null;
  creationTime: string | null;
  rawTags: Record<string, string>;
}

export async function probe(filePath: string, tools?: IMediaToolConfig): Promise<IProbeResult> {
  if (isPhotoPath(filePath)) {
    const imageProbe = await probePhotoWithExiftool(filePath, tools)
      .catch(async () => await probePhotoWithMdls(filePath).catch(() => null));
    if (imageProbe) return imageProbe;
  }

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
  const audioStreams = Array.isArray(data.streams)
    ? data.streams.filter((s: any) => s.codec_type === 'audio')
    : [];
  const primaryAudio = audioStreams[0];
  const fmt = data.format ?? {};
  const tags = { ...fmt.tags, ...video?.tags };

  return {
    durationMs: fmt.duration ? Math.round(parseFloat(fmt.duration) * 1000) : null,
    width: video?.width ?? null,
    height: video?.height ?? null,
    fps: parseFps(video?.r_frame_rate),
    codec: video?.codec_name ?? null,
    hasAudioStream: audioStreams.length > 0,
    audioStreamCount: audioStreams.length,
    audioCodec: primaryAudio?.codec_name ?? null,
    audioSampleRate: parseNumber(primaryAudio?.sample_rate),
    audioChannels: parseNumber(primaryAudio?.channels),
    audioBitRate: parseNumber(primaryAudio?.bit_rate),
    creationTime: tags?.creation_time ?? tags?.date ?? null,
    rawTags: flattenTags(tags),
  };
}

async function probePhotoWithExiftool(
  filePath: string,
  tools?: IMediaToolConfig,
): Promise<IProbeResult> {
  const exiftool = tools?.exiftoolPath?.trim() || 'exiftool';
  const inputPath = toExecutableInputPath(filePath, exiftool);
  const { stdout } = await exec(exiftool, [
    '-j',
    '-n',
    '-ImageWidth',
    '-ImageHeight',
    '-DateTimeOriginal',
    '-SubSecDateTimeOriginal',
    '-CreateDate',
    '-SubSecCreateDate',
    '-ModifyDate',
    '-OffsetTime',
    '-OffsetTimeOriginal',
    '-OffsetTimeDigitized',
    '-GPSDateStamp',
    '-GPSTimeStamp',
    '-GPSDateTime',
    '-GPSLatitude',
    '-GPSLongitude',
    '-GPSLatitudeRef',
    '-GPSLongitudeRef',
    '-Make',
    '-Model',
    '-LensModel',
    '-Software',
    inputPath,
  ], {
    env: buildStableToolExecEnv(),
  });

  const rows = JSON.parse(stdout);
  const metadata = Array.isArray(rows) ? rows[0] : null;
  if (!metadata || typeof metadata !== 'object') {
    throw new Error(`exiftool returned no metadata for ${filePath}`);
  }

  const tags = flattenTags(metadata as Record<string, unknown>);
  return {
    durationMs: null,
    width: parseNumber(tags['imagewidth']),
    height: parseNumber(tags['imageheight']),
    fps: null,
    codec: null,
    hasAudioStream: false,
    audioStreamCount: 0,
    audioCodec: null,
    audioSampleRate: null,
    audioChannels: null,
    audioBitRate: null,
    creationTime: null,
    rawTags: tags,
  };
}

async function probePhotoWithMdls(
  filePath: string,
): Promise<IProbeResult> {
  if (process.platform !== 'darwin') {
    throw new Error('mdls photo probe is only supported on darwin');
  }

  const inputPath = toExecutableInputPath(filePath, 'mdls');
  const { stdout } = await exec('mdls', [
    '-name', 'kMDItemContentCreationDate',
    '-name', 'kMDItemPixelWidth',
    '-name', 'kMDItemPixelHeight',
    inputPath,
  ], {
    env: buildStableToolExecEnv(),
  });

  const contentCreationDate = parseMdlsField(stdout, 'kMDItemContentCreationDate');
  const pixelWidth = parseMdlsField(stdout, 'kMDItemPixelWidth');
  const pixelHeight = parseMdlsField(stdout, 'kMDItemPixelHeight');

  if (!contentCreationDate && !pixelWidth && !pixelHeight) {
    throw new Error(`mdls returned no usable metadata for ${filePath}`);
  }

  return {
    durationMs: null,
    width: parseNumber(pixelWidth),
    height: parseNumber(pixelHeight),
    fps: null,
    codec: null,
    hasAudioStream: false,
    audioStreamCount: 0,
    audioCodec: null,
    audioSampleRate: null,
    audioChannels: null,
    audioBitRate: null,
    creationTime: contentCreationDate && contentCreationDate !== '(null)'
      ? contentCreationDate
      : null,
    rawTags: {},
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
    if (typeof v === 'string' || typeof v === 'number') {
      out[k.toLowerCase()] = String(v);
    }
  }
  return out;
}

function parseNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function isPhotoPath(filePath: string): boolean {
  return CPHOTO_EXT.has(extname(filePath).toLowerCase());
}

function parseMdlsField(output: string, fieldName: string): string | null {
  const line = output
    .split(/\r?\n/gu)
    .find(item => item.trim().startsWith(`${fieldName} = `));
  if (!line) return null;
  const value = line.split(/\s=\s/u).slice(1).join(' = ').trim();
  return value || null;
}

function buildStableToolExecEnv(): NodeJS.ProcessEnv {
  if (process.platform === 'win32') {
    return process.env;
  }

  return {
    ...process.env,
    LC_ALL: 'C',
    LANG: 'C',
    LC_CTYPE: 'C',
  };
}
