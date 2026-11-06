import { readFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { writeJson } from './writer.js';

function isSafeBaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    return (url.protocol === 'https:' || (loopback && url.protocol === 'http:'))
      && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}

const IOpenAiConfig = z.object({
  model: z.string().trim().min(1).default('gpt-6-luna'),
  reasoningEffort: z.enum(['none', 'low', 'medium', 'high', 'xhigh', 'max']).default('high'),
  baseUrl: z.string().trim().refine(isSafeBaseUrl, '需要 HTTPS 或本机 HTTP URL，不能包含凭证、query 或 fragment')
    .transform(value => value.replace(/\/+$/u, '')).default('https://api.openai.com/v1'),
  maxOutputTokens: z.number().int().min(1024).max(128000).default(32768),
  timeoutMs: z.number().int().min(1000).max(600000).default(180000),
  apiKey: z.string().trim().optional(),
});

export const IWorkspaceLlmConfig = z.object({
  backend: z.enum(['local', 'openai']).default('local'),
  openai: IOpenAiConfig.default({}),
});
export type IWorkspaceLlmConfig = z.infer<typeof IWorkspaceLlmConfig>;
export interface IWorkspaceLlmConfigView {
  backend: IWorkspaceLlmConfig['backend'];
  openai: Omit<IWorkspaceLlmConfig['openai'], 'apiKey'> & {
    apiKeyConfigured: boolean;
    apiKeySource: 'config' | 'environment' | 'none';
  };
}

const IUpdate = z.object({
  backend: z.enum(['local', 'openai']).optional(),
  openai: IOpenAiConfig.partial().extend({ apiKey: z.string().nullable().optional() }).optional(),
});

async function readRuntime(workspaceRoot: string): Promise<Record<string, unknown>> {
  let raw: string;
  try { raw = await readFile(join(workspaceRoot, 'config/runtime.json'), 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
  // JSON parser errors can include source snippets containing a secret.
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { throw new Error('全局 runtime.json 不是有效 JSON；请检查配置文件。'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('全局 runtime.json 必须是 JSON object。');
  }
  return value as Record<string, unknown>;
}

function parseConfig(input: unknown): IWorkspaceLlmConfig {
  const parsed = IWorkspaceLlmConfig.safeParse(input);
  if (!parsed.success) {
    throw new Error(`LLM 配置无效：${parsed.error.issues.map(issue => issue.path.join('.')).join(', ')}`);
  }
  return parsed.data;
}

/** Server-side only; deliberately does not resolve project-local runtime overrides. */
export async function loadWorkspaceLlmConfig(workspaceRoot: string): Promise<IWorkspaceLlmConfig> {
  return parseConfig((await readRuntime(workspaceRoot)).llm ?? {});
}

export function resolveOpenAiApiKey(config: IWorkspaceLlmConfig): string | undefined {
  return config.openai.apiKey?.trim() || process.env['OPENAI_API_KEY']?.trim() || undefined;
}

export function toWorkspaceLlmConfigView(config: IWorkspaceLlmConfig): IWorkspaceLlmConfigView {
  const { apiKey, ...openai } = config.openai;
  const apiKeySource = apiKey?.trim() ? 'config' : process.env['OPENAI_API_KEY']?.trim() ? 'environment' : 'none';
  return { backend: config.backend, openai: { ...openai, apiKeyConfigured: apiKeySource !== 'none', apiKeySource } };
}

export async function loadWorkspaceLlmConfigView(workspaceRoot: string): Promise<IWorkspaceLlmConfigView> {
  return toWorkspaceLlmConfigView(await loadWorkspaceLlmConfig(workspaceRoot));
}

export async function saveWorkspaceLlmConfig(workspaceRoot: string, input: unknown): Promise<IWorkspaceLlmConfigView> {
  const patch = IUpdate.safeParse(input);
  if (!patch.success) {
    throw new Error(`LLM 配置无效：${patch.error.issues.map(issue => issue.path.join('.')).join(', ')}`);
  }
  const runtime = await readRuntime(workspaceRoot);
  const previous = parseConfig(runtime.llm ?? {});
  const { apiKey, ...openai } = patch.data.openai ?? {};
  const config = parseConfig({
    backend: patch.data.backend ?? previous.backend,
    openai: {
      ...previous.openai,
      ...openai,
      apiKey: apiKey === null ? undefined : apiKey?.trim() || previous.openai.apiKey,
    },
  });
  const path = join(workspaceRoot, 'config/runtime.json');
  await writeJson(path, { ...runtime, llm: config });
  await chmod(path, 0o600);
  return toWorkspaceLlmConfigView(config);
}
