import { describe, expect, it } from 'vitest';
import { resolveEditFlowSelections } from '../../apps/kairos-console/src/edit-flow-state.js';

describe('edit flow UI selection state', () => {
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
