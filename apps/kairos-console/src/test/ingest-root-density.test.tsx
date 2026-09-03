import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { ProjectBriefEditor } from '../workspace-forms.jsx';

afterEach(cleanup);

describe('ingest material root density', () => {
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
        summaries={[]}
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
  });
});
