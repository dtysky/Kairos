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
 * 通用执行流程：按顺序调用适配器完成 KTEP → NLE 的完整同步。
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
