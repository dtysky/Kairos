import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { IEditRuleCategoryConfig, IStyleProfile } from '../../protocol/schema.js';
import {
  getWorkspaceEditRulesRoot,
  loadEditRulesConfig,
} from '../../store/workspace-config.js';
import { parseStyleMarkdown } from './style-loader.js';

export async function listEditRuleCategories(
  workspaceRoot: string,
): Promise<IEditRuleCategoryConfig[]> {
  const config = await loadEditRulesConfig(workspaceRoot);
  return config.categories;
}

export async function loadEditRuleByCategory(
  workspaceRoot: string,
  category: string,
): Promise<IStyleProfile> {
  const config = await loadEditRulesConfig(workspaceRoot);
  const entry = config.categories.find(item => item.categoryId === category);
  if (!entry) {
    throw new Error(`edit rule category "${category}" is not defined in config/edit-rules.json`);
  }
  const profilePath = entry.profilePath?.trim() || `${entry.categoryId}.md`;
  const filePath = join(getWorkspaceEditRulesRoot(workspaceRoot), profilePath);
  return loadEditRuleFromMarkdown(filePath, entry);
}

export async function loadEditRuleFromMarkdown(
  filePath: string,
  category?: IEditRuleCategoryConfig,
): Promise<IStyleProfile> {
  const raw = await readFile(filePath, 'utf-8');
  return parseStyleMarkdown(raw, {
    category: category?.categoryId,
    name: category?.displayName ?? '剪辑规则',
  }, [filePath]);
}
