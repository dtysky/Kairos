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
  'manual-root-note', 'manual', 'gps', 'derived-track', 'pharos',
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

export const EFineScanMode = z.enum(['skip', 'windowed', 'full']);
export type EFineScanMode = z.infer<typeof EFineScanMode>;

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
  path: z.string().optional(),
  label: z.string().optional(),
  enabled: z.boolean(),
  category: EMediaRootCategory.optional(),
  priority: z.number().optional(),
  description: z.string().optional(),
  notes: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
});
export type IMediaRoot = z.infer<typeof IMediaRoot>;

export const IDeviceMediaRootPath = z.object({
  rootId: z.string(),
  localPath: z.string(),
  flightRecordPath: z.string().optional(),
  exists: z.boolean().optional(),
  lastCheckedAt: z.string().optional(),
});
export type IDeviceMediaRootPath = z.infer<typeof IDeviceMediaRootPath>;

export const IDeviceMediaProjectMap = z.object({
  projectId: z.string(),
  roots: z.array(IDeviceMediaRootPath),
});
export type IDeviceMediaProjectMap = z.infer<typeof IDeviceMediaProjectMap>;

export const IDeviceMediaMapFile = z.object({
  projects: z.record(IDeviceMediaProjectMap),
});
export type IDeviceMediaMapFile = z.infer<typeof IDeviceMediaMapFile>;

// ─── KTEP Core ───────────────────────────────────────────────

export const IKtepEvidence = z.object({
  source: EEvidenceSource,
  value: z.string(),
  confidence: z.number().min(0).max(1).optional(),
});
export type IKtepEvidence = z.infer<typeof IKtepEvidence>;

export const ITranscriptSegment = z.object({
  startMs: z.number().nonnegative(),
  endMs: z.number().nonnegative(),
  text: z.string(),
});
export type ITranscriptSegment = z.infer<typeof ITranscriptSegment>;

export const EDerivedTrackOriginType = z.enum(['embedded-derived', 'manual-itinerary-derived']);
export type EDerivedTrackOriginType = z.infer<typeof EDerivedTrackOriginType>;

export const EEmbeddedGpsOriginType = z.enum(['metadata', 'sidecar-srt', 'flight-record']);
export type EEmbeddedGpsOriginType = z.infer<typeof EEmbeddedGpsOriginType>;

export const IEmbeddedGpsPoint = z.object({
  time: z.string(),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});
export type IEmbeddedGpsPoint = z.infer<typeof IEmbeddedGpsPoint>;

export const IEmbeddedGpsBinding = z.object({
  originType: EEmbeddedGpsOriginType,
  confidence: z.number().min(0).max(1),
  representativeTime: z.string(),
  representativeLat: z.number().min(-90).max(90),
  representativeLng: z.number().min(-180).max(180),
  trackId: z.string().optional(),
  pointCount: z.number().int().nonnegative().optional(),
  startTime: z.string().optional(),
  endTime: z.string().optional(),
  sourcePath: z.string().optional(),
  points: z.array(IEmbeddedGpsPoint).optional(),
});
export type IEmbeddedGpsBinding = z.infer<typeof IEmbeddedGpsBinding>;

export const EProtectionAudioAlignment = z.enum(['exact', 'near', 'mismatch', 'unknown']);
export type EProtectionAudioAlignment = z.infer<typeof EProtectionAudioAlignment>;

export const IProtectionAudioBinding = z.object({
  sourcePath: z.string(),
  displayName: z.string().optional(),
  durationMs: z.number().optional(),
  durationDiffMs: z.number().nonnegative().optional(),
  alignment: EProtectionAudioAlignment,
  codec: z.string().optional(),
  sampleRate: z.number().int().positive().optional(),
  channels: z.number().int().positive().optional(),
  bitRate: z.number().positive().optional(),
});
export type IProtectionAudioBinding = z.infer<typeof IProtectionAudioBinding>;

export const IInferredGps = z.object({
  source: z.enum(['embedded', 'gpx', 'derived-track']),
  confidence: z.number().min(0).max(1),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  embeddedOriginType: EEmbeddedGpsOriginType.optional(),
  derivedOriginType: EDerivedTrackOriginType.optional(),
  timezone: z.string().optional(),
  sourceAssetId: z.string().optional(),
  sourcePath: z.string().optional(),
  matchedItinerarySegmentId: z.string().optional(),
  locationText: z.string().optional(),
  summary: z.string().optional(),
});
export type IInferredGps = z.infer<typeof IInferredGps>;

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
  ingestedAt: z.string().optional(),
  embeddedGps: IEmbeddedGpsBinding.optional(),
  protectionAudio: IProtectionAudioBinding.optional(),
  metadata: z.record(z.unknown()).optional(),
});
export type IKtepAsset = z.infer<typeof IKtepAsset>;

export const IKtepSlice = z.object({
  id: z.string(),
  assetId: z.string(),
  type: ESliceType,
  sourceInMs: z.number().optional(),
  sourceOutMs: z.number().optional(),
  editSourceInMs: z.number().optional(),
  editSourceOutMs: z.number().optional(),
  summary: z.string().optional(),
  transcript: z.string().optional(),
  transcriptSegments: z.array(ITranscriptSegment).optional(),
  labels: z.array(z.string()),
  placeHints: z.array(z.string()),
  evidence: z.array(IKtepEvidence).optional(),
  speechCoverage: z.number().min(0).max(1).optional(),
  confidence: z.number().min(0).max(1).optional(),
  speedCandidate: z.object({
    suggestedSpeeds: z.array(z.number().positive()).min(1),
    rationale: z.string(),
    confidence: z.number().min(0).max(1).optional(),
  }).optional(),
});
export type IKtepSlice = z.infer<typeof IKtepSlice>;

export const IKtepScriptAction = z.object({
  speed: z.number().positive().optional(),
  preserveNatSound: z.boolean().optional(),
  muteSource: z.boolean().optional(),
  transitionHint: ETransitionType.optional(),
  holdMs: z.number().min(0).optional(),
});
export type IKtepScriptAction = z.infer<typeof IKtepScriptAction>;

export const IKtepScriptSelection = z.object({
  assetId: z.string(),
  sliceId: z.string().optional(),
  sourceInMs: z.number().optional(),
  sourceOutMs: z.number().optional(),
  notes: z.string().optional(),
});
export type IKtepScriptSelection = z.infer<typeof IKtepScriptSelection>;

export const IKtepBeatUtterance = z.object({
  text: z.string(),
  pauseBeforeMs: z.number().min(0).optional(),
  pauseAfterMs: z.number().min(0).optional(),
});
export type IKtepBeatUtterance = z.infer<typeof IKtepBeatUtterance>;

export const IKtepScriptBeat = z.object({
  id: z.string(),
  text: z.string(),
  utterances: z.array(IKtepBeatUtterance).optional(),
  targetDurationMs: z.number().optional(),
  actions: IKtepScriptAction.optional(),
  selections: z.array(IKtepScriptSelection),
  linkedSliceIds: z.array(z.string()),
  notes: z.string().optional(),
});
export type IKtepScriptBeat = z.infer<typeof IKtepScriptBeat>;

export const IKtepScript = z.object({
  id: z.string(),
  role: EScriptRole,
  title: z.string().optional(),
  narration: z.string().optional(),
  targetDurationMs: z.number().optional(),
  actions: IKtepScriptAction.optional(),
  selections: z.array(IKtepScriptSelection).optional(),
  linkedSliceIds: z.array(z.string()),
  beats: z.array(IKtepScriptBeat).default([]),
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
  speed: z.number().positive().optional(),
  timelineInMs: z.number(),
  timelineOutMs: z.number(),
  transitionIn: IKtepTransition.optional(),
  transitionOut: IKtepTransition.optional(),
  muteAudio: z.boolean().optional(),
  transform: IKtepTransform.optional(),
  linkedScriptSegmentId: z.string().optional(),
  linkedScriptBeatId: z.string().optional(),
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
  linkedScriptBeatId: z.string().optional(),
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

export const ISpeedCandidateHint = z.object({
  suggestedSpeeds: z.array(z.number().positive()).min(1),
  rationale: z.string(),
  confidence: z.number().min(0).max(1).optional(),
});
export type ISpeedCandidateHint = z.infer<typeof ISpeedCandidateHint>;

export const IInterestingWindow = z.object({
  startMs: z.number(),
  endMs: z.number(),
  editStartMs: z.number().optional(),
  editEndMs: z.number().optional(),
  reason: z.string(),
  speedCandidate: ISpeedCandidateHint.optional(),
});
export type IInterestingWindow = z.infer<typeof IInterestingWindow>;

export const IMediaAnalysisPlan = z.object({
  assetId: z.string(),
  clipType: EClipType,
  densityScore: z.number().min(0).max(1),
  samplingProfile: ESamplingProfile,
  coarseSampleCount: z.number().int().positive().optional(),
  baseSampleIntervalMs: z.number(),
  interestingWindows: z.array(IInterestingWindow),
  vlmMode: EVlmMode,
  targetBudget: ETargetBudget,
  shouldFineScan: z.boolean().default(false),
  fineScanMode: EFineScanMode.default('skip'),
});
export type IMediaAnalysisPlan = z.infer<typeof IMediaAnalysisPlan>;

export const ICoarseSample = z.object({
  timeMs: z.number(),
  path: z.string().optional(),
  summary: z.string().optional(),
});
export type ICoarseSample = z.infer<typeof ICoarseSample>;

export const IAudioHealthSummary = z.object({
  meanVolumeDb: z.number().optional(),
  maxVolumeDb: z.number().optional(),
  silenceRatio: z.number().min(0).max(1).optional(),
  speechCoverage: z.number().min(0).max(1).optional(),
  transcriptChars: z.number().int().nonnegative().optional(),
  score: z.number().min(0).max(1).optional(),
  issues: z.array(z.string()).optional(),
  notes: z.array(z.string()).optional(),
});
export type IAudioHealthSummary = z.infer<typeof IAudioHealthSummary>;

export const EProtectedAudioRecommendation = z.enum(['embedded', 'protection', 'undecided']);
export type EProtectedAudioRecommendation = z.infer<typeof EProtectedAudioRecommendation>;

export const IProtectedAudioAssessment = z.object({
  recommendedSource: EProtectedAudioRecommendation,
  reason: z.string().optional(),
  comparedProtectionTranscript: z.boolean().optional(),
  embedded: IAudioHealthSummary.optional(),
  protection: IAudioHealthSummary.optional(),
});
export type IProtectedAudioAssessment = z.infer<typeof IProtectedAudioAssessment>;

export const IAssetCoarseReport = z.object({
  assetId: z.string(),
  ingestRootId: z.string().optional(),
  durationMs: z.number().optional(),
  clipTypeGuess: EClipType,
  densityScore: z.number().min(0).max(1),
  gpsSummary: z.string().optional(),
  inferredGps: IInferredGps.optional(),
  summary: z.string().optional(),
  transcript: z.string().optional(),
  transcriptSegments: z.array(ITranscriptSegment).optional(),
  speechCoverage: z.number().min(0).max(1).optional(),
  protectedAudio: IProtectedAudioAssessment.optional(),
  labels: z.array(z.string()),
  placeHints: z.array(z.string()),
  rootNotes: z.array(z.string()),
  sampleFrames: z.array(ICoarseSample),
  interestingWindows: z.array(IInterestingWindow),
  shouldFineScan: z.boolean(),
  fineScanMode: EFineScanMode,
  fineScanReasons: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type IAssetCoarseReport = z.infer<typeof IAssetCoarseReport>;

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

// ─── Script Planning ────────────────────────────────────────

export const ESegmentPlanStrategy = z.enum([
  'chronology-first',
  'location-first',
  'emotion-first',
]);
export type ESegmentPlanStrategy = z.infer<typeof ESegmentPlanStrategy>;

export const IProjectMaterialDigestRoot = z.object({
  ingestRootId: z.string().optional(),
  assetCount: z.number().int().nonnegative(),
  durationMs: z.number().nonnegative().optional(),
  topLabels: z.array(z.string()),
  topPlaceHints: z.array(z.string()),
  summary: z.string().optional(),
});
export type IProjectMaterialDigestRoot = z.infer<typeof IProjectMaterialDigestRoot>;

export const IProjectMaterialDigest = z.object({
  id: z.string(),
  projectId: z.string(),
  generatedAt: z.string(),
  projectBrief: z.string().optional(),
  totalAssets: z.number().int().nonnegative(),
  totalDurationMs: z.number().nonnegative().optional(),
  capturedStartAt: z.string().optional(),
  capturedEndAt: z.string().optional(),
  roots: z.array(IProjectMaterialDigestRoot),
  topLabels: z.array(z.string()),
  topPlaceHints: z.array(z.string()),
  clipTypeDistribution: z.record(z.number().int().nonnegative()),
  mainThemes: z.array(z.string()),
  recommendedNarrativeAxes: z.array(z.string()),
  summary: z.string(),
});
export type IProjectMaterialDigest = z.infer<typeof IProjectMaterialDigest>;

export const ISegmentPlanSegment = z.object({
  id: z.string(),
  role: EScriptRole,
  title: z.string(),
  targetDurationMs: z.number().nonnegative().optional(),
  intent: z.string(),
  mood: z.string().optional(),
  preferredClipTypes: z.array(EClipType),
  preferredLabels: z.array(z.string()),
  preferredPlaceHints: z.array(z.string()),
  notes: z.array(z.string()),
});
export type ISegmentPlanSegment = z.infer<typeof ISegmentPlanSegment>;

export const ISegmentPlanDraft = z.object({
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  strategy: ESegmentPlanStrategy,
  description: z.string(),
  generatedAt: z.string(),
  sourceDigestId: z.string().optional(),
  reviewBrief: z.string().optional(),
  segments: z.array(ISegmentPlanSegment),
  notes: z.array(z.string()),
});
export type ISegmentPlanDraft = z.infer<typeof ISegmentPlanDraft>;

export const IApprovedSegmentPlan = z.object({
  id: z.string(),
  projectId: z.string(),
  approvedAt: z.string(),
  sourceDraftId: z.string().optional(),
  reviewBrief: z.string().optional(),
  segments: z.array(ISegmentPlanSegment),
  notes: z.array(z.string()),
});
export type IApprovedSegmentPlan = z.infer<typeof IApprovedSegmentPlan>;

export const ISegmentRecallCandidate = z.object({
  segmentId: z.string(),
  sliceId: z.string(),
  assetId: z.string(),
  score: z.number(),
  reasons: z.array(z.string()),
  summary: z.string().optional(),
  transcript: z.string().optional(),
  labels: z.array(z.string()),
  placeHints: z.array(z.string()),
  sourceInMs: z.number().optional(),
  sourceOutMs: z.number().optional(),
  editSourceInMs: z.number().optional(),
  editSourceOutMs: z.number().optional(),
  speedCandidate: ISpeedCandidateHint.optional(),
});
export type ISegmentRecallCandidate = z.infer<typeof ISegmentRecallCandidate>;

export const ISegmentCandidateRecall = z.object({
  id: z.string(),
  projectId: z.string(),
  approvedPlanId: z.string(),
  generatedAt: z.string(),
  segments: z.array(z.object({
    segmentId: z.string(),
    title: z.string(),
    candidates: z.array(ISegmentRecallCandidate),
  })),
});
export type ISegmentCandidateRecall = z.infer<typeof ISegmentCandidateRecall>;

// ─── Store ───────────────────────────────────────────────────

export const IStoreManifest = z.object({
  storeSchemaVersion: z.string(),
  currentRevisionId: z.string(),
  lastBackupId: z.string().optional(),
  updatedAt: z.string(),
});
export type IStoreManifest = z.infer<typeof IStoreManifest>;
