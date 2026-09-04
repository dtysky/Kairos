import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AsrConfigEditor } from '../workspace-forms.jsx';

describe('ASR global config', () => {
  it('only exposes the backend choice while keeping discovered paths read-only', () => {
    render(
      <AsrConfigEditor
        config={{ backend: 'qwen3' }}
        setConfig={vi.fn()}
        onSave={vi.fn()}
        busy={false}
        runtime={{
          configuredBackend: 'qwen3',
          actualBackend: 'qwen3',
          available: false,
          modelRef: '/workspace/models/Qwen3-ASR',
          alignerModelRef: '/workspace/models/Qwen3-Aligner',
          blocker: '缺少 mlx-audio 依赖',
          runtimeVariant: 'transformers-cuda',
          device: 'cuda',
        }}
      />,
    );

    expect(screen.getByText('ASR 全局配置')).toBeInTheDocument();
    expect(screen.getByText('语音识别')).toBeInTheDocument();
    expect(screen.queryByText('识别语言')).not.toBeInTheDocument();
    expect(screen.queryByText(/模型目录/u)).not.toBeInTheDocument();
    expect(screen.queryByText(/单段上限/u)).not.toBeInTheDocument();
    expect(screen.getByText('/workspace/models/Qwen3-ASR')).toBeInTheDocument();
    expect(screen.getByText('/workspace/models/Qwen3-Aligner')).toBeInTheDocument();
    expect(screen.getByText('transformers-cuda')).toBeInTheDocument();
    expect(screen.getByText('cuda')).toBeInTheDocument();
    expect(screen.getByText('运行阻塞')).toBeInTheDocument();
    expect(screen.getByText('缺少 mlx-audio 依赖')).toBeInTheDocument();
    expect(screen.getByText(/不会静默切换/u)).toBeInTheDocument();
    expect(screen.getByText(/不会注入热词/u)).toBeInTheDocument();
  });
});
