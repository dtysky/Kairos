import { readdir, stat } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';
import type { EAssetKind } from '../../protocol/schema.js';
import { mapWithConcurrency } from './concurrency.js';

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

export interface IScanDirectoryOptions {
  excludeSubtrees?: string[];
  onFile?: (file: IScannedFile) => void | Promise<void>;
  onDirectory?: (directory: string) => void | Promise<void>;
}

export function classifyExt(ext: string): EAssetKind | null {
  const lower = ext.toLowerCase();
  if (CEXT_VIDEO.has(lower)) return 'video';
  if (CEXT_PHOTO.has(lower)) return 'photo';
  if (CEXT_AUDIO.has(lower)) return 'audio';
  return null;
}

export async function scanDirectory(
  dir: string,
  options: IScanDirectoryOptions = {},
): Promise<IScannedFile[]> {
  const results: IScannedFile[] = [];
  const excludeSubtrees = (options.excludeSubtrees ?? []).map(normalizeComparablePath);
  await walk(dir, results, excludeSubtrees, options);
  return results;
}

async function walk(
  dir: string,
  out: IScannedFile[],
  excludeSubtrees: string[],
  options: IScanDirectoryOptions,
): Promise<void> {
  if (shouldExcludePath(dir, excludeSubtrees)) return;
  await options.onDirectory?.(dir);
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  const files = await mapWithConcurrency(entries, 16, async entry => {
    const kind = entry.isFile() ? classifyExt(extname(entry.name)) : null;
    if (!kind) return null;
    const path = join(dir, entry.name);
    const info = await stat(path);
    const file = { path, kind, sizeBytes: info.size };
    await options.onFile?.(file);
    return file;
  });

  for (const [index, entry] of entries.entries()) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (shouldExcludePath(full, excludeSubtrees)) {
        continue;
      }
      await walk(full, out, excludeSubtrees, options);
    } else if (files[index]) {
      out.push(files[index]!);
    }
  }
}

function shouldExcludePath(path: string, excludeSubtrees: string[]): boolean {
  const candidate = normalizeComparablePath(path);
  return excludeSubtrees.some(excluded => {
    if (candidate === excluded) return true;
    const rel = relative(excluded, candidate);
    return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel);
  });
}

function normalizeComparablePath(path: string): string {
  const normalized = resolve(path);
  return process.platform === 'win32'
    ? normalized.toLowerCase()
    : normalized;
}
