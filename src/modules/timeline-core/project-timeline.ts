import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type {
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
  normalizeEditId,
  readJsonOrNull,
  writeJson,
} from '../../store/index.js';
import { resolveAssetLocalPath } from '../media/root-resolver.js';
import { assertConfirmedEditFlowPlan } from '../edit-flow/flow-planner.js';
import { assertMaterialSlotsContract } from '../edit-flow/material-slots-contract.js';
import { resolveTimelineBuildConfig, type IBuildConfig } from './timeline-builder.js';
import {
  createResolveRoughCutTimeline,
  type IResolveRoughCutTimelineResult,
  type IResolveRoughCutClipInput,
} from './resolve-rough-cut.js';

const CPHOTO_DEFAULT_DURATION_MS = 1000;

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

interface IDeterministicTimelineBuild {
  doc: IKtepDoc;
  resolveClips: IResolveRoughCutClipInput[];
  timelineName: string;
  resolveProjectName: string;
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
      requiredCapabilityIds: ['timeline.generate'],
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
    name: `Kairos Rough Cut - ${editId}`,
    chronology: chronology.assetIndex,
  });
  const build = buildDeterministicTimeline({
    project,
    editId,
    assets,
    spans: freshSpans.spans,
    materialSlots,
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
    namespace: `Kairos Edit ${editId}`,
    timelineSpec: {
      width: cfg.width,
      height: cfg.height,
      fps: cfg.fps,
    },
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
  cfg: IBuildConfig;
  ingestRoots: Awaited<ReturnType<typeof loadIngestRoots>>['roots'];
}): IDeterministicTimelineBuild {
  const assetById = new Map(input.assets.map(asset => [asset.id, asset] as const));
  const spanById = new Map(input.spans.map(span => [span.id, span] as const));
  const placedSpanById = new Map<string, IKtepSpan>();
  const clips: IKtepClip[] = [];
  const resolveClips: IResolveRoughCutClipInput[] = [];
  let cursorMs = 0;
  let clipIndex = 0;

  for (const segment of input.materialSlots.segments) {
    for (const slot of segment.slots) {
      for (const spanId of slot.chosenSpanIds) {
        const span = spanById.get(spanId);
        if (!span) throw new Error(`material slot references missing span: ${spanId}`);
        const asset = assetById.get(span.assetId);
        if (!asset) throw new Error(`span ${span.id} references missing asset: ${span.assetId}`);
        if (asset.kind === 'audio') {
          throw new Error(`timeline.generate cannot place audio-only asset on the rough-cut video track: ${asset.id}`);
        }
        const treatment = slot.treatments[spanId];
        const window = resolveSpanSourceWindow(asset, span);
        if (!placedSpanById.has(span.id)) {
          placedSpanById.set(span.id, {
            ...span,
            sourceInMs: window.sourceInMs,
            sourceOutMs: window.sourceOutMs,
            editSourceInMs: window.sourceInMs,
            editSourceOutMs: window.sourceOutMs,
          });
        }
        const speed = treatment.speed;
        const durationMs = asset.kind === 'photo'
          ? CPHOTO_DEFAULT_DURATION_MS
          : Math.max(1, Math.round((window.sourceOutMs - window.sourceInMs) / speed));
        const clipId = `clip-${String(clipIndex + 1).padStart(5, '0')}`;
        const sourceAbsolutePath = resolveAssetLocalPath(asset, input.ingestRoots);
        if (!sourceAbsolutePath) {
          throw new Error(`Unable to resolve asset ${asset.id} (${asset.sourcePath}) from project media roots`);
        }
        const muteAudio = treatment.audio <= -100 || asset.kind === 'photo';
        const clip: IKtepClip = {
          id: clipId,
          trackId: 'v1',
          assetId: asset.id,
          spanId: span.id,
          sliceId: span.id,
          sourceInMs: window.sourceInMs,
          sourceOutMs: window.sourceOutMs,
          ...(speed > 1 ? { speed } : {}),
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

function resolveSpanSourceWindow(asset: IKtepAsset, span: IKtepSpan): { sourceInMs: number; sourceOutMs: number } {
  const sourceInMs = firstFiniteNumber(span.editSourceInMs, span.sourceInMs, 0);
  const explicitSourceOutMs = firstFiniteNumber(span.editSourceOutMs, span.sourceOutMs);
  const sourceOutMs = asset.kind === 'photo' && (!Number.isFinite(explicitSourceOutMs) || explicitSourceOutMs <= sourceInMs)
    ? sourceInMs + CPHOTO_DEFAULT_DURATION_MS
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
