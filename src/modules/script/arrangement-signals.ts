import type { IKtepSlice, IStyleProfile } from '../../protocol/schema.js';

export type TResolvedArrangementAxisKind = 'time' | 'space' | 'emotion' | 'payoff' | 'mixed';

export interface IResolvedArrangementSignals {
  primaryAxisKind: TResolvedArrangementAxisKind;
  chronologyStrength: number;
  routeContinuityStrength: number;
  processContinuityStrength: number;
  spaceStrength: number;
  emotionStrength: number;
  payoffStrength: number;
  enforceChronology: boolean;
  materialRoleBias: Partial<Record<IKtepSlice['type'], number>>;
}

const CTIME_KEYWORDS = [
  'chronology', 'chronologic', 'timeline', 'time', 'route', 'route continuity',
  'process continuity', 'progress', 'progression', 'continuous process', 'continuous',
  'sequence', 'journey', 'drive',
  '时间', '顺时序', '时间顺序', '时序', '路程', '路线', '路感', '行进', '推进', '过程',
  '连续', '接续', '上路', '返程', '出发', '抵达', '到场',
];
const CROUTE_KEYWORDS = [
  'route', 'road', 'journey', 'drive', 'arrival', 'departure', 'return', 'roadtrip',
  '路线', '路程', '路上', '山路', '返程', '出发', '到达', '抵达', '会合', '接人', '接朋友',
];
const CPROCESS_KEYWORDS = [
  'process', 'continuous process', 'event progression', 'real-time', 'on the way',
  '过程', '连续过程', '进入状态', '拍摄状态', '准备', '沟通', '会合', '接人', '到场',
  '收束', '回程', '上路', '推进',
];
const CSPACE_KEYWORDS = [
  'space', 'spatial', 'geography', 'location', 'place', 'map',
  '空间', '地理', '地点', '地貌', '场域', '地理重置', '地点观察',
];
const CEMOTION_KEYWORDS = [
  'emotion', 'emotional', 'mood', 'feeling', 'inner',
  '情绪', '情感', '心境', '氛围', '感受',
];
const CPAYOFF_KEYWORDS = [
  'payoff', 'release', 'result', 'outcome', 'memory recall',
  '成果', '释放', '结果', '回看', '回放', '记忆确认',
];

const CMATERIAL_ROLE_KEYWORDS: Array<{
  type: IKtepSlice['type'];
  keywords: string[];
}> = [
  { type: 'drive', keywords: ['drive', 'route', 'road', 'journey', 'windshield', '路程', '路线', '路上', '车内', '挡风玻璃', '驾驶'] },
  { type: 'talking-head', keywords: ['talking-head', 'talking head', 'monologue', 'dialogue', '口播', '说话', '对话', '沟通', '聊天'] },
  { type: 'photo', keywords: ['photo', 'still', '照片', '成果', '回看'] },
  { type: 'broll', keywords: ['broll', 'b-roll', 'observational', '观察', '空镜', '环境'] },
  { type: 'aerial', keywords: ['aerial', 'drone', '航拍', '无人机'] },
  { type: 'timelapse', keywords: ['timelapse', 'time-lapse', '延时'] },
  { type: 'shot', keywords: ['shot', '镜头'] },
];

export function resolveArrangementSignals(style: IStyleProfile): IResolvedArrangementSignals {
  const weightedTexts = collectWeightedStyleTexts(style);
  const totalWeight = Math.max(1, weightedTexts.reduce((sum, item) => sum + item.weight, 0));
  const timeScore = scoreWeightedKeywordHits(weightedTexts, CTIME_KEYWORDS) / totalWeight;
  const routeScore = scoreWeightedKeywordHits(weightedTexts, CROUTE_KEYWORDS) / totalWeight;
  const processScore = scoreWeightedKeywordHits(weightedTexts, CPROCESS_KEYWORDS) / totalWeight;
  const spaceScore = scoreWeightedKeywordHits(weightedTexts, CSPACE_KEYWORDS) / totalWeight;
  const emotionScore = scoreWeightedKeywordHits(weightedTexts, CEMOTION_KEYWORDS) / totalWeight;
  const payoffScore = scoreWeightedKeywordHits(weightedTexts, CPAYOFF_KEYWORDS) / totalWeight;

  const primaryAxisKind = resolvePrimaryAxisKind({
    time: timeScore + routeScore * 0.35 + processScore * 0.25,
    space: spaceScore,
    emotion: emotionScore,
    payoff: payoffScore,
  });
  const chronologyStrength = clamp01(timeScore * 0.65 + routeScore * 0.2 + processScore * 0.15);
  const routeContinuityStrength = clamp01(routeScore);
  const processContinuityStrength = clamp01(processScore);
  const materialRoleBias = resolveMaterialRoleBias(weightedTexts);

  return {
    primaryAxisKind,
    chronologyStrength,
    routeContinuityStrength,
    processContinuityStrength,
    spaceStrength: clamp01(spaceScore),
    emotionStrength: clamp01(emotionScore),
    payoffStrength: clamp01(payoffScore),
    enforceChronology: chronologyStrength >= 0.36
      || routeContinuityStrength >= 0.28
      || processContinuityStrength >= 0.28,
    materialRoleBias,
  };
}

function collectWeightedStyleTexts(style: IStyleProfile): Array<{ text: string; weight: number }> {
  const texts: Array<{ text: string; weight: number }> = [];
  const sections = style.sections ?? [];
  const parameters = style.parameters ?? {};
  const antiPatterns = style.antiPatterns ?? [];
  const push = (text: string | undefined, weight: number): void => {
    const normalized = text?.trim();
    if (!normalized) return;
    texts.push({ text: normalized, weight });
  };

  push(style.arrangementStructure.primaryAxis, 5);
  for (const axis of style.arrangementStructure.secondaryAxes) push(axis, 2.5);
  for (const note of style.arrangementStructure.chapterSplitPrinciples) push(note, 2.5);
  for (const note of style.arrangementStructure.chapterTransitionNotes) push(note, 2.2);
  for (const program of style.arrangementStructure.chapterPrograms) {
    push(program.type, 2);
    push(program.intent, 3);
    for (const role of program.materialRoles) push(role, 2);
    for (const signal of program.promotionSignals) push(signal, 2.2);
    push(program.transitionBias, 1.4);
    push(program.localNarrationNote, 1.2);
  }
  for (const section of sections) {
    push(section.title, 1.2);
    push(section.content, 1);
  }
  for (const [key, value] of Object.entries(parameters)) {
    push(`${key} ${value}`, 1.6);
  }
  for (const pattern of antiPatterns) push(pattern, 0.8);

  return texts;
}

function scoreWeightedKeywordHits(
  weightedTexts: Array<{ text: string; weight: number }>,
  keywords: string[],
): number {
  let score = 0;
  for (const item of weightedTexts) {
    const haystack = item.text.toLowerCase();
    if (keywords.some(keyword => haystack.includes(keyword.toLowerCase()))) {
      score += item.weight;
    }
  }
  return score;
}

function resolvePrimaryAxisKind(scores: Record<'time' | 'space' | 'emotion' | 'payoff', number>): TResolvedArrangementAxisKind {
  const ordered = Object.entries(scores)
    .sort((left, right) => right[1] - left[1]) as Array<[TResolvedArrangementAxisKind, number]>;
  const [bestKind, bestScore] = ordered[0] ?? ['mixed', 0];
  const secondScore = ordered[1]?.[1] ?? 0;
  if (bestScore <= 0.08 || bestScore - secondScore <= 0.04) {
    return 'mixed';
  }
  return bestKind;
}

function resolveMaterialRoleBias(
  weightedTexts: Array<{ text: string; weight: number }>,
): Partial<Record<IKtepSlice['type'], number>> {
  const result: Partial<Record<IKtepSlice['type'], number>> = {};
  const totalWeight = Math.max(1, weightedTexts.reduce((sum, item) => sum + item.weight, 0));

  for (const definition of CMATERIAL_ROLE_KEYWORDS) {
    const score = scoreWeightedKeywordHits(weightedTexts, definition.keywords) / totalWeight;
    if (score > 0.04) {
      result[definition.type] = clamp01(score);
    }
  }

  return result;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}
