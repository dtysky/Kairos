import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
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

const IV2TranscriptGlossaryConfig = z.object({
  schemaVersion: z.literal('2.0'),
  entries: z.array(z.object({
    canonical: z.string(),
    pronunciation: z.string().optional(),
    context: z.string(),
  })).default([]),
});

export function getTranscriptGlossaryPath(workspaceRoot: string): string {
  return join(workspaceRoot, 'config', 'transcript-glossary.json');
}

export function getTranscriptDomainGlossaryRoot(workspaceRoot: string): string {
  return join(workspaceRoot, 'resources', 'transcript-glossaries');
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
  const v2 = IV2TranscriptGlossaryConfig.safeParse(stored);
  if (v2.success) {
    return normalizeTranscriptGlossary({
      schemaVersion: '3.0',
      entries: v2.data.entries.map(entry => ({
        canonical: entry.canonical,
        context: entry.context,
      })),
    });
  }
  const legacy = ILegacyTranscriptGlossaryConfig.safeParse(stored);
  if (legacy.success) {
    return normalizeTranscriptGlossary({
      schemaVersion: '3.0',
      entries: legacy.data.entries.map(entry => ({
        canonical: entry.canonical,
        context: entry.note?.trim()
          || `仅在完整句子与当前行程语境明确指向“${entry.canonical.trim()}”时`,
      })),
    });
  }
  return { schemaVersion: '3.0', entries: [] };
}

export async function saveTranscriptGlossary(
  workspaceRoot: string,
  config: TTranscriptGlossaryConfig,
): Promise<TTranscriptGlossaryConfig> {
  const normalized = normalizeTranscriptGlossary(config);
  await writeJson(getTranscriptGlossaryPath(workspaceRoot), normalized);
  return normalized;
}

export async function loadEffectiveTranscriptGlossary(
  workspaceRoot: string,
): Promise<TTranscriptGlossaryConfig> {
  const [domain, workspace] = await Promise.all([
    loadTranscriptDomainGlossary(workspaceRoot),
    loadTranscriptGlossary(workspaceRoot),
  ]);
  const entries = new Map<string, ITranscriptGlossaryEntry>();
  for (const entry of domain.entries) entries.set(normalizeGlossaryLookupKey(entry.canonical), entry);
  for (const entry of workspace.entries) entries.set(normalizeGlossaryLookupKey(entry.canonical), entry);
  return normalizeTranscriptGlossary({ schemaVersion: '3.0', entries: [...entries.values()] });
}

export async function loadTranscriptDomainGlossary(
  workspaceRoot: string,
): Promise<TTranscriptGlossaryConfig> {
  const root = getTranscriptDomainGlossaryRoot(workspaceRoot);
  let names: string[];
  try {
    names = (await readdir(root, { withFileTypes: true }))
      .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
      .map(entry => entry.name)
      .sort((left, right) => left.localeCompare(right, 'en'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { schemaVersion: '3.0', entries: [] };
    }
    throw error;
  }
  const entries: ITranscriptGlossaryEntry[] = [];
  const owners = new Map<string, string>();
  for (const name of names) {
    const stored = await readJsonOrNull(join(root, name), z.unknown());
    const parsed = ITranscriptGlossaryConfig.parse(stored);
    for (const entry of normalizeTranscriptGlossary(parsed).entries) {
      const key = normalizeGlossaryLookupKey(entry.canonical);
      const owner = owners.get(key);
      if (owner) throw new Error(`duplicate built-in transcript glossary canonical ${entry.canonical}: ${owner}, ${name}`);
      owners.set(key, name);
      entries.push(entry);
    }
  }
  return normalizeTranscriptGlossary({ schemaVersion: '3.0', entries });
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
  return ITranscriptGlossaryConfig.parse({ schemaVersion: '3.0', entries });
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
    context,
  };
}
