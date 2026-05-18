import type { IKtepEvidence } from '../../protocol/schema.js';
import type { MlClient, IMlVlmTiming } from './ml-client.js';
import type { IShotKeyframeGroup } from './keyframe.js';

const CFINE_SCAN_MAX_TOKENS = 96;
const CVLM_DESCRIPTION_MAX_ATTEMPTS = 2;

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
  let lastTiming: IMlVlmTiming | undefined;
  let lastRoundTripMs = 0;
  for (let attempt = 1; attempt <= CVLM_DESCRIPTION_MAX_ATTEMPTS; attempt += 1) {
    const startedAt = Date.now();
    const result = await client.vlmAnalyze(imagePaths, CVLM_PROMPT, {
      maxTokens: CFINE_SCAN_MAX_TOKENS,
    });
    const roundTripMs = Date.now() - startedAt;
    lastTiming = result.timing;
    lastRoundTripMs = roundTripMs;

    const parsed = parseRecognitionResponse(result.description);
    const description = normalizeRecognitionDescription(parsed.description);
    if (!description && attempt < CVLM_DESCRIPTION_MAX_ATTEMPTS) {
      continue;
    }
    if (!description) break;

    const evidence: IKtepEvidence[] = [
      { source: 'vision', value: description, confidence: 0.7 },
    ];
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
      description,
      evidence,
      timing: result.timing,
      roundTripMs,
      imageCount: imagePaths.length,
    };
  }

  throw new Error(
    `VLM recognition returned no visual description after ${CVLM_DESCRIPTION_MAX_ATTEMPTS} attempts`
      + ` for ${imagePaths.length} frame(s)${lastTiming?.modelRef ? ` (${lastTiming.modelRef})` : ''}; last round trip ${lastRoundTripMs}ms`,
  );
}

function parseRecognitionResponse(responseText: string): Record<string, unknown> {
  try {
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return {};
    const parsedJson = JSON.parse(jsonMatch[0]);
    return parsedJson && typeof parsedJson === 'object' && !Array.isArray(parsedJson)
      ? parsedJson as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function normalizeRecognitionDescription(parsedDescription: unknown): string {
  return typeof parsedDescription === 'string'
    ? parsedDescription.trim()
    : '';
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
