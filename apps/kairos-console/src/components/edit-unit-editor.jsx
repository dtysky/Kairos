import React, { useEffect, useRef, useState } from 'react';
import { Button, Tag } from '../ui-compat.tsx';
import { useConsoleState } from '../app-state.tsx';
import { resolveEditFlowSelections } from '../edit-flow-state.js';

export function EditUnitEditor({ activeEditId, editUnit, editUnits = [], editFlowPlan, editRules, styleSources, busy, onSave, onSelect }) {
  const { dispatch } = useConsoleState();
  const base = resolveEditFlowSelections({ activeEditId, editUnit, editFlowPlan, editRules, styleSources });
  const [draft, setDraft] = useState(base);
  const [creating, setCreating] = useState(false);
  const previousBase = useRef(base);
  const dirty = creating || Object.keys(base).some(key => draft[key] !== base[key]);
  const saved = Boolean(editUnit?.editRuleCategory);
  const duplicate = creating && editUnits.some(unit => unit.editId === draft.editId.trim());
  const validId = /^[a-z0-9][a-z0-9_-]*$/u.test(draft.editId.trim());
  const canSave = validId && draft.editRuleCategory && !duplicate && !busy;

  useEffect(() => {
    const previous = previousBase.current;
    if (!creating) setDraft(current => Object.keys(previous).every(key => current[key] === previous[key]) ? base : current);
    previousBase.current = base;
  }, [base.editId, base.editRuleCategory, base.styleCategory]);
  useEffect(() => {
    dispatch({ type: 'set-dirty', section: 'edit-unit', dirty });
  }, [dirty, dispatch]);
  useEffect(() => () => dispatch({ type: 'set-dirty', section: 'edit-unit', dirty: false }), [dispatch]);

  const change = (key, value) => setDraft(previous => ({ ...previous, [key]: value }));
  async function selectUnit(editId) {
    if (await onSelect(editId)) {
      setCreating(false);
      if (editId === activeEditId) setDraft(base);
    }
  }
  function startNew() {
    if (dirty && !window.confirm('当前剪辑单元还有未保存的修改，放弃这些修改并新建吗？')) return;
    setCreating(true);
    setDraft({ ...base, editId: '' });
  }

  return <>
    <div className="edit-flow-panel-head">
      <div>
        <h2>剪辑单元</h2>
        <p>选择已有专题，或新建剪辑单元；规则、计划与运行记录按单元分别保存。</p>
      </div>
      <div className="inline-actions">
        {dirty ? <Tag color="warning">未保存</Tag> : null}
        <Button disabled={!canSave} type="primary" onClick={async () => {
          if (await onSave({ ...draft, editId: draft.editId.trim() })) setCreating(false);
        }}>{busy ? '保存中…' : creating || !saved ? '创建剪辑单元' : '保存单元配置'}</Button>
      </div>
    </div>
    <div className="edit-flow-form-grid">
      <label className="edit-flow-field">
        <span>{`已有剪辑单元（${editUnits.length}）`}</span>
        <select aria-label="已有剪辑单元" value={creating || !saved ? '' : activeEditId} disabled={busy}
          onChange={event => selectUnit(event.target.value)}>
          <option value="" disabled>{creating ? '正在新建剪辑单元' : '暂无已选择的剪辑单元'}</option>
          {editUnits.map(unit => <option key={unit.editId} value={unit.editId}>{unit.editId}</option>)}
        </select>
      </label>
      <div className="inline-actions">
        <Button disabled={busy || creating} onClick={startNew}>新建剪辑单元</Button>
      </div>
      <label className="edit-flow-field">
        <span>Edit ID</span>
        <input value={draft.editId} readOnly={saved && !creating} disabled={busy}
          onChange={event => change('editId', event.target.value)} />
      </label>
      <label className="edit-flow-field">
        <span>剪辑规则</span>
        <select value={draft.editRuleCategory} disabled={busy} onChange={event => change('editRuleCategory', event.target.value)}>
          <option value="">请选择</option>
          {(editRules?.categories || []).map(category => <option key={category.categoryId} value={category.categoryId}>
            {category.displayName || category.categoryId}
          </option>)}
        </select>
      </label>
      <label className="edit-flow-field">
        <span>风格档案</span>
        <select value={draft.styleCategory} disabled={busy} onChange={event => change('styleCategory', event.target.value)}>
          <option value="">不使用</option>
          {(styleSources?.categories || []).map(category => <option key={category.categoryId} value={category.categoryId}>
            {category.displayName || category.categoryId}
          </option>)}
        </select>
      </label>
    </div>
    {duplicate ? <p role="alert">此 Edit ID 已存在，请从已有剪辑单元中选择。</p> : null}
    {draft.editId && !validId ? <p role="alert">Edit ID 使用小写英文字母、数字、连字符或下划线，以字母或数字开头。</p> : null}
  </>;
}
