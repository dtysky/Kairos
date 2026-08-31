import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { MonitorPage } from '../monitor-page.jsx';

afterEach(cleanup);

function buildModel(status = 'completed') {
  return {
    title: '素材分析',
    subtitle: '测试监控',
    progress: { status, current: 1, total: 1 },
    metrics: [],
    pipelines: [],
    stepDefinitions: [],
    sections: [{ title: '并发详情', items: [{ label: '队列', value: '0' }] }],
    outputs: [{ label: '资产报告目录', description: '正式分析结果', path: '/tmp/asset-reports', exists: true }],
    raw: {},
  };
}

describe('monitor information density', () => {
  it('keeps completed runtime detail and output paths collapsed by default', () => {
    render(<MonitorPage model={buildModel()} emptyLabel="" toolbar={null} afterMonitor={null} />);

    expect(screen.getByText('运行详情').closest('details')).not.toHaveAttribute('open');
    expect(screen.getByText('完成产物').closest('details')).not.toHaveAttribute('open');
  });

  it('opens runtime detail only while the job is live', () => {
    render(<MonitorPage model={buildModel('running')} emptyLabel="" toolbar={null} afterMonitor={null} />);

    expect(screen.getByText('运行详情').closest('details')).toHaveAttribute('open');
    expect(screen.getByText('完成产物').closest('details')).not.toHaveAttribute('open');
  });
});
