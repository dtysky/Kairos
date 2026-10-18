import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppShell } from '../main.jsx';
import { ConsoleStateProvider } from '../app-state.tsx';
import { ResolveSnapshotStatus } from '../components/resolve-snapshot-status.jsx';

let entry, failBackup, polls, requests, jobs;
const snapshot = { projectName: 'Trip [Edit]', createdAt: '2026-10-17T14:36:39Z', snapshotPath: '/backups/Trip.drp', mode: 'manual', retention: 'latest-only' };
const message = 'Unable to connect to DaVinci Resolve';

beforeEach(() => {
  localStorage.clear(); localStorage.setItem('kairos.console.projectId', 'trip');
  entry = { latestSnapshot: snapshot }; failBackup = true; polls = []; requests = []; jobs = [];
  polls = vi.spyOn(window, 'setInterval');
  vi.stubGlobal('fetch', vi.fn(async (path, options = {}) => {
    const url = new URL(path, 'http://localhost'); let data = {};
    if (path === '/api/status') data = { projects: [{ projectId: 'trip', project: { name: 'Trip' } }], jobs, services: [] };
    else if (path === '/api/workspace/config/edit-rules') data = { categories: [{ categoryId: 'travel-vlog', displayName: 'VLOG' }] };
    else if (url.pathname === '/api/projects/trip/config') data = {
      editUnits: [{ editId: 'main', editRuleCategory: 'travel-vlog' }], editUnit: { editId: 'main', editRuleCategory: 'travel-vlog' },
      projectBrief: { name: 'Trip' }, spans: { fresh: true }, chronology: { chronology: { status: 'confirmed' } },
      editResolveProject: { resolveProjectName: 'Trip [Edit]', latestDrpSnapshot: entry.latestSnapshot, resolveProjectMap: { projects: { 'Trip [Edit]': entry } } },
    };
    else if (url.pathname === '/api/projects/trip/edit/resolve-project-snapshot') {
      const payload = JSON.parse(options.body); requests.push(payload);
      entry = { ...entry, latestSnapshotAttempt: { attemptId: `attempt-${requests.length}`, status: failBackup ? 'failed' : 'succeeded',
        mode: 'manual', retention: payload.retention, startedAt: '2026-10-18T12:00:00Z', finishedAt: '2026-10-18T12:00:01Z',
        ...(failBackup ? { error: { code: 'resolve_app_unavailable', message } } : {}) } };
      if (failBackup) return new Response(JSON.stringify({ error: message }), { status: 500 });
      entry.latestSnapshot = { ...snapshot, createdAt: '2026-10-18T12:00:01Z' };
    }
    return new Response(JSON.stringify(data), { status: 200 });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
function mount() { return render(<MemoryRouter initialEntries={['/edit']}><ConsoleStateProvider><AppShell /></ConsoleStateProvider></MemoryRouter>); }
async function openMaintenance() {
  await waitFor(() => expect(screen.getByRole('combobox', { name: '已有剪辑单元' })).toHaveValue('main'));
  fireEvent.click(document.querySelector('.edit-maintenance-disclosure summary'));
}

describe('project snapshot failure UI', () => {
  it('keeps failure after status polling and page reload; retry preserves archive policy and clears failure on success', async () => {
    const view = mount(); await openMaintenance();
    fireEvent.click(screen.getByRole('button', { name: '归档快照' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '重试工程备份' })).toBeEnabled());
    expect(screen.getAllByRole('alert').some(node => node.textContent.includes(message))).toBe(true);
    expect(entry.latestSnapshot).toEqual(snapshot);
    await act(async () => { for (const [poll, interval] of [...polls.mock.calls]) if (interval === 4000) await poll(); });
    expect(screen.getAllByRole('alert').some(node => node.textContent.includes(message))).toBe(true);
    expect(screen.getByText(/此次失败未更新成功记录/)).toBeInTheDocument();
    view.unmount(); mount(); await openMaintenance();
    expect(screen.getByRole('alert')).toHaveTextContent(message);
    failBackup = false;
    fireEvent.click(screen.getByRole('button', { name: '重试工程备份' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: '重试工程备份' })).not.toBeInTheDocument());
    expect(requests.map(row => row.retention)).toEqual(['archive', 'archive']);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('最近备份成功');
  }, 20000);

  it('shows automatic failure in the collapsed maintenance summary without a manual request', async () => {
    entry.latestSnapshotAttempt = { attemptId: 'auto', status: 'failed', mode: 'auto', retention: 'latest-only',
      startedAt: '2026-10-18T12:00:00Z', error: { message } };
    mount();
    await waitFor(() => expect(document.querySelector('.edit-maintenance-disclosure summary')).toHaveTextContent('最近备份失败'));
    expect(document.querySelector('.edit-maintenance-disclosure')).not.toHaveAttribute('open');
    expect(requests).toEqual([]);
  });

  it('does not treat a stale running record as an active request or retry external registration as a new export', () => {
    const view = render(<ResolveSnapshotStatus attempt={{ status: 'running', mode: 'manual', startedAt: 'yesterday' }} />);
    expect(screen.getByRole('status')).toHaveTextContent('上次备份尝试未结束');
    view.rerender(<ResolveSnapshotStatus attempt={{ status: 'failed', mode: 'external', error: { message: '路径不存在' } }} onRetry={() => {}} />);
    expect(screen.getByRole('alert')).toHaveTextContent('重新登记');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('refreshes the durable backup result when the last live project job ends', async () => {
    jobs = [{ jobId: 'timeline-job', projectId: 'trip', jobType: 'edit-flow', status: 'running' }];
    mount(); await openMaintenance();
    expect(document.querySelector('.edit-maintenance-disclosure summary')).not.toHaveTextContent('最近备份失败');
    entry.latestSnapshotAttempt = { attemptId: 'auto-failed', status: 'failed', mode: 'auto', retention: 'latest-only',
      startedAt: '2026-10-18T12:00:00Z', error: { message } };
    jobs = [{ ...jobs[0], status: 'completed' }];
    await act(async () => { await polls.mock.calls[0][0](); });
    await waitFor(() => expect(document.querySelector('.edit-maintenance-disclosure summary')).toHaveTextContent('最近备份失败'));
    expect(requests).toEqual([]);
  });
});
