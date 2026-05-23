import { z } from 'zod';

// ─── Constants ───────────────────────────────────────────────

export const CPROTOCOL = 'kairos.timeline' as const;
export const CVERSION = '2.0' as const;

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
  'primary', 'broll', 'voiceover', 'dialogue', 'nat', 'music', 'caption',
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

export const ECaptureTimePolicyMode = z.enum(['auto', 'manual-required']);
export type ECaptureTimePolicyMode = z.infer<typeof ECaptureTimePolicyMode>;

export const ECaptureTimePolicyKind = z.enum(['video', 'photo']);
export type ECaptureTimePolicyKind = z.infer<typeof ECaptureTimePolicyKind>;

export const EMediaRootCategory = z.enum([
  'camera', 'drone', 'phone', 'audio', 'exports', 'mixed',
]);
export type EMediaRootCategory = z.infer<typeof EMediaRootCategory>;

export const EClipType = z.enum([
  'drive', 'talking-head', 'aerial', 'timelapse', 'broll', 'unknown',
]);
export type EClipType = z.infer<typeof EClipType>;

export const EWindowSemantic = z.enum(['speech', 'visual', 'mixed']);
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

export const EColorSourceProfile = z.enum(['slog3', 'dlog', 'dlog-m', 'hlg', 'rec709']);
export type EColorSourceProfile = z.infer<typeof EColorSourceProfile>;

export const IMediaRootColorConfig = z.object({
  renderPreset: z.lazy(() => IColorRenderPreset).optional(),
  colorSpaceProfile: z.string().optional(),
  transformPresetKey: z.string().optional(),
});
export type IMediaRootColorConfig = z.infer<typeof IMediaRootColorConfig>;

export const ICaptureTimePolicyConfig = z.object({
  mode: ECaptureTimePolicyMode.default('auto'),
  requiredKinds: z.array(ECaptureTimePolicyKind).optional(),
  reason: z.string().optional(),
});
export type ICaptureTimePolicyConfig = z.infer<typeof ICaptureTimePolicyConfig>;

export const IMediaRootAlternatePath = z.object({
  path: z.string().optional(),
  rawPath: z.string().optional(),
});
export type IMediaRootAlternatePath = z.infer<typeof IMediaRootAlternatePath>;

export const IMediaRoot = z.object({
  id: z.string(),
  rootCode: z.string().optional(),
  path: z.string().optional(),
  rawPath: z.string().optional(),
  flightRecordPath: z.string().optional(),
  alternatePaths: z.array(IMediaRootAlternatePath).optional(),
  label: z.string().optional(),
  enabled: z.boolean(),
  clockOffsetMs: z.number().int().optional(),
  category: EMediaRootCategory.optional(),
  priority: z.number().optional(),
  description: z.string().optional(),
  notes: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  captureTimePolicy: ICaptureTimePolicyConfig.optional(),
  color: IMediaRootColorConfig.optional(),
});
export type IMediaRoot = z.infer<typeof IMediaRoot>;

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
  shotKind: z.string().optional(),
  shotLocation: z.string().optional(),
  shotDescription: z.string().optional(),
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
  rawCapturedAt: z.string().optional(),
  appliedClockOffsetMs: z.number().int().optional(),
  captureTimeSource: ECaptureTimeSource.optional(),
  captureTimeConfidence: z.number().min(0).max(1).optional(),
  createdAt: z.string().optional(),
  ingestedAt: z.string().optional(),
  embeddedGps: IEmbeddedGpsBinding.optional(),
  protectionAudio: IProtectionAudioBinding.optional(),
  metadata: z.record(z.unknown()).optional(),
});
export type IKtepAsset = z.infer<typeof IKtepAsset>;

export const IMaterialPattern = z.string();
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
  visualObservation: z.string().optional(),
  sourceInterestingWindowIds: z.array(z.string()).optional(),
  sourceWindowReason: z.string().optional(),
  materialPatterns: z.array(IMaterialPattern).default([]),
  grounding: ISpanGrounding.default({
    speechMode: 'none',
    speechValue: 'none',
    spatialEvidence: [],
    pharosRefs: [],
  }),
  pharosRefs: z.array(IPharosRef).optional(),
  speechCoverage: z.number().min(0).max(1).optional(),
  speedCandidate: z.object({
    suggestedSpeeds: z.array(z.number().positive()).min(1),
    rationale: z.string(),
    confidence: z.number().min(0).max(1).optional(),
  }).optional(),
}).strict();
export type IKtepSpan = z.infer<typeof IKtepSpan>;
export const IKtepSlice = IKtepSpan;
export type IKtepSlice = IKtepSpan;

export const ISpansMeta = z.object({
  schemaVersion: z.literal('1.0'),
  status: z.enum(['fresh', 'stale', 'pending-speech-review']),
  generatedAt: z.string(),
  inputsHash: z.string(),
  assetCount: z.number().int().nonnegative(),
  reportCount: z.number().int().nonnegative(),
  spanCount: z.number().int().nonnegative(),
  speechReview: z.object({
    status: z.enum(['not-required', 'pending', 'completed']).optional(),
    candidateCount: z.number().int().nonnegative().optional(),
    handoffPath: z.string().optional(),
    updatedAt: z.string().optional(),
  }).optional(),
  warnings: z.array(z.string()).default([]),
}).strict();
export type ISpansMeta = z.infer<typeof ISpansMeta>;

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
  audioSelections: z.array(IKtepScriptSelection),
  visualSelections: z.array(IKtepScriptSelection),
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
  audioGainDb: z.number().optional(),
  audioSource: z.enum(['embedded', 'protection']).optional(),
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

export const EStyleProfileVersion = z.enum(['legacy', 'layered-v1']);
export type EStyleProfileVersion = z.infer<typeof EStyleProfileVersion>;

export const EStyleLayerKey = z.enum(['literary', 'artistic', 'editingTechnical']);
export type EStyleLayerKey = z.infer<typeof EStyleLayerKey>;

export const EStyleUsageMode = z.enum(['off', 'soft', 'hard']);
export type EStyleUsageMode = z.infer<typeof EStyleUsageMode>;

export const IStyleLayer = z.object({
  summary: z.string().default('未明确'),
  confidence: z.number().min(0).max(1).default(0),
  evidenceNotes: z.array(z.string()).default([]),
  parameters: z.record(z.string()).default({}),
  antiPatterns: z.array(z.string()).default([]),
});
export type IStyleLayer = z.infer<typeof IStyleLayer>;

export const IStyleLayers = z.object({
  literary: IStyleLayer,
  artistic: IStyleLayer,
  editingTechnical: IStyleLayer,
});
export type IStyleLayers = z.infer<typeof IStyleLayers>;

export const IStyleProfile = z.object({
  id: z.string(),
  name: z.string(),
  category: z.string().optional(),
  styleProfileVersion: EStyleProfileVersion.default('legacy'),
  guidancePrompt: z.string().optional(),
  sourceFiles: z.array(z.string()),
  narrative: IStyleNarrative,
  voice: IStyleVoice,
  rawReference: z.string().optional(),
  sections: z.array(IStyleSection).optional(),
  antiPatterns: z.array(z.string()).optional(),
  parameters: z.record(z.string()).optional(),
  layers: IStyleLayers.optional(),
  arrangementStructure: IStyleArrangementStructure,
  narrationConstraints: IStyleNarrationConstraints,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type IStyleProfile = z.infer<typeof IStyleProfile>;

export const IStyleUsageLayer = z.object({
  mode: EStyleUsageMode.default('off'),
  appliesTo: z.array(z.string()).default([]),
  rationale: z.string().optional(),
});
export type IStyleUsageLayer = z.infer<typeof IStyleUsageLayer>;

export const IStyleUsage = z.object({
  styleCategory: z.string().optional(),
  styleProfileHash: z.string().optional(),
  styleProfileVersion: EStyleProfileVersion.optional(),
  layers: z.object({
    literary: IStyleUsageLayer.default({ mode: 'off', appliesTo: [] }),
    artistic: IStyleUsageLayer.default({ mode: 'off', appliesTo: [] }),
    editingTechnical: IStyleUsageLayer.default({ mode: 'off', appliesTo: [] }),
  }).default({
    literary: { mode: 'off', appliesTo: [] },
    artistic: { mode: 'off', appliesTo: [] },
    editingTechnical: { mode: 'off', appliesTo: [] },
  }),
  rationale: z.string().optional(),
});
export type IStyleUsage = z.infer<typeof IStyleUsage>;

// ─── Media Analysis ─────────────────────────────────────────

export const ISpeedCandidateHint = z.object({
  suggestedSpeeds: z.array(z.number().positive()).min(1),
  rationale: z.string(),
  confidence: z.number().min(0).max(1).optional(),
});
export type ISpeedCandidateHint = z.infer<typeof ISpeedCandidateHint>;

export const IInterestingWindow = z.object({
  windowId: z.string().optional(),
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

export const EFineScanWindowStatus = z.enum(['recognized', 'dropped']);
export type EFineScanWindowStatus = z.infer<typeof EFineScanWindowStatus>;

export const IFineScanWindow = z.object({
  windowId: z.string(),
  sourceInMs: z.number().optional(),
  sourceOutMs: z.number().optional(),
  editSourceInMs: z.number().optional(),
  editSourceOutMs: z.number().optional(),
  semanticKind: EWindowSemantic.optional(),
  reason: z.string().optional(),
  sourceInterestingWindowIds: z.array(z.string()).optional(),
  sourceWindowReason: z.string().optional(),
  transcript: z.string().optional(),
  transcriptSegments: z.array(ITranscriptSegment).optional(),
  speechCoverage: z.number().min(0).max(1).optional(),
  speedCandidate: ISpeedCandidateHint.optional(),
  frameTimestampsMs: z.array(z.number()).default([]),
  framePaths: z.array(z.string()).default([]),
  visualObservation: z.string().optional(),
  status: EFineScanWindowStatus,
  dropReason: z.string().optional(),
});
export type IFineScanWindow = z.infer<typeof IFineScanWindow>;

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
  fineScanWindows: z.array(IFineScanWindow).default([]),
  fineScanReasons: z.array(z.string()),
  fineScanCompletedAt: z.string().optional(),
  fineScanSliceCount: z.number().int().min(0).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type IAssetCoarseReport = z.infer<typeof IAssetCoarseReport>;

export const EChronologyStatus = z.enum(['draft', 'confirmed', 'stale']);
export type EChronologyStatus = z.infer<typeof EChronologyStatus>;

export const EChronologyEventKind = z.enum(['event', 'route', 'gap']);
export type EChronologyEventKind = z.infer<typeof EChronologyEventKind>;

export const EChronologyReviewStatus = z.enum(['pending', 'confirmed', 'rejected']);
export type EChronologyReviewStatus = z.infer<typeof EChronologyReviewStatus>;

export const IChronologyAssetIndex = z.object({
  assetId: z.string(),
  sortCapturedAt: z.string().optional(),
}).strict();
export type IChronologyAssetIndex = z.infer<typeof IChronologyAssetIndex>;

export const IChronologyEvent = z.object({
  id: z.string(),
  kind: EChronologyEventKind,
  reviewStatus: EChronologyReviewStatus,
  title: z.string(),
  summary: z.string().optional(),
  startAt: z.string().optional(),
  endAt: z.string().optional(),
  location: z.string().optional(),
  route: z.object({
    from: z.string().optional(),
    to: z.string().optional(),
  }).strict().optional(),
  spanIds: z.array(z.string()),
}).strict();
export type IChronologyEvent = z.infer<typeof IChronologyEvent>;

export const IProjectChronology = z.object({
  schemaVersion: z.literal('2.0'),
  status: EChronologyStatus,
  generatedAt: z.string(),
  updatedAt: z.string().optional(),
  confirmedAt: z.string().optional(),
  inputsHash: z.string(),
  assetIndex: z.array(IChronologyAssetIndex),
  events: z.array(IChronologyEvent),
}).strict();
export type IProjectChronology = z.infer<typeof IProjectChronology>;

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

export const IMaterialSlotTreatment = z.object({
  audio: z.number().optional(),
  speed: z.number().positive().optional(),
}).strict();
export type IMaterialSlotTreatment = z.infer<typeof IMaterialSlotTreatment>;

export const IMaterialSlot = z.object({
  id: z.string(),
  query: z.string(),
  requirement: EMaterialSlotRequirement.default('required'),
  targetBundles: z.array(z.string()).default([]),
  chosenSpanIds: z.array(z.string()).default([]),
  treatments: z.record(IMaterialSlotTreatment),
});
export type IMaterialSlot = z.infer<typeof IMaterialSlot>;

export const ISegmentMaterialSlotGroup = z.object({
  segmentId: z.string(),
  slots: z.array(IMaterialSlot).default([]),
});
export type ISegmentMaterialSlotGroup = z.infer<typeof ISegmentMaterialSlotGroup>;

export const IMaterialRecallCoverageAuditRow = z.object({
  key: z.string(),
  label: z.string().optional(),
  available: z.number().int().nonnegative(),
  chosen: z.number().int().nonnegative(),
  dropped: z.number().int().nonnegative(),
  droppedSpanIds: z.array(z.string()).default([]),
}).strict();
export type IMaterialRecallCoverageAuditRow = z.infer<typeof IMaterialRecallCoverageAuditRow>;

export const IMaterialRecallCoverageAudit = z.object({
  generatedAt: z.string(),
  byType: z.array(IMaterialRecallCoverageAuditRow).default([]),
  byDay: z.array(IMaterialRecallCoverageAuditRow).default([]),
  byEvent: z.array(IMaterialRecallCoverageAuditRow).default([]),
  speechProtected: z.object({
    available: z.number().int().nonnegative(),
    chosen: z.number().int().nonnegative(),
    dropped: z.number().int().nonnegative(),
    droppedSpanIds: z.array(z.string()).default([]),
  }).strict(),
  notes: z.array(z.string()).default([]),
}).strict();
export type IMaterialRecallCoverageAudit = z.infer<typeof IMaterialRecallCoverageAudit>;

export const IMaterialSlotsDocument = z.object({
  id: z.string(),
  projectId: z.string(),
  generatedAt: z.string(),
  status: z.enum(['current', 'stale']).optional(),
  staleReason: z.string().optional(),
  segments: z.array(ISegmentMaterialSlotGroup).default([]),
  coverageAudit: IMaterialRecallCoverageAudit.optional(),
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
  details: z.unknown().optional(),
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
  'writer_failed',
  'review_failed',
  'review_error',
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

export const ISegmentSelectionWindow = z.object({
  assetId: z.string(),
  spanId: z.string().optional(),
  sliceId: z.string().optional(),
  defaultSourceInMs: z.number().nonnegative().optional(),
  defaultSourceOutMs: z.number().nonnegative().optional(),
  minSourceInMs: z.number().nonnegative().optional(),
  maxSourceOutMs: z.number().nonnegative().optional(),
});
export type ISegmentSelectionWindow = z.infer<typeof ISegmentSelectionWindow>;

export const ISourceSpeechUnit = z.object({
  assetId: z.string(),
  spanId: z.string().optional(),
  sliceId: z.string().optional(),
  sourceInMs: z.number().nonnegative(),
  sourceOutMs: z.number().nonnegative(),
  transcriptText: z.string().optional(),
});
export type ISourceSpeechUnit = z.infer<typeof ISourceSpeechUnit>;

export const ISubtitleCueDraft = z.object({
  id: z.string(),
  text: z.string(),
  sourceInMs: z.number().nonnegative().optional(),
  sourceOutMs: z.number().nonnegative().optional(),
});
export type ISubtitleCueDraft = z.infer<typeof ISubtitleCueDraft>;

export const ISegmentRoughCutBeatPlan = z.object({
  beatId: z.string(),
  text: z.string(),
  utterances: z.array(IKtepBeatUtterance).optional(),
  notes: z.string().optional(),
  muteSource: z.boolean().optional(),
  preserveNatSound: z.boolean().optional(),
  speedSuggestion: z.number().positive().optional(),
  linkedSpanIds: z.array(z.string()).default([]),
  linkedSliceIds: z.array(z.string()).default([]),
  audioSelections: z.array(IKtepScriptSelection).default([]),
  visualSelections: z.array(IKtepScriptSelection).default([]),
  candidateWindows: z.array(ISegmentSelectionWindow).default([]),
  sourceSpeechUnits: z.array(ISourceSpeechUnit).default([]),
  subtitleCueDrafts: z.array(ISubtitleCueDraft).default([]),
});
export type ISegmentRoughCutBeatPlan = z.infer<typeof ISegmentRoughCutBeatPlan>;

export const ISegmentTimeBandGuard = z.object({
  startPosition: z.number().int().nonnegative(),
  endPosition: z.number().int().nonnegative(),
  startSortKey: z.string().optional(),
  endSortKey: z.string().optional(),
});
export type ISegmentTimeBandGuard = z.infer<typeof ISegmentTimeBandGuard>;

export const ISegmentRoughCutPlan = z.object({
  segmentId: z.string(),
  segmentTitle: z.string().optional(),
  timeBandGuard: ISegmentTimeBandGuard,
  lockedSpanIds: z.array(z.string()).default([]),
  beats: z.array(ISegmentRoughCutBeatPlan).default([]),
});
export type ISegmentRoughCutPlan = z.infer<typeof ISegmentRoughCutPlan>;

export const ITimelineRoughCutBase = z.object({
  id: z.string(),
  projectId: z.string(),
  generatedAt: z.string(),
  segments: z.array(ISegmentRoughCutPlan).default([]),
});
export type ITimelineRoughCutBase = z.infer<typeof ITimelineRoughCutBase>;

export const ISegmentCutReview = z.object({
  segmentId: z.string(),
  stage: z.string(),
  identity: z.string(),
  attempt: z.number().int().positive(),
  verdict: EStageReviewVerdict,
  issues: z.array(IStageReviewIssue).default([]),
  revisionBrief: z.array(z.string()).default([]),
  reviewedAt: z.string(),
});
export type ISegmentCutReview = z.infer<typeof ISegmentCutReview>;

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
  rootId: z.string(),
  rootCode: z.string().optional(),
  path: z.string(),
  rawPath: z.string().optional(),
  alternatePaths: z.array(IMediaRootAlternatePath).optional(),
  description: z.string(),
  flightRecordPath: z.string().optional(),
  enabled: z.boolean().optional(),
  label: z.string().optional(),
  clockOffsetMs: z.number().int().optional(),
  priority: z.number().optional(),
  category: EMediaRootCategory.optional(),
  notes: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  captureTimePolicy: ICaptureTimePolicyConfig.optional(),
  color: z.object({
    renderPreset: z.lazy(() => IColorRenderPreset).optional(),
    colorSpaceProfile: z.string().optional(),
    transformPresetKey: z.string().optional(),
  }).optional(),
});
export type IProjectBriefMappingConfig = z.infer<typeof IProjectBriefMappingConfig>;

export const IColorRenderPreset = z.object({
  container: z.string().optional(),
  videoCodec: z.string().optional(),
  audioCodec: z.string().optional(),
  bitrateKbps: z.number().positive().optional(),
});
export type IColorRenderPreset = z.infer<typeof IColorRenderPreset>;

export const EColorTransformPresetKind = z.enum(['lut']);
export type EColorTransformPresetKind = z.infer<typeof EColorTransformPresetKind>;

export const IColorTransformPresetDefinition = z.object({
  kind: EColorTransformPresetKind,
  displayName: z.string(),
  lutPath: z.string(),
});
export type IColorTransformPresetDefinition = z.infer<typeof IColorTransformPresetDefinition>;

export const IColorTransformPresetsConfig = z.object({
  profiles: z.record(z.record(z.string())).default({}),
  discoveredPresets: z.record(IColorTransformPresetDefinition).default({}),
});
export type IColorTransformPresetsConfig = z.infer<typeof IColorTransformPresetsConfig>;

export const EColorGroupStatus = z.enum([
  'idle',
  'draft',
  'ready',
  'running',
  'staged',
  'blocked',
  'promoted',
  'failed',
]);
export type EColorGroupStatus = z.infer<typeof EColorGroupStatus>;

export const EColorBatchStatus = z.enum([
  'draft',
  'rendering',
  'rendered',
  'staged',
  'validated',
  'promoted',
  'failed',
  'superseded',
]);
export type EColorBatchStatus = z.infer<typeof EColorBatchStatus>;

export const EColorValidationStatus = z.enum(['pending', 'pass', 'fail']);
export type EColorValidationStatus = z.infer<typeof EColorValidationStatus>;

export const EColorValidationCheckResult = z.enum(['pass', 'fail', 'not_present_in_source']);
export type EColorValidationCheckResult = z.infer<typeof EColorValidationCheckResult>;

export const EColorBatchSelectionMode = z.enum(['all', 'subset']);
export type EColorBatchSelectionMode = z.infer<typeof EColorBatchSelectionMode>;

export const EColorGroupLowlightStatus = z.enum(['base', 'lowlight', 'mixed']);
export type EColorGroupLowlightStatus = z.infer<typeof EColorGroupLowlightStatus>;

export const EColorCastClass = z.enum(['neutral', 'cool-cyan', 'green-cyan', 'green', 'warm', 'mixed', 'unknown']);
export type EColorCastClass = z.infer<typeof EColorCastClass>;

export const EColorExposureSceneClass = z.enum(['normal', 'high-contrast', 'overexposed', 'underexposed', 'unknown']);
export type EColorExposureSceneClass = z.infer<typeof EColorExposureSceneClass>;

export const EColorGroupPostClipCreativeStatus = z.enum(['missing', 'empty', 'ready']);
export type EColorGroupPostClipCreativeStatus = z.infer<typeof EColorGroupPostClipCreativeStatus>;

export const EColorGyroflowStatus = z.enum(['not-applicable', 'not-seeded', 'seeded-disabled', 'ready-to-load', 'active']);
export type EColorGyroflowStatus = z.infer<typeof EColorGyroflowStatus>;

export const EColorNoiseReductionStatus = z.enum(['not-seeded', 'seeded-disabled', 'seeded-enabled']);
export type EColorNoiseReductionStatus = z.infer<typeof EColorNoiseReductionStatus>;

export const EColorClipRepairStatus = z.enum(['missing', 'skeleton-only', 'pending-template', 'pending-orientation-template', 'partial', 'ready']);
export type EColorClipRepairStatus = z.infer<typeof EColorClipRepairStatus>;

export const EColorClipLayoutStatus = z.enum(['canonical', 'legacy-layout']);
export type EColorClipLayoutStatus = z.infer<typeof EColorClipLayoutStatus>;

export const EColorClipOrientationStatus = z.enum(['unknown', 'horizontal', 'portrait']);
export type EColorClipOrientationStatus = z.infer<typeof EColorClipOrientationStatus>;

export const IColorClipTimelineTransform = z.object({
  rotationAngle: z.number().optional(),
  zoomX: z.number().positive().optional(),
  zoomY: z.number().positive().optional(),
  zoomGang: z.boolean().optional(),
  pan: z.number().optional(),
  tilt: z.number().optional(),
});
export type IColorClipTimelineTransform = z.infer<typeof IColorClipTimelineTransform>;

export const IColorClipReservedNodeIndices = z.object({
  gyro: z.number().int().positive().optional(),
  userStart: z.number().int().positive().optional(),
  userEnd: z.number().int().positive().optional(),
  dehaze: z.number().int().positive().optional(),
  nr: z.number().int().positive().optional(),
});
export type IColorClipReservedNodeIndices = z.infer<typeof IColorClipReservedNodeIndices>;

export const IColorClipRepairSnapshot = z.object({
  clipKey: z.string(),
  displayName: z.string().optional(),
  logProfile: z.string().optional(),
  lowlight: z.boolean().optional(),
  colorCastClass: EColorCastClass.optional(),
  colorCastConfidence: z.number().min(0).max(1).optional(),
  colorCastMetrics: z.record(z.unknown()).default({}),
  exposureSceneClass: EColorExposureSceneClass.optional(),
  exposureSceneConfidence: z.number().min(0).max(1).optional(),
  exposureSceneMetrics: z.record(z.unknown()).default({}),
  encodedWidth: z.number().int().positive().optional(),
  encodedHeight: z.number().int().positive().optional(),
  displayWidth: z.number().int().positive().optional(),
  displayHeight: z.number().int().positive().optional(),
  rotationDegrees: z.number().optional(),
  orientationStatus: EColorClipOrientationStatus.optional(),
  repairTemplateKey: z.string().optional(),
  repairTemplateHash: z.string().optional(),
  timelineTransform: IColorClipTimelineTransform.optional(),
  gyroDataAvailable: z.boolean().optional(),
  gyroEligible: z.boolean().optional(),
  gyroflowStatus: EColorGyroflowStatus.optional(),
  dehazeStatus: EColorNoiseReductionStatus.optional(),
  nrStatus: EColorNoiseReductionStatus.optional(),
  clipRepairStatus: EColorClipRepairStatus.optional(),
  layoutStatus: EColorClipLayoutStatus.optional(),
  reservedNodeIndices: IColorClipReservedNodeIndices.optional(),
  hostSummary: z.record(z.unknown()).default({}),
});
export type IColorClipRepairSnapshot = z.infer<typeof IColorClipRepairSnapshot>;

export const IColorGroupConfig = z.object({
  groupKey: z.string(),
  displayName: z.string().optional(),
  technicalSummary: z.array(z.string()).default([]),
  creativeLookKey: z.string().optional(),
});
export type IColorGroupConfig = z.infer<typeof IColorGroupConfig>;

export const IColorRootConfig = z.object({
  rootId: z.string(),
  resolveProjectName: z.string().optional(),
  rootNamespace: z.string().optional(),
  gradingTimelineName: z.string().optional(),
  renderPreset: IColorRenderPreset.default({}),
  groups: z.array(IColorGroupConfig).default([]),
  updatedAt: z.string().optional(),
});
export type IColorRootConfig = z.infer<typeof IColorRootConfig>;

export const IColorConfig = z.object({
  roots: z.array(IColorRootConfig).default([]),
  updatedAt: z.string().optional(),
});
export type IColorConfig = z.infer<typeof IColorConfig>;

export const IColorRenderSupportContainer = z.object({
  container: z.string(),
  extension: z.string().optional(),
  videoCodecs: z.array(z.string()).default([]),
});
export type IColorRenderSupportContainer = z.infer<typeof IColorRenderSupportContainer>;

export const IColorRenderSupport = z.object({
  containers: z.array(IColorRenderSupportContainer).default([]),
  supportsAudioCodec: z.boolean().optional(),
  supportsVideoQuality: z.boolean().optional(),
});
export type IColorRenderSupport = z.infer<typeof IColorRenderSupport>;

export const IColorHostPreflight = z.object({
  status: z.enum(['unknown', 'ready', 'degraded', 'blocked']).default('unknown'),
  checkedAt: z.string().optional(),
  productName: z.string().optional(),
  versionString: z.string().optional(),
  isStudio: z.boolean().optional(),
  warnings: z.array(z.string()).default([]),
  blockingReasons: z.array(z.string()).default([]),
  renderSupport: IColorRenderSupport.optional(),
});
export type IColorHostPreflight = z.infer<typeof IColorHostPreflight>;

export const IColorPrepareChunk = z.object({
  chunkId: z.string(),
  index: z.number().int().nonnegative(),
  total: z.number().int().positive(),
  status: z.enum(['pending', 'running', 'ready', 'failed', 'skipped']).default('pending'),
  timelineName: z.string(),
  clipCount: z.number().int().nonnegative().default(0),
  rawRelativePaths: z.array(z.string()).default([]),
  fingerprint: z.string().optional(),
  completedAt: z.string().optional(),
  detail: z.string().optional(),
});
export type IColorPrepareChunk = z.infer<typeof IColorPrepareChunk>;

export const IColorResolveProjectSnapshot = z.object({
  projectName: z.string(),
  snapshotPath: z.string(),
  latestPath: z.string().optional(),
  createdAt: z.string(),
  mode: z.enum(['auto', 'manual', 'external']).default('auto'),
  action: z.string().optional(),
  rootId: z.string().optional(),
  chunkId: z.string().optional(),
  database: z.record(z.unknown()).optional(),
  detail: z.string().optional(),
});
export type IColorResolveProjectSnapshot = z.infer<typeof IColorResolveProjectSnapshot>;

export const IColorResolveProjectMapEntry = z.object({
  projectName: z.string(),
  safeProjectName: z.string(),
  latestSnapshot: IColorResolveProjectSnapshot.optional(),
  snapshots: z.array(IColorResolveProjectSnapshot).default([]),
  updatedAt: z.string().optional(),
});
export type IColorResolveProjectMapEntry = z.infer<typeof IColorResolveProjectMapEntry>;

export const IColorResolveProjectMap = z.object({
  updatedAt: z.string().optional(),
  projects: z.record(IColorResolveProjectMapEntry).default({}),
});
export type IColorResolveProjectMap = z.infer<typeof IColorResolveProjectMap>;

export const IColorGroupCurrent = z.object({
  groupKey: z.string(),
  status: EColorGroupStatus,
  displayName: z.string().optional(),
  clipCount: z.number().int().nonnegative().optional(),
  logProfile: z.string().optional(),
  orientationStatus: EColorClipOrientationStatus.optional(),
  lowlight: EColorGroupLowlightStatus.optional(),
  colorCastClass: EColorCastClass.optional(),
  exposureSceneClass: EColorExposureSceneClass.optional(),
  postClipCreativeStatus: EColorGroupPostClipCreativeStatus.optional(),
  latestBatchId: z.string().optional(),
  latestBatchStatus: EColorBatchStatus.optional(),
  latestValidationStatus: EColorValidationStatus.optional(),
  pendingPromoteBatchId: z.string().optional(),
  lastPromotedBatchId: z.string().optional(),
  blockingReasons: z.array(z.string()).default([]),
});
export type IColorGroupCurrent = z.infer<typeof IColorGroupCurrent>;

export const IColorRootCurrent = z.object({
  rootId: z.string(),
  mirrorStatus: z.enum(['idle', 'running', 'ready', 'synced', 'stale', 'blocked']).optional(),
  timelineStatus: z.enum(['idle', 'running', 'missing', 'ready', 'blocked']).optional(),
  groupSyncStatus: z.enum(['idle', 'running', 'missing', 'ready', 'blocked']).optional(),
  groupSyncAt: z.string().optional(),
  activeStage: z.string().optional(),
  currentJobId: z.string().optional(),
  detail: z.string().optional(),
  pendingPromoteBatchId: z.string().optional(),
  latestBatchId: z.string().optional(),
  latestBatchStatus: EColorBatchStatus.optional(),
  latestValidationStatus: EColorValidationStatus.optional(),
  lastPromotedBatchId: z.string().optional(),
  hostSummary: z.record(z.unknown()).default({}),
  prepareChunks: z.array(IColorPrepareChunk).default([]),
  latestDrpSnapshot: IColorResolveProjectSnapshot.optional(),
  groups: z.array(IColorGroupCurrent).default([]),
  blockingReasons: z.array(z.string()).default([]),
});
export type IColorRootCurrent = z.infer<typeof IColorRootCurrent>;

export const IColorCurrent = z.object({
  selectedRootId: z.string().optional(),
  roots: z.array(IColorRootCurrent).default([]),
  hostPreflight: IColorHostPreflight.optional(),
  updatedAt: z.string().optional(),
});
export type IColorCurrent = z.infer<typeof IColorCurrent>;

export const IColorGroupSnapshot = z.object({
  groupKey: z.string(),
  displayName: z.string().optional(),
  clipKeys: z.array(z.string()).default([]),
  logProfile: z.string().optional(),
  orientationStatus: EColorClipOrientationStatus.optional(),
  lowlight: EColorGroupLowlightStatus.optional(),
  colorCastClass: EColorCastClass.optional(),
  exposureSceneClass: EColorExposureSceneClass.optional(),
  postClipCreativeStatus: EColorGroupPostClipCreativeStatus.optional(),
  clips: z.array(IColorClipRepairSnapshot).default([]),
  hostSummary: z.record(z.unknown()).default({}),
});
export type IColorGroupSnapshot = z.infer<typeof IColorGroupSnapshot>;

export const IColorGroupsSnapshotFile = z.object({
  rootId: z.string(),
  syncedAt: z.string().optional(),
  timelineName: z.string().optional(),
  groups: z.array(IColorGroupSnapshot).default([]),
});
export type IColorGroupsSnapshotFile = z.infer<typeof IColorGroupsSnapshotFile>;

export const IColorFileMetadataSnapshot = z.object({
  mediaKind: EAssetKind.optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  displayWidth: z.number().int().positive().optional(),
  displayHeight: z.number().int().positive().optional(),
  rotationDegrees: z.number().optional(),
  fps: z.number().positive().optional(),
  durationMs: z.number().nonnegative().optional(),
  capturedAt: z.string().optional(),
  createTime: z.string().optional(),
  gps: z.tuple([z.number(), z.number()]).optional(),
  filesystemCreateTime: z.string().optional(),
});
export type IColorFileMetadataSnapshot = z.infer<typeof IColorFileMetadataSnapshot>;

export const IColorBatchPlanEntry = z.object({
  rawRelativePath: z.string(),
  sourceAbsolutePath: z.string(),
  sourceStem: z.string().optional(),
  outputPath: z.string().optional(),
  sourceMetadataSnapshot: IColorFileMetadataSnapshot.optional(),
});
export type IColorBatchPlanEntry = z.infer<typeof IColorBatchPlanEntry>;

export const IColorBatchSidecar = z.object({
  sourceRelativePath: z.string(),
  sourceAbsolutePath: z.string(),
  outputRelativePath: z.string(),
  outputPath: z.string(),
  extension: z.string(),
  sizeBytes: z.number().int().nonnegative().optional(),
});
export type IColorBatchSidecar = z.infer<typeof IColorBatchSidecar>;

export const IColorBatchRenderJob = z.object({
  jobId: z.string().optional(),
  timelineName: z.string().optional(),
  targetDir: z.string(),
  clipCount: z.number().int().nonnegative().default(0),
  duplicateStemGroup: z.string().optional(),
});
export type IColorBatchRenderJob = z.infer<typeof IColorBatchRenderJob>;

export const IColorBatchPlan = z.object({
  batchId: z.string(),
  rootId: z.string(),
  createdAt: z.string(),
  outputRoot: z.string(),
  renderPreset: IColorRenderPreset,
  selectionMode: EColorBatchSelectionMode.default('all'),
  clipKeys: z.array(z.string()).default([]),
  overwritePlanHash: z.string().optional(),
  renderJobs: z.array(IColorBatchRenderJob).default([]),
  entries: z.array(IColorBatchPlanEntry).default([]),
});
export type IColorBatchPlan = z.infer<typeof IColorBatchPlan>;

export const IColorBatchManifestEntry = z.object({
  rawRelativePath: z.string(),
  outputPath: z.string(),
  normalizedOutputFilename: z.string(),
  sourceStem: z.string().optional(),
  renderJobId: z.string().optional(),
  sourceMetadataSnapshot: IColorFileMetadataSnapshot.optional(),
  outputMetadataSnapshot: IColorFileMetadataSnapshot.optional(),
  sidecars: z.array(IColorBatchSidecar).default([]),
});
export type IColorBatchManifestEntry = z.infer<typeof IColorBatchManifestEntry>;

export const EColorMetadataRepairStatus = z.enum(['pending', 'completed', 'failed']);
export type EColorMetadataRepairStatus = z.infer<typeof EColorMetadataRepairStatus>;

export const IColorMetadataRepairFailedOutput = z.object({
  rawRelativePath: z.string().optional(),
  outputPath: z.string(),
  reason: z.string(),
});
export type IColorMetadataRepairFailedOutput = z.infer<typeof IColorMetadataRepairFailedOutput>;

export const IColorBatchMetadataRepair = z.object({
  status: EColorMetadataRepairStatus.default('pending'),
  repairedCount: z.number().int().nonnegative().default(0),
  failedOutputs: z.array(IColorMetadataRepairFailedOutput).default([]),
  warnings: z.array(z.string()).default([]),
});
export type IColorBatchMetadataRepair = z.infer<typeof IColorBatchMetadataRepair>;

export const IColorBatchManifest = z.object({
  batchId: z.string(),
  rootId: z.string(),
  createdAt: z.string(),
  renderPreset: IColorRenderPreset,
  managedOutputSet: z.array(z.string()).default([]),
  managedSidecarSet: z.array(z.string()).default([]),
  renderJobs: z.array(IColorBatchRenderJob).default([]),
  metadataRepair: IColorBatchMetadataRepair.optional(),
  entries: z.array(IColorBatchManifestEntry).default([]),
});
export type IColorBatchManifest = z.infer<typeof IColorBatchManifest>;

export const IColorBatchValidationChecks = z.object({
  pathMirror: EColorValidationCheckResult,
  filenameNormalized: EColorValidationCheckResult,
  mediaKind: EColorValidationCheckResult,
  resolution: EColorValidationCheckResult,
  fps: EColorValidationCheckResult,
  duration: EColorValidationCheckResult,
  capturedAt: EColorValidationCheckResult,
  createTime: EColorValidationCheckResult,
  gps: EColorValidationCheckResult,
  filesystemCreateTime: EColorValidationCheckResult,
});
export type IColorBatchValidationChecks = z.infer<typeof IColorBatchValidationChecks>;

export const IColorBatchValidationEntry = z.object({
  rawRelativePath: z.string(),
  outputPath: z.string().optional(),
  status: z.enum(['pass', 'fail']),
  reasons: z.array(z.string()).default([]),
  warnings: z.array(z.string()).default([]),
  checks: IColorBatchValidationChecks,
});
export type IColorBatchValidationEntry = z.infer<typeof IColorBatchValidationEntry>;

export const IColorBatchValidationSummary = z.object({
  targetCount: z.number().int().nonnegative().default(0),
  renderedCount: z.number().int().nonnegative().default(0),
  passedCount: z.number().int().nonnegative().default(0),
  failedCount: z.number().int().nonnegative().default(0),
});
export type IColorBatchValidationSummary = z.infer<typeof IColorBatchValidationSummary>;

export const IColorBatchValidation = z.object({
  batchId: z.string(),
  rootId: z.string(),
  validatedAt: z.string(),
  status: z.enum(['pass', 'fail']),
  summary: IColorBatchValidationSummary.default({}),
  blockingReasons: z.array(z.string()).default([]),
  warnings: z.array(z.string()).default([]),
  entries: z.array(IColorBatchValidationEntry).default([]),
});
export type IColorBatchValidation = z.infer<typeof IColorBatchValidation>;

export const IColorBatchPromote = z.object({
  batchId: z.string(),
  rootId: z.string(),
  promotedAt: z.string(),
  status: z.enum(['completed', 'failed']),
  outputs: z.array(z.string()).default([]),
  sidecarOutputs: z.array(z.string()).default([]),
  deletedOutputs: z.array(z.string()).default([]),
  detail: z.string().optional(),
});
export type IColorBatchPromote = z.infer<typeof IColorBatchPromote>;

export const IColorOverwritePreviewTarget = z.object({
  rawRelativePath: z.string(),
  sourceStem: z.string(),
  outputPath: z.string(),
  exists: z.boolean().default(false),
  sizeBytes: z.number().int().nonnegative().optional(),
  modifiedAt: z.string().optional(),
});
export type IColorOverwritePreviewTarget = z.infer<typeof IColorOverwritePreviewTarget>;

export const IColorOverwritePreviewDirectory = z.object({
  directory: z.string(),
  clipCount: z.number().int().nonnegative().default(0),
  existingCount: z.number().int().nonnegative().default(0),
});
export type IColorOverwritePreviewDirectory = z.infer<typeof IColorOverwritePreviewDirectory>;

export const IColorOverwritePreviewDuplicateStemGroup = z.object({
  sourceStem: z.string(),
  rawRelativePaths: z.array(z.string()).default([]),
});
export type IColorOverwritePreviewDuplicateStemGroup = z.infer<typeof IColorOverwritePreviewDuplicateStemGroup>;

export const IColorOverwritePreviewRoot = z.object({
  projectId: z.string(),
  rootId: z.string().optional(),
  mode: z.enum(['execute_root', 'export_all_roots']),
  outputRoot: z.string().optional(),
  rawRoot: z.string().optional(),
  clipCount: z.number().int().nonnegative().default(0),
  existingCount: z.number().int().nonnegative().default(0),
  targets: z.array(IColorOverwritePreviewTarget).default([]),
  byDirectory: z.array(IColorOverwritePreviewDirectory).default([]),
  duplicateStemGroups: z.array(IColorOverwritePreviewDuplicateStemGroup).default([]),
  overwritePlanHash: z.string(),
  rootHashes: z.record(z.string()).default({}),
});
export type IColorOverwritePreviewRoot = z.infer<typeof IColorOverwritePreviewRoot>;

export const IColorOverwritePreview = IColorOverwritePreviewRoot.extend({
  roots: z.array(IColorOverwritePreviewRoot).default([]),
});
export type IColorOverwritePreview = z.infer<typeof IColorOverwritePreview>;

export const IColorBatchArchiveItem = z.object({
  batchId: z.string(),
  rootId: z.string(),
  plan: IColorBatchPlan.optional(),
  manifest: IColorBatchManifest.optional(),
  validation: IColorBatchValidation.optional(),
  promote: IColorBatchPromote.optional(),
});
export type IColorBatchArchiveItem = z.infer<typeof IColorBatchArchiveItem>;

export const IColorRootArchiveView = z.object({
  rootId: z.string(),
  recentBatches: z.array(IColorBatchArchiveItem).default([]),
  validationFailures: z.array(IColorBatchArchiveItem).default([]),
  promoteHistory: z.array(IColorBatchArchiveItem).default([]),
});
export type IColorRootArchiveView = z.infer<typeof IColorRootArchiveView>;

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

export const IProjectPharosActualCapture = z.object({
  type: z.string().optional(),
  camera: z.string().optional(),
  lens: z.string().nullable().optional(),
});
export type IProjectPharosActualCapture = z.infer<typeof IProjectPharosActualCapture>;

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
  actualCaptures: z.array(IProjectPharosActualCapture).default([]),
  gps: z.tuple([z.number(), z.number()]).optional(),
  gpsStart: z.tuple([z.number(), z.number()]).optional(),
  gpsEnd: z.tuple([z.number(), z.number()]).optional(),
  plannedTimeStart: z.string().optional(),
  plannedTimeEnd: z.string().optional(),
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
  parserVersion: z.number().int().positive().optional(),
  generatedAt: z.string(),
  status: EPharosAssetState,
  rootPath: z.string(),
  discoveredTripIds: z.array(z.string()).default([]),
  includedTripIds: z.array(z.string()).default([]),
  warnings: z.array(z.string()).default([]),
  errors: z.array(z.string()).default([]),
  sourceFingerprint: z.string().optional(),
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
  requiresExplicitDate: z.boolean().optional(),
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
  editId: z.string().optional(),
  editLabel: z.string().optional(),
  editRuleCategory: z.string().optional(),
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

export const IEditUnitConfig = z.object({
  schemaVersion: z.literal('1.0'),
  editId: z.string(),
  editRuleCategory: z.string().optional(),
  styleCategory: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type IEditUnitConfig = z.infer<typeof IEditUnitConfig>;

export const IEditRuleCategoryConfig = z.object({
  categoryId: z.string(),
  displayName: z.string(),
  description: z.string().optional(),
  profilePath: z.string().optional(),
  rulePath: z.string().optional(),
  contentHash: z.string().optional(),
  notes: z.array(z.string()).default([]),
});
export type IEditRuleCategoryConfig = z.infer<typeof IEditRuleCategoryConfig>;

export const IEditRulesConfig = z.object({
  defaultCategory: z.string().optional(),
  categories: z.array(IEditRuleCategoryConfig).default([]),
});
export type IEditRulesConfig = z.infer<typeof IEditRulesConfig>;

export const IEditRuleMarkdownSource = z.object({
  categoryId: z.string(),
  displayName: z.string(),
  description: z.string().optional(),
  profilePath: z.string(),
  absolutePath: z.string().optional(),
  contentHash: z.string(),
  frontMatter: z.record(z.string()).default({}),
  markdown: z.string(),
});
export type IEditRuleMarkdownSource = z.infer<typeof IEditRuleMarkdownSource>;

export const EEditFlowPlanStatus = z.enum(['draft', 'confirmed', 'stale']);
export type EEditFlowPlanStatus = z.infer<typeof EEditFlowPlanStatus>;

export const EEditFlowGate = z.enum(['none', 'human']);
export type EEditFlowGate = z.infer<typeof EEditFlowGate>;

export const EEditFlowRunnerStrategy = z.enum(['deterministic', 'agent', 'script', 'manual']);
export type EEditFlowRunnerStrategy = z.infer<typeof EEditFlowRunnerStrategy>;

export const EEditFlowExecutionMode = z.enum(['single-agent', 'sharded-agent', 'deterministic', 'manual']);
export type EEditFlowExecutionMode = z.infer<typeof EEditFlowExecutionMode>;

export const EEditFlowShardBy = z.enum(['none', 'day', 'event', 'scene', 'topic', 'segment']);
export type EEditFlowShardBy = z.infer<typeof EEditFlowShardBy>;

export const EEditFlowShardPackingBase = z.enum(['day']);
export type EEditFlowShardPackingBase = z.infer<typeof EEditFlowShardPackingBase>;

export const EEditFlowShardPackingMetric = z.enum(['chronologyEventCount', 'materialRefCount']);
export type EEditFlowShardPackingMetric = z.infer<typeof EEditFlowShardPackingMetric>;

export const IEditFlowShardPacking = z.object({
  base: EEditFlowShardPackingBase,
  metric: EEditFlowShardPackingMetric,
  maxPerShard: z.number().int().positive(),
  preserveOrder: z.boolean().default(true),
});
export type IEditFlowShardPacking = z.infer<typeof IEditFlowShardPacking>;

export const IEditFlowCodexSubagentProfile = z.object({
  reasoningEffort: z.enum(['low', 'medium', 'high', 'xhigh']).default('high'),
  forkContext: z.boolean().default(false),
  speed: z.enum(['standard']).default('standard'),
});
export type IEditFlowCodexSubagentProfile = z.infer<typeof IEditFlowCodexSubagentProfile>;

export const IEditFlowStepExecution = z.object({
  mode: EEditFlowExecutionMode,
  shardBy: EEditFlowShardBy,
  shardPacking: IEditFlowShardPacking.optional(),
  codexSubagentProfile: IEditFlowCodexSubagentProfile.optional(),
  reason: z.string().optional(),
});
export type IEditFlowStepExecution = z.infer<typeof IEditFlowStepExecution>;

export const EEditFlowStepRunStatus = z.enum(['pending', 'running', 'awaiting_review', 'completed', 'failed', 'stale']);
export type EEditFlowStepRunStatus = z.infer<typeof EEditFlowStepRunStatus>;

export const IEditFlowPlanStep = z.object({
  id: z.string(),
  capabilityId: z.string(),
  title: z.string().optional(),
  inputRefs: z.array(z.string()),
  outputRefs: z.array(z.string()),
  outputTypes: z.record(z.string()).optional(),
  runner: EEditFlowRunnerStrategy.optional(),
  execution: IEditFlowStepExecution.optional(),
  gate: EEditFlowGate,
  notes: z.array(z.string()),
});
export type IEditFlowPlanStep = z.infer<typeof IEditFlowPlanStep>;

export const IEditFlowPlan = z.object({
  schemaVersion: z.literal('1.0'),
  plannerPolicyVersion: z.enum(['rule-explicit-v1', 'rule-explicit-v2', 'codex-agent-v1']).optional(),
  materialIdPolicyVersion: z.literal('human-source-v1').optional(),
  materialTimePolicyVersion: z.literal('normalized-captured-at-v1').optional(),
  id: z.string(),
  projectId: z.string().optional(),
  editId: z.string(),
  editRuleCategory: z.string(),
  editRuleHash: z.string(),
  generatedAt: z.string(),
  updatedAt: z.string().optional(),
  status: EEditFlowPlanStatus,
  confirmedAt: z.string().optional(),
  staleReason: z.string().optional(),
  summary: z.string().optional(),
  assumptions: z.array(z.string()),
  styleUsage: IStyleUsage.optional(),
  steps: z.array(IEditFlowPlanStep),
});
export type IEditFlowPlan = z.infer<typeof IEditFlowPlan>;

export const IEditFlowStepRunReview = z.object({
  status: z.enum(['not_required', 'pending', 'confirmed']).default('not_required'),
  confirmedAt: z.string().optional(),
  confirmedBy: z.string().optional(),
  note: z.string().optional(),
});
export type IEditFlowStepRunReview = z.infer<typeof IEditFlowStepRunReview>;

export const IEditFlowStepRunRecord = z.object({
  schemaVersion: z.literal('1.0'),
  runId: z.string(),
  editId: z.string(),
  flowPlanId: z.string(),
  flowPlanHash: z.string().optional(),
  stepId: z.string(),
  capabilityId: z.string(),
  runner: EEditFlowRunnerStrategy,
  status: EEditFlowStepRunStatus,
  startedAt: z.string(),
  updatedAt: z.string(),
  completedAt: z.string().optional(),
  inputRefs: z.array(z.string()).default([]),
  outputRefs: z.array(z.string()).default([]),
  inputSnapshot: z.record(z.unknown()).default({}),
  outputPaths: z.array(z.string()).default([]),
  summary: z.record(z.unknown()).default({}),
  error: z.string().optional(),
  review: IEditFlowStepRunReview.default({ status: 'not_required' }),
});
export type IEditFlowStepRunRecord = z.infer<typeof IEditFlowStepRunRecord>;

export const IEditFlowRunsState = z.object({
  schemaVersion: z.literal('1.0'),
  editId: z.string(),
  updatedAt: z.string(),
  records: z.array(IEditFlowStepRunRecord).default([]),
});
export type IEditFlowRunsState = z.infer<typeof IEditFlowRunsState>;

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
