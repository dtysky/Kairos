import { join } from 'node:path';
import { z } from 'zod';
import { IMediaChronology } from '../protocol/schema.js';
import { readJsonOrNull, writeJson } from './writer.js';

const IChronologyFile = z.array(IMediaChronology);

export function getChronologyPath(projectRoot: string): string {
  return join(projectRoot, 'media/chronology.json');
}

export async function loadChronology(
  projectRoot: string,
): Promise<IMediaChronology[]> {
  return (await readJsonOrNull(
    getChronologyPath(projectRoot),
    IChronologyFile,
  ) as IMediaChronology[] | null) ?? [];
}

export async function writeChronology(
  projectRoot: string,
  chronology: IMediaChronology[],
): Promise<void> {
  await writeJson(getChronologyPath(projectRoot), chronology);
}
