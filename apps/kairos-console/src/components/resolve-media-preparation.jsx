import React from 'react';
import { Progress } from 'antd';
import { Button, Card, Tag } from '../ui-compat.tsx';
import { resolveMediaPreparationState } from '../edit-flow-state.js';

export function ResolveMediaPreparation({ projectId, projectName, jobs, spansReady, chronologyReady, submitting, onStart }) {
  const state = resolveMediaPreparationState({ projectId, jobs, spansReady, chronologyReady, submitting });
  const { latest, active, progress, summary } = state;
  const statusLabel = active ? (latest.status === 'queued' ? '等待启动' : '正在准备')
    : latest?.status === 'completed' ? '最近同步成功'
    : latest?.status === 'stopped' ? '已停止'
    : latest ? '上次未完成' : '尚无同步记录';
  return (
    <Card className="panel resolve-media-preparation" style={{ marginBottom: 16 }}>
      <div className="edit-flow-panel-head">
        <div>
          <h2>项目共享素材池</h2>
          <p>{projectName} · 各专题共用素材；准备完成后再分别建立剪辑时间线。</p>
        </div>
        <div className="inline-actions">
          <Tag>{statusLabel}</Tag>
          <Button type="primary" disabled={state.disabled || !onStart} onClick={onStart}>
            {submitting ? '启动中…' : state.label}
          </Button>
        </div>
      </div>
      <p>编年史确认后即可导入，无需先创建剪辑单元或 Flow Plan。重复同步会复用已有素材。</p>
      {state.blocker ? <p role="status">{state.blocker}</p> : null}
      {active ? <div role="status">
        <p>{progress?.phaseLabel || '等待素材准备进程启动'}{progress?.fileName ? ` · ${progress.fileName}` : ''}</p>
        {progress?.total > 0 ? <>
          <Progress percent={Math.floor((progress.current || 0) / progress.total * 100)} />
          <p>{`${progress.current || 0} / ${progress.total} 个素材`}</p>
        </> : null}
        <p>可以在顶部任务中心查看日志或停止任务。</p>
      </div> : null}
      {!active && latest && ['failed', 'blocked'].includes(latest.status)
        ? <p role="alert">{latest.lastError || latest.blockers?.join('；') || '素材准备未完成，请检查 Resolve 与素材路径后重试。'}</p> : null}
      {summary ? <p>{`上次同步：新增 ${summary.imported ?? 0}、复用 ${summary.reused ?? 0}、移动 ${summary.moved ?? 0}；共 ${summary.mediaItemCount ?? 0} 个素材。`}</p> : null}
      {latest?.status === 'completed' ? <p>此处记录上次同步结果；生成时间线时会再次检查实际素材池。</p> : null}
    </Card>
  );
}
