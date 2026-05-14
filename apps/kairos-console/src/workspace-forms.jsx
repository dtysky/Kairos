import React from 'react';
import { Button, Card, Divider, Modal, Tag } from 'hana-ui';

const COLOR_SOURCE_PROFILE_OPTIONS = [
  { value: '', label: '自动 / 未指定' },
  { value: 'slog3', label: 'S-Log3' },
  { value: 'dlog', label: 'D-Log' },
  { value: 'dlog-m', label: 'D-Log M' },
  { value: 'hlg', label: 'HLG' },
  { value: 'rec709', label: 'Rec.709' },
];
const COLOR_SOURCE_PROFILE_HINT = COLOR_SOURCE_PROFILE_OPTIONS
  .filter(option => option.value)
  .map(option => option.value)
  .join(' / ');

export function WorkflowPrompt({
  eyebrow = 'Next Step',
  title,
  body,
  tone = 'accent',
  actions = null,
  detail = '',
}) {
  return (
    <div className={`workflow-prompt workflow-prompt-${tone}`}>
      <div className="workflow-prompt-copy">
        <div className="workflow-prompt-eyebrow">{eyebrow}</div>
        <h3>{title}</h3>
        <p>{body}</p>
        {detail ? <div className="workflow-prompt-detail">{detail}</div> : null}
      </div>
      {actions ? <div className="workflow-prompt-actions">{actions}</div> : null}
    </div>
  );
}

export function ProjectBriefEditor({ config, pharosStatus, summaries = [], setConfig, onSave, busy }) {
  if (!config) return null;
  const summariesByRootId = new Map(
    (Array.isArray(summaries) ? summaries : [])
      .filter(isPlainObject)
      .map(summary => [String(summary.rootId || ''), summary]),
  );
  const pharosRootPath = pharosStatus?.rootPath || 'projects/<projectId>/pharos';
  const pharosNoticeTitle = pharosStatus?.status === 'success'
    ? 'Pharos 固定目录已接入'
    : pharosStatus?.status === 'failure'
      ? 'Pharos 固定目录已准备好，但当前 Trip 还没对上'
      : 'Pharos 固定目录已准备好';
  const pharosNoticeBody = pharosStatus?.status === 'success'
    ? '继续把 trip 镜像放到这个固定目录即可；如需限制范围，只在下面填写“包含 Trip”。'
    : pharosStatus?.status === 'failure'
      ? '固定目录已经准备好。请核对 trip 目录名，并把对应的 plan / record / gpx 镜像放到这里。'
      : '不需要再填写外部 Pharos 路径。把每个 trip 的镜像目录直接放到这个固定位置即可。';
  return (
    <Card className="panel">
      <SectionHeader title="项目概况" onSave={onSave} busy={busy} />
      <div className="field-grid field-grid-three">
        <Field
          label="项目名"
          value={config.name}
          onChange={value => setConfig(current => ({
            ...current,
            name: value,
          }))}
        />
        <Field
          label="项目说明"
          value={config.description || ''}
          onChange={value => setConfig(current => ({
            ...current,
            description: value,
          }))}
        />
        <Field
          label="创建日期"
          value={config.createdAt || ''}
          onChange={value => setConfig(current => ({
            ...current,
            createdAt: value,
          }))}
        />
      </div>
      <p className="field-help">`/ingest-gps` 会在这里用结构化表单维护素材 Root；保存时会把 `config/project-brief.json` 作为单真值落盘，并自动回写 `config/project-brief.md` 镜像。</p>
      <Divider />
      <div className="row-card">
        <div className="section-header">
          <h3>Pharos 资产</h3>
          <Tag>{pharosStatus?.status || 'empty'}</Tag>
        </div>
        <div className="field-grid field-grid-three">
          <Field
            label="固定目录"
            value={pharosStatus?.rootPath || ''}
            onChange={noop}
            readOnly
          />
          <Field
            label="发现 Trip"
            value={String(pharosStatus?.discoveredTripCount || 0)}
            onChange={noop}
            readOnly
          />
          <Field
            label="纳入 Trip"
            value={String(pharosStatus?.includedTripCount || 0)}
            onChange={noop}
            readOnly
          />
        </div>
        <TextAreaField
          label="包含 Trip（每行一个，可留空表示全部纳入）"
          value={(config.pharos?.includedTripIds || []).join('\n')}
          onChange={value => setConfig(current => ({
            ...current,
            pharos: {
              includedTripIds: splitLines(value),
            },
          }))}
          rows={4}
        />
        <div className="pharos-callout">
          <div className="pharos-callout-title">{pharosNoticeTitle}</div>
          <p>{pharosNoticeBody}</p>
          <div className="pharos-callout-path">
            <code>{pharosRootPath}</code>
          </div>
          <pre className="pharos-callout-tree">{`trip-<uuid>/
  plan.json
  record.json
  gpx/
    *.gpx`}</pre>
        </div>
        {pharosStatus?.latestMessage ? (
          <p className="muted">{pharosStatus.latestMessage}</p>
        ) : (
          <p className="muted">Console 会先帮你准备好这个固定目录；用户只需要把 trip 镜像投放进去。</p>
        )}
      </div>
      <Divider />
      <ListToolbar
        title="素材 Root（结构化编辑）"
        onAdd={() => setConfig(current => ({
          ...current,
          mappings: [...current.mappings, createProjectBriefMappingDraft(current.mappings)],
        }))}
      />
      <div className="capture-time-hint">
        这里维护的是正式素材 Root 单真值，不是手写 Markdown。保存后会写入 `project-brief.json`，回写 `project-brief.md` 镜像，并在运行前自动选择可读路径。
      </div>
      {config.mappings.length === 0 ? (
        <p className="muted">当前还没有素材 Root。点击“添加”后在这里结构化填写 `路径 / 原始路径 / 说明 / FlightRecord`。</p>
      ) : null}
      {config.mappings.map((mapping, index) => {
        const alternates = normalizeAlternatePathDrafts(mapping.alternatePaths);
        const summary = summariesByRootId.get(String(mapping.rootId || ''));
        const localPath = summary?.localPath || summary?.pathResolution?.selectedPath || '';
        const rawLocalPath = summary?.rawLocalPath || summary?.rawPathResolution?.selectedPath || '';
        const blockers = normalizePathResolutionBlockers(summary);
        const updateMapping = nextMapping => updateArrayItem(
          config.mappings,
          index,
          nextMapping,
          next => setConfig(current => ({ ...current, mappings: next })),
        );
        const updateAlternates = nextAlternates => updateMapping({
          ...mapping,
          alternatePaths: nextAlternates,
        });
        return (
          <div key={mapping.rootId || `project-brief-mapping-${index}`} className="row-card">
            <div className="row-top">
              <div>
                <strong>{`Root ${String(index + 1).padStart(2, '0')}`}</strong>
                <div className="muted capture-time-reason">{mapping.path || '待填写当前素材路径'}</div>
              </div>
              <div className="capture-time-tags">
                {mapping.rawPath ? <Tag>含原始路径</Tag> : null}
                {alternates.length > 0 ? <Tag>{`${alternates.length} 组备选`}</Tag> : null}
                {mapping.flightRecordPath ? <Tag>含 FlightRecord</Tag> : null}
              </div>
            </div>
            <div className={`root-resolution${blockers.length > 0 ? ' has-blockers' : ''}`}>
              <div>
                <span>当前使用路径</span>
                <code>{localPath || '未命中'}</code>
              </div>
              <div>
                <span>当前使用原始路径</span>
                <code>{rawLocalPath || '未命中'}</code>
              </div>
              {blockers.length > 0 ? (
                <p>{blockers.join(' · ')}</p>
              ) : null}
            </div>
            <div className="field-grid field-grid-three">
              <Field
                label="路径"
                value={mapping.path}
                onChange={value => updateMapping({ ...mapping, path: value })}
              />
              <Field
                label="原始路径"
                value={mapping.rawPath || ''}
                onChange={value => updateMapping({ ...mapping, rawPath: value })}
              />
              <Field
                label="FlightRecord"
                value={mapping.flightRecordPath || ''}
                onChange={value => updateMapping({ ...mapping, flightRecordPath: value })}
              />
            </div>
            <TextAreaField
              label="说明"
              value={mapping.description}
              onChange={value => updateMapping({ ...mapping, description: value })}
              rows={3}
            />
            <ListToolbar
              title="备选路径"
              onAdd={() => updateAlternates([...alternates, createAlternatePathDraft()])}
            />
            {alternates.length === 0 ? (
              <p className="muted">没有备选路径。主路径不可读时不会自动切换到其他目录。</p>
            ) : null}
            {alternates.map((alternate, alternateIndex) => (
              <div key={`alternate-${mapping.rootId || index}-${alternateIndex}`} className="nested-card alternate-path-card">
                <div className="row-top">
                  <strong>{`备选路径 ${alternateIndex + 1}`}</strong>
                  <div className="capture-time-actions">
                    <Button
                      size="small"
                      disabled={alternateIndex === 0}
                      onClick={() => updateAlternates(moveArrayItem(alternates, alternateIndex, alternateIndex - 1))}
                    >
                      上移
                    </Button>
                    <Button
                      size="small"
                      disabled={alternateIndex === alternates.length - 1}
                      onClick={() => updateAlternates(moveArrayItem(alternates, alternateIndex, alternateIndex + 1))}
                    >
                      下移
                    </Button>
                    <Button
                      type="error"
                      size="small"
                      onClick={() => updateAlternates(alternates.filter((_, itemIndex) => itemIndex !== alternateIndex))}
                    >
                      删除
                    </Button>
                  </div>
                </div>
                <div className="field-grid field-grid-three">
                  <Field
                    label="备选路径"
                    value={alternate.path || ''}
                    onChange={value => updateAlternates(replaceArrayItem(alternates, alternateIndex, {
                      ...alternate,
                      path: value,
                    }))}
                  />
                  <Field
                    label="原始路径"
                    value={alternate.rawPath || ''}
                    onChange={value => updateAlternates(replaceArrayItem(alternates, alternateIndex, {
                      ...alternate,
                      rawPath: value,
                    }))}
                  />
                </div>
              </div>
            ))}
            <Button
              type="error"
              size="small"
              onClick={() => removeArrayItem(config.mappings, index, next => setConfig(current => ({ ...current, mappings: next })))}
            >
              删除 Root
            </Button>
          </div>
        );
      })}
      <Divider />
      <TextAreaField
        label="材料模式短语（每行一条）"
        value={(config.materialPatternPhrases || []).join('\n')}
        onChange={value => setConfig(current => ({
          ...current,
          materialPatternPhrases: splitLines(value),
        }))}
        rows={6}
      />
    </Card>
  );
}

export function ManualItineraryEditor({ config, setConfig, onSave, busy }) {
  if (!config) return null;
  return (
    <Card className="panel">
      <SectionHeader title="Manual Itinerary" onSave={onSave} busy={busy} />
      <TextAreaField
        label="自然语言正文"
        value={config.prose}
        onChange={value => setConfig(current => ({ ...current, prose: value }))}
        rows={9}
      />
      <Divider />
      <ListToolbar
        title="结构化 Segment"
        onAdd={() => setConfig(current => ({
          ...current,
          segments: [...current.segments, {
            id: `segment-${Date.now()}`,
            date: '',
            startLocalTime: '',
            endLocalTime: '',
            location: '',
            notes: '',
          }],
        }))}
      />
      {config.segments.map((segment, index) => (
        <div key={segment.id || index} className="row-card">
          <div className="field-grid field-grid-three">
            <Field
              label="ID"
              value={segment.id}
              onChange={value => updateArrayItem(config.segments, index, { ...segment, id: value }, next => setConfig(current => ({ ...current, segments: next })))}
            />
            <Field
              label="日期"
              value={segment.date}
              onChange={value => updateArrayItem(config.segments, index, { ...segment, date: value }, next => setConfig(current => ({ ...current, segments: next })))}
            />
            <Field
              label="地点"
              value={segment.location || ''}
              onChange={value => updateArrayItem(config.segments, index, { ...segment, location: value }, next => setConfig(current => ({ ...current, segments: next })))}
            />
            <Field
              label="开始"
              value={segment.startLocalTime || ''}
              onChange={value => updateArrayItem(config.segments, index, { ...segment, startLocalTime: value }, next => setConfig(current => ({ ...current, segments: next })))}
            />
            <Field
              label="结束"
              value={segment.endLocalTime || ''}
              onChange={value => updateArrayItem(config.segments, index, { ...segment, endLocalTime: value }, next => setConfig(current => ({ ...current, segments: next })))}
            />
            <Field
              label="素材源"
              value={segment.rootRef || ''}
              onChange={value => updateArrayItem(config.segments, index, { ...segment, rootRef: value }, next => setConfig(current => ({ ...current, segments: next })))}
            />
            <Field
              label="路径前缀"
              value={segment.pathPrefix || ''}
              onChange={value => updateArrayItem(config.segments, index, { ...segment, pathPrefix: value }, next => setConfig(current => ({ ...current, segments: next })))}
            />
            <Field
              label="从"
              value={segment.from || ''}
              onChange={value => updateArrayItem(config.segments, index, { ...segment, from: value }, next => setConfig(current => ({ ...current, segments: next })))}
            />
            <Field
              label="到"
              value={segment.to || ''}
              onChange={value => updateArrayItem(config.segments, index, { ...segment, to: value }, next => setConfig(current => ({ ...current, segments: next })))}
            />
            <Field
              label="途经(/分隔)"
              value={(segment.via || []).join('/')}
              onChange={value => updateArrayItem(config.segments, index, { ...segment, via: splitList(value) }, next => setConfig(current => ({ ...current, segments: next })))}
            />
            <Field
              label="交通方式"
              value={segment.transport || ''}
              onChange={value => updateArrayItem(config.segments, index, { ...segment, transport: value }, next => setConfig(current => ({ ...current, segments: next })))}
            />
          </div>
          <TextAreaField
            label="备注"
            value={segment.notes || ''}
            onChange={value => updateArrayItem(config.segments, index, { ...segment, notes: value }, next => setConfig(current => ({ ...current, segments: next })))}
          />
          <Button
            type="error"
            size="small"
            onClick={() => removeArrayItem(config.segments, index, next => setConfig(current => ({ ...current, segments: next })))}
          >
            删除
          </Button>
        </div>
      ))}
    </Card>
  );
}

export function IngestRootClockEditor({ config, summaries = [], setConfig, onSave, busy }) {
  const roots = React.useMemo(
    () => (Array.isArray(config?.mappings)
      ? config.mappings.filter(isPlainObject)
      : []),
    [config?.mappings],
  );
  const [drafts, setDrafts] = React.useState({});

  React.useEffect(() => {
    const nextDrafts = Object.fromEntries(
      roots.map(root => [root.rootId, formatClockOffsetMs(root.clockOffsetMs)]),
    );
    setDrafts(current => areStringRecordsEqual(current, nextDrafts) ? current : nextDrafts);
  }, [roots]);

  if (!config) return null;

  const summariesByRootId = new Map(summaries.map(item => [item.rootId, item]));

  function commitClockOffset(rootId) {
    const draft = drafts[rootId] ?? '';
    const parsed = parseClockOffsetInput(draft);
    const root = roots.find(item => item.rootId === rootId);
    if (!root) return;
    if (parsed === null) {
      setDrafts(current => ({
        ...current,
        [rootId]: formatClockOffsetMs(root.clockOffsetMs),
      }));
      return;
    }
    setConfig(current => ({
      ...current,
      mappings: current.mappings.map(item => item.rootId === rootId
        ? { ...item, clockOffsetMs: parsed }
        : item),
    }));
    setDrafts(current => ({
      ...current,
      [rootId]: formatClockOffsetMs(parsed),
    }));
  }

  return (
    <Card className="panel">
      <SectionHeader title="设备时钟偏移" onSave={onSave} busy={busy} />
      <p className="muted">
        用 root 级偏移修正同一设备整批素材的时钟漂移。输入格式推荐 `±HH:MM:SS`；留空表示不施加偏移。
      </p>
      {roots.length === 0 ? (
        <p className="muted">当前还没有可维护的素材 Root。</p>
      ) : null}
      {roots.map(root => {
        const summary = summariesByRootId.get(root.rootId);
        const draftValue = drafts[root.rootId] ?? formatClockOffsetMs(root.clockOffsetMs);
        return (
          <div key={root.rootId} className="row-card">
            <div className="row-top">
              <div>
                <strong>{root.label || root.path || root.rootId}</strong>
                <div className="muted capture-time-reason">{root.rootId}</div>
              </div>
              <div className="capture-time-tags">
                <Tag>{`${summary?.assetCount || 0} assets`}</Tag>
                {root.category ? <Tag>{root.category}</Tag> : null}
              </div>
            </div>
            <div className="field-grid field-grid-three">
              <label className="field">
                <span>统一偏移</span>
                <input
                  value={draftValue}
                  placeholder="例如 -00:10:11"
                  onChange={event => setDrafts(current => ({
                    ...current,
                    [root.rootId]: event.target.value,
                  }))}
                  onBlur={() => commitClockOffset(root.rootId)}
                />
              </label>
              <Field label="首条锚点" value={formatIngestRootAnchor(summary?.firstAnchor)} onChange={noop} readOnly />
              <Field label="末条锚点" value={formatIngestRootAnchor(summary?.lastAnchor)} onChange={noop} readOnly />
            </div>
            <div className="capture-time-hint">
              {root.clockOffsetMs == null
                ? '当前未设置 root 级偏移。需要更细的个别例外时，仍然用下面的单素材时间校正。'
                : `当前有效偏移：${formatClockOffsetMs(root.clockOffsetMs)}`}
            </div>
          </div>
        );
      })}
    </Card>
  );
}

export function CaptureTimeOverridesEditor({ config, setConfig, onSave, busy }) {
  if (!config) return null;
  return (
    <Card className="panel">
      <SectionHeader title="素材时间校正" onSave={onSave} busy={busy} />
      {config.captureTimeOverrides.length === 0 ? (
        <p className="muted">当前没有待维护的素材时间校正项。</p>
      ) : null}
      {config.captureTimeOverrides.map((item, index) => (
        <div key={`${item.rootRef || 'root'}:${item.sourcePath}:${index}`} className="row-card capture-time-card">
          <div className="row-top">
            <div>
              <strong>{item.sourcePath}</strong>
              <div className="muted capture-time-reason">{item.note || '当前拍摄时间和项目时间线存在明显冲突。'}</div>
            </div>
            <div className="capture-time-tags">
              <Tag>{item.rootRef || '未标记 root'}</Tag>
              <Tag>{item.currentSource || '未知来源'}</Tag>
            </div>
          </div>
          <div className="capture-time-actions">
            <Button
              type={item.currentCapturedAt ? 'default' : 'disabled'}
              disabled={!item.currentCapturedAt}
              onClick={() => applyCaptureTimeAction(config.captureTimeOverrides, index, buildKeepCurrentOverride(item), next => setConfig(current => ({ ...current, captureTimeOverrides: next })))}
            >
              保持当前
            </Button>
            <Button
              type={item.suggestedTime ? 'default' : 'disabled'}
              disabled={!item.suggestedTime}
              onClick={() => applyCaptureTimeAction(config.captureTimeOverrides, index, buildSuggestedOverride(item), next => setConfig(current => ({ ...current, captureTimeOverrides: next })))}
            >
              使用建议
            </Button>
            <Button
              type="default"
              onClick={() => applyCaptureTimeAction(config.captureTimeOverrides, index, buildManualStartOverride(item), next => setConfig(current => ({ ...current, captureTimeOverrides: next })))}
            >
              手动修正
            </Button>
          </div>
          <div className="field-grid field-grid-three">
            <Field label="当前时间" value={item.currentCapturedAt || ''} onChange={noop} readOnly />
            <Field label="建议日期" value={item.suggestedDate || ''} onChange={noop} readOnly />
            <Field label="建议时间" value={item.suggestedTime || ''} onChange={noop} readOnly />
            <Field label="建议时区" value={item.timezone || ''} onChange={noop} readOnly />
          </div>
          <div className="capture-time-hint">
            正常情况下先填“正确时间 / 时区”就够了。若能推导，系统会自动补齐日期；只有无法推导时才需要手填“正确日期”。
          </div>
          <div className="field-grid field-grid-three">
            <Field
              label={`正确日期${requiresExplicitDate(item) ? ' *' : ''}`}
              value={item.correctedDate || ''}
              placeholder={suggestedDatePlaceholder(item)}
              onChange={value => updateArrayItem(config.captureTimeOverrides, index, { ...item, correctedDate: value }, next => setConfig(current => ({ ...current, captureTimeOverrides: next })))}
            />
            <Field
              label="正确时间 *"
              value={item.correctedTime || ''}
              placeholder={item.suggestedTime || ''}
              onChange={value => updateArrayItem(config.captureTimeOverrides, index, { ...item, correctedTime: value }, next => setConfig(current => ({ ...current, captureTimeOverrides: next })))}
            />
            <Field
              label="时区"
              value={item.timezone || ''}
              placeholder={item.timezone || '例如 Asia/Shanghai'}
              onChange={value => updateArrayItem(config.captureTimeOverrides, index, { ...item, timezone: value }, next => setConfig(current => ({ ...current, captureTimeOverrides: next })))}
            />
          </div>
          <TextAreaField
            label="备注"
            value={item.note || ''}
            onChange={value => updateArrayItem(config.captureTimeOverrides, index, { ...item, note: value }, next => setConfig(current => ({ ...current, captureTimeOverrides: next })))}
          />
        </div>
      ))}
    </Card>
  );
}

export function ScriptBriefEditor({
  config,
  editRules,
  styleSources,
  setConfig,
  onSave,
  onEditRuleCategoryChange,
  onStyleCategoryChange,
  onRequestRegenerate,
  busy,
  autoSaveBusy = false,
  regenerateBusy = false,
}) {
  const [showOverwriteModal, setShowOverwriteModal] = React.useState(false);
  if (!config) return null;
  const ruleCategories = editRules?.categories || [];
  const styleCategories = styleSources?.categories || [];
  const workflowState = config.workflowState || 'choose_style';
  const hasValidEditRuleCategory = !config.editRuleCategory
    || ruleCategories.some(category => category.categoryId === config.editRuleCategory);
  const hasValidStyleCategory = !config.styleCategory
    || styleCategories.some(category => category.categoryId === config.styleCategory);
  const canEditBrief = workflowState !== 'choose_style' && workflowState !== 'await_brief_draft';
  const canRequestRegenerate = workflowState === 'review_brief' || workflowState === 'ready_to_prepare';
  const currentFingerprint = computeScriptBriefFingerprint(config);
  const userModifiedBrief = Boolean(
    config.lastAgentDraftFingerprint && currentFingerprint !== config.lastAgentDraftFingerprint,
  );
  const ruleCategoryOptions = [
    { value: '', label: '（待指定）' },
    ...ruleCategories.map(category => ({
      value: category.categoryId,
      label: category.displayName,
    })),
  ];
  if (config.editRuleCategory && !hasValidEditRuleCategory) {
    ruleCategoryOptions.unshift({
      value: config.editRuleCategory,
      label: `当前规则已失效：${config.editRuleCategory}`,
    });
  }
  const styleCategoryOptions = [
    { value: '', label: '（可选）' },
    ...styleCategories.map(category => ({
      value: category.categoryId,
      label: category.displayName,
    })),
  ];
  if (config.styleCategory && !hasValidStyleCategory) {
    styleCategoryOptions.unshift({
      value: config.styleCategory,
      label: `当前分类已失效：${config.styleCategory}`,
    });
  }

  function handleEditRuleCategoryChange(value) {
    const nextEditRuleCategory = value || undefined;
    const nextWorkflowState = nextEditRuleCategory ? 'await_brief_draft' : 'choose_style';
    setConfig(current => ({
      ...current,
      editRuleCategory: nextEditRuleCategory,
      workflowState: nextWorkflowState,
      briefOverwriteApprovedAt: undefined,
      statusText: describeScriptWorkflowState(nextWorkflowState),
    }));
    onEditRuleCategoryChange?.(nextEditRuleCategory);
  }

  function handleStyleCategoryChange(value) {
    const nextStyleCategory = value || undefined;
    setConfig(current => ({
      ...current,
      styleCategory: nextStyleCategory,
    }));
    onStyleCategoryChange?.(nextStyleCategory);
  }

  async function handleConfirmRegenerate() {
    setShowOverwriteModal(false);
    await onRequestRegenerate?.();
  }

  function handleRequestRegenerate() {
    if (userModifiedBrief) {
      setShowOverwriteModal(true);
      return;
    }
    onRequestRegenerate?.();
  }

  return (
    <Card className="panel">
      <SectionHeader
        title="Script Brief"
        onSave={onSave}
        busy={busy}
        saveDisabled={!canEditBrief || autoSaveBusy || regenerateBusy}
        actions={canRequestRegenerate ? (
          <Button
            type={regenerateBusy ? 'disabled' : 'default'}
            disabled={regenerateBusy}
            onClick={handleRequestRegenerate}
          >
            {regenerateBusy ? '处理中…' : '重新生成 overview / brief'}
          </Button>
        ) : null}
      />
      <div className="field-grid field-grid-three">
        <Field
          label="项目名"
          value={config.projectName}
          onChange={() => {}}
          readOnly
        />
        <SelectField
          label="剪辑规则"
          value={config.editRuleCategory || ''}
          onChange={handleEditRuleCategoryChange}
          options={ruleCategoryOptions}
          disabled={autoSaveBusy || ruleCategoryOptions.length <= 1}
        />
        <SelectField
          label="文案风格参考"
          value={config.styleCategory || ''}
          onChange={handleStyleCategoryChange}
          options={styleCategoryOptions}
          disabled={autoSaveBusy || styleCategoryOptions.length <= 1}
        />
      </div>
      <Field
        label="状态"
        value={config.statusText || ''}
        onChange={() => {}}
        readOnly
      />
      {autoSaveBusy ? (
        <p className="field-help">正在自动保存分类选择…</p>
      ) : null}
      {!autoSaveBusy ? (
        <p className="field-help">剪辑规则会自动保存并影响粗剪结构；文案风格参考只影响最终旁白 / 字幕表达。下面的 brief 内容仍需要手动点击“保存”。</p>
      ) : null}
      {config.editRuleCategory && !hasValidEditRuleCategory ? (
        <p className="field-help field-help-error">当前剪辑规则已失效，请从 workspace 剪辑规则库重新选择。</p>
      ) : null}
      {config.styleCategory && !hasValidStyleCategory ? (
        <p className="field-help field-help-error">当前文案风格参考已失效；粗剪可继续，最终旁白 / 字幕阶段需要重新选择。</p>
      ) : null}
      {userModifiedBrief && canRequestRegenerate ? (
        <p className="field-help field-help-error">当前 brief 与最近一次 Agent 初稿不同。重新生成 overview / brief 会覆盖这些修改。</p>
      ) : null}
      <TextAreaField
        label="全片目标（每行一条）"
        value={(config.goalDraft || []).join('\n')}
        onChange={value => setConfig(current => ({ ...current, goalDraft: splitLines(value) }))}
        rows={8}
        disabled={!canEditBrief}
      />
      <TextAreaField
        label="叙事约束（每行一条）"
        value={(config.constraintDraft || []).join('\n')}
        onChange={value => setConfig(current => ({ ...current, constraintDraft: splitLines(value) }))}
        rows={8}
        disabled={!canEditBrief}
      />
      <TextAreaField
        label="段落方案审查（每行一条）"
        value={(config.planReviewDraft || []).join('\n')}
        onChange={value => setConfig(current => ({ ...current, planReviewDraft: splitLines(value) }))}
        rows={8}
        disabled={!canEditBrief}
      />
      <Divider />
      <ListToolbar
        title="Segment Brief"
        disabled={!canEditBrief}
        onAdd={() => setConfig(current => ({
          ...current,
          segments: [...current.segments, {
            segmentId: `segment-${Date.now()}`,
            title: '',
            roleHint: 'scene',
            targetDurationMs: 30000,
            intent: '',
            notes: [],
          }],
        }))}
      />
      {config.segments.map((segment, index) => (
        <div key={segment.segmentId || index} className="row-card">
          <div className="field-grid field-grid-three">
            <Field
              label="segmentId"
              value={segment.segmentId}
              disabled={!canEditBrief}
              onChange={value => updateArrayItem(config.segments, index, { ...segment, segmentId: value }, next => setConfig(current => ({ ...current, segments: next })))}
            />
            <Field
              label="标题"
              value={segment.title || ''}
              disabled={!canEditBrief}
              onChange={value => updateArrayItem(config.segments, index, { ...segment, title: value }, next => setConfig(current => ({ ...current, segments: next })))}
            />
            <Field
              label="角色提示"
              value={segment.roleHint || ''}
              disabled={!canEditBrief}
              onChange={value => updateArrayItem(config.segments, index, { ...segment, roleHint: value }, next => setConfig(current => ({ ...current, segments: next })))}
            />
            <Field
              label="目标时长(ms)"
              value={String(segment.targetDurationMs || '')}
              disabled={!canEditBrief}
              onChange={value => updateArrayItem(config.segments, index, { ...segment, targetDurationMs: Number(value) || 0 }, next => setConfig(current => ({ ...current, segments: next })))}
            />
          </div>
          <TextAreaField
            label="Intent"
            value={segment.intent || ''}
            disabled={!canEditBrief}
            onChange={value => updateArrayItem(config.segments, index, { ...segment, intent: value }, next => setConfig(current => ({ ...current, segments: next })))}
          />
          <TextAreaField
            label="Notes(每行一条)"
            value={(segment.notes || []).join('\n')}
            disabled={!canEditBrief}
            onChange={value => updateArrayItem(config.segments, index, { ...segment, notes: splitLines(value) }, next => setConfig(current => ({ ...current, segments: next })))}
          />
          <Button
            type={!canEditBrief ? 'disabled' : 'error'}
            size="small"
            disabled={!canEditBrief}
            onClick={() => removeArrayItem(config.segments, index, next => setConfig(current => ({ ...current, segments: next })))}
          >
            删除
          </Button>
        </div>
      ))}
      <Modal
        show={showOverwriteModal}
        title="覆盖当前 brief？"
        showClose
        closeOnClickBg
        cancel={() => setShowOverwriteModal(false)}
        actions={(
          <div className="actions modal-actions">
            <Button type="default" onClick={() => setShowOverwriteModal(false)}>取消</Button>
            <Button
              type={regenerateBusy ? 'disabled' : 'primary'}
              disabled={regenerateBusy}
              onClick={handleConfirmRegenerate}
            >
              {regenerateBusy ? '处理中…' : '确认覆盖'}
            </Button>
          </div>
        )}
      >
        <div className="modal-copy">
          <p>这会授权下一次 Agent 重新生成 material-overview.md 和初版 brief。</p>
          <p>重新生成后，你当前已经修改的 brief 内容会被覆盖。</p>
        </div>
      </Modal>
    </Card>
  );
}

export function StyleSourcesEditor({ config, setConfig, onSave, busy }) {
  if (!config) return null;
  return (
    <Card className="panel">
      <SectionHeader title="Style Sources" onSave={onSave} busy={busy} />
      <Field
        label="默认分类"
        value={config.defaultCategory || ''}
        onChange={value => setConfig(current => ({ ...current, defaultCategory: value }))}
      />
      <Divider />
      <ListToolbar
        title="Style Category"
        onAdd={() => setConfig(current => ({
          ...current,
          categories: [...current.categories, {
            categoryId: `category-${Date.now()}`,
            displayName: '新分类',
            guidancePrompt: '',
            inclusionNotes: '',
            exclusionNotes: '',
            overwriteExisting: false,
            profilePath: '',
            sources: [],
          }],
        }))}
      />
      {config.categories.map((category, index) => (
        <div key={category.categoryId || index} className="row-card">
          <div className="field-grid field-grid-three">
            <Field
              label="categoryId"
              value={category.categoryId}
              onChange={value => updateArrayItem(config.categories, index, { ...category, categoryId: value }, next => setConfig(current => ({ ...current, categories: next })))}
            />
            <Field
              label="显示名"
              value={category.displayName}
              onChange={value => updateArrayItem(config.categories, index, { ...category, displayName: value }, next => setConfig(current => ({ ...current, categories: next })))}
            />
            <Field
              label="profilePath"
              value={category.profilePath || ''}
              onChange={value => updateArrayItem(config.categories, index, { ...category, profilePath: value }, next => setConfig(current => ({ ...current, categories: next })))}
            />
          </div>
          <TextAreaField
            label="Guidance Prompt"
            value={category.guidancePrompt || ''}
            onChange={value => updateArrayItem(config.categories, index, { ...category, guidancePrompt: value }, next => setConfig(current => ({ ...current, categories: next })))}
          />
          <TextAreaField
            label="Inclusion"
            value={category.inclusionNotes || ''}
            onChange={value => updateArrayItem(config.categories, index, { ...category, inclusionNotes: value }, next => setConfig(current => ({ ...current, categories: next })))}
          />
          <TextAreaField
            label="Exclusion"
            value={category.exclusionNotes || ''}
            onChange={value => updateArrayItem(config.categories, index, { ...category, exclusionNotes: value }, next => setConfig(current => ({ ...current, categories: next })))}
          />
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={Boolean(category.overwriteExisting)}
              onChange={event => updateArrayItem(config.categories, index, { ...category, overwriteExisting: event.target.checked }, next => setConfig(current => ({ ...current, categories: next })))}
            />
            覆盖已有 profile
          </label>
          <Divider />
          <ListToolbar
            title="Reference Source"
            onAdd={() => updateArrayItem(config.categories, index, {
              ...category,
              sources: [...category.sources, {
                id: `source-${Date.now()}`,
                type: 'file',
                path: '',
                rangeStart: '',
                rangeEnd: '',
                note: '',
                includeNotes: '',
                excludeNotes: '',
              }],
            }, next => setConfig(current => ({ ...current, categories: next })))}
          />
          {category.sources.map((source, sourceIndex) => (
            <div key={source.id || sourceIndex} className="nested-card">
              <div className="field-grid field-grid-three">
                <Field
                  label="类型"
                  value={source.type}
                  onChange={value => updateNestedArrayItem(config.categories, index, 'sources', sourceIndex, { ...source, type: value }, next => setConfig(current => ({ ...current, categories: next })))}
                />
                <Field
                  label="路径"
                  value={source.path}
                  onChange={value => updateNestedArrayItem(config.categories, index, 'sources', sourceIndex, { ...source, path: value }, next => setConfig(current => ({ ...current, categories: next })))}
                />
                <Field
                  label="范围开始"
                  value={source.rangeStart || ''}
                  onChange={value => updateNestedArrayItem(config.categories, index, 'sources', sourceIndex, { ...source, rangeStart: value }, next => setConfig(current => ({ ...current, categories: next })))}
                />
                <Field
                  label="范围结束"
                  value={source.rangeEnd || ''}
                  onChange={value => updateNestedArrayItem(config.categories, index, 'sources', sourceIndex, { ...source, rangeEnd: value }, next => setConfig(current => ({ ...current, categories: next })))}
                />
              </div>
              <TextAreaField
                label="备注"
                value={source.note || ''}
                onChange={value => updateNestedArrayItem(config.categories, index, 'sources', sourceIndex, { ...source, note: value }, next => setConfig(current => ({ ...current, categories: next })))}
              />
              <TextAreaField
                label="Include"
                value={source.includeNotes || ''}
                onChange={value => updateNestedArrayItem(config.categories, index, 'sources', sourceIndex, { ...source, includeNotes: value }, next => setConfig(current => ({ ...current, categories: next })))}
              />
              <TextAreaField
                label="Exclude"
                value={source.excludeNotes || ''}
                onChange={value => updateNestedArrayItem(config.categories, index, 'sources', sourceIndex, { ...source, excludeNotes: value }, next => setConfig(current => ({ ...current, categories: next })))}
              />
              <Button
                type="error"
                size="small"
                onClick={() => removeNestedArrayItem(config.categories, index, 'sources', sourceIndex, next => setConfig(current => ({ ...current, categories: next })))}
              >
                删除来源
              </Button>
            </div>
          ))}
          <Button
            type="error"
            size="small"
            onClick={() => removeArrayItem(config.categories, index, next => setConfig(current => ({ ...current, categories: next })))}
          >
            删除分类
          </Button>
        </div>
      ))}
    </Card>
  );
}

export function ColorConfigEditor({ config, setConfig, onSave, busy, capability }) {
  const [draftText, setDraftText] = React.useState(() => stringifyColorConfig(config));
  const [parseError, setParseError] = React.useState('');
  const lastSerializedRef = React.useRef(stringifyColorConfig(config));

  React.useEffect(() => {
    const nextSerialized = stringifyColorConfig(config);
    if (nextSerialized === lastSerializedRef.current) {
      return;
    }
    lastSerializedRef.current = nextSerialized;
    setDraftText(nextSerialized);
    setParseError('');
  }, [config]);

  const capabilityBlocked = capability?.supported === false;

  function handleDraftChange(value) {
    setDraftText(value);
    try {
      const parsed = parseColorConfigDraft(value);
      lastSerializedRef.current = JSON.stringify(parsed, null, 2);
      setConfig(parsed);
      setParseError('');
    } catch (error) {
      setParseError(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <Card className="panel">
      <SectionHeader
        title="Color Config Advanced"
        onSave={onSave}
        busy={busy}
        saveDisabled={Boolean(parseError)}
      />
      <p className="muted">
        这里保留原始 JSON fallback，只用于需要直接改 `colorConfig` 的场景。主视图优先消费 `config.colorRoots` 这个 root 级 read model。
      </p>
      {capabilityBlocked ? (
        <div className="inline-warning">
          当前 capability 标记 `color` 不支持，无法启动 color 工作流；这里只保留配置查看和保存入口。
        </div>
      ) : null}
      <TextAreaField
        label="colorConfig JSON"
        value={draftText}
        onChange={handleDraftChange}
        rows={16}
        disabled={busy}
      />
      {parseError ? (
        <p className="field-help field-help-error">{parseError}</p>
      ) : (
        <p className="field-help">
          JSON 解析成功后会同步到当前配置；保存时会原样写入 `color-config`。
        </p>
      )}
    </Card>
  );
}

export function ColorCurrentSummary({
  config,
  colorArchive,
  capability,
  projectId,
  jobs = [],
  setProjectBrief,
  onSaveProjectRoots,
  busy = {},
  onRunColorAction,
  onRequestHostPreflight,
  onSaveDrpSnapshot,
  onRegisterDrpSnapshot,
}) {
  const effectiveConfig = isPlainObject(config) ? config : {};
  const rootCards = React.useMemo(
    () => buildMinimalColorRootCards(effectiveConfig),
    [effectiveConfig],
  );
  const archiveByRootId = React.useMemo(
    () => buildColorArchiveMap(colorArchive),
    [colorArchive],
  );
  const colorJobs = React.useMemo(
    () => (Array.isArray(jobs) ? jobs : [])
      .filter(job => job?.jobType === 'color')
      .filter(job => !projectId || job.projectId === projectId)
      .filter(job => ['queued', 'running'].includes(job.status)),
    [jobs, projectId],
  );
  const liveColorJobs = React.useMemo(
    () => colorJobs,
    [colorJobs],
  );
  const capabilityLabel = capability?.supported === false
    ? 'blocked'
    : capability
      ? 'supported'
      : 'unknown';
  const [exportAllDialog, setExportAllDialog] = React.useState(false);
  const [sectionOpen, setSectionOpen] = React.useState({});
  const [externalDrpPath, setExternalDrpPath] = React.useState('');
  const preferredRootId = React.useMemo(
    () => resolvePreferredColorRootId(effectiveConfig, rootCards),
    [effectiveConfig, rootCards],
  );
  const [activeRootId, setActiveRootId] = React.useState(preferredRootId);

  React.useEffect(() => {
    if (!projectId || typeof onRequestHostPreflight !== 'function') return;
    onRequestHostPreflight({}, { silent: true });
  }, [projectId]);

  React.useEffect(() => {
    if (rootCards.length === 0) {
      if (activeRootId) {
        setActiveRootId('');
      }
      return;
    }
    if (!activeRootId || !rootCards.some(root => matchesColorRoot(root, activeRootId))) {
      setActiveRootId(preferredRootId);
    }
  }, [activeRootId, preferredRootId, rootCards]);

  const activeRoot = React.useMemo(() => {
    if (rootCards.length === 0) return null;
    return rootCards.find(root => matchesColorRoot(root, activeRootId))
      || rootCards.find(root => matchesColorRoot(root, preferredRootId))
      || rootCards[0]
      || null;
  }, [activeRootId, preferredRootId, rootCards]);

  const activeRootArchive = activeRoot
    ? (archiveByRootId[activeRoot.rootId] || {
      rootId: activeRoot.rootId,
      recentBatches: [],
      validationFailures: [],
      promoteHistory: [],
    })
    : null;
  const activeRootStageStatus = activeRoot ? resolveColorRootHeadlineStatus(activeRoot) : 'unknown';
  const activeRootTone = resolveColorDashboardTone(activeRootStageStatus);
  const activeRootLatestBatchId = activeRoot ? resolveColorRootLatestBatchId(activeRoot) : '';
  const activeRootHeroDetail = activeRoot ? resolveColorRootHeroDetail(activeRoot) : '';
  const activeRootLiveJob = activeRoot
    ? liveColorJobs.find(job => matchesColorRoot({ rootId: getColorJobRootId(job) }, activeRoot.rootId))
    : null;
  const activeRootProgress = activeRootLiveJob?.progress || null;
  const activeRootPreflightBusy = activeRoot
    ? (busy?.[`color:preflight:${activeRoot.rootId}`] || busy?.['color:preflight'])
    : false;
  const activeRootDrpBusy = activeRoot
    ? (busy?.[`color:drp-snapshot:${activeRoot.rootId}`] || busy?.['color:drp-snapshot'])
    : false;
  const activeRootDrpRegisterBusy = activeRoot
    ? (busy?.[`color:drp-register:${activeRoot.rootId}`] || busy?.['color:drp-register'])
    : false;
  const activeRootLatestDrp = activeRoot?.latestDrpSnapshot || activeRoot?.current?.latestDrpSnapshot || null;

  return (
    <div className="color-dashboard">
      <Card className="panel color-roots-panel">
        <div className="section-header">
          <h2>Color Roots</h2>
          <Tag>{capabilityLabel}</Tag>
        </div>
        <p className="muted">
          {'当前优先消费 `config.colorRoots`。页面按 `Root 摘要 -> 当前 Root Hero -> 所有 Root 常驻可编辑配置 -> Groups -> 次级诊断/归档` 组织；所有 root 的 render preset 都在同一页直接维护。'}
        </p>
        {colorJobs.length > 0 ? (
          <div className="stack-list color-live-jobs">
            {colorJobs.map(job => {
              const progressSummary = formatColorJobProgress(job.progress);
              const progressPercent = getColorProgressPercent(job.progress);
              return (
                <div key={job.jobId} className="job-item color-job-item">
                  <div className="color-job-copy">
                    <strong>{getColorJobRootId(job) || job.jobId}</strong>
                    <div className="muted">{job.progress?.detail || job.progress?.stepLabel || job.status}</div>
                    {progressSummary ? (
                      <div className="color-job-progress">
                        <div className="color-job-progress-bar" aria-hidden="true">
                          <span style={{ width: `${progressPercent}%` }} />
                        </div>
                        <div className="muted color-job-progress-caption">{progressSummary}</div>
                      </div>
                    ) : null}
                  </div>
                  <Tag>{job.status}</Tag>
                </div>
              );
            })}
          </div>
        ) : null}
        {rootCards.length > 0 ? (
          <div className="inline-actions">
            <Button
              type={canRunProjectColorAction('prepare_all_roots', rootCards, capability, liveColorJobs, busy, onRunColorAction) ? 'primary' : 'disabled'}
              disabled={!canRunProjectColorAction('prepare_all_roots', rootCards, capability, liveColorJobs, busy, onRunColorAction)}
              onClick={() => onRunColorAction?.({ action: 'prepare_all_roots' })}
            >
              {describeProjectColorAction('prepare_all_roots', rootCards, liveColorJobs, busy)}
            </Button>
            <Button
              type={canRunProjectColorAction('export_all_roots', rootCards, capability, liveColorJobs, busy, onRunColorAction) ? 'default' : 'disabled'}
              disabled={!canRunProjectColorAction('export_all_roots', rootCards, capability, liveColorJobs, busy, onRunColorAction)}
              onClick={() => setExportAllDialog(true)}
            >
              {describeProjectColorAction('export_all_roots', rootCards, liveColorJobs, busy)}
            </Button>
          </div>
        ) : null}
        {rootCards.length > 0 ? (
          <div className="color-root-switcher">
            {rootCards.map(root => {
              const headlineStatus = resolveColorRootHeadlineStatus(root);
              return (
                <button
                  key={root.key}
                  type="button"
                  className={`color-root-switcher-item${matchesColorRoot(root, activeRoot?.rootId) ? ' is-active' : ''}`}
                  onClick={() => setActiveRootId(root.rootId)}
                >
                  <div className="color-root-switcher-top">
                    <div>
                      <strong>{root.label || root.rootId}</strong>
                      <div className="muted color-root-switcher-description">{root.description || '未填写 description'}</div>
                    </div>
                    <Tag>{formatColorDashboardStatus(headlineStatus)}</Tag>
                  </div>
                  <div className="color-root-switcher-meta">
                    <span>{`host ${root.hostPreflight?.status || 'unknown'}`}</span>
                    <span>{`${root.blockers.length} blockers`}</span>
                    <span>{`${root.groups.length} groups`}</span>
                  </div>
                  <div className="color-root-switcher-sub">
                    {resolveColorRootSwitcherSummary(root)}
                  </div>
                </button>
              );
            })}
          </div>
        ) : (
          <p className="muted">当前还没有可展示的 color root。</p>
        )}
      </Card>

      {activeRoot ? (
        <>
          <Card className="monitor-panel color-hero-panel">
            <div className="color-hero-top">
              <div className="color-hero-copy">
                <div className="eyebrow">Current Root</div>
                <div className="status-row">
                  <div className={`status-pill tone-${activeRootTone}`}>
                    {formatColorDashboardStatus(activeRootStageStatus)}
                  </div>
                  <div className="step-label">{activeRoot.label || activeRoot.rootId}</div>
                </div>
                {activeRoot.description ? (
                  <div className="detail">{activeRoot.description}</div>
                ) : null}
              </div>
              <div className="color-hero-actions">
                <Button
                  type={activeRootPreflightBusy ? 'disabled' : 'default'}
                  disabled={activeRootPreflightBusy || typeof onRequestHostPreflight !== 'function'}
                  onClick={() => onRequestHostPreflight?.({ rootId: activeRoot.rootId })}
                >
                  {activeRootPreflightBusy ? '检查中…' : 'Recheck Host'}
                </Button>
                <Button
                  type={!activeRootDrpBusy && typeof onSaveDrpSnapshot === 'function' ? 'default' : 'disabled'}
                  disabled={activeRootDrpBusy || typeof onSaveDrpSnapshot !== 'function'}
                  onClick={() => onSaveDrpSnapshot?.({ rootId: activeRoot.rootId })}
                >
                  {activeRootDrpBusy ? '保存中…' : '保存 DRP 快照'}
                </Button>
                <Button
                  type={canRunColorRootAction('prepare_root', activeRoot, capability, liveColorJobs, busy, onRunColorAction) ? 'primary' : 'disabled'}
                  disabled={!canRunColorRootAction('prepare_root', activeRoot, capability, liveColorJobs, busy, onRunColorAction)}
                  onClick={() => onRunColorAction?.({ rootId: activeRoot.rootId, action: 'prepare_root' })}
                >
                  {describeColorRootAction('prepare_root', activeRoot, liveColorJobs, busy)}
                </Button>
                <Button
                  type={canRunColorRootAction('sync_groups', activeRoot, capability, liveColorJobs, busy, onRunColorAction) ? 'default' : 'disabled'}
                  disabled={!canRunColorRootAction('sync_groups', activeRoot, capability, liveColorJobs, busy, onRunColorAction)}
                  onClick={() => onRunColorAction?.({ rootId: activeRoot.rootId, action: 'sync_groups' })}
                >
                  {describeColorRootAction('sync_groups', activeRoot, liveColorJobs, busy)}
                </Button>
                <Button
                  type={canRunColorRootAction('execute_root', activeRoot, capability, liveColorJobs, busy, onRunColorAction) ? 'default' : 'disabled'}
                  disabled={!canRunColorRootAction('execute_root', activeRoot, capability, liveColorJobs, busy, onRunColorAction)}
                  onClick={() => onRunColorAction?.({ rootId: activeRoot.rootId, action: 'execute_root' })}
                >
                  {describeColorRootAction('execute_root', activeRoot, liveColorJobs, busy)}
                </Button>
                <Button
                  type={canRunColorRootAction('sync_batch_metadata', activeRoot, capability, liveColorJobs, busy, onRunColorAction) ? 'default' : 'disabled'}
                  disabled={!canRunColorRootAction('sync_batch_metadata', activeRoot, capability, liveColorJobs, busy, onRunColorAction)}
                  onClick={() => onRunColorAction?.({ rootId: activeRoot.rootId, action: 'sync_batch_metadata', batchId: activeRoot.current?.latestBatchId })}
                >
                  {describeColorRootAction('sync_batch_metadata', activeRoot, liveColorJobs, busy)}
                </Button>
                <Button
                  type={canRunColorRootAction('sync_batch_sidecars', activeRoot, capability, liveColorJobs, busy, onRunColorAction) ? 'default' : 'disabled'}
                  disabled={!canRunColorRootAction('sync_batch_sidecars', activeRoot, capability, liveColorJobs, busy, onRunColorAction)}
                  onClick={() => onRunColorAction?.({ rootId: activeRoot.rootId, action: 'sync_batch_sidecars', batchId: activeRoot.current?.latestBatchId })}
                >
                  {describeColorRootAction('sync_batch_sidecars', activeRoot, liveColorJobs, busy)}
                </Button>
                <Button
                  type={canRunColorRootAction('validate_batch', activeRoot, capability, liveColorJobs, busy, onRunColorAction) ? 'default' : 'disabled'}
                  disabled={!canRunColorRootAction('validate_batch', activeRoot, capability, liveColorJobs, busy, onRunColorAction)}
                  onClick={() => onRunColorAction?.({ rootId: activeRoot.rootId, action: 'validate_batch', batchId: activeRoot.current?.latestBatchId })}
                >
                  {describeColorRootAction('validate_batch', activeRoot, liveColorJobs, busy)}
                </Button>
              </div>
            </div>
            <div className="detail">{activeRootHeroDetail}</div>
            {activeRootProgress ? (
              <div className="color-active-progress">
                <div className="color-active-progress-top">
                  <strong>{activeRootProgress.stepLabel || activeRootProgress.step || 'Color job'}</strong>
                  <span>{formatColorJobProgress(activeRootProgress) || activeRootProgress.status || 'running'}</span>
                </div>
                <div className="color-job-progress-bar" aria-hidden="true">
                  <span style={{ width: `${getColorProgressPercent(activeRootProgress)}%` }} />
                </div>
                {activeRootProgress.detail ? (
                  <div className="muted">{activeRootProgress.detail}</div>
                ) : null}
              </div>
            ) : null}
            <div className="color-drp-panel">
              <div className="color-drp-copy">
                <strong>Resolve DRP 快照</strong>
                <div className="muted">
                  {activeRootLatestDrp?.snapshotPath
                    ? `latest · ${activeRootLatestDrp.snapshotPath}`
                    : '还没有 DRP 快照。Resolve scripting 不可用时，用 File -> Export Project... 保存到 snapshots 目录后在这里登记。'}
                </div>
                {activeRootLatestDrp?.createdAt ? (
                  <div className="muted">
                    {`${activeRootLatestDrp.mode || 'auto'} · ${activeRootLatestDrp.createdAt} · ${activeRootLatestDrp.projectName || activeRoot.resolveProjectName || ''}`}
                  </div>
                ) : null}
              </div>
              <div className="color-drp-register">
                <Field
                  label="登记外部 DRP"
                  value={externalDrpPath}
                  onChange={setExternalDrpPath}
                  placeholder=".../color/resolve-projects/.../snapshots/project.drp"
                  disabled={activeRootDrpRegisterBusy}
                />
                <Button
                  type={externalDrpPath.trim() && !activeRootDrpRegisterBusy ? 'default' : 'disabled'}
                  disabled={!externalDrpPath.trim() || activeRootDrpRegisterBusy || typeof onRegisterDrpSnapshot !== 'function'}
                  onClick={() => {
                    onRegisterDrpSnapshot?.({ rootId: activeRoot.rootId, path: externalDrpPath.trim() });
                    setExternalDrpPath('');
                  }}
                >
                  {activeRootDrpRegisterBusy ? '登记中…' : '登记'}
                </Button>
              </div>
            </div>
            {activeRoot.blockers.length > 0 ? (
              <div className="inline-warning">
                {`主 blocker：${activeRoot.blockers.slice(0, 2).join('；')}`}
              </div>
            ) : null}
            <div className="headline-metrics color-headline-metrics">
              <div className="headline-metric">
                <div className="label">Host</div>
                <div className="value">{activeRoot.hostPreflight?.status || 'unknown'}</div>
                <div className="sub">{activeRoot.renderPresetSummary}</div>
              </div>
              <div className="headline-metric">
                <div className="label">Blockers</div>
                <div className="value">{String(activeRoot.blockers.length)}</div>
                <div className="sub">{activeRoot.blockers.length > 0 ? '需要先解除阻塞' : '当前无显式 blocker'}</div>
              </div>
              <div className="headline-metric">
                <div className="label">Groups</div>
                <div className="value">{String(activeRoot.groups.length)}</div>
                <div className="sub">{activeRoot.groups.length > 0 ? '可进入执行/校验' : '等待首次 Sync Groups'}</div>
              </div>
              <div className="headline-metric">
                <div className="label">Chunks</div>
                <div className="value">{formatColorPrepareChunkCount(activeRoot.current?.prepareChunks)}</div>
                <div className="sub">{describeColorPrepareChunks(activeRoot.current?.prepareChunks)}</div>
              </div>
              <div className="headline-metric">
                <div className="label">Latest Batch</div>
                <div className="value value-compact">{activeRootLatestBatchId || 'none'}</div>
                <div className="sub">{resolveColorRootBatchSummary(activeRoot)}</div>
              </div>
            </div>
            <div className="monitor-stage-grid color-stage-grid">
              {[
                ['timeline', 'Timeline'],
                ['mirror', 'Media Pool / Mirror'],
                ['groupSync', 'Group Sync'],
                ['batch', 'Batch'],
              ].map(([key, label]) => {
                const summary = summarizeColorStatusNode(
                  key === 'groupSync'
                    ? activeRoot.current?.groupSyncStatus
                    : activeRoot.current?.[key] ?? activeRoot.current?.[`${key}Status`] ?? activeRoot.current?.[`${key}State`] ?? activeRoot.current?.[`${key}Phase`],
                );
                return (
                  <div key={`${activeRoot.key}:${key}`} className={`monitor-stage-card state-${resolveColorStageCardState(summary.status)}`}>
                    <div className="monitor-stage-head">
                      <strong>{label}</strong>
                      <Tag>{summary.status}</Tag>
                    </div>
                    <div className="muted">{summary.summary}</div>
                  </div>
                );
              })}
            </div>
          </Card>

          <div className="color-detail-layout">
            <div className="color-primary-stack">
              <Card className="panel color-config-panel">
                <SectionHeader
                  title="所有 Root 配置"
                  onSave={onSaveProjectRoots}
                  busy={busy?.['project-brief']}
                  actions={<Tag>{`${rootCards.length} 个 root`}</Tag>}
                />
                <p className="muted color-panel-copy">
                  所有 root 的可填参数都集中在这里，同页可维护；不需要切换详情才能逐个填写。
                </p>
                <div className="color-config-list">
                  {rootCards.map(root => {
                    const rootStatus = resolveColorRootHeadlineStatus(root);
                    const isActiveRoot = matchesColorRoot(root, activeRoot.rootId);
                    return (
                      <div key={`${root.key}:config`} className={`color-root-config-card${isActiveRoot ? ' is-active' : ''}`}>
                        <div className="color-root-config-top">
                          <div className="color-root-config-copy">
                            <strong>{root.label || root.rootId}</strong>
                            <div className="muted">
                              {root.description || '未填写 description'}
                            </div>
                          </div>
                          <div className="color-root-config-badges">
                            {isActiveRoot ? <Tag>当前详情</Tag> : null}
                            <Tag>{formatColorDashboardStatus(rootStatus)}</Tag>
                          </div>
                        </div>
                        <div className="field-grid color-path-grid">
                          <Field label="当前素材路径" value={root.currentPath || ''} onChange={noop} readOnly />
                          <Field label="原始素材路径" value={root.displayRawPath || ''} onChange={noop} readOnly />
                        </div>
                        <div className="field-grid color-preset-grid">
                          <Field
                            label="container"
                            value={root.renderPreset.container || ''}
                            onChange={value => updateProjectRootRenderPreset(setProjectBrief, root.rootId, { container: value })}
                            disabled={busy?.['project-brief']}
                          />
                          <Field
                            label="videoCodec"
                            value={root.renderPreset.videoCodec || ''}
                            onChange={value => updateProjectRootRenderPreset(setProjectBrief, root.rootId, { videoCodec: value })}
                            disabled={busy?.['project-brief']}
                          />
                          <Field
                            label="audioCodec"
                            value={root.renderPreset.audioCodec || ''}
                            onChange={value => updateProjectRootRenderPreset(setProjectBrief, root.rootId, { audioCodec: value })}
                            disabled={busy?.['project-brief']}
                          />
                          <Field
                            label="bitrateKbps (kb/s)"
                            type="number"
                            step="1"
                            inputMode="numeric"
                            value={formatColorBitrateInput(root.bitrateKbps)}
                            onChange={value => updateProjectRootRenderPreset(setProjectBrief, root.rootId, { bitrateKbps: value })}
                            disabled={busy?.['project-brief']}
                          />
                          <Field
                            label="colorSpaceProfile"
                            value={root.colorSpaceProfile || ''}
                            onChange={value => updateProjectRootColorSpaceProfile(setProjectBrief, root.rootId, value)}
                            placeholder={COLOR_SOURCE_PROFILE_HINT}
                            disabled={busy?.['project-brief']}
                          />
                          <SelectField
                            label="transformPresetKey"
                            value={root.transformPresetKey || ''}
                            onChange={value => updateProjectRootTransformPresetKey(setProjectBrief, root.rootId, value)}
                            options={root.transformPresetOptions || [{ value: '', label: '自动 / 按 profile' }]}
                            disabled={busy?.['project-brief']}
                          />
                        </div>
                        <div className="color-root-config-foot">
                          <span>{resolveColorRootSwitcherSummary(root)}</span>
                          <span>{root.renderPresetSummary}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
                <p className="field-help">
                  {'`Prepare Root` 会真正同步 Media Pool / grading timeline，并按 `logProfile + lowlight + 高置信 colorCastClass` 生成或复用 Resolve Groups；横屏使用 `config/default.drt`，竖屏 Sony/ZV-E1 可用方向专用 DRT 自动 Gyro，并会写入 timeline transform 旋转放大为横屏单 clip 导出。`Group Post-Clip` 是主 creative 真相，`Clip` 只承担 repair / local exception。'}
                </p>
              </Card>

              <Card className="panel color-groups-panel">
                <div className="section-header">
                  <h2>Groups</h2>
                  <Tag>{`${activeRoot.groups.length} 个`}</Tag>
                </div>
                <p className="muted color-panel-copy">
                  {'`Group Post-Clip` 是 Resolve 里的主 creative 真相；clip repair 只负责固定槽位 `Gyro -> Dehaze -> User1 -> User2 -> NR`。没有对应 DRT 模板时 Kairos 会跳过自动 Gyro/repair seed 并标记待初始化；竖屏素材仍会应用横屏 transform。导出会按 raw 父目录拆临时时间线，并直接渲染到最终 root 目标后校验。'}
                </p>
                <div className="color-group-list">
                  {activeRoot.groups.length > 0 ? activeRoot.groups.map(group => (
                    <div key={`${activeRoot.key}:${group.groupKey}`} className="color-group-row">
                      <div className="color-group-row-top">
                        <div className="color-group-copy">
                          <strong>{group.displayName}</strong>
                          <div className="muted">{`${group.groupKey} · ${group.clipCount} clips`}</div>
                          {describeColorGroupCreativeState(group) ? (
                            <div className="muted">{describeColorGroupCreativeState(group)}</div>
                          ) : null}
                          {describeColorTechnicalSignals(group.hostSummary) ? (
                            <div className="muted">{describeColorTechnicalSignals(group.hostSummary)}</div>
                          ) : null}
                          {describeColorClipRepairSummary(group.clips) ? (
                            <div className="muted">{describeColorClipRepairSummary(group.clips)}</div>
                          ) : null}
                        </div>
                        <Tag>{group.current?.status || 'ready'}</Tag>
                      </div>
                      {Array.isArray(group.clips) && group.clips.length > 0 ? (
                        <details className="color-group-clip-details">
                          <summary>{`Clip Repair (${group.clips.length})`}</summary>
                          <div className="color-group-clip-list">
                            {group.clips.map(clip => (
                              <div key={`${group.groupKey}:${clip.clipKey}`} className="color-group-clip-row">
                                <strong>{clip.displayName || clip.clipKey}</strong>
                                <div className="muted">{clip.clipKey}</div>
                                <div className="muted">{describeColorClipRepairState(clip)}</div>
                              </div>
                            ))}
                          </div>
                        </details>
                      ) : null}
                    </div>
                  )) : <p className="muted">当前还没有已同步的正式 Groups。先运行 `Prepare Root`，如你在 Resolve 里做了调整，再执行一次 `Sync Groups`。</p>}
                </div>
              </Card>
            </div>

            <div className="color-secondary-stack">
              <Card className="panel color-secondary-panel">
                <div className="section-header">
                  <h2>高级诊断与归档</h2>
                  <Tag>readonly</Tag>
                </div>
                <p className="muted color-panel-copy">
                  这里只保留只读诊断与 batch/archive 历史；用户可填写参数已经全部放到左侧配置区。
                </p>
                <div className={`color-secondary-summary${activeRoot.blockers.length > 0 ? ' has-blockers' : ''}`}>
                  <strong>{activeRoot.blockers.length > 0 ? `${activeRoot.blockers.length} 个 blocker` : '当前无显式 blocker'}</strong>
                  <span>
                    {activeRoot.blockers.length > 0
                      ? activeRoot.blockers[0]
                      : '如需看宿主和 archive 细节，展开下面的只读诊断区。'}
                  </span>
                </div>
                <details className="color-advanced-details">
                  <summary><strong>高级 / 调试信息</strong></summary>
                  <div className="field-grid field-grid-three">
                    <Field label="project path" value={activeRoot.path || ''} onChange={noop} readOnly />
                    <Field label="解析后 localPath" value={activeRoot.localPath || ''} onChange={noop} readOnly />
                    <Field label="rawPath" value={activeRoot.rawPath || ''} onChange={noop} readOnly />
                    <Field label="解析后 rawLocalPath" value={activeRoot.rawLocalPath || ''} onChange={noop} readOnly />
                    <Field label="colorSpaceProfile" value={activeRoot.colorSpaceProfile || ''} onChange={noop} readOnly />
                    <Field label="transformPresetKey" value={activeRoot.transformPresetKey || ''} onChange={noop} readOnly />
                    <Field label="detectedProfile" value={getColorStringField(activeRoot.current?.hostSummary, ['detectedProfile']) || ''} onChange={noop} readOnly />
                    <Field label="effectiveProfile" value={getColorStringField(activeRoot.current?.hostSummary, ['effectiveProfile']) || ''} onChange={noop} readOnly />
                    <Field label="resolvedTransformPresetKey" value={getColorStringField(activeRoot.current?.hostSummary, ['resolvedTransformPresetKey']) || ''} onChange={noop} readOnly />
                    <Field label="lutSyncStatus" value={getColorStringField(activeRoot.current?.hostSummary, ['lutSyncStatus']) || ''} onChange={noop} readOnly />
                    <Field label="transformStatus" value={getColorStringField(activeRoot.current?.hostSummary, ['transformStatus']) || ''} onChange={noop} readOnly />
                    <Field label="repairTemplateStatus" value={getColorStringField(activeRoot.current?.hostSummary, ['repairTemplateStatus']) || ''} onChange={noop} readOnly />
                    <Field label="repairSeedSkippedReason" value={getColorStringField(activeRoot.current?.hostSummary, ['repairSeedSkippedReason']) || ''} onChange={noop} readOnly />
                    <Field label="portraitClipCount" value={String(activeRoot.current?.hostSummary?.portraitClipCount || '')} onChange={noop} readOnly />
                    <Field label="timelineTransformClipCount" value={String(activeRoot.current?.hostSummary?.timelineTransformClipCount || '')} onChange={noop} readOnly />
                    <Field label="missingPortraitDrtCount" value={String(activeRoot.current?.hostSummary?.repairOrientationTemplateMissingClipCount || '')} onChange={noop} readOnly />
                    <Field label="resolveProjectName" value={activeRoot.resolveProjectName || ''} onChange={noop} readOnly />
                    <Field label="rootNamespace" value={activeRoot.rootNamespace || ''} onChange={noop} readOnly />
                    <Field label="gradingTimelineName" value={activeRoot.gradingTimelineName || ''} onChange={noop} readOnly />
                  </div>
                </details>
                <ColorRootArchivePanels
                  root={activeRoot}
                  archive={activeRootArchive}
                  sectionOpen={sectionOpen}
                  setSectionOpen={setSectionOpen}
                />
                {activeRoot.current?.detail ? <p className="field-help">{activeRoot.current.detail}</p> : null}
              </Card>
            </div>
          </div>
        </>
      ) : null}

      <Modal
        show={exportAllDialog}
        title="确认 Export All Roots"
        width={560}
        cancel={() => setExportAllDialog(false)}
        footer={(
          <>
            <Button type="default" onClick={() => setExportAllDialog(false)}>
              取消
            </Button>
            <Button
              type="primary"
              onClick={() => {
                setExportAllDialog(false);
                onRunColorAction?.({ action: 'export_all_roots' });
              }}
            >
              确认统一导出
            </Button>
          </>
        )}
      >
        <div className="stack-list">
          <p>{'这会按当前 root priority 顺序执行 `Execute -> Validate`。'}</p>
          <p>每个 root 会按 raw 父目录拆临时时间线，直接渲染到对应当前素材目录并自动修复 metadata。</p>
          <p>如果某个 root 失败，任务会继续处理后续 roots，但整个 color job 最终会记为 failed。</p>
          <p>{`本次目标 roots：${rootCards.map(root => root.label || root.rootId).join(' · ')}`}</p>
        </div>
      </Modal>
    </div>
  );
}

function resolvePreferredColorRootId(config, rootCards) {
  const currentRootId = resolveColorCurrentRootId(config?.colorCurrent) || resolveColorCurrentRootId(config);
  if (currentRootId) {
    const matched = rootCards.find(root => matchesColorRoot(root, currentRootId));
    if (matched) {
      return matched.rootId;
    }
  }
  return rootCards[0]?.rootId || '';
}

function resolveColorRootHeadlineStatus(root) {
  if (!root) return 'unknown';
  if (root.hostPreflight?.status === 'blocked' || root.blockers.length > 0) {
    return 'blocked';
  }
  if (root.groups.some(group => ['queued', 'running'].includes(group.current?.status))) {
    return 'running';
  }
  if (root.current?.activeStage) {
    return 'running';
  }
  if (root.hostPreflight?.status === 'degraded') {
    return 'degraded';
  }
  if ([root.current?.groupSyncStatus, root.current?.timelineStatus, root.current?.mirrorStatus].includes('ready')) {
    return 'ready';
  }
  if ([root.current?.groupSyncStatus, root.current?.timelineStatus, root.current?.mirrorStatus].includes('missing')) {
    return 'missing';
  }
  return 'idle';
}

function resolveColorDashboardTone(status) {
  const normalized = String(status || '').toLowerCase();
  if (['failed', 'blocked'].includes(normalized)) return 'error';
  if (['degraded', 'missing', 'queued'].includes(normalized)) return 'warn';
  if (['ready', 'running', 'synced', 'rendered', 'staged', 'promoted', 'completed'].includes(normalized)) return 'ok';
  return 'default';
}

function formatColorDashboardStatus(status) {
  switch (String(status || '').toLowerCase()) {
    case 'blocked':
      return 'Blocked';
    case 'running':
      return 'Running';
    case 'ready':
      return 'Ready';
    case 'missing':
      return 'Missing';
    case 'degraded':
      return 'Degraded';
    case 'queued':
      return 'Queued';
    case 'failed':
      return 'Failed';
    case 'promoted':
      return 'Promoted';
    case 'staged':
      return 'Staged';
    case 'synced':
      return 'Synced';
    case 'rendered':
      return 'Rendered';
    case 'completed':
      return 'Completed';
    default:
      return 'Idle';
  }
}

function resolveColorRootHeroDetail(root) {
  if (!root) return '当前还没有可展示的 color root。';
  if (getColorStringField(root.current, ['detail'])) {
    return root.current.detail;
  }
  if (root.blockers.length > 0) {
    return `当前有 ${root.blockers.length} 个 blocker。优先处理宿主、路径或 render preset 阻塞后再继续。`;
  }
  if (root.groups.length > 0) {
    return `当前已同步 ${root.groups.length} 个 Groups，可继续执行 root batch 或校验。`;
  }
  if (root.hostPreflight?.status === 'degraded') {
    return '当前 Resolve host 可用但存在兼容降级，建议先复查宿主诊断。';
  }
  return '当前还没有正式 Groups。先运行 `Prepare Root`，如你在 Resolve 里做了调整，再执行一次 `Sync Groups`。';
}

function resolveColorRootSwitcherSummary(root) {
  const activeStage = getColorStringField(root.current, ['activeStage']);
  if (activeStage) {
    return `当前阶段：${activeStage}`;
  }
  if (root.blockers.length > 0) {
    return `主 blocker：${root.blockers[0]}`;
  }
  if (root.groups.length > 0) {
    return `最近 root batch：${resolveColorRootLatestBatchId(root) || 'none'}。`;
  }
  return '等待首次 Prepare / Sync。';
}

function resolveColorRootLatestBatchId(root) {
  return getColorStringField(root.current, ['latestBatchId']);
}

function resolveColorRootBatchSummary(root) {
  if (!root) return '尚未产生 batch';
  const validationStatus = getColorStringField(root.current, ['latestValidationStatus']);
  if (validationStatus) {
    return `validation ${validationStatus}`;
  }
  const batchStatus = getColorStringField(root.current, ['latestBatchStatus']);
  if (batchStatus) {
    return `batch ${batchStatus}`;
  }
  return root.groups.length > 0 ? '等待下一次 root batch' : '尚未产生 batch';
}

function formatColorPrepareChunkCount(chunks) {
  const list = Array.isArray(chunks) ? chunks.filter(isPlainObject) : [];
  if (list.length === 0) return 'none';
  const ready = list.filter(chunk => getColorStringField(chunk, ['status']) === 'ready').length;
  return `${ready}/${list.length}`;
}

function describeColorPrepareChunks(chunks) {
  const list = Array.isArray(chunks) ? chunks.filter(isPlainObject) : [];
  if (list.length === 0) return '未拆批';
  const running = list.find(chunk => getColorStringField(chunk, ['status']) === 'running');
  const failed = list.filter(chunk => getColorStringField(chunk, ['status']) === 'failed').length;
  if (running) {
    return `当前 ${Number(running.index ?? 0) + 1}/${Number(running.total ?? list.length)} · ${running.timelineName || running.chunkId}`;
  }
  if (failed > 0) {
    return `${failed} 个 chunk 失败，可重试 Prepare`;
  }
  const clipCount = list.reduce((total, chunk) => total + Number(chunk.clipCount || 0), 0);
  return `${clipCount} clips · 每批最多 50`;
}

function resolveColorStageCardState(status) {
  const normalized = String(status || '').toLowerCase();
  if (['running', 'queued'].includes(normalized)) return 'active';
  if (['ready', 'completed', 'synced', 'rendered', 'promoted', 'staged'].includes(normalized)) return 'completed';
  if (['failed', 'blocked'].includes(normalized)) return 'error';
  return 'idle';
}

function ColorRootArchivePanels({ root, archive, sectionOpen, setSectionOpen }) {
  const hostSectionKey = `${root.rootId}:host`;
  const recentSectionKey = `${root.rootId}:recent`;
  const failuresSectionKey = `${root.rootId}:failures`;
  const hostDefaultOpen = ['blocked', 'degraded'].includes(root.hostPreflight?.status || '');
  const validationDefaultOpen = Array.isArray(archive?.validationFailures) && archive.validationFailures.length > 0;
  const sections = [
    {
      key: hostSectionKey,
      title: 'Host Diagnostics',
      defaultOpen: hostDefaultOpen,
      body: renderColorHostDiagnostics(root.hostPreflight),
    },
    {
      key: recentSectionKey,
      title: 'Recent Batches',
      defaultOpen: false,
      body: renderColorRecentBatches(archive?.recentBatches),
    },
    {
      key: failuresSectionKey,
      title: 'Validation Failures',
      defaultOpen: validationDefaultOpen,
      body: renderColorValidationFailures(archive?.validationFailures),
    },
  ];

  return (
    <div className="stack-list">
      {sections.map(section => {
        const open = Object.prototype.hasOwnProperty.call(sectionOpen || {}, section.key)
          ? Boolean(sectionOpen[section.key])
          : section.defaultOpen;
        return (
          <details
            key={section.key}
            open={open}
            onToggle={event => {
              const nextOpen = Boolean(event.currentTarget?.open);
              setSectionOpen(current => ({
                ...(isPlainObject(current) ? current : {}),
                [section.key]: nextOpen,
              }));
            }}
          >
            <summary><strong>{section.title}</strong></summary>
            <div className="stack-list">
              {section.body}
            </div>
          </details>
        );
      })}
    </div>
  );
}

function renderColorHostDiagnostics(hostPreflight) {
  const diagnostics = materializeColorHostPreflight(hostPreflight);
  if (!diagnostics) {
    return <p className="muted">当前还没有 Resolve host 诊断缓存。</p>;
  }
  return (
    <>
      <div className="capture-time-tags">
        <Tag>{diagnostics.status || 'unknown'}</Tag>
        {diagnostics.productName ? <Tag>{diagnostics.productName}</Tag> : null}
        {diagnostics.versionString ? <Tag>{diagnostics.versionString}</Tag> : null}
        {typeof diagnostics.isStudio === 'boolean' ? <Tag>{diagnostics.isStudio ? 'Studio' : 'Free / Unknown'}</Tag> : null}
        <Tag>{`containers ${(diagnostics.renderSupport?.containers || []).length}`}</Tag>
      </div>
      {diagnostics.checkedAt ? <div className="muted">{`checkedAt · ${diagnostics.checkedAt}`}</div> : null}
      {diagnostics.blockingReasons?.length ? (
        <div className="capture-time-tags">
          {diagnostics.blockingReasons.map((reason, index) => (
            <Tag key={`host-blocker:${index}`}>{reason}</Tag>
          ))}
        </div>
      ) : <div className="muted">当前没有 host blocker。</div>}
      {diagnostics.warnings?.length ? (
        <div className="capture-time-tags">
          {diagnostics.warnings.map((warning, index) => (
            <Tag key={`host-warning:${index}`}>{warning}</Tag>
          ))}
        </div>
      ) : null}
      {(diagnostics.renderSupport?.containers || []).length > 0 ? (
        <div className="stack-list">
          {diagnostics.renderSupport.containers.map(container => (
            <div key={`host-container:${container.container}`} className="job-item">
              <div>
                <strong>{container.container}</strong>
                <div className="muted">
                  {container.videoCodecs?.length > 0
                    ? `videoCodec: ${container.videoCodecs.join(' / ')}`
                    : 'videoCodec: 未探测到'}
                </div>
              </div>
              <Tag>{container.extension || container.container}</Tag>
            </div>
          ))}
          <div className="muted">
            {`AudioCodec: ${diagnostics.renderSupport.supportsAudioCodec ? 'supported' : 'unsupported'} · VideoQuality: ${diagnostics.renderSupport.supportsVideoQuality ? 'supported' : 'unsupported'}`}
          </div>
        </div>
      ) : null}
    </>
  );
}

function renderColorRecentBatches(items) {
  const batches = Array.isArray(items) ? items : [];
  if (batches.length === 0) {
    return <p className="muted">当前还没有 batch archive。</p>;
  }
  return batches.map(item => (
    <div key={`recent:${item.batchId}`} className="job-item">
      <div>
        <strong>{item.batchId}</strong>
        <div className="muted">{`${describeColorBatchSelection(item.plan)} · ${item.plan?.createdAt || 'unknown time'}`}</div>
        <div className="muted">
          {`targets ${item.plan?.entries?.length || 0} · validation ${item.validation?.status || 'pending'}`}
        </div>
      </div>
      <Tag>{item.validation?.status || 'planned'}</Tag>
    </div>
  ));
}

function renderColorValidationFailures(items) {
  const failures = Array.isArray(items) ? items : [];
  if (failures.length === 0) {
    return <p className="muted">当前没有 validation fail 归档。</p>;
  }
  return failures.map(item => (
    <div key={`validation:${item.batchId}`} className="row-card">
      <div className="row-top">
        <div>
          <strong>{item.batchId}</strong>
          <div className="muted">{`${describeColorBatchSelection(item.plan)} · ${item.validation?.validatedAt || 'unknown time'}`}</div>
        </div>
        <Tag>{item.validation?.status || 'fail'}</Tag>
      </div>
      <div className="muted">
        {describeColorValidationSummary(item.validation?.summary)}
      </div>
      {Array.isArray(item.validation?.blockingReasons) && item.validation.blockingReasons.length > 0 ? (
        <div className="capture-time-tags">
          {item.validation.blockingReasons.map((reason, index) => (
            <Tag key={`validation-reason:${item.batchId}:${index}`}>{reason}</Tag>
          ))}
        </div>
      ) : null}
      {(item.validation?.entries || []).filter(entry => entry.status === 'fail').map(entry => (
        <div key={`validation-entry:${item.batchId}:${entry.rawRelativePath}`} className="job-item">
          <div>
            <strong>{entry.rawRelativePath}</strong>
            <div className="muted">{entry.reasons?.join(' · ') || 'validation failed'}</div>
            {(entry.warnings || []).length > 0 ? (
              <div className="muted">{`warnings · ${entry.warnings.join(' · ')}`}</div>
            ) : null}
            <div className="muted">{describeColorValidationChecks(entry.checks)}</div>
          </div>
          <Tag>{entry.status}</Tag>
        </div>
      ))}
    </div>
  ));
}

function renderColorPromoteHistory(items) {
  const history = Array.isArray(items) ? items : [];
  if (history.length === 0) {
    return <p className="muted">当前还没有 promote 历史。</p>;
  }
  return history.map(item => (
    <details key={`promote:${item.batchId}`}>
      <summary>
        <strong>{item.batchId}</strong>
        {` · ${describeColorBatchSelection(item.plan)} · ${item.promote?.promotedAt || 'unknown time'} · ${item.promote?.status || 'completed'} · outputs ${item.promote?.outputs?.length || 0} · deleted ${item.promote?.deletedOutputs?.length || 0}`}
      </summary>
      <div className="stack-list">
        {(item.promote?.outputs || []).length > 0 ? (
          <div className="capture-time-tags">
            {item.promote.outputs.map((output, index) => (
              <Tag key={`promote-output:${item.batchId}:${index}`}>{output}</Tag>
            ))}
          </div>
        ) : <div className="muted">没有 outputs 记录。</div>}
        {(item.promote?.deletedOutputs || []).length > 0 ? (
          <div className="capture-time-tags">
            {item.promote.deletedOutputs.map((output, index) => (
              <Tag key={`promote-deleted:${item.batchId}:${index}`}>{output}</Tag>
            ))}
          </div>
        ) : <div className="muted">没有 deletedOutputs 记录。</div>}
      </div>
    </details>
  ));
}

function describeColorBatchSelection(plan) {
  const mode = getColorStringField(plan, ['selectionMode']) || 'all';
  const count = Array.isArray(plan?.clipKeys) ? plan.clipKeys.length : (Array.isArray(plan?.entries) ? plan.entries.length : 0);
  if (mode === 'subset') {
    return `subset ${count} clips`;
  }
  return count > 0 ? `all ${count} clips` : 'all clips';
}

function buildColorArchiveMap(colorArchive) {
  const roots = Array.isArray(colorArchive?.roots)
    ? colorArchive.roots.filter(isPlainObject)
    : [];
  return roots.reduce((result, root) => {
    const rootId = getColorStringField(root, ['rootId']);
    if (!rootId) return result;
    result[rootId] = {
      rootId,
      recentBatches: Array.isArray(root.recentBatches) ? root.recentBatches.filter(isPlainObject) : [],
      validationFailures: Array.isArray(root.validationFailures) ? root.validationFailures.filter(isPlainObject) : [],
      promoteHistory: Array.isArray(root.promoteHistory) ? root.promoteHistory.filter(isPlainObject) : [],
    };
    return result;
  }, {});
}

function materializeColorHostPreflight(hostPreflight) {
  if (!isPlainObject(hostPreflight)) return null;
  return {
    status: getColorStringField(hostPreflight, ['status']) || 'unknown',
    checkedAt: getColorStringField(hostPreflight, ['checkedAt']),
    productName: getColorStringField(hostPreflight, ['productName']),
    versionString: getColorStringField(hostPreflight, ['versionString']),
    isStudio: typeof hostPreflight.isStudio === 'boolean' ? hostPreflight.isStudio : undefined,
    warnings: normalizeColorBlockers(hostPreflight.warnings),
    blockingReasons: normalizeColorBlockers(hostPreflight.blockingReasons),
    renderSupport: {
      containers: Array.isArray(hostPreflight.renderSupport?.containers)
        ? hostPreflight.renderSupport.containers.filter(isPlainObject).map(container => ({
          container: getColorStringField(container, ['container']) || 'unknown',
          extension: getColorStringField(container, ['extension']),
          videoCodecs: Array.isArray(container.videoCodecs)
            ? container.videoCodecs.filter(item => typeof item === 'string' && item.trim()).map(item => item.trim())
            : [],
        }))
        : [],
      supportsAudioCodec: Boolean(hostPreflight.renderSupport?.supportsAudioCodec),
      supportsVideoQuality: Boolean(hostPreflight.renderSupport?.supportsVideoQuality),
    },
  };
}

function describeColorValidationSummary(summary) {
  if (!isPlainObject(summary)) return 'summary unavailable';
  return [
    `targets ${Number(summary.targetCount || 0)}`,
    `rendered ${Number(summary.renderedCount || 0)}`,
    `passed ${Number(summary.passedCount || 0)}`,
    `failed ${Number(summary.failedCount || 0)}`,
  ].join(' · ');
}

function describeColorValidationChecks(checks) {
  if (!isPlainObject(checks)) return 'checks unavailable';
  return Object.entries(checks)
    .map(([key, value]) => `${key}:${value}`)
    .join(' · ');
}

function buildMinimalColorRootCards(config) {
  const readModelRoots = Array.isArray(config?.colorRoots)
    ? config.colorRoots.filter(isPlainObject)
    : [];
  const transformPresetOptions = buildColorTransformPresetOptions(config?.workspaceColorTransformPresets);
  const projectBriefMappings = Array.isArray(config?.projectBrief?.mappings)
    ? config.projectBrief.mappings.filter(isPlainObject)
    : [];
  const projectRootById = new Map(projectBriefMappings.map(root => [String(root.rootId || root.id), root]));

  if (readModelRoots.length > 0) {
    return readModelRoots.map((root, index) => {
      const projectRoot = projectRootById.get(String(root.rootId || getColorRootId(root, index)));
      const renderPreset = materializeProjectRootRenderPreset(projectRoot?.color?.renderPreset || root.renderPreset);
      const colorSpaceProfile = materializeProjectRootColorSpaceProfile(projectRoot?.color?.colorSpaceProfile || root.colorSpaceProfile);
      const transformPresetKey = materializeProjectRootTransformPresetKey(projectRoot?.color?.transformPresetKey || root.transformPresetKey);
      const current = materializeColorRootCurrent(isPlainObject(root.colorCurrent) ? root.colorCurrent : null);
      const hostPreflight = materializeColorHostPreflight(root.hostPreflight || current?.hostPreflight);
      const blockers = normalizeColorBlockers(root.blockingReasons || current?.blockingReasons);
      const currentPath = getColorStringField(root, ['currentPath', 'localPath', 'path']);
      const displayRawPath = getColorStringField(root, ['displayRawPath', 'rawLocalPath', 'rawPath']);
      return {
        key: String(root.rootId || getColorRootId(root, index)),
        rootId: String(root.rootId || getColorRootId(root, index)),
        label: getColorRootLabel(root, index),
        description: getColorStringField(root, ['description']),
        path: getColorStringField(root, ['path']),
        localPath: getColorStringField(root, ['localPath']),
        currentPath,
        rawPath: getColorStringField(root, ['rawPath']),
        rawLocalPath: getColorStringField(root, ['rawLocalPath']),
        displayRawPath,
        resolveProjectName: getColorStringField(root, ['resolveProjectName']),
        rootNamespace: getColorStringField(root, ['rootNamespace']),
        gradingTimelineName: getColorStringField(root, ['gradingTimelineName']),
        latestDrpSnapshot: isPlainObject(root.latestDrpSnapshot)
          ? root.latestDrpSnapshot
          : isPlainObject(current?.latestDrpSnapshot)
            ? current.latestDrpSnapshot
            : null,
        renderPreset,
        colorSpaceProfile,
        transformPresetKey,
        transformPresetOptions,
        bitrateKbps: renderPreset.bitrateKbps,
        renderPresetSummary: describeColorRenderPreset(renderPreset, renderPreset.bitrateKbps),
        pathText: [
          currentPath || 'no current path',
          displayRawPath || 'no raw path',
        ].join(' · '),
        hostPreflight,
        blockers,
        blockerCountText: blockers.length > 0 ? `${blockers.length} blockers` : '',
        current,
        groups: Array.isArray(root.groups)
          ? root.groups.filter(isPlainObject).map(materializeColorWorkspaceGroup)
          : [],
      };
    });
  }

  return projectBriefMappings
    .filter(root => getColorStringField(root, ['rawPath']))
    .map((root, index) => {
      const renderPreset = materializeProjectRootRenderPreset(root.color?.renderPreset);
      const colorSpaceProfile = materializeProjectRootColorSpaceProfile(root.color?.colorSpaceProfile);
      const transformPresetKey = materializeProjectRootTransformPresetKey(root.color?.transformPresetKey);
      const currentPath = getColorStringField(root, ['path']);
      const displayRawPath = getColorStringField(root, ['rawPath']);
      return {
        key: String(root.rootId || root.id || `root-${index + 1}`),
        rootId: String(root.rootId || root.id || `root-${index + 1}`),
        label: getColorRootLabel(root, index),
        description: getColorStringField(root, ['description']),
        path: getColorStringField(root, ['path']),
        localPath: currentPath,
        currentPath,
        rawPath: getColorStringField(root, ['rawPath']),
        rawLocalPath: displayRawPath,
        displayRawPath,
        resolveProjectName: '',
        rootNamespace: '',
        gradingTimelineName: '',
        latestDrpSnapshot: null,
        renderPreset,
        colorSpaceProfile,
        transformPresetKey,
        transformPresetOptions,
        bitrateKbps: renderPreset.bitrateKbps,
        renderPresetSummary: describeColorRenderPreset(renderPreset, renderPreset.bitrateKbps),
        pathText: [
          currentPath || 'no current path',
          displayRawPath || 'no raw path',
        ].join(' · '),
        hostPreflight: null,
        blockers: [],
        blockerCountText: '',
        current: null,
        groups: [],
      };
    });
}

function materializeProjectRootRenderPreset(renderPreset) {
  return {
    container: normalizeColorOptionalString(renderPreset?.container) || 'mp4',
    videoCodec: normalizeColorOptionalString(renderPreset?.videoCodec || renderPreset?.videoCodecName) || 'h265',
    audioCodec: normalizeColorOptionalString(renderPreset?.audioCodec || renderPreset?.audioCodecName) || 'aac',
    bitrateKbps: normalizeColorBitrateValue(renderPreset?.bitrateKbps),
  };
}

function materializeProjectRootColorSpaceProfile(value) {
  const normalized = normalizeColorOptionalString(value);
  if (!normalized) return '';
  if (/^s-?log3$/u.test(normalized)) return 'slog3';
  if (/^d-?log$/u.test(normalized)) return 'dlog';
  if (/^d-?log-?m$/u.test(normalized)) return 'dlog-m';
  if (/^hlg$/u.test(normalized)) return 'hlg';
  if (/^rec[.-]?709$/u.test(normalized)) return 'rec709';
  return normalized
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function materializeProjectRootTransformPresetKey(value) {
  const normalized = normalizeColorOptionalString(value);
  if (!normalized) return '';
  const relativePath = normalized
    .replace(/\s*[\\/]+\s*/g, '/')
    .replace(/^\/+/g, '')
    .replace(/\/+/g, '/');
  if (
    !relativePath
    || relativePath.startsWith('..')
    || relativePath.includes('/../')
    || /^[a-z]:/iu.test(relativePath)
    || relativePath.includes('://')
  ) {
    return '';
  }
  return relativePath.toLowerCase().endsWith('.cube')
    ? relativePath
    : `${relativePath}.cube`;
}

function buildColorTransformPresetOptions(config) {
  const discoveredPresets = isPlainObject(config?.discoveredPresets) ? config.discoveredPresets : {};
  const options = Object.entries(discoveredPresets)
    .filter(([, preset]) => isPlainObject(preset))
    .map(([presetKey, preset]) => ({
      value: materializeProjectRootTransformPresetKey(presetKey),
      label: normalizeColorOptionalString(preset.displayName) || presetKey,
    }))
    .filter(option => option.value);
  options.sort((left, right) => left.label.localeCompare(right.label, 'zh-Hans-CN'));
  return [{ value: '', label: '自动 / 按 profile' }, ...options];
}

function createProjectBriefMappingDraft(existingMappings) {
  const existingRootIds = new Set(
    (Array.isArray(existingMappings) ? existingMappings : [])
      .map(mapping => normalizeColorOptionalString(mapping?.rootId))
      .filter(Boolean),
  );
  let rootId = '';
  do {
    rootId = `root-draft-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  } while (existingRootIds.has(rootId));
  return {
    rootId,
    path: '',
    rawPath: '',
    alternatePaths: [],
    description: '',
    flightRecordPath: '',
    enabled: true,
  };
}

function createAlternatePathDraft() {
  return {
    path: '',
    rawPath: '',
  };
}

function normalizeAlternatePathDrafts(value) {
  return Array.isArray(value)
    ? value.filter(isPlainObject).map(item => ({
      path: String(item.path || ''),
      rawPath: String(item.rawPath || ''),
    }))
    : [];
}

function normalizePathResolutionBlockers(summary) {
  if (!isPlainObject(summary)) return [];
  const blockers = Array.isArray(summary.blockingReasons)
    ? summary.blockingReasons
    : [];
  return blockers
    .map(item => String(item || '').trim())
    .filter(Boolean);
}

function updateProjectRootRenderPreset(setProjectBrief, rootId, patch) {
  if (typeof setProjectBrief !== 'function' || !rootId) return;
  setProjectBrief(current => {
    const config = isPlainObject(current) ? current : {};
    const roots = Array.isArray(config.mappings)
      ? config.mappings.filter(isPlainObject)
      : [];
    const index = roots.findIndex(root => String(root.rootId || root.id) === String(rootId));
    if (index < 0) {
      return config;
    }
    const existingRoot = roots[index];
    const existingPreset = materializeProjectRootRenderPreset(existingRoot.color?.renderPreset);
    const nextPreset = {
      container: normalizeColorOptionalString(patch?.container) || existingPreset.container || 'mp4',
      videoCodec: normalizeColorOptionalString(patch?.videoCodec) || existingPreset.videoCodec || 'h265',
      audioCodec: normalizeColorOptionalString(patch?.audioCodec) || existingPreset.audioCodec || 'aac',
      bitrateKbps: Object.prototype.hasOwnProperty.call(patch || {}, 'bitrateKbps')
        ? normalizeColorBitrateValue(patch?.bitrateKbps)
        : existingPreset.bitrateKbps,
    };
    const nextRoots = [...roots];
    nextRoots[index] = {
      ...existingRoot,
      color: {
        ...(isPlainObject(existingRoot.color) ? existingRoot.color : {}),
        renderPreset: nextPreset,
      },
    };
    return {
      ...config,
      mappings: nextRoots,
    };
  });
}

function updateProjectRootColorSpaceProfile(setProjectBrief, rootId, value) {
  if (typeof setProjectBrief !== 'function' || !rootId) return;
  setProjectBrief(current => {
    const config = isPlainObject(current) ? current : {};
    const roots = Array.isArray(config.mappings)
      ? config.mappings.filter(isPlainObject)
      : [];
    const index = roots.findIndex(root => String(root.rootId || root.id) === String(rootId));
    if (index < 0) {
      return config;
    }
    const existingRoot = roots[index];
    const nextRoots = [...roots];
    nextRoots[index] = {
      ...existingRoot,
      color: {
        ...(isPlainObject(existingRoot.color) ? existingRoot.color : {}),
        colorSpaceProfile: materializeProjectRootColorSpaceProfile(value) || undefined,
      },
    };
    return {
      ...config,
      mappings: nextRoots,
    };
  });
}

function updateProjectRootTransformPresetKey(setProjectBrief, rootId, value) {
  if (typeof setProjectBrief !== 'function' || !rootId) return;
  setProjectBrief(current => {
    const config = isPlainObject(current) ? current : {};
    const roots = Array.isArray(config.mappings)
      ? config.mappings.filter(isPlainObject)
      : [];
    const index = roots.findIndex(root => String(root.rootId || root.id) === String(rootId));
    if (index < 0) {
      return config;
    }
    const existingRoot = roots[index];
    const nextRoots = [...roots];
    nextRoots[index] = {
      ...existingRoot,
      color: {
        ...(isPlainObject(existingRoot.color) ? existingRoot.color : {}),
        transformPresetKey: materializeProjectRootTransformPresetKey(value) || undefined,
      },
    };
    return {
      ...config,
      mappings: nextRoots,
    };
  });
}

export function ReviewQueuePanel({
  reviews,
  setReviews,
  onResolve,
  title = 'Review Queue',
  emptyLabel = '当前没有待处理 review。',
  filter,
  compact = false,
}) {
  const visibleItems = typeof filter === 'function'
    ? reviews.filter(filter)
    : reviews;

  return (
    <Card className="panel">
      <div className="section-header">
        <h2>{title}</h2>
        <Tag>{`${visibleItems.length} 条`}</Tag>
      </div>
      {visibleItems.length === 0 ? <p className="muted">{emptyLabel}</p> : null}
      {visibleItems.map(review => (
        <div key={review.id} className="row-card">
          <div className="row-top">
            <div>
              <strong>{review.title}</strong>
              <div className="muted">{review.stage}</div>
            </div>
            <Tag>{review.status}</Tag>
          </div>
          <p className="muted">{review.reason}</p>
          {(review.fields || []).map(field => (
            <Field
              key={`${review.id}:${field.key}`}
              label={`${field.label}${field.required ? ' *' : ''}`}
              value={field.value || ''}
              placeholder={field.suggestedValue || ''}
              onChange={value => updateReviewField(reviews, review.id, field.key, value, setReviews)}
            />
          ))}
          <TextAreaField
            label="备注"
            value={review.note || ''}
            onChange={value => updateReviewNote(reviews, review.id, value, setReviews)}
            rows={compact ? 3 : 4}
          />
          <div className="actions">
            <Button type="primary" onClick={() => onResolve(review.id)}>标记完成</Button>
          </div>
        </div>
      ))}
    </Card>
  );
}

export function SectionHeader({ title, onSave, busy, saveDisabled = false, actions = null }) {
  return (
    <div className="section-header">
      <h2>{title}</h2>
      <div className="actions">
        {actions}
        {typeof onSave === 'function' ? (
          <Button
            type={busy || saveDisabled ? 'disabled' : 'primary'}
            disabled={busy || saveDisabled}
            onClick={onSave}
          >
            {busy ? '保存中…' : '保存'}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

export function ListToolbar({ title, onAdd, disabled = false }) {
  return (
    <div className="list-toolbar">
      <h3>{title}</h3>
      <Button
        type={disabled ? 'disabled' : 'default'}
        disabled={disabled}
        onClick={onAdd}
      >
        新增
      </Button>
    </div>
  );
}

export function Field({
  label,
  value,
  onChange,
  readOnly = false,
  disabled = false,
  placeholder = '',
  type = 'text',
  step,
  inputMode,
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <input
        type={type}
        value={value}
        readOnly={readOnly}
        disabled={disabled}
        placeholder={placeholder}
        step={step}
        inputMode={inputMode}
        onChange={event => onChange(event.target.value)}
      />
    </label>
  );
}

export function SelectField({ label, value, onChange, options, disabled = false }) {
  return (
    <label className="field">
      <span>{label}</span>
      <select
        value={value}
        disabled={disabled}
        onChange={event => onChange(event.target.value)}
      >
        {options.map(option => (
          <option key={`${option.value}:${option.label}`} value={option.value}>{option.label}</option>
        ))}
      </select>
    </label>
  );
}

export function TextAreaField({ label, value, onChange, rows = 4, disabled = false }) {
  return (
    <label className="field field-area">
      <span>{label}</span>
      <textarea value={value} disabled={disabled} onChange={event => onChange(event.target.value)} rows={rows} />
    </label>
  );
}

function stringifyColorConfig(config) {
  return JSON.stringify(isPlainObject(config) ? config : {}, null, 2);
}

function parseColorConfigDraft(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) {
    return {};
  }
  const parsed = JSON.parse(trimmed);
  if (!isPlainObject(parsed)) {
    throw new Error('colorConfig 必须是对象');
  }
  return parsed;
}

function summarizeColorRoots(config) {
  const roots = extractColorRoots(config);
  return roots.map((root, index) => ({
    key: String(getColorRootId(root, index)),
    label: getColorRootLabel(root, index),
    rawPath: getColorRootRawPath(root),
    presetSummary: describeColorRenderPreset(getColorRenderPreset(root), getColorRenderPresetBitrate(root)),
    current: matchesColorRoot(root, resolveColorCurrentRootId(config)),
  }));
}

function buildColorRootCards(config, rootSummaries, legacyColorConfig, legacyColorCurrent) {
  const readModelRoots = Array.isArray(config?.colorRoots)
    ? config.colorRoots.filter(isPlainObject)
    : [];
  if (readModelRoots.length > 0) {
    const draftRoots = new Map(
      extractColorRoots(legacyColorConfig).map((root, index) => [String(getColorRootId(root, index)), root]),
    );
    return readModelRoots.map((root, index) => {
      const draftRoot = draftRoots.get(String(getColorRootId(root, index)));
      const readModelColorConfig = isPlainObject(root.colorConfig) ? root.colorConfig : null;
      return normalizeColorRootCard({
        ...root,
        colorConfig: draftRoot
          ? applyColorRootDraftPatch(materializeColorRootConfigDraft(root, readModelColorConfig), draftRoot)
          : materializeColorRootConfigDraft(root, readModelColorConfig),
      }, index);
    });
  }
  const fallbackRoots = extractColorRoots(legacyColorConfig);
  if (fallbackRoots.length > 0) {
    return fallbackRoots.map((root, index) => normalizeColorRootCard({
      ...root,
      colorCurrent: legacyColorCurrent,
    }, index));
  }
  if (rootSummaries.length > 0) {
    return rootSummaries.map((root, index) => normalizeLegacyColorRootCard(root, index));
  }
  if (isPlainObject(legacyColorConfig) || isPlainObject(legacyColorCurrent)) {
    return [normalizeColorRootCard({
      rootId: 'root-1',
      description: 'legacy color config',
      colorConfig: legacyColorConfig,
      colorCurrent: legacyColorCurrent,
    }, 0)];
  }
  return [];
}

function extractColorRoots(config) {
  if (!isPlainObject(config)) {
    return [];
  }
  const candidates = [config.roots, config.rootMappings, config.items, config.entries];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate.filter(item => isPlainObject(item));
    }
  }
  if (config.rawPath || config.rawLocalPath || config.renderPreset || config.bitrateKbps) {
    return [config];
  }
  return [];
}

function normalizeColorRootCard(root, index) {
  const rootConfig = isPlainObject(root?.colorConfig) ? root.colorConfig : root;
  const rootCurrent = materializeColorRootCurrent(isPlainObject(root?.colorCurrent) ? root.colorCurrent : null);
  const draftGroups = Array.isArray(root?.draftGroups)
    ? root.draftGroups.filter(isPlainObject)
    : [];
  const configuredGroups = Array.isArray(rootConfig?.groups)
    ? rootConfig.groups.filter(isPlainObject)
    : [];
  const assetCount = Number.isFinite(root?.assetCount) ? root.assetCount : Number(rootConfig?.assetCount);
  const anchorSummary = describeColorAnchors(root?.firstAnchor || rootConfig?.firstAnchor, root?.lastAnchor || rootConfig?.lastAnchor);
  const path = getColorStringField(root, ['path']) || getColorStringField(rootConfig, ['path']);
  const localPath = getColorStringField(root, ['localPath']) || getColorStringField(rootConfig, ['localPath']);
  const rawPath = getColorStringField(root, ['rawPath']) || getColorStringField(rootConfig, ['rawPath']);
  const rawLocalPath = getColorStringField(root, ['rawLocalPath']) || getColorStringField(rootConfig, ['rawLocalPath']);
  const bitrateKbps = getColorRenderPresetBitrate(rootConfig);
  const blockers = normalizeColorBlockers(root?.blockingReasons || rootConfig?.blockingReasons || rootCurrent?.blockingReasons)
    .filter(blocker => {
      if (configuredGroups.length > 0 && blocker.includes('当前还没有已确认的 Resolve Group')) {
        return false;
      }
      if (
        bitrateKbps
        && (
          blocker.includes('未配置 root 级目标码率')
          || blocker.includes('renderPreset.bitrateKbps')
        )
      ) {
        return false;
      }
      return true;
    });
  return {
    key: String(getColorRootId(root, index)),
    rootId: getColorRootId(root, index),
    description: getColorStringField(root, ['description']) || getColorStringField(rootConfig, ['description']) || getColorRootLabel(root, index),
    path,
    localPath,
    rawPath,
    rawLocalPath,
    resolveProjectName: getColorStringField(rootConfig, ['resolveProjectName']),
    rootNamespace: getColorStringField(rootConfig, ['rootNamespace']),
    gradingTimelineName: getColorStringField(rootConfig, ['gradingTimelineName']),
    bitrateKbps,
    assetCountText: Number.isFinite(assetCount) ? `${assetCount} assets` : 'assets unknown',
    pathText: [path || 'no path', localPath || 'no localPath'].filter(Boolean).join(' · '),
    renderPresetSummary: describeColorRenderPreset(getColorRenderPreset(rootConfig), bitrateKbps),
    anchorSummary,
    blockers,
    blockerCountText: blockers.length > 0 ? `${blockers.length} blockers` : '',
    draftGroups,
    draftGroupReason: getColorStringField(root, ['draftGroupReason']),
    configuredGroups,
    current: rootCurrent,
  };
}

function normalizeLegacyColorRootCard(root, index) {
  const rootConfig = isPlainObject(root?.config) ? root.config : root;
  return normalizeColorRootCard({
    ...root,
    colorConfig: rootConfig,
    colorCurrent: isPlainObject(root?.current) ? root.current : null,
  }, index);
}

function normalizeColorBlockers(value) {
  if (value == null || value === '') {
    return [];
  }
  const items = Array.isArray(value) ? value : [value];
  return items.map(item => {
    if (item == null || item === '') return '';
    if (typeof item === 'string') return item.trim();
    if (typeof item === 'number' || typeof item === 'boolean') return String(item);
    if (isPlainObject(item)) {
      return getColorStringField(item, ['reason', 'message', 'detail', 'note', 'label', 'title', 'status']) || JSON.stringify(item);
    }
    return String(item);
  }).filter(Boolean).filter(item => !(
    item.includes('resolveColorPythonPath')
    || item.includes('resolveColorScriptApiRoot')
    || item.includes('config/runtime.json')
  ));
}

function describeColorAnchors(firstAnchor, lastAnchor) {
  const first = formatColorAnchor(firstAnchor);
  const last = formatColorAnchor(lastAnchor);
  if (!first && !last) {
    return 'anchors: 未配置';
  }
  if (first === last) {
    return `anchors: ${first}`;
  }
  return `anchors: ${first || 'start'} → ${last || 'end'}`;
}

function formatColorAnchor(anchor) {
  if (!anchor) return '';
  if (typeof anchor === 'string') return anchor;
  if (typeof anchor === 'number' || typeof anchor === 'boolean') return String(anchor);
  if (!isPlainObject(anchor)) return String(anchor);
  const name = getColorStringField(anchor, ['displayName', 'name', 'label', 'title', 'assetName', 'sourceName', 'assetId']);
  const time = getColorStringField(anchor, ['sortCapturedAt', 'capturedAt', 'time', 'datetime']);
  if (name && time) {
    return `${name} | ${time}`;
  }
  return name || time || JSON.stringify(anchor);
}

function getColorRootId(root, index) {
  return root?.rootId || root?.id || root?.key || root?.name || root?.label || `root-${index + 1}`;
}

function getColorRootLabel(root, index) {
  return root?.label || root?.displayName || root?.name || root?.rootId || root?.id || `Root ${index + 1}`;
}

function getColorRootRawPath(root) {
  return root?.rawPath || root?.rawLocalPath || root?.sourcePath || root?.path || '';
}

function getColorRenderPreset(root) {
  return isPlainObject(root?.renderPreset) ? root.renderPreset : root?.preset || root?.outputPreset || null;
}

function getColorRenderPresetBitrate(root) {
  const renderPreset = getColorRenderPreset(root);
  return renderPreset?.bitrateKbps
    || root?.bitrateKbps
    || '';
}

function describeColorRenderPreset(renderPreset, bitrate) {
  const parts = [
    getColorStringField(renderPreset, ['container']),
    getColorStringField(renderPreset, ['videoCodec', 'videoCodecName']),
    getColorStringField(renderPreset, ['audioCodec', 'audioCodecName']),
  ].filter(Boolean);
  if (bitrate) {
    parts.push(`bitrate ${bitrate} kb/s`);
  }
  if (!parts.length) {
    return 'render preset: 未配置';
  }
  return `render preset: ${parts.join(' · ')}`;
}

function matchesColorRoot(root, currentRootId) {
  if (!currentRootId || !root) return false;
  return [
    root.rootId,
    root.id,
    root.key,
    root.name,
    root.label,
  ].filter(Boolean).some(value => String(value) === String(currentRootId));
}

function resolveColorCurrentRootId(config) {
  return getColorStringField(config, ['currentRootId', 'activeRootId', 'selectedRootId', 'rootId']);
}

function materializeColorRootCurrent(current) {
  if (!isPlainObject(current)) {
    return current;
  }
  const groups = Array.isArray(current.groups)
    ? current.groups.filter(isPlainObject)
    : [];
  const groupSummary = isPlainObject(current.group)
    ? current.group
    : buildColorGroupStageSummary(groups);
  const batchSummary = isPlainObject(current.batch)
    ? current.batch
    : buildColorBatchStageSummary(current, groups);
  return {
    ...current,
    group: groupSummary,
    batch: batchSummary,
  };
}

function materializeColorWorkspaceGroup(group) {
  const current = isPlainObject(group?.current) ? group.current : {};
  return {
    groupKey: getColorStringField(group, ['groupKey']) || getColorStringField(current, ['groupKey']) || 'group',
    displayName: getColorStringField(group, ['displayName']) || getColorStringField(current, ['displayName']) || 'Unnamed Group',
    clipCount: Number(group?.clipCount || current?.clipCount || 0) || 0,
    clipKeys: Array.isArray(group?.clipKeys) ? group.clipKeys.filter(item => typeof item === 'string' && item.trim()) : [],
    logProfile: getColorStringField(group, ['logProfile']) || getColorStringField(current, ['logProfile']) || '',
    lowlight: getColorStringField(group, ['lowlight']) || getColorStringField(current, ['lowlight']) || '',
    colorCastClass: getColorStringField(group, ['colorCastClass']) || getColorStringField(current, ['colorCastClass']) || '',
    postClipCreativeStatus: getColorStringField(group, ['postClipCreativeStatus']) || getColorStringField(current, ['postClipCreativeStatus']) || '',
    clips: Array.isArray(group?.clips) ? group.clips.filter(isPlainObject).map(materializeColorWorkspaceClipRepair) : [],
    hostSummary: isPlainObject(group?.hostSummary) ? group.hostSummary : {},
    current: {
      ...current,
      status: getColorStringField(current, ['status', 'state', 'phase']) || 'ready',
    },
  };
}

function materializeColorWorkspaceClipRepair(clip) {
  return {
    clipKey: getColorStringField(clip, ['clipKey']) || 'clip',
    displayName: getColorStringField(clip, ['displayName']) || '',
    logProfile: getColorStringField(clip, ['logProfile']) || '',
    lowlight: typeof clip?.lowlight === 'boolean' ? clip.lowlight : undefined,
    colorCastClass: getColorStringField(clip, ['colorCastClass']) || '',
    colorCastConfidence: Number.isFinite(Number(clip?.colorCastConfidence)) ? Number(clip.colorCastConfidence) : undefined,
    colorCastMetrics: isPlainObject(clip?.colorCastMetrics) ? clip.colorCastMetrics : {},
    encodedWidth: Number(clip?.encodedWidth) || undefined,
    encodedHeight: Number(clip?.encodedHeight) || undefined,
    displayWidth: Number(clip?.displayWidth) || undefined,
    displayHeight: Number(clip?.displayHeight) || undefined,
    rotationDegrees: Number.isFinite(Number(clip?.rotationDegrees)) ? Number(clip.rotationDegrees) : undefined,
    orientationStatus: getColorStringField(clip, ['orientationStatus']) || '',
    repairTemplateKey: getColorStringField(clip, ['repairTemplateKey']) || getColorStringField(clip?.hostSummary, ['repairTemplateKey']) || '',
    timelineTransform: isPlainObject(clip?.timelineTransform)
      ? clip.timelineTransform
      : isPlainObject(clip?.hostSummary?.timelineTransform)
        ? clip.hostSummary.timelineTransform
        : {},
    gyroDataAvailable: clip?.gyroDataAvailable === true,
    gyroEligible: clip?.gyroEligible === true,
    gyroflowStatus: getColorStringField(clip, ['gyroflowStatus']) || '',
    dehazeStatus: getColorStringField(clip, ['dehazeStatus']) || '',
    nrStatus: getColorStringField(clip, ['nrStatus']) || '',
    clipRepairStatus: getColorStringField(clip, ['clipRepairStatus']) || '',
    layoutStatus: getColorStringField(clip, ['layoutStatus']) || getColorStringField(clip?.hostSummary, ['layoutStatus']) || '',
    reservedNodeIndices: isPlainObject(clip?.reservedNodeIndices)
      ? clip.reservedNodeIndices
      : isPlainObject(clip?.hostSummary?.reservedNodeIndices)
        ? clip.hostSummary.reservedNodeIndices
        : {},
    hostSummary: isPlainObject(clip?.hostSummary) ? clip.hostSummary : {},
  };
}

function buildColorGroupStageSummary(groups) {
  if (!Array.isArray(groups) || groups.length === 0) {
    return { status: 'empty', summary: '0 groups' };
  }
  const counts = {
    total: groups.length,
    idle: 0,
    ready: 0,
    running: 0,
    staged: 0,
    blocked: 0,
    draft: 0,
    promoted: 0,
    failed: 0,
  };
  for (const group of groups) {
    const status = getColorStringField(group, ['status', 'state', 'phase']) || 'ready';
    if (Object.prototype.hasOwnProperty.call(counts, status)) {
      counts[status] += 1;
    }
  }
  const status = counts.blocked > 0
    ? 'blocked'
    : counts.failed > 0
      ? 'failed'
      : counts.promoted > 0
        ? 'promoted'
    : counts.running > 0
      ? 'running'
      : counts.staged > 0
        ? 'staged'
        : counts.draft > 0
          ? 'draft'
          : 'ready';
  const fragments = [
    counts.idle > 0 ? `${counts.idle} idle` : '',
    counts.ready > 0 ? `${counts.ready} ready` : '',
    counts.running > 0 ? `${counts.running} running` : '',
    counts.staged > 0 ? `${counts.staged} staged` : '',
    counts.blocked > 0 ? `${counts.blocked} blocked` : '',
    counts.draft > 0 ? `${counts.draft} draft` : '',
    counts.promoted > 0 ? `${counts.promoted} promoted` : '',
    counts.failed > 0 ? `${counts.failed} failed` : '',
  ].filter(Boolean);
  return {
    status,
    total: counts.total,
    ready: counts.ready,
    current: counts.running + counts.staged,
    summary: fragments.join(' · ') || `${counts.total} groups`,
  };
}

function buildColorBatchStageSummary(current, groups) {
  const latestBatchId = getColorStringField(current, ['latestBatchId', 'batchId']);
  const latestBatchStatus = getColorStringField(current, ['latestBatchStatus']);
  const latestValidationStatus = getColorStringField(current, ['latestValidationStatus']);
  if (isPlainObject(current?.batch)) {
    return current.batch;
  }
  if (latestBatchId && latestValidationStatus === 'pass') {
    return {
      status: 'completed',
      batchId: latestBatchId,
      summary: '已导出并校验',
    };
  }
  if (latestBatchId) {
    return {
      status: latestBatchStatus || (latestValidationStatus === 'fail' ? 'failed' : 'ready'),
      batchId: latestBatchId,
      summary: latestValidationStatus
        ? `validation ${latestValidationStatus}`
        : latestBatchStatus
          ? `batch ${latestBatchStatus}`
          : `latest ${latestBatchId}`,
    };
  }
  if (Array.isArray(groups) && groups.some(group => getColorStringField(group, ['status']) === 'blocked')) {
    return {
      status: 'blocked',
      summary: 'group blocked',
    };
  }
  return {
    status: 'idle',
    summary: '尚无 batch',
  };
}

function findCurrentColorRoot(current, colorConfig, rootSummaries) {
  if (isPlainObject(current?.root)) {
    return current.root;
  }
  if (isPlainObject(current?.currentRoot)) {
    return current.currentRoot;
  }
  if (isPlainObject(current?.selectedRoot)) {
    return current.selectedRoot;
  }
  const currentRootId = getColorStringField(current, ['currentRootId', 'activeRootId', 'selectedRootId', 'rootId']);
  const roots = extractColorRoots(colorConfig);
  if (currentRootId) {
    const matchedRoot = roots.find(root => matchesColorRoot(root, currentRootId));
    if (matchedRoot) {
      return matchedRoot;
    }
  }
  if (rootSummaries.length === 1) {
    return roots[0] || null;
  }
  if (current?.activeRootIndex != null && roots[current.activeRootIndex]) {
    return roots[current.activeRootIndex];
  }
  return null;
}

function describeColorRoot(root, current) {
  const currentRootId = getColorStringField(current, ['currentRootId', 'activeRootId', 'selectedRootId', 'rootId']);
  if (root) {
    return getColorRootLabel(root, 0);
  }
  if (currentRootId) {
    return currentRootId;
  }
  return '未指定';
}

function summarizeColorStatusNode(node) {
  if (node == null || node === '') {
    return { status: 'empty', summary: '未提供' };
  }
  if (typeof node === 'string') {
    return { status: node, summary: node };
  }
  if (typeof node === 'number' || typeof node === 'boolean') {
    return { status: 'value', summary: String(node) };
  }
  if (Array.isArray(node)) {
    return { status: node.length > 0 ? 'ready' : 'empty', summary: `${node.length} 项` };
  }
  if (isPlainObject(node)) {
    const status = getColorStringField(node, ['status', 'state', 'phase', 'step']) || 'ready';
    const counts = [
      formatColorCount(node.current, node.total),
      formatColorCount(node.completed, node.total),
      formatColorCount(node.ready, node.total),
    ].filter(Boolean);
    const summaryParts = [
      getColorStringField(node, ['summary', 'message', 'detail', 'note', 'title', 'label']),
      getColorStringField(node, ['rootId', 'groupKey', 'batchId']),
      counts[0] || counts[1] || counts[2] || '',
    ].filter(Boolean);
    return {
      status,
      summary: summaryParts.join(' · ') || '已提供结构化状态',
    };
  }
  return { status: 'value', summary: String(node) };
}

function formatColorCount(current, total) {
  if (typeof current !== 'number' && typeof total !== 'number') {
    return '';
  }
  if (typeof total === 'number' && total > 0) {
    return `${current || 0}/${total}`;
  }
  return String(current || 0);
}

function updateColorRootDraft(setColorConfig, root, patch) {
  if (typeof setColorConfig !== 'function' || !isPlainObject(root)) return;
  const rootId = String(getColorRootId(root, 0));
  setColorConfig(current => {
    const config = isPlainObject(current) ? current : {};
    const roots = Array.isArray(config.roots)
      ? config.roots.filter(isPlainObject)
      : [];
    const index = roots.findIndex(item => String(getColorRootId(item, 0)) === rootId);
    const existing = index >= 0 ? roots[index] : null;
    const nextRoot = applyColorRootDraftPatch(materializeColorRootConfigDraft(root, existing), patch);
    const nextRoots = [...roots];
    if (index >= 0) {
      nextRoots[index] = nextRoot;
    } else {
      nextRoots.push(nextRoot);
    }
    return {
      ...config,
      roots: nextRoots,
    };
  });
}

function adoptColorDraftGroup(setColorConfig, root, group) {
  if (typeof setColorConfig !== 'function' || !isPlainObject(root) || !isPlainObject(group)) return;
  updateColorRootDraft(setColorConfig, root, currentRoot => {
    const existingGroups = Array.isArray(currentRoot.groups)
      ? currentRoot.groups.filter(isPlainObject).map(materializeColorGroupDraft)
      : [];
    const nextGroup = materializeColorGroupDraft(group);
    if (existingGroups.some(item => item.groupKey === nextGroup.groupKey)) {
      return currentRoot;
    }
    return {
      ...currentRoot,
      groups: [...existingGroups, nextGroup],
    };
  });
}

function materializeColorRootConfigDraft(root, existing) {
  const baseRoot = isPlainObject(existing)
    ? existing
    : (isPlainObject(root?.colorConfig) ? root.colorConfig : {});
  const renderPreset = isPlainObject(baseRoot.renderPreset)
    ? baseRoot.renderPreset
    : {};
  return {
    rootId: String(getColorRootId(root, 0)),
    resolveProjectName: normalizeColorOptionalString(baseRoot.resolveProjectName ?? root?.resolveProjectName),
    rootNamespace: normalizeColorOptionalString(baseRoot.rootNamespace ?? root?.rootNamespace),
    gradingTimelineName: normalizeColorOptionalString(baseRoot.gradingTimelineName ?? root?.gradingTimelineName),
    renderPreset: {
      container: normalizeColorOptionalString(renderPreset.container) || 'mp4',
      videoCodec: normalizeColorOptionalString(renderPreset.videoCodec ?? renderPreset.videoCodecName) || 'h265',
      audioCodec: normalizeColorOptionalString(renderPreset.audioCodec ?? renderPreset.audioCodecName) || 'aac',
      bitrateKbps: normalizeColorBitrateValue(renderPreset.bitrateKbps ?? root?.bitrateKbps),
    },
    groups: Array.isArray(baseRoot.groups)
      ? baseRoot.groups.filter(isPlainObject).map(materializeColorGroupDraft)
      : Array.isArray(root?.configuredGroups)
        ? root.configuredGroups.filter(isPlainObject).map(materializeColorGroupDraft)
        : [],
    updatedAt: normalizeColorOptionalString(baseRoot.updatedAt),
  };
}

function materializeColorGroupDraft(group) {
  return {
    groupKey: getColorStringField(group, ['groupKey']) || 'bootstrap',
    displayName: normalizeColorOptionalString(group?.displayName),
    technicalSummary: Array.isArray(group?.technicalSummary)
      ? group.technicalSummary.filter(item => typeof item === 'string' && item.trim()).map(item => item.trim())
      : [],
    creativeLookKey: normalizeColorOptionalString(group?.creativeLookKey),
  };
}

function applyColorRootDraftPatch(rootConfig, patch) {
  const nextPatch = typeof patch === 'function'
    ? patch(rootConfig)
    : patch;
  if (!isPlainObject(nextPatch)) {
    return rootConfig;
  }
  const nextRenderPreset = isPlainObject(nextPatch.renderPreset)
    ? nextPatch.renderPreset
    : {};
  const hasDirectBitrate = Object.prototype.hasOwnProperty.call(nextPatch, 'bitrateKbps');
  const hasRenderPresetBitrate = Object.prototype.hasOwnProperty.call(nextRenderPreset, 'bitrateKbps');
  return {
    rootId: normalizeColorOptionalString(nextPatch.rootId) || rootConfig.rootId,
    resolveProjectName: normalizeColorOptionalString(nextPatch.resolveProjectName) ?? rootConfig.resolveProjectName,
    rootNamespace: normalizeColorOptionalString(nextPatch.rootNamespace) ?? rootConfig.rootNamespace,
    gradingTimelineName: normalizeColorOptionalString(nextPatch.gradingTimelineName) ?? rootConfig.gradingTimelineName,
    renderPreset: {
      container: normalizeColorOptionalString(nextRenderPreset.container) || rootConfig.renderPreset?.container || 'mp4',
      videoCodec: normalizeColorOptionalString(nextRenderPreset.videoCodec ?? nextRenderPreset.videoCodecName) || rootConfig.renderPreset?.videoCodec || 'h265',
      audioCodec: normalizeColorOptionalString(nextRenderPreset.audioCodec ?? nextRenderPreset.audioCodecName) || rootConfig.renderPreset?.audioCodec || 'aac',
      bitrateKbps: hasDirectBitrate
        ? normalizeColorBitrateValue(nextPatch.bitrateKbps)
        : hasRenderPresetBitrate
          ? normalizeColorBitrateValue(nextRenderPreset.bitrateKbps)
          : normalizeColorBitrateValue(rootConfig.renderPreset?.bitrateKbps),
    },
    groups: Array.isArray(nextPatch.groups)
      ? nextPatch.groups.filter(isPlainObject).map(materializeColorGroupDraft)
      : rootConfig.groups,
    updatedAt: normalizeColorOptionalString(nextPatch.updatedAt) ?? rootConfig.updatedAt,
  };
}

function formatColorBitrateInput(value) {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
}

function getColorStringField(object, keys) {
  if (!isPlainObject(object)) return '';
  for (const key of keys) {
    const value = object[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      return String(value);
    }
  }
  return '';
}

function normalizeColorOptionalString(value) {
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed || undefined;
}

function normalizeColorBitrateValue(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    const parsed = Number(trimmed);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return undefined;
}

function getColorJobRootId(job) {
  return getColorStringField(job?.args, ['rootId'])
    || getColorStringField(job, ['rootId'])
    || (['prepare_all_roots', 'export_all_roots'].includes(getColorJobAction(job)) ? 'all-roots' : '');
}

function getColorJobAction(job) {
  return getColorStringField(job?.args, ['action']) || 'prepare_root';
}

function formatColorJobProgress(progress) {
  if (!isPlainObject(progress)) return '';
  const current = Number(progress.current || 0);
  const total = Number(progress.total || 0);
  const percent = getColorProgressPercent(progress);
  if (total > 0) {
    const unit = formatColorProgressUnit(progress.unit);
    const failedCount = Number(progress.extra?.failedCount || 0);
    const failureText = failedCount > 0 ? ` · 失败 ${failedCount}` : '';
    return `${current}/${total} ${unit} · ${percent.toFixed(1)}%${failureText}`;
  }
  return progress.status || '';
}

function getColorProgressPercent(progress) {
  if (!isPlainObject(progress)) return 0;
  const explicitPercent = Number(progress.percent);
  if (Number.isFinite(explicitPercent)) {
    return clampPercent(explicitPercent);
  }
  const current = Number(progress.current || 0);
  const total = Number(progress.total || 0);
  if (!Number.isFinite(current) || !Number.isFinite(total) || total <= 0) {
    return progress.status === 'succeeded' ? 100 : 0;
  }
  return clampPercent((current / total) * 100);
}

function clampPercent(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

function formatColorProgressUnit(unit) {
  if (unit === 'file') return '文件';
  if (unit === 'step') return '步骤';
  return unit || '项';
}

function hasLiveColorJobForRoot(liveJobs, rootId, action) {
  return (liveJobs || []).some(job => (
    String(getColorJobRootId(job)) === String(rootId)
      && (!action || getColorJobAction(job) === action)
  ));
}

function canRunProjectColorAction(action, roots, capability, liveJobs, busy, onRunColorAction) {
  if (typeof onRunColorAction !== 'function') return false;
  if (capability?.supported === false) return false;
  if (busy?.['project-brief']) return false;
  if (busy?.['job:color']) return false;
  if ((liveJobs || []).length > 0) return false;
  if (!Array.isArray(roots) || roots.length === 0) return false;
  if (roots.some(root => getColorStringField(root.hostPreflight, ['status']) === 'blocked')) return false;
  if (action === 'export_all_roots') {
    return roots.every(root => getColorStringField(root.current, ['timelineStatus']) === 'ready');
  }
  return true;
}

function canRunColorRootAction(action, root, capability, liveJobs, busy, onRunColorAction) {
  if (typeof onRunColorAction !== 'function') return false;
  if (capability?.supported === false) return false;
  if (busy?.['project-brief']) return false;
  if (busy?.['job:color']) return false;
  if ((liveJobs || []).length > 0) return false;
  if (['sync_batch_metadata', 'sync_batch_sidecars', 'validate_batch'].includes(action)) {
    return Boolean(getColorStringField(root.current, ['latestBatchId']));
  }
  if (getColorStringField(root.hostPreflight, ['status']) === 'blocked') return false;
  if (action === 'sync_groups' && !colorRootHasSyncableResolveGroups(root)) return false;
  if (action === 'execute_root' && getColorStringField(root.current, ['timelineStatus']) !== 'ready') return false;
  if (action === 'promote_batch') {
    return Boolean(getColorStringField(root.current, ['pendingPromoteBatchId']) || (
      getColorStringField(root.current, ['latestBatchId']) && getColorStringField(root.current, ['latestValidationStatus']) === 'pass'
    ));
  }
  return true;
}

function colorRootHasSyncableResolveGroups(root) {
  if (getColorStringField(root?.current, ['timelineStatus']) === 'ready') return true;
  if (getColorStringField(root?.current, ['groupSyncStatus']) === 'ready') return true;
  if (Array.isArray(root?.groups) && root.groups.length > 0) return true;
  if (Array.isArray(root?.current?.groups) && root.current.groups.length > 0) return true;
  return false;
}

function describeColorRootAction(action, root, liveJobs, busy) {
  if (busy?.['project-brief']) {
    return '保存中…';
  }
  if (busy?.['job:color']) {
    return '启动中…';
  }
  if (hasLiveColorJobForRoot(liveJobs, root.rootId, action)) {
    if (action === 'sync_groups') return '同步中…';
    if (action === 'execute_root') return '执行中…';
    if (action === 'sync_batch_metadata') return '同步中…';
    if (action === 'sync_batch_sidecars') return '同步中…';
    if (action === 'validate_batch') return '校验中…';
    if (action === 'promote_batch') return '覆盖中…';
    return '准备中…';
  }
  if ((liveJobs || []).length > 0) {
    return '等待当前 color job…';
  }
  if (action === 'sync_groups') {
    return getColorStringField(root.current, ['groupSyncStatus']) === 'ready' ? '重同步 Groups' : 'Sync Groups';
  }
  if (action === 'execute_root') {
    return getColorStringField(root.current, ['latestBatchId']) ? '重新 Execute Root' : 'Execute Root';
  }
  if (action === 'sync_batch_metadata') {
    return '同步元信息';
  }
  if (action === 'sync_batch_sidecars') {
    return '同步字幕/备份音轨';
  }
  if (action === 'validate_batch') {
    return 'Validate';
  }
  if (action === 'promote_batch') {
    return 'Promote';
  }
  const mirrorReady = ['ready', 'synced'].includes(getColorStringField(root.current, ['mirrorStatus']));
  const timelineReady = getColorStringField(root.current, ['timelineStatus']) === 'ready';
  return mirrorReady && timelineReady ? '重跑 Prep' : '准备 Root';
}

function describeProjectColorAction(action, roots, liveJobs, busy) {
  if (busy?.['project-brief']) return '保存中…';
  if (busy?.['job:color']) return '启动中…';
  if ((liveJobs || []).some(job => getColorJobAction(job) === action)) {
    return action === 'export_all_roots' ? '统一导出中…' : '统一准备中…';
  }
  if ((liveJobs || []).length > 0) return '等待当前 color job…';
  if (!Array.isArray(roots) || roots.length === 0) return action === 'export_all_roots' ? '无可导出 roots' : '无可准备 roots';
  if (action === 'export_all_roots') {
    return roots.every(root => getColorStringField(root.current, ['timelineStatus']) === 'ready')
      ? 'Export All Roots'
      : '等待所有 roots ready';
  }
  return 'Prepare All Roots';
}

function describeColorTechnicalSignals(hostSummary) {
  const creativeTags = Array.isArray(hostSummary?.creativeTags)
    ? hostSummary.creativeTags.filter(item => typeof item === 'string' && item.trim()).map(item => item.trim())
    : [];
  const details = [];
  if (creativeTags.length > 0) {
    details.push(`tags: ${creativeTags.join(' · ')}`);
  }
  const detectedProfile = getColorStringField(hostSummary, ['detectedProfile']);
  const effectiveProfile = getColorStringField(hostSummary, ['effectiveProfile']);
  const resolvedPreset = getColorStringField(hostSummary, ['resolvedTransformPresetKey']);
  const transformStatus = getColorStringField(hostSummary, ['transformStatus']);
  const lutSyncStatus = getColorStringField(hostSummary, ['lutSyncStatus']);
  const repairTemplateStatus = getColorStringField(hostSummary, ['repairTemplateStatus']);
  const repairSeedSkippedReason = getColorStringField(hostSummary, ['repairSeedSkippedReason']);
  const portraitClipCount = Number(hostSummary?.portraitClipCount || 0);
  const timelineTransformClipCount = Number(hostSummary?.timelineTransformClipCount || 0);
  const missingOrientationTemplateCount = Number(hostSummary?.repairOrientationTemplateMissingClipCount || 0);
  if (detectedProfile) details.push(`detected: ${detectedProfile}`);
  if (effectiveProfile) details.push(`effective: ${effectiveProfile}`);
  if (resolvedPreset) details.push(`preset: ${resolvedPreset}`);
  if (lutSyncStatus) details.push(`lut: ${lutSyncStatus}`);
  if (transformStatus) details.push(`transform: ${transformStatus}`);
  if (portraitClipCount > 0) details.push(`portrait: ${portraitClipCount}`);
  if (timelineTransformClipCount > 0) details.push(`horizontal transform: ${timelineTransformClipCount}`);
  if (missingOrientationTemplateCount > 0) details.push(`missing portrait DRT: ${missingOrientationTemplateCount}`);
  if (repairTemplateStatus) details.push(`repair template: ${repairTemplateStatus}`);
  if (repairSeedSkippedReason) details.push('repair seed: 待 DRT 模板初始化');
  return details.join(' · ');
}

function describeColorGroupCreativeState(group) {
  const details = [];
  if (group?.logProfile) details.push(`log: ${group.logProfile}`);
  if (group?.lowlight) details.push(`lowlight: ${group.lowlight}`);
  if (group?.colorCastClass) details.push(`cast: ${group.colorCastClass}`);
  if (group?.postClipCreativeStatus) details.push(`post-clip: ${group.postClipCreativeStatus}`);
  return details.join(' · ');
}

function describeColorClipRepairSummary(clips) {
  if (!Array.isArray(clips) || clips.length === 0) return '';
  const gyroCounts = countBy(clips.map(clip => clip?.gyroflowStatus || ''));
  const dehazeCounts = countBy(clips.map(clip => clip?.dehazeStatus || ''));
  const nrCounts = countBy(clips.map(clip => clip?.nrStatus || ''));
  const repairCounts = countBy(clips.map(clip => clip?.clipRepairStatus || ''));
  const layoutCounts = countBy(clips.map(clip => clip?.layoutStatus || ''));
  const orientationCounts = countBy(clips.map(clip => clip?.orientationStatus || ''));
  const templateCounts = countBy(clips.map(clip => clip?.repairTemplateKey || ''));
  const details = [];
  const orientationSummary = summarizeCountMap('orientation', orientationCounts);
  const templateSummary = summarizeCountMap('template', templateCounts);
  const gyroSummary = summarizeCountMap('gyro', gyroCounts);
  const dehazeSummary = summarizeCountMap('dehaze', dehazeCounts);
  const nrSummary = summarizeCountMap('nr', nrCounts);
  const repairSummary = summarizeCountMap('repair', repairCounts);
  const layoutSummary = summarizeCountMap('layout', layoutCounts);
  if (orientationSummary) details.push(orientationSummary);
  if (templateSummary) details.push(templateSummary);
  if (gyroSummary) details.push(gyroSummary);
  if (dehazeSummary) details.push(dehazeSummary);
  if (nrSummary) details.push(nrSummary);
  if (repairSummary) details.push(repairSummary);
  if (layoutSummary) details.push(layoutSummary);
  return details.join(' · ');
}

function describeColorClipRepairState(clip) {
  const details = [];
  if (clip?.logProfile) details.push(`log: ${clip.logProfile}`);
  if (typeof clip?.lowlight === 'boolean') details.push(clip.lowlight ? 'lowlight' : 'base');
  if (clip?.colorCastClass) {
    const confidence = Number.isFinite(Number(clip.colorCastConfidence))
      ? ` ${Math.round(Number(clip.colorCastConfidence) * 100)}%`
      : '';
    details.push(`cast: ${clip.colorCastClass}${confidence}`);
  }
  if (clip?.orientationStatus) details.push(`orientation: ${clip.orientationStatus}`);
  if (Number.isFinite(Number(clip?.rotationDegrees))) details.push(`rotation: ${clip.rotationDegrees}`);
  if (clip?.repairTemplateKey) details.push(`template: ${clip.repairTemplateKey}`);
  if (isPlainObject(clip?.timelineTransform) && Object.keys(clip.timelineTransform).length > 0) {
    const rotation = Number.isFinite(Number(clip.timelineTransform.rotationAngle))
      ? `rot ${clip.timelineTransform.rotationAngle}`
      : '';
    const zoom = Number.isFinite(Number(clip.timelineTransform.zoomX))
      ? `zoom ${clip.timelineTransform.zoomX}`
      : '';
    details.push(['horizontal transform', rotation, zoom].filter(Boolean).join(': '));
  }
  if (clip?.gyroDataAvailable === true) details.push('gyro-data');
  if (clip?.gyroEligible === true) details.push('gyro-eligible');
  if (clip?.gyroflowStatus) details.push(`gyro: ${clip.gyroflowStatus}`);
  if (clip?.gyroflowStatus === 'ready-to-load') details.push('gyro load: pending Resolve');
  if (clip?.dehazeStatus) details.push(`dehaze: ${clip.dehazeStatus}`);
  if (clip?.nrStatus) details.push(`nr: ${clip.nrStatus}`);
  if (clip?.clipRepairStatus) details.push(`repair: ${clip.clipRepairStatus}`);
  if (clip?.clipRepairStatus === 'pending-template') details.push('repair seed: 待 DRT 模板初始化');
  if (clip?.clipRepairStatus === 'pending-orientation-template') details.push('portrait DRT: 缺失，已禁用自动 Gyro');
  if (getColorStringField(clip?.hostSummary, ['repairSeedSkippedReason'])) details.push('repair seed skipped');
  if (clip?.layoutStatus) details.push(`layout: ${clip.layoutStatus}`);
  if (isPlainObject(clip?.reservedNodeIndices)) {
    const userStart = Number(clip.reservedNodeIndices.userStart);
    const userEnd = Number(clip.reservedNodeIndices.userEnd);
    if (Number.isFinite(userStart) && Number.isFinite(userEnd) && userEnd >= userStart) {
      details.push(`user zone: ${userStart}-${userEnd}`);
    }
  }
  return details.join(' · ');
}

function countBy(values) {
  const counts = new Map();
  for (const value of values) {
    const normalized = String(value || '').trim();
    if (!normalized) continue;
    counts.set(normalized, (counts.get(normalized) || 0) + 1);
  }
  return counts;
}

function summarizeCountMap(label, counts) {
  if (!(counts instanceof Map) || counts.size === 0) return '';
  return `${label}: ${[...counts.entries()].map(([key, value]) => `${key}×${value}`).join(' / ')}`;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function areStringRecordsEqual(left, right) {
  const leftKeys = Object.keys(left || {});
  const rightKeys = Object.keys(right || {});
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every(key => String(left?.[key] ?? '') === String(right?.[key] ?? ''));
}

function formatClockOffsetMs(value) {
  if (value == null || !Number.isFinite(value) || value === 0) return '';
  const sign = value < 0 ? '-' : '+';
  const totalSeconds = Math.round(Math.abs(value) / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${sign}${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function parseClockOffsetInput(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return undefined;
  const match = trimmed.match(/^([+-])?(\d{1,2}):(\d{2})(?::(\d{2}))?$/u);
  if (!match) return null;
  const sign = match[1] === '-' ? -1 : 1;
  const hours = Number(match[2] || '0');
  const minutes = Number(match[3] || '0');
  const seconds = Number(match[4] || '0');
  if (minutes >= 60 || seconds >= 60) return null;
  return sign * ((((hours * 60) + minutes) * 60) + seconds) * 1000;
}

function formatIngestRootAnchor(anchor) {
  if (!anchor) return '';
  const sortTime = anchor.sortCapturedAt || anchor.capturedAt || '';
  if (!sortTime) return anchor.displayName || anchor.assetId || '';
  if (anchor.capturedAt && anchor.sortCapturedAt && anchor.capturedAt !== anchor.sortCapturedAt) {
    return `${anchor.displayName} | ${anchor.capturedAt} -> ${anchor.sortCapturedAt}`;
  }
  return `${anchor.displayName} | ${sortTime}`;
}

export function splitLines(value) {
  return value.split('\n').map(item => item.trim()).filter(Boolean);
}

export function splitComma(value) {
  return value.split(',').map(item => item.trim()).filter(Boolean);
}

export function splitList(value) {
  return value.split('/').map(item => item.trim()).filter(Boolean);
}

function applyCaptureTimeAction(items, index, partial, apply) {
  const next = [...items];
  next[index] = {
    ...next[index],
    ...partial,
  };
  apply(next);
}

function buildSuggestedOverride(item) {
  return {
    correctedDate: item.suggestedDate || item.correctedDate || '',
    correctedTime: item.suggestedTime || item.correctedTime || '',
    timezone: item.timezone || '',
  };
}

function buildManualStartOverride(item) {
  return {
    timezone: item.timezone || 'UTC',
  };
}

function buildKeepCurrentOverride(item) {
  const current = deriveCurrentLocalDateTime(item.currentCapturedAt, item.timezone || 'UTC');
  if (!current) {
    return {};
  }
  return {
    correctedDate: current.date,
    correctedTime: current.time,
    timezone: current.timezone,
  };
}

function suggestedDatePlaceholder(item) {
  if (item.suggestedDate) return item.suggestedDate;
  const current = deriveCurrentLocalDateTime(item.currentCapturedAt, item.timezone);
  if (current?.date) {
    return `自动补齐 ${current.date}`;
  }
  return '无法自动推导时再填写';
}

function requiresExplicitDate(item) {
  if (!normalizeCaptureTime(item.correctedTime)) return false;
  return !item.correctedDate && !item.suggestedDate && !deriveCurrentLocalDateTime(item.currentCapturedAt, item.timezone);
}

function normalizeCaptureTime(value) {
  const trimmed = String(value || '').trim();
  if (/^\d{2}:\d{2}$/u.test(trimmed)) return `${trimmed}:00`;
  return /^\d{2}:\d{2}:\d{2}$/u.test(trimmed) ? trimmed : '';
}

function deriveCurrentLocalDateTime(currentCapturedAt, timeZone) {
  if (!currentCapturedAt) return null;
  const date = new Date(currentCapturedAt);
  if (Number.isNaN(date.getTime())) return null;
  const effectiveTimeZone = String(timeZone || '').trim() || 'UTC';
  try {
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: effectiveTimeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
    const parts = new Map(formatter.formatToParts(date).map(part => [part.type, part.value]));
    const year = parts.get('year');
    const month = parts.get('month');
    const day = parts.get('day');
    const hour = parts.get('hour');
    const minute = parts.get('minute');
    const second = parts.get('second');
    if (!year || !month || !day || !hour || !minute || !second) return null;
    return {
      date: `${year}-${month}-${day}`,
      time: `${hour}:${minute}:${second}`,
      timezone: effectiveTimeZone,
    };
  } catch {
    return null;
  }
}

function updateReviewField(reviews, reviewId, fieldKey, value, setReviews) {
  setReviews(reviews.map(review => (
    review.id === reviewId
      ? {
        ...review,
        fields: review.fields.map(field => field.key === fieldKey ? { ...field, value } : field),
      }
      : review
  )));
}

function updateReviewNote(reviews, reviewId, note, setReviews) {
  setReviews(reviews.map(review => (
    review.id === reviewId
      ? { ...review, note }
      : review
  )));
}

function updateArrayItem(items, index, nextItem, apply) {
  const next = [...items];
  next[index] = nextItem;
  apply(next);
}

function replaceArrayItem(items, index, nextItem) {
  return items.map((item, itemIndex) => itemIndex === index ? nextItem : item);
}

function moveArrayItem(items, fromIndex, toIndex) {
  if (toIndex < 0 || toIndex >= items.length || fromIndex === toIndex) return items;
  const next = [...items];
  const [item] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, item);
  return next;
}

function removeArrayItem(items, index, apply) {
  apply(items.filter((_, currentIndex) => currentIndex !== index));
}

function updateNestedArrayItem(items, index, nestedKey, nestedIndex, nextItem, apply) {
  const next = [...items];
  const current = next[index];
  next[index] = {
    ...current,
    [nestedKey]: current[nestedKey].map((item, itemIndex) => itemIndex === nestedIndex ? nextItem : item),
  };
  apply(next);
}

function removeNestedArrayItem(items, index, nestedKey, nestedIndex, apply) {
  const next = [...items];
  const current = next[index];
  next[index] = {
    ...current,
    [nestedKey]: current[nestedKey].filter((_, itemIndex) => itemIndex !== nestedIndex),
  };
  apply(next);
}

function noop() {}

function describeScriptWorkflowState(workflowState) {
  return SCRIPT_WORKFLOW_STATUS_TEXT[workflowState] || SCRIPT_WORKFLOW_STATUS_TEXT.choose_style;
}

function computeScriptBriefFingerprint(config) {
  const payload = {
    goalDraft: normalizeFingerprintLines(config.goalDraft),
    constraintDraft: normalizeFingerprintLines(config.constraintDraft),
    planReviewDraft: normalizeFingerprintLines(config.planReviewDraft),
    segments: (config.segments || []).map(segment => ({
      segmentId: String(segment.segmentId || '').trim(),
      title: String(segment.title || '').trim() || undefined,
      roleHint: String(segment.roleHint || '').trim() || undefined,
      targetDurationMs: Number(segment.targetDurationMs) > 0 ? Number(segment.targetDurationMs) : undefined,
      intent: String(segment.intent || '').trim() || undefined,
      notes: normalizeFingerprintLines(segment.notes),
    })),
  };
  return hashScriptBriefFingerprintPayload(JSON.stringify(payload));
}

function normalizeFingerprintLines(values) {
  return (values || [])
    .map(value => String(value || '').trim())
    .filter(Boolean);
}

function hashScriptBriefFingerprintPayload(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a:${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

const SCRIPT_WORKFLOW_STATUS_TEXT = {
  choose_style: '请先在 /script 选择剪辑规则。',
  await_brief_draft: '剪辑规则已保存，请回到 Agent 生成 material-overview.md 和初版 brief。',
  review_brief: '初版 overview / brief 已生成，请在 /script 审查并保存。',
  ready_to_prepare: 'brief 已保存，请点击 准备给 Agent。',
  ready_for_agent: '事实刷新与 bundle 索引已完成，请回到 Agent 继续生成当前 edit unit 的 segment-plan、material-slots 与 script/current。',
  script_generated: '脚本已生成，可继续审稿或进入 Timeline。',
};
