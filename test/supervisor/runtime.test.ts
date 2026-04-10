import { describe, expect, it } from 'vitest';
import {
  shouldReuseExistingMlService,
  shouldStopExistingMlService,
} from '../../src/supervisor/runtime.js';

describe('supervisor runtime ML lifecycle helpers', () => {
  it('reuses an existing listener only when a healthy Kairos ML endpoint is present', () => {
    expect(shouldReuseExistingMlService({
      listenerPid: 654,
      health: {
        status: 'ok',
        device: 'mps',
      },
    })).toBe(true);

    expect(shouldReuseExistingMlService({
      listenerPid: 654,
      health: null,
    })).toBe(false);

    expect(shouldReuseExistingMlService({
      listenerPid: null,
      health: {
        status: 'ok',
      },
    })).toBe(false);
  });

  it('stops only tracked or health-verified Kairos ML listeners', () => {
    expect(shouldStopExistingMlService({
      recordListenerPid: 321,
      listenerPid: 321,
      health: null,
    })).toBe(true);

    expect(shouldStopExistingMlService({
      recordListenerPid: undefined,
      listenerPid: 321,
      health: {
        status: 'ok',
      },
    })).toBe(true);

    expect(shouldStopExistingMlService({
      recordListenerPid: undefined,
      listenerPid: 321,
      health: null,
    })).toBe(false);
  });
});
