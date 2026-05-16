import type {
  IKtepAsset,
  IChronologyAssetIndex,
  IProjectChronology,
  IKtepScriptSelection,
  IKtepSlice,
  IStyleProfile,
} from '../../src/protocol/index.js';

const CNOW = '2026-04-18T00:00:00.000Z';

export function createStyleProfile(overrides: Partial<IStyleProfile> = {}): IStyleProfile {
  return {
    id: 'style-test',
    name: 'Test Style',
    category: 'test',
    guidancePrompt: 'Keep it factual.',
    sourceFiles: [],
    narrative: {
      introRatio: 0.1,
      outroRatio: 0.1,
      avgSegmentDurationSec: 8,
      brollFrequency: 0.4,
      pacePattern: 'steady',
    },
    voice: {
      person: '1st',
      tone: 'calm',
      density: 'moderate',
      sampleTexts: [],
    },
    arrangementStructure: {
      primaryAxis: 'chronology',
      secondaryAxes: [],
      chapterPrograms: [],
      chapterSplitPrinciples: [],
      chapterTransitionNotes: [],
    },
    narrationConstraints: {
      perspective: 'first-person',
      tone: 'calm',
      informationDensity: 'moderate',
      explanationBias: 'observational',
      forbiddenPatterns: [],
      notes: [],
    },
    antiPatterns: [],
    parameters: {},
    sections: [],
    createdAt: CNOW,
    updatedAt: CNOW,
    ...overrides,
  };
}

export function createVideoAsset(overrides: Partial<IKtepAsset> & Pick<IKtepAsset, 'id'>): IKtepAsset {
  return {
    id: overrides.id,
    kind: 'video',
    sourcePath: overrides.sourcePath ?? `media/${overrides.id}.mp4`,
    displayName: overrides.displayName ?? overrides.id,
    durationMs: overrides.durationMs ?? 10_000,
    fps: overrides.fps ?? 30,
    width: overrides.width ?? 1920,
    height: overrides.height ?? 1080,
    capturedAt: overrides.capturedAt ?? CNOW,
    createdAt: overrides.createdAt ?? CNOW,
    ingestedAt: overrides.ingestedAt ?? CNOW,
    ...overrides,
  };
}

export function createSelection(input: {
  assetId: string;
  spanId: string;
  sliceId?: string;
  sourceInMs: number;
  sourceOutMs: number;
}): IKtepScriptSelection {
  return {
    assetId: input.assetId,
    spanId: input.spanId,
    sliceId: input.sliceId ?? input.spanId,
    sourceInMs: input.sourceInMs,
    sourceOutMs: input.sourceOutMs,
  };
}

export function createSlice(overrides: Partial<IKtepSlice> & Pick<IKtepSlice, 'id' | 'assetId'>): IKtepSlice {
  return {
    id: overrides.id,
    assetId: overrides.assetId,
    type: overrides.type ?? 'shot',
    semanticKind: overrides.semanticKind,
    sourceInMs: overrides.sourceInMs ?? 0,
    sourceOutMs: overrides.sourceOutMs ?? 5_000,
    editSourceInMs: overrides.editSourceInMs,
    editSourceOutMs: overrides.editSourceOutMs,
    transcript: overrides.transcript,
    transcriptSegments: overrides.transcriptSegments,
    visualObservation: overrides.visualObservation,
    materialPatterns: overrides.materialPatterns ?? [],
    grounding: overrides.grounding ?? {
      speechMode: 'none',
      speechValue: 'none',
      spatialEvidence: [],
      pharosRefs: [],
    },
    pharosRefs: overrides.pharosRefs,
    speechCoverage: overrides.speechCoverage,
    speedCandidate: overrides.speedCandidate,
  };
}

export function createChronology(
  overrides: Partial<IChronologyAssetIndex> & { assetId: string; id?: string; capturedAt?: string },
): IChronologyAssetIndex {
  return {
    assetId: overrides.assetId,
    sortCapturedAt: overrides.sortCapturedAt ?? overrides.capturedAt ?? CNOW,
  };
}

export function createProjectChronology(
  assetIndex: IChronologyAssetIndex[],
  overrides: Partial<IProjectChronology> = {},
): IProjectChronology {
  return {
    schemaVersion: '2.0',
    status: 'confirmed',
    generatedAt: CNOW,
    confirmedAt: CNOW,
    inputsHash: 'test-inputs',
    assetIndex,
    events: [],
    ...overrides,
  };
}
