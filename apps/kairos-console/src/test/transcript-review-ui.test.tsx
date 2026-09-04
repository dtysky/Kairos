import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import {
  TranscriptCorrectionReviewPanel,
  TranscriptGlossaryEditor,
} from '../workspace-forms.jsx';

afterEach(cleanup);

describe('transcript review UI', () => {
  it('edits glossary entries in a drawer-backed compact table', () => {
    function Harness() {
      const [config, setConfig] = React.useState({ schemaVersion: '2.0', entries: [] });
      return <TranscriptGlossaryEditor config={config} setConfig={setConfig} onSave={() => {}} busy={false} />;
    }
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: '新增词条' }));
    fireEvent.change(screen.getByLabelText('正确写法'), { target: { value: '瞬光' } });
    fireEvent.change(screen.getByLabelText(/发音/u), { target: { value: 'shùn guāng' } });
    fireEvent.change(screen.getByLabelText('使用语境'), { target: { value: '自我介绍、人物介绍时' } });
    fireEvent.click(screen.getByRole('button', { name: '应用到草稿' }));
    expect(screen.getByText('瞬光')).toBeInTheDocument();
    expect(screen.getByText('shùn guāng')).toBeInTheDocument();
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
});
