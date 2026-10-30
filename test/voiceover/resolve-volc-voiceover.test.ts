import { mkdtemp, mkdir, rm, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildResolveVolcVoiceoverConfigSummaryTsv,
  ensureResolveVolcVoiceoverIpcDirs,
  findKairosProjectForResolve,
  mergeSelectedSubtitlesForSynthesis,
  parseTtsResponse,
  processResolveVolcVoiceoverIpcOnce,
  resolveProjectVoiceoverMedia,
  synthesizeResolveVolcVoiceoverJob,
  synthesizeResolveVolcVoiceoverTsv,
  type IVolcTtsClient,
} from '../../src/modules/voiceover/index.js';

const cTempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(cTempRoots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('Resolve Volc voiceover Supervisor service', () => {
  it('matches Resolve project aliases and chooses the first writable voiceover media candidate', async () => {
    const workspaceRoot = await createWorkspaceFixture({
      brief: {
        name: '格聂南线',
        voiceoverMedia: {
          path: await createFilePathPlaceholder('not-a-directory'),
          alternatePaths: [{ path: 'PLACEHOLDER_ALTERNATE' }],
          resolveProjectAliases: ['格聂南线 Debug [Edit]'],
        },
      },
    });
    const alternate = join(workspaceRoot, 'voiceover-alt');
    await rewriteProjectBrief(workspaceRoot, brief => ({
      ...brief,
      voiceoverMedia: {
        ...brief.voiceoverMedia,
        alternatePaths: [{ path: alternate }],
      },
    }));

    const match = await findKairosProjectForResolve(workspaceRoot, '格聂南线 Debug [Edit]');
    const media = await resolveProjectVoiceoverMedia(match);

    expect(match.projectId).toBe('proj-a');
    expect(media.selected.source).toBe('alternate');
    expect(media.selected.expandedPath).toBe(alternate);
  });

  it('rejects implicit Windows drive paths before choosing a writable voiceover alternate', async () => {
    const workspaceRoot = await createWorkspaceFixture({
      brief: {
        name: '格聂南线',
        voiceoverMedia: {
          path: '/Volumes/SSDMAX/kairos-voiceover',
          alternatePaths: [{ path: 'PLACEHOLDER_ALTERNATE' }],
        },
      },
    });
    const alternate = join(workspaceRoot, 'voiceover-alt');
    await mkdir(alternate, { recursive: true });
    await rewriteProjectBrief(workspaceRoot, brief => ({
      ...brief,
      voiceoverMedia: {
        ...brief.voiceoverMedia,
        alternatePaths: [{ path: alternate }],
      },
    }));

    const match = await findKairosProjectForResolve(workspaceRoot, '格聂南线 [Edit]');
    const media = await resolveProjectVoiceoverMedia(match);

    if (process.platform === 'win32') {
      expect(media.selected.source).toBe('alternate');
      expect(media.selected.expandedPath).toBe(alternate);
      expect(media.candidates[0]).toMatchObject({
        source: 'primary',
        configuredPath: '/Volumes/SSDMAX/kairos-voiceover',
        usable: false,
        reason: 'implicit_windows_drive_path',
      });
    }
  });

  it('rejects relative voiceover media paths from project configuration', async () => {
    const workspaceRoot = await createWorkspaceFixture({
      brief: {
        name: '格聂南线',
        voiceoverMedia: {
          path: 'relative-voiceover',
          alternatePaths: [{ path: 'PLACEHOLDER_ALTERNATE' }],
        },
      },
    });
    const alternate = join(workspaceRoot, 'voiceover-alt');
    await mkdir(alternate, { recursive: true });
    await rewriteProjectBrief(workspaceRoot, brief => ({
      ...brief,
      voiceoverMedia: {
        ...brief.voiceoverMedia,
        alternatePaths: [{ path: alternate }],
      },
    }));

    const match = await findKairosProjectForResolve(workspaceRoot, '格聂南线 [Edit]');
    const media = await resolveProjectVoiceoverMedia(match);

    expect(media.selected.source).toBe('alternate');
    expect(media.selected.expandedPath).toBe(alternate);
    expect(media.candidates[0]).toMatchObject({
      source: 'primary',
      configuredPath: 'relative-voiceover',
      usable: false,
      reason: 'path_not_absolute',
    });
  });

  it('parses Volcengine JSON response audio payloads', () => {
    const audio = Buffer.from('ID3fake-audio');
    const parsed = parseTtsResponse(Buffer.from(JSON.stringify({
      code: 3000,
      data: audio.toString('base64'),
      usage: { characters: 8 },
    })));

    expect(parsed.audio.equals(audio)).toBe(true);
    expect(parsed.usage.characters).toBe(8);
  });

  it('parses delayed sentence.words events from HTTP and SSE responses', () => {
    const bytes = Buffer.from('ID3test');
    const lines = [
      `data: ${JSON.stringify({ code: 0, data: bytes.toString('base64') })}`,
      `data: ${JSON.stringify({ code: 0, data: null, sentence: { text: '你好', words: [{ word: '你好', startTime: 0.1, endTime: 1 }] } })}`,
      'data: {"code":20000000,"data":null}',
    ];
    const result = parseTtsResponse(Buffer.from(lines.join('\n')));
    expect(result.audio).toEqual(bytes);
    expect(result.subtitles).toEqual([{ word: '你好', startTime: 0.1, endTime: 1 }]);
  });

  it('synthesizes once, reuses timed cache, and returns independent source ranges at original frames', async () => {
    const { workspaceRoot, job, client } = await alignedFixture();
    const first = await synthesizeResolveVolcVoiceoverJob({ workspaceRoot, job, client });
    const second = await synthesizeResolveVolcVoiceoverJob({ workspaceRoot, job, client });
    expect(client.calls).toBe(1);
    expect(first.units).toHaveLength(2);
    expect(first.units.map(unit => unit.subtitle.startFrame)).toEqual([108000, 108300]);
    expect(first.units[0]?.resolveAudioPath).toBe(first.units[1]?.resolveAudioPath);
    expect(first.units.map(unit => unit.alignment?.status)).toEqual(['aligned', 'aligned']);
    expect(second.units[0]?.alignment).toEqual(first.units[0]?.alignment);
    expect(second.units.every(unit => unit.cacheHit)).toBe(true);
    const tsv = await synthesizeResolveVolcVoiceoverTsv({ workspaceRoot, job, client });
    expect(tsv).toContain('ALIGNMENT\tsubtitle-alignment-v1');
    expect(tsv).toContain('\taligned\t\t150\t1150\t1\t');
  });

  it('marks overflow per subtitle, including frame rounding', async () => {
    const { workspaceRoot, job, client } = await alignedFixture();
    job.subtitles[0]!.endFrame = 108010;
    const result = await synthesizeResolveVolcVoiceoverJob({ workspaceRoot, job, client });
    expect(result.units.map(unit => unit.durationStatus)).toEqual(['overflow', 'ok']);
    expect(result.units[0]?.overflowMs).toBeGreaterThan(300);
  });

  it('does not silently pay again when the alignment sidecar is damaged', async () => {
    const { workspaceRoot, job, client } = await alignedFixture();
    await synthesizeResolveVolcVoiceoverJob({ workspaceRoot, job, client });
    const cache = join(workspaceRoot, 'projects/proj-a/.tmp/resolve-volc-voiceover-plugin/cache');
    const sidecar = (await readdir(cache)).find(file => file.endsWith('.alignment.json'))!;
    await writeFile(join(cache, sidecar), '{}');
    const result = await synthesizeResolveVolcVoiceoverJob({ workspaceRoot, job, client });
    expect(client.calls).toBe(1);
    expect(result.units.every(unit => unit.alignment?.reason === 'alignment_cache_invalid_use_force')).toBe(true);
  });

  it('blocks unsupported resources and invalid selections before calling the paid provider', async () => {
    const { workspaceRoot, job, client } = await alignedFixture();
    await expect(synthesizeResolveVolcVoiceoverJob({ workspaceRoot, job: { ...job, timelineFrameRate: 0 }, client })).rejects.toMatchObject({ code: 'timeline_fps_missing' });
    await expect(synthesizeResolveVolcVoiceoverJob({ workspaceRoot, job: { ...job, subtitles: [job.subtitles[0]!, job.subtitles[0]!] }, client })).rejects.toMatchObject({ code: 'subtitle_alignment_input_invalid' });
    const runtimePath = join(workspaceRoot, 'config/runtime.json');
    const runtime = JSON.parse(await readFile(runtimePath, 'utf8'));
    runtime.voiceover.profiles[0].resourceId = 'seed-tts-1.0';
    await writeFile(runtimePath, JSON.stringify(runtime));
    await expect(synthesizeResolveVolcVoiceoverJob({ workspaceRoot, job, client })).rejects.toMatchObject({ code: 'alignment_resource_unsupported' });
    expect(client.calls).toBe(0);
  });

  it('Force preserves earlier media and uses a new content-addressed file', async () => {
    const { workspaceRoot, job, client } = await alignedFixture();
    const first = await synthesizeResolveVolcVoiceoverJob({ workspaceRoot, job, client });
    const original = await readFile(first.units[0]!.resolveAudioPath);
    const originalSynthesize = client.synthesize.bind(client);
    client.synthesize = async (...args) => {
      const result = await originalSynthesize(...args);
      result.audio = Buffer.from(result.audio);
      result.audio[100] = 1;
      return result;
    };
    const forced = await synthesizeResolveVolcVoiceoverJob({ workspaceRoot, job: { ...job, settings: { ...job.settings, force: true } }, client });
    expect(forced.units[0]?.resolveAudioPath).not.toBe(first.units[0]?.resolveAudioPath);
    expect(await readFile(first.units[0]!.resolveAudioPath)).toEqual(original);
  });

  it('merges selected subtitles without adding terminal periods', () => {
    const [merged] = mergeSelectedSubtitlesForSynthesis([
      { subtitleIndex: 2, startFrame: 20, endFrame: 30, text: '第二句.' },
      { subtitleIndex: 1, startFrame: 10, endFrame: 20, text: '第一句。' },
    ]);

    expect(merged?.text).toBe('第一句\n第二句');
    expect(merged?.subtitleIndex).toBe('1-2');
  });

  it('synthesizes through injected client, caches audio, writes manifest, and formats TSV', async () => {
    const workspaceRoot = await createWorkspaceFixture({
      brief: {
        name: '格聂南线',
        voiceoverMedia: {
          path: 'PLACEHOLDER_VOICEOVER',
        },
      },
      runtime: {
        voiceover: {
          volcApiKey: 'test-key',
          defaultProfile: 'narrator',
          profiles: [{
            name: 'narrator',
            displayName: 'Narrator',
            speakerId: 'speaker-1',
            resourceId: 'seed-icl-2.0',
            language: 'zh-cn',
          }],
        },
      },
    });
    const voiceoverRoot = join(workspaceRoot, 'voiceover');
    await rewriteProjectBrief(workspaceRoot, brief => ({
      ...brief,
      voiceoverMedia: {
        ...brief.voiceoverMedia,
        path: voiceoverRoot,
      },
    }));
    const client = createFakeTtsClient(Buffer.from('ID3fake-audio'));
    const job = {
      resolveProjectName: '格聂南线 [Edit]',
      timelineId: 'timeline-main',
      timelineName: 'Main Timeline',
      subtitles: [{
        subtitleIndex: 1,
        trackIndex: 1,
        startFrame: 100,
        endFrame: 130,
        durationMs: 1000,
        text: '终于到垭口了。',
      }],
      settings: { profileName: 'narrator' },
      runId: 'test-run',
    };

    const first = await synthesizeResolveVolcVoiceoverJob({ workspaceRoot, job, client });
    const second = await synthesizeResolveVolcVoiceoverJob({ workspaceRoot, job, client });
    const tsv = await synthesizeResolveVolcVoiceoverTsv({ workspaceRoot, job, client });
    const summary = await buildResolveVolcVoiceoverConfigSummaryTsv({
      workspaceRoot,
      resolveProjectName: '格聂南线 [Edit]',
    });

    expect(client.calls).toBe(1);
    expect(first.units[0]?.cacheHit).toBe(false);
    expect(second.units[0]?.cacheHit).toBe(true);
    expect(first.units[0]?.text).toBe('终于到垭口了');
    expect(await readFile(first.manifestPath, 'utf-8')).toContain('resolve-volc-voiceover-supervisor-v1');
    expect(tsv).toContain('OK\t');
    expect(tsv).toContain('UNIT\t');
    expect(summary).toContain('PROFILE\tnarrator\tNarrator');
    expect(summary).toContain('VOICEOVER_MEDIA\tready');
  });

  it('processes Resolve Lua file IPC requests without command backends', async () => {
    const workspaceRoot = await createWorkspaceFixture({
      brief: {
        name: '格聂南线',
        voiceoverMedia: {
          path: 'PLACEHOLDER_VOICEOVER',
          resolveProjectAliases: ['格聂南线 Debug [Edit]'],
        },
      },
      runtime: {
        voiceover: {
          volcApiKey: 'test-key',
          defaultProfile: 'narrator',
          profiles: [{
            name: 'narrator',
            displayName: 'Narrator',
            speakerId: 'speaker-1',
            language: 'zh-cn',
          }],
        },
      },
    });
    const voiceoverRoot = join(workspaceRoot, 'voiceover');
    await rewriteProjectBrief(workspaceRoot, brief => ({
      ...brief,
      voiceoverMedia: {
        ...brief.voiceoverMedia,
        path: voiceoverRoot,
      },
    }));
    const paths = await ensureResolveVolcVoiceoverIpcDirs(workspaceRoot);
    await writeFile(join(paths.requestsDir, 'config-1.json'), JSON.stringify({
      type: 'config-summary',
      resolveProjectName: '格聂南线 Debug [Edit]',
    }), 'utf-8');
    await processResolveVolcVoiceoverIpcOnce({ workspaceRoot });
    const configTsv = await readFile(join(paths.responsesDir, 'config-1.tsv'), 'utf-8');

    const client = createFakeTtsClient(Buffer.from('ID3fake-audio'));
    await writeFile(join(paths.requestsDir, 'synth-1.json'), JSON.stringify({
      type: 'synthesize',
      job: {
        resolveProjectName: '格聂南线 Debug [Edit]',
        timelineId: 'timeline-main',
        timelineName: 'Main Timeline',
        subtitles: [{
          subtitleIndex: 1,
          trackIndex: 2,
          startFrame: 120,
          endFrame: 150,
          durationMs: 1000,
          text: '沿着山路继续往前。',
        }],
        settings: { profileName: 'narrator' },
        runId: 'ipc-run',
      },
    }), 'utf-8');
    await processResolveVolcVoiceoverIpcOnce({ workspaceRoot, client });
    const synthTsv = await readFile(join(paths.responsesDir, 'synth-1.tsv'), 'utf-8');

    expect(configTsv).toContain('PROFILE\tnarrator\tNarrator');
    expect(configTsv).toContain('VOICEOVER_MEDIA\tready');
    expect(synthTsv).toContain('OK\t');
    expect(synthTsv).toContain('UNIT\t');
    expect(client.calls).toBe(1);
  });
});

async function createWorkspaceFixture(input: {
  brief: {
    name: string;
    voiceoverMedia: {
      path: string;
      alternatePaths?: Array<{ path: string }>;
      resolveProjectAliases?: string[];
    };
  };
  runtime?: Record<string, unknown>;
}): Promise<string> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'kairos-voiceover-'));
  cTempRoots.push(workspaceRoot);
  await mkdir(join(workspaceRoot, 'projects', 'proj-a', 'config'), { recursive: true });
  await mkdir(join(workspaceRoot, 'config'), { recursive: true });
  await writeFile(join(workspaceRoot, 'projects', 'proj-a', 'config', 'project-brief.json'), JSON.stringify({
    name: input.brief.name,
    mappings: [],
    voiceoverMedia: input.brief.voiceoverMedia,
    materialPatternPhrases: [],
  }, null, 2), 'utf-8');
  await writeFile(join(workspaceRoot, 'config', 'runtime.json'), JSON.stringify(input.runtime ?? {}, null, 2), 'utf-8');
  return workspaceRoot;
}

async function rewriteProjectBrief(
  workspaceRoot: string,
  update: (brief: any) => any,
): Promise<void> {
  const path = join(workspaceRoot, 'projects', 'proj-a', 'config', 'project-brief.json');
  const brief = JSON.parse(await readFile(path, 'utf-8'));
  await writeFile(path, JSON.stringify(update(brief), null, 2), 'utf-8');
}

async function createFilePathPlaceholder(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'kairos-voiceover-placeholder-'));
  cTempRoots.push(root);
  const path = join(root, name);
  await writeFile(path, 'not a directory', 'utf-8');
  return path;
}

function createFakeTtsClient(audio: Buffer): IVolcTtsClient & { calls: number } {
  return {
    calls: 0,
    async synthesize() {
      this.calls += 1;
      return {
        audio,
        requestId: `request-${this.calls}`,
        headers: { 'content-type': 'application/json' },
        usage: { characters: 10 },
        events: [{}],
        subtitles: [],
      };
    },
  };
}

async function alignedFixture() {
  const workspaceRoot = await createWorkspaceFixture({
    brief: { name: '测试', voiceoverMedia: { path: 'PLACEHOLDER' } },
    runtime: { voiceover: { volcApiKey: 'test-key', defaultProfile: 'narrator', profiles: [
      { name: 'narrator', speakerId: 'test-speaker', resourceId: 'seed-icl-2.0' },
    ] } },
  });
  await rewriteProjectBrief(workspaceRoot, brief => ({ ...brief, voiceoverMedia: { path: join(workspaceRoot, 'voiceover') } }));
  // Real decodable WAV in an .mp3-named fixture exercises the production ffprobe duration path.
  const audio = Buffer.alloc(44 + 24000 * 2 * 3);
  audio.write('RIFF'); audio.writeUInt32LE(audio.length - 8, 4); audio.write('WAVEfmt ', 8);
  audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22);
  audio.writeUInt32LE(24000, 24); audio.writeUInt32LE(48000, 28); audio.writeUInt16LE(2, 32);
  audio.writeUInt16LE(16, 34); audio.write('data', 36); audio.writeUInt32LE(audio.length - 44, 40);
  const client: IVolcTtsClient & { calls: number } = {
    calls: 0,
    async synthesize(text, settings) {
      expect(text).toBe('你好 再见');
      expect(settings.enableSubtitle).toBe(true);
      this.calls++;
      return { audio, requestId: 'test-timing', subtitles: [
        { word: '你好', startTime: 0.2, endTime: 0.8 },
        { word: '再见', startTime: 1.5, endTime: 2.5 },
      ] };
    },
  };
  const job = {
    resolveProjectName: '测试 [Edit]', timelineId: 't1', timelineFrameRate: 30,
    subtitles: [
      { trackIndex: 2, subtitleIndex: 2, startFrame: 108300, endFrame: 108360, text: '再见。' },
      { trackIndex: 2, subtitleIndex: 1, startFrame: 108000, endFrame: 108030, text: '你好。' },
    ].sort((a, b) => a.startFrame - b.startFrame),
    settings: { placementMode: 'subtitle-aligned' as const },
  };
  return { workspaceRoot, job, client };
}
