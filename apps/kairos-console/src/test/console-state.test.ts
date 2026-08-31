import { describe, expect, it } from 'vitest';
import { isProjectSwitchBlocked } from '../app-state';

describe('project switching guard', () => {
  it('blocks switching only when a section is dirty', () => {
    expect(isProjectSwitchBlocked([])).toBe(false);
    expect(isProjectSwitchBlocked(['project-config'])).toBe(true);
  });
});
