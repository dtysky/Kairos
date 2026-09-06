import { describe, expect, it } from 'vitest';
import {
  isLiveSupervisorJob,
  normalizeAnalyzeAsrLifecycleForDisplay,
  pickConsoleProjectId,
  resolveChronologyPipelineStages,
  resolveChronologyNextStep,
  resolveCurrentStyleCategory,
  selectChronologyJobsForDisplay,
} from '../main.jsx';

describe('runtime truth', () => {
  it('does not treat durable or blocked state as a live job', () => {
    expect(isLiveSupervisorJob({ status: 'running' })).toBe(true);
    expect(isLiveSupervisorJob({ status: 'queued' })).toBe(true);
    expect(isLiveSupervisorJob({ status: 'blocked' })).toBe(false);
    expect(isLiveSupervisorJob({ status: 'completed' })).toBe(false);
  });

  it('keeps the stored project before falling back to the active job owner', () => {
    const projects = [{ projectId: 'a' }, { projectId: 'b' }];
    const jobs = [{ projectId: 'b', status: 'running', updatedAt: '2026-08-31T12:00:00Z' }];
    expect(pickConsoleProjectId(projects, jobs, 'a')).toBe('a');
    expect(pickConsoleProjectId(projects, jobs, '')).toBe('b');
  });

  it('keeps Style scoped to one explicit or live category', () => {
    const config = { categories: [{ categoryId: 'travel' }, { categoryId: 'city' }] };
    expect(resolveCurrentStyleCategory(config, '?categoryId=city', [])).toBe('city');
    expect(resolveCurrentStyleCategory(config, '', [{ jobType: 'style-analysis', status: 'running', args: { categoryId: 'travel' } }])).toBe('travel');
  });

  it('renders a stopped Qwen worker as released after Analyze leaves audio analysis', () => {
    const model = normalizeAnalyzeAsrLifecycleForDisplay({
      asr: {
        configuredBackend: 'qwen3',
        actualBackend: 'qwen3',
        available: false,
        blocker: 'Qwen ASR worker unavailable: connection refused',
      },
      latestJob: { jobType: 'analyze', status: 'running' },
      progress: { stepKey: 'finalize' },
      chips: [{ label: 'ASR qwen3', tone: 'error' }],
    });

    expect(model.asr.lifecycle).toBe('released');
    expect(model.asr.blocker).toBeNull();
    expect(model.asr.statusDetail).toContain('释放显存');
    expect(model.chips[0].tone).toBe('ok');
  });

  it('keeps a Qwen worker failure blocking while audio analysis still needs it', () => {
    const source = {
      asr: {
        configuredBackend: 'qwen3',
        actualBackend: 'qwen3',
        available: false,
        blocker: 'Qwen ASR worker unavailable: connection refused',
      },
      latestJob: { jobType: 'analyze', status: 'running' },
      progress: { stepKey: 'audio-analysis' },
      chips: [{ label: 'ASR qwen3', tone: 'error' }],
    };

    expect(normalizeAnalyzeAsrLifecycleForDisplay(source)).toBe(source);
  });

  it('keeps only the latest unresolved chronology failure beside live jobs', () => {
    const jobs = [
      { jobId: 'old-failure', projectId: 'trip', jobType: 'span-rebuild', status: 'failed', updatedAt: '2026-09-05T01:00:00Z' },
      { jobId: 'latest-failure', projectId: 'trip', jobType: 'span-rebuild', status: 'failed', updatedAt: '2026-09-05T02:00:00Z' },
      { jobId: 'live-build', projectId: 'trip', jobType: 'chronology-build', status: 'running', updatedAt: '2026-09-05T03:00:00Z' },
      { jobId: 'other-project', projectId: 'other', jobType: 'span-rebuild', status: 'failed', updatedAt: '2026-09-05T04:00:00Z' },
    ];
    const selected = selectChronologyJobsForDisplay(jobs, 'trip', { status: 'missing' });

    expect(selected.activeJobs.map(job => job.jobId)).toEqual(['live-build']);
    expect(selected.terminalJobs.map(job => job.jobId)).toEqual(['latest-failure']);
    expect(selected.currentJobs.map(job => job.jobId)).toEqual(['live-build', 'latest-failure']);
  });

  it('suppresses an older span failure after a newer spans output exists', () => {
    const selected = selectChronologyJobsForDisplay([{
      jobId: 'failed-span',
      projectId: 'trip',
      jobType: 'span-rebuild',
      status: 'failed',
      updatedAt: '2026-09-05T02:00:00Z',
    }], 'trip', {
      status: 'pending-speech-review',
      meta: { generatedAt: '2026-09-05T03:00:00Z' },
    });

    expect(selected.terminalJobs).toEqual([]);
  });

  it('guides fresh spans without chronology directly to chronology build', () => {
    const nextStep = resolveChronologyNextStep({
      spans: { status: 'fresh', fresh: true, count: 1109 },
      chronology: null,
    });

    expect(nextStep.action).toBe('chronology-build');
    expect(nextStep.title).toContain('1109');
    expect(nextStep.body).toContain('不会重跑素材分析或字幕审查');
  });

  it('guides pending speech spans to the review report before chronology', () => {
    const nextStep = resolveChronologyNextStep({
      spans: {
        status: 'pending-speech-review',
        fresh: false,
        meta: { speechReview: { phase: 'human' } },
      },
      chronology: null,
    });

    expect(nextStep.action).toBe('speech-review');
    expect(nextStep.title).toContain('完成本轮');
    expect(nextStep.detail).toContain('生成编年史');
  });

  it('guides a draft chronology to review and a confirmed chronology to Edit Flow', () => {
    const spans = { status: 'fresh', fresh: true, count: 12 };
    const draftStep = resolveChronologyNextStep({
      spans,
      chronology: { status: 'draft', inputsHash: 'inputs', events: [{ id: 'one' }] },
      eventConsolidation: { status: 'completed', inputsHash: 'inputs' },
    });
    const confirmedStep = resolveChronologyNextStep({
      spans,
      chronology: { status: 'confirmed', events: [{ id: 'one' }] },
    });

    expect(draftStep.action).toBe('review-chronology');
    expect(confirmedStep.action).toBe('edit-flow');
  });

  it('places Agent event consolidation between chronology build and human review', () => {
    const chronology = { status: 'draft', inputsHash: 'inputs', events: [{ id: 'one' }, { id: 'two' }] };
    const nextStep = resolveChronologyNextStep({
      spans: { status: 'fresh', fresh: true, count: 12 },
      chronology,
      eventConsolidation: { status: 'pending-agent', inputsHash: 'inputs', candidateEventCount: 2 },
    });
    const stages = resolveChronologyPipelineStages({
      spans: {
        status: 'fresh',
        fresh: true,
        count: 12,
        materialPatternIntegrity: { expectedCount: 7, completeCount: 12, incompleteCount: 0 },
      },
      chronology,
      eventConsolidation: { status: 'pending-agent', inputsHash: 'inputs', candidateEventCount: 2 },
    });

    expect(nextStep.action).toBe('event-consolidation');
    expect(stages.map(stage => stage.status)).toEqual(['completed', 'completed', 'completed', 'review', 'waiting', 'waiting']);
    expect(stages[3].current).toBe(true);
  });

  it('shows a live chronology stage instead of another start action', () => {
    const nextStep = resolveChronologyNextStep({
      spans: { status: 'fresh', fresh: true },
      chronology: null,
      activeJobs: [{ jobType: 'chronology-build', status: 'running', updatedAt: '2026-09-06T01:00:00Z' }],
    });

    expect(nextStep.key).toBe('running-chronology-build');
    expect(nextStep.action).toBeNull();
    expect(nextStep.title).toBe('正在生成编年史');
  });

  it('places incomplete seven-slot material patterns in the first stage without reopening later stages', () => {
    const stages = resolveChronologyPipelineStages({
      spans: {
        status: 'fresh',
        fresh: false,
        count: 1109,
        materialPatternIntegrity: { expectedCount: 7, completeCount: 1024, incompleteCount: 85 },
        meta: { speechReview: { status: 'completed' } },
      },
      chronology: null,
    });

    expect(stages.map(stage => stage.status)).toEqual(['warning', 'waiting', 'waiting', 'waiting', 'waiting', 'waiting']);
    expect(stages[0].action).toBe('repair-patterns');
    expect(stages[0].actionLabel).toContain('85');
    expect(stages[0].current).toBe(true);
  });

  it('shows each completed prerequisite and makes chronology build the only current action', () => {
    const stages = resolveChronologyPipelineStages({
      spans: {
        status: 'fresh',
        fresh: true,
        count: 1109,
        materialPatternIntegrity: { expectedCount: 7, completeCount: 1109, incompleteCount: 0 },
        meta: { speechReview: { status: 'completed' } },
      },
      chronology: null,
    });

    expect(stages.map(stage => stage.status)).toEqual(['completed', 'completed', 'ready', 'waiting', 'waiting', 'waiting']);
    expect(stages[2].action).toBe('chronology-build');
    expect(stages.filter(stage => stage.current).map(stage => stage.key)).toEqual(['chronology-build']);
  });
});
