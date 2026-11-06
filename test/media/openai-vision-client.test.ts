import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IWorkspaceLlmConfig } from '../../src/store/llm-config.js';
import { OpenAiVisionClient } from '../../src/modules/media/openai-vision-client.js';
import { MlClient } from '../../src/modules/media/ml-client.js';

const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); })));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function fixture(handler: (req: IncomingMessage, res: ServerResponse, body: any) => void, timeoutMs = 1000) {
  const root = await mkdtemp(join(tmpdir(), 'kairos-openai-'));
  roots.push(root);
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    handler(req, res, chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null);
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const config = IWorkspaceLlmConfig.parse({ openai: { baseUrl, timeoutMs } }).openai;
  const frames = [join(root, 'one.jpg'), join(root, 'two.png')];
  await writeFile(frames[0]!, 'first-frame-bytes');
  await writeFile(frames[1]!, 'second-frame-bytes');
  const auditPath = join(root, 'llm-requests.jsonl');
  const client = new OpenAiVisionClient(config, 'private-test-key', auditPath);
  return { client, config, frames, root, baseUrl, auditPath };
}
function respond(res: ServerResponse, payload: unknown, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'x-request-id': 'req_test' });
  res.end(JSON.stringify(payload));
}
const completed = { status: 'completed', model: 'gpt-6-luna', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '{"type":"drive"}' }] }], usage: { input_tokens: 200, input_tokens_details: { cached_tokens: 50, cache_write_tokens: 10 }, output_tokens: 100, output_tokens_details: { reasoning_tokens: 75 }, total_tokens: 300 } };

describe('OpenAI visual transport contract', () => {
  it('preserves exact prompt/image order and uses an independent reasoning budget with no conversation state', async () => {
    const requests: any[] = [];
    const { client, frames, auditPath } = await fixture((req, res, body) => {
      requests.push(body);
      expect(req.url).toBe('/responses');
      expect(req.headers.authorization).toBe('Bearer private-test-key');
      respond(res, completed);
    });
    const result = await client.vlmAnalyze(frames, 'Exact existing prompt\n请按原 schema 输出。', { maxTokens: 96 });
    expect(requests[0]).toMatchObject({ model: 'gpt-6-luna', reasoning: { effort: 'high' }, store: false, service_tier: 'default', max_output_tokens: 32768 });
    expect(requests[0].input[0].content).toEqual([
      { type: 'input_text', text: 'Exact existing prompt\n请按原 schema 输出。' },
      { type: 'input_image', detail: 'high', image_url: `data:image/jpeg;base64,${Buffer.from('first-frame-bytes').toString('base64')}` },
      { type: 'input_image', detail: 'high', image_url: `data:image/png;base64,${Buffer.from('second-frame-bytes').toString('base64')}` },
    ]);
    expect(requests[0]).not.toHaveProperty('previous_response_id');
    expect(result.description).toBe('{"type":"drive"}');
    expect(result.timing?.usage).toEqual({ inputTokens: 200, cachedInputTokens: 50, cacheWriteTokens: 10, outputTokens: 100, reasoningTokens: 75, totalTokens: 300 });
    const audit = await readFile(auditPath, 'utf8');
    expect(audit).not.toContain('private-test-key');
    expect(audit).not.toContain('Exact existing prompt');
    expect(JSON.parse(audit)).toMatchObject({ status: 'completed', requestId: 'req_test', requestedLocalMaxTokens: 96, maxOutputTokens: 32768 });
  });

  it('retries transient HTTP failures with identical payloads and audits each attempt', async () => {
    const requests: unknown[] = [];
    const { client, frames, auditPath } = await fixture((_req, res, body) => {
      requests.push(body);
      respond(res, requests.length === 1 ? { error: { message: 'private-test-key' } } : completed, requests.length === 1 ? 429 : 200);
    });
    await client.vlmAnalyze(frames, 'same prompt');
    expect(requests).toHaveLength(2);
    expect(requests[0]).toEqual(requests[1]);
    expect((await readFile(auditPath, 'utf8')).trim().split('\n').map(row => JSON.parse(row).status)).toEqual(['failed', 'completed']);
  });

  it.each([
    ['HTTP 401', 401, { error: { message: 'private-test-key' } }],
    ['incomplete', 200, { ...completed, status: 'incomplete' }],
    ['refusal', 200, { ...completed, output: [{ type: 'message', role: 'assistant', content: [{ type: 'refusal' }] }] }],
    ['empty_output', 200, { ...completed, output: [] }],
  ])('fails %s without retrying, leaking errors or using local fallback', async (error, status, payload) => {
    let calls = 0;
    const { client, frames, auditPath } = await fixture((_req, res) => { calls++; respond(res, payload, status); });
    await expect(client.vlmAnalyze(frames, 'same')).rejects.toThrow(error);
    expect(calls).toBe(1);
    const audit = await readFile(auditPath, 'utf8');
    expect(audit).not.toContain('private-test-key');
    if (error === 'incomplete') expect(JSON.parse(audit).usage.outputTokens).toBe(100);
  });

  it('bounds timeout retries and records terminal failure', async () => {
    const { config, frames, auditPath } = await fixture(() => {});
    const client = new OpenAiVisionClient({ ...config, timeoutMs: 15 }, 'private-test-key', auditPath);
    await expect(client.vlmAnalyze(frames, 'same')).rejects.toThrow('timeout');
    const rows = (await readFile(auditPath, 'utf8')).trim().split('\n').map(row => JSON.parse(row));
    expect(rows).toHaveLength(3);
    expect(rows.every(row => row.error === 'timeout')).toBe(true);
  });

  it('injects only vision: health, ASR and text still use their existing local endpoints', async () => {
    const routes: string[] = [];
    const { client, baseUrl, frames } = await fixture((req, res) => {
      routes.push(req.url!);
      respond(res, req.url === '/responses' ? completed : req.url === '/health' ? { status: 'ok' } : req.url === '/asr' ? { segments: [] } : { text: 'local-text' });
    });
    const ml = new MlClient(baseUrl, client);
    await ml.health();
    await ml.asrDetailed('/test.wav');
    await ml.textGenerate('tags');
    await ml.vlmAnalyze(frames, 'original');
    expect(routes).toEqual(['/health', '/asr', '/text/generate', '/responses']);
  });
});
