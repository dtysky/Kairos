import type {
  IKtepDoc, IKtepAsset, IKtepTimeline,
  IKtepClip, IKtepSubtitle,
} from '../../protocol/schema.js';
import { validateKtepDoc } from '../../protocol/validator.js';
import type { INleAdapter, INleCapabilities, INleIdMap } from './adapter.js';
import { createIdMap } from './adapter.js';

export interface IJianyingConfig {
  mcpBaseUrl: string;
}

const CDEFAULT_CONFIG: IJianyingConfig = {
  mcpBaseUrl: 'http://127.0.0.1:9000',
};

/**
 * 剪映 MCP 适配器。
 * 通过 HTTP 调用剪映 MCP Server 实现时间线操作。
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
  private idMap: INleIdMap;

  constructor(config: Partial<IJianyingConfig> = {}) {
    this.config = { ...CDEFAULT_CONFIG, ...config };
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
    const res = await this.callMcp('create_project', { name: projectName });
    this.idMap.projectId = res.project_id;
  }

  async importAssets(assets: IKtepAsset[]): Promise<void> {
    for (const asset of assets) {
      const res = await this.callMcp('import_media', {
        project_id: this.idMap.projectId,
        file_path: asset.sourcePath,
        media_type: asset.kind,
      });
      this.idMap.assets.set(asset.id, res.media_id);
    }
  }

  async createTimeline(timeline: IKtepTimeline): Promise<void> {
    const res = await this.callMcp('create_timeline', {
      project_id: this.idMap.projectId,
      name: timeline.name,
      fps: timeline.fps,
      width: timeline.resolution.width,
      height: timeline.resolution.height,
    });
    this.idMap.timelineId = res.timeline_id;

    for (const track of timeline.tracks) {
      const tRes = await this.callMcp('add_track', {
        timeline_id: this.idMap.timelineId,
        kind: track.kind,
        name: `${track.role}-${track.index}`,
      });
      this.idMap.tracks.set(track.id, tRes.track_id);
    }
  }

  async placeClips(clips: IKtepClip[]): Promise<void> {
    for (const clip of clips) {
      const mediaId = this.idMap.assets.get(clip.assetId);
      const trackId = this.idMap.tracks.get(clip.trackId);
      if (!mediaId || !trackId) continue;

      const params: Record<string, unknown> = {
        timeline_id: this.idMap.timelineId,
        track_id: trackId,
        media_id: mediaId,
        timeline_in_ms: clip.timelineInMs,
        timeline_out_ms: clip.timelineOutMs,
      };

      if (clip.sourceInMs != null) params.source_in_ms = clip.sourceInMs;
      if (clip.sourceOutMs != null) params.source_out_ms = clip.sourceOutMs;

      if (clip.transitionIn) {
        params.transition_in = {
          type: clip.transitionIn.type,
          duration_ms: clip.transitionIn.durationMs,
        };
      }

      if (clip.transform && this.capabilities.transform) {
        params.transform = {
          scale: clip.transform.scale,
          position_x: clip.transform.positionX,
          position_y: clip.transform.positionY,
          rotation: clip.transform.rotation,
        };
      }

      const res = await this.callMcp('place_clip', params);
      this.idMap.clips.set(clip.id, res.clip_id);
    }
  }

  async addSubtitles(cues: IKtepSubtitle[]): Promise<void> {
    for (const cue of cues) {
      await this.callMcp('add_subtitle', {
        timeline_id: this.idMap.timelineId,
        start_ms: cue.startMs,
        end_ms: cue.endMs,
        text: cue.text,
        language: cue.language,
      });
    }
  }

  getIdMap(): INleIdMap {
    return this.idMap;
  }

  private async callMcp(method: string, params: Record<string, unknown>): Promise<any> {
    const res = await fetch(`${this.config.mcpBaseUrl}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method, params }),
    });
    if (!res.ok) {
      throw new Error(`Jianying MCP ${method}: ${res.status} ${await res.text()}`);
    }
    return res.json();
  }
}
