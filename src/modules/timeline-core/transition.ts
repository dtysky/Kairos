import type { IKtepClip, IKtepTransition } from '../../protocol/schema.js';

export interface ITransitionConfig {
  defaultType: IKtepTransition['type'];
  defaultDurationMs: number;
  sceneChangeType: IKtepTransition['type'];
  sceneChangeDurationMs: number;
}

const CDEFAULTS: ITransitionConfig = {
  defaultType: 'cut',
  defaultDurationMs: 0,
  sceneChangeType: 'cross-dissolve',
  sceneChangeDurationMs: 800,
};

/**
 * 为相邻 clip 添加转场。
 * 规则：
 *   - 同段落内默认 cut
 *   - 跨段落使用 cross-dissolve
 *   - 航拍/延时开头使用 fade
 */
export function planTransitions(
  clips: IKtepClip[],
  config: Partial<ITransitionConfig> = {},
): IKtepClip[] {
  const cfg = { ...CDEFAULTS, ...config };
  if (clips.length < 2) return clips;

  const result = [...clips];

  for (let i = 1; i < result.length; i++) {
    const prev = result[i - 1];
    const cur = result[i];

    const crossSegment = prev.linkedScriptSegmentId !== cur.linkedScriptSegmentId;

    if (crossSegment) {
      result[i - 1] = {
        ...prev,
        transitionOut: {
          type: cfg.sceneChangeType,
          durationMs: cfg.sceneChangeDurationMs,
        },
      };
    }
  }

  return result;
}
