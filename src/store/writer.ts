import { writeFile, readFile, rename, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { z } from 'zod';

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
  await writeFile(tmp, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  await rename(tmp, path);
}
