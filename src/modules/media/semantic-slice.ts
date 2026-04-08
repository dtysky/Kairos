import type {
  EClipType,
  IAssetCoarseReport,
  IInterestingWindow,
  IKtepSlice,
  ILocalEditingIntent,
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
  | 'localEditingIntent'
  | 'narrativeFunctions'
  | 'shotGrammar'
  | 'viewpointRoles'
  | 'subjectStates'
  | 'grounding'
> {
  return {
    materialPatterns: [],
    localEditingIntent: {
      primaryPhrase: '适合先作为一般观察材料使用',
      secondaryPhrases: [],
      forbiddenPhrases: [],
      sourceAudioPolicy: 'optional',
      speedPolicy: 'forbid',
      confidence: 0.4,
      reasons: [],
    },
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
      locationText: [match.tripTitle, match.dayTitle].filter(Boolean).join(' / ') || undefined,
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
    localEditingIntentPhrases?: string[];
  };
}): IKtepSlice {
  const slice = {
    ...input.slice,
    materialPatterns: [...(input.slice.materialPatterns ?? [])],
    localEditingIntent: cloneLocalEditingIntent(input.slice.localEditingIntent),
    narrativeFunctions: cloneTagSet(input.slice.narrativeFunctions),
    shotGrammar: cloneTagSet(input.slice.shotGrammar),
    viewpointRoles: cloneTagSet(input.slice.viewpointRoles),
    subjectStates: cloneTagSet(input.slice.subjectStates),
    grounding: {
      ...input.slice.grounding,
      spatialEvidence: [...(input.slice.grounding.spatialEvidence ?? [])],
      pharosRefs: [...(input.slice.grounding.pharosRefs ?? [])],
    },
  };

  const tier = input.report?.inferredGps?.source === 'embedded' ? 'truth' : 'strong-inference';
  const baseConfidence = input.report?.speechCoverage ?? 0.65;
  const transcript = slice.transcript?.trim() || input.report?.transcript?.trim();

  const materialPatterns = normalizeMaterialPatternsWithVocabulary(
    mapMaterialPatterns({
      clipType: input.clipType,
      semanticKind: input.semanticWindow?.semanticKind,
      transcript,
      recognition: input.recognition,
      report: input.report,
    }),
    input.vocabulary?.materialPatternPhrases ?? [],
  );
  slice.materialPatterns = mergeMaterialPatterns(slice.materialPatterns, materialPatterns);
  slice.localEditingIntent = normalizeLocalEditingIntentWithVocabulary(
    buildLocalEditingIntent({
      clipType: input.clipType,
      semanticKind: input.semanticWindow?.semanticKind,
      transcript,
      report: input.report,
      materialPatterns: slice.materialPatterns,
    }),
    input.vocabulary?.localEditingIntentPhrases ?? [],
  );

  pushTag(slice.narrativeFunctions, mapNarrativeFunction(input.clipType, input.semanticWindow?.semanticKind), tier, baseConfidence, [input.clipType], [input.semanticWindow?.reason ?? input.recognition?.description]);
  for (const value of mapNarrativeExtras(input.recognition?.description, input.recognition?.sceneType)) {
    pushExtra(slice.narrativeFunctions, value, tier, baseConfidence, ['vision'], [value]);
  }

  for (const grammar of mapShotGrammar(input.clipType, input.recognition?.description)) {
    pushTag(slice.shotGrammar, grammar, tier, 0.7, [input.clipType], [input.recognition?.description]);
  }

  for (const role of mapViewpointRoles(input.clipType, slice.transcript, input.semanticWindow?.semanticKind)) {
    pushTag(slice.viewpointRoles, role, tier, 0.65, [input.clipType], [input.semanticWindow?.reason]);
  }

  for (const state of mapSubjectStates(input.clipType, input.semanticWindow?.semanticKind)) {
    pushTag(slice.subjectStates, state, tier, 0.65, [input.clipType], [input.semanticWindow?.reason]);
  }

  if (transcript) {
    const speechMode = input.semanticWindow?.semanticKind === 'speech' || input.clipType === 'talking-head'
      ? 'preferred'
      : 'available';
    const speechValue = input.clipType === 'talking-head'
      ? 'informative'
      : input.semanticWindow?.semanticKind === 'speech'
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
  const values: Array<[string, number, string | undefined]> = [];
  const description = input.recognition?.description ?? '';
  const sceneType = input.recognition?.sceneType ?? '';
  const combined = `${description} ${sceneType}`.toLowerCase();
  const hasTranscript = Boolean(input.transcript?.trim());

  if (input.clipType === 'aerial') {
    values.push(['高辨识度地点快速建场', 0.82, description || sceneType]);
  }
  if (input.clipType === 'drive') {
    values.push(['车内向前行进视角', 0.84, description]);
    values.push(['道路、桥梁、河流或海岸在证明路线', 0.72, description]);
  }
  if (input.clipType === 'timelapse') {
    values.push(['画面在呈现明显的时间流逝', 0.88, description || sceneType]);
  }
  if (input.clipType === 'talking-head') {
    values.push(['人物正在对镜记录当下感受', 0.78, input.transcript]);
    values.push(['人物正在解释接下来要做什么', 0.72, input.transcript]);
  }
  if (input.semanticKind === 'speech' && input.clipType === 'drive') {
    values.push(['车内行进中自拍', 0.76, input.transcript]);
  }
  if (input.semanticKind === 'speech' && input.clipType !== 'talking-head' && input.clipType !== 'drive') {
    values.push(['人物正在一边移动一边说话', 0.68, input.transcript]);
  }
  if (hasTranscript) {
    values.push(['现场人声可以直接使用', 0.74, input.transcript]);
  }
  if (/follow|跟拍|跟着|tracking/u.test(combined)) {
    values.push(['镜头在跟着主体持续移动', 0.7, description]);
  }
  if (/car|interior|车内|驾驶/u.test(combined) && hasTranscript) {
    values.push(['交通工具内静态自拍', 0.62, description]);
  }
  if (/market|crowd|traffic|chaos|拥堵|混乱|风险|阻碍/u.test(combined)) {
    values.push(['现场正在发生现实摩擦或阻碍', 0.7, description || sceneType]);
  }
  if (/detail|细节|close|close-up/u.test(combined)) {
    values.push(['地点局部细节作为记忆点', 0.66, description]);
  }
  if (/first person|first-person|主观|第一人称/u.test(combined)) {
    values.push(['第一人称日常记录', 0.7, description]);
  }
  if (/place|location|landmark|temple|pyramid|site|地点/u.test(combined) && hasTranscript) {
    values.push(['人物正在介绍地点', 0.68, input.transcript]);
  }
  if ((input.report?.speechCoverage ?? 0) > 0.4 && input.semanticKind !== 'speech') {
    values.push(['现场环境声本身有表达价值', 0.55, description]);
  }

  return dedupeMaterialPatterns(values.map(([phrase, confidence, excerpt]) => ({
    phrase,
    confidence: clampConfidence(confidence),
    excerpt,
    evidenceRefs: [],
  })));
}

function buildLocalEditingIntent(input: {
  clipType: EClipType;
  semanticKind?: IInterestingWindow['semanticKind'];
  transcript?: string;
  report?: Pick<IAssetCoarseReport, 'speechCoverage'>;
  materialPatterns: IMaterialPattern[];
}): ILocalEditingIntent {
  const phrases = input.materialPatterns.map(item => item.phrase);
  let primaryPhrase = '适合先作为一般观察材料使用';
  let sourceAudioPolicy: ILocalEditingIntent['sourceAudioPolicy'] = 'optional';
  let speedPolicy: ILocalEditingIntent['speedPolicy'] = 'forbid';
  const secondaryPhrases: string[] = [];
  const forbiddenPhrases: string[] = [];

  if (phrases.includes('高辨识度地点快速建场')) {
    primaryPhrase = '适合先把观众带进一个地方';
    secondaryPhrases.push('适合立起一个地方的第一印象');
  } else if (phrases.includes('人物正在介绍地点') || phrases.includes('人物正在解释接下来要做什么')) {
    primaryPhrase = '适合承接解释性信息';
    secondaryPhrases.push('适合让人物出场并交代当前处境');
    sourceAudioPolicy = 'prefer-use';
  } else if (phrases.includes('车内向前行进视角') || phrases.includes('道路、桥梁、河流或海岸在证明路线')) {
    primaryPhrase = '适合证明行动、路途或过程正在发生';
    secondaryPhrases.push('适合完成空间切换或地理重置');
    speedPolicy = input.semanticKind === 'speech' ? 'forbid' : 'allow-mild';
  } else if (phrases.includes('现场正在发生现实摩擦或阻碍')) {
    primaryPhrase = '适合把现实摩擦、压力或风险压上来';
    sourceAudioPolicy = 'prefer-use';
    forbiddenPhrases.push('适合抬高尺度、气势或情绪');
  } else if (phrases.includes('画面在呈现明显的时间流逝')) {
    primaryPhrase = '适合表达时间流逝或状态变化';
    secondaryPhrases.push('适合抬高尺度、气势或情绪');
    sourceAudioPolicy = 'prefer-mute';
    speedPolicy = 'allow-strong';
  } else if (phrases.includes('现场环境声本身有表达价值')) {
    primaryPhrase = '适合做收束、抵达或递送到下一段';
    sourceAudioPolicy = 'prefer-use';
  }

  if ((input.report?.speechCoverage ?? 0) > 0.55 || Boolean(input.transcript?.trim())) {
    sourceAudioPolicy = sourceAudioPolicy === 'prefer-mute' ? 'optional' : sourceAudioPolicy;
  }

  return {
    primaryPhrase,
    secondaryPhrases: dedupeStrings(secondaryPhrases).slice(0, 3),
    forbiddenPhrases: dedupeStrings(forbiddenPhrases).slice(0, 4),
    sourceAudioPolicy,
    speedPolicy,
    confidence: clampConfidence(resolveIntentConfidence(input.materialPatterns)),
    reasons: input.materialPatterns.map(item => item.phrase).slice(0, 6),
  };
}

function mapNarrativeFunction(
  clipType: EClipType,
  semanticKind: IInterestingWindow['semanticKind'] | undefined,
): string {
  if (semanticKind === 'speech') return 'info-delivery';
  switch (clipType) {
    case 'aerial':
      return 'establish';
    case 'drive':
      return 'route-advance';
    case 'timelapse':
      return 'time-passage';
    case 'talking-head':
      return 'info-delivery';
    default:
      return 'transition';
  }
}

function mapNarrativeExtras(description?: string, sceneType?: string): string[] {
  const tokens = [description ?? '', sceneType ?? ''].join(' ').toLowerCase();
  return [
    /arrival|抵达|到达/u.test(tokens) ? 'arrival' : undefined,
    /depart|出发/u.test(tokens) ? 'departure' : undefined,
    /emotion|情绪|氛围/u.test(tokens) ? 'emotion-release' : undefined,
  ].filter(Boolean) as string[];
}

function mapShotGrammar(clipType: EClipType, description?: string): string[] {
  const values: string[] = [];
  const text = (description ?? '').toLowerCase();
  if (clipType === 'drive') values.push('windshield-drive');
  if (clipType === 'aerial') values.push(/follow|跟/u.test(text) ? 'follow-vehicle' : 'pull-back');
  if (clipType === 'timelapse') values.push('locked-timelapse');
  if (clipType === 'talking-head') values.push('third-person-to-camera');
  if (clipType === 'broll' || clipType === 'unknown') values.push('handheld-observe');
  return dedupeStrings(values);
}

function mapViewpointRoles(
  clipType: EClipType,
  transcript?: string,
  semanticKind?: IInterestingWindow['semanticKind'],
): string[] {
  const values: string[] = [];
  if (clipType === 'drive') values.push(transcript ? 'driving-selfie' : 'car-interior-drive');
  if (clipType === 'talking-head') values.push('non-self-to-camera');
  if (semanticKind === 'speech' && clipType === 'unknown') values.push('walk-and-talk');
  return dedupeStrings(values);
}

function mapSubjectStates(
  clipType: EClipType,
  semanticKind?: IInterestingWindow['semanticKind'],
): string[] {
  const values: string[] = [];
  if (clipType === 'drive') values.push('en-route');
  if (clipType === 'timelapse' || clipType === 'aerial') values.push('admiring');
  if (clipType === 'talking-head' || semanticKind === 'speech') values.push('explaining');
  return dedupeStrings(values);
}

function pushTag(
  target: ISemanticTagSet,
  value: string | undefined,
  tier: 'truth' | 'strong-inference' | 'weak-inference',
  confidence: number,
  sourceKinds: string[],
  reasons: Array<string | undefined>,
): void {
  if (!value) return;
  if (!target.core.includes(value)) {
    target.core.push(value);
  }
  target.evidence.push({
    tier,
    confidence: clampConfidence(confidence),
    sourceKinds: dedupeStrings(sourceKinds),
    reasons: dedupeStrings(reasons),
  });
}

function pushExtra(
  target: ISemanticTagSet,
  value: string | undefined,
  tier: 'truth' | 'strong-inference' | 'weak-inference',
  confidence: number,
  sourceKinds: string[],
  reasons: Array<string | undefined>,
): void {
  if (!value) return;
  if (!target.extra.includes(value)) {
    target.extra.push(value);
  }
  target.evidence.push({
    tier,
    confidence: clampConfidence(confidence),
    sourceKinds: dedupeStrings(sourceKinds),
    reasons: dedupeStrings(reasons),
  });
}

function cloneTagSet(input?: ISemanticTagSet): ISemanticTagSet {
  return {
    core: [...(input?.core ?? [])],
    extra: [...(input?.extra ?? [])],
    evidence: [...(input?.evidence ?? [])],
  };
}

function cloneLocalEditingIntent(input?: ILocalEditingIntent): ILocalEditingIntent {
  return {
    primaryPhrase: input?.primaryPhrase ?? '适合先作为一般观察材料使用',
    secondaryPhrases: [...(input?.secondaryPhrases ?? [])],
    forbiddenPhrases: [...(input?.forbiddenPhrases ?? [])],
    sourceAudioPolicy: input?.sourceAudioPolicy ?? 'optional',
    speedPolicy: input?.speedPolicy ?? 'forbid',
    confidence: clampConfidence(input?.confidence ?? 0.4),
    reasons: [...(input?.reasons ?? [])],
  };
}

function mergeMaterialPatterns(existing: IMaterialPattern[], incoming: IMaterialPattern[]): IMaterialPattern[] {
  return dedupeMaterialPatterns([...existing, ...incoming]);
}

function dedupeMaterialPatterns(patterns: IMaterialPattern[]): IMaterialPattern[] {
  const seen = new Set<string>();
  const result: IMaterialPattern[] = [];
  for (const pattern of patterns) {
    const key = pattern.phrase.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push({
      phrase: key,
      confidence: clampConfidence(pattern.confidence),
      excerpt: pattern.excerpt?.trim() || undefined,
      evidenceRefs: dedupeStrings(pattern.evidenceRefs ?? []),
    });
  }
  return result;
}

function normalizeMaterialPatternsWithVocabulary(
  patterns: IMaterialPattern[],
  allowedPhrases: string[],
): IMaterialPattern[] {
  if (allowedPhrases.length === 0) return patterns;
  return dedupeMaterialPatterns(patterns.map(pattern => {
    const matched = findBestVocabularyPhrase(pattern.phrase, allowedPhrases, 0.34);
    return matched ? { ...pattern, phrase: matched } : pattern;
  }));
}

function normalizeLocalEditingIntentWithVocabulary(
  intent: ILocalEditingIntent,
  allowedPhrases: string[],
): ILocalEditingIntent {
  if (allowedPhrases.length === 0) return intent;
  const normalizePhrase = (phrase: string): string => (
    findBestVocabularyPhrase(phrase, allowedPhrases, 0.32) ?? phrase
  );
  return {
    ...intent,
    primaryPhrase: normalizePhrase(intent.primaryPhrase),
    secondaryPhrases: dedupeStrings(intent.secondaryPhrases.map(normalizePhrase)),
    forbiddenPhrases: dedupeStrings(intent.forbiddenPhrases.map(normalizePhrase)),
  };
}

function resolveIntentConfidence(materialPatterns: IMaterialPattern[]): number {
  if (materialPatterns.length === 0) return 0.35;
  const total = materialPatterns.reduce((sum, item) => sum + item.confidence, 0);
  return total / materialPatterns.length;
}

function findBestVocabularyPhrase(
  phrase: string,
  allowedPhrases: string[],
  threshold: number,
): string | null {
  const scored = allowedPhrases
    .map(candidate => ({
      candidate,
      score: computePhraseSimilarity(phrase, candidate),
    }))
    .sort((left, right) => right.score - left.score);
  const best = scored[0];
  return best && best.score >= threshold ? best.candidate : null;
}

function computePhraseSimilarity(left: string | undefined, right: string | undefined): number {
  const a = normalizePhrase(left);
  const b = normalizePhrase(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.92;
  const leftBigrams = toBigrams(a);
  const rightBigrams = toBigrams(b);
  if (leftBigrams.size === 0 || rightBigrams.size === 0) return 0;
  let intersection = 0;
  for (const gram of leftBigrams) {
    if (rightBigrams.has(gram)) intersection += 1;
  }
  const union = new Set([...leftBigrams, ...rightBigrams]).size;
  return union > 0 ? intersection / union : 0;
}

function normalizePhrase(value: string | undefined): string {
  return (value ?? '')
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
