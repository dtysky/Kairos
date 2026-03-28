import { readdir, stat } from 'node:fs/promises';
import { join, extname } from 'node:path';
import type { EAssetKind } from '../../protocol/schema.js';

const CEXT_VIDEO = new Set([
  '.mp4', '.mov', '.avi', '.mkv', '.mts', '.m2ts', '.webm', '.mxf',
]);
const CEXT_PHOTO = new Set([
  '.jpg', '.jpeg', '.png', '.tiff', '.tif', '.webp',
  '.raw', '.arw', '.cr2', '.cr3', '.nef', '.dng', '.raf', '.orf',
]);
const CEXT_AUDIO = new Set(['.wav', '.mp3', '.aac', '.flac', '.m4a']);

export interface IScannedFile {
  path: string;
  kind: EAssetKind;
  sizeBytes: number;
}

export function classifyExt(ext: string): EAssetKind | null {
  const lower = ext.toLowerCase();
  if (CEXT_VIDEO.has(lower)) return 'video';
  if (CEXT_PHOTO.has(lower)) return 'photo';
  if (CEXT_AUDIO.has(lower)) return 'audio';
  return null;
}

export async function scanDirectory(dir: string): Promise<IScannedFile[]> {
  const results: IScannedFile[] = [];
  await walk(dir, results);
  return results;
}

async function walk(dir: string, out: IScannedFile[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, out);
    } else if (entry.isFile()) {
      const kind = classifyExt(extname(entry.name));
      if (kind) {
        const info = await stat(full);
        out.push({ path: full, kind, sizeBytes: info.size });
      }
    }
  }
}
