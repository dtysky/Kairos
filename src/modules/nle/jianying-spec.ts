import { basename } from 'node:path';
import type {
  IDeviceMediaMapFile,
  IKtepAsset,
  IKtepClip,
  IKtepDoc,
  IKtepSubtitle,
  IKtepTimeline,
  IMediaRoot,
} from '../../protocol/schema.js';
import { validateKtepDoc } from '../../protocol/validator.js';
import { resolveAssetLocalPath } from '../media/root-resolver.js';
import { loadProjectDeviceMediaMaps } from '../../store/device-media-maps.js';
import { loadIngestRoots } from '../../store/project.js';
import type { INleIdMap } from './adapter.js';
import { createIdMap } from './adapter.js';

export type EJianyingTrackKind = 'video' | 'audio' | 'text';

export interface IJianyingClipSettings {
  scale_x?: number;
  scale_y?: number;
  transform_x?: number;
  transform_y?: number;
  rotation?: number;
}

export interface IJianyingTransitionSpec {
  type: string;
  name: string;
  durationMs?: number;
}

export interface IJianyingTrackSpec {
  id: string;
  kind: EJianyingTrackKind;
  role: string;
  index: number;
  name: string;
  relativeIndex: number;
}

export interface IJianyingClipSpec {
  id: string;
  trackId: string;
  trackName: string;
  kind: 'video' | 'audio';
  materialPath: string;
  targetStartMs: number;
  targetEndMs: number;
  sourceInMs?: number;
  sourceOutMs?: number;
  volume?: number;
  clipSettings?: IJianyingClipSettings;
  transitionOut?: IJianyingTransitionSpec;
}

export interface IJianyingSubtitleSpec {
  id: string;
  trackName: string;
  text: string;
  startMs: number;
  endMs: number;
  style?: {
    size?: number;
  };
  clipSettings?: IJianyingClipSettings;
}

export interface IJianyingDraftSpec {
  version: '1.0';
  backend: 'pyjianyingdraft';
  compatibility: 'legacy-draft-format';
  project: {
    id?: string;
    name: string;
  };
  timeline: {
    id?: string;
    name: string;
    fps: number;
    resolution: {
      width: number;
      height: number;
    };
  };
  tracks: IJianyingTrackSpec[];
  clips: IJianyingClipSpec[];
  subtitles: IJianyingSubtitleSpec[];
}

export interface IJianyingDraftBuildResult {
  spec: IJianyingDraftSpec;
  idMap: INleIdMap;
  warnings: string[];
}

export interface IJianyingBuilderConfig {
  subtitleY?: number;
  subtitleSize?: number;
  projectRoot?: string;
  deviceMapProjectId?: string;
  mediaRoots?: IMediaRoot[];
  deviceMaps?: IDeviceMediaMapFile;
}

const CDEFAULTS = {
  subtitleY: -0.8,
  subtitleSize: 6.0,
} as const;

const CGENERATED_SUBTITLE_TRACK_ID = '__generated_subtitles__';

interface IAssetResolutionContext {
  projectId: string;
  roots: IMediaRoot[];
  deviceMaps: IDeviceMediaMapFile;
}

export class JianyingDraftBuilder {
  private config: IJianyingBuilderConfig & {
    subtitleY: number;
    subtitleSize: number;
  };
  private idMap: INleIdMap;
  private assetPaths = new Map<string, string>();
  private trackKindMap = new Map<string, EJianyingTrackKind>();
  private tracks: IJianyingTrackSpec[] = [];
  private clips: IJianyingClipSpec[] = [];
  private subtitles: IJianyingSubtitleSpec[] = [];
  private timeline: IJianyingDraftSpec['timeline'] | null = null;
  private projectId: string | undefined;
  private projectName: string | undefined;
  private subtitleTrackName: string | null = null;
  private warnings = new Set<string>();
  private pathResolutionContextPromise: Promise<IAssetResolutionContext | null> | null = null;

  constructor(config: IJianyingBuilderConfig = {}) {
    this.config = {
      ...config,
      subtitleY: config.subtitleY ?? CDEFAULTS.subtitleY,
      subtitleSize: config.subtitleSize ?? CDEFAULTS.subtitleSize,
    };
    this.idMap = createIdMap();
  }

  async validate(doc: IKtepDoc): Promise<void> {
    const result = validateKtepDoc(doc);
    if (!result.ok) {
      const msg = result.errors.map(e => `[${e.rule}] ${e.message}`).join('\n');
      throw new Error(`Jianying validation failed:\n${msg}`);
    }

    this.projectId = doc.project.id;
    this.projectName = doc.project.name;
    this.idMap.projectId = doc.project.id;
  }

  async ensureProject(projectName: string): Promise<void> {
    this.projectName = projectName;
  }

  async importAssets(assets: IKtepAsset[]): Promise<void> {
    const context = await this.getAssetResolutionContext();
    for (const asset of assets) {
      const resolved = this.resolveAssetPath(asset, context);
      this.assetPaths.set(asset.id, resolved);
      this.idMap.assets.set(asset.id, resolved);
    }
  }

  async createTimeline(timeline: IKtepTimeline): Promise<void> {
    this.timeline = {
      id: timeline.id,
      name: timeline.name,
      fps: timeline.fps,
      resolution: {
        width: timeline.resolution.width,
        height: timeline.resolution.height,
      },
    };
    this.idMap.timelineId = timeline.id;

    this.tracks = timeline.tracks.map(track => {
      const kind = mapTrackKind(track.kind);
      const name = buildTrackName(track.role, track.index);
      if (kind === 'text') {
        this.subtitleTrackName = name;
      }

      this.trackKindMap.set(track.id, kind);
      this.idMap.tracks.set(track.id, name);

      return {
        id: track.id,
        kind,
        role: track.role,
        index: track.index,
        name,
        relativeIndex: track.index,
      };
    });
  }

  async placeClips(clips: IKtepClip[]): Promise<void> {
    this.clips = [];
    for (const clip of clips) {
      const trackName = this.idMap.tracks.get(clip.trackId);
      if (!trackName) {
        throw new Error(`Jianying clip ${clip.id} references unknown track ${clip.trackId}`);
      }

      const trackKind = this.trackKindMap.get(clip.trackId);
      if (!trackKind || trackKind === 'text') {
        throw new Error(`Jianying clip ${clip.id} cannot be placed on track ${clip.trackId}`);
      }

      const materialPath = this.assetPaths.get(clip.assetId);
      if (!materialPath) {
        throw new Error(`Jianying clip ${clip.id} references unresolved asset ${clip.assetId}`);
      }

      const clipSettings = buildClipSettings(clip);
      const clipVolume = buildClipVolume(clip);
      if (clip.transform?.kenBurns) {
        this.warnings.add(
          `Clip ${clip.id} contains kenBurns data, but the pyJianYingDraft backend currently ignores kenBurns motion.`,
        );
      }

      this.clips.push({
        id: clip.id,
        trackId: clip.trackId,
        trackName,
        kind: trackKind,
        materialPath,
        targetStartMs: clip.timelineInMs,
        targetEndMs: clip.timelineOutMs,
        ...(clip.sourceInMs != null && { sourceInMs: clip.sourceInMs }),
        ...(clip.sourceOutMs != null && { sourceOutMs: clip.sourceOutMs }),
        ...(clipVolume != null && { volume: clipVolume }),
        ...(clipSettings && { clipSettings }),
        ...(trackKind === 'video' && clip.transitionOut?.type !== 'cut' && {
          transitionOut: buildTransitionSpec(clip.transitionOut?.type, clip.transitionOut?.durationMs),
        }),
      });
      this.idMap.clips.set(clip.id, clip.id);
    }
  }

  async addSubtitles(cues: IKtepSubtitle[]): Promise<void> {
    const trackName = this.ensureSubtitleTrack();
    this.subtitles = cues.map(cue => ({
      id: cue.id,
      trackName,
      text: cue.text,
      startMs: cue.startMs,
      endMs: cue.endMs,
      style: { size: this.config.subtitleSize },
      clipSettings: { transform_y: this.config.subtitleY },
    }));
  }

  build(): IJianyingDraftSpec {
    if (!this.projectName) {
      throw new Error('Jianying draft project name is not set');
    }
    if (!this.timeline) {
      throw new Error('Jianying draft timeline has not been created');
    }

    return {
      version: '1.0',
      backend: 'pyjianyingdraft',
      compatibility: 'legacy-draft-format',
      project: {
        ...(this.projectId && { id: this.projectId }),
        name: this.projectName,
      },
      timeline: this.timeline,
      tracks: [...this.tracks],
      clips: [...this.clips],
      subtitles: [...this.subtitles],
    };
  }

  getIdMap(): INleIdMap {
    return this.idMap;
  }

  getWarnings(): string[] {
    return [...this.warnings];
  }

  private async getAssetResolutionContext(): Promise<IAssetResolutionContext | null> {
    if (!this.pathResolutionContextPromise) {
      this.pathResolutionContextPromise = this.loadAssetResolutionContext();
    }
    return this.pathResolutionContextPromise;
  }

  private async loadAssetResolutionContext(): Promise<IAssetResolutionContext | null> {
    if (this.config.mediaRoots && this.config.deviceMaps) {
      const projectId = resolveDeviceMapProjectId(
        this.config.projectRoot,
        this.config.deviceMaps,
        this.config.deviceMapProjectId,
        this.projectId,
      );
      return {
        projectId,
        roots: this.config.mediaRoots,
        deviceMaps: this.config.deviceMaps,
      };
    }

    if (!this.config.projectRoot) return null;

    const [ingestRoots, deviceMaps] = await Promise.all([
      this.config.mediaRoots
        ? Promise.resolve(this.config.mediaRoots)
        : loadIngestRoots(this.config.projectRoot).then(data => data.roots),
      this.config.deviceMaps
        ? Promise.resolve(this.config.deviceMaps)
        : loadProjectDeviceMediaMaps(this.config.projectRoot),
    ]);

    const projectId = resolveDeviceMapProjectId(
      this.config.projectRoot,
      deviceMaps,
      this.config.deviceMapProjectId,
      this.projectId,
    );

    return {
      projectId,
      roots: ingestRoots,
      deviceMaps,
    };
  }

  private resolveAssetPath(asset: IKtepAsset, context: IAssetResolutionContext | null): string {
    if (isUri(asset.sourcePath)) {
      return asset.sourcePath;
    }

    if (isPlatformAbsolutePath(asset.sourcePath)) {
      return normalizeMaterialPath(asset.sourcePath);
    }

    if (!context) {
      throw new Error(
        `Asset ${asset.id} uses relative sourcePath '${asset.sourcePath}', but no projectRoot or media root mapping was provided for Jianying export.`,
      );
    }

    const resolved = resolveAssetLocalPath(context.projectId, asset, context.roots, context.deviceMaps);
    if (!resolved) {
      const rootHint = asset.ingestRootId ?? 'unknown-ingest-root';
      throw new Error(
        `Unable to resolve asset ${asset.id} (${asset.sourcePath}) from ingest root ${rootHint}. Check device media mappings or pass deviceMapProjectId explicitly.`,
      );
    }

    return normalizeMaterialPath(resolved);
  }

  private ensureSubtitleTrack(): string {
    if (this.subtitleTrackName) return this.subtitleTrackName;

    const generatedName = createUniqueTrackName(this.tracks.map(track => track.name), 'subtitles');
    const generatedTrack: IJianyingTrackSpec = {
      id: CGENERATED_SUBTITLE_TRACK_ID,
      kind: 'text',
      role: 'caption',
      index: 0,
      name: generatedName,
      relativeIndex: 999,
    };
    this.tracks.push(generatedTrack);
    this.trackKindMap.set(generatedTrack.id, generatedTrack.kind);
    this.idMap.tracks.set(generatedTrack.id, generatedTrack.name);
    this.subtitleTrackName = generatedTrack.name;
    return generatedTrack.name;
  }
}

export async function buildJianyingDraftSpec(
  doc: IKtepDoc,
  config: IJianyingBuilderConfig = {},
): Promise<IJianyingDraftBuildResult> {
  const builder = new JianyingDraftBuilder(config);
  await builder.validate(doc);
  await builder.ensureProject(doc.project.name);
  await builder.importAssets(doc.assets);
  await builder.createTimeline(doc.timeline);
  await builder.placeClips(doc.timeline.clips);
  if (doc.subtitles?.length) {
    await builder.addSubtitles(doc.subtitles);
  }

  return {
    spec: builder.build(),
    idMap: builder.getIdMap(),
    warnings: builder.getWarnings(),
  };
}

export function normalizeMaterialPath(material: string): string {
  if (isUri(material)) return material;

  if (/^[a-zA-Z]:\//.test(material)) {
    return material.replace(/\//g, '\\');
  }

  const wslMountMatch = material.match(/^\/mnt\/([a-zA-Z])\/(.*)$/);
  if (!wslMountMatch) return material;

  const [, driveLetter, rest] = wslMountMatch;
  return `${driveLetter.toUpperCase()}:\\${rest.replace(/\//g, '\\')}`;
}

export function msToTimeStr(ms: number): string {
  return `${(ms / 1000).toFixed(3)}s`;
}

export function msToRange(inMs: number, outMs: number): string {
  return `${msToTimeStr(inMs)}-${msToTimeStr(outMs)}`;
}

export function mapTransitionType(type: string): string | null {
  const map: Record<string, string> = {
    'cross-dissolve': '叠化',
    // pyJianYingDraft does not expose a generic fade-to-color transition,
    // so we map `fade` to the closest broadly available dissolve transition.
    'fade': '叠化',
    'wipe': '渐变擦除',
  };
  return map[type] ?? null;
}

function buildTrackName(role: string, index: number): string {
  return `${role}-${index}`;
}

function mapTrackKind(kind: string): EJianyingTrackKind {
  return kind === 'subtitle' ? 'text' : kind as EJianyingTrackKind;
}

function buildClipSettings(clip: IKtepClip): IJianyingClipSettings | undefined {
  if (!clip.transform) return undefined;

  const settings: IJianyingClipSettings = {
    ...(clip.transform.scale != null && {
      scale_x: clip.transform.scale,
      scale_y: clip.transform.scale,
    }),
    ...(clip.transform.positionX != null && { transform_x: clip.transform.positionX }),
    ...(clip.transform.positionY != null && { transform_y: clip.transform.positionY }),
    ...(clip.transform.rotation != null && { rotation: clip.transform.rotation }),
  };

  return Object.keys(settings).length > 0 ? settings : undefined;
}

function buildClipVolume(clip: IKtepClip): number | undefined {
  return clip.muteAudio ? 0 : undefined;
}

function buildTransitionSpec(type: string | undefined, durationMs: number | undefined): IJianyingTransitionSpec | undefined {
  if (!type) return undefined;
  const name = mapTransitionType(type);
  if (!name) return undefined;

  return {
    type,
    name,
    ...(durationMs != null && { durationMs }),
  };
}

function resolveDeviceMapProjectId(
  projectRoot: string | undefined,
  deviceMaps: IDeviceMediaMapFile,
  explicitProjectId: string | undefined,
  docProjectId: string | undefined,
): string {
  if (explicitProjectId?.trim()) return explicitProjectId.trim();

  const projectRootId = projectRoot ? basename(projectRoot) : null;
  if (projectRootId && deviceMaps.projects[projectRootId]) return projectRootId;
  if (docProjectId && deviceMaps.projects[docProjectId]) return docProjectId;

  const projectIds = Object.keys(deviceMaps.projects);
  if (projectIds.length === 1) return projectIds[0]!;
  return projectRootId ?? docProjectId ?? '';
}

function createUniqueTrackName(existing: string[], baseName: string): string {
  if (!existing.includes(baseName)) return baseName;

  let suffix = 1;
  while (existing.includes(`${baseName}-${suffix}`)) {
    suffix += 1;
  }
  return `${baseName}-${suffix}`;
}

function isUri(value: string): boolean {
  return /^[a-z]+:\/\//i.test(value);
}

function isPlatformAbsolutePath(value: string): boolean {
  return value.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(value);
}
