import { describe, expect, it } from 'vitest';
import { buildColorWorkspaceState } from '../../src/modules/color/workspace-state.js';

describe('color workspace state', () => {
  it('materializes color roots from ingest roots with rawPath', () => {
    const state = buildColorWorkspaceState({
      projectId: 'project-color',
      ingestRoots: [
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
      ingestRootSummaries: [{
        rootId: 'root-camera',
        assetCount: 3,
        firstAnchor: {
          assetId: 'asset-1',
          displayName: 'A001.MP4',
          sortCapturedAt: '2026-04-17T09:00:00.000Z',
        },
      }],
      colorConfig: { roots: [] },
      colorCurrent: { roots: [] },
    });

    expect(state.colorRoots).toHaveLength(1);
    expect(state.colorRoots[0]?.rootId).toBe('root-camera');
    expect(state.colorRoots[0]?.rawPath).toBe('/media/raw/camera');
    expect(state.colorRoots[0]?.assetCount).toBe(3);
    expect(state.colorRoots[0]?.colorConfig.resolveProjectName).toBe('kairos__project-color');
    expect(state.colorRoots[0]?.colorConfig.renderPreset.container).toBe('mp4');
    expect(state.colorRoots[0]?.colorCurrent.mirrorStatus).toBe('blocked');
    expect(state.colorRoots[0]?.colorCurrent.timelineStatus).toBe('blocked');
    expect(state.colorRoots[0]?.blockingReasons).toContain('当前设备未配置 rawLocalPath，无法在本机访问原始素材。');
    expect(state.colorRoots[0]?.blockingReasons).toContain('未配置 root 级目标码率，当前只能查看配置与状态。');
    expect(state.colorCurrent.selectedRootId).toBe('root-camera');
  });

  it('merges configured groups with current group runtime state', () => {
    const state = buildColorWorkspaceState({
      projectId: 'project-color',
      ingestRoots: [{
        id: 'root-camera',
        path: '/media/current/camera',
        rawPath: '/media/raw/camera',
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
      colorConfig: {
        roots: [{
          rootId: 'root-camera',
          renderPreset: {
            container: 'mp4',
            videoCodec: 'h265',
            audioCodec: 'aac',
            bitrateMbps: 80,
          },
          groups: [{
            groupKey: 'group-day',
            displayName: 'Day Group',
            technicalSummary: ['S-Log3', 'daylight'],
          }],
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
