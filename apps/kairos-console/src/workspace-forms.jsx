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

export function IngestRootClockEditor({ config, summaries = [], setConfig, onSave, busy }) {
  const roots = config?.roots || [];
  const [drafts, setDrafts] = React.useState({});

  React.useEffect(() => {
    setDrafts(Object.fromEntries(
      roots.map(root => [root.id, formatClockOffsetMs(root.clockOffsetMs)]),
    ));
  }, [roots]);

  if (!config) return null;

  const summariesByRootId = new Map(summaries.map(item => [item.rootId, item]));

  function commitClockOffset(rootId) {
    const draft = drafts[rootId] ?? '';
    const parsed = parseClockOffsetInput(draft);
    const root = roots.find(item => item.id === rootId);
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
      roots: current.roots.map(item => item.id === rootId
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
        <p className="muted">当前还没有可维护的 ingest roots。</p>
      ) : null}
      {roots.map(root => {
        const summary = summariesByRootId.get(root.id);
        const draftValue = drafts[root.id] ?? formatClockOffsetMs(root.clockOffsetMs);
        return (
          <div key={root.id} className="row-card">
            <div className="row-top">
              <div>
                <strong>{root.label || root.id}</strong>
                <div className="muted capture-time-reason">{root.id}</div>
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
                    [root.id]: event.target.value,
                  }))}
                  onBlur={() => commitClockOffset(root.id)}
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
  setIngestRoots,
  onSaveProjectRoots,
  busy = {},
  onRunColorAction,
  onRequestHostPreflight,
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
      .filter(job => ['queued', 'running', 'blocked'].includes(job.status)),
    [jobs, projectId],
  );
  const liveColorJobs = React.useMemo(
    () => colorJobs.filter(job => ['queued', 'running'].includes(job.status)),
    [colorJobs],
  );
  const capabilityLabel = capability?.supported === false
    ? 'blocked'
    : capability
      ? 'supported'
      : 'unknown';
  const [promoteDialog, setPromoteDialog] = React.useState(null);
  const [sectionOpen, setSectionOpen] = React.useState({});

  React.useEffect(() => {
    if (!projectId || typeof onRequestHostPreflight !== 'function') return;
    onRequestHostPreflight({}, { silent: true });
  }, [projectId]);

  return (
    <Card className="panel">
      <div className="section-header">
        <h2>Color Roots</h2>
        <Tag>{capabilityLabel}</Tag>
      </div>
      <p className="muted">
        {'当前优先消费 `config.colorRoots`。长期配置只保留项目 root 上的 `color.renderPreset`；/color 现在是 Resolve Groups 的镜像、执行、校验和 Promote 面板，推荐顺序是 `Prepare Root -> Sync Groups -> Execute -> Validate -> Promote`。'}
      </p>
      {colorJobs.length > 0 ? (
        <>
          <Divider />
          <div className="stack-list">
            {colorJobs.map(job => (
              <div key={job.jobId} className="job-item">
                <div>
                  <strong>{getColorJobRootId(job) || job.jobId}</strong>
                  <div className="muted">{job.progress?.stepLabel || job.progress?.detail || job.status}</div>
                </div>
                <Tag>{job.status}</Tag>
              </div>
            ))}
          </div>
        </>
      ) : null}
      <Divider />
      <div className="stack-list">
        {rootCards.length > 0 ? (
          rootCards.map(root => {
            const rootArchive = archiveByRootId[root.rootId] || {
              rootId: root.rootId,
              recentBatches: [],
              validationFailures: [],
              promoteHistory: [],
            };
            const preflightBusy = busy?.[`color:preflight:${root.rootId}`] || busy?.['color:preflight'];
            return (
              <div key={root.key} className="row-card">
                <div className="row-top">
                  <div>
                    <strong>{root.rootId}</strong>
                    <div className="muted capture-time-reason">{root.description || '未填写 description'}</div>
                  </div>
                  <div className="actions">
                    <div className="capture-time-tags">
                      <Tag>{root.pathText}</Tag>
                      <Tag>{root.renderPresetSummary}</Tag>
                      {root.hostPreflight?.status ? <Tag>{`host ${root.hostPreflight.status}`}</Tag> : null}
                      {root.blockerCountText ? <Tag>{root.blockerCountText}</Tag> : null}
                    </div>
                    <Button
                      type={busy?.['ingest-roots'] ? 'disabled' : 'default'}
                      disabled={busy?.['ingest-roots'] || typeof onSaveProjectRoots !== 'function'}
                      onClick={() => onSaveProjectRoots?.()}
                    >
                      {busy?.['ingest-roots'] ? '保存中…' : '保存 Root 配置'}
                    </Button>
                    <Button
                      type={preflightBusy ? 'disabled' : 'default'}
                      disabled={preflightBusy || typeof onRequestHostPreflight !== 'function'}
                      onClick={() => onRequestHostPreflight?.({ rootId: root.rootId })}
                    >
                      {preflightBusy ? '检查中…' : 'Recheck Host'}
                    </Button>
                    <Button
                      type={canRunColorRootAction('prepare_root', root, capability, liveColorJobs, busy, onRunColorAction) ? 'primary' : 'disabled'}
                      disabled={!canRunColorRootAction('prepare_root', root, capability, liveColorJobs, busy, onRunColorAction)}
                      onClick={() => onRunColorAction?.({ rootId: root.rootId, action: 'prepare_root' })}
                    >
                      {describeColorRootAction('prepare_root', root, liveColorJobs, busy)}
                    </Button>
                    <Button
                      type={canRunColorRootAction('sync_groups', root, capability, liveColorJobs, busy, onRunColorAction) ? 'default' : 'disabled'}
                      disabled={!canRunColorRootAction('sync_groups', root, capability, liveColorJobs, busy, onRunColorAction)}
                      onClick={() => onRunColorAction?.({ rootId: root.rootId, action: 'sync_groups' })}
                    >
                      {describeColorRootAction('sync_groups', root, liveColorJobs, busy)}
                    </Button>
                  </div>
                </div>
              <div className="field-grid field-grid-three">
                <Field label="path" value={root.path || ''} onChange={noop} readOnly />
                <Field label="localPath" value={root.localPath || ''} onChange={noop} readOnly />
                <Field label="rawPath" value={root.rawPath || ''} onChange={noop} readOnly />
                <Field label="rawLocalPath" value={root.rawLocalPath || ''} onChange={noop} readOnly />
                <Field label="resolveProjectName" value={root.resolveProjectName || ''} onChange={noop} readOnly />
                <Field label="rootNamespace" value={root.rootNamespace || ''} onChange={noop} readOnly />
                <Field label="gradingTimelineName" value={root.gradingTimelineName || ''} onChange={noop} readOnly />
                <Field
                  label="container"
                  value={root.renderPreset.container || ''}
                  onChange={value => updateProjectRootRenderPreset(setIngestRoots, root.rootId, { container: value })}
                  disabled={busy?.['ingest-roots']}
                />
                <Field
                  label="videoCodec"
                  value={root.renderPreset.videoCodec || ''}
                  onChange={value => updateProjectRootRenderPreset(setIngestRoots, root.rootId, { videoCodec: value })}
                  disabled={busy?.['ingest-roots']}
                />
                <Field
                  label="audioCodec"
                  value={root.renderPreset.audioCodec || ''}
                  onChange={value => updateProjectRootRenderPreset(setIngestRoots, root.rootId, { audioCodec: value })}
                  disabled={busy?.['ingest-roots']}
                />
                <Field
                  label="bitrateMbps"
                  type="number"
                  step="0.1"
                  inputMode="decimal"
                  value={formatColorBitrateInput(root.bitrateMbps)}
                  onChange={value => updateProjectRootRenderPreset(setIngestRoots, root.rootId, { bitrateMbps: value })}
                  disabled={busy?.['ingest-roots']}
                />
              </div>
              <p className="field-help">
                `resolveProjectName / rootNamespace / gradingTimelineName` 全部按约定生成。`Prepare Root` 会真正同步 Media Pool / grading timeline，并按技术信号生成或复用 Resolve Groups。
              </p>
              <div className="capture-time-hint">
                {root.blockers.length > 0
                  ? '以下 blocker 是该 root 的主要阻塞条件。'
                  : '当前没有显式 blocker。'}
              </div>
              <div className="capture-time-tags">
                {root.blockers.length > 0 ? root.blockers.map((blocker, index) => (
                  <Tag key={`${root.key}:blocker:${index}`}>{blocker}</Tag>
                )) : <Tag>no blockers</Tag>}
              </div>
              <Divider />
              <div className="monitor-stage-grid">
                {[
                  ['timeline', 'Timeline'],
                  ['mirror', 'Media Pool / Mirror'],
                  ['groupSync', 'Group Sync'],
                  ['batch', 'Batch'],
                ].map(([key, label]) => {
                  const summary = summarizeColorStatusNode(
                    key === 'groupSync'
                      ? root.current?.groupSyncStatus
                      : root.current?.[key] ?? root.current?.[`${key}Status`] ?? root.current?.[`${key}State`] ?? root.current?.[`${key}Phase`],
                  );
                  return (
                    <div key={`${root.key}:${key}`} className="monitor-stage-card">
                      <div className="monitor-stage-head">
                        <strong>{label}</strong>
                        <Tag>{summary.status}</Tag>
                      </div>
                      <div className="muted">{summary.summary}</div>
                    </div>
                  );
                })}
              </div>
              <Divider />
              <div className="stack-list">
                {root.groups.length > 0 ? root.groups.map(group => (
                  <div key={`${root.key}:${group.groupKey}`} className="job-item">
                    <div>
                      <strong>{group.displayName}</strong>
                      <div className="muted">{`${group.groupKey} · ${group.clipCount} clips · latest ${group.current?.latestBatchId || 'none'} · validation ${group.current?.latestValidationStatus || 'pending'}`}</div>
                      {describeColorTechnicalSignals(group.hostSummary) ? (
                        <div className="muted">{describeColorTechnicalSignals(group.hostSummary)}</div>
                      ) : null}
                    </div>
                    <div className="actions">
                      <Tag>{group.current?.status || 'ready'}</Tag>
                      <Button
                        type={canRunColorGroupAction('execute_group', root, group, capability, liveColorJobs, busy, onRunColorAction) ? 'default' : 'disabled'}
                        disabled={!canRunColorGroupAction('execute_group', root, group, capability, liveColorJobs, busy, onRunColorAction)}
                        onClick={() => onRunColorAction?.({ rootId: root.rootId, action: 'execute_group', groupKey: group.groupKey })}
                      >
                        {describeColorGroupAction('execute_group', group, liveColorJobs, busy)}
                      </Button>
                      <Button
                        type={canRunColorGroupAction('validate_batch', root, group, capability, liveColorJobs, busy, onRunColorAction) ? 'default' : 'disabled'}
                        disabled={!canRunColorGroupAction('validate_batch', root, group, capability, liveColorJobs, busy, onRunColorAction)}
                        onClick={() => onRunColorAction?.({ rootId: root.rootId, action: 'validate_batch', groupKey: group.groupKey, batchId: group.current?.latestBatchId })}
                      >
                        {describeColorGroupAction('validate_batch', group, liveColorJobs, busy)}
                      </Button>
                      <Button
                        type={canRunColorGroupAction('promote_batch', root, group, capability, liveColorJobs, busy, onRunColorAction) ? 'primary' : 'disabled'}
                        disabled={!canRunColorGroupAction('promote_batch', root, group, capability, liveColorJobs, busy, onRunColorAction)}
                        onClick={() => setPromoteDialog({
                          rootId: root.rootId,
                          groupKey: group.groupKey,
                          batchId: group.current?.pendingPromoteBatchId || group.current?.latestBatchId,
                        })}
                      >
                        {describeColorGroupAction('promote_batch', group, liveColorJobs, busy)}
                      </Button>
                    </div>
                  </div>
                )) : <p className="muted">当前还没有已同步的正式 Groups。先运行 `Prepare Root`，如你在 Resolve 里做了调整，再执行一次 `Sync Groups`。</p>}
              </div>
              <Divider />
              <ColorRootArchivePanels
                root={root}
                archive={rootArchive}
                sectionOpen={sectionOpen}
                setSectionOpen={setSectionOpen}
              />
              {root.current?.detail ? <p className="field-help">{root.current.detail}</p> : null}
            </div>
            );
          })
        ) : (
          <p className="muted">当前还没有可展示的 color root。</p>
        )}
      </div>
      <Modal
        show={Boolean(promoteDialog)}
        title="确认 Promote"
        showClose
        closeOnClickBg
        cancel={() => setPromoteDialog(null)}
        actions={(
          <div className="actions modal-actions">
            <Button type="default" onClick={() => setPromoteDialog(null)}>
              取消
            </Button>
            <Button
              type="primary"
              onClick={() => {
                const dialog = promoteDialog;
                setPromoteDialog(null);
                if (!dialog?.rootId || !dialog?.batchId) return;
                onRunColorAction?.({
                  rootId: dialog.rootId,
                  action: 'promote_batch',
                  groupKey: dialog.groupKey,
                  batchId: dialog.batchId,
                });
              }}
            >
              确认 Promote
            </Button>
          </div>
        )}
      >
        <div className="modal-copy">
          <p>这一步会把当前 batch 的受管输出覆盖回当前素材目录。</p>
          <p>它不会触碰 `rawPath`，也只会作用于这个 Group manifest 声明的覆盖范围。</p>
        </div>
      </Modal>
    </Card>
  );
}

function ColorRootArchivePanels({ root, archive, sectionOpen, setSectionOpen }) {
  const hostSectionKey = `${root.rootId}:host`;
  const recentSectionKey = `${root.rootId}:recent`;
  const failuresSectionKey = `${root.rootId}:failures`;
  const promoteSectionKey = `${root.rootId}:promote`;
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
      defaultOpen: true,
      body: renderColorRecentBatches(archive?.recentBatches),
    },
    {
      key: failuresSectionKey,
      title: 'Validation Failures',
      defaultOpen: validationDefaultOpen,
      body: renderColorValidationFailures(archive?.validationFailures),
    },
    {
      key: promoteSectionKey,
      title: 'Promote History',
      defaultOpen: false,
      body: renderColorPromoteHistory(archive?.promoteHistory),
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
            onToggle={event => setSectionOpen(current => ({
              ...(isPlainObject(current) ? current : {}),
              [section.key]: Boolean(event.currentTarget.open),
            }))}
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
        <div className="muted">{`${item.groupKey} · ${item.plan?.createdAt || 'unknown time'}`}</div>
        <div className="muted">
          {`targets ${item.plan?.entries?.length || 0} · validation ${item.validation?.status || 'pending'} · promote ${item.promote?.status || 'none'}`}
        </div>
      </div>
      <Tag>{item.validation?.status || item.promote?.status || 'planned'}</Tag>
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
          <div className="muted">{`${item.groupKey} · ${item.validation?.validatedAt || 'unknown time'}`}</div>
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
        {` · ${item.groupKey} · ${item.promote?.promotedAt || 'unknown time'} · ${item.promote?.status || 'completed'} · outputs ${item.promote?.outputs?.length || 0} · deleted ${item.promote?.deletedOutputs?.length || 0}`}
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
  const projectRoots = Array.isArray(config?.ingestRoots?.roots)
    ? config.ingestRoots.roots.filter(isPlainObject)
    : [];
  const projectRootById = new Map(projectRoots.map(root => [String(root.id || root.rootId), root]));

  if (readModelRoots.length > 0) {
    return readModelRoots.map((root, index) => {
      const projectRoot = projectRootById.get(String(root.rootId || getColorRootId(root, index)));
      const renderPreset = materializeProjectRootRenderPreset(projectRoot?.color?.renderPreset || root.renderPreset);
      const current = materializeColorRootCurrent(isPlainObject(root.colorCurrent) ? root.colorCurrent : null);
      const hostPreflight = materializeColorHostPreflight(root.hostPreflight || current?.hostPreflight);
      const blockers = normalizeColorBlockers(root.blockingReasons || current?.blockingReasons);
      return {
        key: String(root.rootId || getColorRootId(root, index)),
        rootId: String(root.rootId || getColorRootId(root, index)),
        description: getColorStringField(root, ['description']) || getColorRootLabel(root, index),
        path: getColorStringField(root, ['path']),
        localPath: getColorStringField(root, ['localPath']),
        rawPath: getColorStringField(root, ['rawPath']),
        rawLocalPath: getColorStringField(root, ['rawLocalPath']),
        resolveProjectName: getColorStringField(root, ['resolveProjectName']),
        rootNamespace: getColorStringField(root, ['rootNamespace']),
        gradingTimelineName: getColorStringField(root, ['gradingTimelineName']),
        renderPreset,
        bitrateMbps: renderPreset.bitrateMbps,
        renderPresetSummary: describeColorRenderPreset(renderPreset, renderPreset.bitrateMbps),
        pathText: [
          getColorStringField(root, ['path']) || 'no path',
          getColorStringField(root, ['rawPath']) || 'no rawPath',
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

  return projectRoots
    .filter(root => getColorStringField(root, ['rawPath']))
    .map((root, index) => {
      const renderPreset = materializeProjectRootRenderPreset(root.color?.renderPreset);
      return {
        key: String(root.id || `root-${index + 1}`),
        rootId: String(root.id || `root-${index + 1}`),
        description: getColorStringField(root, ['description']) || getColorRootLabel(root, index),
        path: getColorStringField(root, ['path']),
        localPath: '',
        rawPath: getColorStringField(root, ['rawPath']),
        rawLocalPath: '',
        resolveProjectName: '',
        rootNamespace: '',
        gradingTimelineName: '',
        renderPreset,
        bitrateMbps: renderPreset.bitrateMbps,
        renderPresetSummary: describeColorRenderPreset(renderPreset, renderPreset.bitrateMbps),
        pathText: [
          getColorStringField(root, ['path']) || 'no path',
          getColorStringField(root, ['rawPath']) || 'no rawPath',
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
    bitrateMbps: normalizeColorBitrateValue(renderPreset?.bitrateMbps ?? renderPreset?.bitrate),
  };
}

function updateProjectRootRenderPreset(setIngestRoots, rootId, patch) {
  if (typeof setIngestRoots !== 'function' || !rootId) return;
  setIngestRoots(current => {
    const config = isPlainObject(current) ? current : {};
    const roots = Array.isArray(config.roots)
      ? config.roots.filter(isPlainObject)
      : [];
    const index = roots.findIndex(root => String(root.id || root.rootId) === String(rootId));
    if (index < 0) {
      return config;
    }
    const existingRoot = roots[index];
    const existingPreset = materializeProjectRootRenderPreset(existingRoot.color?.renderPreset);
    const nextPreset = {
      container: normalizeColorOptionalString(patch?.container) || existingPreset.container || 'mp4',
      videoCodec: normalizeColorOptionalString(patch?.videoCodec) || existingPreset.videoCodec || 'h265',
      audioCodec: normalizeColorOptionalString(patch?.audioCodec) || existingPreset.audioCodec || 'aac',
      bitrateMbps: Object.prototype.hasOwnProperty.call(patch || {}, 'bitrateMbps')
        ? normalizeColorBitrateValue(patch?.bitrateMbps)
        : existingPreset.bitrateMbps,
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
      roots: nextRoots,
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
  if (config.rawPath || config.rawLocalPath || config.renderPreset || config.bitrate) {
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
  const bitrateMbps = getColorRenderPresetBitrate(rootConfig);
  const blockers = normalizeColorBlockers(root?.blockingReasons || rootConfig?.blockingReasons || rootCurrent?.blockingReasons)
    .filter(blocker => {
      if (configuredGroups.length > 0 && blocker.includes('当前还没有已确认的 Resolve Group')) {
        return false;
      }
      if (bitrateMbps && blocker.includes('未配置 root 级目标码率')) {
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
    bitrateMbps,
    assetCountText: Number.isFinite(assetCount) ? `${assetCount} assets` : 'assets unknown',
    pathText: [path || 'no path', localPath || 'no localPath'].filter(Boolean).join(' · '),
    renderPresetSummary: describeColorRenderPreset(getColorRenderPreset(rootConfig), bitrateMbps),
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
  }).filter(Boolean);
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
  return renderPreset?.bitrateMbps || renderPreset?.bitrate || root?.bitrateMbps || root?.bitrate || root?.renderBitrate || '';
}

function describeColorRenderPreset(renderPreset, bitrate) {
  const parts = [
    getColorStringField(renderPreset, ['container']),
    getColorStringField(renderPreset, ['videoCodec', 'videoCodecName']),
    getColorStringField(renderPreset, ['audioCodec', 'audioCodecName']),
  ].filter(Boolean);
  if (bitrate) {
    parts.push(`bitrate ${bitrate}`);
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
    hostSummary: isPlainObject(group?.hostSummary) ? group.hostSummary : {},
    current: {
      ...current,
      latestBatchId: getColorStringField(current, ['latestBatchId', 'batchId']) || '',
      latestValidationStatus: getColorStringField(current, ['latestValidationStatus']) || '',
      pendingPromoteBatchId: getColorStringField(current, ['pendingPromoteBatchId']) || '',
      status: getColorStringField(current, ['status', 'state', 'phase']) || 'ready',
    },
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
  const pendingPromoteGroupKey = getColorStringField(current, ['pendingPromoteGroupKey']);
  const pendingPromoteBatchId = getColorStringField(current, ['pendingPromoteBatchId']);
  if (isPlainObject(current?.batch)) {
    return current.batch;
  }
  if (pendingPromoteGroupKey && (pendingPromoteBatchId || latestBatchId)) {
    return {
      status: 'staged',
      batchId: pendingPromoteBatchId || latestBatchId,
      groupKey: pendingPromoteGroupKey,
      summary: `待 promote · ${pendingPromoteGroupKey}`,
    };
  }
  if (latestBatchId) {
    return {
      status: 'ready',
      batchId: latestBatchId,
      summary: `latest ${latestBatchId}`,
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
      bitrateMbps: normalizeColorBitrateValue(
        renderPreset.bitrateMbps ?? renderPreset.bitrate ?? root?.bitrateMbps,
      ),
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
  const hasDirectBitrate = Object.prototype.hasOwnProperty.call(nextPatch, 'bitrateMbps');
  const hasRenderPresetBitrate = Object.prototype.hasOwnProperty.call(nextRenderPreset, 'bitrateMbps')
    || Object.prototype.hasOwnProperty.call(nextRenderPreset, 'bitrate');
  return {
    rootId: normalizeColorOptionalString(nextPatch.rootId) || rootConfig.rootId,
    resolveProjectName: normalizeColorOptionalString(nextPatch.resolveProjectName) ?? rootConfig.resolveProjectName,
    rootNamespace: normalizeColorOptionalString(nextPatch.rootNamespace) ?? rootConfig.rootNamespace,
    gradingTimelineName: normalizeColorOptionalString(nextPatch.gradingTimelineName) ?? rootConfig.gradingTimelineName,
    renderPreset: {
      container: normalizeColorOptionalString(nextRenderPreset.container) || rootConfig.renderPreset?.container || 'mp4',
      videoCodec: normalizeColorOptionalString(nextRenderPreset.videoCodec ?? nextRenderPreset.videoCodecName) || rootConfig.renderPreset?.videoCodec || 'h265',
      audioCodec: normalizeColorOptionalString(nextRenderPreset.audioCodec ?? nextRenderPreset.audioCodecName) || rootConfig.renderPreset?.audioCodec || 'aac',
      bitrateMbps: hasDirectBitrate
        ? normalizeColorBitrateValue(nextPatch.bitrateMbps)
        : hasRenderPresetBitrate
          ? normalizeColorBitrateValue(nextRenderPreset.bitrateMbps ?? nextRenderPreset.bitrate)
          : normalizeColorBitrateValue(rootConfig.renderPreset?.bitrateMbps),
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
  return getColorStringField(job?.args, ['rootId']) || getColorStringField(job, ['rootId']);
}

function getColorJobAction(job) {
  return getColorStringField(job?.args, ['action']) || 'prepare_root';
}

function hasLiveColorJobForRoot(liveJobs, rootId, action) {
  return (liveJobs || []).some(job => (
    String(getColorJobRootId(job)) === String(rootId)
      && (!action || getColorJobAction(job) === action)
  ));
}

function canRunColorRootAction(action, root, capability, liveJobs, busy, onRunColorAction) {
  if (typeof onRunColorAction !== 'function') return false;
  if (capability?.supported === false) return false;
  if (busy?.['ingest-roots']) return false;
  if (busy?.['job:color']) return false;
  if (getColorStringField(root.hostPreflight, ['status']) === 'blocked') return false;
  if (action === 'sync_groups' && getColorStringField(root.current, ['timelineStatus']) !== 'ready') return false;
  return (liveJobs || []).length === 0;
}

function describeColorRootAction(action, root, liveJobs, busy) {
  if (busy?.['ingest-roots']) {
    return '保存中…';
  }
  if (busy?.['job:color']) {
    return '启动中…';
  }
  if (hasLiveColorJobForRoot(liveJobs, root.rootId, action)) {
    return action === 'sync_groups' ? '同步中…' : '准备中…';
  }
  if ((liveJobs || []).length > 0) {
    return '等待当前 color job…';
  }
  if (action === 'sync_groups') {
    return getColorStringField(root.current, ['groupSyncStatus']) === 'ready' ? '重同步 Groups' : 'Sync Groups';
  }
  const mirrorReady = ['ready', 'synced'].includes(getColorStringField(root.current, ['mirrorStatus']));
  const timelineReady = getColorStringField(root.current, ['timelineStatus']) === 'ready';
  return mirrorReady && timelineReady ? '重跑 Prep' : '准备 Root';
}

function canRunColorGroupAction(action, root, group, capability, liveJobs, busy, onRunColorAction) {
  if (typeof onRunColorAction !== 'function') return false;
  if (capability?.supported === false) return false;
  if (busy?.['job:color']) return false;
  if ((liveJobs || []).length > 0) return false;
  if (getColorStringField(root.hostPreflight, ['status']) === 'blocked') return false;
  if (action === 'execute_group') return group.clipCount > 0;
  if (action === 'validate_batch') return Boolean(group.current?.latestBatchId);
  if (action === 'promote_batch') {
    return group.clipCount > 0 && Boolean(group.current?.pendingPromoteBatchId || (
      group.current?.latestBatchId && group.current?.latestValidationStatus === 'pass'
    ));
  }
  return false;
}

function describeColorGroupAction(action, group, liveJobs, busy) {
  if (busy?.['job:color']) return '启动中…';
  if ((liveJobs || []).some(job => getColorJobAction(job) === action)) {
    if (action === 'execute_group') return '执行中…';
    if (action === 'validate_batch') return '校验中…';
    if (action === 'promote_batch') return '覆盖中…';
  }
  if (action === 'execute_group') return group.current?.latestBatchId ? '重新 Execute' : 'Execute';
  if (action === 'validate_batch') return 'Validate';
  if (action === 'promote_batch') return 'Promote';
  return action;
}

function describeColorTechnicalSignals(hostSummary) {
  const signals = isPlainObject(hostSummary?.signals) ? hostSummary.signals : null;
  if (!signals) return '';
  return Object.entries(signals)
    .map(([key, value]) => {
      const label = key === 'logProfile'
        ? 'log'
        : key === 'cameraModel'
          ? 'camera'
          : key;
      const rendered = Array.isArray(value)
        ? value.join(' / ')
        : typeof value === 'string' || typeof value === 'number'
          ? String(value)
          : '';
      return rendered ? `${label}: ${rendered}` : '';
    })
    .filter(Boolean)
    .join(' · ');
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
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
