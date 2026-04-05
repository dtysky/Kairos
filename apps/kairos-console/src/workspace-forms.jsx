import React from 'react';
import { Button, Card, Divider, Tag } from 'hana-ui';

export function ProjectBriefEditor({ config, setConfig, onSave, busy }) {
  if (!config) return null;
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
          <button
            className="danger-link"
            type="button"
            onClick={() => removeArrayItem(config.mappings, index, next => setConfig(current => ({ ...current, mappings: next })))}
          >
            删除
          </button>
        </div>
      ))}
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
          <button
            className="danger-link"
            type="button"
            onClick={() => removeArrayItem(config.segments, index, next => setConfig(current => ({ ...current, segments: next })))}
          >
            删除
          </button>
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
        <p className="muted">当前没有待维护的 capture-time overrides。</p>
      ) : null}
      {config.captureTimeOverrides.map((item, index) => (
        <div key={`${item.rootRef || 'root'}:${item.sourcePath}:${index}`} className="row-card">
          <div className="row-top">
            <strong>{item.sourcePath}</strong>
            <Tag>{item.rootRef || '未标记 root'}</Tag>
          </div>
          <div className="field-grid field-grid-three">
            <Field label="当前时间" value={item.currentCapturedAt || ''} onChange={noop} readOnly />
            <Field label="当前来源" value={item.currentSource || ''} onChange={noop} readOnly />
            <Field label="建议日期" value={item.suggestedDate || ''} onChange={noop} readOnly />
            <Field label="建议时间" value={item.suggestedTime || ''} onChange={noop} readOnly />
            <Field
              label="正确日期"
              value={item.correctedDate || ''}
              onChange={value => updateArrayItem(config.captureTimeOverrides, index, { ...item, correctedDate: value }, next => setConfig(current => ({ ...current, captureTimeOverrides: next })))}
            />
            <Field
              label="正确时间"
              value={item.correctedTime || ''}
              onChange={value => updateArrayItem(config.captureTimeOverrides, index, { ...item, correctedTime: value }, next => setConfig(current => ({ ...current, captureTimeOverrides: next })))}
            />
            <Field
              label="时区"
              value={item.timezone || ''}
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

export function ScriptBriefEditor({ config, setConfig, onSave, busy }) {
  if (!config) return null;
  return (
    <Card className="panel">
      <SectionHeader title="Script Brief" onSave={onSave} busy={busy} />
      <div className="field-grid field-grid-three">
        <Field
          label="项目名"
          value={config.projectName}
          onChange={value => setConfig(current => ({ ...current, projectName: value }))}
        />
        <Field
          label="风格分类"
          value={config.styleCategory || ''}
          onChange={value => setConfig(current => ({ ...current, styleCategory: value }))}
        />
        <Field
          label="状态"
          value={config.statusText || ''}
          onChange={value => setConfig(current => ({ ...current, statusText: value }))}
        />
      </div>
      <TextAreaField
        label="全片目标（每行一条）"
        value={(config.goalDraft || []).join('\n')}
        onChange={value => setConfig(current => ({ ...current, goalDraft: splitLines(value) }))}
      />
      <TextAreaField
        label="叙事约束（每行一条）"
        value={(config.constraintDraft || []).join('\n')}
        onChange={value => setConfig(current => ({ ...current, constraintDraft: splitLines(value) }))}
      />
      <TextAreaField
        label="段落方案审查（每行一条）"
        value={(config.planReviewDraft || []).join('\n')}
        onChange={value => setConfig(current => ({ ...current, planReviewDraft: splitLines(value) }))}
      />
      <Divider />
      <ListToolbar
        title="Segment Brief"
        onAdd={() => setConfig(current => ({
          ...current,
          segments: [...current.segments, {
            segmentId: `segment-${Date.now()}`,
            title: '',
            role: 'scene',
            targetDurationMs: 30000,
            intent: '',
            preferredClipTypes: [],
            preferredPlaceHints: [],
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
              onChange={value => updateArrayItem(config.segments, index, { ...segment, segmentId: value }, next => setConfig(current => ({ ...current, segments: next })))}
            />
            <Field
              label="标题"
              value={segment.title || ''}
              onChange={value => updateArrayItem(config.segments, index, { ...segment, title: value }, next => setConfig(current => ({ ...current, segments: next })))}
            />
            <Field
              label="角色"
              value={segment.role || ''}
              onChange={value => updateArrayItem(config.segments, index, { ...segment, role: value }, next => setConfig(current => ({ ...current, segments: next })))}
            />
            <Field
              label="目标时长(ms)"
              value={String(segment.targetDurationMs || '')}
              onChange={value => updateArrayItem(config.segments, index, { ...segment, targetDurationMs: Number(value) || 0 }, next => setConfig(current => ({ ...current, segments: next })))}
            />
            <Field
              label="ClipTypes(, 分隔)"
              value={(segment.preferredClipTypes || []).join(', ')}
              onChange={value => updateArrayItem(config.segments, index, { ...segment, preferredClipTypes: splitComma(value) }, next => setConfig(current => ({ ...current, segments: next })))}
            />
            <Field
              label="PlaceHints(, 分隔)"
              value={(segment.preferredPlaceHints || []).join(', ')}
              onChange={value => updateArrayItem(config.segments, index, { ...segment, preferredPlaceHints: splitComma(value) }, next => setConfig(current => ({ ...current, segments: next })))}
            />
          </div>
          <TextAreaField
            label="Intent"
            value={segment.intent || ''}
            onChange={value => updateArrayItem(config.segments, index, { ...segment, intent: value }, next => setConfig(current => ({ ...current, segments: next })))}
          />
          <TextAreaField
            label="Notes(每行一条)"
            value={(segment.notes || []).join('\n')}
            onChange={value => updateArrayItem(config.segments, index, { ...segment, notes: splitLines(value) }, next => setConfig(current => ({ ...current, segments: next })))}
          />
          <button
            className="danger-link"
            type="button"
            onClick={() => removeArrayItem(config.segments, index, next => setConfig(current => ({ ...current, segments: next })))}
          >
            删除
          </button>
        </div>
      ))}
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
              <button
                className="danger-link"
                type="button"
                onClick={() => removeNestedArrayItem(config.categories, index, 'sources', sourceIndex, next => setConfig(current => ({ ...current, categories: next })))}
              >
                删除来源
              </button>
            </div>
          ))}
          <button
            className="danger-link"
            type="button"
            onClick={() => removeArrayItem(config.categories, index, next => setConfig(current => ({ ...current, categories: next })))}
          >
            删除分类
          </button>
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
            <Button onClick={() => onResolve(review.id)}>标记完成</Button>
          </div>
        </div>
      ))}
    </Card>
  );
}

export function SectionHeader({ title, onSave, busy }) {
  return (
    <div className="section-header">
      <h2>{title}</h2>
      <Button onClick={onSave} disabled={busy}>{busy ? '保存中…' : '保存'}</Button>
    </div>
  );
}

export function ListToolbar({ title, onAdd }) {
  return (
    <div className="list-toolbar">
      <h3>{title}</h3>
      <Button onClick={onAdd}>新增</Button>
    </div>
  );
}

export function Field({ label, value, onChange, readOnly = false, placeholder = '' }) {
  return (
    <label className="field">
      <span>{label}</span>
      <input
        value={value}
        readOnly={readOnly}
        placeholder={placeholder}
        onChange={event => onChange(event.target.value)}
      />
    </label>
  );
}

export function TextAreaField({ label, value, onChange, rows = 4 }) {
  return (
    <label className="field field-area">
      <span>{label}</span>
      <textarea value={value} onChange={event => onChange(event.target.value)} rows={rows} />
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
