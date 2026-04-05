import React from 'react';
import { Card, Tag } from 'hana-ui';

export function MonitorPage({ model, emptyLabel, toolbar, afterMonitor }) {
  if (!model) {
    return (
      <div className="route-page">
        <EmptyPanel label={emptyLabel || '当前还没有可用的监控数据。'} />
        {afterMonitor || null}
      </div>
    );
  }

  const percent = typeof model.progress?.percent === 'number'
    ? Math.max(0, Math.min(100, model.progress.percent))
    : model.progress?.current && model.progress?.total
      ? Math.max(0, Math.min(100, (model.progress.current / model.progress.total) * 100))
      : 0;

  return (
    <div className="route-page monitor-page">
      <Card className="monitor-panel intro-panel">
        <div className="eyebrow">Kairos Monitor</div>
        <h1 className="monitor-title">{model.title}</h1>
        <p className="monitor-subtitle">{model.subtitle}</p>
        <div className="chips">
          {(model.chips || []).map(chip => (
            <span key={chip.label} className={`chip chip-${chip.tone || 'default'}`}>
              {chip.label}
            </span>
          ))}
        </div>
        {toolbar ? <div className="monitor-toolbar">{toolbar}</div> : null}
      </Card>

      <Card className="monitor-panel hero-panel">
        <div className="status-row">
          <div className={`status-pill tone-${toneClass(model.progress?.status)}`}>
            {statusLabel(model.progress?.status)}
          </div>
          <div className="step-label">{model.progress?.stepLabel || model.progress?.stepKey || '等待运行'}</div>
        </div>
        {model.progress?.detail ? (
          <div className="detail">{model.progress.detail}</div>
        ) : null}

        <div className="headline-metrics">
          {(model.metrics || []).map(metric => (
            <div key={metric.label} className="headline-metric">
              <div className="label">{metric.label}</div>
              <div className="value">{metric.value}</div>
              {metric.sub ? <div className="sub">{metric.sub}</div> : null}
            </div>
          ))}
        </div>

        <div className="progress-block">
          <div className="bar-shell">
            <div className="bar-fill" style={{ width: `${percent}%` }} />
          </div>
          <div className="progress-caption">
            <span>
              {formatProgress(model.progress)}
            </span>
            <span>
              {model.progress?.etaSeconds ? `ETA ${formatEta(model.progress.etaSeconds)}` : '重新估算中'}
            </span>
          </div>
        </div>

        <div className="aux-grid">
          <div className="aux-item">
            <div className="label">当前素材</div>
            <div className="value">{model.progress?.fileName || '暂无'}</div>
          </div>
          <div className="aux-item">
            <div className="label">最后更新</div>
            <div className="value">{formatDateTime(model.progress?.updatedAt)}</div>
          </div>
        </div>
      </Card>

      <Card className="monitor-panel section-panel">
        <h2>流程步骤</h2>
        <div className="step-track">
          {(model.stepDefinitions || []).map((step, index) => (
            <div key={step.key || index} className={`step-track-item state-${step.state}`}>
              <div className="step-track-index">{index + 1}</div>
              <div className="step-track-copy">
                <strong>{step.label}</strong>
                {step.description ? <div className="muted">{step.description}</div> : null}
              </div>
              <Tag>{stateLabel(step.state)}</Tag>
            </div>
          ))}
        </div>
      </Card>

      <Card className="monitor-panel section-panel">
        <h2>完成产物</h2>
        {(model.outputs || []).length === 0 ? <p className="muted">当前没有可展示的产物。</p> : null}
        {(model.outputs || []).map(output => (
          <div key={`${output.label}:${output.path}`} className="output-row">
            <div className="output-copy">
              <strong>{output.label}</strong>
              {output.description ? <div className="muted">{output.description}</div> : null}
              <code>{output.path}</code>
            </div>
            <Tag>{output.exists ? 'ready' : 'pending'}</Tag>
          </div>
        ))}
      </Card>

      <Card className="monitor-panel section-panel">
        <h2>原始进度数据</h2>
        <pre className="raw-json">{JSON.stringify(model.raw, null, 2)}</pre>
      </Card>

      {afterMonitor || null}
    </div>
  );
}

export function EmptyPanel({ label }) {
  return (
    <Card className="monitor-panel section-panel">
      <h2>等待数据</h2>
      <p className="muted">{label}</p>
    </Card>
  );
}

function formatProgress(progress) {
  if (!progress) {
    return '尚未开始';
  }
  const current = progress.current || 0;
  const total = progress.total || 0;
  if (!total) {
    return progress.stepLabel || progress.stepKey || '等待运行';
  }
  return `${current}/${total} · ${Math.max(0, Math.min(100, progress.percent || (current / total) * 100)).toFixed(1)}%`;
}

function formatDateTime(value) {
  if (!value) {
    return '暂无';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString('zh-CN', {
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function formatEta(seconds) {
  const total = Math.max(0, Number(seconds) || 0);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remain = total % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${remain}s`;
  return `${remain}s`;
}

function toneClass(status) {
  const normalized = (status || '').toLowerCase();
  if (normalized === 'running' || normalized === 'completed') {
    return 'ok';
  }
  if (normalized === 'failed' || normalized === 'error') {
    return 'error';
  }
  if (normalized === 'blocked' || normalized === 'queued') {
    return 'warn';
  }
  return 'default';
}

function statusLabel(status) {
  const normalized = (status || '').toLowerCase();
  if (normalized === 'running') return '运行中';
  if (normalized === 'completed') return '已完成';
  if (normalized === 'blocked') return '已阻塞';
  if (normalized === 'queued') return '排队中';
  if (normalized === 'failed' || normalized === 'error') return '失败';
  if (normalized === 'stopped') return '已停止';
  return '待启动';
}

function stateLabel(state) {
  if (state === 'completed') return 'done';
  if (state === 'active') return 'active';
  if (state === 'error') return 'error';
  return 'pending';
}
