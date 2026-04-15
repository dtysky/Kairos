import type {
  EClipType,
  IAssetCoarseReport,
  IInterestingWindow,
  IKtepSlice,
  IMaterialPattern,
  ISpatialEvidence,
  ISemanticTagSet,
} from '../../protocol/schema.js';

export function createEmptySemanticTagSet(): ISemanticTagSet {
  return {
    core: [],
    extra: [],
    evidence: [],
  };
}

export function createEmptySliceSemantics(): Pick<
  IKtepSlice,
  | 'materialPatterns'
  | 'narrativeFunctions'
  | 'shotGrammar'
  | 'viewpointRoles'
  | 'subjectStates'
  | 'grounding'
> {
  return {
    materialPatterns: [],
    narrativeFunctions: createEmptySemanticTagSet(),
    shotGrammar: createEmptySemanticTagSet(),
    viewpointRoles: createEmptySemanticTagSet(),
    subjectStates: createEmptySemanticTagSet(),
    grounding: {
      speechMode: 'none',
      speechValue: 'none',
      spatialEvidence: [],
      pharosRefs: [],
    },
  };
}

export function buildSpatialEvidenceFromReport(
  report?: Pick<IAssetCoarseReport, 'inferredGps' | 'pharosMatches'>,
): ISpatialEvidence[] {
  const evidence: ISpatialEvidence[] = [];
  const inferredGps = report?.inferredGps;
  if (inferredGps) {
    const tier = inferredGps.source === 'embedded'
      ? 'truth'
      : inferredGps.source === 'derived-track'
        ? 'weak-inference'
        : 'strong-inference';
    evidence.push({
      tier,
      confidence: inferredGps.confidence,
      sourceKinds: [inferredGps.source],
      reasons: [inferredGps.summary ?? inferredGps.locationText ?? inferredGps.source],
      lat: inferredGps.lat,
      lng: inferredGps.lng,
      locationText: inferredGps.locationText,
      routeRole: inferredGps.source === 'derived-track' ? 'route-segment' : undefined,
    });
  }

  for (const match of report?.pharosMatches ?? []) {
    evidence.push({
      tier: 'strong-inference',
      confidence: match.confidence,
      sourceKinds: ['pharos-record'],
      reasons: match.matchReasons ?? [],
      pharosRef: match.ref,
    });
  }

  return dedupeSpatialEvidence(evidence);
}

export function decorateSliceWithSemanticTags(input: {
  slice: IKtepSlice;
  clipType: EClipType;
  report?: Pick<IAssetCoarseReport, 'inferredGps' | 'pharosMatches' | 'transcript' | 'speechCoverage'>;
  recognition?: {
    description?: string;
    sceneType?: string;
    subjects?: string[];
    placeHints?: string[];
  } | null;
  semanticWindow?: Pick<IInterestingWindow, 'semanticKind' | 'reason'> | null;
  vocabulary?: {
    materialPatternPhrases?: string[];
  };
}): IKtepSlice {
  const slice: IKtepSlice = {
    ...input.slice,
    materialPatterns: [...(input.slice.materialPatterns ?? [])],
    narrativeFunctions: cloneTagSet(input.slice.narrativeFunctions),
    shotGrammar: cloneTagSet(input.slice.shotGrammar),
    viewpointRoles: cloneTagSet(input.slice.viewpointRoles),
    subjectStates: cloneTagSet(input.slice.subjectStates),
    grounding: {
      ...input.slice.grounding,
      speechMode: input.slice.grounding?.speechMode ?? 'none',
      speechValue: input.slice.grounding?.speechValue ?? 'none',
      spatialEvidence: [...(input.slice.grounding?.spatialEvidence ?? [])],
      pharosRefs: [...(input.slice.grounding?.pharosRefs ?? [])],
    },
  };

  const tier = input.report?.inferredGps?.source === 'embedded' ? 'truth' : 'strong-inference';
  const baseConfidence = input.report?.speechCoverage ?? 0.65;
  const transcript = slice.transcript?.trim() || input.report?.transcript?.trim();
  const semanticKind = input.semanticWindow?.semanticKind;

  const materialPatterns = normalizeMaterialPatternsWithVocabulary(
    mapMaterialPatterns({
      clipType: input.clipType,
      semanticKind,
      transcript,
      recognition: input.recognition,
      report: input.report,
    }),
    input.vocabulary?.materialPatternPhrases ?? [],
  );
  slice.materialPatterns = mergeMaterialPatterns(slice.materialPatterns, materialPatterns);

  pushTag(
    slice.narrativeFunctions,
    mapNarrativeFunction(input.clipType, semanticKind),
    tier,
    baseConfidence,
    [input.clipType],
    [input.semanticWindow?.reason ?? input.recognition?.description],
  );
  for (const value of mapNarrativeExtras(input.recognition?.description, input.recognition?.sceneType)) {
    pushExtra(slice.narrativeFunctions, value, tier, baseConfidence, ['vision'], [value]);
  }

  for (const grammar of mapShotGrammar(input.clipType, input.recognition?.description)) {
    pushTag(slice.shotGrammar, grammar, tier, 0.7, [input.clipType], [input.recognition?.description]);
  }

  for (const role of mapViewpointRoles(input.clipType, transcript, semanticKind)) {
    pushTag(slice.viewpointRoles, role, tier, 0.65, [input.clipType], [input.semanticWindow?.reason]);
  }

  for (const state of mapSubjectStates(input.clipType, semanticKind)) {
    pushTag(slice.subjectStates, state, tier, 0.65, [input.clipType], [input.semanticWindow?.reason]);
  }

  if (transcript) {
    const speechMode = semanticKind === 'speech' || input.clipType === 'talking-head'
      ? 'preferred'
      : 'available';
    const speechValue = input.clipType === 'talking-head'
      ? 'informative'
      : semanticKind === 'speech'
        ? 'mixed'
        : 'informative';
    slice.grounding = {
      ...slice.grounding,
      speechMode,
      speechValue,
    };
  }

  const spatialEvidence = buildSpatialEvidenceFromReport(input.report);
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

function mapMaterialPatterns(input: {
  clipType: EClipType;
  semanticKind?: IInterestingWindow['semanticKind'];
  transcript?: string;
  recognition?: {
    description?: string;
    sceneType?: string;
    subjects?: string[];
    placeHints?: string[];
  } | null;
  report?: Pick<IAssetCoarseReport, 'speechCoverage' | 'inferredGps'>;
}): IMaterialPattern[] {
  const values: Array<[string, number]> = [];
  const description = input.recognition?.description ?? '';
  const sceneType = input.recognition?.sceneType ?? '';
  const combined = `${description} ${sceneType}`.toLowerCase();
  const hasTranscript = Boolean(input.transcript?.trim());

  if (input.clipType === 'aerial') {
    values.push(['高辨识度地点快速建场', 0.82]);
  }
  if (input.clipType === 'drive') {
    values.push(['车内向前行进视角', 0.84]);
    values.push(['道路、桥梁、河流或海岸在证明路线', 0.72]);
  }
  if (input.clipType === 'timelapse') {
    values.push(['画面在呈现明显的时间流逝', 0.88]);
  }
  if (input.clipType === 'talking-head') {
    values.push(['人物正在对镜记录当下感受', 0.78]);
    values.push(['人物正在解释接下来要做什么', 0.72]);
  }
  if (input.semanticKind === 'speech' && input.clipType === 'drive') {
    values.push(['车内行进中自拍', 0.76]);
  }
  if (input.semanticKind === 'speech' && input.clipType !== 'talking-head' && input.clipType !== 'drive') {
    values.push(['人物正在一边移动一边说话', 0.68]);
  }
  if (hasTranscript) {
    values.push(['现场人声可以直接使用', 0.74]);
  }
  if (/follow|跟拍|跟着|tracking/u.test(combined)) {
    values.push(['镜头在跟着主体持续移动', 0.7]);
  }
  if (/car|interior|车内|驾驶/u.test(combined) && hasTranscript) {
    values.push(['交通工具内静态自拍', 0.62]);
  }
  if (/market|crowd|traffic|chaos|拥堵|混乱|风险|阻碍/u.test(combined)) {
    values.push(['现场正在发生现实摩擦或阻碍', 0.7]);
  }
  if (/detail|细节|close|close-up/u.test(combined)) {
    values.push(['地点局部细节作为记忆点', 0.66]);
  }
  if (/first person|first-person|主观|第一人称/u.test(combined)) {
    values.push(['第一人称日常记录', 0.7]);
  }
  if (/place|location|landmark|temple|pyramid|site|地点/u.test(combined) && hasTranscript) {
    values.push(['人物正在介绍地点', 0.68]);
  }
  if ((input.report?.speechCoverage ?? 0) > 0.4 && input.semanticKind !== 'speech') {
    values.push(['声音信息能补强画面事实', 0.58]);
  }
  if (input.report?.inferredGps?.locationText) {
    values.push(['地点线索可以和时空证据交叉印证', 0.56]);
  }

  return dedupeMaterialPatterns(values.map(([phrase, confidence]) => ({
    phrase,
    confidence: clampConfidence(confidence),
    evidenceRefs: [],
  })));
}

function normalizeMaterialPatternsWithVocabulary(
  patterns: IMaterialPattern[],
  vocabulary: string[],
): IMaterialPattern[] {
  if (patterns.length === 0 || vocabulary.length === 0) return patterns;

  const normalizedVocabulary = vocabulary
    .map(item => item.trim())
    .filter(Boolean)
    .map(item => ({
      value: item,
      signature: normalizeSemanticText(item),
      bigrams: toBigrams(normalizeSemanticText(item)),
    }));

  return patterns.map(pattern => {
    const normalizedPhrase = normalizeSemanticText(pattern.phrase);
    const phraseBigrams = toBigrams(normalizedPhrase);
    let best = pattern.phrase;
    let bestScore = 0;

    for (const candidate of normalizedVocabulary) {
      const overlap = overlapBigramScore(phraseBigrams, candidate.bigrams);
      if (overlap > bestScore) {
        bestScore = overlap;
        best = candidate.value;
      }
    }

    return bestScore >= 0.45
      ? {
        ...pattern,
        phrase: best,
      }
      : pattern;
  });
}

function mergeMaterialPatterns(existing: IMaterialPattern[], incoming: IMaterialPattern[]): IMaterialPattern[] {
  return dedupeMaterialPatterns([...existing, ...incoming]);
}

function dedupeMaterialPatterns(values: IMaterialPattern[]): IMaterialPattern[] {
  const byPhrase = new Map<string, IMaterialPattern>();
  for (const value of values) {
    const key = normalizeSemanticText(value.phrase);
    const current = byPhrase.get(key);
    if (!current || value.confidence > current.confidence) {
      byPhrase.set(key, value);
    }
  }
  return [...byPhrase.values()].sort((left, right) => right.confidence - left.confidence);
}

function cloneTagSet(tagSet?: ISemanticTagSet): ISemanticTagSet {
  return {
    core: [...(tagSet?.core ?? [])],
    extra: [...(tagSet?.extra ?? [])],
    evidence: [...(tagSet?.evidence ?? [])],
  };
}

function pushTag(
  tagSet: ISemanticTagSet,
  value: string | undefined,
  tier: ISpatialEvidence['tier'],
  confidence: number,
  sourceKinds: string[],
  reasons: Array<string | undefined>,
): void {
  if (!value?.trim()) return;
  if (!tagSet.core.includes(value)) {
    tagSet.core.push(value);
  }
  tagSet.evidence.push({
    tier,
    confidence: clampConfidence(confidence),
    sourceKinds: dedupeStrings(sourceKinds),
    reasons: dedupeStrings(reasons),
  });
}

function pushExtra(
  tagSet: ISemanticTagSet,
  value: string | undefined,
  tier: ISpatialEvidence['tier'],
  confidence: number,
  sourceKinds: string[],
  reasons: Array<string | undefined>,
): void {
  if (!value?.trim()) return;
  if (!tagSet.extra.includes(value)) {
    tagSet.extra.push(value);
  }
  tagSet.evidence.push({
    tier,
    confidence: clampConfidence(confidence),
    sourceKinds: dedupeStrings(sourceKinds),
    reasons: dedupeStrings(reasons),
  });
}

function mapNarrativeFunction(
  clipType: EClipType,
  semanticKind?: IInterestingWindow['semanticKind'],
): string {
  if (clipType === 'aerial') return '建场';
  if (clipType === 'timelapse') return '时间推进';
  if (clipType === 'talking-head') return '主观表达';
  if (clipType === 'drive') return semanticKind === 'speech' ? '路上自述' : '路线推进';
  if (clipType === 'broll') return '观察补充';
  return '一般观察';
}

function mapNarrativeExtras(description?: string, sceneType?: string): string[] {
  const combined = `${description ?? ''} ${sceneType ?? ''}`.toLowerCase();
  return dedupeStrings([
    /arrive|arrival|抵达/u.test(combined) ? '抵达感' : undefined,
    /leave|depart|离开/u.test(combined) ? '离场感' : undefined,
    /crowd|busy|拥挤/u.test(combined) ? '现实摩擦' : undefined,
    /detail|细节/u.test(combined) ? '记忆点' : undefined,
  ]);
}

function mapShotGrammar(clipType: EClipType, description?: string): string[] {
  const combined = `${clipType} ${description ?? ''}`.toLowerCase();
  return dedupeStrings([
    clipType === 'aerial' ? '俯瞰建场' : undefined,
    clipType === 'timelapse' ? '时间压缩' : undefined,
    clipType === 'drive' ? '持续前进' : undefined,
    /close|细节/u.test(combined) ? '细节切入' : undefined,
    /wide|空镜|landscape/u.test(combined) ? '空间观察' : undefined,
  ]);
}

function mapViewpointRoles(
  clipType: EClipType,
  transcript?: string,
  semanticKind?: IInterestingWindow['semanticKind'],
): string[] {
  return dedupeStrings([
    clipType === 'talking-head' ? '自述者' : undefined,
    clipType === 'drive' ? '行进中的观察者' : undefined,
    semanticKind === 'speech' && transcript ? '带口播的现场见证者' : undefined,
  ]);
}

function mapSubjectStates(
  clipType: EClipType,
  semanticKind?: IInterestingWindow['semanticKind'],
): string[] {
  return dedupeStrings([
    clipType === 'drive' ? '移动中' : undefined,
    clipType === 'timelapse' ? '时间变化中' : undefined,
    semanticKind === 'speech' ? '正在表达' : undefined,
  ]);
}

function overlapBigramScore(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let overlap = 0;
  for (const item of left) {
    if (right.has(item)) overlap += 1;
  }
  return overlap / Math.max(left.size, right.size);
}

function normalizeSemanticText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[，。！？；：、,.!?;:()[\]{}"'`~\-_/\\\s]+/gu, '');
}

function toBigrams(value: string): Set<string> {
  if (!value) return new Set();
  if (value.length === 1) return new Set([value]);
  const result = new Set<string>();
  for (let i = 0; i < value.length - 1; i += 1) {
    result.add(value.slice(i, i + 2));
  }
  return result;
}

function dedupeSpatialEvidence(values: ISpatialEvidence[]): ISpatialEvidence[] {
  const seen = new Set<string>();
  const result: ISpatialEvidence[] = [];
  for (const value of values) {
    const key = [
      value.tier,
      value.lat ?? '',
      value.lng ?? '',
      value.locationText ?? '',
      value.pharosRef?.tripId ?? '',
      value.pharosRef?.shotId ?? '',
    ].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function dedupeStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.map(value => value?.trim()).filter(Boolean) as string[])];
}

function clampConfidence(value: number): number {
  return Math.max(0, Math.min(1, value));
}
