import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { EAssetKind, EClipType, EWindowSemantic, IAnalysisInput, IAssetCoarseReport, IMediaVersion,
  IInferredGps, IEmbeddedGpsBinding, type IKtepAsset, type IMediaRoot } from '../protocol/schema.js';
import { loadAssets } from './incremental.js';
import { loadIngestRoots } from './project.js';
import { readJsonOrNull, writeJson } from './writer.js';

export const COLOR_INPUTS_PROJECTION_VERSION = 'asset-color-inputs-v2' as const;
const ITimeRange = z.object({ startMs: z.number(), endMs: z.number() });
const ISpeechFacts = z.object({
  hasTranscript: z.boolean(),
  ranges: z.array(ITimeRange),
  coverage: z.number().optional(),
});
const IColorMediaVersion = IMediaVersion.omit({ sizeBytes: true, mtimeMs: true, ctimeMs: true }).strip();
const IColorMedia = z.object({
  kind: EAssetKind,
  ingestRootId: z.string().optional(),
  durationMs: z.number().optional(),
  capturedAt: z.string().optional(),
  // These are asset metadata, not a separate probe of the raw version.
  width: z.number().optional(), height: z.number().optional(),
  displayWidth: z.number().optional(), displayHeight: z.number().optional(),
  rotationDegrees: z.number().nullable().optional(),
  embeddedGps: IEmbeddedGpsBinding.pick({ originType: true, confidence: true, representativeTime: true,
    representativeLat: true, representativeLng: true }).optional(),
  versions: z.object({ raw: IColorMediaVersion.optional(), target: IColorMediaVersion.optional() }),
  rootColor: z.object({
    colorSpaceProfile: z.string().optional(), inputColorSpace: z.string().optional(), transformPresetKey: z.string().optional(),
  }).optional(),
});
const IColorFacts = z.object({
  type: EClipType,
  gps: IInferredGps.pick({ source: true, confidence: true, lat: true, lng: true, timezone: true }).optional(),
  summary: z.string().optional(),
  speech: ISpeechFacts,
  visualWindows: z.array(z.object({
    windowId: z.string(),
    sourceInMs: z.number().optional(), sourceOutMs: z.number().optional(),
    semanticKind: EWindowSemantic.optional(),
    visualObservation: z.string().optional(),
    speech: ISpeechFacts,
  })),
});
export const IColorInput = z.object({
  assetId: z.string(),
  media: IColorMedia,
  analysisInput: IAnalysisInput.optional(),
  analysisStatus: z.enum(['current', 'missing', 'stale', 'blocked', 'unversioned']),
  reasons: z.array(z.string()),
  facts: IColorFacts.optional(),
  sources: z.object({
    assetFingerprint: z.string(), reportFactsFingerprint: z.string().optional(), reportPath: z.string(),
  }),
  fingerprint: z.string(),
  updatedAt: z.string(),
});
export type IColorInput = z.infer<typeof IColorInput>;
export const IColorInputsStore = z.object({
  schemaVersion: z.literal(1),
  projectionVersion: z.literal(COLOR_INPUTS_PROJECTION_VERSION),
  updatedAt: z.string(),
  assets: z.record(IColorInput),
});
export type IColorInputsStore = z.infer<typeof IColorInputsStore>;

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
}
const fingerprint = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const metadataNumber = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined;

function projectMedia(asset: IKtepAsset, root?: IMediaRoot): IColorInput['media'] {
  return IColorMedia.parse({
    kind: asset.kind, ingestRootId: asset.ingestRootId, durationMs: asset.durationMs, capturedAt: asset.capturedAt,
    width: asset.width, height: asset.height,
    displayWidth: metadataNumber(asset.metadata?.displayWidth), displayHeight: metadataNumber(asset.metadata?.displayHeight),
    rotationDegrees: asset.metadata?.rotationDegrees === null ? null : metadataNumber(asset.metadata?.rotationDegrees),
    embeddedGps: asset.embeddedGps,
    versions: {
      raw: asset.mediaVersions?.raw && IColorMediaVersion.parse(asset.mediaVersions.raw),
      target: asset.mediaVersions?.target && IColorMediaVersion.parse(asset.mediaVersions.target),
    },
    rootColor: root?.color && { colorSpaceProfile: root.color.colorSpaceProfile,
      inputColorSpace: root.color.inputColorSpace, transformPresetKey: root.color.transformPresetKey },
  });
}

function projectSpeech(input: { transcript?: string; transcriptSegments?: Array<{ startMs: number; endMs: number }>; speechCoverage?: number }): z.infer<typeof ISpeechFacts> {
  return { hasTranscript: Boolean(input.transcript?.trim()),
    ranges: (input.transcriptSegments ?? []).map(({ startMs, endMs }) => ({ startMs, endMs })), coverage: input.speechCoverage };
}

function projectFacts(report: IAssetCoarseReport): IColorInput['facts'] {
  return IColorFacts.parse({ type: report.clipTypeGuess, gps: report.inferredGps, summary: report.summary, speech: projectSpeech(report),
    visualWindows: report.fineScanWindows.filter(window => window.status === 'recognized').map(window => ({
      windowId: window.windowId, sourceInMs: window.sourceInMs, sourceOutMs: window.sourceOutMs,
      semanticKind: window.semanticKind, visualObservation: window.visualObservation,
      // Never borrow asset-level speech truth for a visual window.
      speech: projectSpeech(window),
    })) });
}

function assetFingerprint(asset: IKtepAsset, root?: IMediaRoot): string {
  return fingerprint({ media: projectMedia(asset, root), analysisInput: asset.analysisInput });
}

/** Verifies the asset side again after refresh if a caller separately loaded assets/root settings. */
export function isColorInputAssetCurrent(input: IColorInput, asset: IKtepAsset, root?: IMediaRoot): boolean {
  return input.assetId === asset.id && input.sources.assetFingerprint === assetFingerprint(asset, root);
}

function projectColorInput(asset: IKtepAsset, root: IMediaRoot | undefined, report: IAssetCoarseReport | null, now: string): IColorInput {
  let analysisStatus: IColorInput['analysisStatus'] = 'current';
  const reasons: string[] = [];
  if (asset.analysisInput?.blocker) {
    analysisStatus = 'blocked'; reasons.push(asset.analysisInput.blocker);
  } else if (!report) {
    analysisStatus = 'missing'; reasons.push('缺少可读取的 Analyze 素材报告');
  } else if (report.assetId !== asset.id) {
    analysisStatus = 'stale'; reasons.push('Analyze 报告的素材身份不匹配');
  } else if (!asset.mediaVersions || !asset.analysisInput || !report.analysisInput) {
    analysisStatus = 'unversioned'; reasons.push('缺少素材版本或分析输入签名');
  } else if (canonical(report.analysisInput) !== canonical(asset.analysisInput)) {
    analysisStatus = 'stale'; reasons.push('Analyze 报告与当前分析输入签名不匹配');
  } else if (!asset.mediaVersions[asset.analysisInput.role]?.available
    || asset.mediaVersions[asset.analysisInput.role]?.contentHash !== asset.analysisInput.contentHash) {
    analysisStatus = 'stale'; reasons.push('登记的分析版本不可用或内容签名不匹配，请先 Ingest');
  }
  const facts = report ? projectFacts(report) : undefined;
  const payload = {
    assetId: asset.id, media: projectMedia(asset, root), analysisInput: asset.analysisInput, analysisStatus, reasons,
    facts: analysisStatus === 'current' || analysisStatus === 'unversioned' ? facts : undefined,
    sources: {
      assetFingerprint: assetFingerprint(asset, root),
      reportFactsFingerprint: report ? fingerprint({ assetId: report.assetId, analysisInput: report.analysisInput, facts }) : undefined,
      reportPath: `analysis/asset-reports/${asset.id}.json`,
    },
  };
  return IColorInput.parse({ ...payload, fingerprint: fingerprint([COLOR_INPUTS_PROJECTION_VERSION, payload]), updatedAt: now });
}

export function getColorInputsPath(projectRoot: string): string {
  return join(projectRoot, 'store/color-inputs.json');
}

/** Raw persisted view for inspection. Consumers must refresh/validate before treating it as current. */
export async function loadColorInputs(projectRoot: string): Promise<IColorInputsStore | null> {
  return readJsonOrNull(getColorInputsPath(projectRoot), IColorInputsStore);
}

const pendingWrites = new Map<string, Promise<void>>();

/** Rebuildable projection only. No media decode, model calls, classifications or source writes. */
export async function refreshColorInputs(projectRoot: string, options: { assetIds?: readonly string[] } = {}): Promise<IColorInputsStore> {
  const key = resolve(projectRoot);
  const operation = (pendingWrites.get(key) ?? Promise.resolve()).then(() => refreshUnlocked(key, options.assetIds));
  const settled = operation.then(() => undefined, () => undefined);
  pendingWrites.set(key, settled);
  try { return await operation; }
  finally { if (pendingWrites.get(key) === settled) pendingWrites.delete(key); }
}

async function refreshUnlocked(projectRoot: string, assetIds?: readonly string[]): Promise<IColorInputsStore> {
  const [assets, { roots }, previous] = await Promise.all([loadAssets(projectRoot), loadIngestRoots(projectRoot), loadColorInputs(projectRoot)]);
  const visualAssets = assets.filter(asset => asset.kind !== 'audio');
  const byId = new Map(visualAssets.map(asset => [asset.id, asset]));
  const rootsById = new Map(roots.map(root => [root.id, root]));
  const selected = previous && assetIds ? new Set(assetIds) : new Set(byId.keys());
  const entries = { ...previous?.assets };
  for (const id of Object.keys(entries)) if (!byId.has(id)) delete entries[id];
  const now = new Date().toISOString();
  for (const asset of visualAssets) {
    if (!selected.has(asset.id)) continue;
    const report = await readJsonOrNull(join(projectRoot, 'analysis/asset-reports', `${asset.id}.json`), IAssetCoarseReport) as IAssetCoarseReport | null;
    const next = projectColorInput(asset, rootsById.get(asset.ingestRootId ?? ''), report, now);
    const old = entries[asset.id];
    // Compare the actual projection too: retaining a copied fingerprint must not hide edits.
    const { updatedAt: _updated, ...oldPayload } = old ?? {};
    const { updatedAt: _nextUpdated, ...newPayload } = next;
    entries[asset.id] = canonical(oldPayload) === canonical(newPayload) ? old! : next;
  }
  if (previous && canonical(entries) === canonical(previous.assets)) return previous;
  const store: IColorInputsStore = { schemaVersion: 1, projectionVersion: COLOR_INPUTS_PROJECTION_VERSION,
    updatedAt: now, assets: Object.fromEntries(Object.entries(entries).sort(([a], [b]) => a.localeCompare(b))) };
  await writeJson(getColorInputsPath(projectRoot), store);
  return store;
}
