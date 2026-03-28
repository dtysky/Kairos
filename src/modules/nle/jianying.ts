import type {
  IKtepDoc, IKtepAsset, IKtepTimeline,
  IKtepClip, IKtepSubtitle, IKtepTrack,
} from '../../protocol/schema.js';
import { validateKtepDoc } from '../../protocol/validator.js';
import type { INleAdapter, INleCapabilities, INleIdMap } from './adapter.js';
import { createIdMap } from './adapter.js';
import type { IMcpCaller } from './mcp-caller.js';

export interface IJianyingConfig {
  outputPath?: string;
  subtitleY?: number;
  subtitleSize?: number;
}

const CDEFAULTS: IJianyingConfig = {
  subtitleY: -0.8,
  subtitleSize: 6.0,
};

function msToTimeStr(ms: number): string {
  return `${(ms / 1000).toFixed(3)}s`;
}

function msToRange(inMs: number, outMs: number): string {
  return `${msToTimeStr(inMs)}-${msToTimeStr(outMs)}`;
}

/**
 * 剪映 MCP 适配器。
 * 通过 IMcpCaller 调用 jianying-mcp 的 MCP 工具。
 *
 * 工具链：
 *   create_draft → create_track → add_*_segment → add_*_effects → export_draft
 *
 * @see https://github.com/hey-jian-wei/jianying-mcp
 */
export class JianyingAdapter implements INleAdapter {
  readonly name = 'jianying';
  readonly capabilities: INleCapabilities = {
    subtitleTrack: true,
    transform: true,
    kenBurns: false,
    transition: true,
    nestedTimeline: false,
  };

  private config: IJianyingConfig;
  private mcp: IMcpCaller;
  private idMap: INleIdMap;
  private draftId: string | null = null;
  private assetPaths = new Map<string, string>();
  private trackKindMap = new Map<string, string>();

  constructor(mcp: IMcpCaller, config: Partial<IJianyingConfig> = {}) {
    this.config = { ...CDEFAULTS, ...config };
    this.mcp = mcp;
    this.idMap = createIdMap();
  }

  async validate(doc: IKtepDoc): Promise<void> {
    const result = validateKtepDoc(doc);
    if (!result.ok) {
      const msg = result.errors.map(e => `[${e.rule}] ${e.message}`).join('\n');
      throw new Error(`Jianying validation failed:\n${msg}`);
    }
  }

  async ensureProject(projectName: string): Promise<void> {
    const res = await this.mcp.call('create_draft', {
      draft_name: projectName,
    }) as any;
    this.draftId = res.draft_id ?? res.data?.draft_id;
    this.idMap.projectId = this.draftId!;
  }

  async importAssets(assets: IKtepAsset[]): Promise<void> {
    for (const asset of assets) {
      this.assetPaths.set(asset.id, asset.sourcePath);
    }
  }

  async createTimeline(timeline: IKtepTimeline): Promise<void> {
    if (!this.draftId) throw new Error('No draft created');

    for (const track of timeline.tracks) {
      const trackType = track.kind === 'subtitle' ? 'text' : track.kind;
      const res = await this.mcp.call('create_track', {
        draft_id: this.draftId,
        track_type: trackType,
        track_name: `${track.role}-${track.index}`,
      }) as any;
      const trackId = res.track_id ?? res.data?.track_id;
      if (trackId) {
        this.idMap.tracks.set(track.id, trackId);
        this.trackKindMap.set(track.id, track.kind);
      }
    }
  }

  async placeClips(clips: IKtepClip[]): Promise<void> {
    for (const clip of clips) {
      const jyTrackId = this.idMap.tracks.get(clip.trackId);
      if (!jyTrackId) continue;

      const material = this.assetPaths.get(clip.assetId);
      if (!material) continue;

      const targetRange = msToRange(clip.timelineInMs, clip.timelineOutMs);
      const trackKind = this.trackKindMap.get(clip.trackId) ?? 'video';

      if (trackKind === 'audio') {
        const args: Record<string, unknown> = {
          track_id: jyTrackId,
          material,
          target_start_end: targetRange,
        };
        if (clip.sourceInMs != null && clip.sourceOutMs != null) {
          args.source_start_end = msToRange(clip.sourceInMs, clip.sourceOutMs);
        }
        const res = await this.mcp.call('add_audio_segment', args) as any;
        const segId = res.audio_segment_id ?? res.data?.audio_segment_id;
        if (segId) this.idMap.clips.set(clip.id, segId);
      } else {
        const args: Record<string, unknown> = {
          track_id: jyTrackId,
          material,
          target_start_end: targetRange,
        };
        if (clip.sourceInMs != null && clip.sourceOutMs != null) {
          args.source_start_end = msToRange(clip.sourceInMs, clip.sourceOutMs);
        }
        if (clip.transform) {
          args.clip_settings = {
            ...(clip.transform.scale != null && {
              scale_x: clip.transform.scale,
              scale_y: clip.transform.scale,
            }),
            ...(clip.transform.positionX != null && { transform_x: clip.transform.positionX }),
            ...(clip.transform.positionY != null && { transform_y: clip.transform.positionY }),
            ...(clip.transform.rotation != null && { rotation: clip.transform.rotation }),
          };
        }
        const res = await this.mcp.call('add_video_segment', args) as any;
        const segId = res.video_segment_id ?? res.data?.video_segment_id;
        if (segId) this.idMap.clips.set(clip.id, segId);

        if (clip.transitionOut && clip.transitionOut.type !== 'cut') {
          const transitionName = mapTransitionType(clip.transitionOut.type);
          if (transitionName && segId) {
            await this.mcp.call('add_video_transition', {
              video_segment_id: segId,
              transition_type: transitionName,
              ...(clip.transitionOut.durationMs && {
                duration: msToTimeStr(clip.transitionOut.durationMs),
              }),
            }).catch(() => {});
          }
        }
      }
    }
  }

  async addSubtitles(cues: IKtepSubtitle[]): Promise<void> {
    if (!this.draftId) throw new Error('No draft created');

    let textTrackId: string | null = null;
    for (const [ktepId, jyId] of this.idMap.tracks) {
      if (ktepId.includes('caption') || ktepId.includes('subtitle')) {
        textTrackId = jyId;
        break;
      }
    }

    if (!textTrackId) {
      const res = await this.mcp.call('create_track', {
        draft_id: this.draftId,
        track_type: 'text',
        track_name: 'subtitles',
      }) as any;
      textTrackId = res.track_id ?? res.data?.track_id;
    }

    if (!textTrackId) return;

    for (const cue of cues) {
      await this.mcp.call('add_text_segment', {
        track_id: textTrackId,
        text: cue.text,
        target_start_end: msToRange(cue.startMs, cue.endMs),
        style: { size: this.config.subtitleSize },
        clip_settings: { transform_y: this.config.subtitleY },
      });
    }
  }

  async exportDraft(): Promise<string | null> {
    if (!this.draftId) return null;
    const args: Record<string, unknown> = { draft_id: this.draftId };
    if (this.config.outputPath) args.jianying_draft_path = this.config.outputPath;
    const res = await this.mcp.call('export_draft', args) as any;
    return res.data?.output_path ?? null;
  }

  getIdMap(): INleIdMap {
    return this.idMap;
  }
}

function mapTransitionType(type: string): string | null {
  const map: Record<string, string> = {
    'cross-dissolve': '叠化',
    'fade': '淡化',
    'wipe': '擦除',
  };
  return map[type] ?? null;
}
