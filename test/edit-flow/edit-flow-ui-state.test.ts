import { describe, expect, it } from 'vitest';
import { resolveEditFlowSelections, resolveMediaPreparationState, splitEditFlowSteps } from '../../apps/kairos-console/src/edit-flow-state.js';

describe('edit flow UI selection state', () => {
  it('prepares project media without an edit unit and separates historical media-sync steps', () => {
    expect(resolveMediaPreparationState({ projectId: 'trip', jobs: [], spansReady: true, chronologyReady: true }))
      .toMatchObject({ disabled: false, active: false, label: '准备剪辑素材池' });
    const legacy = { id: 'sync', capabilityId: 'resolve.media_sync' };
    const timeline = { id: 'timeline', capabilityId: 'timeline.generate' };
    expect(splitEditFlowSteps([legacy, timeline])).toEqual({ active: [timeline], historical: [legacy] });
  });

  it('does not display stale progress from another job or treat a completed cache as live', () => {
    const job = { jobId: 'new', jobType: 'resolve-media-sync', projectId: 'trip', status: 'running',
      updatedAt: '2026-10-14', progress: { current: 200, total: 200, extra: { jobId: 'old' } } };
    expect(resolveMediaPreparationState({ projectId: 'trip', jobs: [job], spansReady: true, chronologyReady: true }))
      .toMatchObject({ disabled: true, active: true, progress: null });
    expect(resolveMediaPreparationState({ projectId: 'trip', jobs: [{ ...job, status: 'completed' }], spansReady: true, chronologyReady: true }))
      .toMatchObject({ disabled: false, active: false, label: '重新同步素材池' });
  });

  it('uses the saved edit unit style after async config hydration', () => {
    const selections = resolveEditFlowSelections({
      activeEditId: 'main',
      editUnit: {
        editId: 'main',
        editRuleCategory: 'travel-documentary',
        styleCategory: 'china-drive-travel-documentary-main',
      },
      editFlowPlan: {
        editId: 'main',
        editRuleCategory: 'travel-documentary',
        styleUsage: { styleCategory: 'old-plan-style' },
      },
      editRules: { defaultCategory: 'other-rule', categories: [] },
      styleSources: { defaultCategory: 'short-trip-photo-vlog' },
    });

    expect(selections).toMatchObject({
      editId: 'main',
      editRuleCategory: 'travel-documentary',
      styleCategory: 'china-drive-travel-documentary-main',
    });
  });

  it('does not backfill a saved no-style edit unit from stale plan or workspace default', () => {
    const selections = resolveEditFlowSelections({
      activeEditId: 'main',
      editUnit: {
        editId: 'main',
        editRuleCategory: 'travel-documentary',
      },
      editFlowPlan: {
        editId: 'main',
        editRuleCategory: 'travel-documentary',
        styleUsage: { styleCategory: 'old-plan-style' },
      },
      editRules: { defaultCategory: 'other-rule', categories: [] },
      styleSources: { defaultCategory: 'short-trip-photo-vlog' },
    });

    expect(selections.styleCategory).toBe('');
  });
});
