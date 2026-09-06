import { describe, expect, it } from 'vitest';
import {
  createResolveRoughCutTimeline,
  regenerateResolveRoughCutTimelineSuffix,
  syncResolveRoughCutMedia,
} from '../../src/modules/timeline-core/resolve-rough-cut.js';

describe('Resolve rough-cut runner', () => {
  it('does not pass bounded child-process wait options to media sync or timeline generation', async () => {
    const forbiddenOption = ['time', 'out'].join('');
    const execCalls: Array<{ operation: string; hasForbiddenOption: boolean }> = [];
    const execFileImpl = async (_file: string, _args: readonly string[], options: Record<string, unknown>) => {
      execCalls.push({
        operation: ['sync_rough_cut_media', 'create_rough_cut_timeline', 'regenerate_rough_cut_suffix'][execCalls.length]!,
        hasForbiddenOption: Object.prototype.hasOwnProperty.call(options, forbiddenOption),
      });
      return {
        stdout: JSON.stringify(execCalls.length === 1
          ? {
              resolveProjectName: 'Project [Edit]',
              namespace: 'Kairos Project Media',
              createdAt: '2026-05-23T00:00:00.000Z',
            }
          : {
              resolveProjectName: 'Project [Edit]',
              timelineName: 'Main [main]',
              createdAt: '2026-05-23T00:00:00.000Z',
              clipCount: 0,
            }),
        stderr: '',
      };
    };

    await syncResolveRoughCutMedia({
      projectId: 'project-1',
      resolveProjectName: 'Project [Edit]',
      clips: [],
    }, {
      pythonPath: 'python',
      scriptPath: 'resolve-color-host.py',
    }, execFileImpl);

    await createResolveRoughCutTimeline({
      projectId: 'project-1',
      resolveProjectName: 'Project [Edit]',
      timelineName: 'Main [main]',
      timelineSpec: {
        width: 1920,
        height: 1080,
        fps: 30,
      },
      clips: [],
    }, {
      pythonPath: 'python',
      scriptPath: 'resolve-color-host.py',
    }, execFileImpl);

    await regenerateResolveRoughCutTimelineSuffix({
      projectId: 'project-1',
      resolveProjectName: 'Project [Edit]',
      timelineName: 'Main [main]',
      timelineSpec: {
        width: 1920,
        height: 1080,
        fps: 30,
      },
      clips: [],
    }, {
      pythonPath: 'python',
      scriptPath: 'resolve-color-host.py',
    }, execFileImpl);

    expect(execCalls).toEqual([
      { operation: 'sync_rough_cut_media', hasForbiddenOption: false },
      { operation: 'create_rough_cut_timeline', hasForbiddenOption: false },
      { operation: 'regenerate_rough_cut_suffix', hasForbiddenOption: false },
    ]);
  });
});
