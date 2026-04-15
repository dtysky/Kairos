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

export const EWindowSemantic = z.enum(['speech', 'visual']);
export type EWindowSemantic = z.infer<typeof EWindowSemantic>;

export const ESamplingProfile = z.enum(['dense', 'balanced', 'sparse']);
export type ESamplingProfile = z.infer<typeof ESamplingProfile>;

export const EVlmMode = z.enum(['none', 'multi-image', 'video']);
export type EVlmMode = z.infer<typeof EVlmMode>;

export const ETargetBudget = z.enum(['coarse', 'standard', 'deep']);
export type ETargetBudget = z.infer<typeof ETargetBudget>;

export const EFineScanMode = z.enum(['skip', 'windowed', 'full']);
export type EFineScanMode = z.infer<typeof EFineScanMode>;

export const EKeepDecision = z.enum(['keep', 'drop']);
export type EKeepDecision = z.infer<typeof EKeepDecision>;

export const EMaterializationPath = z.enum(['fine-scan', 'direct']);
export type EMaterializationPath = z.infer<typeof EMaterializationPath>;

export const EFinalizeFineScanMode = z.enum(['windowed', 'full']);
export type EFinalizeFineScanMode = z.infer<typeof EFinalizeFineScanMode>;

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
  clockOffsetMs: z.number().int().optional(),
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

export const IPharosRef = z.object({
  tripId: z.string(),
  shotId: z.string(),
});
export type IPharosRef = z.infer<typeof IPharosRef>;

export const EPharosAssetState = z.enum(['empty', 'success', 'failure']);
export type EPharosAssetState = z.infer<typeof EPharosAssetState>;

export const EPharosShotMatchStatus = z.enum([
  'pending',
  'expected',
  'unexpected',
  'abandoned',
]);
export type EPharosShotMatchStatus = z.infer<typeof EPharosShotMatchStatus>;

export const IPharosMatch = z.object({
  ref: IPharosRef,
  confidence: z.number().min(0).max(1),
  status: EPharosShotMatchStatus.optional(),
  tripTitle: z.string().optional(),
  dayTitle: z.string().optional(),
  matchReasons: z.array(z.string()).default([]),
});
export type IPharosMatch = z.infer<typeof IPharosMatch>;

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
  source: z.enum(['embedded', 'gpx', 'pharos', 'derived-track']),
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

export const ESemanticEvidenceTier = z.enum(['truth', 'strong-inference', 'weak-inference']);
export type ESemanticEvidenceTier = z.infer<typeof ESemanticEvidenceTier>;

export const ISemanticEvidence = z.object({
  tier: ESemanticEvidenceTier,
  confidence: z.number().min(0).max(1),
  sourceKinds: z.array(z.string()).default([]),
  reasons: z.array(z.string()).default([]),
});
export type ISemanticEvidence = z.infer<typeof ISemanticEvidence>;

export const ISemanticTagSet = z.object({
  core: z.array(z.string()).default([]),
  extra: z.array(z.string()).default([]),
  evidence: z.array(ISemanticEvidence).default([]),
});
export type ISemanticTagSet = z.infer<typeof ISemanticTagSet>;

export const EGroundingSpeechMode = z.enum(['none', 'available', 'preferred']);
export type EGroundingSpeechMode = z.infer<typeof EGroundingSpeechMode>;

export const EGroundingSpeechValue = z.enum(['none', 'informative', 'emotional', 'mixed']);
export type EGroundingSpeechValue = z.infer<typeof EGroundingSpeechValue>;

export const ISpatialEvidence = z.object({
  tier: ESemanticEvidenceTier,
  confidence: z.number().min(0).max(1),
  sourceKinds: z.array(z.string()).default([]),
  reasons: z.array(z.string()).default([]),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
  locationText: z.string().optional(),
  routeRole: z.string().optional(),
  timeReference: z.string().optional(),
  pharosRef: IPharosRef.optional(),
});
export type ISpatialEvidence = z.infer<typeof ISpatialEvidence>;

export const ISpanGrounding = z.object({
  speechMode: EGroundingSpeechMode,
  speechValue: EGroundingSpeechValue,
  spatialEvidence: z.array(ISpatialEvidence).default([]),
  pharosRefs: z.array(IPharosRef).default([]),
});
export type ISpanGrounding = z.infer<typeof ISpanGrounding>;
export const ISliceGrounding = ISpanGrounding;
export type ISliceGrounding = ISpanGrounding;

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

export const IMaterialPattern = z.object({
  phrase: z.string(),
  confidence: z.number().min(0).max(1),
  excerpt: z.string().optional(),
  evidenceRefs: z.array(z.string()).default([]),
});
export type IMaterialPattern = z.infer<typeof IMaterialPattern>;

export const IKtepSpan = z.object({
  id: z.string(),
  assetId: z.string(),
  type: ESliceType,
  semanticKind: EWindowSemantic.optional(),
  sourceInMs: z.number().optional(),
  sourceOutMs: z.number().optional(),
  editSourceInMs: z.number().optional(),
  editSourceOutMs: z.number().optional(),
  transcript: z.string().optional(),
  transcriptSegments: z.array(ITranscriptSegment).optional(),
  materialPatterns: z.array(IMaterialPattern).default([]),
  grounding: ISpanGrounding.default({
    speechMode: 'none',
    speechValue: 'none',
    spatialEvidence: [],
    pharosRefs: [],
  }),
  narrativeFunctions: ISemanticTagSet.default({
    core: [],
    extra: [],
    evidence: [],
  }),
  shotGrammar: ISemanticTagSet.default({
    core: [],
    extra: [],
    evidence: [],
  }),
  viewpointRoles: ISemanticTagSet.default({
    core: [],
    extra: [],
    evidence: [],
  }),
  subjectStates: ISemanticTagSet.default({
    core: [],
    extra: [],
    evidence: [],
  }),
  evidence: z.array(IKtepEvidence).optional(),
  pharosRefs: z.array(IPharosRef).optional(),
  speechCoverage: z.number().min(0).max(1).optional(),
  speedCandidate: z.object({
    suggestedSpeeds: z.array(z.number().positive()).min(1),
    rationale: z.string(),
    confidence: z.number().min(0).max(1).optional(),
  }).optional(),
});
export type IKtepSpan = z.infer<typeof IKtepSpan>;
export const IKtepSlice = IKtepSpan;
export type IKtepSlice = IKtepSpan;

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
  spanId: z.string().optional(),
  sliceId: z.string().optional(),
  sourceInMs: z.number().optional(),
  sourceOutMs: z.number().optional(),
  notes: z.string().optional(),
  pharosRefs: z.array(IPharosRef).optional(),
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
  linkedSpanIds: z.array(z.string()).default([]),
  linkedSliceIds: z.array(z.string()).default([]),
  pharosRefs: z.array(IPharosRef).optional(),
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
  linkedSpanIds: z.array(z.string()).default([]),
  linkedSliceIds: z.array(z.string()).default([]),
  pharosRefs: z.array(IPharosRef).optional(),
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
  spanId: z.string().optional(),
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
  pharosRefs: z.array(IPharosRef).optional(),
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
  spans: z.array(IKtepSpan),
  slices: z.array(IKtepSpan).optional(),
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

export const IStyleChapterProgram = z.object({
  type: z.string(),
  intent: z.string(),
  materialRoles: z.array(z.string()).default([]),
  promotionSignals: z.array(z.string()).default([]),
  transitionBias: z.string(),
  localNarrationNote: z.string().optional(),
});
export type IStyleChapterProgram = z.infer<typeof IStyleChapterProgram>;

export const IStyleArrangementStructure = z.object({
  primaryAxis: z.string().optional(),
  secondaryAxes: z.array(z.string()).default([]),
  chapterPrograms: z.array(IStyleChapterProgram).default([]),
  chapterSplitPrinciples: z.array(z.string()).default([]),
  chapterTransitionNotes: z.array(z.string()).default([]),
});
export type IStyleArrangementStructure = z.infer<typeof IStyleArrangementStructure>;

export const IStyleNarrationConstraints = z.object({
  perspective: z.string().optional(),
  tone: z.string().optional(),
  informationDensity: z.string().optional(),
  explanationBias: z.string().optional(),
  forbiddenPatterns: z.array(z.string()).default([]),
  notes: z.array(z.string()).default([]),
});
export type IStyleNarrationConstraints = z.infer<typeof IStyleNarrationConstraints>;

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
  arrangementStructure: IStyleArrangementStructure,
  narrationConstraints: IStyleNarrationConstraints,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type IStyleProfile = z.infer<typeof IStyleProfile>;

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
  semanticKind: EWindowSemantic.optional(),
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
  keepDecision: EKeepDecision.default('keep'),
  materializationPath: EMaterializationPath.optional(),
  fineScanMode: EFinalizeFineScanMode.optional(),
  densityScore: z.number().min(0).max(1),
  gpsSummary: z.string().optional(),
  inferredGps: IInferredGps.optional(),
  summary: z.string().optional(),
  transcript: z.string().optional(),
  transcriptSegments: z.array(ITranscriptSegment).optional(),
  speechCoverage: z.number().min(0).max(1).optional(),
  protectedAudio: IProtectedAudioAssessment.optional(),
  pharosMatches: z.array(IPharosMatch).default([]),
  primaryPharosRef: IPharosRef.optional(),
  pharosMatchConfidence: z.number().min(0).max(1).optional(),
  pharosStatus: EPharosShotMatchStatus.optional(),
  pharosDayTitle: z.string().optional(),
  labels: z.array(z.string()),
  placeHints: z.array(z.string()),
  rootNotes: z.array(z.string()),
  sampleFrames: z.array(ICoarseSample),
  interestingWindows: z.array(IInterestingWindow),
  fineScanReasons: z.array(z.string()),
  fineScanCompletedAt: z.string().optional(),
  fineScanSliceCount: z.number().int().min(0).optional(),
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
  pharosMatches: z.array(IPharosMatch).default([]),
  primaryPharosRef: IPharosRef.optional(),
  pharosStatus: EPharosShotMatchStatus.optional(),
  pharosDayTitle: z.string().optional(),
  correction: IChronologyCorrection.optional(),
});
export type IMediaChronology = z.infer<typeof IMediaChronology>;

// ─── Model-Driven Script Prep ──────────────────────────────

export const IProjectMaterialOverviewRoot = z.object({
  ingestRootId: z.string().optional(),
  assetCount: z.number().int().nonnegative(),
  durationMs: z.number().nonnegative().optional(),
  topLabels: z.array(z.string()),
  topPlaceHints: z.array(z.string()),
  topMaterialPatterns: z.array(z.string()).default([]),
  summary: z.string().optional(),
});
export type IProjectMaterialOverviewRoot = z.infer<typeof IProjectMaterialOverviewRoot>;

export const IProjectMaterialOverviewPharosTrip = z.object({
  tripId: z.string(),
  title: z.string(),
  tripKind: z.enum(['planned', 'freeform']).optional(),
  revision: z.number().int().nonnegative().optional(),
  dateStart: z.string().optional(),
  dateEnd: z.string().optional(),
  mustCount: z.number().int().nonnegative().default(0),
  optionalCount: z.number().int().nonnegative().default(0),
  pendingCount: z.number().int().nonnegative().default(0),
  abandonedCount: z.number().int().nonnegative().default(0),
  matchedAssetCount: z.number().int().nonnegative().default(0),
});
export type IProjectMaterialOverviewPharosTrip = z.infer<typeof IProjectMaterialOverviewPharosTrip>;

export const IProjectMaterialOverviewPharos = z.object({
  status: EPharosAssetState,
  fallbackMode: z.boolean().default(true),
  discoveredTripCount: z.number().int().nonnegative().default(0),
  includedTripCount: z.number().int().nonnegative().default(0),
  matchedAssetCount: z.number().int().nonnegative().default(0),
  unmatchedAssetCount: z.number().int().nonnegative().default(0),
  pendingShotCount: z.number().int().nonnegative().default(0),
  abandonedShotCount: z.number().int().nonnegative().default(0),
  warnings: z.array(z.string()).default([]),
  errors: z.array(z.string()).default([]),
  trips: z.array(IProjectMaterialOverviewPharosTrip).default([]),
});
export type IProjectMaterialOverviewPharos = z.infer<typeof IProjectMaterialOverviewPharos>;

export const IProjectMaterialOverviewFacts = z.object({
  id: z.string(),
  projectId: z.string(),
  generatedAt: z.string(),
  projectBrief: z.string().optional(),
  totalAssets: z.number().int().nonnegative(),
  totalDurationMs: z.number().nonnegative().optional(),
  capturedStartAt: z.string().optional(),
  capturedEndAt: z.string().optional(),
  roots: z.array(IProjectMaterialOverviewRoot),
  topLabels: z.array(z.string()),
  topPlaceHints: z.array(z.string()),
  topMaterialPatterns: z.array(z.string()).default([]),
  clipTypeDistribution: z.record(z.number().int().nonnegative()),
  mainThemes: z.array(z.string()),
  spatialStorySummary: z.array(z.string()).default([]),
  inferredGaps: z.array(z.string()).default([]),
  pharos: IProjectMaterialOverviewPharos.optional(),
  summary: z.string(),
});
export type IProjectMaterialOverviewFacts = z.infer<typeof IProjectMaterialOverviewFacts>;

export const IMaterialBundle = z.object({
  id: z.string(),
  key: z.string(),
  label: z.string(),
  memberSpanIds: z.array(z.string()).default([]),
  representativeSpanIds: z.array(z.string()).default([]),
  placeHints: z.array(z.string()).default([]),
  pharosTripIds: z.array(z.string()).default([]),
  notes: z.array(z.string()).default([]),
});
export type IMaterialBundle = z.infer<typeof IMaterialBundle>;

export const ISegmentPlanSegment = z.object({
  id: z.string(),
  title: z.string(),
  intent: z.string(),
  targetDurationMs: z.number().nonnegative().optional(),
  roleHint: z.string().optional(),
  notes: z.array(z.string()).default([]),
});
export type ISegmentPlanSegment = z.infer<typeof ISegmentPlanSegment>;

export const ISegmentPlan = z.object({
  id: z.string(),
  projectId: z.string(),
  generatedAt: z.string(),
  summary: z.string().optional(),
  segments: z.array(ISegmentPlanSegment),
  notes: z.array(z.string()).default([]),
});
export type ISegmentPlan = z.infer<typeof ISegmentPlan>;

export const EMaterialSlotRequirement = z.enum(['required', 'optional']);
export type EMaterialSlotRequirement = z.infer<typeof EMaterialSlotRequirement>;

export const IMaterialSlot = z.object({
  id: z.string(),
  query: z.string(),
  requirement: EMaterialSlotRequirement.default('required'),
  targetBundles: z.array(z.string()).default([]),
  chosenSpanIds: z.array(z.string()).default([]),
});
export type IMaterialSlot = z.infer<typeof IMaterialSlot>;

export const ISegmentMaterialSlotGroup = z.object({
  segmentId: z.string(),
  slots: z.array(IMaterialSlot).default([]),
});
export type ISegmentMaterialSlotGroup = z.infer<typeof ISegmentMaterialSlotGroup>;

export const IMaterialSlotsDocument = z.object({
  id: z.string(),
  projectId: z.string(),
  generatedAt: z.string(),
  segments: z.array(ISegmentMaterialSlotGroup).default([]),
});
export type IMaterialSlotsDocument = z.infer<typeof IMaterialSlotsDocument>;

export const IAgentPacketInputArtifact = z.object({
  label: z.string(),
  path: z.string().optional(),
  summary: z.string().optional(),
  content: z.unknown().optional(),
});
export type IAgentPacketInputArtifact = z.infer<typeof IAgentPacketInputArtifact>;

export const IAgentPacket = z.object({
  stage: z.string(),
  identity: z.string(),
  mission: z.string(),
  hardConstraints: z.array(z.string()).default([]),
  allowedInputs: z.array(z.string()).default([]),
  inputArtifacts: z.array(IAgentPacketInputArtifact).default([]),
  outputSchema: z.record(z.unknown()).default({}),
  reviewRubric: z.array(z.string()).default([]),
});
export type IAgentPacket = z.infer<typeof IAgentPacket>;

export const EStageReviewSeverity = z.enum(['blocker', 'warning']);
export type EStageReviewSeverity = z.infer<typeof EStageReviewSeverity>;

export const IStageReviewIssue = z.object({
  code: z.string(),
  severity: EStageReviewSeverity,
  message: z.string(),
  details: z.string().optional(),
});
export type IStageReviewIssue = z.infer<typeof IStageReviewIssue>;

export const EStageReviewVerdict = z.enum(['pass', 'revise', 'awaiting_user']);
export type EStageReviewVerdict = z.infer<typeof EStageReviewVerdict>;

export const IStageReview = z.object({
  stage: z.string(),
  identity: z.string(),
  attempt: z.number().int().positive(),
  verdict: EStageReviewVerdict,
  issues: z.array(IStageReviewIssue).default([]),
  revisionBrief: z.array(z.string()).default([]),
  reviewedAt: z.string(),
});
export type IStageReview = z.infer<typeof IStageReview>;

export const EAgentPipelineStatus = z.enum([
  'pending',
  'running',
  'review_failed',
  'awaiting_user',
  'completed',
]);
export type EAgentPipelineStatus = z.infer<typeof EAgentPipelineStatus>;

export const IAgentPipelineState = z.object({
  currentStage: z.string(),
  stageStatus: EAgentPipelineStatus.default('pending'),
  attemptCount: z.number().int().nonnegative().default(0),
  latestReviewResult: z.string().optional(),
  blockerSummary: z.array(z.string()).default([]),
  updatedAt: z.string(),
});
export type IAgentPipelineState = z.infer<typeof IAgentPipelineState>;

export const ISpatialStoryAnchor = z.object({
  id: z.string(),
  title: z.string(),
  startAt: z.string().optional(),
  endAt: z.string().optional(),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
  locationText: z.string().optional(),
  routeRole: z.string().optional(),
  spanIds: z.array(z.string()).default([]),
  pharosRefs: z.array(IPharosRef).default([]),
});
export type ISpatialStoryAnchor = z.infer<typeof ISpatialStoryAnchor>;

export const ISpatialStoryTransition = z.object({
  id: z.string(),
  fromAnchorId: z.string().optional(),
  toAnchorId: z.string().optional(),
  title: z.string(),
  startAt: z.string().optional(),
  endAt: z.string().optional(),
  routeRole: z.string().optional(),
  spanIds: z.array(z.string()).default([]),
  pharosRefs: z.array(IPharosRef).default([]),
});
export type ISpatialStoryTransition = z.infer<typeof ISpatialStoryTransition>;

export const ISpatialStoryRouteWindow = z.object({
  id: z.string(),
  title: z.string(),
  startAt: z.string().optional(),
  endAt: z.string().optional(),
  anchorIds: z.array(z.string()).default([]),
  spanIds: z.array(z.string()).default([]),
  notes: z.array(z.string()).default([]),
});
export type ISpatialStoryRouteWindow = z.infer<typeof ISpatialStoryRouteWindow>;

export const ESpatialStoryGapKind = z.enum([
  'weak-location',
  'route-break',
  'pharos-uncovered',
]);
export type ESpatialStoryGapKind = z.infer<typeof ESpatialStoryGapKind>;

export const ISpatialStoryCoverageGap = z.object({
  kind: ESpatialStoryGapKind,
  message: z.string(),
  spanIds: z.array(z.string()).default([]),
  pharosRefs: z.array(IPharosRef).default([]),
});
export type ISpatialStoryCoverageGap = z.infer<typeof ISpatialStoryCoverageGap>;

export const ISpatialStoryNarrativeHint = z.object({
  title: z.string(),
  guidance: z.string(),
  anchorIds: z.array(z.string()).default([]),
  spanIds: z.array(z.string()).default([]),
  pharosRefs: z.array(IPharosRef).default([]),
});
export type ISpatialStoryNarrativeHint = z.infer<typeof ISpatialStoryNarrativeHint>;

export const ISpatialStoryContext = z.object({
  generatedAt: z.string(),
  anchors: z.array(ISpatialStoryAnchor).default([]),
  transitions: z.array(ISpatialStoryTransition).default([]),
  routeWindows: z.array(ISpatialStoryRouteWindow).default([]),
  coverageGaps: z.array(ISpatialStoryCoverageGap).default([]),
  narrativeHints: z.array(ISpatialStoryNarrativeHint).default([]),
});
export type ISpatialStoryContext = z.infer<typeof ISpatialStoryContext>;

export const IAgentContract = z.object({
  generatedAt: z.string(),
  goals: z.array(z.string()).default([]),
  constraints: z.array(z.string()).default([]),
  reviewNotes: z.array(z.string()).default([]),
  styleMust: z.array(z.string()).default([]),
  styleForbidden: z.array(z.string()).default([]),
  gpsNarrativeHints: z.array(z.string()).default([]),
  pharosMustCover: z.array(z.string()).default([]),
  pharosPendingHints: z.array(z.string()).default([]),
  chronologyGuardrails: z.array(z.string()).default([]),
});
export type IAgentContract = z.infer<typeof IAgentContract>;

// ─── Store ───────────────────────────────────────────────────

export const IStoreManifest = z.object({
  storeSchemaVersion: z.string(),
  currentRevisionId: z.string(),
  lastBackupId: z.string().optional(),
  updatedAt: z.string(),
});
export type IStoreManifest = z.infer<typeof IStoreManifest>;

// ─── Project Workspace / Review Queue ───────────────────────

export const IProjectBriefMappingConfig = z.object({
  path: z.string(),
  description: z.string(),
  flightRecordPath: z.string().optional(),
});
export type IProjectBriefMappingConfig = z.infer<typeof IProjectBriefMappingConfig>;

export const IProjectBriefPharosConfig = z.object({
  includedTripIds: z.array(z.string()).default([]),
});
export type IProjectBriefPharosConfig = z.infer<typeof IProjectBriefPharosConfig>;

export const IProjectBriefConfig = z.object({
  name: z.string(),
  description: z.string().optional(),
  createdAt: z.string().optional(),
  mappings: z.array(IProjectBriefMappingConfig),
  pharos: IProjectBriefPharosConfig.optional(),
  materialPatternPhrases: z.array(z.string()).default([]),
});
export type IProjectBriefConfig = z.infer<typeof IProjectBriefConfig>;

export const IProjectPharosGpxSummary = z.object({
  tripId: z.string(),
  path: z.string(),
  pointCount: z.number().int().nonnegative().optional(),
  startTime: z.string().optional(),
  endTime: z.string().optional(),
});
export type IProjectPharosGpxSummary = z.infer<typeof IProjectPharosGpxSummary>;

export const IProjectPharosTripSummary = z.object({
  tripId: z.string(),
  title: z.string(),
  tripKind: z.enum(['planned', 'freeform']).optional(),
  revision: z.number().int().nonnegative().optional(),
  timezone: z.string().optional(),
  dateStart: z.string().optional(),
  dateEnd: z.string().optional(),
  mustCount: z.number().int().nonnegative().default(0),
  optionalCount: z.number().int().nonnegative().default(0),
  pendingCount: z.number().int().nonnegative().default(0),
  expectedCount: z.number().int().nonnegative().default(0),
  unexpectedCount: z.number().int().nonnegative().default(0),
  abandonedCount: z.number().int().nonnegative().default(0),
  gpxCount: z.number().int().nonnegative().default(0),
  warnings: z.array(z.string()).default([]),
});
export type IProjectPharosTripSummary = z.infer<typeof IProjectPharosTripSummary>;

export const IProjectPharosShot = z.object({
  ref: IPharosRef,
  tripTitle: z.string().optional(),
  tripKind: z.enum(['planned', 'freeform']).optional(),
  day: z.number().int().positive().optional(),
  date: z.string().optional(),
  dayTitle: z.string().optional(),
  location: z.string(),
  description: z.string(),
  type: z.string(),
  priority: z.enum(['must', 'optional']).optional(),
  source: z.string().optional(),
  device: z.string().optional(),
  roll: z.string().optional(),
  devices: z.array(z.string()).default([]),
  rolls: z.array(z.string()).default([]),
  gps: z.tuple([z.number(), z.number()]).optional(),
  gpsStart: z.tuple([z.number(), z.number()]).optional(),
  gpsEnd: z.tuple([z.number(), z.number()]).optional(),
  timeWindowStart: z.string().optional(),
  timeWindowEnd: z.string().optional(),
  actualTimeStart: z.string().optional(),
  actualTimeEnd: z.string().optional(),
  actualGpsStart: z.tuple([z.number(), z.number()]).optional(),
  actualGpsEnd: z.tuple([z.number(), z.number()]).optional(),
  status: EPharosShotMatchStatus.optional(),
  note: z.string().nullable().optional(),
  abandonReason: z.string().nullable().optional(),
  isExtraShot: z.boolean().default(false),
});
export type IProjectPharosShot = z.infer<typeof IProjectPharosShot>;

export const IProjectPharosContext = z.object({
  schemaVersion: z.literal('1.0'),
  generatedAt: z.string(),
  status: EPharosAssetState,
  rootPath: z.string(),
  discoveredTripIds: z.array(z.string()).default([]),
  includedTripIds: z.array(z.string()).default([]),
  warnings: z.array(z.string()).default([]),
  errors: z.array(z.string()).default([]),
  trips: z.array(IProjectPharosTripSummary).default([]),
  shots: z.array(IProjectPharosShot).default([]),
  gpxFiles: z.array(IProjectPharosGpxSummary).default([]),
});
export type IProjectPharosContext = z.infer<typeof IProjectPharosContext>;

export const IManualItinerarySegmentConfig = z.object({
  id: z.string(),
  date: z.string(),
  startLocalTime: z.string().optional(),
  endLocalTime: z.string().optional(),
  rootRef: z.string().optional(),
  pathPrefix: z.string().optional(),
  location: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  via: z.array(z.string()).optional(),
  transport: z.enum(['drive', 'walk', 'train', 'flight', 'boat', 'mixed']).optional(),
  notes: z.string().optional(),
});
export type IManualItinerarySegmentConfig = z.infer<typeof IManualItinerarySegmentConfig>;

export const IManualCaptureTimeOverrideConfig = z.object({
  rootRef: z.string().optional(),
  sourcePath: z.string(),
  currentCapturedAt: z.string().optional(),
  currentSource: z.string().optional(),
  suggestedDate: z.string().optional(),
  suggestedTime: z.string().optional(),
  correctedDate: z.string().optional(),
  correctedTime: z.string().optional(),
  timezone: z.string().optional(),
  note: z.string().optional(),
});
export type IManualCaptureTimeOverrideConfig = z.infer<typeof IManualCaptureTimeOverrideConfig>;

export const IManualItineraryConfig = z.object({
  prose: z.string().default(''),
  segments: z.array(IManualItinerarySegmentConfig).default([]),
  captureTimeOverrides: z.array(IManualCaptureTimeOverrideConfig).default([]),
});
export type IManualItineraryConfig = z.infer<typeof IManualItineraryConfig>;

export const IScriptBriefSegmentConfig = z.object({
  segmentId: z.string(),
  title: z.string().optional(),
  roleHint: z.string().optional(),
  targetDurationMs: z.number().nonnegative().optional(),
  intent: z.string().optional(),
  notes: z.array(z.string()).default([]),
});
export type IScriptBriefSegmentConfig = z.infer<typeof IScriptBriefSegmentConfig>;

export const EScriptBriefWorkflowState = z.enum([
  'choose_style',
  'await_brief_draft',
  'review_brief',
  'ready_to_prepare',
  'ready_for_agent',
  'script_generated',
]);
export type EScriptBriefWorkflowState = z.infer<typeof EScriptBriefWorkflowState>;

export const IScriptBriefConfig = z.object({
  projectName: z.string(),
  createdAt: z.string().optional(),
  styleCategory: z.string().optional(),
  workflowState: EScriptBriefWorkflowState.default('choose_style'),
  lastAgentDraftAt: z.string().optional(),
  lastUserReviewAt: z.string().optional(),
  lastAgentDraftFingerprint: z.string().optional(),
  briefOverwriteApprovedAt: z.string().optional(),
  statusText: z.string().optional(),
  goalDraft: z.array(z.string()).default([]),
  constraintDraft: z.array(z.string()).default([]),
  planReviewDraft: z.array(z.string()).default([]),
  segments: z.array(IScriptBriefSegmentConfig).default([]),
});
export type IScriptBriefConfig = z.infer<typeof IScriptBriefConfig>;

export const EStyleSourceType = z.enum(['file', 'directory']);
export type EStyleSourceType = z.infer<typeof EStyleSourceType>;

export const IStyleSourceItem = z.object({
  id: z.string(),
  type: EStyleSourceType,
  path: z.string(),
  rangeStart: z.string().optional(),
  rangeEnd: z.string().optional(),
  note: z.string().optional(),
  includeNotes: z.string().optional(),
  excludeNotes: z.string().optional(),
});
export type IStyleSourceItem = z.infer<typeof IStyleSourceItem>;

export const IStyleSourceCategoryConfig = z.object({
  categoryId: z.string(),
  displayName: z.string(),
  guidancePrompt: z.string().optional(),
  inclusionNotes: z.string().optional(),
  exclusionNotes: z.string().optional(),
  overwriteExisting: z.boolean().default(false),
  profilePath: z.string().optional(),
  sources: z.array(IStyleSourceItem).default([]),
});
export type IStyleSourceCategoryConfig = z.infer<typeof IStyleSourceCategoryConfig>;

export const IStyleSourcesConfig = z.object({
  defaultCategory: z.string().optional(),
  categories: z.array(IStyleSourceCategoryConfig).default([]),
});
export type IStyleSourcesConfig = z.infer<typeof IStyleSourcesConfig>;

export const EReviewStage = z.enum([
  'project-init',
  'ingest',
  'gps-refresh',
  'analyze',
  'style-analysis',
  'script',
  'timeline',
  'export',
]);
export type EReviewStage = z.infer<typeof EReviewStage>;

export const EReviewStatus = z.enum(['open', 'resolved', 'dismissed']);
export type EReviewStatus = z.infer<typeof EReviewStatus>;

export const EReviewItemKind = z.enum([
  'capture-time-correction',
  'script-review',
  'agent-approval',
  'style-source-warning',
  'generic',
]);
export type EReviewItemKind = z.infer<typeof EReviewItemKind>;

export const IReviewField = z.object({
  key: z.string(),
  label: z.string(),
  value: z.string().optional(),
  suggestedValue: z.string().optional(),
  required: z.boolean().optional(),
});
export type IReviewField = z.infer<typeof IReviewField>;

export const IReviewItem = z.object({
  id: z.string(),
  projectId: z.string(),
  kind: EReviewItemKind,
  stage: EReviewStage,
  status: EReviewStatus,
  title: z.string(),
  reason: z.string(),
  sourcePath: z.string().optional(),
  rootRef: z.string().optional(),
  relatedJobId: z.string().optional(),
  currentValue: z.record(z.string()).optional(),
  suggestedValue: z.record(z.string()).optional(),
  fields: z.array(IReviewField).default([]),
  note: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  resolvedAt: z.string().optional(),
});
export type IReviewItem = z.infer<typeof IReviewItem>;

export const IReviewQueue = z.object({
  items: z.array(IReviewItem).default([]),
});
export type IReviewQueue = z.infer<typeof IReviewQueue>;
