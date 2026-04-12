import React from 'react';
import { Button, Card, Divider, Modal, Tag } from 'hana-ui';

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

export function ProjectBriefEditor({ config, pharosStatus, setConfig, onSave, busy }) {
  if (!config) return null;
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
      <SectionHeader title="Project Brief" onSave={onSave} busy={busy} />
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
        title="素材 Root"
        onAdd={() => setConfig(current => ({
          ...current,
          mappings: [...current.mappings, { path: '', description: '', flightRecordPath: '' }],
        }))}
      />
      {config.mappings.map((mapping, index) => (
        <div key={`project-brief-mapping-${index}`} className="row-card">
          <div className="field-grid field-grid-three">
            <Field
              label="路径"
              value={mapping.path}
              onChange={value => updateArrayItem(config.mappings, index, { ...mapping, path: value }, next => setConfig(current => ({ ...current, mappings: next })))}
            />
            <Field
              label="说明"
              value={mapping.description}
              onChange={value => updateArrayItem(config.mappings, index, { ...mapping, description: value }, next => setConfig(current => ({ ...current, mappings: next })))}
            />
            <Field
              label="FlightRecord"
              value={mapping.flightRecordPath || ''}
              onChange={value => updateArrayItem(config.mappings, index, { ...mapping, flightRecordPath: value }, next => setConfig(current => ({ ...current, mappings: next })))}
            />
          </div>
          <Button
            type="error"
            size="small"
            onClick={() => removeArrayItem(config.mappings, index, next => setConfig(current => ({ ...current, mappings: next })))}
          >
            删除
          </Button>
        </div>
      ))}
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
  styleSources,
  setConfig,
  onSave,
  onStyleCategoryChange,
  onRequestRegenerate,
  busy,
  autoSaveBusy = false,
  regenerateBusy = false,
}) {
  const [showOverwriteModal, setShowOverwriteModal] = React.useState(false);
  if (!config) return null;
  const categories = styleSources?.categories || [];
  const workflowState = config.workflowState || 'choose_style';
  const hasValidStyleCategory = !config.styleCategory
    || categories.some(category => category.categoryId === config.styleCategory);
  const canEditBrief = workflowState !== 'choose_style' && workflowState !== 'await_brief_draft';
  const canRequestRegenerate = workflowState === 'review_brief' || workflowState === 'ready_to_prepare';
  const currentFingerprint = computeScriptBriefFingerprint(config);
  const userModifiedBrief = Boolean(
    config.lastAgentDraftFingerprint && currentFingerprint !== config.lastAgentDraftFingerprint,
  );
  const categoryOptions = [
    { value: '', label: '（待指定）' },
    ...categories.map(category => ({
      value: category.categoryId,
      label: category.displayName,
    })),
  ];
  if (config.styleCategory && !hasValidStyleCategory) {
    categoryOptions.unshift({
      value: config.styleCategory,
      label: `当前分类已失效：${config.styleCategory}`,
    });
  }

  function handleStyleCategoryChange(value) {
    const nextStyleCategory = value || undefined;
    const nextWorkflowState = nextStyleCategory ? 'await_brief_draft' : 'choose_style';
    setConfig(current => ({
      ...current,
      styleCategory: nextStyleCategory,
      workflowState: nextWorkflowState,
      briefOverwriteApprovedAt: undefined,
      statusText: describeScriptWorkflowState(nextWorkflowState),
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
          label="风格分类"
          value={config.styleCategory || ''}
          onChange={handleStyleCategoryChange}
          options={categoryOptions}
          disabled={autoSaveBusy || categoryOptions.length <= 1}
        />
        <Field
          label="状态"
          value={config.statusText || ''}
          onChange={() => {}}
          readOnly
        />
      </div>
      {autoSaveBusy ? (
        <p className="field-help">正在自动保存风格分类…</p>
      ) : null}
      {!autoSaveBusy ? (
        <p className="field-help">风格分类会自动保存；下面的 brief 内容仍需要手动点击“保存”。</p>
      ) : null}
      {config.styleCategory && !hasValidStyleCategory ? (
        <p className="field-help field-help-error">当前风格分类已失效，请从 workspace 风格库重新选择。</p>
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

export function Field({ label, value, onChange, readOnly = false, disabled = false, placeholder = '' }) {
  return (
    <label className="field">
      <span>{label}</span>
      <input
        value={value}
        readOnly={readOnly}
        disabled={disabled}
        placeholder={placeholder}
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
  choose_style: '请先在 /script 选择风格分类。',
  await_brief_draft: '风格已保存，请回到 Agent 生成 material-overview.md 和初版 brief。',
  review_brief: '初版 overview / brief 已生成，请在 /script 审查并保存。',
  ready_to_prepare: 'brief 已保存，请点击 准备给 Agent。',
  ready_for_agent: '事实刷新与 bundle 索引已完成，请回到 Agent 继续生成 segment-plan、material-slots 与 script/current.json。',
  script_generated: '脚本已生成，可继续审稿或进入 Timeline。',
};
