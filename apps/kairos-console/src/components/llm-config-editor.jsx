import React from 'react';
import { Input, InputNumber, Select } from 'antd';
import { Button, Card, Tag } from '../ui-compat.tsx';
import { SectionHeader } from '../workspace-forms.jsx';

export function LlmConfigEditor({ config, setConfig, onSave, busy }) {
  if (!config) return null;
  const openai = config.openai;
  const updateOpenai = patch => setConfig(current => ({ ...current, openai: { ...current.openai, ...patch } }));
  const keyState = openai.apiKey === null ? '保存后清除本机 Key'
    : openai.apiKey?.trim() ? '待保存新 Key'
      : openai.apiKeySource === 'environment' ? '使用服务端环境变量'
        : openai.apiKeyConfigured ? '已保存 Key' : '尚未配置 Key';

  return (
    <Card className="panel llm-config-panel">
      <SectionHeader title="LLM 全局配置" onSave={onSave} busy={busy} />
      <p className="muted">用于所有项目的素材视觉分析，保存后对后续作业生效。选择 OpenAI 会将分析帧发送到所配置的 API；现有分析结果保持可用。</p>
      <div className="llm-config-grid">
        <label><span>视觉分析后端</span><Select aria-label="视觉分析后端" value={config.backend} disabled={busy}
          onChange={backend => setConfig(current => ({ ...current, backend }))}
          options={[{ value: 'local', label: '本地 VLM' }, { value: 'openai', label: 'OpenAI' }]} /></label>
      </div>
      {config.backend === 'openai' ? <>
        <div className="llm-config-grid">
          <label><span>模型</span><Input aria-label="模型" value={openai.model} disabled={busy} onChange={event => updateOpenai({ model: event.target.value })} /></label>
          <label><span>推理级别</span><Select aria-label="推理级别" value={openai.reasoningEffort} disabled={busy}
            onChange={reasoningEffort => updateOpenai({ reasoningEffort })}
            options={['none', 'low', 'medium', 'high', 'xhigh', 'max'].map(value => ({ value, label: value }))} /></label>
          <label><span>OpenAI API Key</span><Input.Password aria-label="OpenAI API Key" autoComplete="new-password" value={openai.apiKey ?? ''} disabled={busy}
            placeholder="输入以替换，留空保留已保存的 Key" onChange={event => updateOpenai({ apiKey: event.target.value })} /></label>
        </div>
        <div className="actions"><Tag>{keyState}</Tag>
          <Button disabled={busy || openai.apiKeySource !== 'config'} onClick={() => updateOpenai({ apiKey: null })}>清除已保存 Key</Button>
        </div>
        <details>
          <summary>API 高级配置</summary>
          <div className="llm-config-grid">
            <label><span>API Base URL</span><Input aria-label="API Base URL" value={openai.baseUrl} disabled={busy} onChange={event => updateOpenai({ baseUrl: event.target.value })} /></label>
            <label><span>输出总预算（含推理 tokens）</span><InputNumber aria-label="输出总预算" min={1024} max={128000} value={openai.maxOutputTokens} disabled={busy} onChange={maxOutputTokens => updateOpenai({ maxOutputTokens })} /></label>
            <label><span>单次请求超时（秒）</span><InputNumber aria-label="单次请求超时" min={1} max={600} value={openai.timeoutMs / 1000} disabled={busy} onChange={seconds => updateOpenai({ timeoutMs: seconds == null ? null : seconds * 1000 })} /></label>
          </div>
        </details>
      </> : null}
    </Card>
  );
}
