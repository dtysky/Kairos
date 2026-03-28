const CDEFAULT_URL = 'http://127.0.0.1:8910';

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
  modelsLoaded: string[];
}

export class MlClient {
  constructor(private baseUrl = CDEFAULT_URL) {}

  async health(): Promise<IMlHealth> {
    return this.post('/health', {});
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
    const res = await fetch(`${this.baseUrl}${path}`, {
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
