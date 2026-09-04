import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import {
  ITranscriptGlossaryConfig,
  type ITranscriptGlossaryConfig as TTranscriptGlossaryConfig,
  type ITranscriptGlossaryEntry,
} from '../protocol/schema.js';
import { readJsonOrNull, writeJson } from './writer.js';

const ILegacyTranscriptGlossaryConfig = z.object({
  schemaVersion: z.literal('1.0'),
  entries: z.array(z.object({
    canonical: z.string(),
    aliases: z.array(z.string()).default([]),
    category: z.string().optional(),
    note: z.string().optional(),
  })).default([]),
});

export function getTranscriptGlossaryPath(workspaceRoot: string): string {
  return join(workspaceRoot, 'config', 'transcript-glossary.json');
}

export async function loadTranscriptGlossary(
  workspaceRoot: string,
): Promise<TTranscriptGlossaryConfig> {
  const stored = await readJsonOrNull(
    getTranscriptGlossaryPath(workspaceRoot),
    z.unknown(),
  );
  const current = ITranscriptGlossaryConfig.safeParse(stored);
  if (current.success) return normalizeTranscriptGlossary(current.data);
  const legacy = ILegacyTranscriptGlossaryConfig.safeParse(stored);
  if (legacy.success) {
    return normalizeTranscriptGlossary({
      schemaVersion: '2.0',
      entries: legacy.data.entries.map(entry => ({
        canonical: entry.canonical,
        context: entry.note?.trim()
          || `仅在完整句子与当前行程语境明确指向“${entry.canonical.trim()}”时`,
      })),
    });
  }
  return { schemaVersion: '2.0', entries: [] };
}

export async function saveTranscriptGlossary(
  workspaceRoot: string,
  config: TTranscriptGlossaryConfig,
): Promise<TTranscriptGlossaryConfig> {
  const normalized = normalizeTranscriptGlossary(config);
  await writeJson(getTranscriptGlossaryPath(workspaceRoot), normalized);
  return normalized;
}

export function normalizeTranscriptGlossary(
  config: TTranscriptGlossaryConfig,
): TTranscriptGlossaryConfig {
  const parsed = ITranscriptGlossaryConfig.parse(config);
  const entries = parsed.entries.map(normalizeTranscriptGlossaryEntry);
  const canonicalOwners = new Map<string, string>();

  for (const entry of entries) {
    const canonicalKey = normalizeGlossaryLookupKey(entry.canonical);
    const existingCanonical = canonicalOwners.get(canonicalKey);
    if (existingCanonical) {
      throw new Error(`transcript glossary canonical must be unique: ${entry.canonical}`);
    }
    canonicalOwners.set(canonicalKey, entry.canonical);
  }
  return ITranscriptGlossaryConfig.parse({ schemaVersion: '2.0', entries });
}

export function computeTranscriptGlossaryHash(config: TTranscriptGlossaryConfig): string {
  return createHash('sha256')
    .update(JSON.stringify(normalizeTranscriptGlossary(config)))
    .digest('hex');
}

export function normalizeGlossaryLookupKey(value: string): string {
  return value.normalize('NFKC').trim().toLocaleLowerCase('zh-CN');
}

function normalizeTranscriptGlossaryEntry(entry: ITranscriptGlossaryEntry): ITranscriptGlossaryEntry {
  const canonical = entry.canonical.normalize('NFKC').trim();
  if (!canonical) {
    throw new Error('transcript glossary canonical must not be empty');
  }
  const context = entry.context.normalize('NFKC').trim();
  if (!context) {
    throw new Error(`transcript glossary context must not be empty: ${canonical}`);
  }
  return {
    canonical,
    pronunciation: entry.pronunciation?.normalize('NFKC').trim() || undefined,
    context,
  };
}
