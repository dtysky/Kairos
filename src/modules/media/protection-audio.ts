import { readdir } from 'node:fs/promises';
import { basename, join, parse } from 'node:path';
import type {
  IDeviceMediaMapFile,
  IKtepAsset,
  IMediaRoot,
  IProtectionAudioBinding,
} from '../../protocol/schema.js';
import { probe, type IMediaToolConfig } from './probe.js';
import { resolveAssetLocalPath, toPortableRelativePath } from './root-resolver.js';

const CPROTECTION_AUDIO_EXT_PRIORITY = ['.wav', '.flac', '.m4a', '.aac', '.mp3'] as const;
const CEXACT_ALIGNMENT_TOLERANCE_MS = 50;
const CNEAR_ALIGNMENT_TOLERANCE_MS = 300;

export async function resolveProtectionAudioBinding(input: {
  localPath: string;
  localRootPath: string;
  assetDurationMs?: number;
  tools?: IMediaToolConfig;
}): Promise<IProtectionAudioBinding | null> {
  const protectionPath = await findProtectionAudioPath(input.localPath);
  if (!protectionPath) return null;

  let probed: Awaited<ReturnType<typeof probe>> | null = null;
  try {
    probed = await probe(protectionPath, input.tools);
  } catch {
    probed = null;
  }

  const protectionDurationMs = probed?.durationMs ?? undefined;
  const durationDiffMs = (
    typeof input.assetDurationMs === 'number'
    && typeof protectionDurationMs === 'number'
  )
    ? Math.abs(input.assetDurationMs - protectionDurationMs)
    : undefined;

  return {
    sourcePath: toPortableRelativePath(input.localRootPath, protectionPath),
    displayName: basename(protectionPath),
    durationMs: protectionDurationMs,
    ...(durationDiffMs != null && { durationDiffMs }),
    alignment: resolveProtectionAudioAlignment(input.assetDurationMs, protectionDurationMs),
    ...(probed?.audioCodec && { codec: probed.audioCodec }),
    ...(probed?.audioSampleRate != null && { sampleRate: probed.audioSampleRate }),
    ...(probed?.audioChannels != null && { channels: probed.audioChannels }),
    ...(probed?.audioBitRate != null && { bitRate: probed.audioBitRate }),
  };
}

export function resolveProtectionAudioLocalPath(
  projectId: string,
  asset: IKtepAsset,
  roots: IMediaRoot[],
  deviceMaps: IDeviceMediaMapFile,
): string | null {
  const sourcePath = asset.protectionAudio?.sourcePath;
  if (!sourcePath) return null;

  return resolveAssetLocalPath(projectId, {
    ingestRootId: asset.ingestRootId,
    sourcePath,
  }, roots, deviceMaps);
}

export function canUseProtectionAudio(binding?: IProtectionAudioBinding | null): boolean {
  if (!binding) return false;
  return binding.alignment === 'exact' || binding.alignment === 'near';
}

async function findProtectionAudioPath(localPath: string): Promise<string | null> {
  const parsed = parse(localPath);
  const entries = await readdir(parsed.dir, { withFileTypes: true }).catch(() => []);
  const targetStem = parsed.name.toLowerCase();

  const matches = entries
    .filter(entry => entry.isFile())
    .map(entry => {
      const candidate = parse(entry.name);
      return {
        name: entry.name,
        stem: candidate.name.toLowerCase(),
        ext: candidate.ext.toLowerCase(),
      };
    })
    .filter(entry =>
      entry.stem === targetStem
      && CPROTECTION_AUDIO_EXT_PRIORITY.includes(entry.ext as typeof CPROTECTION_AUDIO_EXT_PRIORITY[number]),
    )
    .sort((a, b) => rankProtectionAudioExt(a.ext) - rankProtectionAudioExt(b.ext));

  if (matches.length === 0) return null;
  return join(parsed.dir, matches[0]!.name);
}

function rankProtectionAudioExt(ext: string): number {
  const index = CPROTECTION_AUDIO_EXT_PRIORITY.indexOf(ext as typeof CPROTECTION_AUDIO_EXT_PRIORITY[number]);
  return index >= 0 ? index : Number.MAX_SAFE_INTEGER;
}

function resolveProtectionAudioAlignment(
  assetDurationMs?: number,
  protectionDurationMs?: number,
): IProtectionAudioBinding['alignment'] {
  if (
    typeof assetDurationMs !== 'number'
    || assetDurationMs <= 0
    || typeof protectionDurationMs !== 'number'
    || protectionDurationMs <= 0
  ) {
    return 'unknown';
  }

  const diffMs = Math.abs(assetDurationMs - protectionDurationMs);
  if (diffMs <= CEXACT_ALIGNMENT_TOLERANCE_MS) return 'exact';
  if (diffMs <= CNEAR_ALIGNMENT_TOLERANCE_MS) return 'near';
  return 'mismatch';
}
