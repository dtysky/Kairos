import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type {
  IChronologyEvent,
  IKtepAsset,
  IKtepClip,
  IKtepDoc,
  IKtepProject,
  IKtepSpan,
  IMaterialSlotsDocument,
} from '../../protocol/schema.js';
import { CPROTOCOL, CVERSION, IMaterialSlotsDocument as ZMaterialSlotsDocument } from '../../protocol/schema.js';
import { validateKtepDoc } from '../../protocol/validator.js';
import {
  assertConfirmedProjectChronology,
  assertFreshSpans,
  getEditPlanningArtifactPath,
  getMaterialSlotsPath,
  getTimelineCurrentPath,
  loadAssetReports,
  loadAssets,
  loadIngestRoots,
  loadProject,
  loadRuntimeConfig,
  loadScriptBriefConfig,
  normalizeEditId,
  readJsonOrNull,
  writeJson,
} from '../../store/index.js';
import { resolveAssetLocalPath } from '../media/root-resolver.js';
import { assertConfirmedEditFlowPlan } from '../edit-flow/flow-planner.js';
import { assertMaterialSlotsContract, spanHasSpeechTruth } from '../edit-flow/material-slots-contract.js';
import { resolveTimelineBuildConfig, type IBuildConfig } from './timeline-builder.js';
import {
  createResolveRoughCutTimeline,
  syncResolveRoughCutMedia,
  type IResolveRoughCutMediaSyncResult,
  type IResolveRoughCutTimelineResult,
  type IResolveRoughCutClipInput,
} from './resolve-rough-cut.js';

const CPHOTO_DEFAULT_DURATION_MS = 5000;
const CRESOLVE_MEDIA_SYNC_TIMEOUT_MS = 60 * 60 * 1000;
const CRESOLVE_PROJECT_MEDIA_NAMESPACE = 'Kairos Project Media';
const CRESOLVE_TIMELINE_FOLDER_NAME = 'Kairos Timelines';

export interface IBuildProjectTimelineInput {
  projectRoot: string;
  editId?: string;
  workspaceRoot?: string;
  editRuleCategory?: string;
  config?: Partial<IBuildConfig>;
}

export interface IBuildProjectTimelineResult {
  doc: IKtepDoc;
  resolveTimeline: IResolveRoughCutTimelineResult;
}

export interface ISyncProjectResolveMediaInput {
  projectRoot: string;
  editId?: string;
  workspaceRoot?: string;
  editRuleCategory?: string;
}

export interface ISyncProjectResolveMediaResult {
  resolveProjectName: string;
  resolveMedia: IResolveRoughCutMediaSyncResult;
  hostSummary?: Record<string, unknown>;
}

interface IDeterministicTimelineBuild {
  doc: IKtepDoc;
  resolveClips: IResolveRoughCutClipInput[];
  timelineName: string;
  resolveProjectName: string;
}

interface IResolvedResolveMediaClip {
  assetId: string;
  rawRelativePath: string;
  eventId: string;
  eventTitle: string;
  eventKind: string;
  assetKind: 'video' | 'photo' | 'audio';
  sourceAbsolutePath: string;
  sourceStem: string;
}

export async function syncProjectResolveMedia(
  input: ISyncProjectResolveMediaInput,
): Promise<ISyncProjectResolveMediaResult> {
  const editId = normalizeEditId(input.editId);
  const [project, assets, freshSpans, chronology, ingestRoots] = await Promise.all([
    loadProject(input.projectRoot),
    loadAssets(input.projectRoot),
    assertFreshSpans(input.projectRoot),
    assertConfirmedProjectChronology(input.projectRoot),
    loadIngestRoots(input.projectRoot).then(result => result.roots),
  ]);
  if (input.workspaceRoot) {
    if (!input.editRuleCategory) {
      throw new Error('resolve.media_sync requires editRuleCategory to validate confirmed Flow Plan');
    }
    await assertConfirmedEditFlowPlan({
      workspaceRoot: input.workspaceRoot,
      projectRoot: input.projectRoot,
      editId,
      editRuleCategory: input.editRuleCategory,
      requiredCapabilityIds: ['resolve.media_sync'],
    });
  }
  const resolveProjectName = deriveResolveRoughCutProjectName(project.name, project.id);
  const clips = buildResolveMediaSyncClips({
    assets,
    spans: freshSpans.spans,
    chronologyEvents: chronology.events,
    ingestRoots,
  });
  const resolveMedia = await syncResolveRoughCutMedia({
    projectId: project.id,
    resolveProjectName,
    namespace: CRESOLVE_PROJECT_MEDIA_NAMESPACE,
    legacyNamespaces: [`Kairos Edit ${editId}`],
    clips,
  }, {
    timeoutMs: CRESOLVE_MEDIA_SYNC_TIMEOUT_MS,
  });
  return {
    resolveProjectName,
    resolveMedia,
    hostSummary: resolveMedia.hostSummary,
  };
}

export async function buildProjectTimeline(
  input: IBuildProjectTimelineInput,
): Promise<IBuildProjectTimelineResult> {
  const editId = normalizeEditId(input.editId);
  const [
    project,
    assets,
    freshSpans,
    materialSlots,
    chronology,
    assetReports,
    runtimeConfig,
    ingestRoots,
    editFramework,
    scriptBriefConfig,
  ] = await Promise.all([
    loadProject(input.projectRoot),
    loadAssets(input.projectRoot),
    assertFreshSpans(input.projectRoot),
    readJsonOrNull(
      getMaterialSlotsPath(input.projectRoot, editId),
      ZMaterialSlotsDocument,
    ) as Promise<IMaterialSlotsDocument | null>,
    assertConfirmedProjectChronology(input.projectRoot),
    loadAssetReports(input.projectRoot),
    loadRuntimeConfig(input.projectRoot),
    loadIngestRoots(input.projectRoot).then(result => result.roots),
    readFile(getEditPlanningArtifactPath(input.projectRoot, 'edit-framework.md', editId), 'utf-8'),
    loadScriptBriefConfig(input.projectRoot, editId),
  ]);
  if (!materialSlots) {
    throw new Error(`timeline.generate requires edits/${editId}/script/material-slots.json`);
  }
  if (!editFramework.trim()) {
    throw new Error(`timeline.generate requires non-empty edits/${editId}/planning/edit-framework.md`);
  }
  if (input.workspaceRoot) {
    if (!input.editRuleCategory) {
      throw new Error('timeline.generate requires editRuleCategory to validate confirmed Flow Plan');
    }
    await assertConfirmedEditFlowPlan({
      workspaceRoot: input.workspaceRoot,
      projectRoot: input.projectRoot,
      editId,
      editRuleCategory: input.editRuleCategory,
      requiredCapabilityIds: ['resolve.media_sync', 'timeline.generate'],
    });
  }

  assertMaterialSlotsContract({
    materialSlots,
    spans: freshSpans.spans,
    assets,
    assetReports,
  });

  const cfg = resolveTimelineBuildConfig(runtimeConfig, {
    ...input.config,
    name: deriveResolveRoughCutTimelineName(editId, scriptBriefConfig.editLabel),
    chronology: chronology.assetIndex,
  });
  const build = buildDeterministicTimeline({
    project,
    editId,
    assets,
    spans: freshSpans.spans,
    materialSlots,
    chronologyEvents: chronology.events,
    cfg,
    ingestRoots,
  });
  const validation = validateKtepDoc(build.doc);
  if (!validation.ok) {
    const message = validation.errors.map(error => `[${error.rule}] ${error.message}`).join('\n');
    throw new Error(`deterministic timeline validation failed:\n${message}`);
  }

  const resolveTimeline = await createResolveRoughCutTimeline({
    projectId: project.id,
    resolveProjectName: build.resolveProjectName,
    timelineName: build.timelineName,
    legacyTimelineNames: [`Kairos Rough Cut - ${editId}`],
    namespace: CRESOLVE_PROJECT_MEDIA_NAMESPACE,
    legacyNamespaces: [`Kairos Edit ${editId}`],
    timelineFolderName: CRESOLVE_TIMELINE_FOLDER_NAME,
    timelineSpec: {
      width: cfg.width,
      height: cfg.height,
      fps: cfg.fps,
    },
    stillDurationMs: cfg.stillDurationMs,
    clips: build.resolveClips,
  });
  const doc: IKtepDoc = {
    ...build.doc,
    adapterHints: {
      ...build.doc.adapterHints,
      resolveRoughCut: resolveTimeline,
    },
  };
  await writeJson(getTimelineCurrentPath(input.projectRoot, editId), doc);

  return {
    doc,
    resolveTimeline,
  };
}

function buildDeterministicTimeline(input: {
  project: IKtepProject;
  editId: string;
  assets: IKtepAsset[];
  spans: IKtepSpan[];
  materialSlots: IMaterialSlotsDocument;
  chronologyEvents: IChronologyEvent[];
  cfg: IBuildConfig;
  ingestRoots: Awaited<ReturnType<typeof loadIngestRoots>>['roots'];
}): IDeterministicTimelineBuild {
  const assetById = new Map(input.assets.map(asset => [asset.id, asset] as const));
  const spanById = new Map(input.spans.map(span => [span.id, span] as const));
  const eventBySpanId = buildChronologyEventBySpanId(input.chronologyEvents);
  const placedSpanById = new Map<string, IKtepSpan>();
  const clips: IKtepClip[] = [];
  const resolveClips: IResolveRoughCutClipInput[] = [];
  let cursorMs = 0;
  let clipIndex = 0;

  for (const segment of input.materialSlots.segments) {
    for (const slot of segment.slots) {
      for (const spanId of orderSlotSpanIds(slot.chosenSpanIds, spanById, assetById)) {
        const span = spanById.get(spanId);
        if (!span) throw new Error(`material slot references missing span: ${spanId}`);
        const asset = assetById.get(span.assetId);
        if (!asset) throw new Error(`span ${span.id} references missing asset: ${span.assetId}`);
        if (asset.kind === 'audio') {
          throw new Error(`timeline.generate cannot place audio-only asset on the rough-cut video track: ${asset.id}`);
        }
        const treatment = slot.treatments[spanId];
        const photoStillDurationMs = asset.kind === 'photo' ? resolvePhotoStillDurationMs(input.cfg) : CPHOTO_DEFAULT_DURATION_MS;
        const window = resolveSpanSourceWindow(asset, span, photoStillDurationMs);
        if (!placedSpanById.has(span.id)) {
          placedSpanById.set(span.id, {
            ...span,
            sourceInMs: window.sourceInMs,
            sourceOutMs: window.sourceOutMs,
            editSourceInMs: window.sourceInMs,
            editSourceOutMs: window.sourceOutMs,
          });
        }
        const requestedSpeed = treatment.speed;
        const speed = 1;
        const durationMs = asset.kind === 'photo'
          ? photoStillDurationMs
          : Math.max(1, Math.round(window.sourceOutMs - window.sourceInMs));
        const clipId = `clip-${String(clipIndex + 1).padStart(5, '0')}`;
        if (asset.kind !== 'photo' && spanHasSpeechTruth(span) && treatment.audio <= -100) {
          throw new Error(
            `timeline.generate blocked muted speech span: clipId=${clipId} spanId=${span.id} assetId=${asset.id}`,
          );
        }
        const sourceAbsolutePath = resolveAssetLocalPath(asset, input.ingestRoots);
        if (!sourceAbsolutePath) {
          throw new Error(`Unable to resolve asset ${asset.id} (${asset.sourcePath}) from project media roots`);
        }
        const eventContext = resolveChronologyEventContext(eventBySpanId, span.id);
        const muteAudio = treatment.audio <= -100 || asset.kind === 'photo';
        const clip: IKtepClip = {
          id: clipId,
          trackId: 'v1',
          assetId: asset.id,
          spanId: span.id,
          sliceId: span.id,
          sourceInMs: window.sourceInMs,
          sourceOutMs: window.sourceOutMs,
          audioGainDb: treatment.audio,
          timelineInMs: cursorMs,
          timelineOutMs: cursorMs + durationMs,
          ...(muteAudio ? { muteAudio: true } : {}),
          linkedScriptSegmentId: segment.segmentId,
          linkedScriptBeatId: slot.id,
          pharosRefs: span.pharosRefs,
        };
        clips.push(clip);
        resolveClips.push({
          clipId,
          assetId: asset.id,
          spanId: span.id,
          rawRelativePath: buildResolveRoughCutRelativePath({
            eventFolder: eventContext.folder,
            clipId,
            sourceAbsolutePath,
          }),
          eventId: eventContext.id,
          eventTitle: eventContext.title,
          eventKind: eventContext.kind,
          assetKind: asset.kind,
          sourceAbsolutePath,
          sourceStem: resolveSourceStem(asset),
          fps: asset.fps ?? input.cfg.fps,
          sourceInMs: window.sourceInMs,
          sourceOutMs: window.sourceOutMs,
          timelineInMs: clip.timelineInMs,
          timelineOutMs: clip.timelineOutMs,
          audioGainDb: treatment.audio,
          muteAudio,
          speed,
          requestedSpeed,
        });
        cursorMs += durationMs;
        clipIndex += 1;
      }
    }
  }

  const timelineName = input.cfg.name || `Kairos Rough Cut - ${input.editId}`;
  const resolveProjectName = deriveResolveRoughCutProjectName(input.project.name, input.project.id);
  const placedSpans = [...placedSpanById.values()];
  return {
    timelineName,
    resolveProjectName,
    resolveClips,
    doc: {
      protocol: CPROTOCOL,
      version: CVERSION,
      project: input.project,
      assets: input.assets,
      spans: placedSpans,
      slices: placedSpans,
      timeline: {
        id: randomUUID(),
        name: timelineName,
        fps: input.cfg.fps,
        resolution: {
          width: input.cfg.width,
          height: input.cfg.height,
        },
        tracks: [
          {
            id: 'v1',
            kind: 'video',
            role: 'primary',
            index: 1,
          },
        ],
        clips,
      },
      subtitles: [],
      adapterHints: {
        kind: 'resolve-rough-cut-manifest',
        editId: input.editId,
        materialSlotsId: input.materialSlots.id,
        generatedBy: 'timeline.generate:deterministic',
      },
    },
  };
}

function buildResolveMediaSyncClips(input: {
  assets: IKtepAsset[];
  spans: IKtepSpan[];
  chronologyEvents: IChronologyEvent[];
  ingestRoots: Awaited<ReturnType<typeof loadIngestRoots>>['roots'];
}): IResolvedResolveMediaClip[] {
  const assetById = new Map(input.assets.map(asset => [asset.id, asset] as const));
  const spanById = new Map(input.spans.map(span => [span.id, span] as const));
  const seenSourcePaths = new Set<string>();
  const clips: IResolvedResolveMediaClip[] = [];
  input.chronologyEvents.forEach((event, index) => {
    const title = event.title.trim() || event.id;
    const eventFolder = `${String(index + 1).padStart(3, '0')}-${sanitizeResolvePathSegment(title)}`;
    for (const spanId of event.spanIds) {
      const span = spanById.get(spanId);
      if (!span) continue;
      const asset = assetById.get(span.assetId);
      if (!asset || asset.kind === 'audio') continue;
      const sourceAbsolutePath = resolveAssetLocalPath(asset, input.ingestRoots);
      if (!sourceAbsolutePath) {
        throw new Error(`Unable to resolve asset ${asset.id} (${asset.sourcePath}) from project media roots`);
      }
      const normalizedPath = sourceAbsolutePath.replace(/\\/gu, '/');
      if (seenSourcePaths.has(normalizedPath)) continue;
      seenSourcePaths.add(normalizedPath);
      clips.push({
        assetId: asset.id,
        rawRelativePath: buildResolveRoughCutRelativePath({
          eventFolder,
          clipId: asset.id,
          sourceAbsolutePath,
        }),
        eventId: event.id,
        eventTitle: title,
        eventKind: event.kind,
        assetKind: asset.kind,
        sourceAbsolutePath,
        sourceStem: resolveSourceStem(asset),
      });
    }
  });
  return clips;
}

function orderSlotSpanIds(
  spanIds: string[],
  spanById: Map<string, IKtepSpan>,
  assetById: Map<string, IKtepAsset>,
): string[] {
  return spanIds
    .map((spanId, index) => ({ spanId, index }))
    .sort((left, right) => {
      const leftSpan = spanById.get(left.spanId);
      const rightSpan = spanById.get(right.spanId);
      if (!leftSpan || !rightSpan || leftSpan.assetId !== rightSpan.assetId) {
        return left.index - right.index;
      }
      const asset = assetById.get(leftSpan.assetId);
      if (!asset) return left.index - right.index;
      const leftWindow = resolveSpanSourceWindow(asset, leftSpan);
      const rightWindow = resolveSpanSourceWindow(asset, rightSpan);
      if (leftWindow.sourceInMs !== rightWindow.sourceInMs) {
        return leftWindow.sourceInMs - rightWindow.sourceInMs;
      }
      return left.index - right.index;
    })
    .map(item => item.spanId);
}

function resolvePhotoStillDurationMs(cfg: IBuildConfig): number {
  if (typeof cfg.stillDurationMs === 'number' && Number.isFinite(cfg.stillDurationMs) && cfg.stillDurationMs > 0) {
    return Math.round(cfg.stillDurationMs);
  }
  throw new Error('timeline.generate requires runtime config timelineStillDurationMs when placing photos; set it to match the Resolve still-image duration preference');
}

function buildChronologyEventBySpanId(events: IChronologyEvent[]): Map<string, {
  id: string;
  kind: string;
  title: string;
  folder: string;
}> {
  const result = new Map<string, {
    id: string;
    kind: string;
    title: string;
    folder: string;
  }>();
  events.forEach((event, index) => {
    const title = event.title.trim() || event.id;
    const folder = `${String(index + 1).padStart(3, '0')}-${sanitizeResolvePathSegment(title)}`;
    for (const spanId of event.spanIds) {
      if (!result.has(spanId)) {
        result.set(spanId, {
          id: event.id,
          kind: event.kind,
          title,
          folder,
        });
      }
    }
  });
  return result;
}

function resolveChronologyEventContext(
  eventBySpanId: Map<string, {
    id: string;
    kind: string;
    title: string;
    folder: string;
  }>,
  spanId: string,
): {
  id: string;
  kind: string;
  title: string;
  folder: string;
} {
  return eventBySpanId.get(spanId) ?? {
    id: 'unassigned',
    kind: 'unknown',
    title: '未归入事件',
    folder: '999-未归入事件',
  };
}

function buildResolveRoughCutRelativePath(input: {
  eventFolder: string;
  clipId: string;
  sourceAbsolutePath: string;
}): string {
  const filename = input.sourceAbsolutePath.replace(/\\/gu, '/').split('/').filter(Boolean).at(-1) ?? `${input.clipId}.mov`;
  return `${input.eventFolder}/${sanitizeResolvePathSegment(filename)}`;
}

function sanitizeResolvePathSegment(value: string): string {
  const normalized = value
    .replace(/[\\/:*?"<>|]+/gu, '-')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 80);
  return normalized || 'untitled';
}

function resolveSpanSourceWindow(
  asset: IKtepAsset,
  span: IKtepSpan,
  photoStillDurationMs = CPHOTO_DEFAULT_DURATION_MS,
): { sourceInMs: number; sourceOutMs: number } {
  const sourceInMs = firstFiniteNumber(span.editSourceInMs, span.sourceInMs, 0);
  const explicitSourceOutMs = firstFiniteNumber(span.editSourceOutMs, span.sourceOutMs);
  const sourceOutMs = asset.kind === 'photo' && (!Number.isFinite(explicitSourceOutMs) || explicitSourceOutMs <= sourceInMs)
    ? sourceInMs + photoStillDurationMs
    : explicitSourceOutMs;
  if (!Number.isFinite(sourceOutMs) || sourceOutMs <= sourceInMs) {
    throw new Error(`span ${span.id} does not have a valid source time range`);
  }
  return {
    sourceInMs,
    sourceOutMs,
  };
}

function firstFiniteNumber(...values: Array<number | undefined>): number {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
  }
  return Number.NaN;
}

function resolveSourceStem(asset: IKtepAsset): string {
  const normalized = asset.sourcePath.replace(/\\/gu, '/');
  const filename = normalized.split('/').filter(Boolean).at(-1) ?? asset.displayName ?? asset.id;
  return filename.replace(/\.[^.]+$/u, '') || asset.id;
}

function deriveResolveRoughCutProjectName(projectName?: string, projectId?: string): string {
  const base = (projectName?.trim() || projectId?.trim() || 'Kairos Project').slice(0, 100);
  return `${base} [Edit]`;
}

function deriveResolveRoughCutTimelineName(editId: string, editLabel?: string): string {
  const normalizedEditId = normalizeEditId(editId);
  const label = (editLabel?.trim() || (normalizedEditId === 'main' ? 'Main' : normalizedEditId)).slice(0, 100);
  return `${label} [${normalizedEditId}]`;
}
