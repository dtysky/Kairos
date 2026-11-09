import React from 'react';
import { cleanup, fireEvent, render, within } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { ColorCurrentSummary } from '../workspace-forms.jsx';
afterEach(cleanup);
const mappings = [
  { rootId: 'sony', label: 'Sony', path: '/target/sony', rawPath: '/raw/sony', color: { colorSpaceProfile: 'slog3', inputColorSpace: 'S-Gamut3.Cine/S-Log3', transformPresetKey: 'Sony/Log.cube', renderPreset: { videoCodec: 'h265', bitrateKbps: 30000 } } },
  { rootId: 'dji', label: 'DJI', path: '/target/dji', rawPath: '/raw/dji', color: { colorSpaceProfile: 'dlog', transformPresetKey: 'DJI/Log.cube', renderPreset: { videoCodec: 'h265', bitrateKbps: 60000 } } },
  { rootId: 'disabled', enabled: false, path: '/disabled', rawPath: '/raw/disabled', color: { renderPreset: { bitrateKbps: 1000 } } },
  { rootId: 'extra', path: '/extra' },
];
function setup() {
  let saved: any;
  function Editor() {
    const [projectBrief, setProjectBrief] = React.useState({ name: 'Test', mappings }); saved = projectBrief;
    return <ColorCurrentSummary config={{ projectBrief }} setProjectBrief={setProjectBrief} />;
  }
  const view = render(<Editor />);
  fireEvent.click(view.getByRole('tab', { name: '项目设置' }));
  return { view, get saved() { return saved; } };
}
it('edits only the selected directory output and preserves all other source settings', () => {
  const state = setup();
  const sony = within(state.view.getByRole('group', { name: 'Sony' }));
  const dji = within(state.view.getByRole('group', { name: 'DJI' }));
  expect(sony.getByLabelText('视频码率 (kb/s)')).toHaveValue(30000);
  expect(dji.getByLabelText('视频码率 (kb/s)')).toHaveValue(60000);
  fireEvent.change(sony.getByLabelText('视频码率 (kb/s)'), { target: { value: '45000' } });
  fireEvent.change(sony.getByLabelText('视频编码'), { target: { value: 'h264' } });
  expect(state.saved.mappings[0].color.renderPreset).toEqual({ videoCodec: 'h264', bitrateKbps: 45000 });
  expect(state.saved.mappings[0].color.inputColorSpace).toBe('S-Gamut3.Cine/S-Log3');
  expect(state.saved.mappings[0].color.transformPresetKey).toBe('Sony/Log.cube');
  expect(state.saved.mappings.slice(1)).toEqual(mappings.slice(1));
  fireEvent.change(dji.getByLabelText('视频码率 (kb/s)'), { target: { value: '80000' } });
  expect(state.saved.mappings[0].color.renderPreset.bitrateKbps).toBe(45000);
  expect(state.saved.mappings[1].color.renderPreset.bitrateKbps).toBe(80000);
  expect(state.saved.mappings[1].color.transformPresetKey).toBe('DJI/Log.cube');
});
it('shows per-directory values without merging them and retains drafts across tabs', () => {
  const state = setup();
  expect(state.saved.mappings).toEqual(mappings);
  expect(state.view.queryByText('统一输出设置')).not.toBeInTheDocument();
  const sony = within(state.view.getByRole('group', { name: 'Sony' }));
  expect(sony.getByText('输入色彩与路径').closest('details')).not.toHaveAttribute('open');
  fireEvent.change(sony.getByLabelText('视频码率 (kb/s)'), { target: { value: '50000' } });
  fireEvent.click(state.view.getByRole('tab', { name: '分组与素材' }));
  fireEvent.click(state.view.getByRole('tab', { name: '项目设置' }));
  expect(within(state.view.getByRole('group', { name: 'Sony' })).getByLabelText('视频码率 (kb/s)')).toHaveValue(50000);
  expect(within(state.view.getByRole('group', { name: 'DJI' })).getByLabelText('视频码率 (kb/s)')).toHaveValue(60000);
});
it('keeps explicit RCM exceptions source-specific without modifying analysis LUTs', () => {
  const state = setup();
  fireEvent.click(within(state.view.getByRole('group', { name: 'Sony' })).getByText('输入色彩与路径'));
  const field = state.view.getByLabelText('RCM 输入空间（元数据缺失时） · Sony');
  fireEvent.change(field, { target: { value: '' } });
  expect(state.saved.mappings[0].color.inputColorSpace).toBe('');
  expect(state.saved.mappings[0].color.transformPresetKey).toBe('Sony/Log.cube');
  expect(state.saved.mappings[1]).toEqual(mappings[1]);
});
