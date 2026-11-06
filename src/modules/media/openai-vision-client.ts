import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import nodeFetch from 'node-fetch';
import {
  loadWorkspaceLlmConfig,
  resolveOpenAiApiKey,
  type IWorkspaceLlmConfig,
} from '../../store/llm-config.js';
import type { ILlmUsage, IMlRequestOptions, IVisionClient, IVlmResult } from './ml-client.js';

const fetchCompat = typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : nodeFetch;
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const count = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;

interface IResponse {
  status?: string;
  model?: string;
  output?: Array<{ type: string; role?: string; content?: Array<{ type: string; text?: string }> }>;
  usage?: {
    input_tokens?: number;
    input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
    output_tokens?: number;
    output_tokens_details?: { reasoning_tokens?: number };
    total_tokens?: number;
  };
}

function readUsage(response: IResponse): ILlmUsage | undefined {
  const usage = response.usage;
  if (!usage) return undefined;
  return {
    inputTokens: count(usage.input_tokens),
    cachedInputTokens: count(usage.input_tokens_details?.cached_tokens),
    cacheWriteTokens: count(usage.input_tokens_details?.cache_write_tokens),
    outputTokens: count(usage.output_tokens),
    reasoningTokens: count(usage.output_tokens_details?.reasoning_tokens),
    totalTokens: count(usage.total_tokens),
  };
}

class OpenAiVisionError extends Error {
  constructor(readonly code: string, readonly retryable = false, readonly retryAfterMs = 0) {
    super(`OpenAI 视觉请求失败：${code}。请检查全局 LLM 配置或 API 服务状态；不会切换后端。`);
  }
}

export async function createAnalyzeVisionClient(workspaceRoot: string, projectRoot: string): Promise<IVisionClient | undefined> {
  const config = await loadWorkspaceLlmConfig(workspaceRoot);
  if (config.backend === 'local') return undefined;
  const apiKey = resolveOpenAiApiKey(config);
  if (!apiKey) throw new Error('OpenAI API Key 未配置，请在 /project 的 LLM 全局配置中保存，或设置服务端 OPENAI_API_KEY。');
  return new OpenAiVisionClient(config.openai, apiKey, join(projectRoot, '.tmp/media-analyze/llm-requests.jsonl'));
}

/** Transport adapter only: images, prompt, business parsing and scheduling belong to Analyze. */
export class OpenAiVisionClient implements IVisionClient {
  private readonly runId = randomUUID();
  private readonly configFingerprint: string;

  constructor(
    private readonly config: IWorkspaceLlmConfig['openai'],
    private readonly apiKey: string,
    private readonly auditPath: string,
  ) {
    const { apiKey: _secret, ...settings } = config;
    this.configFingerprint = hash(JSON.stringify({ backend: 'openai', ...settings }));
  }

  async vlmAnalyze(imagePaths: string[], prompt: string, options?: IMlRequestOptions): Promise<IVlmResult> {
    const startedAt = Date.now();
    const frames = await Promise.all(imagePaths.map(async path => {
      const bytes = await readFile(path);
      const extension = extname(path).toLowerCase();
      const mime = extension === '.png' ? 'image/png' : ['.jpg', '.jpeg'].includes(extension) ? 'image/jpeg' : null;
      if (!mime) throw new Error('OpenAI 视觉输入必须是现有 JPEG/PNG 分析帧。');
      return { fingerprint: hash(bytes), url: `data:${mime};base64,${bytes.toString('base64')}` };
    }));
    const inputFingerprint = hash(JSON.stringify({ prompt, frames: frames.map(frame => frame.fingerprint) }));
    const body = JSON.stringify({
      model: this.config.model,
      reasoning: { effort: this.config.reasoningEffort },
      store: false,
      service_tier: 'default',
      max_output_tokens: this.config.maxOutputTokens,
      input: [{ role: 'user', content: [
        { type: 'input_text', text: prompt },
        ...frames.map(frame => ({ type: 'input_image', image_url: frame.url, detail: 'high' })),
      ] }],
    });
    const callId = randomUUID();
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const attemptStartedAt = Date.now();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
      let requestId: string | undefined;
      let usage: ILlmUsage | undefined;
      let actualModel: string | undefined;
      let failure: OpenAiVisionError | undefined;
      let description = '';
      try {
        const response = await fetchCompat(`${this.config.baseUrl}/responses`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
          body,
          signal: controller.signal,
          // Do not forward credentials through an endpoint redirect.
          redirect: 'error',
        });
        const id = response.headers.get('x-request-id');
        requestId = id && /^[a-zA-Z0-9_-]{1,200}$/u.test(id) ? id : undefined;
        const payload = await response.json().catch(() => null) as IResponse | null;
        if (payload && typeof payload === 'object') usage = readUsage(payload);
        if (!response.ok) {
          const after = response.headers.get('retry-after');
          const delay = after && /^\d+(\.\d+)?$/u.test(after) ? Number(after) * 1000 : 0;
          throw new OpenAiVisionError(`HTTP ${response.status}`, [408, 409, 429].includes(response.status) || response.status >= 500, delay);
        }
        if (!payload || typeof payload !== 'object') throw new OpenAiVisionError('invalid_response');
        actualModel = typeof payload.model === 'string' && /^[a-zA-Z0-9._:-]{1,200}$/u.test(payload.model) ? payload.model : undefined;
        if (payload.status !== 'completed') throw new OpenAiVisionError(payload.status === 'incomplete' ? 'incomplete（可能超出推理与输出总预算）' : 'response_not_completed');
        const content = (Array.isArray(payload.output) ? payload.output : [])
          .filter(item => item.type === 'message' && item.role === 'assistant')
          .flatMap(item => Array.isArray(item.content) ? item.content : []);
        if (content.some(item => item.type === 'refusal')) throw new OpenAiVisionError('refusal');
        description = content.filter(item => item.type === 'output_text').map(item => item.text ?? '').join('');
        if (!description.trim()) throw new OpenAiVisionError('empty_output');
      } catch (error) {
        failure = error instanceof OpenAiVisionError ? error : new OpenAiVisionError(controller.signal.aborted ? 'timeout' : 'network_error', true);
      } finally {
        clearTimeout(timeout);
      }
      await mkdir(dirname(this.auditPath), { recursive: true });
      await appendFile(this.auditPath, `${JSON.stringify({
        at: new Date().toISOString(), runId: this.runId, callId, attempt, requestId,
        backend: 'openai', model: this.config.model, actualModel, reasoningEffort: this.config.reasoningEffort,
        configFingerprint: this.configFingerprint, inputFingerprint, imageCount: frames.length,
        requestedLocalMaxTokens: options?.maxTokens, maxOutputTokens: this.config.maxOutputTokens,
        elapsedMs: Date.now() - attemptStartedAt, status: failure ? 'failed' : 'completed', error: failure?.code, usage,
      })}\n`, 'utf8');
      if (!failure) return { description, timing: { backend: 'openai', modelRef: actualModel ?? this.config.model, totalMs: Date.now() - startedAt, requestId, usage } };
      if (!failure.retryable || attempt === 3) throw failure;
      await new Promise(resolve => setTimeout(resolve, Math.min(10000, Math.max(failure!.retryAfterMs, 500 * 2 ** (attempt - 1)))));
    }
    throw new Error('OpenAI 视觉请求未完成。');
  }
}
