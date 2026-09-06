import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import type {
  IChronologyEvent,
  IKtepAsset,
  IKtepClip,
  IKtepDoc,
  IKtepProject,
  IKtepSpan,
  IKtepSubtitle,
  ITranscriptSegment,
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
  getTimelineRemainingPath,
  getTimelineRemainingSrtPath,
  getTimelineSubtitleSrtPath,
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
import {
  assertMaterialSlotsContract,
  spanHasSpeechTruth,
  spanRequiresSourceAudioProtection,
} from '../edit-flow/material-slots-contract.js';
import { resolveMaterialSlotTreatment } from '../edit-flow/material-slot-treatments.js';
import { exportSrt } from '../nle/export-srt.js';
import { estimateTranscriptTextUnits } from '../media/refined-transcript.js';
import { trimSpeechOverlappingVisualWindows } from '../media/window-policy.js';
import { resolveTimelineBuildConfig, type IBuildConfig } from './timeline-builder.js';
import {
  createResolveRoughCutTimeline,
  regenerateResolveRoughCutTimelineSuffix,
  syncResolveRoughCutMedia,
  type IResolveRoughCutMediaSyncResult,
  type IResolveRoughCutTimelineResult,
  type IResolveRoughCutClipInput,
} from './resolve-rough-cut.js';
import {
  deriveResolveRoughCutProjectName,
  deriveResolveRoughCutTimelineName,
} from './resolve-edit-naming.js';
import { snapshotProjectEditDrp } from './edit-resolve-snapshot.js';

const CPHOTO_DEFAULT_DURATION_MS = 1000;
const CSPEECH_SOURCE_HEAD_HANDLE_MS = 250;
const CSPEECH_SOURCE_TAIL_HANDLE_MS = 250;
const CRESOLVE_PROJECT_MEDIA_NAMESPACE = 'Kairos Project Media';
const CRESOLVE_TIMELINE_FOLDER_NAME = 'Kairos Timelines';
const SOURCE_SPEECH_CUE_MAX_TEXT_UNITS = 36;

export interface IBuildProjectTimelineInput {
  projectRoot: string;
  editId?: string;
  workspaceRoot?: string;
  editRuleCategory?: string;
  config?: Partial<IBuildConfig>;
  timelineNameOverride?: string;
  writeTimelineArtifacts?: boolean;
  skipDrpSnapshot?: boolean;
  mode?: 'replace' | 'resume-from-current-playhead';
  resumeExpectedAnchorClipId?: string;
}

export interface IBuildProjectTimelineResult {
  doc: IKtepDoc;
  resolveTimeline: IResolveRoughCutTimelineResult;
  subtitleSrtPath: string;
  subtitleCueCount: number;
  mode: 'replace' | 'resume-from-current-playhead';
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

export interface IDeterministicTimelineBuild {
  doc: IKtepDoc;
  resolveClips: IResolveRoughCutClipInput[];
  timelineName: string;
  resolveProjectName: string;
}

export interface IResolveTimelinePlacementReconciliation {
  build: IDeterministicTimelineBuild;
  plannedDurationMs: number;
  actualDurationMs: number;
  durationDeltaMs: number;
}

interface IResolveHostClipPlacement {
  clipId: string;
  actualStartFrame: number;
  actualEndFrame: number;
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

interface ISourceWindow {
  sourceInMs: number;
  sourceOutMs: number;
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
  await assertResolveMediaSyncSourceFilesExist(clips);
  const resolveMedia = await syncResolveRoughCutMedia({
    projectId: project.id,
    resolveProjectName,
    namespace: CRESOLVE_PROJECT_MEDIA_NAMESPACE,
    legacyNamespaces: [`Kairos Edit ${editId}`],
    clips,
  });
  return {
    resolveProjectName,
    resolveMedia,
    hostSummary: resolveMedia.hostSummary,
  };
}

async function assertResolveMediaSyncSourceFilesExist(clips: IResolvedResolveMediaClip[]): Promise<void> {
  const missing: IResolvedResolveMediaClip[] = [];
  await Promise.all(clips.map(async clip => {
    try {
      await access(clip.sourceAbsolutePath, constants.R_OK);
    } catch {
      missing.push(clip);
    }
  }));
  if (missing.length === 0) return;
  const examples = missing
    .slice(0, 8)
    .map(clip => `${clip.assetId} (${clip.sourceAbsolutePath})`)
    .join(', ');
  throw new Error(
    `resolve.media_sync blocked: ${missing.length} source file(s) are missing or unreadable before Resolve import. Missing examples: ${examples}`,
  );
}

export async function buildProjectTimeline(
  input: IBuildProjectTimelineInput,
): Promise<IBuildProjectTimelineResult> {
  const editId = normalizeEditId(input.editId);
  const mode = input.mode ?? 'replace';
  const resumeFromCurrentPlayhead = mode === 'resume-from-current-playhead';
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
  if (input.workspaceRoot && !resumeFromCurrentPlayhead) {
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

  const timelineName = input.timelineNameOverride?.trim()
    || input.config?.name?.trim()
    || deriveResolveRoughCutTimelineName(editId, scriptBriefConfig.editLabel);
  const cfg = resolveTimelineBuildConfig(runtimeConfig, {
    ...input.config,
    name: timelineName,
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
  assertValidTimelineDocument(build.doc, 'deterministic timeline');
  const subtitleSrtPath = resumeFromCurrentPlayhead
    ? getTimelineRemainingSrtPath(input.projectRoot, editId)
    : getTimelineSubtitleSrtPath(input.projectRoot, editId);

  let resolveTimeline = await (resumeFromCurrentPlayhead
    ? regenerateResolveRoughCutTimelineSuffix
    : createResolveRoughCutTimeline)({
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
    ...(resumeFromCurrentPlayhead && input.resumeExpectedAnchorClipId
      ? { resumeExpectedAnchorClipId: input.resumeExpectedAnchorClipId }
      : {}),
    clips: build.resolveClips,
  });
  const placementBuild = resumeFromCurrentPlayhead
    ? selectDeterministicTimelineSuffix(build, resolveTimeline)
    : build;
  const placement = rebaseDeterministicTimelineToResolvePlacements({
    build: placementBuild,
    resolveTimeline,
    fps: cfg.fps,
  });
  assertValidTimelineDocument(placement.build.doc, 'Resolve actual-frame timeline');
  const subtitleCues = buildTimelineSourceSpeechSubtitles({
    clips: placement.build.doc.timeline.clips,
    spans: placement.build.doc.spans,
    language: 'zh',
  });

  const writeTimelineArtifacts = input.writeTimelineArtifacts !== false;
  if (writeTimelineArtifacts) {
    await exportSrt(subtitleCues, subtitleSrtPath, { preserveTerminalPeriods: true });
  }
  if (!input.skipDrpSnapshot) {
    resolveTimeline = await attachEditDrpSnapshotToResolveTimeline({
      resolveTimeline,
      workspaceRoot: input.workspaceRoot,
      projectRoot: input.projectRoot,
      projectId: project.id,
      editId,
    });
  }
  const doc: IKtepDoc = {
    ...placement.build.doc,
    adapterHints: {
      ...placement.build.doc.adapterHints,
      resolveRoughCut: resolveTimeline,
      resolveActualFrameTiming: {
        policyVersion: 'resolve-actual-frame-v1',
        placementPasses: 1,
        plannedDurationMs: placement.plannedDurationMs,
        actualDurationMs: placement.actualDurationMs,
        durationDeltaMs: placement.durationDeltaMs,
        subtitlePreloaded: false,
      },
      sourceSpeechSrt: {
        path: subtitleSrtPath,
        cueCount: subtitleCues.length,
        generatedBy: resumeFromCurrentPlayhead
          ? 'timeline.generate:remaining-source-speech-srt'
          : 'timeline.generate:source-speech-srt',
      },
      timelineGenerationMode: mode,
    },
  };
  if (writeTimelineArtifacts) {
    await writeJson(
      resumeFromCurrentPlayhead
        ? getTimelineRemainingPath(input.projectRoot, editId)
        : getTimelineCurrentPath(input.projectRoot, editId),
      doc,
    );
  }

  return {
    doc,
    resolveTimeline,
    subtitleSrtPath,
    subtitleCueCount: subtitleCues.length,
    mode,
  };
}

export function selectDeterministicTimelineSuffix(
  build: IDeterministicTimelineBuild,
  resolveTimeline: IResolveRoughCutTimelineResult,
): IDeterministicTimelineBuild {
  const resume = (resolveTimeline.hostSummary as { resume?: { appendedClipIds?: unknown } } | undefined)?.resume;
  const appendedClipIds = Array.isArray(resume?.appendedClipIds)
    ? resume.appendedClipIds.filter((value): value is string => typeof value === 'string' && value.length > 0)
    : [];
  if (appendedClipIds.length === 0) {
    throw new Error('Resolve suffix regeneration returned no appended clip ids.');
  }
  const requested = new Set(appendedClipIds);
  const docClips = build.doc.timeline.clips.filter(clip => requested.has(clip.id));
  const resolveClips = build.resolveClips.filter(clip => requested.has(clip.clipId));
  if (docClips.length !== appendedClipIds.length || resolveClips.length !== appendedClipIds.length) {
    throw new Error(
      `Resolve suffix regeneration clip mapping mismatch: returned=${appendedClipIds.length} doc=${docClips.length} host=${resolveClips.length}`,
    );
  }
  const spanIds = new Set(docClips.map(clip => clip.spanId ?? clip.sliceId).filter((value): value is string => Boolean(value)));
  const spans = build.doc.spans.filter(span => spanIds.has(span.id));
  return {
    ...build,
    resolveClips,
    doc: {
      ...build.doc,
      spans,
      slices: spans,
      timeline: {
        ...build.doc.timeline,
        clips: docClips,
      },
    },
  };
}

function assertValidTimelineDocument(doc: IKtepDoc, label: string): void {
  const validation = validateKtepDoc(doc);
  if (validation.ok) return;
  const message = validation.errors.map(error => `[${error.rule}] ${error.message}`).join('\n');
  throw new Error(`${label} validation failed:\n${message}`);
}

export function rebaseDeterministicTimelineToResolvePlacements(input: {
  build: IDeterministicTimelineBuild;
  resolveTimeline: IResolveRoughCutTimelineResult;
  fps: number;
}): IResolveTimelinePlacementReconciliation {
  if (!Number.isFinite(input.fps) || input.fps <= 0) {
    throw new Error(`Resolve actual-frame reconciliation requires a positive fps, received ${input.fps}`);
  }
  const placements = readResolveHostClipPlacements(input.resolveTimeline);
  const plannedClips = input.build.doc.timeline.clips;
  if (placements.length !== plannedClips.length) {
    throw new Error(
      `Resolve actual-frame reconciliation clip count mismatch: planned=${plannedClips.length} actual=${placements.length}`,
    );
  }
  const placementByClipId = new Map(placements.map(placement => [placement.clipId, placement] as const));
  const actualClips = plannedClips.map(clip => {
    const placement = placementByClipId.get(clip.id);
    if (!placement) {
      throw new Error(`Resolve actual-frame reconciliation missing clip placement: ${clip.id}`);
    }
    return {
      ...clip,
      timelineInMs: timelineFrameToMs(placement.actualStartFrame, input.fps),
      timelineOutMs: timelineFrameToMs(placement.actualEndFrame, input.fps),
    };
  });
  const resolveClips = input.build.resolveClips.map(clip => {
    const placement = placementByClipId.get(clip.clipId);
    if (!placement) {
      throw new Error(`Resolve actual-frame reconciliation missing host clip request: ${clip.clipId}`);
    }
    return {
      ...clip,
      timelineInMs: timelineFrameToMs(placement.actualStartFrame, input.fps),
      timelineOutMs: timelineFrameToMs(placement.actualEndFrame, input.fps),
    };
  });
  const plannedDurationMs = plannedClips.at(-1)?.timelineOutMs ?? 0;
  const actualDurationMs = actualClips.at(-1)?.timelineOutMs ?? 0;
  return {
    build: {
      ...input.build,
      resolveClips,
      doc: {
        ...input.build.doc,
        timeline: {
          ...input.build.doc.timeline,
          clips: actualClips,
        },
      },
    },
    plannedDurationMs,
    actualDurationMs,
    durationDeltaMs: actualDurationMs - plannedDurationMs,
  };
}

function readResolveHostClipPlacements(resolveTimeline: IResolveRoughCutTimelineResult): IResolveHostClipPlacement[] {
  const raw = resolveTimeline.hostSummary?.clips;
  if (!Array.isArray(raw)) {
    throw new Error('Resolve actual-frame reconciliation requires hostSummary.clips');
  }
  const seen = new Set<string>();
  return raw.map((value, index) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`Resolve host clip placement ${index} is not an object`);
    }
    const row = value as Record<string, unknown>;
    const clipId = typeof row.clipId === 'string' ? row.clipId.trim() : '';
    const actualStartFrame = readFiniteInteger(row.actualStartFrame);
    const actualEndFrame = readFiniteInteger(row.actualEndFrame);
    if (!clipId || actualStartFrame === undefined || actualEndFrame === undefined || actualEndFrame <= actualStartFrame) {
      throw new Error(`Resolve host clip placement ${index} is invalid`);
    }
    if (seen.has(clipId)) {
      throw new Error(`Resolve host clip placement contains duplicate clipId: ${clipId}`);
    }
    seen.add(clipId);
    return { clipId, actualStartFrame, actualEndFrame };
  });
}

function readFiniteInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value)
    ? value
    : undefined;
}

export async function attachEditDrpSnapshotToResolveTimeline(input: {
  resolveTimeline: IResolveRoughCutTimelineResult;
  workspaceRoot?: string;
  projectRoot: string;
  projectId: string;
  editId: string;
  snapshotter?: typeof snapshotProjectEditDrp;
}): Promise<IResolveRoughCutTimelineResult> {
  try {
    const drp = await (input.snapshotter ?? snapshotProjectEditDrp)({
      workspaceRoot: input.workspaceRoot,
      projectRoot: input.projectRoot,
      projectId: input.projectId,
      editId: input.editId,
      snapshotLabel: `timeline-generate-${input.editId}-complete`,
      mode: 'auto',
      action: 'timeline.generate',
    });
    return {
      ...input.resolveTimeline,
      drpSnapshot: drp.snapshot,
    };
  } catch (error) {
    return {
      ...input.resolveTimeline,
      drpSnapshotWarning: error instanceof Error ? error.message : String(error),
    };
  }
}

export function buildDeterministicTimeline(input: {
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
  const selectedSpeechRangesByAsset = collectSelectedSpeechRangesByAsset({
    materialSlots: input.materialSlots,
    spanById,
    assetById,
  });
  const placedSpanById = new Map<string, IKtepSpan>();
  const clips: IKtepClip[] = [];
  const resolveClips: IResolveRoughCutClipInput[] = [];
  let cursorFrame = 0;
  let planClipIndex = 0;

  for (const segment of input.materialSlots.segments) {
    for (const slot of segment.slots) {
      for (const spanId of orderSlotSpanIds(slot.chosenSpanIds, spanById, assetById, eventBySpanId)) {
        const span = spanById.get(spanId);
        if (!span) throw new Error(`material slot references missing span: ${spanId}`);
        const asset = assetById.get(span.assetId);
        if (!asset) throw new Error(`span ${span.id} references missing asset: ${span.assetId}`);
        if (asset.kind === 'audio') {
          throw new Error(`timeline.generate cannot place audio-only asset on the rough-cut video track: ${asset.id}`);
        }
        const baseClipId = `clip-${String(planClipIndex + 1).padStart(5, '0')}`;
        planClipIndex += 1;
        const photoStillDurationMs = asset.kind === 'photo' ? resolvePhotoStillDurationMs(input.cfg) : CPHOTO_DEFAULT_DURATION_MS;
        const treatment = resolveMaterialSlotTreatment(slot.treatments[spanId]);
        const forceDisableAerialAudio = shouldForceDisableAerialAudio(asset, span);
        const effectiveAudioGainDb = forceDisableAerialAudio ? -100 : treatment.audio;
        const shouldApplySpeechHandles = asset.kind !== 'photo'
          && effectiveAudioGainDb > -100
          && spanRequiresSourceAudioProtection(span);
        const sourceWindow = resolveSpanSourceWindow(asset, span, photoStillDurationMs, {
          applySpeechHandles: shouldApplySpeechHandles,
        });
        const plannedWindows = resolveSpeechOverlapCompatibleSourceWindows({
          asset,
          span,
          sourceWindow,
          speechRanges: selectedSpeechRangesByAsset.get(asset.id) ?? [],
        });
        const requestedSpeed = treatment.speed;
        const speed = 1;
        if (asset.kind !== 'photo' && spanRequiresSourceAudioProtection(span) && effectiveAudioGainDb <= -100) {
          throw new Error(
            `timeline.generate blocked muted speech span: clipId=${baseClipId} spanId=${span.id} assetId=${asset.id}`,
          );
        }
        const sourceAbsolutePath = resolveAssetLocalPath(asset, input.ingestRoots);
        if (!sourceAbsolutePath) {
          throw new Error(`Unable to resolve asset ${asset.id} (${asset.sourcePath}) from project media roots`);
        }
        const eventContext = resolveChronologyEventContext(eventBySpanId, span.id);
        const muteAudio = effectiveAudioGainDb <= -100 || asset.kind === 'photo';
        for (const [windowIndex, window] of plannedWindows.entries()) {
          if (!placedSpanById.has(span.id)) {
            const placedWindow = plannedWindows.length > 1 ? sourceWindow : window;
            placedSpanById.set(span.id, {
              ...span,
              sourceInMs: placedWindow.sourceInMs,
              sourceOutMs: placedWindow.sourceOutMs,
              editSourceInMs: placedWindow.sourceInMs,
              editSourceOutMs: placedWindow.sourceOutMs,
            });
          }
          const durationMs = asset.kind === 'photo'
            ? photoStillDurationMs
            : Math.max(1, Math.round(window.sourceOutMs - window.sourceInMs));
          const durationFrames = Math.max(1, msToTimelineFrame(durationMs, input.cfg.fps));
          const timelineInMs = timelineFrameToMs(cursorFrame, input.cfg.fps);
          const timelineOutMs = timelineFrameToMs(cursorFrame + durationFrames, input.cfg.fps);
          const clipId = plannedWindows.length === 1
            ? baseClipId
            : `${baseClipId}-r${String(windowIndex + 1).padStart(2, '0')}`;
          const clip: IKtepClip = {
            id: clipId,
            trackId: 'v1',
            assetId: asset.id,
            spanId: span.id,
            sliceId: span.id,
            sourceInMs: window.sourceInMs,
            sourceOutMs: window.sourceOutMs,
            audioGainDb: effectiveAudioGainDb,
            timelineInMs,
            timelineOutMs,
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
            spanType: span.type,
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
            audioGainDb: effectiveAudioGainDb,
            muteAudio,
            speed,
            requestedSpeed,
          });
          cursorFrame += durationFrames;
        }
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

function collectSelectedSpeechRangesByAsset(input: {
  materialSlots: IMaterialSlotsDocument;
  spanById: Map<string, IKtepSpan>;
  assetById: Map<string, IKtepAsset>;
}): Map<string, ISourceWindow[]> {
  const result = new Map<string, ISourceWindow[]>();
  const seenSpanIds = new Set<string>();

  for (const segment of input.materialSlots.segments) {
    for (const slot of segment.slots) {
      for (const spanId of slot.chosenSpanIds) {
        if (seenSpanIds.has(spanId)) continue;
        seenSpanIds.add(spanId);
        const span = input.spanById.get(spanId);
        if (!span) continue;
        const asset = input.assetById.get(span.assetId);
        if (!asset || asset.kind === 'photo' || asset.kind === 'audio') continue;
        if (!spanRequiresSourceAudioProtection(span) || shouldForceDisableAerialAudio(asset, span)) continue;
        const treatment = resolveMaterialSlotTreatment(slot.treatments[spanId]);
        if (treatment.audio <= -100) continue;
        const range = resolveSpanSourceWindow(asset, span, CPHOTO_DEFAULT_DURATION_MS, {
          applySpeechHandles: true,
        });
        const ranges = result.get(asset.id) ?? [];
        ranges.push(range);
        result.set(asset.id, ranges);
      }
    }
  }

  return result;
}

function resolveSpeechOverlapCompatibleSourceWindows(input: {
  asset: IKtepAsset;
  span: IKtepSpan;
  sourceWindow: ISourceWindow;
  speechRanges: ISourceWindow[];
}): ISourceWindow[] {
  if (
    input.asset.kind !== 'video'
    || input.span.semanticKind !== 'visual'
    || input.speechRanges.length === 0
  ) {
    return [input.sourceWindow];
  }

  const assetDurationMs = input.asset.durationMs
    ?? Math.max(
      input.sourceWindow.sourceOutMs,
      ...input.speechRanges.map(range => range.sourceOutMs),
    );
  const windows = trimSpeechOverlappingVisualWindows({
    assetDurationMs,
    clipType: input.span.type === 'shot' || input.span.type === 'photo'
      ? 'broll'
      : input.span.type,
    windows: [
      ...input.speechRanges.map(range => ({
        startMs: range.sourceInMs,
        endMs: range.sourceOutMs,
        editStartMs: range.sourceInMs,
        editEndMs: range.sourceOutMs,
        semanticKind: 'speech' as const,
        reason: 'speech-window',
      })),
      {
        startMs: input.sourceWindow.sourceInMs,
        endMs: input.sourceWindow.sourceOutMs,
        editStartMs: input.sourceWindow.sourceInMs,
        editEndMs: input.sourceWindow.sourceOutMs,
        semanticKind: 'visual' as const,
        reason: 'timeline-legacy-visual',
      },
    ],
  });

  return windows
    .filter(window => window.semanticKind === 'visual')
    .map(window => ({
      sourceInMs: window.editStartMs ?? window.startMs,
      sourceOutMs: window.editEndMs ?? window.endMs,
    }));
}

export function buildTimelineSourceSpeechSubtitles(input: {
  clips: IKtepClip[];
  spans: IKtepSpan[];
  language?: string;
}): IKtepSubtitle[] {
  const spanById = new Map(input.spans.map(span => [span.id, span] as const));
  const cues: Array<Omit<IKtepSubtitle, 'id'>> = [];
  const clips = [...input.clips].sort((left, right) => (
    left.timelineInMs - right.timelineInMs || left.id.localeCompare(right.id)
  ));

  for (const clip of clips) {
    if (isClipAudioMuted(clip)) continue;
    const spanId = clip.spanId ?? clip.sliceId;
    if (!spanId) continue;
    const span = spanById.get(spanId);
    if (!span || !spanHasSpeechTruth(span)) continue;

    const sourceInMs = firstFiniteNumber(clip.sourceInMs, span.editSourceInMs, span.sourceInMs);
    const sourceOutMs = firstFiniteNumber(clip.sourceOutMs, span.editSourceOutMs, span.sourceOutMs);
    if (!Number.isFinite(sourceInMs) || !Number.isFinite(sourceOutMs) || sourceOutMs <= sourceInMs) {
      continue;
    }
    if (!Number.isFinite(clip.timelineInMs) || !Number.isFinite(clip.timelineOutMs) || clip.timelineOutMs <= clip.timelineInMs) {
      continue;
    }

    const speed = resolveSubtitleClipSpeed(clip);
    const segments = resolveSubtitleTranscriptSegments(span)
      .filter(segment => normalizeSubtitleText(segment.text))
      .sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs);

    const clipCues: Array<Omit<IKtepSubtitle, 'id'>> = [];
    if (segments.length > 0) {
      for (const segment of segments) {
        const segmentStartMs = Math.max(segment.startMs, sourceInMs);
        const segmentEndMs = Math.min(segment.endMs, sourceOutMs);
        const text = normalizeSubtitleText(segment.text);
        if (!text || segmentEndMs <= segmentStartMs) continue;
        const startMs = mapSourceMsToTimelineMs(segmentStartMs, {
          sourceInMs,
          timelineInMs: clip.timelineInMs,
          timelineOutMs: clip.timelineOutMs,
          speed,
        });
        const endMs = mapSourceMsToTimelineMs(segmentEndMs, {
          sourceInMs,
          timelineInMs: clip.timelineInMs,
          timelineOutMs: clip.timelineOutMs,
          speed,
        });
        if (endMs <= startMs) continue;
        clipCues.push(...splitSourceSpeechDisplayCue({
          startMs,
          endMs,
          text,
          language: input.language,
          linkedScriptSegmentId: clip.linkedScriptSegmentId,
          linkedScriptBeatId: clip.linkedScriptBeatId,
        }));
      }
    } else {
      const transcript = normalizeSubtitleText(span.transcript);
      if (!transcript) continue;
      clipCues.push(...splitSourceSpeechDisplayCue({
        startMs: Math.round(clip.timelineInMs),
        endMs: Math.round(clip.timelineOutMs),
        text: transcript,
        language: input.language,
        linkedScriptSegmentId: clip.linkedScriptSegmentId,
        linkedScriptBeatId: clip.linkedScriptBeatId,
      }));
    }
    cues.push(...mergeAdjacentSourceSpeechCues(clipCues));
  }

  return cues.map((cue, index) => ({
    id: `subtitle-source-speech-${String(index + 1).padStart(5, '0')}`,
    ...cue,
  }));
}

function splitSourceSpeechDisplayCue(
  cue: Omit<IKtepSubtitle, 'id'>,
): Array<Omit<IKtepSubtitle, 'id'>> {
  const normalized = normalizeSubtitleText(cue.text);
  if (!normalized || cue.endMs <= cue.startMs) return [];
  const chunks = splitSourceSpeechCueText(normalized)
    .map(normalizeSubtitleText)
    .filter(Boolean);
  if (chunks.length === 0) return [];
  for (const chunk of chunks) {
    const units = estimateTranscriptTextUnits(chunk);
    if (units > SOURCE_SPEECH_CUE_MAX_TEXT_UNITS) {
      throw new Error(
        `source-speech subtitle cue exceeds ${SOURCE_SPEECH_CUE_MAX_TEXT_UNITS} text units after display split: ${chunk}`,
      );
    }
  }
  if (chunks.length === 1) return [{ ...cue, text: chunks[0]! }];

  const durationMs = Math.round(cue.endMs) - Math.round(cue.startMs);
  if (durationMs < chunks.length) {
    throw new Error(`source-speech subtitle interval is too short for ${chunks.length} display cues`);
  }
  const weights = chunks.map(chunk => Math.max(1, estimateTranscriptTextUnits(chunk)));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  const endMs = Math.round(cue.endMs);
  let cursorMs = Math.round(cue.startMs);
  let cumulativeWeight = 0;
  return chunks.map((text, index) => {
    cumulativeWeight += weights[index] ?? 0;
    const remainingCueCount = chunks.length - index - 1;
    const proposedEndMs = index === chunks.length - 1
      ? endMs
      : Math.round(cue.startMs + (((cue.endMs - cue.startMs) * cumulativeWeight) / totalWeight));
    const chunkEndMs = index === chunks.length - 1
      ? endMs
      : clampNumber(proposedEndMs, cursorMs + 1, endMs - remainingCueCount);
    const result = {
      ...cue,
      startMs: cursorMs,
      endMs: chunkEndMs,
      text,
    };
    cursorMs = chunkEndMs;
    return result;
  });
}

function mergeAdjacentSourceSpeechCues(
  cues: Array<Omit<IKtepSubtitle, 'id'>>,
): Array<Omit<IKtepSubtitle, 'id'>> {
  const merged: Array<Omit<IKtepSubtitle, 'id'>> = [];
  for (const cue of cues) {
    const previous = merged.at(-1);
    const gapMs = previous ? cue.startMs - previous.endMs : Number.POSITIVE_INFINITY;
    const combinedText = previous ? `${previous.text}${cue.text}` : cue.text;
    if (
      previous
      && gapMs >= 0
      && gapMs < 1500
      && estimateTranscriptTextUnits(combinedText) <= SOURCE_SPEECH_CUE_MAX_TEXT_UNITS
    ) {
      previous.endMs = cue.endMs;
      previous.text = combinedText;
      continue;
    }
    merged.push({ ...cue });
  }
  return merged.map(cue => ({
    ...cue,
    text: promoteTerminalSoftComma(cue.text),
  }));
}

function promoteTerminalSoftComma(text: string): string {
  return text.replace(/[，,]+(["')\]}>」』”’）】〉》]*)$/u, '。$1');
}

function splitSourceSpeechCueText(text: string): string[] {
  return splitAtHardPunctuation(text)
    .flatMap(unit => splitLongUnitAtBalancedCommas(unit, SOURCE_SPEECH_CUE_MAX_TEXT_UNITS));
}

function splitAtHardPunctuation(text: string): string[] {
  const characters = Array.from(text);
  const units: string[] = [];
  let buffer = '';
  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index]!;
    buffer += character;
    if (!isHardSubtitlePunctuation(character)) continue;
    while (index + 1 < characters.length && /^\p{P}$/u.test(characters[index + 1]!)) {
      index += 1;
      buffer += characters[index]!;
    }
    if (buffer.trim()) units.push(buffer.trim());
    buffer = '';
  }
  if (buffer.trim()) units.push(buffer.trim());
  return units;
}

function splitLongUnitAtBalancedCommas(text: string, maxTextUnits: number): string[] {
  if (estimateTranscriptTextUnits(text) <= maxTextUnits) return [text];
  const clauses = splitAtSoftCommas(text)
    .flatMap(clause => hardSplitOversizedClause(clause, maxTextUnits));
  if (clauses.length <= 1) return clauses;
  const weights = clauses.map(clause => Math.max(1, estimateTranscriptTextUnits(clause)));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  const minimumGroups = Math.ceil(totalWeight / maxTextUnits);
  let groups: Array<{ start: number; end: number }> | null = null;
  for (let groupCount = minimumGroups; groupCount <= clauses.length; groupCount += 1) {
    groups = selectBalancedClauseGroups(weights, maxTextUnits, groupCount);
    if (groups) break;
  }
  if (!groups) {
    throw new Error(`unable to split source-speech subtitle within ${maxTextUnits} text units: ${text}`);
  }
  return groups.map((group, index) => {
    const joined = clauses.slice(group.start, group.end).join('').trim();
    return index < groups!.length - 1
      ? joined.replace(/[，,]+$/u, '。')
      : joined;
  });
}

function splitAtSoftCommas(text: string): string[] {
  const clauses: string[] = [];
  let buffer = '';
  for (const character of Array.from(text)) {
    buffer += character;
    if (!/[，,]/u.test(character)) continue;
    if (buffer.trim()) clauses.push(buffer.trim());
    buffer = '';
  }
  if (buffer.trim()) clauses.push(buffer.trim());
  return clauses;
}

function hardSplitOversizedClause(text: string, maxTextUnits: number): string[] {
  if (estimateTranscriptTextUnits(text) <= maxTextUnits) return [text];
  const chunks: string[] = [];
  let buffer = '';
  for (const character of Array.from(text)) {
    const candidate = `${buffer}${character}`;
    if (buffer && estimateTranscriptTextUnits(candidate) > maxTextUnits) {
      chunks.push(buffer.trim());
      buffer = character;
    } else {
      buffer = candidate;
    }
  }
  if (buffer.trim()) chunks.push(buffer.trim());
  return chunks;
}

function selectBalancedClauseGroups(
  weights: number[],
  maxTextUnits: number,
  groupCount: number,
): Array<{ start: number; end: number }> | null {
  const prefix = [0];
  for (const weight of weights) prefix.push(prefix[prefix.length - 1]! + weight);
  const target = prefix[prefix.length - 1]! / groupCount;
  const memo = new Map<string, { score: number; groups: Array<{ start: number; end: number }> } | null>();
  const visit = (
    start: number,
    remainingGroups: number,
  ): { score: number; groups: Array<{ start: number; end: number }> } | null => {
    const key = `${start}:${remainingGroups}`;
    if (memo.has(key)) return memo.get(key)!;
    if (remainingGroups === 1) {
      const weight = prefix[weights.length]! - prefix[start]!;
      const result = weight > 0 && weight <= maxTextUnits
        ? { score: (weight - target) ** 2, groups: [{ start, end: weights.length }] }
        : null;
      memo.set(key, result);
      return result;
    }
    let best: { score: number; groups: Array<{ start: number; end: number }> } | null = null;
    const latestEnd = weights.length - remainingGroups + 1;
    for (let end = start + 1; end <= latestEnd; end += 1) {
      const weight = prefix[end]! - prefix[start]!;
      if (weight > maxTextUnits) break;
      const tail = visit(end, remainingGroups - 1);
      if (!tail) continue;
      const score = (weight - target) ** 2 + tail.score;
      if (!best || score < best.score) {
        best = { score, groups: [{ start, end }, ...tail.groups] };
      }
    }
    memo.set(key, best);
    return best;
  };
  return visit(0, groupCount)?.groups ?? null;
}

function isHardSubtitlePunctuation(character: string): boolean {
  return /^\p{P}$/u.test(character) && !/[，,]/u.test(character);
}

function isClipAudioMuted(clip: IKtepClip): boolean {
  if (clip.muteAudio) return true;
  return typeof clip.audioGainDb === 'number'
    && Number.isFinite(clip.audioGainDb)
    && clip.audioGainDb <= -100;
}

function shouldForceDisableAerialAudio(asset: IKtepAsset, span: IKtepSpan): boolean {
  return asset.kind === 'video' && span.type === 'aerial';
}

function resolveSubtitleClipSpeed(clip: IKtepClip): number {
  if (typeof clip.speed === 'number' && Number.isFinite(clip.speed) && clip.speed > 0) {
    return clip.speed;
  }
  return 1;
}

function resolveSubtitleTranscriptSegments(span: IKtepSpan): ITranscriptSegment[] {
  return [...(span.transcriptSegments ?? [])];
}

function mapSourceMsToTimelineMs(sourceMs: number, input: {
  sourceInMs: number;
  timelineInMs: number;
  timelineOutMs: number;
  speed: number;
}): number {
  const timelineMs = input.timelineInMs + ((sourceMs - input.sourceInMs) / input.speed);
  return clampNumber(Math.round(timelineMs), Math.round(input.timelineInMs), Math.round(input.timelineOutMs));
}

function normalizeSubtitleText(value: string | undefined): string {
  return (value ?? '').replace(/\s+/gu, ' ').trim();
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
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
  eventBySpanId: Map<string, {
    id: string;
    kind: string;
    title: string;
    folder: string;
  }> = new Map(),
): string[] {
  const groups: Array<{ eventId: string; items: Array<{ spanId: string; index: number }> }> = [];
  const groupByEventId = new Map<string, { eventId: string; items: Array<{ spanId: string; index: number }> }>();

  spanIds.forEach((spanId, index) => {
    const event = eventBySpanId.get(spanId);
    const eventId = event?.id ?? `__ungrouped:${index}`;
    let group = groupByEventId.get(eventId);
    if (!group) {
      group = { eventId, items: [] };
      groupByEventId.set(eventId, group);
      groups.push(group);
    }
    group.items.push({ spanId, index });
  });

  return groups.flatMap(group => {
    const nonPhotoItems = group.items.filter(item => !isPhotoSlotItem(item.spanId, spanById, assetById));
    const photoItems = group.items.filter(item => isPhotoSlotItem(item.spanId, spanById, assetById));
    return [
      ...orderSlotItemsBySource(nonPhotoItems, spanById, assetById),
      ...orderSlotItemsBySource(photoItems, spanById, assetById),
    ].map(item => item.spanId);
  });
}

function orderSlotItemsBySource(
  items: Array<{ spanId: string; index: number }>,
  spanById: Map<string, IKtepSpan>,
  assetById: Map<string, IKtepAsset>,
): Array<{ spanId: string; index: number }> {
  return [...items].sort((left, right) => {
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
  });
}

function isPhotoSlotItem(
  spanId: string,
  spanById: Map<string, IKtepSpan>,
  assetById: Map<string, IKtepAsset>,
): boolean {
  const span = spanById.get(spanId);
  if (!span) return false;
  const asset = assetById.get(span.assetId);
  return span.type === 'photo' || asset?.kind === 'photo';
}

function resolvePhotoStillDurationMs(cfg: IBuildConfig): number {
  if (typeof cfg.stillDurationMs === 'number' && Number.isFinite(cfg.stillDurationMs) && cfg.stillDurationMs > 0) {
    return Math.round(cfg.stillDurationMs);
  }
  return CPHOTO_DEFAULT_DURATION_MS;
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
  options: { applySpeechHandles?: boolean } = {},
): { sourceInMs: number; sourceOutMs: number } {
  const sourceInMs = firstFiniteNumber(span.editSourceInMs, span.sourceInMs, 0);
  const explicitSourceOutMs = firstFiniteNumber(span.editSourceOutMs, span.sourceOutMs);
  const sourceOutMs = asset.kind === 'photo' && (!Number.isFinite(explicitSourceOutMs) || explicitSourceOutMs <= sourceInMs)
    ? sourceInMs + photoStillDurationMs
    : explicitSourceOutMs;
  if (!Number.isFinite(sourceOutMs) || sourceOutMs <= sourceInMs) {
    throw new Error(`span ${span.id} does not have a valid source time range`);
  }
  if (options.applySpeechHandles) {
    const speechCore = resolveAlignedSpeechCoreWindow(span)
      ?? resolveLegacyEffectiveSpeechCoreWindow(span)
      ?? resolveSpanCoreWindow(span)
      ?? { sourceInMs, sourceOutMs };
    return expandSourceWindowWithHandles({
      sourceInMs: speechCore.sourceInMs,
      sourceOutMs: speechCore.sourceOutMs,
      assetDurationMs: asset.durationMs,
      headHandleMs: CSPEECH_SOURCE_HEAD_HANDLE_MS,
      tailHandleMs: CSPEECH_SOURCE_TAIL_HANDLE_MS,
    });
  }
  return {
    sourceInMs,
    sourceOutMs,
  };
}

function resolveAlignedSpeechCoreWindow(span: IKtepSpan): { sourceInMs: number; sourceOutMs: number } | null {
  const segments = (span.transcriptSegments ?? []).filter(segment => (
    Number.isFinite(segment.startMs)
    && Number.isFinite(segment.endMs)
    && segment.startMs >= 0
    && segment.endMs > segment.startMs
    && segment.text.trim().length > 0
  ));
  if (segments.length === 0) return null;
  return {
    sourceInMs: Math.min(...segments.map(segment => segment.startMs)),
    sourceOutMs: Math.max(...segments.map(segment => segment.endMs)),
  };
}

function resolveLegacyEffectiveSpeechCoreWindow(span: IKtepSpan): { sourceInMs: number; sourceOutMs: number } | null {
  const sourceInMs = span.effectiveSpeechStartMs;
  const sourceOutMs = span.effectiveSpeechEndMs;
  if (
    typeof sourceInMs !== 'number'
    || typeof sourceOutMs !== 'number'
    || !Number.isFinite(sourceInMs)
    || !Number.isFinite(sourceOutMs)
    || sourceInMs < 0
    || sourceOutMs <= sourceInMs
  ) {
    return null;
  }
  return {
    sourceInMs,
    sourceOutMs,
  };
}

function resolveSpanCoreWindow(span: IKtepSpan): { sourceInMs: number; sourceOutMs: number } | null {
  const sourceInMs = span.sourceInMs;
  const sourceOutMs = span.sourceOutMs;
  if (
    typeof sourceInMs !== 'number'
    || typeof sourceOutMs !== 'number'
    || !Number.isFinite(sourceInMs)
    || !Number.isFinite(sourceOutMs)
    || sourceInMs < 0
    || sourceOutMs <= sourceInMs
  ) {
    return null;
  }
  return { sourceInMs, sourceOutMs };
}

function expandSourceWindowWithHandles(input: {
  sourceInMs: number;
  sourceOutMs: number;
  assetDurationMs?: number;
  headHandleMs: number;
  tailHandleMs: number;
}): { sourceInMs: number; sourceOutMs: number } {
  const sourceInMs = Math.max(0, input.sourceInMs - input.headHandleMs);
  const sourceOutLimit = typeof input.assetDurationMs === 'number' && Number.isFinite(input.assetDurationMs)
    ? Math.max(input.assetDurationMs, input.sourceOutMs)
    : Number.POSITIVE_INFINITY;
  const sourceOutMs = Math.min(sourceOutLimit, input.sourceOutMs + input.tailHandleMs);
  return {
    sourceInMs,
    sourceOutMs: Math.max(sourceOutMs, input.sourceOutMs),
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

function msToTimelineFrame(ms: number, fps: number): number {
  return Math.round((ms / 1000) * fps);
}

function timelineFrameToMs(frame: number, fps: number): number {
  return Math.round((frame / fps) * 1000);
}

function resolveSourceStem(asset: IKtepAsset): string {
  const normalized = asset.sourcePath.replace(/\\/gu, '/');
  const filename = normalized.split('/').filter(Boolean).at(-1) ?? asset.displayName ?? asset.id;
  return filename.replace(/\.[^.]+$/u, '') || asset.id;
}
