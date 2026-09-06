import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  TranscriptCorrectionReviewPanel,
  SpeechTranscriptReviewPanel,
  TranscriptGlossaryEditor,
} from '../workspace-forms.jsx';

afterEach(cleanup);

describe('transcript review UI', () => {
  it('edits glossary entries in a drawer-backed compact table', () => {
    function Harness() {
      const [config, setConfig] = React.useState({ schemaVersion: '3.0', entries: [] });
      return <TranscriptGlossaryEditor config={config} setConfig={setConfig} onSave={() => {}} busy={false} />;
    }
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: '新增词条' }));
    fireEvent.change(screen.getByLabelText('正确写法'), { target: { value: '瞬光' } });
    fireEvent.change(screen.getByLabelText('使用语境'), { target: { value: '自我介绍、人物介绍时' } });
    fireEvent.click(screen.getByRole('button', { name: '应用到草稿' }));
    expect(screen.getByText('瞬光')).toBeInTheDocument();
    expect(screen.getAllByText('自我介绍、人物介绍时').length).toBeGreaterThan(0);
  });

  it('offers suggested, original, and manual transcript decisions from a drawer', () => {
    const onResolve = vi.fn();
    function Harness() {
      const [reviews, setReviews] = React.useState([{
        id: 'review-1',
        kind: 'transcript-correction',
        stage: 'chronology',
        status: 'open',
        title: '字幕校对 · asset-1',
        currentValue: { originalText: '野猪掌', evidence: 'pharos: 野猪嶂', context: '野猪嶂' },
        suggestedValue: { suggestedText: '野猪嶂' },
        fields: [{ key: 'finalText', label: '最终文本', value: '野猪掌', suggestedValue: '野猪嶂' }],
      }]);
      return <TranscriptCorrectionReviewPanel reviews={reviews} setReviews={setReviews} onResolve={onResolve} />;
    }
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: /确\s*认/u }));
    expect(screen.getByText('ASR 原文')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /采\s*用\s*建\s*议/u }));
    expect(onResolve).toHaveBeenCalledWith('review-1', {
      finalText: '野猪嶂',
      promoteToGlossary: false,
    });
  });

  it('shows each actionable category in a separate table and accepts suggestions by default', () => {
    const onSubmit = vi.fn();
    const review = {
      inputsHash: 'hash',
      updatedAt: '2026-09-06T00:00:00.000Z',
      status: 'pending-human',
      items: [
        { id: 'text-1', category: 'transcript-suggested-correction', selection: 'accepted', assetId: 'C1', spanIds: ['C1_speech'], startMs: 0, endMs: 1000, originalText: '顺光', suggestedText: '瞬光', reason: '词表语境匹配' },
        { id: 'window-1', category: 'speech-window-suggested-cancel', selection: 'accepted', assetId: 'C2', spanIds: ['C2_speech'], startMs: 0, endMs: 2000, originalText: '背景歌词', reason: '非人物口播' },
        { id: 'trim-1', category: 'speech-window-suggested-trim', selection: 'accepted', assetId: 'C3', spanIds: ['C3_speech'], startMs: 0, endMs: 2000, retainStartMs: 0, retainEndMs: 1000, originalText: '保留这一句 删除这一句', suggestedText: '保留这一句', transcriptSegments: [{ startMs: 0, endMs: 1000, text: '保留这一句' }, { startMs: 1000, endMs: 2000, text: '删除这一句' }], reason: '移除尾部噪声' },
      ],
    };
    render(<SpeechTranscriptReviewPanel projectId="trip" review={review} onSubmit={onSubmit} />);
    expect(screen.getByRole('heading', { name: '字幕｜建议修正' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '口播窗口｜建议取消' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '口播窗口｜建议裁切' })).toBeInTheDocument();
    expect(screen.getByText('裁切后口播')).toBeInTheDocument();
    expect(screen.queryByText('保持原文')).not.toBeInTheDocument();
    expect(screen.getByLabelText('text-1 最终文本').tagName).toBe('TEXTAREA');
    const checkboxes = screen.getAllByRole('checkbox');
    for (const checkbox of checkboxes) expect(checkbox).toBeChecked();
    fireEvent.click(checkboxes[0]);
    fireEvent.click(screen.getByRole('button', { name: '提交整轮审查' }));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      inputsHash: 'hash',
      resolutions: expect.arrayContaining([
        expect.objectContaining({ itemId: 'text-1', selection: 'rejected' }),
        expect.objectContaining({ itemId: 'window-1', selection: 'accepted' }),
      ]),
    }));
  });

  it('keeps only transcript listening rows in the human review UI', () => {
    const onSubmit = vi.fn();
    const review = {
      inputsHash: 'hash',
      updatedAt: '2026-09-06T00:00:00.000Z',
      status: 'pending-human',
      items: [
        { id: 'listen-1', category: 'transcript-needs-listening', selection: 'unresolved', assetId: 'C1', spanIds: ['C1_speech'], startMs: 0, endMs: 1000, originalText: '野猪掌', suggestedText: '野猪嶂', reason: '需听音确认' },
        { id: 'window-listen-1', category: 'speech-window-needs-listening', selection: 'unresolved', assetId: 'C2', spanIds: ['C2_speech'], startMs: 0, endMs: 2000, originalText: '一段待确认口播', reason: '需听音确认窗口' },
      ],
    };
    render(<SpeechTranscriptReviewPanel projectId="trip" review={review} onSubmit={onSubmit} />);
    expect(screen.getByRole('button', { name: '循环播放' })).toBeInTheDocument();
    expect(screen.getByText('前后各 1 秒')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '口播窗口｜需人工听音' })).not.toBeInTheDocument();
    expect(screen.queryByText('保留原文')).not.toBeInTheDocument();
    expect(screen.queryByText('采用／手动修正')).not.toBeInTheDocument();
    const submit = screen.getByRole('button', { name: '提交整轮审查' });
    expect(submit).toBeDisabled();
    fireEvent.click(screen.getByLabelText('listen-1 审查完成'));
    expect(submit).toBeEnabled();
    fireEvent.click(submit);
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      resolutions: [expect.objectContaining({ itemId: 'listen-1', selection: 'accepted', finalText: '野猪嶂' })],
    }));
  });

  it('migrates a legacy keep-original listening choice into completed original text', () => {
    const onSubmit = vi.fn();
    const review = {
      inputsHash: 'hash',
      updatedAt: '2026-09-06T00:00:00.000Z',
      status: 'pending-human',
      items: [
        { id: 'legacy-listen', category: 'transcript-needs-listening', selection: 'rejected', assetId: 'C1', spanIds: ['C1_speech'], startMs: 0, endMs: 1000, originalText: '阳朔', suggestedText: '杨硕', finalText: '杨硕', reason: '旧草稿' },
      ],
    };
    render(<SpeechTranscriptReviewPanel projectId="trip" review={review} onSubmit={onSubmit} />);
    expect(screen.getByLabelText('legacy-listen 审查完成')).toBeChecked();
    expect(screen.getByLabelText('legacy-listen 最终文本')).toHaveValue('阳朔');
    fireEvent.click(screen.getByRole('button', { name: '提交整轮审查' }));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      resolutions: [expect.objectContaining({ itemId: 'legacy-listen', selection: 'accepted', finalText: '阳朔' })],
    }));
  });

  it('autosaves draft choices and restores the server-backed selection after refresh', async () => {
    const onSaveDraft = vi.fn().mockResolvedValue({ status: 'pending-human' });
    const item = { id: 'text-1', category: 'transcript-suggested-correction', selection: 'accepted', assetId: 'C1', spanIds: ['C1_speech'], startMs: 0, endMs: 1000, originalText: '顺光', suggestedText: '瞬光', reason: '词表语境匹配' };
    const review = { inputsHash: 'hash', updatedAt: '2026-09-06T00:00:00.000Z', status: 'pending-human', items: [item] };
    render(<SpeechTranscriptReviewPanel projectId="trip" review={review} onSaveDraft={onSaveDraft} onSubmit={() => {}} />);
    fireEvent.click(screen.getByRole('checkbox'));
    expect(screen.getByText('草稿保存中')).toBeInTheDocument();
    await waitFor(() => expect(onSaveDraft).toHaveBeenCalledWith(expect.objectContaining({
      inputsHash: 'hash',
      resolutions: [expect.objectContaining({ itemId: 'text-1', selection: 'rejected' })],
    })), { timeout: 2000 });
    await waitFor(() => expect(screen.getByText('草稿已保存')).toBeInTheDocument());

    cleanup();
    render(<SpeechTranscriptReviewPanel projectId="trip" review={{ ...review, updatedAt: '2026-09-06T00:01:00.000Z', items: [{ ...item, selection: 'rejected' }] }} onSaveDraft={onSaveDraft} onSubmit={() => {}} />);
    expect(screen.getByRole('checkbox')).not.toBeChecked();
  });
});
