import type {
  IKtepDoc, IKtepAsset, IKtepTimeline,
  IKtepClip, IKtepSubtitle,
} from '../../protocol/schema.js';

export interface INleCapabilities {
  subtitleTrack: boolean;
  transform: boolean;
  kenBurns: boolean;
  transition: boolean;
  nestedTimeline: boolean;
}

export interface INleAdapter {
  readonly name: string;
  readonly capabilities: INleCapabilities;

  /**
   * 将 KTEP 时间线应用到目标 NLE。
   *
   * 注意：这里描述的是“同步 / 摆放”能力，而不是完整的最终导出能力。
   * 最终导出（例如剪映草稿导出、Resolve 项目提交）由上层 skill / 编排层负责。
   */
  validate(doc: IKtepDoc): Promise<void>;
  ensureProject(projectName: string): Promise<void>;
  importAssets(assets: IKtepAsset[]): Promise<void>;
  createTimeline(timeline: IKtepTimeline): Promise<void>;
  placeClips(clips: IKtepClip[]): Promise<void>;
  addSubtitles(cues: IKtepSubtitle[]): Promise<void>;
}

/**
 * ID 映射：KTEP ID ↔ NLE 内部 ID
 */
export interface INleIdMap {
  assets: Map<string, string>;
  tracks: Map<string, string>;
  clips: Map<string, string>;
  projectId?: string;
  timelineId?: string;
}

export function createIdMap(): INleIdMap {
  return {
    assets: new Map(),
    tracks: new Map(),
    clips: new Map(),
  };
}

/**
 * 通用执行流程：按顺序调用适配器完成 KTEP → NLE 的时间线应用。
 *
 * 它覆盖项目创建、轨道创建、片段摆放和字幕同步；
 * 不负责 NLE 特定的最终导出动作。
 */
export async function executeAdapter(
  adapter: INleAdapter,
  doc: IKtepDoc,
): Promise<void> {
  await adapter.validate(doc);
  await adapter.ensureProject(doc.project.name);
  await adapter.importAssets(doc.assets);
  await adapter.createTimeline(doc.timeline);
  await adapter.placeClips(doc.timeline.clips);
  if (doc.subtitles?.length) {
    await adapter.addSubtitles(doc.subtitles);
  }
}
