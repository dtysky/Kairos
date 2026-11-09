import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ColorCurrentSummary } from '../workspace-forms.jsx';
const clipboardDescriptor = Object.getOwnPropertyDescriptor(window.navigator, 'clipboard');
afterEach(() => { cleanup(); if (clipboardDescriptor) Object.defineProperty(window.navigator, 'clipboard', clipboardDescriptor); else Reflect.deleteProperty(window.navigator, 'clipboard'); });
const pending = { status: 'pending-agent', pendingCount: 3, model: 'gpt-6.1-sol', reasoningEffort: 'high', batchFingerprint: 'batch', handoffPath: '/camera/handoff.md', submissionPath: '/camera/submission.json' };
const root = { rootId: 'camera', label: 'Camera', rawLocalPath: '/raw', localPath: '/target', resolveProjectName: 'Trip [Color]', gradingTimelineName: 'Camera [Color]',
  hostPreflight: { status: 'ready' }, classification: { status: 'ready', pendingCount: 0 },
  colorCurrent: { mirrorStatus: 'ready', timelineStatus: 'ready', groupSyncStatus: 'ready' },
  groups: [{ groupKey: 'camera-night', displayName: '夜景／低照度', clipCount: 1, clips: [{ clipKey: 'one.mov', displayName: 'C4333', classificationReasons: ['室内低照度'], reviewFlags: [] }], current: { status: 'ready' } }] };
const other = { ...root, rootId: 'drone', label: 'Drone', gradingTimelineName: 'Drone [Color]', groups: [{ ...root.groups[0], groupKey: 'drone-night', clips: [{ ...root.groups[0].clips[0], displayName: 'D001' }] }] };
const props = { projectId: 'trip', capability: { supported: true }, onRunColorAction: vi.fn() };
const panel = (roots: any[], extra = {}) => <ColorCurrentSummary {...props} config={{ colorRoots: roots }} {...extra} />;
const maintenance = () => fireEvent.click(screen.getByRole('tab', { name: '维护与历史' }));

describe('project Color workflow', () => {
  it('starts one project prepare and does not claim legacy timelines have current classifications', () => {
    const onRunColorAction = vi.fn();
    const view = render(panel([{ ...root, classification: undefined }, other], { onRunColorAction }));
    expect(screen.queryByText('选择素材源')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '检查并准备项目' }));
    expect(onRunColorAction).toHaveBeenCalledWith({ action: 'prepare_all_roots' });
    expect(view.container.querySelectorAll('.ant-btn-primary')).toHaveLength(1);
    maintenance(); expect(screen.getByRole('button', { name: '重新导出项目' })).toBeDisabled();
  });
  it('copies all pending batches once, retaining each exact submission and the specified subagent', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, 'clipboard', { configurable: true, value: { writeText } });
    render(panel([{ ...root, classification: pending }, { ...other, classification: { ...pending, handoffPath: '/drone/handoff.md', submissionPath: '/drone/submission.json' } }]));
    expect(screen.getByRole('status')).toHaveTextContent('6 个素材待分类');
    fireEvent.click(screen.getByRole('button', { name: '复制项目分类任务' }));
    const text = writeText.mock.calls[0][0];
    expect(text).toContain('model=gpt-6.1-sol、reasoning_effort=high、fork_turns=none');
    expect(text).toContain('/camera/handoff.md'); expect(text).toContain('/drone/handoff.md');
    expect(text).toContain("submit 'trip' 'camera' '/camera/submission.json'");
    expect(text).toContain("submit 'trip' 'drone' '/drone/submission.json'");
    expect(text).toContain('prepare_all_roots'); expect(text).toContain('不要重跑 Analyze');
    expect(await screen.findByText('已复制全部待分类任务，请粘贴到 Codex 执行。')).toBeVisible();
  });
  it('does not send accepted roots to the Agent again and ignores historical activeStage', () => {
    const view = render(panel([{ ...root, classification: pending, colorCurrent: { ...root.colorCurrent, activeStage: 'old-running' } }, other], {
      jobs: [{ projectId: 'trip', jobType: 'color', status: 'completed' }],
    }));
    expect(screen.getByRole('status')).toHaveTextContent('3 个素材待分类');
    expect(view.container.querySelector('.color-live-jobs')).toBeNull();
    expect(screen.getByRole('button', { name: '复制项目分类任务' })).toBeEnabled();
    maintenance(); expect(screen.getByRole('button', { name: '重新导出项目' })).toBeDisabled();
  });
  it('prepares newly added roots before handing off all pending input', () => {
    render(panel([{ ...root, classification: pending }, { ...other, classification: undefined }]));
    expect(screen.getByRole('button', { name: '检查并准备项目' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: '复制项目分类任务' })).not.toBeInTheDocument();
  });
  it('recovers a missing handoff through project preparation instead of copying incomplete tasks', () => {
    render(panel([{ ...root, classification: { ...pending, handoffPath: undefined } }]));
    expect(screen.getByRole('button', { name: '重新生成项目分类任务' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: '复制项目分类任务' })).not.toBeInTheDocument();
  });
  it('requires accepted results to be applied before opening project export', () => {
    const onRunColorAction = vi.fn();
    render(panel([{ ...root, classification: { ...pending, status: 'ready', pendingCount: 0 } }, other], { onRunColorAction }));
    fireEvent.click(screen.getByRole('button', { name: '应用项目分类到 Resolve' }));
    expect(onRunColorAction).toHaveBeenCalledWith({ action: 'prepare_all_roots' });
    maintenance(); expect(screen.getByRole('button', { name: '重新导出项目' })).toBeDisabled();
  });
  it('aggregates categories across directories; a list filter never reduces project export scope', async () => {
    const onRunColorAction = vi.fn();
    render(panel([root, other], { onRunColorAction }));
    expect(screen.getByText('1 类 · 2 个片段')).toBeVisible();
    fireEvent.change(screen.getByLabelText('筛选素材目录'), { target: { value: 'camera' } });
    expect(screen.getByText('1 类 · 1 个片段')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '调色后导出项目' }));
    expect(onRunColorAction).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByText('本次素材源：Camera · Drone')).toBeVisible());
    fireEvent.click(screen.getByRole('button', { name: '确认统一导出' }));
    expect(onRunColorAction).toHaveBeenCalledWith({ action: 'export_all_roots' });
  });
  it('shows project progress regardless of the directory filter and blocks another start', () => {
    const job = { projectId: 'trip', jobType: 'color', jobId: 'live', status: 'running', args: { action: 'prepare_all_roots' }, progress: { detail: '正在检查 Drone', current: 1, total: 2, extra: { currentRootId: 'drone' } } };
    const view = render(panel([root, other], { jobs: [job] }));
    fireEvent.change(screen.getByLabelText('筛选素材目录'), { target: { value: 'camera' } });
    expect(view.container.querySelector('.color-live-jobs')).toHaveTextContent('正在检查 Drone');
    expect(screen.getByRole('button', { name: '任务进行中…' })).toBeDisabled();
    view.rerender(panel([root, other], { jobs: [{ ...job, projectId: 'elsewhere' }] }));
    expect(view.container.querySelector('.color-live-jobs')).toBeNull();
    expect(screen.getByRole('button', { name: '调色后导出项目' })).toBeEnabled();
  });
  it('routes validation failures to the affected directory without relaunching preparation', () => {
    render(panel([root, { ...other, blockingReasons: ['输出缺少字幕'], colorCurrent: { ...root.colorCurrent, latestBatchId: 'failed', latestValidationStatus: 'fail' } }]));
    fireEvent.click(screen.getByRole('button', { name: '查看待校验输出' }));
    expect(screen.getByLabelText('定位目录问题')).toHaveValue('drone');
    expect(screen.getByRole('button', { name: '重新校验最近一批' })).toBeEnabled();
  });
  it('blocks project export if any directory has a prerequisite failure', () => {
    render(panel([root, { ...other, blockingReasons: ['原片路径不可读'] }]));
    expect(screen.getByRole('status')).toHaveTextContent('Drone：原片路径不可读');
    expect(screen.getByRole('link', { name: '检查素材导入' })).toHaveAttribute('href', '/ingest-gps');
    maintenance(); expect(screen.getByRole('button', { name: '重新导出项目' })).toBeDisabled();
  });
});
