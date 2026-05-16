import type { IKtepEvidence } from '../../protocol/schema.js';
import type { MlClient, IMlVlmTiming } from './ml-client.js';
import type { IShotKeyframeGroup } from './keyframe.js';

const CFINE_SCAN_MAX_TOKENS = 96;

const CVLM_PROMPT = `Analyze these travel-video frames. Return only a compact JSON object:
{"description":"one short factual visual observation in Chinese or English"}
Rules:
- description must be one sentence, at most 32 words.
- Describe only visible visual facts in the frames.
- Do not include route ownership, day labels, GPS coordinates, timestamps, Pharos ids, or trip names.
- Do not include markdown or extra explanation.`;

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

export interface IRecognizeShotGroupsOptions {
  onProgress?: (progress: IRecognizeShotGroupsProgress) => Promise<void> | void;
}

export interface IRecognizeShotGroupsProgress {
  totalGroups: number;
  completedGroups: number;
  currentShotId?: string;
  currentFrameCount?: number;
  lastRoundTripMs?: number;
}

export async function recognizeFrames(
  client: MlClient,
  imagePaths: string[],
): Promise<IRecognition> {
  const startedAt = Date.now();
  const result = await client.vlmAnalyze(imagePaths, CVLM_PROMPT, {
    maxTokens: CFINE_SCAN_MAX_TOKENS,
  });
  const roundTripMs = Date.now() - startedAt;

  let parsed: Record<string, unknown> = {};
  try {
    const jsonMatch = result.description.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsedJson = JSON.parse(jsonMatch[0]);
      parsed = parsedJson && typeof parsedJson === 'object' && !Array.isArray(parsedJson)
        ? parsedJson as Record<string, unknown>
        : {};
    }
  } catch (error) {
    void error;
    parsed = {};
  }

  const evidence: IKtepEvidence[] = [];
  if (typeof parsed.description === 'string' && parsed.description) {
    evidence.push({ source: 'vision', value: parsed.description, confidence: 0.7 });
  }
  if (Array.isArray(parsed.place_hints)) {
    for (const hint of parsed.place_hints) {
      if (typeof hint !== 'string') continue;
      evidence.push({ source: 'vision', value: `place:${hint}`, confidence: 0.5 });
    }
  }

  return {
    sceneType: typeof parsed.scene_type === 'string' ? parsed.scene_type : 'unknown',
    subjects: Array.isArray(parsed.subjects)
      ? parsed.subjects.filter((item): item is string => typeof item === 'string')
      : [],
    mood: typeof parsed.mood === 'string' ? parsed.mood : 'unknown',
    placeHints: Array.isArray(parsed.place_hints)
      ? parsed.place_hints.filter((item): item is string => typeof item === 'string')
      : [],
    narrativeRole: typeof parsed.narrative_role === 'string' ? parsed.narrative_role : 'filler',
    description: normalizeRecognitionDescription(parsed.description, result.description),
    evidence,
    timing: result.timing,
    roundTripMs,
    imageCount: imagePaths.length,
  };
}

function normalizeRecognitionDescription(
  parsedDescription: unknown,
  responseText: string,
): string {
  const description = typeof parsedDescription === 'string'
    ? parsedDescription.trim()
    : '';
  if (description) return description;
  return responseText
    .replace(/```(?:json)?/giu, '')
    .replace(/```/gu, '')
    .trim();
}

export async function recognizeShotGroups(
  client: MlClient,
  groups: IShotKeyframeGroup[],
  options?: IRecognizeShotGroupsOptions,
): Promise<IShotRecognition[]> {
  const results: IShotRecognition[] = [];
  let progressChain = Promise.resolve();
  const reportProgress = async (progress: IRecognizeShotGroupsProgress) => {
    if (!options?.onProgress) return;
    progressChain = progressChain
      .then(() => options.onProgress?.(progress))
      .catch(() => undefined);
    await progressChain;
  };

  await reportProgress({
    totalGroups: groups.length,
    completedGroups: 0,
  });

  for (const group of groups) {
    const framePaths = group.frames.map(frame => frame.path);
    if (framePaths.length === 0) continue;
    await reportProgress({
      totalGroups: groups.length,
      completedGroups: results.length,
      currentShotId: group.shotId,
      currentFrameCount: framePaths.length,
    });
    const recognition = await recognizeFrames(client, framePaths);
    results.push({
      shotId: group.shotId,
      startMs: group.startMs,
      endMs: group.endMs,
      framePaths,
      recognition,
    });
    await reportProgress({
      totalGroups: groups.length,
      completedGroups: results.length,
      currentShotId: group.shotId,
      currentFrameCount: framePaths.length,
      lastRoundTripMs: recognition.roundTripMs,
    });
  }

  return results;
}
