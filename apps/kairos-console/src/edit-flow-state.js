export function editSelectionStorageKey(projectId) {
  return `kairos.console.editId:${projectId}`;
}

export function resolveProjectEditId(editUnits = [], preferredEditId, legacyEditId) {
  const ids = editUnits.map(unit => unit.editId);
  if (ids.includes(preferredEditId)) return preferredEditId;
  if (ids.includes(legacyEditId)) return legacyEditId;
  return ids[0] || 'main';
}

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

export function resolveMediaPreparationState({ projectId, jobs = [], spansReady, chronologyReady, submitting }) {
  const ownJobs = jobs.filter(job => job.projectId === projectId && job.jobType === 'resolve-media-sync')
    .sort((a, b) => String(b.startedAt || b.updatedAt).localeCompare(String(a.startedAt || a.updatedAt)));
  const latest = ownJobs.find(job => ['queued', 'running'].includes(job.status)) || ownJobs[0];
  const active = latest && ['queued', 'running'].includes(latest.status);
  const conflict = jobs.find(job => ['queued', 'running'].includes(job.status) && (
    ['color', 'resolve-media-sync'].includes(job.jobType)
    || (job.projectId === projectId && ['ingest', 'gps-refresh', 'analyze', 'spatial-refresh', 'span-rebuild', 'chronology-build'].includes(job.jobType))
  ));
  const blocker = !projectId ? '请先选择项目'
    : !chronologyReady ? '请先确认编年史'
    : !spansReady ? '请先完成素材片段生成与审查'
    : conflict && !active ? '请等待当前素材准备或 Resolve 任务结束' : '';
  const progress = latest?.progress?.extra?.jobId === latest?.jobId ? latest?.progress : null;
  return {
    latest, active: Boolean(active), progress,
    disabled: Boolean(submitting || blocker || active), blocker,
    label: active ? '素材池准备中…' : latest?.status === 'completed' ? '重新同步素材池'
      : latest ? '重试素材池准备' : '准备剪辑素材池',
    summary: latest?.status === 'completed' ? latest.result?.hostSummary : null,
  };
}

export function splitEditFlowSteps(steps = []) {
  return {
    active: steps.filter(step => step.capabilityId !== 'resolve.media_sync'),
    historical: steps.filter(step => step.capabilityId === 'resolve.media_sync'),
  };
}
