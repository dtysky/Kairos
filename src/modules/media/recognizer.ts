import type { IKtepEvidence } from '../../protocol/schema.js';
import type { MlClient, IMlVlmTiming } from './ml-client.js';
import type { IShotKeyframeGroup } from './keyframe.js';

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
  timing?: IMlVlmTiming;
  roundTripMs?: number;
  imageCount?: number;
}

export interface IShotRecognition {
  shotId: string;
  startMs: number;
  endMs: number;
  framePaths: string[];
  recognition: IRecognition;
}

export async function recognizeFrames(
  client: MlClient,
  imagePaths: string[],
): Promise<IRecognition> {
  const startedAt = Date.now();
  const result = await client.vlmAnalyze(imagePaths, CVLM_PROMPT);
  const roundTripMs = Date.now() - startedAt;

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
    timing: result.timing,
    roundTripMs,
    imageCount: imagePaths.length,
  };
}

export async function recognizeShotGroups(
  client: MlClient,
  groups: IShotKeyframeGroup[],
): Promise<IShotRecognition[]> {
  const results: IShotRecognition[] = [];

  for (const group of groups) {
    const framePaths = group.frames.map(frame => frame.path);
    if (framePaths.length === 0) continue;
    const recognition = await recognizeFrames(client, framePaths);
    results.push({
      shotId: group.shotId,
      startMs: group.startMs,
      endMs: group.endMs,
      framePaths,
      recognition,
    });
  }

  return results;
}
