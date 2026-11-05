import React from 'react';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { ColorCurrentSummary } from '../workspace-forms.jsx';
afterEach(cleanup);
it('edits explicit RCM input without losing analysis proxy LUT or other root settings', () => {
  let saved: any;
  function Editor() {
    const [projectBrief, setProjectBrief] = React.useState({ name: 'Test', mappings: [
      { rootId: 'camera', path: '/target', rawPath: '/raw', color: { colorSpaceProfile: 'slog3', transformPresetKey: 'Sony/Log.cube' } },
    ] });
    saved = projectBrief;
    return <ColorCurrentSummary config={{ projectBrief }} setProjectBrief={setProjectBrief} />;
  }
  const view = render(<Editor />);
  const field = view.getByLabelText('RCM 输入空间（元数据缺失时）');
  fireEvent.change(field, { target: { value: 'S-Gamut3.Cine/S-Log3' } });
  expect(saved.mappings[0].color).toEqual({ colorSpaceProfile: 'slog3', transformPresetKey: 'Sony/Log.cube', inputColorSpace: 'S-Gamut3.Cine/S-Log3' });
  fireEvent.change(field, { target: { value: '' } });
  expect(saved.mappings[0].color.inputColorSpace).toBe('');
});
