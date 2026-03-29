import type { IKtepEvidence } from '../../protocol/schema.js';
import type { MlClient } from './ml-client.js';

const CVLM_PROMPT = `Analyze this image from a travel video. Return only a raw JSON object with:
- scene_type: one of "landscape", "cityscape", "driving", "aerial", "food", "portrait", "activity", "landmark", "nature", "interior"
- subjects: string[] of main subjects/objects
- mood: one of "calm", "energetic", "dramatic", "cozy", "melancholic", "joyful"
- place_hints: string[] of any recognizable location clues
- narrative_role: one of "intro", "establishing", "detail", "transition", "climax", "filler"
- description: one sentence summary
Do not use markdown fences or any extra explanation.`;

export interface IRecognition {
  sceneType: string;
  subjects: string[];
  mood: string;
  placeHints: string[];
  narrativeRole: string;
  description: string;
  evidence: IKtepEvidence[];
}

export async function recognizeFrames(
  client: MlClient,
  imagePaths: string[],
): Promise<IRecognition> {
  const result = await client.vlmAnalyze(imagePaths, CVLM_PROMPT);

  let parsed: any;
  try {
    const jsonMatch = result.description.match(/\{[\s\S]*\}/);
    parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : {};
  } catch {
    parsed = {};
  }

  const evidence: IKtepEvidence[] = [];
  if (parsed.description) {
    evidence.push({ source: 'vision', value: parsed.description, confidence: 0.7 });
  }
  if (parsed.place_hints) {
    for (const hint of parsed.place_hints) {
      evidence.push({ source: 'vision', value: `place:${hint}`, confidence: 0.5 });
    }
  }

  return {
    sceneType: parsed.scene_type ?? 'unknown',
    subjects: parsed.subjects ?? [],
    mood: parsed.mood ?? 'unknown',
    placeHints: parsed.place_hints ?? [],
    narrativeRole: parsed.narrative_role ?? 'filler',
    description: parsed.description ?? '',
    evidence,
  };
}
