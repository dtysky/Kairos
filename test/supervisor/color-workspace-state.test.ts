import { describe, expect, it } from 'vitest';
import { buildColorWorkspaceState } from '../../src/modules/color/workspace-state.js';

describe('color workspace state', () => {
  it('materializes color roots from ingest roots with rawPath', () => {
    const state = buildColorWorkspaceState({
      projectId: 'project-color',
      projectRoots: [
        {
          id: 'root-camera',
          path: '/media/current/camera',
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
      deviceProjectMap: {
        projectId: 'project-color',
        roots: [{
          rootId: 'root-camera',
          localPath: 'F:\\current\\camera',
        }],
      },
      colorCurrent: { roots: [] },
    });

    expect(state.colorRoots).toHaveLength(1);
    expect(state.colorRoots[0]?.rootId).toBe('root-camera');
    expect(state.colorRoots[0]?.rawPath).toBe('/media/raw/camera');
    expect(state.colorRoots[0]?.resolveProjectName).toBe('kairos__project-color');
    expect(state.colorRoots[0]?.rootNamespace).toBe('root__root-camera');
    expect(state.colorRoots[0]?.gradingTimelineName).toBe('root__root-camera__grading');
    expect(state.colorRoots[0]?.renderPreset.container).toBe('mp4');
    expect(state.colorRoots[0]?.colorCurrent.mirrorStatus).toBe('blocked');
    expect(state.colorRoots[0]?.colorCurrent.timelineStatus).toBe('blocked');
    expect(state.colorRoots[0]?.blockingReasons).toContain('当前设备未配置 rawLocalPath，无法在本机访问原始素材。');
    expect(state.colorRoots[0]?.blockingReasons).toContain('未配置 root 级 renderPreset.bitrateMbps，后续 execute_group 无法启动。');
    expect(state.colorCurrent.selectedRootId).toBe('root-camera');
  });

  it('materializes renderPreset from project roots and keeps current group runtime state', () => {
    const state = buildColorWorkspaceState({
      projectId: 'project-color',
      projectRoots: [{
        id: 'root-camera',
        path: '/media/current/camera',
        rawPath: '/media/raw/camera',
        color: {
          renderPreset: {
            container: 'mp4',
            videoCodec: 'h265',
            audioCodec: 'aac',
            bitrateMbps: 80,
          },
        },
        enabled: true,
      }],
      deviceProjectMap: {
        projectId: 'project-color',
        roots: [{
          rootId: 'root-camera',
          localPath: 'F:\\current\\camera',
          rawLocalPath: 'F:\\raw\\camera',
        }],
      },
      colorCurrent: {
        roots: [{
          rootId: 'root-camera',
          mirrorStatus: 'synced',
          timelineStatus: 'ready',
          groups: [{
            groupKey: 'group-day',
            status: 'running',
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
    expect(state.colorRoots[0]?.renderPreset.bitrateMbps).toBe(80);
    expect(state.colorRoots[0]?.colorCurrent.mirrorStatus).toBe('synced');
    expect(state.colorRoots[0]?.colorCurrent.timelineStatus).toBe('ready');
    expect(state.colorRoots[0]?.colorCurrent.groups).toEqual([
      {
        groupKey: 'group-day',
        status: 'running',
        latestBatchId: 'batch-2',
        blockingReasons: [],
      },
      {
        groupKey: 'group-legacy',
        status: 'blocked',
        latestBatchId: undefined,
        blockingReasons: ['legacy blocked'],
      },
    ]);
  });
});
