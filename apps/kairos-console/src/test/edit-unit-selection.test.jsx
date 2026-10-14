import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppShell } from '../main.jsx';
import { ConsoleStateProvider } from '../app-state.tsx';
import { editSelectionStorageKey, resolveProjectEditId } from '../edit-flow-state.js';

const ids = ['ep1-minnan-coast', 'ep2-mountains-villages-craft', 'ep3-return-to-wild'];
let requests;
let delayConfig;
let units;
function configFor(projectId, editId) {
  const editUnits = projectId === 'trip' ? units : [{ editId: 'main', editRuleCategory: 'travel-documentary' }];
  return { editUnits, editUnit: editUnits.find(unit => unit.editId === editId) || { editId },
    projectBrief: { name: projectId }, spans: { fresh: true }, chronology: { chronology: { status: 'confirmed' } },
    editFlowPlan: { editId, editRuleCategory: editUnits.find(unit => unit.editId === editId)?.editRuleCategory,
      status: 'draft', steps: [{ id: `step-${editId}`, title: `框架 ${editId}`, capabilityId: 'edit.framework', notes: [] }] },
    editFlowRuns: [{ stepId: `step-${editId}`, status: 'completed', startedAt: '2026-10-14', summary: {} }] };
}
beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('kairos.console.projectId', 'trip');
  localStorage.setItem('kairos.console.editId', 'main');
  requests = [];
  delayConfig = null;
  units = ids.map(editId => ({ editId, editRuleCategory: 'travel-vlog', updatedAt: '2026-10-14' }));
  vi.stubGlobal('fetch', vi.fn(async (path, options = {}) => {
    requests.push([path, options.method || 'GET']);
    const url = new URL(path, 'http://localhost');
    let data = {};
    if (path === '/api/status') data = { projects: ['trip', 'other'].map(projectId => ({ projectId, project: { name: projectId } })), jobs: [], services: [] };
    else if (path === '/api/workspace/config/edit-rules') data = { defaultCategory: 'travel-documentary', categories: [
      { categoryId: 'travel-vlog', displayName: '旅行VLOG剪辑规则' }, { categoryId: 'travel-documentary', displayName: '旅行纪录片剪辑规则' }] };
    else if (path === '/api/workspace/config/style-sources') data = { defaultCategory: 'default-style', categories: [{ categoryId: 'default-style', displayName: '默认风格' }] };
    else if (url.pathname === '/api/projects/trip/config/edit-unit' && options.method === 'PUT') {
      const unit = JSON.parse(options.body);
      units = [...units.filter(existing => existing.editId !== unit.editId), unit];
      data = unit;
    } else if (/\/projects\/[^/]+\/config$/u.test(url.pathname)) {
      const projectId = url.pathname.split('/')[3];
      const editId = url.searchParams.get('editId') || 'main';
      if (delayConfig) await delayConfig(projectId, editId);
      data = configFor(projectId, editId);
    }
    return new Response(JSON.stringify(data), { status: 200 });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
function mount() { return render(<MemoryRouter initialEntries={['/edit']}><ConsoleStateProvider><AppShell /></ConsoleStateProvider></MemoryRouter>); }
async function loaded(editId) { await waitFor(() => expect(screen.getByRole('combobox', { name: '已有剪辑单元' })).toHaveValue(editId)); }

describe('edit unit selection', () => {
  it('discovers all three VLOG units, switches their plan and preserves the choice after reload without writing config', async () => {
    const view = mount(); await loaded(ids[0]);
    expect(screen.getByText('已有剪辑单元（3）')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: '剪辑规则' })).toHaveValue('travel-vlog');
    expect(screen.getByRole('combobox', { name: '风格档案' })).toHaveValue('');
    fireEvent.change(screen.getByRole('combobox', { name: '已有剪辑单元' }), { target: { value: ids[1] } });
    await loaded(ids[1]);
    expect(screen.getByRole('heading', { name: `框架 ${ids[1]}` })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: `框架 ${ids[0]}` })).not.toBeInTheDocument();
    expect(localStorage.getItem(editSelectionStorageKey('trip'))).toBe(ids[1]);
    view.unmount(); mount(); await loaded(ids[1]);
    expect(requests.every(([, method]) => method === 'GET')).toBe(true);
  });
  it('isolates project choices and leaves legacy main usable', async () => {
    localStorage.setItem(editSelectionStorageKey('trip'), ids[2]);
    mount(); await loaded(ids[2]);
    fireEvent.change(screen.getByRole('combobox', { name: '当前项目' }), { target: { value: 'other' } });
    await loaded('main');
    expect(screen.getByRole('combobox', { name: '剪辑规则' })).toHaveValue('travel-documentary');
    fireEvent.change(screen.getByRole('combobox', { name: '当前项目' }), { target: { value: 'trip' } });
    await loaded(ids[2]);
  });
  it('keeps a new ID draft and protects it when switching units or projects', async () => {
    mount(); await loaded(ids[0]);
    fireEvent.click(screen.getByRole('button', { name: '新建剪辑单元' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Edit ID' }), { target: { value: 'ep4-new-topic' } });
    expect(screen.getByRole('textbox', { name: 'Edit ID' })).toHaveValue('ep4-new-topic');
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    fireEvent.change(screen.getByRole('combobox', { name: '已有剪辑单元' }), { target: { value: ids[1] } });
    await waitFor(() => expect(confirm).toHaveBeenCalledOnce());
    expect(screen.getByRole('textbox', { name: 'Edit ID' })).toHaveValue('ep4-new-topic');
    fireEvent.change(screen.getByRole('combobox', { name: '当前项目' }), { target: { value: 'other' } });
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('textbox', { name: 'Edit ID' })).toHaveValue('ep4-new-topic');
    confirm.mockReturnValue(true);
    fireEvent.change(screen.getByRole('combobox', { name: '已有剪辑单元' }), { target: { value: ids[1] } });
    await loaded(ids[1]);
  });
  it('ignores a late episode response after changing projects', async () => {
    mount(); await loaded(ids[0]);
    let release;
    const delayed = new Promise(resolve => { release = resolve; });
    delayConfig = (project, editId) => project === 'trip' && editId === ids[1] ? delayed : undefined;
    fireEvent.change(screen.getByRole('combobox', { name: '已有剪辑单元' }), { target: { value: ids[1] } });
    fireEvent.change(screen.getByRole('combobox', { name: '当前项目' }), { target: { value: 'other' } });
    await loaded('main');
    await act(async () => { release(); await delayed; });
    await loaded('main');
    expect(screen.getByRole('combobox', { name: '剪辑规则' })).toHaveValue('travel-documentary');
  });
  it('creates a separate unit and immediately discovers it without rewriting existing units', async () => {
    mount(); await loaded(ids[0]);
    fireEvent.click(screen.getByRole('button', { name: '新建剪辑单元' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Edit ID' }), { target: { value: ids[0] } });
    expect(screen.getByRole('button', { name: '创建剪辑单元' })).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox', { name: 'Edit ID' }), { target: { value: 'ep4-new-topic' } });
    fireEvent.click(screen.getByRole('button', { name: '创建剪辑单元' }));
    await loaded('ep4-new-topic');
    expect(screen.getByText('已有剪辑单元（4）')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: '剪辑规则' })).toHaveValue('travel-vlog');
    expect(units.slice(0, 3).map(unit => unit.editId)).toEqual(ids);
    expect(requests.filter(([, method]) => method !== 'GET')).toEqual([['/api/projects/trip/config/edit-unit?editId=ep4-new-topic', 'PUT']]);
  });
  it('falls back from missing saved units without borrowing another project\'s ID', () => {
    expect(resolveProjectEditId(units, 'gone', 'main')).toBe(ids[0]);
    expect(resolveProjectEditId([], ids[0], ids[1])).toBe('main');
    expect(editSelectionStorageKey('trip')).not.toBe(editSelectionStorageKey('other'));
  });
});
