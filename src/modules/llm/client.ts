export interface ILlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ILlmOptions {
  temperature?: number;
  maxTokens?: number;
  jsonMode?: boolean;
}

export interface ILlmClient {
  chat(messages: ILlmMessage[], opts?: ILlmOptions): Promise<string>;
}

/**
 * OpenAI-compatible chat client.
 * Works with OpenAI, Azure OpenAI, local vLLM, Ollama (with /v1 compat), etc.
 */
export class OpenAIClient implements ILlmClient {
  constructor(
    private apiKey: string,
    private baseUrl = 'https://api.openai.com/v1',
    private model = 'gpt-4o',
  ) {}

  async chat(messages: ILlmMessage[], opts: ILlmOptions = {}): Promise<string> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages,
    };
    if (opts.temperature != null) body.temperature = opts.temperature;
    if (opts.maxTokens != null) body.max_tokens = opts.maxTokens;
    if (opts.jsonMode) body.response_format = { type: 'json_object' };

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      throw new Error(`LLM API error: ${res.status} ${await res.text()}`);
    }

    const data = await res.json() as any;
    return data.choices[0].message.content;
  }
}
