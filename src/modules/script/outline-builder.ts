import type { IKtepSlice, IKtepEvidence } from '../../protocol/schema.js';

export interface IOutlineSegment {
  role: 'intro' | 'scene' | 'transition' | 'highlight' | 'outro';
  title: string;
  sliceIds: string[];
  evidence: IKtepEvidence[];
  estimatedDurationMs: number;
}

/**
 * 从切片列表构建叙事骨架。
 * 规则：
 *   - 开头 10% 切片候选 intro
 *   - 结尾 5% 切片候选 outro
 *   - 中间按时间/位置分组为 scene
 *   - 高 score 切片标记为 highlight
 */
export function buildOutline(
  slices: IKtepSlice[],
  targetDurationMs: number,
): IOutlineSegment[] {
  if (slices.length === 0) return [];

  const sorted = [...slices].sort((a, b) =>
    (a.sourceInMs ?? 0) - (b.sourceInMs ?? 0),
  );

  const introCount = Math.max(1, Math.floor(sorted.length * 0.1));
  const outroCount = Math.max(1, Math.floor(sorted.length * 0.05));
  const mainSlices = sorted.slice(introCount, sorted.length - outroCount);

  const segments: IOutlineSegment[] = [];

  // Intro
  segments.push({
    role: 'intro',
    title: '开篇',
    sliceIds: sorted.slice(0, introCount).map(s => s.id),
    evidence: collectEvidence(sorted.slice(0, introCount)),
    estimatedDurationMs: targetDurationMs * 0.1,
  });

  // Main scenes — group by chunks
  const chunkSize = Math.max(1, Math.ceil(mainSlices.length / 5));
  for (let i = 0; i < mainSlices.length; i += chunkSize) {
    const chunk = mainSlices.slice(i, i + chunkSize);
    const idx = Math.floor(i / chunkSize) + 1;

    const hasHighlight = chunk.some(s =>
      s.confidence != null && s.confidence > 0.7,
    );

    segments.push({
      role: hasHighlight ? 'highlight' : 'scene',
      title: `段落 ${idx}`,
      sliceIds: chunk.map(s => s.id),
      evidence: collectEvidence(chunk),
      estimatedDurationMs: targetDurationMs * 0.8 / Math.ceil(mainSlices.length / chunkSize),
    });
  }

  // Outro
  segments.push({
    role: 'outro',
    title: '结尾',
    sliceIds: sorted.slice(-outroCount).map(s => s.id),
    evidence: collectEvidence(sorted.slice(-outroCount)),
    estimatedDurationMs: targetDurationMs * 0.05,
  });

  return segments;
}

function collectEvidence(slices: IKtepSlice[]): IKtepEvidence[] {
  const all: IKtepEvidence[] = [];
  for (const s of slices) all.push(...s.evidence);
  return all;
}
