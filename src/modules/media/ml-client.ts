import nodeFetch from 'node-fetch';
import { toLocalWindowsServicePath } from './tool-path.js';

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

export interface IMlAsrTiming {
  backend?: string;
  modelRef?: string;
  totalMs?: number;
  loadMs?: number;
  wavExtractMs?: number;
  inferenceMs?: number;
  queueWaitMs?: number;
  batched?: boolean;
  batchSize?: number;
  silenceGateMs?: number;
  skippedSilent?: boolean;
  effectiveAudioDetected?: boolean;
  silenceGateStats?: {
    sampledWindows?: number;
    maxRms?: number | null;
    maxPeak?: number | null;
    probeFailed?: boolean;
  };
}

export interface IMlVlmTiming {
  backend?: string;
  modelRef?: string;
  totalMs?: number;
  loadMs?: number;
  imageOpenMs?: number;
  processorMs?: number;
  h2dMs?: number;
  generateMs?: number;
  decodeMs?: number;
}

export interface IAsrResult {
  segments: IAsrSegment[];
  timing?: IMlAsrTiming;
}

export interface IOcrResult {
  text: string;
  confidence: number;
  bbox?: [number, number, number, number];
}

export interface IVlmResult {
  description: string;
  timing?: IMlVlmTiming;
}

export interface IMlHealth {
  status: string;
  device: string;
  backend: string;
  models_loaded: string[];
  limits?: {
    asrBatchMaxItems?: number;
    asrBatchMaxWaitMs?: number;
    asrPreprocessMaxConcurrency?: number;
    asrMode?: string;
    asrQueuedRequests?: number;
  };
}

export interface IMlRequestOptions {
  keepOtherModelsLoaded?: boolean;
  maxTokens?: number;
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

  async asr(
    audioPath: string,
    language?: string,
    options?: IMlRequestOptions,
  ): Promise<IAsrSegment[]> {
    const res = await this.asrDetailed(audioPath, language, options);
    return res.segments;
  }

  async asrDetailed(
    audioPath: string,
    language?: string,
    options?: IMlRequestOptions,
  ): Promise<IAsrResult> {
    return this.post<IAsrResult>('/asr', {
      audio_path: this.normalizePath(audioPath),
      language,
      keep_other_models_loaded: options?.keepOtherModelsLoaded ?? false,
    });
  }

  async ocr(imagePath: string): Promise<IOcrResult[]> {
    const res = await this.post<{ texts: IOcrResult[] }>('/ocr', {
      image_path: this.normalizePath(imagePath),
    });
    return res.texts;
  }

  async clipEmbed(imagePaths: string[]): Promise<number[][]> {
    const res = await this.post<{ embeddings: number[][] }>('/clip/embed', {
      image_paths: imagePaths.map(path => this.normalizePath(path)),
    });
    return res.embeddings;
  }

  async vlmAnalyze(
    imagePaths: string[],
    prompt: string,
    options?: IMlRequestOptions,
  ): Promise<IVlmResult> {
    return this.post<IVlmResult>('/vlm/analyze', {
      image_paths: imagePaths.map(path => this.normalizePath(path)),
      prompt,
      keep_other_models_loaded: options?.keepOtherModelsLoaded ?? false,
      max_tokens: options?.maxTokens,
    });
  }

  private normalizePath(filePath: string): string {
    return toLocalWindowsServicePath(filePath, this.baseUrl);
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
