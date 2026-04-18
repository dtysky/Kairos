import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
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
import { resolveProtectionAudioLocalPath } from '../media/protection-audio.js';
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
  speed?: number;
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
  ffmpegPath?: string;
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

interface IResolvedClipMaterial {
  materialPath: string;
  sourceInMs?: number;
  sourceOutMs?: number;
  audioGainDb?: number;
}

const exec = promisify(execFile);
const C_TARGET_AUDIO_LOUDNESS_LUFS = -16;
const C_MAX_TRUE_PEAK_DBTP = -1;

export class JianyingDraftBuilder {
  private config: IJianyingBuilderConfig & {
    subtitleY: number;
    subtitleSize: number;
  };
  private idMap: INleIdMap;
  private assetPaths = new Map<string, string>();
  private protectionAssetPaths = new Map<string, string>();
  private dialogueClipMaterialPaths = new Map<string, string>();
  private assetKindMap = new Map<string, IKtepAsset['kind']>();
  private trackKindMap = new Map<string, EJianyingTrackKind>();
  private tracks: IJianyingTrackSpec[] = [];
  private clips: IJianyingClipSpec[] = [];
  private subtitles: IJianyingSubtitleSpec[] = [];
  private timeline: IJianyingDraftSpec['timeline'] | null = null;
  private projectId: string | undefined;
  private projectName: string | undefined;
  private subtitleTrackNames: string[] = [];
  private warnings = new Set<string>();
  private pathResolutionContextPromise: Promise<IAssetResolutionContext | null> | null = null;
  private extractedAudioDirPromise: Promise<string> | null = null;
  private audioGainCache = new Map<string, number>();

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
      this.assetKindMap.set(asset.id, asset.kind);
      const protectionPath = this.resolveProtectionAudioPath(asset, context);
      if (protectionPath) {
        this.protectionAssetPaths.set(asset.id, protectionPath);
      }
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
        this.subtitleTrackNames.push(name);
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

      const resolvedMaterial = await this.resolveClipMaterial(clip, trackKind);
      if (!resolvedMaterial) {
        throw new Error(`Jianying clip ${clip.id} references unresolved asset ${clip.assetId}`);
      }
      if (resolvedMaterial.audioGainDb != null && clip.audioGainDb == null) {
        clip.audioGainDb = resolvedMaterial.audioGainDb;
      }

      const clipSettings = buildClipSettings(clip);
      const clipVolume = buildClipVolume(clip, resolvedMaterial.audioGainDb);
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
        materialPath: resolvedMaterial.materialPath,
        targetStartMs: clip.timelineInMs,
        targetEndMs: clip.timelineOutMs,
        ...(resolvedMaterial.sourceInMs != null && { sourceInMs: resolvedMaterial.sourceInMs }),
        ...(resolvedMaterial.sourceOutMs != null && { sourceOutMs: resolvedMaterial.sourceOutMs }),
        ...(clip.speed != null && { speed: clip.speed }),
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
    type ISubtitleLane = {
      trackName: string;
      endMs: number;
    };

    const lanes: ISubtitleLane[] = [];
    const subtitles: IJianyingSubtitleSpec[] = [];
    const sortedCues = [...cues].sort((left, right) => (
      left.startMs - right.startMs
      || left.endMs - right.endMs
      || left.id.localeCompare(right.id)
    ));

    for (const cue of sortedCues) {
      const lane = this.resolveSubtitleLane(lanes, cue);
      subtitles.push({
        id: cue.id,
        trackName: lane.trackName,
        text: cue.text,
        startMs: cue.startMs,
        endMs: cue.endMs,
        style: { size: this.config.subtitleSize },
        clipSettings: { transform_y: this.config.subtitleY },
      });
    }

    this.subtitles = subtitles.sort((left, right) => (
      left.trackName.localeCompare(right.trackName)
      || left.startMs - right.startMs
      || left.endMs - right.endMs
      || left.id.localeCompare(right.id)
    ));
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

  private resolveProtectionAudioPath(
    asset: IKtepAsset,
    context: IAssetResolutionContext | null,
  ): string | null {
    if (!asset.protectionAudio?.sourcePath) return null;

    if (isUri(asset.protectionAudio.sourcePath)) {
      return asset.protectionAudio.sourcePath;
    }

    if (isPlatformAbsolutePath(asset.protectionAudio.sourcePath)) {
      return normalizeMaterialPath(asset.protectionAudio.sourcePath);
    }

    if (!context) {
      throw new Error(
        `Asset ${asset.id} uses relative protection audio path '${asset.protectionAudio.sourcePath}', but no projectRoot or media root mapping was provided for Jianying export.`,
      );
    }

    const resolved = resolveProtectionAudioLocalPath(
      context.projectId,
      asset,
      context.roots,
      context.deviceMaps,
    );
    if (!resolved) {
      const rootHint = asset.ingestRootId ?? 'unknown-ingest-root';
      throw new Error(
        `Unable to resolve protection audio for asset ${asset.id} from ingest root ${rootHint}. Check device media mappings or sidecar binding.`,
      );
    }

    return normalizeMaterialPath(resolved);
  }

  private async resolveClipMaterial(
    clip: IKtepClip,
    trackKind: EJianyingTrackKind,
  ): Promise<IResolvedClipMaterial | undefined> {
    if (trackKind === 'audio') {
      const dialogueMaterial = this.dialogueClipMaterialPaths.get(clip.id);
      if (dialogueMaterial) {
        return {
          materialPath: dialogueMaterial,
          audioGainDb: await this.resolveClipAudioGainDb(clip, dialogueMaterial, true),
        };
      }

      const protectionPath = this.protectionAssetPaths.get(clip.assetId);
      if (clip.audioSource === 'protection' && protectionPath) {
        return {
          materialPath: protectionPath,
          sourceInMs: clip.sourceInMs,
          sourceOutMs: clip.sourceOutMs,
          audioGainDb: await this.resolveClipAudioGainDb(clip, protectionPath, false),
        };
      }

      const assetKind = this.assetKindMap.get(clip.assetId);
      if (assetKind === 'video') {
        const assetPath = this.assetPaths.get(clip.assetId);
        if (!assetPath) return undefined;
        const extractedPath = await this.extractDialogueAudioClip(clip, assetPath);
        this.dialogueClipMaterialPaths.set(clip.id, extractedPath);
        return {
          materialPath: extractedPath,
          audioGainDb: await this.resolveClipAudioGainDb(clip, extractedPath, true),
        };
      }

      const assetPath = this.assetPaths.get(clip.assetId);
      if (!assetPath) return undefined;
      return {
        materialPath: assetPath,
        sourceInMs: clip.sourceInMs,
        sourceOutMs: clip.sourceOutMs,
        audioGainDb: await this.resolveClipAudioGainDb(clip, assetPath, false),
      };
    }

    const assetPath = this.assetPaths.get(clip.assetId);
    if (!assetPath) return undefined;
    return {
      materialPath: assetPath,
      sourceInMs: clip.sourceInMs,
      sourceOutMs: clip.sourceOutMs,
    };
  }

  private async extractDialogueAudioClip(
    clip: IKtepClip,
    sourcePath: string,
  ): Promise<string> {
    if (isUri(sourcePath)) {
      throw new Error(`Cannot extract dialogue audio for remote URI asset ${clip.assetId}.`);
    }
    const sourceInMs = clip.sourceInMs ?? 0;
    const sourceOutMs = clip.sourceOutMs;
    if (sourceOutMs == null || sourceOutMs <= sourceInMs) {
      throw new Error(`Dialogue clip ${clip.id} is missing a valid source range for audio extraction.`);
    }

    const audioDir = await this.getExtractedAudioDir();
    const outputPath = join(audioDir, `${clip.id}.wav`);
    const ffmpeg = this.config.ffmpegPath?.trim() || 'ffmpeg';
    await exec(ffmpeg, [
      '-y',
      '-ss', msToFfmpegTime(sourceInMs),
      '-i', sourcePath,
      '-t', msToFfmpegTime(sourceOutMs - sourceInMs),
      '-vn',
      '-ac', '2',
      '-ar', '48000',
      '-c:a', 'pcm_s16le',
      outputPath,
    ], {
      maxBuffer: 50 * 1024 * 1024,
      windowsHide: true,
    });
    return normalizeMaterialPath(outputPath);
  }

  private async getExtractedAudioDir(): Promise<string> {
    if (!this.extractedAudioDirPromise) {
      this.extractedAudioDirPromise = (async () => {
        const root = this.config.projectRoot
          ? join(this.config.projectRoot, '.tmp', 'jianying-dialogue-audio')
          : join(tmpdir(), 'kairos-jianying-dialogue-audio');
        await mkdir(root, { recursive: true });
        return root;
      })();
    }
    return this.extractedAudioDirPromise;
  }

  private async resolveClipAudioGainDb(
    clip: IKtepClip,
    materialPath: string,
    extractedClipMaterial: boolean,
  ): Promise<number | undefined> {
    if (typeof clip.audioGainDb === 'number' && Number.isFinite(clip.audioGainDb)) {
      return clip.audioGainDb;
    }
    if (isUri(materialPath)) return undefined;

    const cacheKey = extractedClipMaterial
      ? `material:${materialPath}`
      : [
        materialPath,
        clip.sourceInMs ?? '',
        clip.sourceOutMs ?? '',
        clip.audioSource ?? '',
      ].join('|');
    const cached = this.audioGainCache.get(cacheKey);
    if (cached != null) {
      return cached;
    }

    const loudness = await measureClipLoudness({
      materialPath,
      ffmpegPath: this.config.ffmpegPath,
      sourceInMs: extractedClipMaterial ? undefined : clip.sourceInMs,
      sourceOutMs: extractedClipMaterial ? undefined : clip.sourceOutMs,
    });
    if (!loudness) return undefined;

    let gainDb = C_TARGET_AUDIO_LOUDNESS_LUFS - loudness.integratedLufs;
    if (loudness.truePeakDbtp + gainDb > C_MAX_TRUE_PEAK_DBTP) {
      gainDb = C_MAX_TRUE_PEAK_DBTP - loudness.truePeakDbtp;
    }

    const normalizedGainDb = Math.round(gainDb * 100) / 100;
    this.audioGainCache.set(cacheKey, normalizedGainDb);
    return normalizedGainDb;
  }

  private resolveSubtitleLane(
    lanes: Array<{ trackName: string; endMs: number }>,
    cue: IKtepSubtitle,
  ): { trackName: string; endMs: number } {
    const reusableLane = lanes.find(lane => cue.startMs >= lane.endMs);
    if (reusableLane) {
      reusableLane.endMs = cue.endMs;
      return reusableLane;
    }

    const createdLane = {
      trackName: this.ensureSubtitleTrack(lanes.length),
      endMs: cue.endMs,
    };
    lanes.push(createdLane);
    return createdLane;
  }

  private ensureSubtitleTrack(index: number): string {
    const existingTrackName = this.subtitleTrackNames[index];
    if (existingTrackName) return existingTrackName;

    const generatedName = createUniqueTrackName(this.tracks.map(track => track.name), 'subtitles');
    const generatedTrack: IJianyingTrackSpec = {
      id: index === 0 ? CGENERATED_SUBTITLE_TRACK_ID : `${CGENERATED_SUBTITLE_TRACK_ID}-${index}`,
      kind: 'text',
      role: 'caption',
      index,
      name: generatedName,
      relativeIndex: 999 + index,
    };
    this.tracks.push(generatedTrack);
    this.trackKindMap.set(generatedTrack.id, generatedTrack.kind);
    this.idMap.tracks.set(generatedTrack.id, generatedTrack.name);
    this.subtitleTrackNames.push(generatedTrack.name);
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

  if (material.includes('\\')) {
    return material.replace(/\\/g, '/');
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

function buildClipVolume(clip: IKtepClip, measuredAudioGainDb?: number): number | undefined {
  if (clip.muteAudio) return 0;
  const audioGainDb = measuredAudioGainDb ?? clip.audioGainDb;
  if (typeof audioGainDb !== 'number' || !Number.isFinite(audioGainDb)) return undefined;
  return Math.round((10 ** (audioGainDb / 20)) * 10000) / 10000;
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

async function measureClipLoudness(input: {
  materialPath: string;
  ffmpegPath?: string;
  sourceInMs?: number;
  sourceOutMs?: number;
}): Promise<{ integratedLufs: number; truePeakDbtp: number } | null> {
  const ffmpeg = input.ffmpegPath?.trim() || 'ffmpeg';
  const args = [
    '-hide_banner',
    '-nostats',
    ...(input.sourceInMs != null ? ['-ss', msToFfmpegTime(input.sourceInMs)] : []),
    '-i', input.materialPath,
    ...(input.sourceOutMs != null && input.sourceInMs != null && input.sourceOutMs > input.sourceInMs
      ? ['-t', msToFfmpegTime(input.sourceOutMs - input.sourceInMs)]
      : []),
    '-vn',
    '-af', `loudnorm=I=${C_TARGET_AUDIO_LOUDNESS_LUFS}:TP=${C_MAX_TRUE_PEAK_DBTP}:LRA=11:print_format=json`,
    '-f', 'null',
    '-',
  ];

  try {
    const { stderr } = await exec(ffmpeg, args, {
      maxBuffer: 50 * 1024 * 1024,
      windowsHide: true,
    });
    return parseLoudnormMetrics(stderr);
  } catch (error) {
    const stderr = typeof error === 'object' && error && 'stderr' in error
      ? String((error as { stderr?: unknown }).stderr ?? '')
      : '';
    return parseLoudnormMetrics(stderr);
  }
}

function parseLoudnormMetrics(stderr: string): { integratedLufs: number; truePeakDbtp: number } | null {
  const match = stderr.match(/\{\s*"input_i"[\s\S]*?\}/u);
  if (!match) return null;

  try {
    const payload = JSON.parse(match[0]) as { input_i?: string; input_tp?: string };
    const integratedLufs = Number(payload.input_i);
    const truePeakDbtp = Number(payload.input_tp);
    if (!Number.isFinite(integratedLufs) || !Number.isFinite(truePeakDbtp)) {
      return null;
    }
    return { integratedLufs, truePeakDbtp };
  } catch {
    return null;
  }
}

function msToFfmpegTime(ms: number): string {
  return (Math.max(0, ms) / 1000).toFixed(3);
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
