import React, { useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { ExtraMediaEditor } from '../workspace-forms.jsx';
afterEach(cleanup);

it('edits the independent root and permits import without analysis or chronology', () => {
  const run = vi.fn();
  const windowsPath = String.raw`F:\vlog-proj\20260924_中秋国庆闽赣自驾\additional`;
  function Editor() {
    const [config, setConfig] = useState({ extraMedia: { rootId: 'extra', path: '/media/extra', alternatePaths: [{ path: windowsPath }] } });
    return <ExtraMediaEditor config={config} setConfig={setConfig} projectId="trip" onImport={() => run(config)} />;
  }
  const { container } = render(<Editor />);
  fireEvent.click(container.querySelector('.structured-root-summary'));
  fireEvent.change(screen.getByLabelText('路径'), { target: { value: 'D:/media/extra' } });
  const alternatives = within(screen.getByRole('region', { name: '备选路径' }));
  expect(alternatives.getByLabelText('备选路径')).toHaveValue(windowsPath);
  fireEvent.click(alternatives.getByRole('button', { name: /新\s*增/ }));
  fireEvent.change(alternatives.getAllByLabelText('备选路径')[1], { target: { value: '/Volumes/SSD/extra' } });
  fireEvent.click(alternatives.getAllByRole('button', { name: /上\s*移/ })[1]);
  expect(alternatives.getAllByLabelText('备选路径')[0]).toHaveValue('/Volumes/SSD/extra');
  fireEvent.click(alternatives.getAllByRole('button', { name: /下\s*移/ })[0]);
  fireEvent.click(alternatives.getByRole('button', { name: /新\s*增/ }));
  fireEvent.click(alternatives.getAllByRole('button', { name: /删\s*除/ })[2]);
  expect(container.querySelectorAll('.alternate-path-row')).toHaveLength(2);
  expect(alternatives.queryByRole('textbox', { name: /每行/ })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '保存并导入额外素材到 Resolve' }));
  expect(run).toHaveBeenCalledWith({ extraMedia: { rootId: 'extra', path: 'D:/media/extra', alternatePaths: [
    { path: windowsPath }, { path: '/Volumes/SSD/extra' },
  ] } });
});

it('shows matching live progress and completed import/reuse results', () => {
  const job = { jobId: 'extra-1', jobType: 'resolve-extra-media-sync', projectId: 'trip', status: 'running',
    progress: { phaseLabel: '同步素材', current: 20, total: 100, fileName: 'day1/test.mp4', extra: { jobId: 'extra-1', imported: 2, reused: 18 } } };
  const props = { config: { extraMedia: { path: '/extra' } }, setConfig: vi.fn(), projectId: 'trip', onImport: vi.fn() };
  const view = render(<ExtraMediaEditor {...props} jobs={[job]} />);
  expect(screen.getByText('20 / 100 个素材')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '额外素材导入中…' })).toBeDisabled();
  view.rerender(<ExtraMediaEditor {...props} jobs={[{ ...job, status: 'completed', progress: null, result: { hostSummary: { imported: 2, reused: 98 } } }]} />);
  expect(screen.getByText('新增 2 · 复用 98')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '保存并导入额外素材到 Resolve' })).toBeEnabled();
});
