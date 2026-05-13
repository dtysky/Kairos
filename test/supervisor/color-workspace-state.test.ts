import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildColorWorkspaceState } from '../../src/modules/color/workspace-state.js';

const resolveBackendReady = {
  available: true,
  backendRoot: '/vendor/resolve-color-host',
  pythonPath: '/vendor/resolve-color-host/.venv/bin/python',
  scriptPath: '/vendor/resolve-color-host/resolve-color-host.py',
  missingPaths: [],
};

function makeReadableDir(label: string): string {
  const path = mkdtempSync(join(tmpdir(), `kairos-color-state-${label}-`));
  mkdirSync(path, { recursive: true });
  return path;
}

describe('color workspace state', () => {
  it('materializes color roots from ingest roots with rawPath', () => {
    const currentDir = makeReadableDir('current');
    const state = buildColorWorkspaceState({
      projectId: 'project-color',
      projectRoots: [
        {
          id: 'root-camera',
          path: currentDir,
          rawPath: '/media/raw/camera',
          label: '主机位',
          description: 'Sony 主机位',
          enabled: true,
        },
        {
          id: 'root-broll',
          path: '/media/current/broll',
          label: '补镜头',
          enabled: true,
        },
      ],
      resolveBackend: resolveBackendReady,
      colorCurrent: { roots: [] },
    });

    expect(state.colorRoots).toHaveLength(1);
    expect(state.colorRoots[0]?.rootId).toBe('root-camera');
    expect(state.colorRoots[0]?.rawPath).toBe('/media/raw/camera');
    expect(state.colorRoots[0]?.resolveProjectName).toBe('project-color [Color]');
    expect(state.colorRoots[0]?.rootNamespace).toBe('主机位 [Color Root]');
    expect(state.colorRoots[0]?.gradingTimelineName).toBe('主机位 [Color]');
    expect(state.colorRoots[0]?.renderPreset.container).toBe('mp4');
    expect(state.colorRoots[0]?.colorCurrent.mirrorStatus).toBe('blocked');
    expect(state.colorRoots[0]?.colorCurrent.timelineStatus).toBe('blocked');
    expect(state.colorRoots[0]?.colorCurrent.groupSyncStatus).toBe('blocked');
    expect(state.colorRoots[0]?.colorCurrent.hostPreflight?.status).toBe('unknown');
    expect(state.colorRoots[0]?.blockingReasons.some(reason => reason.startsWith('原始素材路径未命中'))).toBe(true);
    expect(state.colorRoots[0]?.blockingReasons).toContain('未配置 root 级 renderPreset.bitrateKbps（kb/s），后续 execute_root 无法启动。');
    expect(state.colorCurrent.selectedRootId).toBe('root-camera');
  });

  it('materializes renderPreset from project roots and keeps current group runtime state', () => {
    const currentDir = makeReadableDir('current');
    const rawDir = makeReadableDir('raw');
    const state = buildColorWorkspaceState({
      projectId: 'project-color',
      projectRoots: [{
        id: 'root-camera',
        path: currentDir,
        rawPath: rawDir,
        color: {
          renderPreset: {
            container: 'mp4',
            videoCodec: 'h265',
            audioCodec: 'aac',
            bitrateKbps: 80,
          },
        },
        enabled: true,
      }],
      resolveBackend: resolveBackendReady,
      groupSnapshotsByRootId: {
        'root-camera': {
          rootId: 'root-camera',
          syncedAt: '2026-04-19T10:00:00.000Z',
          timelineName: 'root__root-camera__grading',
          groups: [{
            groupKey: 'group-day',
            displayName: 'Day Group',
            clipKeys: ['day/clip001.mov'],
            clips: [{
              clipKey: 'day/clip001.mov',
              displayName: 'clip001',
              gyroEligible: true,
              gyroflowStatus: 'ready-to-load',
              dehazeStatus: 'seeded-disabled',
              nrStatus: 'seeded-disabled',
              clipRepairStatus: 'ready',
              layoutStatus: 'canonical',
              reservedNodeIndices: {
                gyro: 1,
                dehaze: 2,
                userStart: 3,
                userEnd: 4,
                nr: 5,
              },
              hostSummary: {
                layoutStatus: 'canonical',
              },
            }],
            hostSummary: {},
          }],
        },
      },
      colorCurrent: {
        hostPreflight: {
          status: 'degraded',
          checkedAt: '2026-04-20T10:00:00.000Z',
          warnings: ['legacy probe'],
          blockingReasons: [],
          renderSupport: {
            containers: [{
              container: 'mp4',
              extension: 'mp4',
              videoCodecs: ['h265'],
            }],
            supportsAudioCodec: true,
            supportsVideoQuality: false,
          },
        },
        roots: [{
          rootId: 'root-camera',
          mirrorStatus: 'synced',
          timelineStatus: 'ready',
          groupSyncStatus: 'ready',
          groups: [{
            groupKey: 'group-day',
            status: 'running',
            displayName: 'Day Group',
            clipCount: 1,
            latestBatchId: 'batch-2',
          }, {
            groupKey: 'group-legacy',
            status: 'blocked',
            blockingReasons: ['legacy blocked'],
          }],
        }],
      },
    });

    expect(state.colorRoots[0]?.blockingReasons).toEqual([]);
    expect(state.colorRoots[0]?.renderPreset.bitrateKbps).toBe(80);
    expect(state.colorRoots[0]?.colorCurrent.mirrorStatus).toBe('synced');
    expect(state.colorRoots[0]?.colorCurrent.timelineStatus).toBe('ready');
    expect(state.colorRoots[0]?.colorCurrent.groupSyncStatus).toBe('ready');
    expect(state.colorRoots[0]?.hostPreflight?.status).toBe('degraded');
    expect(state.colorRoots[0]?.groups[0]?.displayName).toBe('Day Group');
    expect(state.colorRoots[0]?.groups[0]?.clipCount).toBe(1);
    expect(state.colorRoots[0]?.groups[0]?.clips[0]).toMatchObject({
      dehazeStatus: 'seeded-disabled',
      nrStatus: 'seeded-disabled',
      layoutStatus: 'canonical',
      reservedNodeIndices: {
        gyro: 1,
        dehaze: 2,
        userStart: 3,
        userEnd: 4,
        nr: 5,
      },
    });
    expect(state.colorRoots[0]?.colorCurrent.groups).toEqual([
      {
        groupKey: 'group-day',
        status: 'running',
        displayName: 'Day Group',
        clipCount: 1,
        latestBatchId: 'batch-2',
        latestBatchStatus: undefined,
        latestValidationStatus: undefined,
        pendingPromoteBatchId: undefined,
        lastPromotedBatchId: undefined,
        blockingReasons: [],
      },
      {
        groupKey: 'group-legacy',
        status: 'blocked',
        displayName: 'group-legacy',
        clipCount: 0,
        latestBatchId: undefined,
        latestBatchStatus: undefined,
        latestValidationStatus: undefined,
        pendingPromoteBatchId: undefined,
        lastPromotedBatchId: undefined,
        blockingReasons: ['legacy blocked'],
      },
    ]);
  });

  it('projects blocked host preflight into root blockers before actions start', () => {
    const currentDir = makeReadableDir('current');
    const rawDir = makeReadableDir('raw');
    const state = buildColorWorkspaceState({
      projectId: 'project-color',
      projectRoots: [{
        id: 'root-camera',
        path: currentDir,
        rawPath: rawDir,
        enabled: true,
      }],
      resolveBackend: resolveBackendReady,
      colorCurrent: {
        hostPreflight: {
          status: 'blocked',
          checkedAt: '2026-04-20T10:00:00.000Z',
          warnings: [],
          blockingReasons: ['Resolve is not running'],
        },
        roots: [],
      },
    });

    expect(state.colorRoots[0]?.blockingReasons).toContain('Resolve is not running');
    expect(state.colorRoots[0]?.hostPreflight?.status).toBe('blocked');
  });

  it('uses resolved alternate paths as the visible color paths without requiring project path blockers', () => {
    const currentDir = makeReadableDir('current');
    const rawDir = makeReadableDir('raw');
    const state = buildColorWorkspaceState({
      projectId: 'project-color',
      projectRoots: [{
        id: 'root-camera',
        path: '/media/current/camera',
        rawPath: '/media/raw/camera',
        alternatePaths: [{
          path: currentDir,
          rawPath: rawDir,
        }],
        color: {
          renderPreset: {
            container: 'mp4',
            videoCodec: 'h265',
            audioCodec: 'aac',
            bitrateKbps: 60,
          },
        },
        enabled: true,
      }],
      resolveBackend: resolveBackendReady,
      colorCurrent: { roots: [] },
    });

    expect(state.colorRoots[0]?.currentPath).toBe(currentDir);
    expect(state.colorRoots[0]?.displayRawPath).toBe(rawDir);
    expect(state.colorRoots[0]?.blockingReasons.some(reason => reason.startsWith('当前素材路径未命中'))).toBe(false);
  });

  it('surfaces vendored backend blockers before host preflight is cached', () => {
    const currentDir = makeReadableDir('current');
    const rawDir = makeReadableDir('raw');
    const state = buildColorWorkspaceState({
      projectId: 'project-color',
      projectRoots: [{
        id: 'root-camera',
        path: currentDir,
        rawPath: rawDir,
        color: {
          renderPreset: {
            container: 'mp4',
            videoCodec: 'h265',
            audioCodec: 'aac',
            bitrateKbps: 80,
          },
        },
        enabled: true,
      }],
      resolveBackend: {
        available: false,
        backendRoot: '/vendor/resolve-color-host',
        pythonPath: '/vendor/resolve-color-host/.venv/bin/python',
        scriptPath: '/vendor/resolve-color-host/resolve-color-host.py',
        missingPaths: ['/vendor/resolve-color-host/.venv/bin/python'],
        blockingReason: '未找到 vendored Resolve backend。 期望脚本：/vendor/resolve-color-host/resolve-color-host.py；期望 Python：/vendor/resolve-color-host/.venv/bin/python。 请先在 /vendor/resolve-color-host 下准备固定 backend 与 .venv。',
      },
      colorCurrent: { roots: [] },
    });

    expect(state.colorRoots[0]?.hostPreflight?.status).toBe('blocked');
    expect(state.colorRoots[0]?.blockingReasons.some(reason => reason.includes('vendored Resolve backend'))).toBe(true);
  });
});
