import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ResolveMediaPreparation } from '../components/resolve-media-preparation.jsx';

afterEach(cleanup);
const base = { projectId: 'trip', projectName: 'Trip [Edit]', jobs: [], spansReady: true, chronologyReady: true };
const job = { jobId: 'media-1', jobType: 'resolve-media-sync', projectId: 'trip', updatedAt: '2026-10-14' };

describe('project media preparation', () => {
  it('starts before an Edit Unit or Flow Plan exists', () => {
    const onStart = vi.fn();
    render(<ResolveMediaPreparation {...base} onStart={onStart} />);
    fireEvent.click(screen.getByRole('button', { name: '准备剪辑素材池' }));
    expect(onStart).toHaveBeenCalledOnce();
  });
  it('shows running progress, then a retryable failure', () => {
    const view = render(<ResolveMediaPreparation {...base} onStart={() => {}} jobs={[{ ...job, status: 'running',
      progress: { phaseLabel: '同步素材', fileName: 'C4170.mp4', current: 4, total: 12, extra: { jobId: job.jobId } } }]} />);
    expect(screen.getByText('4 / 12 个素材')).toBeInTheDocument();
    expect(screen.getByText(/同步素材 · C4170.mp4/)).toBeInTheDocument();
    expect(screen.getByRole('button')).toBeDisabled();
    view.rerender(<ResolveMediaPreparation {...base} onStart={() => {}} jobs={[{ ...job, status: 'failed', lastError: '源文件不可读' }]} />);
    expect(screen.getByRole('alert')).toHaveTextContent('源文件不可读');
    expect(screen.getByRole('button', { name: '重试素材池准备' })).toBeEnabled();
  });
  it('labels completion as historical and permits a new sync', () => {
    render(<ResolveMediaPreparation {...base} onStart={() => {}} jobs={[{ ...job, status: 'completed',
      result: { hostSummary: { imported: 10, reused: 2, moved: 1, mediaItemCount: 13 } } }]} />);
    expect(screen.getByText(/上次同步：新增 10、复用 2、移动 1/)).toBeInTheDocument();
    expect(screen.getByText(/生成时间线时会再次检查实际素材池/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '重新同步素材池' })).toBeEnabled();
  });
});
