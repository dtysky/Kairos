import { describe, expect, it } from 'vitest';
import { isLiveSupervisorJob, pickConsoleProjectId, resolveCurrentStyleCategory } from '../main.jsx';

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
});
