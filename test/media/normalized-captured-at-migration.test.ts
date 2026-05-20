import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const workspaces: string[] = [];

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe('normalized capturedAt migration', () => {
  it('migrates only the supported project and marks stale edit artifacts', async () => {
    const repoRoot = process.cwd();
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'kairos-time-migration-test-'));
    workspaces.push(workspaceRoot);
    const projectRoot = join(workspaceRoot, 'projects', 'bingchacha-genie-south-zimeiyakou');
    await mkdir(join(projectRoot, 'store'), { recursive: true });
    await mkdir(join(projectRoot, 'config'), { recursive: true });
    await mkdir(join(projectRoot, 'media'), { recursive: true });
    await mkdir(join(projectRoot, 'gps'), { recursive: true });
    await mkdir(join(projectRoot, 'edits', 'main', 'planning'), { recursive: true });
    await mkdir(join(projectRoot, 'edits', 'main', 'script'), { recursive: true });

    await writeFile(join(projectRoot, 'config', 'project-brief.json'), JSON.stringify({
      name: 'Project',
      mappings: [{
        rootId: 'root-a',
        rootCode: 'cam',
        path: 'media',
        description: 'Camera',
        clockOffsetMs: -611_000,
      }],
    }, null, 2), 'utf-8');
    await writeFile(join(projectRoot, 'store', 'assets.json'), JSON.stringify([
      {
        id: 'A001_cam',
        kind: 'video',
        sourcePath: 'A001.mp4',
        displayName: 'A001.mp4',
        ingestRootId: 'root-a',
        capturedAt: '2026-04-12T08:09:46.000Z',
        createdAt: '2026-04-12T08:09:46.000Z',
        captureTimeSource: 'filename',
      },
      {
        id: 'A002_cam',
        kind: 'video',
        sourcePath: 'A002.mp4',
        displayName: 'A002.mp4',
        ingestRootId: 'root-a',
        capturedAt: '2026-04-12T09:00:00.000Z',
        captureTimeSource: 'manual',
      },
    ], null, 2), 'utf-8');
    await writeFile(join(projectRoot, 'media', 'chronology.json'), JSON.stringify({
      schemaVersion: '2.0',
      status: 'confirmed',
      generatedAt: '2026-05-20T00:00:00.000Z',
      inputsHash: 'hash',
      assetIndex: [{ assetId: 'A001_cam', sortCapturedAt: '2026-04-12T08:09:46.000Z' }],
      events: [],
    }, null, 2), 'utf-8');
    await writeFile(join(projectRoot, 'gps', 'derived.json'), JSON.stringify({
      schemaVersion: '1.0',
      updatedAt: '2026-05-20T00:00:00.000Z',
      entries: [{
        sourceAssetId: 'A001_cam',
        time: '2026-04-12T08:09:46.000Z',
        summary: 'point 2026-04-12T08:09:46.000Z',
      }],
    }, null, 2), 'utf-8');
    await writeFile(join(projectRoot, 'edits', 'main', 'planning', 'flow-plan.json'), JSON.stringify({
      schemaVersion: '1.0',
      plannerPolicyVersion: 'rule-explicit-v1',
      materialIdPolicyVersion: 'human-source-v1',
      id: 'plan-a',
      editId: 'main',
      editRuleCategory: 'travel-doc',
      editRuleHash: 'hash',
      generatedAt: '2026-05-20T00:00:00.000Z',
      status: 'confirmed',
      assumptions: [],
      steps: [],
    }, null, 2), 'utf-8');
    await writeFile(join(projectRoot, 'edits', 'main', 'planning', 'edit-framework.md'), '# Framework\n', 'utf-8');
    await writeFile(join(projectRoot, 'edits', 'main', 'script', 'material-slots.json'), JSON.stringify({
      id: 'slots',
      projectId: 'project',
      generatedAt: '2026-05-20T00:00:00.000Z',
      segments: [],
    }, null, 2), 'utf-8');

    const scriptPath = join(repoRoot, 'scripts', 'migrate-normalized-captured-at.mjs');
    const dryRun = await execFileAsync(process.execPath, [scriptPath, '--dry-run'], { cwd: workspaceRoot });
    expect(JSON.parse(dryRun.stdout).shiftedAssetCount).toBe(1);

    await execFileAsync(process.execPath, [scriptPath, '--apply'], { cwd: workspaceRoot });

    const assets = JSON.parse(await readFile(join(projectRoot, 'store', 'assets.json'), 'utf-8'));
    expect(assets[0]).toMatchObject({
      rawCapturedAt: '2026-04-12T08:09:46.000Z',
      capturedAt: '2026-04-12T07:59:35.000Z',
      createdAt: '2026-04-12T07:59:35.000Z',
      appliedClockOffsetMs: -611_000,
    });
    expect(assets[1]).toMatchObject({
      capturedAt: '2026-04-12T09:00:00.000Z',
      appliedClockOffsetMs: 0,
    });

    const chronology = JSON.parse(await readFile(join(projectRoot, 'media', 'chronology.json'), 'utf-8'));
    expect(chronology.status).toBe('stale');
    expect(chronology.assetIndex[0].sortCapturedAt).toBe('2026-04-12T07:59:35.000Z');

    const derived = JSON.parse(await readFile(join(projectRoot, 'gps', 'derived.json'), 'utf-8'));
    expect(derived.entries[0].time).toBe('2026-04-12T07:59:35.000Z');
    expect(derived.entries[0].summary).toContain('2026-04-12T07:59:35.000Z');

    const flowPlan = JSON.parse(await readFile(join(projectRoot, 'edits', 'main', 'planning', 'flow-plan.json'), 'utf-8'));
    expect(flowPlan.status).toBe('stale');
    expect(flowPlan.materialTimePolicyVersion).toBe('normalized-captured-at-v1');
    expect(await readFile(join(projectRoot, 'edits', 'main', 'planning', 'edit-framework.md'), 'utf-8'))
      .toContain('STALE: material time policy changed');
  });
});
