import { z } from 'zod';

// ─── Constants ───────────────────────────────────────────────

export const CPROTOCOL = 'kairos.timeline' as const;
export const CVERSION = '1.0' as const;

// ─── Enums ───────────────────────────────────────────────────

export const EAssetKind = z.enum(['video', 'photo', 'audio']);
export type EAssetKind = z.infer<typeof EAssetKind>;

export const ESliceType = z.enum([
  'shot', 'timelapse', 'photo', 'aerial',
  'talking-head', 'drive', 'broll', 'unknown',
]);
export type ESliceType = z.infer<typeof ESliceType>;

export const EEvidenceSource = z.enum([
  'vision', 'asr', 'ocr', 'filename', 'folder',
  'manual-root-note', 'manual', 'gps', 'pharos',
]);
export type EEvidenceSource = z.infer<typeof EEvidenceSource>;

export const EScriptRole = z.enum([
  'intro', 'scene', 'transition', 'highlight', 'outro',
]);
export type EScriptRole = z.infer<typeof EScriptRole>;

export const ETrackKind = z.enum(['video', 'audio', 'subtitle']);
export type ETrackKind = z.infer<typeof ETrackKind>;

export const ETrackRole = z.enum([
  'primary', 'broll', 'voiceover', 'nat', 'music', 'caption',
]);
export type ETrackRole = z.infer<typeof ETrackRole>;

export const ETransitionType = z.enum([
  'cut', 'cross-dissolve', 'fade', 'wipe',
]);
export type ETransitionType = z.infer<typeof ETransitionType>;

export const ECaptureTimeSource = z.enum([
  'exif', 'quicktime', 'container', 'ffprobe-tag',
  'filename', 'filesystem', 'manual',
]);
export type ECaptureTimeSource = z.infer<typeof ECaptureTimeSource>;

export const EMediaRootCategory = z.enum([
  'camera', 'drone', 'phone', 'audio', 'exports', 'mixed',
]);
export type EMediaRootCategory = z.infer<typeof EMediaRootCategory>;

export const EClipType = z.enum([
  'drive', 'talking-head', 'aerial', 'timelapse', 'broll', 'unknown',
]);
export type EClipType = z.infer<typeof EClipType>;

export const ESamplingProfile = z.enum(['dense', 'balanced', 'sparse']);
export type ESamplingProfile = z.infer<typeof ESamplingProfile>;

export const EVlmMode = z.enum(['none', 'multi-image', 'video']);
export type EVlmMode = z.infer<typeof EVlmMode>;

export const ETargetBudget = z.enum(['coarse', 'standard', 'deep']);
export type ETargetBudget = z.infer<typeof ETargetBudget>;

// ─── Supporting Types ────────────────────────────────────────

export const ICaptureTime = z.object({
  capturedAt: z.string().optional(),
  originalValue: z.string().optional(),
  originalTimezone: z.string().optional(),
  source: ECaptureTimeSource,
  confidence: z.number().min(0).max(1),
});
export type ICaptureTime = z.infer<typeof ICaptureTime>;

export const IMediaRoot = z.object({
  id: z.string(),
  path: z.string(),
  enabled: z.boolean(),
  category: EMediaRootCategory.optional(),
  priority: z.number().optional(),
  notes: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  defaultTimezone: z.string().optional(),
});
export type IMediaRoot = z.infer<typeof IMediaRoot>;

// ─── KTEP Core ───────────────────────────────────────────────

export const IKtepEvidence = z.object({
  source: EEvidenceSource,
  value: z.string(),
  confidence: z.number().min(0).max(1).optional(),
});
export type IKtepEvidence = z.infer<typeof IKtepEvidence>;

export const IKtepAsset = z.object({
  id: z.string(),
  kind: EAssetKind,
  sourcePath: z.string(),
  displayName: z.string(),
  ingestRootId: z.string().optional(),
  durationMs: z.number().optional(),
  fps: z.number().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  capturedAt: z.string().optional(),
  captureTimeSource: ECaptureTimeSource.optional(),
  captureTimeConfidence: z.number().min(0).max(1).optional(),
  createdAt: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});
export type IKtepAsset = z.infer<typeof IKtepAsset>;

export const IKtepSlice = z.object({
  id: z.string(),
  assetId: z.string(),
  type: ESliceType,
  sourceInMs: z.number().optional(),
  sourceOutMs: z.number().optional(),
  summary: z.string().optional(),
  labels: z.array(z.string()),
  confidence: z.number().min(0).max(1).optional(),
  evidence: z.array(IKtepEvidence),
});
export type IKtepSlice = z.infer<typeof IKtepSlice>;

export const IKtepScript = z.object({
  id: z.string(),
  role: EScriptRole,
  title: z.string().optional(),
  narration: z.string(),
  targetDurationMs: z.number().optional(),
  linkedSliceIds: z.array(z.string()),
  notes: z.string().optional(),
});
export type IKtepScript = z.infer<typeof IKtepScript>;

export const IKtepKenBurns = z.object({
  startScale: z.number(),
  endScale: z.number(),
  startX: z.number(),
  startY: z.number(),
  endX: z.number(),
  endY: z.number(),
});
export type IKtepKenBurns = z.infer<typeof IKtepKenBurns>;

export const IKtepTransform = z.object({
  scale: z.number().optional(),
  positionX: z.number().optional(),
  positionY: z.number().optional(),
  rotation: z.number().optional(),
  kenBurns: IKtepKenBurns.optional(),
});
export type IKtepTransform = z.infer<typeof IKtepTransform>;

export const IKtepTransition = z.object({
  type: ETransitionType,
  durationMs: z.number().optional(),
});
export type IKtepTransition = z.infer<typeof IKtepTransition>;

export const IKtepTrack = z.object({
  id: z.string(),
  kind: ETrackKind,
  role: ETrackRole,
  index: z.number(),
});
export type IKtepTrack = z.infer<typeof IKtepTrack>;

export const IKtepClip = z.object({
  id: z.string(),
  trackId: z.string(),
  assetId: z.string(),
  sliceId: z.string().optional(),
  sourceInMs: z.number().optional(),
  sourceOutMs: z.number().optional(),
  timelineInMs: z.number(),
  timelineOutMs: z.number(),
  transitionIn: IKtepTransition.optional(),
  transitionOut: IKtepTransition.optional(),
  transform: IKtepTransform.optional(),
  linkedScriptSegmentId: z.string().optional(),
});
export type IKtepClip = z.infer<typeof IKtepClip>;

export const IKtepTimeline = z.object({
  id: z.string(),
  name: z.string(),
  fps: z.number(),
  resolution: z.object({
    width: z.number(),
    height: z.number(),
  }),
  tracks: z.array(IKtepTrack),
  clips: z.array(IKtepClip),
});
export type IKtepTimeline = z.infer<typeof IKtepTimeline>;

export const IKtepSubtitle = z.object({
  id: z.string(),
  startMs: z.number(),
  endMs: z.number(),
  text: z.string(),
  language: z.string().optional(),
  speaker: z.string().optional(),
  linkedScriptSegmentId: z.string().optional(),
});
export type IKtepSubtitle = z.infer<typeof IKtepSubtitle>;

export const IKtepProject = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type IKtepProject = z.infer<typeof IKtepProject>;

// ─── Top-Level Document ──────────────────────────────────────

export const IKtepDoc = z.object({
  protocol: z.literal(CPROTOCOL),
  version: z.literal(CVERSION),
  project: IKtepProject,
  assets: z.array(IKtepAsset),
  slices: z.array(IKtepSlice),
  script: z.array(IKtepScript).optional(),
  timeline: IKtepTimeline,
  subtitles: z.array(IKtepSubtitle).optional(),
  adapterHints: z.record(z.unknown()).optional(),
});
export type IKtepDoc = z.infer<typeof IKtepDoc>;

// ─── Style Profile ───────────────────────────────────────────

export const IStyleNarrative = z.object({
  introRatio: z.number().min(0).max(1),
  outroRatio: z.number().min(0).max(1),
  avgSegmentDurationSec: z.number(),
  brollFrequency: z.number().min(0).max(1),
  pacePattern: z.string(),
});
export type IStyleNarrative = z.infer<typeof IStyleNarrative>;

export const IStyleVoice = z.object({
  person: z.enum(['1st', '2nd', '3rd']),
  tone: z.string(),
  density: z.enum(['low', 'moderate', 'high']),
  sampleTexts: z.array(z.string()),
});
export type IStyleVoice = z.infer<typeof IStyleVoice>;

export const IStyleSection = z.object({
  id: z.string(),
  title: z.string(),
  content: z.string(),
  tags: z.array(z.string()).optional(),
});
export type IStyleSection = z.infer<typeof IStyleSection>;

export const IStyleProfile = z.object({
  id: z.string(),
  name: z.string(),
  category: z.string().optional(),
  guidancePrompt: z.string().optional(),
  sourceFiles: z.array(z.string()),
  narrative: IStyleNarrative,
  voice: IStyleVoice,
  rawReference: z.string().optional(),
  sections: z.array(IStyleSection).optional(),
  antiPatterns: z.array(z.string()).optional(),
  parameters: z.record(z.string()).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type IStyleProfile = z.infer<typeof IStyleProfile>;

export const IStyleCatalogEntry = z.object({
  id: z.string(),
  category: z.string(),
  name: z.string(),
  description: z.string().optional(),
  profilePath: z.string(),
  sourceVideoCount: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type IStyleCatalogEntry = z.infer<typeof IStyleCatalogEntry>;

export const IStyleCatalog = z.object({
  defaultCategory: z.string().optional(),
  entries: z.array(IStyleCatalogEntry),
});
export type IStyleCatalog = z.infer<typeof IStyleCatalog>;

// ─── Media Analysis ─────────────────────────────────────────

export const IInterestingWindow = z.object({
  startMs: z.number(),
  endMs: z.number(),
  reason: z.string(),
});
export type IInterestingWindow = z.infer<typeof IInterestingWindow>;

export const IMediaAnalysisPlan = z.object({
  assetId: z.string(),
  clipType: EClipType,
  densityScore: z.number().min(0).max(1),
  samplingProfile: ESamplingProfile,
  baseSampleIntervalMs: z.number(),
  interestingWindows: z.array(IInterestingWindow),
  vlmMode: EVlmMode,
  targetBudget: ETargetBudget,
});
export type IMediaAnalysisPlan = z.infer<typeof IMediaAnalysisPlan>;

export const IChronologyCorrection = z.object({
  capturedAtOverride: z.string().optional(),
  summaryOverride: z.string().optional(),
  labelsAdd: z.array(z.string()).optional(),
  labelsRemove: z.array(z.string()).optional(),
  reason: z.string().optional(),
  updatedAt: z.string(),
});
export type IChronologyCorrection = z.infer<typeof IChronologyCorrection>;

export const IMediaChronology = z.object({
  id: z.string(),
  assetId: z.string(),
  ingestRootId: z.string().optional(),
  capturedAt: z.string().optional(),
  sortCapturedAt: z.string().optional(),
  captureTimeSource: ECaptureTimeSource.optional(),
  captureTimeConfidence: z.number().min(0).max(1).optional(),
  summary: z.string().optional(),
  labels: z.array(z.string()),
  placeHints: z.array(z.string()),
  evidence: z.array(IKtepEvidence),
  correction: IChronologyCorrection.optional(),
});
export type IMediaChronology = z.infer<typeof IMediaChronology>;

// ─── Store ───────────────────────────────────────────────────

export const IStoreManifest = z.object({
  storeSchemaVersion: z.string(),
  currentRevisionId: z.string(),
  lastBackupId: z.string().optional(),
  updatedAt: z.string(),
});
export type IStoreManifest = z.infer<typeof IStoreManifest>;
