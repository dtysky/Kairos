// A presentation of persisted Color facts, never a new workflow state machine.
export function colorNeedsApply(root) {
  return root?.classification?.status === 'ready' && Boolean(root.classification.batchFingerprint);
}

export function colorReadyForExport(root) {
  return root?.classification?.status === 'ready'
    && !colorNeedsApply(root)
    && root?.current?.timelineStatus === 'ready'
    && !root?.blockers?.length
    && root?.hostPreflight?.status !== 'blocked';
}

export function colorProjectWorkflow(roots, liveJob) {
  const pendingRoots = roots.filter(root => root.classification?.status === 'pending-agent');
  const accepted = roots.filter(root => root.classification?.status === 'ready');
  const prepared = accepted.filter(root => !colorNeedsApply(root) && root.current?.timelineStatus === 'ready');
  const blockers = roots.flatMap(root => [...(root.blockers || []), ...(root.hostPreflight?.status === 'blocked' ? ['Resolve 连接检查未通过'] : [])]
    .map(reason => `${root.label || root.rootId}：${reason}`));
  const unprepared = roots.length - accepted.length - pendingRoots.length;
  const missingHandoff = pendingRoots.some(root => !root.classification.handoffPath);
  const pendingCount = pendingRoots.reduce((sum, root) => sum + (root.classification.pendingCount || 0), 0);
  const batches = roots.filter(root => root.current?.latestBatchId);
  const passed = batches.filter(root => root.current.latestValidationStatus === 'pass');
  const validationPending = batches.filter(root => root.current.latestValidationStatus !== 'pass');
  let current = 0, action = 'prepare_all_roots', label = '检查并准备项目';
  let title = '统一准备项目素材';
  let body = '一次检查所有已登记目录，复用已有分析和技术检测；只有新增或变化素材需要重新处理。';
  if (!unprepared && pendingRoots.length && !missingHandoff) {
    current = 1; action = 'agent'; label = '复制项目分类任务'; title = '等待 Agent 完成分类';
    body = `共 ${pendingCount} 个素材待分类。一次复制所有待办，交给 Codex 的 gpt-6.1-sol / high subagent 判断；提交后统一应用到 Resolve。`;
  } else if (missingHandoff) {
    label = '重新生成项目分类任务'; body = '部分待分类任务缺少交接文件，请重新准备项目。有效检测与已接受结果会复用。';
  } else if (accepted.length === roots.length && prepared.length < roots.length) {
    current = 2; label = '应用项目分类到 Resolve'; title = '分类已接受，统一应用到 Resolve';
    body = '一次应用所有目录的分类、输入色彩管理和标准模板，保留既有手动调整。';
  } else if (roots.length && prepared.length === roots.length) {
    current = 3; action = 'export_all_roots'; label = '调色后导出项目'; title = '项目已准备好，请在 Resolve 中调色';
    body = '完成项目各时间线的人工调色后，一次导出并校验全部素材。准备完成不表示人工调色已经完成。';
    if (validationPending.length) {
      current = 4; action = 'review_validation'; label = '查看待校验输出'; title = '最近导出仍有校验待办';
      body = `${validationPending.length} 个目录的最近输出待校验或未通过；进入维护区查看具体输出和重试入口。`;
    }
  }
  if (blockers.length && action !== 'review_validation') {
    action = 'prepare_all_roots'; label = '修复后重新检查项目'; title = '项目有准备条件需要处理';
    body = blockers.join('；');
  }
  if (liveJob) {
    title = liveJob.status === 'queued' ? '项目任务已排队' : '正在处理项目';
    body = liveJob.progress?.detail || '处理进度来自当前 Supervisor 任务。';
    label = '任务进行中…';
    current = liveJob.args?.action === 'validate_batch' ? 4
      : ['execute_root', 'export_all_roots'].includes(liveJob.args?.action) ? 3 : current;
  }
  const ratio = count => `${count}/${roots.length} 个目录`;
  return { current, action, label, title, body, pendingRoots, pendingCount,
    prepared: roots.length > 0 && prepared.length === roots.length, blockers, validationPending,
    tone: blockers.length ? 'error' : pendingRoots.length ? 'warn' : 'accent',
    steps: [
      { title: '检查与检测', status: ratio(accepted.length + pendingRoots.length), detail: '统一检查，增量复用' },
      { title: 'Agent 分类', status: pendingCount ? `${pendingCount} 个素材待分类` : ratio(accepted.length), detail: '一次交接全部待办' },
      { title: '应用到 Resolve', status: ratio(prepared.length), detail: '统一应用分组与模板' },
      { title: '人工调色与导出', status: prepared.length === roots.length ? '由你调色后导出' : '待准备', detail: '一次导出全部素材' },
      { title: '结果校验', status: !batches.length ? '尚无导出' : `最近 ${passed.length}/${batches.length} 批通过`, detail: '输出与媒体信息' },
    ] };
}

// Project-wide execution does not imply shared per-directory configuration.
export function updateRootColorOutput(config, rootId, key, value) {
  if (!['container', 'videoCodec', 'audioCodec', 'bitrateKbps'].includes(key)) return config;
  return { ...config, mappings: (config?.mappings || []).map(root => {
    if (root.enabled === false || String(root.rootId || root.id) !== rootId) return root;
    return { ...root, color: { ...root.color, renderPreset: { ...root.color?.renderPreset, [key]: value } } };
  }) };
}

export function aggregateColorGroups(roots) {
  const groups = new Map();
  for (const root of roots) for (const group of root.groups || []) {
    const key = `${group.nativeGroup !== false}:${group.displayName}`;
    const row = groups.get(key) || { groupKey: key, displayName: group.displayName, nativeGroup: group.nativeGroup, clipCount: 0, clips: [] };
    row.clipCount += group.clipCount || 0;
    row.clips.push(...(group.clips || []).map(clip => ({ ...clip, sourceRootId: root.rootId,
      sourceLabel: root.label || root.rootId, sourceTimeline: root.gradingTimelineName,
      displayKey: `${root.rootId}:${group.groupKey}:${clip.clipKey}` })));
    groups.set(key, row);
  }
  return [...groups.values()];
}
