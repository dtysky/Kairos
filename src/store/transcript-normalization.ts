import { createHash } from 'node:crypto';
import { join } from 'node:path';
import {
  ITranscriptNormalizationConfig,
  type ITranscriptNormalizationConfig as TTranscriptNormalizationConfig,
  type ITranscriptNormalizationRule,
} from '../protocol/schema.js';
import { readJsonOrNull, writeJson } from './writer.js';

export interface ITranscriptNormalizationResult {
  text: string;
  appliedRules: string[];
}

export function getTranscriptNormalizationPath(workspaceRoot: string): string {
  return join(workspaceRoot, 'config', 'transcript-normalization.json');
}

export async function loadTranscriptNormalization(
  workspaceRoot: string,
): Promise<TTranscriptNormalizationConfig> {
  const stored = await readJsonOrNull(
    getTranscriptNormalizationPath(workspaceRoot),
    ITranscriptNormalizationConfig,
  );
  return normalizeTranscriptNormalization(
    stored
      ? { schemaVersion: '1.0', rules: stored.rules ?? [] }
      : { schemaVersion: '1.0', rules: [] },
  );
}

export async function saveTranscriptNormalization(
  workspaceRoot: string,
  config: TTranscriptNormalizationConfig,
): Promise<TTranscriptNormalizationConfig> {
  const normalized = normalizeTranscriptNormalization(config);
  await writeJson(getTranscriptNormalizationPath(workspaceRoot), normalized);
  return normalized;
}

export function normalizeTranscriptNormalization(
  config: TTranscriptNormalizationConfig,
): TTranscriptNormalizationConfig {
  const parsed = ITranscriptNormalizationConfig.parse(config);
  const rules = parsed.rules.map(normalizeRule);
  const owners = new Map<string, string>();
  for (const rule of rules) {
    const key = rule.from.toLocaleLowerCase('zh-CN');
    const existing = owners.get(key);
    if (existing) throw new Error(`transcript normalization source must be unique: ${rule.from}`);
    owners.set(key, rule.from);
  }
  return ITranscriptNormalizationConfig.parse({ schemaVersion: '1.0', rules });
}

export function computeTranscriptNormalizationHash(config: TTranscriptNormalizationConfig): string {
  return createHash('sha256')
    .update(JSON.stringify(normalizeTranscriptNormalization(config)))
    .digest('hex');
}

export function applyTranscriptNormalizations(
  value: string,
  config: TTranscriptNormalizationConfig,
): ITranscriptNormalizationResult {
  const normalized = normalizeTranscriptNormalization(config);
  if (normalized.rules.length === 0 || !value) return { text: value, appliedRules: [] };
  const replacementBySource = new Map(normalized.rules.map(rule => [rule.from, rule.to] as const));
  const sources = [...replacementBySource.keys()].sort((left, right) => (
    right.length - left.length || left.localeCompare(right, 'zh-CN')
  ));
  const pattern = new RegExp(sources.map(escapeRegExp).join('|'), 'gu');
  const applied = new Set<string>();
  const text = value.replace(pattern, source => {
    const replacement = replacementBySource.get(source)!;
    applied.add(`${source}→${replacement}`);
    return replacement;
  });
  return { text, appliedRules: [...applied] };
}

function normalizeRule(rule: ITranscriptNormalizationRule): ITranscriptNormalizationRule {
  const from = rule.from.normalize('NFKC').trim();
  const to = rule.to.normalize('NFKC').trim();
  if (!from) throw new Error('transcript normalization source must not be empty');
  if (!to) throw new Error(`transcript normalization target must not be empty: ${from}`);
  if (from === to) throw new Error(`transcript normalization rule must change text: ${from}`);
  return { from, to };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
