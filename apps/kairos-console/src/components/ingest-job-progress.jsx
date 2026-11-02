import React from 'react';
import { Progress, Spin } from 'antd';

export function IngestJobProgress({ job }) {
  const active = ['running', 'queued'].includes(job.status);
  const progress = job.progress?.pipelineKey === 'ingest' && job.progress?.extra?.jobId === job.jobId
    ? job.progress : null;
  const failed = ['failed', 'blocked'].includes(job.status);
  const error = failed ? job.lastError || job.blockers?.join('；') || progress?.detail : null;
  if (!progress) {
    return <div className="ingest-progress" role="status">
      <div className="muted">{active
        ? job.status === 'queued' ? '等待导入任务启动…' : '本次任务尚未上报详细进度。'
        : job.status === 'completed' ? '导入已完成；本次任务没有详细进度记录。'
        : job.status === 'stopped' ? '导入已停止。' : '导入未完成。'}</div>
      {error ? <div role="alert">{error}</div> : null}
    </div>;
  }

  const stats = progress.extra;
  const current = Number.isFinite(progress.current) && progress.current >= 0 ? progress.current : null;
  const total = Number.isFinite(progress.total) && progress.total >= 0 ? progress.total : null;
  const percent = current !== null && total > 0 ? Math.min(100, Math.floor(current / total * 100)) : null;
  const phase = job.status === 'completed' ? '导入完成'
    : job.status === 'stopped' ? `已停止 · ${progress.phaseLabel || '导入'}`
    : failed ? `未完成 · ${progress.phaseLabel || '导入'}` : progress.phaseLabel || '正在导入';
  const updatedAt = progress.updatedAt && Number.isFinite(Date.parse(progress.updatedAt))
    ? new Date(progress.updatedAt).toLocaleTimeString('zh-CN', { hour12: false }) : null;

  return <div className="ingest-progress" role="status" aria-label="Ingest 进度">
    <div className="ingest-progress-heading">
      <strong>{active && percent === null ? <Spin size="small" /> : null}{phase}</strong>
      {stats.rootTotal > 0 ? <span>{`目录 ${stats.rootIndex} / ${stats.rootTotal} · ${stats.rootLabel || stats.rootId}`}</span> : null}
      {current !== null ? <span className="ingest-progress-count">{total !== null
        ? `当前阶段 ${current} / ${total} 个素材`
        : `已发现 ${current} 个素材 · ${active ? '正在统计总数' : '总数尚未确定'}`}</span> : null}
    </div>
    {percent !== null ? <Progress percent={percent} size="small"
      status={failed ? 'exception' : active ? 'active' : job.status === 'completed' ? 'success' : 'normal'} /> : null}
    {progress.fileName ? <div className="ingest-progress-file muted" title={progress.fileName}>
      {`${active ? '当前' : '最后处理'}：${progress.fileName}`}
      {active && stats.activeFileCount > 1 ? `（${stats.activeFileCount} 个素材并行处理中）` : ''}
    </div> : null}
    <div className="ingest-progress-stats">
      {Number.isFinite(stats.scannedFileCount) ? <span>累计发现 <b>{stats.scannedFileCount}</b></span> : null}
      <span title="元数据统计含同名保护音轨">读取 <b>{stats.probedFileCount ?? 0}</b></span>
      <span title="文件未变化，直接复用元数据；含保护音轨">复用 <b>{stats.reusedFileCount ?? 0}</b></span>
      <span className={stats.failedFileCount > 0 ? 'ingest-progress-warning' : ''}>读取失败 <b>{stats.failedFileCount ?? 0}</b></span>
      {updatedAt ? <span className="muted">{active ? '更新于' : '最后更新'} {updatedAt}</span> : null}
    </div>
    {job.status === 'completed' && Number.isFinite(stats.assetCount)
      ? <div>{`本次新增 ${stats.addedCount ?? 0}，移除 ${stats.prunedCount ?? 0}；共 ${stats.assetCount} 个素材。`}</div> : null}
    {error ? <div className="ingest-progress-error" role="alert">{error}</div> : null}
  </div>;
}
