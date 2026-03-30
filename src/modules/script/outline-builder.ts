import type { IKtepScriptSelection, IKtepSlice } from '../../protocol/schema.js';

export interface IOutlineSliceContext {
  sliceId: string;
  assetId: string;
  summary?: string;
  labels: string[];
  placeHints: string[];
  sourceInMs?: number;
  sourceOutMs?: number;
}

export interface IOutlineSegmentContext {
  assetId: string;
  sliceContexts: IOutlineSliceContext[];
  summary: string;
  startMs?: number;
  endMs?: number;
}

export interface IOutlineSegment {
  role: 'intro' | 'scene' | 'transition' | 'highlight' | 'outro';
  title: string;
  assetId: string;
  sliceIds: string[];
  selections: IKtepScriptSelection[];
  context: IOutlineSegmentContext;
  estimatedDurationMs: number;
}

/**
 * 从切片列表构建叙事骨架。
 * 当前实现优先按素材分段：
 *   - 同一 asset 下的切片优先归为同一个段落
 *   - 只有存在多个 asset 时，才按位置推导 intro/outro
 *   - 每个段落下再保留若干可选切片，供脚本阶段选择
 */
export function buildOutline(
  slices: IKtepSlice[],
  targetDurationMs: number,
): IOutlineSegment[] {
  if (slices.length === 0) return [];

  const sorted = [...slices].sort((a, b) =>
    (a.sourceInMs ?? 0) - (b.sourceInMs ?? 0)
    || a.assetId.localeCompare(b.assetId)
    || a.id.localeCompare(b.id),
  );

  const groups = groupByAsset(sorted);
  const groupDurations = groups.map(group => estimateGroupDuration(group));
  const totalDuration = groupDurations.reduce((sum, duration) => sum + duration, 0);

  return groups.map((group, index) => {
    const role = pickSegmentRole(groups.length, index, group);
    const context = buildSegmentContext(group);
    const estimatedDurationMs = totalDuration > 0
      ? Math.round(targetDurationMs * (groupDurations[index] / totalDuration))
      : Math.round(targetDurationMs / groups.length);

    return {
      role,
      title: buildSegmentTitle(role, index),
      assetId: group[0].assetId,
      sliceIds: group.map(slice => slice.id),
      selections: group.map(buildSelection),
      context,
      estimatedDurationMs,
    };
  });
}

function buildSegmentContext(slices: IKtepSlice[]): IOutlineSegmentContext {
  const sliceContexts: IOutlineSliceContext[] = slices.map(slice => ({
    sliceId: slice.id,
    assetId: slice.assetId,
    summary: slice.summary,
    labels: takeUnique(slice.labels, 4),
    placeHints: takeUnique(
      slice.evidence
        .filter(evidence => evidence.value.startsWith('place:'))
        .map(evidence => evidence.value.replace(/^place:/, '')),
      3,
    ),
    sourceInMs: slice.sourceInMs,
    sourceOutMs: slice.sourceOutMs,
  }));

  const summaries = slices
    .map(slice => slice.summary?.trim())
    .filter((summary): summary is string => Boolean(summary));
  const startMs = pickMinNumber(slices.map(slice => slice.sourceInMs));
  const endMs = pickMaxNumber(slices.map(slice => slice.sourceOutMs));

  return {
    assetId: slices[0]?.assetId ?? '',
    sliceContexts,
    summary: summaries.length > 1
      ? summaries.slice(0, 3).join(' / ')
      : summaries[0] ?? `包含 ${slices.length} 个候选切片`,
    startMs,
    endMs,
  };
}

function buildSelection(slice: IKtepSlice): IKtepScriptSelection {
  return {
    assetId: slice.assetId,
    sliceId: slice.id,
    sourceInMs: slice.sourceInMs,
    sourceOutMs: slice.sourceOutMs,
  };
}

function groupByAsset(slices: IKtepSlice[]): IKtepSlice[][] {
  const groups = new Map<string, IKtepSlice[]>();
  const order: string[] = [];
  for (const slice of slices) {
    if (!groups.has(slice.assetId)) {
      groups.set(slice.assetId, []);
      order.push(slice.assetId);
    }
    groups.get(slice.assetId)!.push(slice);
  }

  return order.map(assetId => groups.get(assetId)!);
}

function estimateGroupDuration(slices: IKtepSlice[]): number {
  const duration = slices.reduce((sum, slice) => {
    if (typeof slice.sourceInMs === 'number' && typeof slice.sourceOutMs === 'number') {
      return sum + Math.max(0, slice.sourceOutMs - slice.sourceInMs);
    }
    return sum + 5000;
  }, 0);

  return Math.max(duration, 5000);
}

function pickSegmentRole(
  groupCount: number,
  index: number,
  slices: IKtepSlice[],
): IOutlineSegment['role'] {
  if (groupCount === 1) return 'scene';
  if (index === 0) return 'intro';
  if (index === groupCount - 1) return 'outro';
  const avgConfidence = slices.reduce((sum, slice) => sum + (slice.confidence ?? 0.5), 0) / slices.length;
  return avgConfidence >= 0.75 ? 'highlight' : 'scene';
}

function buildSegmentTitle(
  role: IOutlineSegment['role'],
  index: number,
): string {
  if (role === 'intro') return '开篇素材';
  if (role === 'outro') return '结尾素材';
  if (role === 'highlight') return `重点段落 ${index + 1}`;
  return `素材段落 ${index + 1}`;
}

function takeUnique(values: string[], limit: number): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))].slice(0, limit);
}

function pickMinNumber(values: Array<number | undefined>): number | undefined {
  const numbers = values.filter((value): value is number => typeof value === 'number');
  if (numbers.length === 0) return undefined;
  return Math.min(...numbers);
}

function pickMaxNumber(values: Array<number | undefined>): number | undefined {
  const numbers = values.filter((value): value is number => typeof value === 'number');
  if (numbers.length === 0) return undefined;
  return Math.max(...numbers);
}
