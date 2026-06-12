import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const WORKSPACE_ROOT = process.cwd();
const GENERATE_SCRIPT = resolve(WORKSPACE_ROOT, 'scripts/generate-postlock-narration-framework.mjs');
const VALIDATE_SCRIPT = resolve(WORKSPACE_ROOT, 'scripts/validate-postlock-narration-framework.mjs');
const EDIT_ID = 'main';

describe('post-lock narration framework visual evidence fixture', () => {
  it('builds no-subtitle clip evidence from visualObservation instead of materialPatterns', async () => {
    const fixture = await createPostlockFixtureProject({
      spans: [
        visualSpan({
          id: 'VIS001_broll_visual_s0-3',
          assetId: 'VIS001',
          visualObservation: '山坡上云影压过弯道，路面和护栏清晰可见。',
          materialPatterns: ['素材模式禁用陷阱', '有口播语音', '讨论路况'],
        }),
        speechSpan({
          id: 'SPCH001_drive_mixed_s0-3',
          assetId: 'SPCH001',
          sourceInMs: 0,
          sourceOutMs: 3000,
        }),
        visualSpan({
          id: 'SPCH001_drive_visual_s0-3',
          assetId: 'SPCH001',
          sourceInMs: 0,
          sourceOutMs: 3000,
          visualObservation: '同一素材的车窗外雪墙贴近车身，前方弯道被雾气罩住。',
        }),
        speechSpan({
          id: 'SPCH002_drive_speech_s30-35',
          assetId: 'SPCH002',
          sourceInMs: 30000,
          sourceOutMs: 35000,
        }),
        visualSpan({
          id: 'SPCH002_drive_visual_s45-50',
          assetId: 'SPCH002',
          sourceInMs: 45000,
          sourceOutMs: 50000,
          visualObservation: '同一原片稍后出现积雪路肩和连续发卡弯，能补足当前画面事实。',
        }),
        speechSpan({
          id: 'SPCH003_drive_mixed_s0-4',
          assetId: 'SPCH003',
          sourceInMs: 0,
          sourceOutMs: 4000,
          visualObservation: '当前片段自身能看见挡风玻璃外的碎雪和山谷路面。',
        }),
      ],
      timelineExport: {
        schemaVersion: 'kairos-resolve-edit-timeline-export-test-v1',
        exportedAt: '2026-06-12T00:00:00.000Z',
        fps: 30,
        subtitleItems: [],
        videoItems: [
          videoItem({
            name: 'Visual only VIS001',
            sourceStem: 'VIS001',
            filePath: '/fixture-media/VIS001.mp4',
            startFrame: 0,
            endFrame: 90,
            sourceStartFrame: 0,
            sourceEndFrame: 90,
          }),
          videoItem({
            name: 'No subtitle mixed overlapping SPCH001',
            sourceStem: 'SPCH001',
            filePath: '/fixture-media/SPCH001.mp4',
            startFrame: 120,
            endFrame: 210,
            sourceStartFrame: 0,
            sourceEndFrame: 90,
          }),
          videoItem({
            name: 'No subtitle speech nearby SPCH002',
            sourceStem: 'SPCH002',
            filePath: '/fixture-media/SPCH002.mp4',
            startFrame: 240,
            endFrame: 390,
            sourceStartFrame: 900,
            sourceEndFrame: 1050,
          }),
          videoItem({
            name: 'No subtitle mixed fallback SPCH003',
            sourceStem: 'SPCH003',
            filePath: '/fixture-media/SPCH003.mp4',
            startFrame: 420,
            endFrame: 540,
            sourceStartFrame: 0,
            sourceEndFrame: 120,
          }),
        ],
      },
    });

    try {
      await runGenerate(fixture.projectRoot, fixture.timelineExportPath);

      const packet = await readJson(join(fixture.projectRoot, '.tmp/edit-flow/main/postlock/current-timeline-clip-packet.json'));
      const framework = await readFile(join(fixture.projectRoot, 'edits/main/postlock/narration-framework.md'), 'utf8');
      const clipMap = await readJson(join(fixture.projectRoot, 'edits/main/postlock/narration-framework.clip-map.json'));

      expect(packet.schemaVersion).toBe('kairos-postlock-narration-framework-clip-packet-v2');
      expect(framework).toContain('格式：Markdown pack-list v2');
      expect(clipMap.schemaVersion).toBe('kairos-postlock-narration-framework-clip-map-v2');
      expect(clipMap.format).toBe('markdown-pack-list-v2');
      expect(Object.keys(clipMap).sort()).toEqual(['entries', 'format', 'packs', 'schemaVersion', 'sourcePacket'].sort());
      expect(clipMap.entries.every((entry: Record<string, unknown>) => (
        JSON.stringify(Object.keys(entry).sort()) === JSON.stringify(['clips', 'marker'].sort())
      ))).toBe(true);
      expect(clipMap.packs.every((pack: Record<string, unknown>) => (
        JSON.stringify(Object.keys(pack).sort()) === JSON.stringify(['entries', 'title'].sort())
      ))).toBe(true);
      expect(findObjectKeys(packet, 'materialPatterns')).toEqual([]);
      expect(findObjectKeys(clipMap, 'assetIds')).toEqual([]);
      expect(findObjectKeys(clipMap, 'spanIds')).toEqual([]);
      expect(findObjectKeys(clipMap, 'previousClipIds')).toEqual([]);
      expect(findObjectKeys(clipMap, 'summary')).toEqual([]);
      expect(JSON.stringify({ packet, clipMap, framework })).not.toContain('素材模式禁用陷阱');
      expect(JSON.stringify({ packet, clipMap, framework })).not.toContain('有口播语音');

      expect(packet.clips).toHaveLength(4);
      expect(clipMap.entries).toHaveLength(4);
      expect(framework).toContain('山坡上云影压过弯道，路面和护栏清晰可见');
      expect(framework).toContain('同一素材的车窗外雪墙贴近车身');
      expect(framework).toContain('同一原片稍后出现积雪路肩和连续发卡弯');
      expect(framework).toContain('当前片段自身能看见挡风玻璃外的碎雪');

      expect(packet.clips[0].narrationVisualEvidence).toMatchObject({
        visualObservation: '山坡上云影压过弯道，路面和护栏清晰可见。',
      });
      expectEvidence(packet.clips[1], {
        source: 'same-asset-visual-span',
        visualObservation: '同一素材的车窗外雪墙贴近车身，前方弯道被雾气罩住。',
      });
      expectEvidence(packet.clips[2], {
        source: 'same-asset-visual-span',
        visualObservation: '同一原片稍后出现积雪路肩和连续发卡弯，能补足当前画面事实。',
      });
      expectEvidence(packet.clips[3], {
        source: 'speech-span-visualObservation-fallback',
        visualObservation: '当前片段自身能看见挡风玻璃外的碎雪和山谷路面。',
      });
    } finally {
      await rm(fixture.projectRoot, { recursive: true, force: true });
    }
  });

  it('rejects legacy verbose clip-map fields instead of reading v1 compatibly', async () => {
    const fixture = await createPostlockFixtureProject({
      spans: [
        visualSpan({
          id: 'LEGACY001_drive_visual_s0-3',
          assetId: 'LEGACY001',
          visualObservation: '车窗外的山路绕过湿润护栏，远处云雾贴着山坡。',
        }),
      ],
      timelineExport: {
        schemaVersion: 'kairos-resolve-edit-timeline-export-test-v1',
        exportedAt: '2026-06-12T00:00:00.000Z',
        fps: 30,
        subtitleItems: [],
        videoItems: [
          videoItem({
            name: 'Legacy map visual LEGACY001',
            sourceStem: 'LEGACY001',
            filePath: '/fixture-media/LEGACY001.mp4',
            startFrame: 0,
            endFrame: 90,
            sourceStartFrame: 0,
            sourceEndFrame: 90,
          }),
        ],
      },
    });

    try {
      await runGenerate(fixture.projectRoot, fixture.timelineExportPath);
      await writeJson(join(fixture.projectRoot, 'edits/main/postlock/narration-framework.clip-map.json'), {
        schemaVersion: 'kairos-postlock-narration-framework-clip-map-v1',
        projectId: 'legacy',
        editId: EDIT_ID,
        createdAt: '2026-06-12T00:00:00.000Z',
        format: 'markdown-pack-list-v2',
        sourcePacket: '.tmp/edit-flow/<editId>/postlock/current-timeline-clip-packet.json',
        entries: [{
          entryIndex: 1,
          marker: 'visual',
          clipIndices: [1],
          previousClipIds: ['clip-00001'],
          assetIds: ['LEGACY001'],
          spanIds: ['LEGACY001_drive_visual_s0-3'],
        }],
        packs: [{
          packIndex: 1,
          type: '视觉',
          title: '视觉｜当前片段',
          marker: 'visual',
          entryIndices: [1],
          clipIndices: [1],
        }],
        summary: { entryCount: 1, packCount: 1 },
      });

      await expect(runValidate(fixture.projectRoot)).rejects.toMatchObject({
        stderr: expect.stringContaining('clip-map schemaVersion must be kairos-postlock-narration-framework-clip-map-v2'),
      });
    } finally {
      await rm(fixture.projectRoot, { recursive: true, force: true });
    }
  });

  it('records a warning when a no-subtitle clip has no visualObservation evidence', async () => {
    const fixture = await createPostlockFixtureProject({
      spans: [
        visualSpan({
          id: 'MISS001_broll_visual_s0-3',
          assetId: 'MISS001',
          visualObservation: undefined,
          materialPatterns: ['旧素材模式不能作为旁白画面证据'],
        }),
      ],
      timelineExport: {
        schemaVersion: 'kairos-resolve-edit-timeline-export-test-v1',
        exportedAt: '2026-06-12T00:00:00.000Z',
        fps: 30,
        subtitleItems: [],
        videoItems: [
          videoItem({
            name: 'Missing visual observation MISS001',
            sourceStem: 'MISS001',
            filePath: '/fixture-media/MISS001.mp4',
            startFrame: 0,
            endFrame: 90,
            sourceStartFrame: 0,
            sourceEndFrame: 90,
          }),
        ],
      },
    });

    try {
      await runGenerate(fixture.projectRoot, fixture.timelineExportPath);
      const packet = await readJson(join(fixture.projectRoot, '.tmp/edit-flow/main/postlock/current-timeline-clip-packet.json'));
      const framework = await readFile(join(fixture.projectRoot, 'edits/main/postlock/narration-framework.md'), 'utf8');
      expect(packet.summary.narrationVisualEvidenceWarningCount).toBe(1);
      expectEvidence(packet.clips[0], {
        source: 'missing-visualObservation-warning',
        visualObservation: 'clip 1 MISS001缺少可用视觉观察',
      });
      expect(framework).toContain('缺少可用视觉观察');
    } finally {
      await rm(fixture.projectRoot, { recursive: true, force: true });
    }
  });

  it('rejects comma-separated visual tag lists in framework entries', async () => {
    const fixture = await createPostlockFixtureProject({
      spans: [
        visualSpan({
          id: 'TAG001_drive_visual_s0-3',
          assetId: 'TAG001',
          visualObservation: '雨后的高速上车流穿过高架，镜头跟着前车一路向远处延伸。',
        }),
      ],
      timelineExport: {
        schemaVersion: 'kairos-resolve-edit-timeline-export-test-v1',
        exportedAt: '2026-06-12T00:00:00.000Z',
        fps: 30,
        subtitleItems: [],
        videoItems: [
          videoItem({
            name: 'Tag list visual TAG001',
            sourceStem: 'TAG001',
            filePath: '/fixture-media/TAG001.mp4',
            startFrame: 0,
            endFrame: 90,
            sourceStartFrame: 0,
            sourceEndFrame: 90,
          }),
        ],
      },
    });

    try {
      await runGenerate(fixture.projectRoot, fixture.timelineExportPath);
      const frameworkPath = join(fixture.projectRoot, 'edits/main/postlock/narration-framework.md');
      const framework = await readFile(frameworkPath, 'utf8');
      await writeFile(
        frameworkPath,
        framework.replace(
          /(\s+-\s+\d+｜)[^\n]+/u,
          '$1开车，雨后湿滑、高速路面、道路延伸、车流穿行、黄色车在画面中推进，测试路线',
        ),
        'utf8',
      );

      await expect(runValidate(fixture.projectRoot)).rejects.toMatchObject({
        stderr: expect.stringContaining('comma-separated visual tag list'),
      });
    } finally {
      await rm(fixture.projectRoot, { recursive: true, force: true });
    }
  });
});

async function runGenerate(projectRoot: string, timelineExportPath: string) {
  return execFileAsync(
    process.execPath,
    [GENERATE_SCRIPT, projectRoot, EDIT_ID, '--timeline-export', timelineExportPath],
    {
      cwd: WORKSPACE_ROOT,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    },
  );
}

async function runValidate(projectRoot: string) {
  return execFileAsync(
    process.execPath,
    [VALIDATE_SCRIPT, projectRoot, EDIT_ID],
    {
      cwd: WORKSPACE_ROOT,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    },
  );
}

async function createPostlockFixtureProject(input: {
  spans: Array<Record<string, unknown>>;
  timelineExport: Record<string, unknown>;
}) {
  const projectRoot = await mkdtemp(join(tmpdir(), 'kairos-postlock-visual-evidence-'));
  const timelineAuditPath = join(projectRoot, 'timeline-audit.json');
  const timelineExportPath = join(projectRoot, 'timeline-export.json');
  const assets = [...new Set(input.spans.map(span => String(span.assetId)))].map(assetId => ({
    id: assetId,
    kind: 'video',
    fps: 30,
    sourcePath: `/fixture-media/${assetId}.mp4`,
    displayName: `${assetId}.mp4`,
  }));

  await writeJson(join(projectRoot, 'store/project.json'), {
    id: 'postlock-visual-evidence-fixture',
    name: 'Postlock Visual Evidence Fixture',
  });
  await writeJson(join(projectRoot, 'edits/main/config/edit-unit.json'), {
    editId: EDIT_ID,
    editRuleCategory: 'fixture-postlock',
  });
  await writeJson(join(projectRoot, 'edits/main/planning/flow-plan.json'), {
    id: 'flow-plan-postlock-fixture',
    status: 'confirmed',
    plannerPolicyVersion: 'codex-agent-v1',
    materialIdPolicyVersion: 'human-source-v1',
    materialTimePolicyVersion: 'normalized-captured-at-v1',
    editRuleHash: 'fixture',
    steps: [{
      id: 'postlock-narration-framework-codex-v1',
      capabilityId: 'postlock.subtitle_narration',
      runner: 'agent',
      inputRefs: ['edits/<editId>/timeline/locked-rough-cut.json'],
      outputRefs: ['edits/<editId>/postlock/narration-framework.md'],
      gate: 'human',
    }],
  });
  await writeJson(join(projectRoot, 'edits/main/timeline/locked-rough-cut.json'), {
    resolveProjectName: 'Postlock Visual Evidence Fixture [Edit]',
    timelineName: 'main [main]',
    timelineAuditPath,
  });
  await writeJson(timelineAuditPath, {
    assets,
    spans: input.spans,
    timeline: { clips: [] },
    adapterHints: { resolveRoughCut: { hostSummary: { clips: [] } } },
  });
  await writeJson(timelineExportPath, input.timelineExport);

  return { projectRoot, timelineExportPath };
}

function videoItem(input: {
  name: string;
  sourceStem: string;
  filePath: string;
  startFrame: number;
  endFrame: number;
  sourceStartFrame: number;
  sourceEndFrame: number;
}) {
  return {
    trackIndex: 1,
    name: input.name,
    sourceStem: input.sourceStem,
    filePath: input.filePath,
    mediaPoolName: `${input.sourceStem}.mp4`,
    startFrame: input.startFrame,
    endFrame: input.endFrame,
    sourceStartFrame: input.sourceStartFrame,
    sourceEndFrame: input.sourceEndFrame,
    timelineInMs: input.startFrame * 1000 / 30,
    timelineOutMs: input.endFrame * 1000 / 30,
    durationMs: (input.endFrame - input.startFrame) * 1000 / 30,
  };
}

function visualSpan(input: {
  id: string;
  assetId: string;
  sourceInMs?: number;
  sourceOutMs?: number;
  visualObservation?: string;
  materialPatterns?: string[];
}) {
  return {
    id: input.id,
    assetId: input.assetId,
    type: 'broll',
    semanticKind: 'visual',
    sourceInMs: input.sourceInMs ?? 0,
    sourceOutMs: input.sourceOutMs ?? 3000,
    visualObservation: input.visualObservation,
    materialPatterns: input.materialPatterns ?? ['旧模式标签不应进入 post-lock packet'],
  };
}

function speechSpan(input: {
  id: string;
  assetId: string;
  sourceInMs: number;
  sourceOutMs: number;
  visualObservation?: string;
}) {
  return {
    id: input.id,
    assetId: input.assetId,
    type: 'drive',
    semanticKind: input.id.includes('_mixed_') ? 'mixed' : 'speech',
    sourceInMs: input.sourceInMs,
    sourceOutMs: input.sourceOutMs,
    transcript: '这里保留原片口播事实，但当前 Resolve clip 没有字幕重叠。',
    transcriptSegments: [{
      startMs: input.sourceInMs,
      endMs: input.sourceOutMs,
      text: '这里保留原片口播事实。',
    }],
    visualObservation: input.visualObservation,
    materialPatterns: ['行车口播旧标签', '有口播语音'],
  };
}

function expectEvidence(clip: Record<string, unknown>, expected: {
  source: string;
  visualObservation: string;
}) {
  expect(clip.narrationVisualEvidence).toMatchObject(expected);
}

function findObjectKeys(value: unknown, keyName: string): string[] {
  const matches: string[] = [];
  const visit = (item: unknown, path: string) => {
    if (Array.isArray(item)) {
      item.forEach((child, index) => visit(child, `${path}[${index}]`));
      return;
    }
    if (!item || typeof item !== 'object') return;
    for (const [key, child] of Object.entries(item)) {
      const childPath = path ? `${path}.${key}` : key;
      if (key === keyName) matches.push(childPath);
      visit(child, childPath);
    }
  };
  visit(value, '');
  return matches;
}

async function readJson(path: string) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function writeJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function fileExists(path: string) {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}
