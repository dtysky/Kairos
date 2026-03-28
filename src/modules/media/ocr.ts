import type { IKtepEvidence } from '../../protocol/schema.js';
import type { MlClient, IOcrResult } from './ml-client.js';

export interface IOcrExtraction {
  results: IOcrResult[];
  evidence: IKtepEvidence[];
}

export async function extractOcr(
  client: MlClient,
  imagePath: string,
): Promise<IOcrExtraction> {
  const results = await client.ocr(imagePath);
  const evidence: IKtepEvidence[] = results
    .filter(r => r.text.trim().length > 0)
    .map(r => ({
      source: 'ocr' as const,
      value: r.text.trim(),
      confidence: r.confidence,
    }));

  return { results, evidence };
}
