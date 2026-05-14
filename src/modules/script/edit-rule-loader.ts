import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { IEditRuleCategoryConfig, IEditRuleMarkdownSource } from '../../protocol/schema.js';
import { IEditRuleMarkdownSource as ZEditRuleMarkdownSource } from '../../protocol/schema.js';
import {
  getWorkspaceEditRulesRoot,
  loadEditRulesConfig,
} from '../../store/workspace-config.js';

export async function listEditRuleCategories(
  workspaceRoot: string,
): Promise<IEditRuleCategoryConfig[]> {
  const config = await loadEditRulesConfig(workspaceRoot);
  return config.categories;
}

export async function loadEditRuleByCategory(
  workspaceRoot: string,
  category: string,
): Promise<IEditRuleMarkdownSource> {
  const config = await loadEditRulesConfig(workspaceRoot);
  const entry = config.categories.find(item => item.categoryId === category);
  if (!entry) {
    throw new Error(`edit rule category "${category}" is not defined in config/edit-rules/*.md`);
  }
  const profilePath = entry.rulePath?.trim() || entry.profilePath?.trim() || `${entry.categoryId}.md`;
  const filePath = join(getWorkspaceEditRulesRoot(workspaceRoot), profilePath);
  return loadEditRuleFromMarkdown(filePath, entry);
}

export async function loadEditRuleFromMarkdown(
  filePath: string,
  category?: IEditRuleCategoryConfig,
): Promise<IEditRuleMarkdownSource> {
  const markdown = await readFile(filePath, 'utf-8');
  const frontMatter = parseFrontMatter(markdown);
  const categoryId = (category?.categoryId || frontMatter.category || frontMatter.categoryId || 'edit-rule').trim();
  const displayName = (category?.displayName || frontMatter.name || frontMatter.title || categoryId).trim();
  const profilePath = category?.rulePath || category?.profilePath || filePath.split(/[\\/]/u).pop() || `${categoryId}.md`;
  return ZEditRuleMarkdownSource.parse({
    categoryId,
    displayName,
    description: category?.description || frontMatter.description || undefined,
    profilePath,
    absolutePath: filePath,
    contentHash: createHash('sha256').update(markdown).digest('hex'),
    frontMatter,
    markdown,
  });
}

function parseFrontMatter(markdown: string): Record<string, string> {
  const match = markdown.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/u);
  if (!match?.[1]) return {};
  const frontMatter: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const parts = line.match(/^([\w-]+)\s*:\s*(.*)$/u);
    if (!parts?.[1]) continue;
    frontMatter[parts[1]] = parts[2]?.trim() || '';
  }
  return frontMatter;
}
