export function resolveEditFlowSelections({
  activeEditId,
  editFlowPlan,
  editRules,
  editUnit,
  styleSources,
}) {
  const hasSavedEditUnit = Boolean(editUnit?.editRuleCategory);
  return {
    editId: editUnit?.editId || editFlowPlan?.editId || activeEditId || 'main',
    editRuleCategory: editUnit?.editRuleCategory
      || editFlowPlan?.editRuleCategory
      || editRules?.defaultCategory
      || editRules?.categories?.[0]?.categoryId
      || '',
    styleCategory: hasSavedEditUnit
      ? editUnit?.styleCategory || ''
      : editFlowPlan?.styleUsage?.styleCategory
        || styleSources?.defaultCategory
        || '',
  };
}
