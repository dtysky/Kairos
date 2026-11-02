import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { IngestJobProgress } from '../components/ingest-job-progress.jsx';
import { IngestGpsActionPanel } from '../main.jsx';

afterEach(cleanup);
const job = { jobId: 'ingest-1', projectId: 'trip', jobType: 'ingest', status: 'running' };
const progress = { pipelineKey: 'ingest', phaseKey: 'metadata', phaseLabel: '读取素材元数据',
  current: 40, total: 100, fileName: 'day1/C0001.mp4', updatedAt: '2026-11-02T06:30:00Z',
  extra: { jobId: job.jobId, rootLabel: '主机位', rootIndex: 1, rootTotal: 3, scannedFileCount: 100,
    probedFileCount: 5, reusedFileCount: 35, failedFileCount: 0, activeFileCount: 4 } };

describe('Ingest job progress', () => {
  it('shows real stage count, current file, root and metadata statistics', () => {
    render(<IngestJobProgress job={{ ...job, progress }} />);
    expect(screen.getByText('当前阶段 40 / 100 个素材')).toBeInTheDocument();
    expect(screen.getByText('40%')).toBeInTheDocument();
    expect(screen.getByText('目录 1 / 3 · 主机位')).toBeInTheDocument();
    expect(screen.getByText(/当前：day1\/C0001.mp4/)).toHaveTextContent('4 个素材并行处理中');
    expect(screen.getByText('35')).toBeInTheDocument();
  });

  it('shows discovery without inventing a percentage before scan completion', () => {
    render(<IngestJobProgress job={{ ...job, progress: { ...progress, phaseKey: 'scan', phaseLabel: '扫描素材', total: undefined } }} />);
    expect(screen.getByText('已发现 40 个素材 · 正在统计总数')).toBeInTheDocument();
    expect(screen.queryByText(/\d+%/)).not.toBeInTheDocument();
  });

  it.each(['running', 'completed'])('rejects another job snapshot for a %s job', status => {
    render(<IngestJobProgress job={{ ...job, status, progress: { ...progress, extra: { jobId: 'other-job' } } }} />);
    expect(screen.queryByText('40%')).not.toBeInTheDocument();
    expect(screen.queryByText(/C0001/)).not.toBeInTheDocument();
    expect(screen.getByText(status === 'running' ? '本次任务尚未上报详细进度。' : '导入已完成；本次任务没有详细进度记录。')).toBeInTheDocument();
  });

  it('keeps terminal counts historical even if the last snapshot says running', () => {
    const view = render(<IngestJobProgress job={{ ...job, status: 'stopped', progress: { ...progress, status: 'running' } }} />);
    expect(screen.getByText('已停止 · 读取素材元数据')).toBeInTheDocument();
    expect(screen.queryByText(/并行处理中/)).not.toBeInTheDocument();
    view.rerender(<IngestJobProgress job={{ ...job, status: 'failed', lastError: '磁盘断开', progress }} />);
    expect(screen.getByRole('alert')).toHaveTextContent('磁盘断开');
    expect(screen.getByText('当前阶段 40 / 100 个素材')).toBeInTheDocument();
    view.rerender(<IngestJobProgress job={{ ...job, status: 'stopped', progress: {
      ...progress, phaseKey: 'scan', phaseLabel: '扫描素材', total: undefined,
    } }} />);
    expect(screen.getByText('已发现 40 个素材 · 总数尚未确定')).toBeInTheDocument();
    expect(screen.queryByText(/正在统计/)).not.toBeInTheDocument();
  });

  it('shows the final ingest summary and handles empty roots without NaN', () => {
    render(<IngestJobProgress job={{ ...job, status: 'completed', progress: { ...progress, current: 0, total: 0,
      extra: { ...progress.extra, assetCount: 120, addedCount: 20, prunedCount: 1 } } }} />);
    expect(screen.getByText('本次新增 20，移除 1；共 120 个素材。')).toBeInTheDocument();
    expect(screen.queryByText(/NaN|Infinity/)).not.toBeInTheDocument();
  });

  it('keeps the active ingest visible above a more recent GPS result with one status badge', () => {
    render(<IngestGpsActionPanel projectId="trip" capabilities={{}} busy={{}} jobs={[
      { jobId: 'gps', projectId: 'trip', jobType: 'gps-refresh', status: 'completed' }, { ...job, progress },
    ]} />);
    expect(screen.getByText('40%')).toBeInTheDocument();
    expect(screen.getAllByText('运行中')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Ingest 运行中…' })).toBeDisabled();
  });
});
