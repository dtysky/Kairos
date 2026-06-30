import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
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
