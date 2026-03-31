import { writeFile, readFile, rename, mkdir, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { z } from 'zod';

const CRETRYABLE_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const CRENAME_RETRY_DELAYS_MS = [40, 80, 120, 180, 260, 360, 500, 700, 1000];

export async function readJson<T>(path: string, schema: z.ZodType<T>): Promise<T> {
  const raw = await readFile(path, 'utf-8');
  return schema.parse(JSON.parse(raw));
}

export async function readJsonOrNull<T>(path: string, schema: z.ZodType<T>): Promise<T | null> {
  try {
    return await readJson(path, schema);
  } catch {
    return null;
  }
}

export async function writeJson(path: string, data: unknown): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });

  const tmp = join(dir, `.tmp-${randomUUID()}.json`);
  try {
    await writeFile(tmp, JSON.stringify(data, null, 2) + '\n', 'utf-8');
    await renameWithRetry(tmp, path);
  } finally {
    await unlink(tmp).catch(() => undefined);
  }
}

async function renameWithRetry(tmp: string, path: string): Promise<void> {
  let lastError: unknown;

  for (const delayMs of [0, ...CRENAME_RETRY_DELAYS_MS]) {
    if (delayMs > 0) {
      await sleep(delayMs);
    }

    try {
      await rename(tmp, path);
      return;
    } catch (error) {
      const code = getErrorCode(error);
      if (!code || !CRETRYABLE_RENAME_CODES.has(code)) {
        throw error;
      }
      lastError = error;
    }
  }

  throw lastError;
}

function getErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const code = Reflect.get(error, 'code');
  return typeof code === 'string' ? code : undefined;
}

async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}
