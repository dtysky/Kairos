import React, { useState } from 'react';
import { fireEvent, render, screen, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LlmConfigEditor } from '../components/llm-config-editor.jsx';

const saved = { backend: 'openai', openai: { model: 'gpt-6-luna', reasoningEffort: 'high', baseUrl: 'https://api.openai.com/v1', maxOutputTokens: 32768, timeoutMs: 180000, apiKeyConfigured: true, apiKeySource: 'config' } };
afterEach(cleanup);

describe('LLM global settings', () => {
  it('uses a blank password field for saved credentials and stages explicit removal until save', () => {
    const onSave = vi.fn();
    function Harness() {
      const [config, setConfig] = useState<any>(saved);
      return <LlmConfigEditor config={config} setConfig={setConfig} onSave={() => onSave(config)} busy={false} />;
    }
    render(<Harness />);
    const keyInput = screen.getByLabelText('OpenAI API Key');
    expect(keyInput).toHaveAttribute('type', 'password');
    expect(keyInput).toHaveValue('');
    expect(screen.getByText('已保存 Key')).toBeInTheDocument();
    expect(screen.getByLabelText('模型')).toHaveValue('gpt-6-luna');
    fireEvent.change(keyInput, { target: { value: 'new-test-key' } });
    expect(screen.getByText('待保存新 Key')).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '清除已保存 Key' }));
    expect(screen.getByText('保存后清除本机 Key')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^保\s*存$/u }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ openai: expect.objectContaining({ apiKey: null }) }));
  });

  it('does not render a saved secret and clears the draft when a save response replaces it', () => {
    const props = { setConfig: vi.fn(), onSave: vi.fn(), busy: false };
    const { rerender } = render(<LlmConfigEditor {...props} config={{ ...saved, openai: { ...saved.openai, apiKey: 'draft-test-key' } }} />);
    expect(screen.getByLabelText('OpenAI API Key')).toHaveValue('draft-test-key');
    rerender(<LlmConfigEditor {...props} config={saved} />);
    expect(screen.getByLabelText('OpenAI API Key')).toHaveValue('');
    rerender(<LlmConfigEditor {...props} config={{ ...saved, backend: 'local' }} />);
    expect(screen.queryByLabelText('OpenAI API Key')).not.toBeInTheDocument();
    expect(screen.getByText('LLM 全局配置')).toBeInTheDocument();
  });
});
