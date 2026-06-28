import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, copyFile, mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import nodeFetch from 'node-fetch';
import type { IProjectBriefConfig } from '../../protocol/schema.js';
import { loadProjectBriefConfig, loadRuntimeConfig, writeJson } from '../../store/index.js';
import type { IRuntimeConfig } from '../../store/project.js';
import { probe } from '../media/probe.js';
import { stripGeneratedSubtitlePeriods } from '../nle/subtitle-text.js';

const CDEFAULT_TTS_ENDPOINT = 'https://openspeech.bytedance.com/api/v3/tts/unidirectional';
const CDEFAULT_RESOURCE_ID = 'seed-icl-2.0';
const CDEFAULT_FORMAT = 'mp3';
const CDEFAULT_SAMPLE_RATE = 24000;
const CTTS_TIMEOUT_MS = 120_000;
const CIPC_INTERVAL_MS = 250;

const fetchCompat: typeof fetch = typeof globalThis.fetch === 'function'
  ? globalThis.fetch.bind(globalThis)
  : ((
    input: Parameters<typeof nodeFetch>[0],
    init?: Parameters<typeof nodeFetch>[1],
  ) => nodeFetch(input, init)) as typeof fetch;

export class ResolveVolcVoiceoverError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ResolveVolcVoiceoverError';
  }
}

export interface IResolveVoiceoverSubtitleInput {
  text?: unknown;
  name?: unknown;
  trackIndex?: unknown;
  subtitleIndex?: unknown;
  startFrame?: unknown;
  endFrame?: unknown;
  durationFrames?: unknown;
  timelineInMs?: unknown;
  timelineOutMs?: unknown;
  durationMs?: unknown;
  startTimecode?: unknown;
  endTimecode?: unknown;
  [key: string]: unknown;
}

export interface IResolveVoiceoverJobInput {
  resolveProjectName: string;
  timelineId: string;
  timelineName?: string;
  subtitles: IResolveVoiceoverSubtitleInput[];
  settings?: {
    profileName?: string;
    speedRatio?: number;
    loudnessRatio?: number;
    force?: boolean;
  };
  runId?: string;
}

export interface IResolveVoiceoverProjectMatch {
  projectId: string;
  projectRoot: string;
  projectBriefPath: string;
  projectName: string;
  brief: IProjectBriefConfig;
  matchedKeys: string[];
}

export interface IResolveVoiceoverUnitManifest {
  unitId: string;
  requestId: string;
  requestHash: string;
  cacheHit: boolean;
  text: string;
  subtitle: Record<string, unknown>;
  settings: IVolcTtsPublicSettings;
  audioPath: string;
  rawAudioPath: string;
  resolveAudioPath: string;
  audioRelativePath?: string;
  resolveAudioRelativePath?: string;
  provider: Record<string, unknown>;
  durationMs?: number | null;
  targetDurationMs?: number | null;
  overflowMs?: number | null;
  durationStatus: 'ok' | 'overflow' | 'unknown';
}

export interface IResolveVoiceoverSynthesizeResult {
  manifestPath: string;
  manifest: Record<string, unknown>;
  units: IResolveVoiceoverUnitManifest[];
}

export interface IVolcTtsPublicSettings {
  speaker: string;
  resourceId: string;
  endpoint: string;
  audioFormat: string;
  sampleRate: number;
  model: string;
  language: string;
  speedRatio?: number;
  loudnessRatio?: number;
  contextText: string;
}

interface IVolcTtsSettings extends IVolcTtsPublicSettings {
  apiKey: string;
}

export interface IVolcTtsClient {
  synthesize(text: string, settings: IVolcTtsSettings, requestId?: string): Promise<{
    audio: Buffer;
    requestId: string;
    headers?: Record<string, string>;
    usage?: Record<string, unknown>;
    events?: unknown[];
    subtitles?: unknown[];
  }>;
}

export interface IResolveVoiceoverIpcPaths {
  root: string;
  requestsDir: string;
  processingDir: string;
  responsesDir: string;
}

export interface IResolveVoiceoverIpcServer {
  paths: IResolveVoiceoverIpcPaths;
  processOnce: () => Promise<void>;
  stop: () => void;
}

interface IResolveVoiceoverIpcRequest {
  requestId?: unknown;
  type?: unknown;
  resolveProjectName?: unknown;
  job?: unknown;
}

export function stripResolveProjectSuffix(name: string): string {
  return name.trim().replace(/\s+\[(?:Edit|Color)\]\s*$/iu, '');
}

export function safeSegment(value: unknown, fallback = 'unnamed'): string {
  const text = stringify(value) || fallback;
  return text
    .replace(/[^A-Za-z0-9._ -]+/gu, '_')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 80) || fallback;
}

export function stableHash(value: unknown, length = 16): string {
  return createHash('sha256')
    .update(stableStringify(value))
    .digest('hex')
    .slice(0, length);
}

export function unitIdForSubtitle(timelineId: string, subtitle: Record<string, unknown>): string {
  return `vo_${stableHash({
    timelineId,
    trackIndex: subtitle.trackIndex,
    subtitleIndex: subtitle.subtitleIndex,
    startFrame: subtitle.startFrame,
    endFrame: subtitle.endFrame,
    text: subtitle.text,
  }, 20)}`;
}

export function requestHash(text: string, settings: IVolcTtsPublicSettings): string {
  return stableHash({ text, settings }, 24);
}

export async function buildResolveVolcVoiceoverConfigSummaryTsv(input: {
  workspaceRoot: string;
  resolveProjectName?: string;
}): Promise<string> {
  const runtime = await loadRuntimeConfig(input.workspaceRoot);
  const rows: string[][] = [
    ['VERSION', 'resolve-volc-voiceover-supervisor-v1'],
    ['CONFIG', join(resolve(input.workspaceRoot), 'config', 'runtime.json')],
    ['HAS_API_KEY', runtime.voiceover?.volcApiKey ? '1' : '0'],
    ['DEFAULT', runtime.voiceover?.defaultProfile ?? ''],
  ];

  for (const profile of runtime.voiceover?.profiles ?? []) {
    rows.push(['PROFILE', profile.name, profile.displayName ?? profile.name]);
  }

  if (input.resolveProjectName?.trim()) {
    try {
      const match = await findKairosProjectForResolve(input.workspaceRoot, input.resolveProjectName);
      rows.push(['PROJECT', match.projectId, match.projectName, match.projectRoot]);
      const media = await resolveProjectVoiceoverMedia(match);
      rows.push(['VOICEOVER_MEDIA', 'ready', media.selected.expandedPath ?? '', media.rootId]);
    } catch (error) {
      rows.push(errorToTsvRow(error));
    }
  }

  return formatTsv(rows);
}

export async function synthesizeResolveVolcVoiceoverTsv(input: {
  workspaceRoot: string;
  job: IResolveVoiceoverJobInput;
  client?: IVolcTtsClient;
}): Promise<string> {
  const result = await synthesizeResolveVolcVoiceoverJob(input);
  return formatResolveVolcVoiceoverSynthesizeTsv(result);
}

export function formatResolveVolcVoiceoverSynthesizeTsv(result: IResolveVoiceoverSynthesizeResult): string {
  const rows: string[][] = [
    ['OK', result.manifestPath, String(result.units.length)],
  ];
  for (const unit of result.units) {
    rows.push([
      'UNIT',
      unit.unitId,
      unit.resolveAudioPath,
      String(numberOrBlank(unit.subtitle.startFrame)),
      unit.durationStatus,
      numberOrBlank(unit.durationMs),
      numberOrBlank(unit.targetDurationMs),
      numberOrBlank(unit.overflowMs),
    ]);
  }
  return formatTsv(rows);
}

export async function synthesizeResolveVolcVoiceoverJob(input: {
  workspaceRoot: string;
  job: IResolveVoiceoverJobInput;
  client?: IVolcTtsClient;
}): Promise<IResolveVoiceoverSynthesizeResult> {
  const job = normalizeJobInput(input.job);
  const runtime = await loadRuntimeConfig(input.workspaceRoot);
  const settings = resolveTtsSettings(runtime, job.settings);
  const project = await findKairosProjectForResolve(input.workspaceRoot, job.resolveProjectName);
  const { runDir, metadata } = await buildProjectVoiceoverRunDir({
    workspaceRoot: input.workspaceRoot,
    project,
    resolveProjectName: job.resolveProjectName,
    timelineId: job.timelineId,
    timelineName: job.timelineName,
  });
  const tmpDir = join(project.projectRoot, '.tmp', 'resolve-volc-voiceover-plugin');
  const cacheRoot = join(tmpDir, 'cache');
  const manifestRoot = join(tmpDir, 'manifests', safeSegment(job.runId || new Date().toISOString().replace(/[:.]/gu, '-'), randomUUID()));
  await mkdir(manifestRoot, { recursive: true });

  const units: IResolveVoiceoverUnitManifest[] = [];
  for (const subtitle of mergeSelectedSubtitlesForSynthesis(job.subtitles)) {
    units.push(await synthesizeUnit({
      subtitle,
      timelineId: job.timelineId,
      runDir,
      cacheRoot,
      artifactRoot: metadata.selectedRootPath,
      runtime,
      settings,
      client: input.client,
      force: Boolean(job.settings?.force),
    }));
  }

  const manifest = {
    manifestVersion: 'resolve-volc-voiceover-supervisor-v1',
    createdAt: new Date().toISOString(),
    job,
    project: metadata,
    units,
  };
  const manifestPath = join(manifestRoot, 'manifest.json');
  await writeJson(manifestPath, manifest);
  return { manifestPath, manifest, units };
}

export function mergeSelectedSubtitlesForSynthesis(
  subtitles: IResolveVoiceoverSubtitleInput[],
): Array<Record<string, unknown>> {
  const rows = subtitles
    .filter((row): row is IResolveVoiceoverSubtitleInput => row != null && typeof row === 'object')
    .map(row => ({
      ...row,
      text: cleanSubtitleText(row.text ?? row.name),
    }))
    .filter(row => stringify(row.text));

  if (rows.length <= 1) {
    return rows.map(row => ({ ...row, text: stripGeneratedSubtitlePeriods(String(row.text)) }));
  }

  const sorted = [...rows].sort(subtitleSortCompare);
  const text = sorted
    .map(row => stripGeneratedSubtitlePeriods(cleanSubtitleText(row.text)))
    .filter(Boolean)
    .join('\n');
  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;
  const startFrame = numberOrUndefined(first.startFrame);
  const endFrame = maxNumber(sorted.map(row => numberOrUndefined(row.endFrame))) ?? numberOrUndefined(last.endFrame);
  const timelineInMs = numberOrUndefined(first.timelineInMs);
  const timelineOutMs = maxNumber(sorted.map(row => numberOrUndefined(row.timelineOutMs))) ?? numberOrUndefined(last.timelineOutMs);
  const sourceIds = sorted
    .map(row => row.subtitleIndex)
    .filter(value => value != null)
    .map(value => String(value));

  return [{
    ...first,
    name: text,
    text,
    startFrame: startFrame ?? first.startFrame,
    endFrame: endFrame ?? last.endFrame,
    durationFrames: startFrame != null && endFrame != null ? endFrame - startFrame : first.durationFrames,
    timelineInMs: timelineInMs ?? first.timelineInMs,
    timelineOutMs: timelineOutMs ?? last.timelineOutMs,
    durationMs: timelineInMs != null && timelineOutMs != null ? timelineOutMs - timelineInMs : first.durationMs,
    endTimecode: last.endTimecode ?? first.endTimecode,
    subtitleIndex: sourceIds.join('-') || first.subtitleIndex,
    sourceSubtitleIds: sourceIds,
    sourceSubtitles: sorted,
    isMergedGroup: true,
    groupSize: sorted.length,
  }];
}

export async function findKairosProjectForResolve(
  workspaceRoot: string,
  resolveProjectName: string,
): Promise<IResolveVoiceoverProjectMatch> {
  const projectsRoot = join(resolve(workspaceRoot), 'projects');
  if (!await pathExists(projectsRoot)) {
    throw new ResolveVolcVoiceoverError(
      'voiceover_projects_root_missing',
      `Kairos projects directory is missing: ${projectsRoot}`,
      { workspaceRoot },
    );
  }

  const wanted = new Set([
    stringify(resolveProjectName),
    stripResolveProjectSuffix(stringify(resolveProjectName)),
  ].filter(Boolean));
  const matches: IResolveVoiceoverProjectMatch[] = [];
  for (const entry of await readdir(projectsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const projectRoot = join(projectsRoot, entry.name);
    const projectBriefPath = join(projectRoot, 'config', 'project-brief.json');
    if (!await pathExists(projectBriefPath)) continue;
    const brief = await loadProjectBriefConfig(projectRoot).catch(() => null);
    if (!brief) continue;
    const keys = voiceoverMatchKeys(entry.name, brief);
    const matchedKeys = [...keys].filter(key => wanted.has(key));
    if (matchedKeys.length === 0) continue;
    matches.push({
      projectId: entry.name,
      projectRoot,
      projectBriefPath,
      projectName: brief.name?.trim() || entry.name,
      brief,
      matchedKeys: matchedKeys.sort(),
    });
  }

  if (matches.length === 0) {
    throw new ResolveVolcVoiceoverError(
      'voiceover_project_not_found',
      'Current Resolve project does not match any Kairos project brief name.',
      { resolveProjectName, workspaceRoot },
    );
  }
  if (matches.length > 1) {
    throw new ResolveVolcVoiceoverError(
      'voiceover_project_ambiguous',
      'Current Resolve project matches multiple Kairos projects.',
      { resolveProjectName, matches: matches.map(match => ({
        projectId: match.projectId,
        projectName: match.projectName,
        projectRoot: match.projectRoot,
      })) },
    );
  }
  return matches[0]!;
}

export async function resolveProjectVoiceoverMedia(project: IResolveVoiceoverProjectMatch): Promise<{
  rootId: string;
  description: string;
  selected: IVoiceoverMediaProbeResult & IVoiceoverMediaCandidate;
  candidates: Array<IVoiceoverMediaProbeResult & IVoiceoverMediaCandidate>;
}> {
  const media = project.brief.voiceoverMedia;
  if (!media?.path?.trim()) {
    throw new ResolveVolcVoiceoverError(
      'voiceover_media_missing',
      'Project voiceoverMedia.path is not configured in config/project-brief.json.',
      { projectId: project.projectId, projectBriefPath: project.projectBriefPath },
    );
  }

  const probed: Array<IVoiceoverMediaProbeResult & IVoiceoverMediaCandidate> = [];
  let selected: (IVoiceoverMediaProbeResult & IVoiceoverMediaCandidate) | undefined;
  for (const candidate of voiceoverMediaCandidates(media)) {
    const result = { ...candidate, ...await probeVoiceoverRoot(candidate.configuredPath) };
    probed.push(result);
    if (result.usable && !selected) selected = result;
  }
  if (!selected) {
    throw new ResolveVolcVoiceoverError(
      'voiceover_media_unwritable',
      'No project voiceoverMedia path is writable on this device.',
      { projectId: project.projectId, projectBriefPath: project.projectBriefPath, candidates: probed },
    );
  }
  return {
    rootId: media.rootId?.trim() || 'voiceover',
    description: media.description?.trim() ?? '',
    selected,
    candidates: probed,
  };
}

export class VolcTtsHttpClient implements IVolcTtsClient {
  async synthesize(text: string, settings: IVolcTtsSettings, requestId = randomUUID()): Promise<{
    audio: Buffer;
    requestId: string;
    headers: Record<string, string>;
    usage: Record<string, unknown>;
    events: unknown[];
    subtitles: unknown[];
  }> {
    if (!settings.apiKey) {
      throw new ResolveVolcVoiceoverError('volc_api_key_missing', 'Volcengine API key is required.');
    }
    if (!settings.speaker) {
      throw new ResolveVolcVoiceoverError('volc_speaker_missing', 'Volcengine speaker id is required.');
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CTTS_TIMEOUT_MS);
    try {
      const response = await fetchCompat(settings.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Api-Key': settings.apiKey,
          'X-Api-Resource-Id': settings.resourceId,
          'X-Api-Request-Id': requestId,
          'X-Control-Require-Usage-Tokens-Return': '*',
        },
        body: JSON.stringify({ req_params: ttsRequestParams(text, settings) }),
        signal: controller.signal,
      });
      const body = Buffer.from(await response.arrayBuffer());
      if (!response.ok) {
        throw new ResolveVolcVoiceoverError(
          'volc_tts_http_error',
          `Volcengine TTS HTTP ${response.status}: ${body.toString('utf-8').slice(0, 500)}`,
          { status: response.status, body: body.toString('utf-8').slice(0, 2000), requestId },
        );
      }
      const parsed = parseTtsResponse(body);
      return {
        ...parsed,
        requestId,
        headers: pickHeaders(response.headers),
      };
    } catch (error) {
      if (error instanceof ResolveVolcVoiceoverError) throw error;
      throw new ResolveVolcVoiceoverError(
        'volc_tts_network_error',
        `Volcengine TTS network error: ${error instanceof Error ? error.message : String(error)}`,
        { requestId },
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function parseTtsResponse(body: Buffer): {
  audio: Buffer;
  events: unknown[];
  usage: Record<string, unknown>;
  subtitles: unknown[];
} {
  if (body.length === 0) {
    throw new ResolveVolcVoiceoverError('volc_tts_empty_response', 'Volcengine TTS returned an empty body.');
  }

  const text = body.toString('utf-8').trim();
  const jsonObjects = parseJsonObjects(text);
  const audioChunks: Buffer[] = [];
  const events: unknown[] = [];
  const usage: Record<string, unknown> = {};
  const subtitles: unknown[] = [];

  for (const value of jsonObjects) {
    if (!isRecord(value)) continue;
    events.push(value);
    const usageValue = isRecord(value.usage) ? value.usage : isRecord(value.Usage) ? value.Usage : null;
    if (usageValue) Object.assign(usage, usageValue);
    const subtitleValue = Array.isArray(value.subtitles)
      ? value.subtitles
      : Array.isArray(value.subtitle)
        ? value.subtitle
        : Array.isArray(value.words)
          ? value.words
          : [];
    subtitles.push(...subtitleValue);
    const chunk = extractAudioPayload(value);
    if (chunk) audioChunks.push(chunk);
    const code = value.code ?? value.Code;
    if (![undefined, null, 0, 3000, 20000000, '0', '3000', '20000000'].includes(code as never)) {
      throw new ResolveVolcVoiceoverError(
        'volc_tts_provider_error',
        stringify(value.message ?? value.Message ?? value.msg) || `Volcengine TTS returned code ${String(code)}.`,
        { provider: value },
      );
    }
  }

  if (audioChunks.length > 0) {
    return { audio: Buffer.concat(audioChunks), events, usage, subtitles };
  }
  if (jsonObjects.length === 0) {
    const direct = maybeBase64Decode(text);
    if (direct) return { audio: direct, events, usage, subtitles };
  }
  if (looksLikeAudio(body)) {
    return { audio: body, events, usage, subtitles };
  }
  throw new ResolveVolcVoiceoverError(
    'volc_tts_audio_missing',
    'Unable to find audio data in Volcengine TTS response.',
    { bodyPreview: text.slice(0, 1000) },
  );
}

export function resolveVolcVoiceoverIpcPaths(workspaceRoot: string): IResolveVoiceoverIpcPaths {
  const root = join(resolve(workspaceRoot), '.tmp', 'resolve-volc-voiceover-plugin', 'ipc');
  return {
    root,
    requestsDir: join(root, 'requests'),
    processingDir: join(root, 'processing'),
    responsesDir: join(root, 'responses'),
  };
}

export async function ensureResolveVolcVoiceoverIpcDirs(workspaceRoot: string): Promise<IResolveVoiceoverIpcPaths> {
  const paths = resolveVolcVoiceoverIpcPaths(workspaceRoot);
  await Promise.all([
    mkdir(paths.requestsDir, { recursive: true }),
    mkdir(paths.processingDir, { recursive: true }),
    mkdir(paths.responsesDir, { recursive: true }),
  ]);
  return paths;
}

export async function processResolveVolcVoiceoverIpcOnce(input: {
  workspaceRoot: string;
  client?: IVolcTtsClient;
}): Promise<void> {
  const paths = await ensureResolveVolcVoiceoverIpcDirs(input.workspaceRoot);
  const files = (await readdir(paths.requestsDir).catch(() => []))
    .filter(file => file.endsWith('.json'))
    .sort();

  for (const file of files) {
    const requestPath = join(paths.requestsDir, file);
    const requestId = basename(file, '.json');
    const processingPath = join(paths.processingDir, file);
    try {
      await rename(requestPath, processingPath);
    } catch {
      continue;
    }

    let output = '';
    try {
      const request = JSON.parse(await readFile(processingPath, 'utf-8')) as IResolveVoiceoverIpcRequest;
      output = await resolveVolcVoiceoverIpcRequest({
        workspaceRoot: input.workspaceRoot,
        request,
        client: input.client,
      });
    } catch (error) {
      output = errorToTsv(error);
    }

    const responsePath = join(paths.responsesDir, `${requestId}.tsv`);
    const tmpResponsePath = `${responsePath}.tmp`;
    try {
      await writeFile(tmpResponsePath, output, 'utf-8');
      await rename(tmpResponsePath, responsePath);
    } finally {
      await unlink(processingPath).catch(() => undefined);
    }
  }
}

export async function startResolveVolcVoiceoverIpcServer(input: {
  workspaceRoot: string;
  intervalMs?: number;
  client?: IVolcTtsClient;
}): Promise<IResolveVoiceoverIpcServer> {
  const paths = await ensureResolveVolcVoiceoverIpcDirs(input.workspaceRoot);
  let stopped = false;
  let processing = false;
  const processOnce = async () => {
    if (stopped || processing) return;
    processing = true;
    try {
      await processResolveVolcVoiceoverIpcOnce({
        workspaceRoot: input.workspaceRoot,
        client: input.client,
      });
    } finally {
      processing = false;
    }
  };
  const timer = setInterval(() => {
    void processOnce();
  }, input.intervalMs ?? CIPC_INTERVAL_MS);
  timer.unref?.();
  void processOnce();
  return {
    paths,
    processOnce,
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}

async function resolveVolcVoiceoverIpcRequest(input: {
  workspaceRoot: string;
  request: IResolveVoiceoverIpcRequest;
  client?: IVolcTtsClient;
}): Promise<string> {
  const type = stringify(input.request.type);
  if (type === 'config-summary') {
    return buildResolveVolcVoiceoverConfigSummaryTsv({
      workspaceRoot: input.workspaceRoot,
      resolveProjectName: stringify(input.request.resolveProjectName) || undefined,
    });
  }
  if (type === 'synthesize') {
    if (!isRecord(input.request.job)) {
      throw new ResolveVolcVoiceoverError('ipc_job_missing', 'IPC synthesize request is missing job.');
    }
    return synthesizeResolveVolcVoiceoverTsv({
      workspaceRoot: input.workspaceRoot,
      job: input.request.job as unknown as IResolveVoiceoverJobInput,
      client: input.client,
    });
  }
  throw new ResolveVolcVoiceoverError(
    'ipc_request_type_unknown',
    `Unknown Resolve voiceover IPC request type: ${type || '(empty)'}.`,
    { requestType: input.request.type },
  );
}

function normalizeJobInput(job: IResolveVoiceoverJobInput): IResolveVoiceoverJobInput {
  if (!job.resolveProjectName?.trim()) {
    throw new ResolveVolcVoiceoverError('resolve_project_name_missing', 'Resolve project name is required.');
  }
  if (!job.timelineId?.trim()) {
    throw new ResolveVolcVoiceoverError('timeline_id_missing', 'Resolve timeline id/name is required.');
  }
  if (!Array.isArray(job.subtitles) || job.subtitles.length === 0) {
    throw new ResolveVolcVoiceoverError('subtitle_selection_missing', 'Select at least one subtitle row.');
  }
  return job;
}

function resolveTtsSettings(
  runtime: IRuntimeConfig,
  requestSettings: IResolveVoiceoverJobInput['settings'] = {},
): IVolcTtsSettings {
  const profiles = runtime.voiceover?.profiles ?? [];
  const selectedProfileName = requestSettings.profileName
    || runtime.voiceover?.defaultProfile
    || profiles[0]?.name;
  const profile = profiles.find(item => item.name === selectedProfileName) ?? profiles[0];
  if (!profile) {
    throw new ResolveVolcVoiceoverError('voice_profile_missing', 'No voiceover profile configured in config/runtime.json.');
  }
  return {
    apiKey: runtime.voiceover?.volcApiKey ?? '',
    speaker: profile.speakerId ?? '',
    resourceId: profile.resourceId ?? CDEFAULT_RESOURCE_ID,
    endpoint: ((profile as Record<string, unknown>).endpoint as string | undefined) || CDEFAULT_TTS_ENDPOINT,
    audioFormat: CDEFAULT_FORMAT,
    sampleRate: CDEFAULT_SAMPLE_RATE,
    model: profile.model ?? '',
    language: profile.language ?? 'zh-cn',
    speedRatio: firstFiniteNumber(requestSettings.speedRatio, profile.defaultSpeed),
    loudnessRatio: firstFiniteNumber(requestSettings.loudnessRatio, profile.defaultLoudness),
    contextText: profile.contextText ?? '',
  };
}

async function buildProjectVoiceoverRunDir(input: {
  workspaceRoot: string;
  project: IResolveVoiceoverProjectMatch;
  resolveProjectName: string;
  timelineId: string;
  timelineName?: string;
}): Promise<{
  runDir: string;
  metadata: Record<string, unknown> & { selectedRootPath: string };
}> {
  const media = await resolveProjectVoiceoverMedia(input.project);
  const selectedRootPath = media.selected.expandedPath!;
  const timelineName = stringify(input.timelineName) || stringify(input.timelineId) || 'timeline';
  const relativeRunDir = join(
    safeSegment(input.resolveProjectName, 'resolve-project'),
    safeSegment(timelineName, 'timeline'),
  );
  const runDir = join(selectedRootPath, relativeRunDir);
  return {
    runDir,
    metadata: {
      outputLayoutVersion: 'project-timeline-mp3-v1',
      projectId: input.project.projectId,
      projectRoot: input.project.projectRoot,
      projectBriefPath: input.project.projectBriefPath,
      projectName: input.project.projectName,
      resolveProjectName: input.resolveProjectName,
      timelineId: input.timelineId,
      timelineName,
      rootId: media.rootId,
      description: media.description,
      selectedRootPath,
      selectedSource: media.selected.source,
      selectedAlternateIndex: media.selected.source === 'alternate' ? media.selected.index : undefined,
      relativeRunDir: relativeRunDir.replace(/\\/gu, '/'),
      candidates: media.candidates,
    },
  };
}

async function synthesizeUnit(input: {
  subtitle: Record<string, unknown>;
  timelineId: string;
  runDir: string;
  cacheRoot: string;
  artifactRoot: string;
  runtime: IRuntimeConfig;
  settings: IVolcTtsSettings;
  client?: IVolcTtsClient;
  force: boolean;
}): Promise<IResolveVoiceoverUnitManifest> {
  const text = stripGeneratedSubtitlePeriods(cleanSubtitleText(input.subtitle.text));
  if (!text) {
    throw new ResolveVolcVoiceoverError('subtitle_text_missing', 'Selected subtitle has no readable text.', { subtitle: input.subtitle });
  }

  await mkdir(input.runDir, { recursive: true });
  await mkdir(input.cacheRoot, { recursive: true });
  const unitId = unitIdForSubtitle(input.timelineId, { ...input.subtitle, text });
  const publicSettings = publicTtsSettings(input.settings);
  const cacheKey = requestHash(text, publicSettings);
  const extension = input.settings.audioFormat.toLowerCase().replace(/^\./u, '') || CDEFAULT_FORMAT;
  const rawPath = join(input.runDir, `${unitId}_${cacheKey.slice(0, 8)}.${extension}`);
  const cachePath = join(input.cacheRoot, `${cacheKey}.${extension}`);
  let requestId = '';
  let provider: Record<string, unknown> = {};
  let cacheHit = false;

  if (!input.force && await pathExists(cachePath)) {
    await copyFile(cachePath, rawPath);
    cacheHit = true;
  } else {
    const result = await (input.client ?? new VolcTtsHttpClient()).synthesize(text, input.settings);
    requestId = result.requestId;
    provider = {
      headers: result.headers ?? {},
      usage: result.usage ?? {},
      eventCount: result.events?.length ?? 0,
      subtitleCount: result.subtitles?.length ?? 0,
    };
    await writeFile(rawPath, result.audio);
    await writeFile(cachePath, result.audio);
  }

  const durationMs = await probe(rawPath, input.runtime)
    .then(result => result.durationMs)
    .catch(() => null);
  const targetDurationMs = numberOrUndefined(input.subtitle.durationMs) ?? null;
  const overflowMs = durationMs != null && targetDurationMs != null ? durationMs - targetDurationMs : null;
  const durationStatus = overflowMs == null ? 'unknown' : overflowMs > 250 ? 'overflow' : 'ok';

  return {
    unitId,
    requestId,
    requestHash: cacheKey,
    cacheHit,
    text,
    subtitle: { ...input.subtitle, text },
    settings: publicSettings,
    audioPath: rawPath,
    rawAudioPath: rawPath,
    resolveAudioPath: rawPath,
    audioRelativePath: relativeToRoot(rawPath, input.artifactRoot),
    resolveAudioRelativePath: relativeToRoot(rawPath, input.artifactRoot),
    provider,
    durationMs,
    targetDurationMs,
    overflowMs,
    durationStatus,
  };
}

function publicTtsSettings(settings: IVolcTtsSettings): IVolcTtsPublicSettings {
  return {
    speaker: settings.speaker,
    resourceId: settings.resourceId,
    endpoint: settings.endpoint,
    audioFormat: settings.audioFormat,
    sampleRate: settings.sampleRate,
    model: settings.model,
    language: settings.language,
    speedRatio: settings.speedRatio,
    loudnessRatio: settings.loudnessRatio,
    contextText: settings.contextText,
  };
}

function voiceoverMatchKeys(projectId: string, brief: IProjectBriefConfig): Set<string> {
  const keys = [
    projectId,
    stripResolveProjectSuffix(projectId),
    brief.name,
    stripResolveProjectSuffix(brief.name),
    ...(brief.voiceoverMedia?.resolveProjectAliases ?? []).flatMap(alias => [
      alias,
      stripResolveProjectSuffix(alias),
    ]),
  ];
  return new Set(keys.map(stringify).filter(Boolean));
}

interface IVoiceoverMediaCandidate {
  source: 'primary' | 'alternate';
  index: number;
  configuredPath: string;
}

interface IVoiceoverMediaProbeResult {
  usable: boolean;
  expandedPath?: string;
  created?: boolean;
  reason?: string;
  error?: string;
}

function voiceoverMediaCandidates(media: NonNullable<IProjectBriefConfig['voiceoverMedia']>): IVoiceoverMediaCandidate[] {
  const candidates: IVoiceoverMediaCandidate[] = [];
  if (media.path?.trim()) {
    candidates.push({ source: 'primary', index: 0, configuredPath: media.path.trim() });
  }
  for (const [index, alternate] of (media.alternatePaths ?? []).entries()) {
    if (alternate.path?.trim()) {
      candidates.push({ source: 'alternate', index: index + 1, configuredPath: alternate.path.trim() });
    }
  }
  return candidates;
}

async function probeVoiceoverRoot(pathText: string): Promise<IVoiceoverMediaProbeResult> {
  if (!pathText.trim()) return { usable: false, reason: 'empty_path' };
  if (isNonNativeDrivePath(pathText)) return { usable: false, reason: 'non_native_drive_path' };
  const expandedPath = resolve(pathText);
  if (!isAbsolutePathLike(pathText)) return { usable: false, expandedPath, reason: 'path_not_absolute' };
  try {
    if (await pathExists(expandedPath)) {
      if (!(await stat(expandedPath)).isDirectory()) {
        return { usable: false, expandedPath, reason: 'not_directory' };
      }
    } else {
      const parent = await nearestExistingParent(expandedPath);
      if (!parent || !await canWrite(parent)) {
        return { usable: false, expandedPath, reason: 'parent_not_writable' };
      }
      await mkdir(expandedPath, { recursive: true });
    }
    if (!await canWrite(expandedPath)) return { usable: false, expandedPath, reason: 'not_writable' };
    return { usable: true, expandedPath };
  } catch (error) {
    return { usable: false, expandedPath, reason: 'mkdir_failed', error: error instanceof Error ? error.message : String(error) };
  }
}

function parseJsonObjects(text: string): unknown[] {
  if (!text) return [];
  try {
    return [JSON.parse(text)];
  } catch {
    // continue
  }
  const rows: unknown[] = [];
  for (let line of text.split(/\r?\n/u)) {
    line = line.trim();
    if (!line) continue;
    if (line.startsWith('data:')) line = line.slice(5).trim();
    try {
      rows.push(JSON.parse(line));
    } catch {
      // continue
    }
  }
  if (rows.length > 0) return rows;

  const scanned: unknown[] = [];
  let depth = 0;
  let start = -1;
  let quote = '';
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        quote = '';
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char !== '{' && char !== '[' && char !== '}' && char !== ']') continue;
    if (char === '{' || char === '[') {
      if (depth === 0) start = index;
      depth += 1;
      continue;
    }
    depth -= 1;
    if (depth === 0 && start >= 0) {
      const candidate = text.slice(start, index + 1);
      try {
        scanned.push(JSON.parse(candidate));
      } catch {
        // continue
      }
      start = -1;
    }
  }
  return scanned;
}

function extractAudioPayload(obj: Record<string, unknown>): Buffer | null {
  const candidates = [
    obj.audio,
    obj.data,
    obj.payload,
    obj.audio_data,
    obj.Audio,
    obj.Data,
  ];
  if (isRecord(obj.result)) {
    candidates.push(obj.result.audio, obj.result.data, obj.result.audio_data);
  }
  if (isRecord(obj.data)) {
    candidates.push(obj.data.audio, obj.data.data, obj.data.audio_data);
  }
  if (isRecord(obj.payload)) {
    candidates.push(obj.payload.audio, obj.payload.data, obj.payload.audio_data);
  }
  for (const candidate of candidates) {
    if (Buffer.isBuffer(candidate)) return candidate;
    if (typeof candidate === 'string') {
      const decoded = maybeBase64Decode(candidate);
      if (decoded) return decoded;
    }
  }
  return null;
}

function maybeBase64Decode(value: string): Buffer | null {
  let text = value.trim();
  if (!text || text.length < 4) return null;
  if (text.startsWith('data:') && text.includes(',')) {
    text = text.split(',').slice(1).join(',');
  }
  try {
    const decoded = Buffer.from(text, 'base64');
    return decoded.length > 0 ? decoded : null;
  } catch {
    return null;
  }
}

function looksLikeAudio(body: Buffer): boolean {
  return body.subarray(0, 3).equals(Buffer.from('ID3'))
    || body.subarray(0, 4).equals(Buffer.from('RIFF'))
    || body.subarray(0, 4).equals(Buffer.from('OggS'))
    || (body[0] === 0xff && body[1] === 0xfb);
}

function ttsRequestParams(text: string, settings: IVolcTtsSettings): Record<string, unknown> {
  const params: Record<string, unknown> = {
    text,
    speaker: settings.speaker,
    audio_params: {
      format: settings.audioFormat,
      sample_rate: settings.sampleRate,
    },
    explicit_language: settings.language,
  };
  if (settings.model) params.model = settings.model;
  if (settings.contextText) params.context_texts = [settings.contextText];
  if (settings.speedRatio != null) params.speed_ratio = settings.speedRatio;
  if (settings.loudnessRatio != null) params.loudness_ratio = settings.loudnessRatio;
  return params;
}

function cleanSubtitleText(value: unknown): string {
  return stringify(value)
    .replace(/<[^>]+>/gu, '')
    .replace(/\\N/gu, '\n')
    .replace(/\s+/gu, ' ')
    .trim();
}

function subtitleSortCompare(left: Record<string, unknown>, right: Record<string, unknown>): number {
  return (numberOrUndefined(left.startFrame) ?? 0) - (numberOrUndefined(right.startFrame) ?? 0)
    || (numberOrUndefined(left.trackIndex) ?? 0) - (numberOrUndefined(right.trackIndex) ?? 0)
    || (numberOrUndefined(left.subtitleIndex) ?? 0) - (numberOrUndefined(right.subtitleIndex) ?? 0);
}

function formatTsv(rows: string[][]): string {
  return `${rows.map(row => row.map(tsvEscape).join('\t')).join('\n')}\n`;
}

function tsvEscape(value: unknown): string {
  return stringify(value)
    .replace(/\\/gu, '\\\\')
    .replace(/\t/gu, '\\t')
    .replace(/\r/gu, '\\r')
    .replace(/\n/gu, '\\n');
}

export function errorToTsv(error: unknown): string {
  return formatTsv([errorToTsvRow(error)]);
}

function errorToTsvRow(error: unknown): string[] {
  if (error instanceof ResolveVolcVoiceoverError) {
    return ['ERROR', error.code, error.message, JSON.stringify(error.details)];
  }
  return ['ERROR', 'voiceover_unknown_error', error instanceof Error ? error.message : String(error)];
}

function pickHeaders(headers: Headers): Record<string, string> {
  const selected: Record<string, string> = {};
  for (const key of ['x-tt-logid', 'x-request-id', 'content-type']) {
    const value = headers.get(key);
    if (value) selected[key] = value;
  }
  return selected;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function stringify(value: unknown): string {
  if (value == null) return '';
  if (Buffer.isBuffer(value)) return value.toString('utf-8').trim();
  if (Array.isArray(value) || typeof value === 'object') return '';
  return String(value).trim();
}

function numberOrUndefined(value: unknown): number | undefined {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : undefined;
}

function numberOrBlank(value: unknown): string {
  const numberValue = numberOrUndefined(value);
  return numberValue == null ? '' : String(Math.round(numberValue));
}

function maxNumber(values: Array<number | undefined>): number | undefined {
  const finite = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  return finite.length > 0 ? Math.max(...finite) : undefined;
}

function firstFiniteNumber(...values: Array<number | undefined>): number | undefined {
  return values.find(value => typeof value === 'number' && Number.isFinite(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function canWrite(path: string): Promise<boolean> {
  try {
    await access(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

async function nearestExistingParent(path: string): Promise<string | null> {
  let current = dirname(path);
  while (current && current !== dirname(current)) {
    if (await pathExists(current)) return current;
    current = dirname(current);
  }
  return await pathExists(current) ? current : null;
}

function isNonNativeDrivePath(pathText: string): boolean {
  return process.platform !== 'win32' && /^[A-Za-z]:[\\/]/u.test(pathText.trim());
}

function isAbsolutePathLike(pathText: string): boolean {
  return process.platform === 'win32'
    ? /^[A-Za-z]:[\\/]/u.test(pathText) || pathText.startsWith('\\\\') || pathText.startsWith('/')
    : pathText.startsWith('/');
}

function relativeToRoot(path: string, root: string): string | undefined {
  try {
    const relativePath = relative(resolve(root), resolve(path));
    return relativePath && !relativePath.startsWith('..') && !relativePath.includes(':')
      ? relativePath.replace(/\\/gu, '/')
      : undefined;
  } catch {
    return undefined;
  }
}
