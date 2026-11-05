import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { ProjectBriefEditor } from '../workspace-forms.jsx';

afterEach(cleanup);

describe('ingest material root density', () => {
  it('preserves the linked Pharos directory when editing its trip filter', () => {
    let saved: any;
    function Editor() {
      const [config, setConfig] = React.useState({
        name: '测试项目', description: '', createdAt: '2026-09-01', mappings: [],
        pharos: { sourcePath: '/pharos/original', includedTripIds: ['trip-1'] },
        materialPatternPhrases: [],
      });
      saved = config;
      return <ProjectBriefEditor config={config} setConfig={setConfig} onSave={() => {}} busy={false} />;
    }
    const view = render(<Editor />);
    fireEvent.change(view.getByLabelText('Pharos 工程目录（可留空）'), { target: { value: '/pharos/linked' } });
    expect(saved.pharos).toEqual({ sourcePath: '/pharos/linked', includedTripIds: ['trip-1'] });
    fireEvent.change(view.getByLabelText('包含 Trip（每行一个，可留空表示全部纳入）'), { target: { value: 'trip-2\ntrip-3' } });
    expect(saved.pharos).toEqual({ sourcePath: '/pharos/linked', includedTripIds: ['trip-2', 'trip-3'] });
  });

  it('renders alternate paths as compact rows inside one root editor', () => {
    const { container } = render(
      <ProjectBriefEditor
        config={{
          name: '测试项目',
          description: '',
          createdAt: '2026-09-01',
          pharos: { includedTripIds: [] },
          mappings: [{
            rootId: 'root-1',
            rootCode: 'zve1',
            path: '/media/zve1',
            rawPath: '/raw/zve1',
            description: '主素材',
            alternatePaths: [
              { path: '/backup-1/zve1', rawPath: '/backup-1/raw/zve1' },
              { path: '/backup-2/zve1', rawPath: '/backup-2/raw/zve1' },
            ],
          }],
          voiceoverMedia: null,
          audioMedia: null,
          materialPatternPhrases: [],
        }}
        pharosStatus={{ status: 'empty', rootPath: '/project/pharos' }}
        summaries={[{ rootId: 'root-1', versionSummary: { paired: 54, targetOnly: 46, rawOnly: 3, unavailable: 0, analysisBlocked: 1 } }]}
        setConfig={() => {}}
        onSave={() => {}}
        busy={false}
      />,
    );

    const root = container.querySelector<HTMLDetailsElement>('.structured-root-details');
    expect(root).not.toBeNull();
    fireEvent.click(root!.querySelector('summary')!);
    expect(root!.open).toBe(true);
    expect(root!.querySelectorAll('.alternate-path-row')).toHaveLength(2);
    expect(root!.querySelector('.alternate-path-card')).toBeNull();
    expect(root!.querySelector('.structured-root-description textarea')).toHaveAttribute('rows', '2');
    expect(root!.textContent).toContain('原片＋目标 54 · 仅目标 46 · 仅原片 3 · 不可用 0 · 分析待处理 1');
  });
});
