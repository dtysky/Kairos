import nodeFetch from 'node-fetch';

const CDEFAULT_URL = process.env['KAIROS_ML_URL'] ?? 'http://127.0.0.1:8910';

const fetchCompat: typeof fetch = typeof globalThis.fetch === 'function'
  ? globalThis.fetch.bind(globalThis)
  : ((
    input: Parameters<typeof nodeFetch>[0],
    init?: Parameters<typeof nodeFetch>[1],
  ) => nodeFetch(input, init)) as typeof fetch;

export interface IAsrSegment {
  start: number;
  end: number;
  text: string;
}

export interface IOcrResult {
  text: string;
  confidence: number;
  bbox?: [number, number, number, number];
}

export interface IVlmResult {
  description: string;
}

export interface IMlHealth {
  status: string;
  device: string;
  models_loaded: string[];
}

export class MlClient {
  constructor(private baseUrl = CDEFAULT_URL) {}

  async health(): Promise<IMlHealth> {
    const res = await fetchCompat(`${this.baseUrl}/health`);
    if (!res.ok) {
      throw new Error(`ML server /health: ${res.status} ${await res.text()}`);
    }
    return res.json() as Promise<IMlHealth>;
  }

  async asr(audioPath: string, language?: string): Promise<IAsrSegment[]> {
    const res = await this.post<{ segments: IAsrSegment[] }>('/asr', {
      audio_path: audioPath,
      language,
    });
    return res.segments;
  }

  async ocr(imagePath: string): Promise<IOcrResult[]> {
    const res = await this.post<{ texts: IOcrResult[] }>('/ocr', {
      image_path: imagePath,
    });
    return res.texts;
  }

  async clipEmbed(imagePaths: string[]): Promise<number[][]> {
    const res = await this.post<{ embeddings: number[][] }>('/clip/embed', {
      image_paths: imagePaths,
    });
    return res.embeddings;
  }

  async vlmAnalyze(imagePaths: string[], prompt: string): Promise<IVlmResult> {
    return this.post<IVlmResult>('/vlm/analyze', {
      image_paths: imagePaths,
      prompt,
    });
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetchCompat(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`ML server ${path}: ${res.status} ${await res.text()}`);
    }
    return res.json() as Promise<T>;
  }
}
