import type {
  EClipType,
  IAssetCoarseReport,
  IInterestingWindow,
  IKtepAsset,
  IKtepSlice,
  IProjectPharosContext,
  ISpatialEvidence,
} from '../../protocol/schema.js';
import { resolvePharosTimedSpatialContext } from '../pharos/gpx-timed.js';

const CMATERIAL_PATTERN_LIMIT = 8;

export function createEmptySliceSemantics(): Pick<IKtepSlice, 'materialPatterns' | 'grounding'> {
  return {
    materialPatterns: [],
    grounding: {
      speechMode: 'none',
      speechValue: 'none',
      spatialEvidence: [],
      pharosRefs: [],
    },
  };
}

export async function buildSpatialEvidenceFromReport(input: {
  clipType: EClipType;
  report?: Pick<IAssetCoarseReport, 'inferredGps' | 'pharosMatches'>;
  asset?: Pick<IKtepAsset, 'capturedAt' | 'durationMs'>;
  slice?: Pick<IKtepSlice, 'sourceInMs' | 'sourceOutMs'>;
  pharosContext?: IProjectPharosContext | null;
}): Promise<ISpatialEvidence[]> {
  const evidence: ISpatialEvidence[] = [];
  const inferredGps = input.report?.inferredGps;
  if (inferredGps) {
    const primaryPharosRef = inferredGps.source === 'pharos'
      ? input.report?.pharosMatches?.[0]?.ref
      : undefined;
    const tier = inferredGps.source === 'embedded'
      ? 'truth'
      : inferredGps.source === 'derived-track'
        ? 'weak-inference'
        : 'strong-inference';
    evidence.push({
      tier,
      confidence: inferredGps.confidence,
      sourceKinds: [inferredGps.source],
      lat: inferredGps.lat,
      lng: inferredGps.lng,
      locationText: inferredGps.locationText,
      routeRole: inferredGps.source === 'derived-track' ? 'route-segment' : undefined,
      pharosRef: primaryPharosRef,
    });
  }

  const pharosSpatial = input.asset && input.report?.pharosMatches?.length
    ? await resolvePharosTimedSpatialContext({
      asset: input.asset,
      clipType: input.clipType,
      pharosContext: input.pharosContext ?? null,
      pharosMatches: input.report.pharosMatches,
      sourceInMs: input.slice?.sourceInMs,
      sourceOutMs: input.slice?.sourceOutMs,
    })
    : null;
  if (pharosSpatial) {
    for (const candidate of pharosSpatial.locationCandidates) {
      evidence.push({
        tier: 'strong-inference',
        confidence: Math.max(0.35, Math.min(0.9, pharosSpatial.match.confidence)),
        sourceKinds: ['pharos', 'gpx'],
        lat: candidate.lat,
        lng: candidate.lng,
        routeRole: candidate.role === 'start'
          ? 'route-start'
          : candidate.role === 'end'
            ? 'route-end'
            : undefined,
        timeReference: candidate.time,
        pharosRef: pharosSpatial.match.ref,
      });
    }
  }

  return dedupeSpatialEvidence(evidence);
}

export async function decorateSliceWithSemanticTags(input: {
  slice: IKtepSlice;
  clipType: EClipType;
  report?: Pick<IAssetCoarseReport, 'inferredGps' | 'pharosMatches' | 'summary' | 'transcript' | 'speechCoverage'>;
  asset?: Pick<IKtepAsset, 'capturedAt' | 'durationMs'>;
  pharosContext?: IProjectPharosContext | null;
  recognition?: {
    description?: string;
    sceneType?: string;
    subjects?: string[];
    placeHints?: string[];
    materialPatterns?: string[];
  } | null;
  semanticWindow?: Pick<IInterestingWindow, 'semanticKind' | 'reason'> | null;
  vocabulary?: {
    materialPatternPhrases?: string[];
  };
}): Promise<IKtepSlice> {
  const slice: IKtepSlice = {
    ...input.slice,
    visualObservation: normalizeObservation(input.slice.visualObservation ?? input.recognition?.description),
    materialPatterns: normalizeMaterialPatternsWithVocabulary(
      sanitizeMaterialPatterns([
        ...(input.slice.materialPatterns ?? []),
        ...(input.recognition?.materialPatterns ?? []),
        input.slice.visualObservation,
        input.recognition?.description,
        input.report?.summary,
      ]),
      input.vocabulary?.materialPatternPhrases ?? [],
    ),
    grounding: {
      ...input.slice.grounding,
      speechMode: input.slice.grounding?.speechMode ?? 'none',
      speechValue: input.slice.grounding?.speechValue ?? 'none',
      spatialEvidence: [...(input.slice.grounding?.spatialEvidence ?? [])],
      pharosRefs: [...(input.slice.grounding?.pharosRefs ?? [])],
    },
  };

  const transcript = slice.transcript?.trim() || input.report?.transcript?.trim();
  const semanticKind = input.semanticWindow?.semanticKind;
  if (transcript) {
    slice.grounding = {
      ...slice.grounding,
      speechMode: semanticKind === 'speech' ? 'preferred' : 'available',
      speechValue: (input.report?.speechCoverage ?? 0) >= 0.45 ? 'informative' : 'mixed',
    };
  }

  const spatialEvidence = await buildSpatialEvidenceFromReport({
    clipType: input.clipType,
    report: input.report,
    asset: input.asset,
    slice,
    pharosContext: input.pharosContext ?? null,
  });
  if (spatialEvidence.length > 0) {
    slice.grounding.spatialEvidence = dedupeSpatialEvidence([
      ...slice.grounding.spatialEvidence,
      ...spatialEvidence,
    ]);
  }

  const existingRefs = new Set((slice.pharosRefs ?? []).map(ref => `${ref.tripId}:${ref.shotId}`));
  for (const ref of input.report?.pharosMatches.map(match => match.ref) ?? []) {
    const key = `${ref.tripId}:${ref.shotId}`;
    if (existingRefs.has(key)) continue;
    existingRefs.add(key);
    slice.pharosRefs = [...(slice.pharosRefs ?? []), ref];
    slice.grounding.pharosRefs = [...slice.grounding.pharosRefs, ref];
  }

  return slice;
}

export function sanitizeMaterialPatterns(values: Array<string | undefined>): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const trimmed = value?.trim();
    if (!trimmed || isOwnershipPattern(trimmed)) continue;
    const key = normalizeSemanticText(trimmed);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
    if (result.length >= CMATERIAL_PATTERN_LIMIT) break;
  }
  return result;
}

function normalizeObservation(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function normalizeMaterialPatternsWithVocabulary(
  patterns: string[],
  vocabulary: string[],
): string[] {
  void vocabulary;
  return patterns;
}

function isOwnershipPattern(value: string): boolean {
  return /\btrip-[a-z0-9-]+/iu.test(value)
    || /\bshot[-_\s]?id\b/iu.test(value)
    || /\bday\s*\d+\b/iu.test(value)
    || /\bd\d+-\d+/iu.test(value)
    || /pharos/iu.test(value)
    || /\d{4}-\d{2}-\d{2}t\d{2}:\d{2}/iu.test(value)
    || /@-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?/u.test(value)
    || /-?\d{1,2}\.\d{4,}\s*,\s*-?\d{1,3}\.\d{4,}/u.test(value)
    || /→/u.test(value);
}

function normalizeSemanticText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[，。！？；：、,.!?;:()[\]{}"'`~\-_/\\\s]+/gu, '');
}

function dedupeSpatialEvidence(values: ISpatialEvidence[]): ISpatialEvidence[] {
  const seen = new Set<string>();
  const result: ISpatialEvidence[] = [];
  for (const value of values) {
    const cleaned: ISpatialEvidence = {
      ...value,
      sourceKinds: [...(value.sourceKinds ?? [])],
    };
    const key = [
      cleaned.tier,
      cleaned.lat ?? '',
      cleaned.lng ?? '',
      cleaned.locationText ?? '',
      cleaned.routeRole ?? '',
      cleaned.timeReference ?? '',
      cleaned.pharosRef?.tripId ?? '',
      cleaned.pharosRef?.shotId ?? '',
    ].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(cleaned);
  }
  return result;
}
