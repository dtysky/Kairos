import React from 'react';
import { Button } from '../ui-compat.tsx';

export function resolveSnapshotStatusLabel(attempt, localError, busy) {
  if (busy) return '工程备份中…';
  if (localError || attempt?.status === 'failed') return '最近备份失败';
  if (attempt?.status === 'running') return '上次备份尝试未结束';
  if (attempt?.status === 'succeeded') return '最近备份成功';
  return '';
}

export function ResolveSnapshotStatus({ attempt, latestSnapshot, localError, retryMode, retryRetention, busy, disabled, onRetry }) {
  const label = resolveSnapshotStatusLabel(attempt, localError, busy);
  if (!label) return null;
  const failure = Boolean(localError || attempt?.status === 'failed');
  const mode = retryMode || attempt?.mode;
  return (
    <div role={failure ? 'alert' : 'status'} className={`edit-resolve-relink-summary ${failure ? 'edit-resolve-relink-summary-error' : ''}`}>
      <strong>{label}</strong>
      {attempt ? <span>{attempt.mode === 'auto' ? '自动备份' : attempt.mode === 'external' ? '外部登记' : '手动备份'} · {attempt.finishedAt || attempt.startedAt}</span> : null}
      {failure ? <span>{localError || attempt?.error?.message}</span> : null}
      {failure && attempt?.error?.code ? <span>{attempt.error.code}</span> : null}
      {failure ? <span>{latestSnapshot ? `最后成功备份：${latestSnapshot.createdAt}；此次失败未更新成功记录。` : '尚无成功的工程备份。'}</span> : null}
      {attempt?.status === 'running' && !busy ? <span>尚未收到结束结果；这条记录不代表任务仍在运行。</span> : null}
      {failure && mode === 'external' ? <span>请核对外部 DRP 路径后重新登记。</span> : null}
      {failure && mode !== 'external' && onRetry ? (
        <Button disabled={disabled || busy} onClick={() => onRetry({ retention: retryRetention || attempt?.retention || 'latest-only' })}>
          重试工程备份
        </Button>
      ) : null}
    </div>
  );
}
