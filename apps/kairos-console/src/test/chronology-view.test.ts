import { describe, expect, it } from 'vitest';
import { buildChronologyEventPayload, filterChronologyEvents } from '../chronology-view';

const events = [
  { id: 'e1', kind: 'event', reviewStatus: 'confirmed', day: '2026-08-01', title: '抵达大理', location: '大理市', summary: '进入古城' },
  { id: 'r1', kind: 'route', reviewStatus: 'pending', day: '2026-08-02', title: '环湖公路', route: { from: '大理', to: '洱源' }, summary: '沿洱海北上' },
];

describe('chronology virtual table view model', () => {
  it('combines day, kind, status and search filters', () => {
    expect(filterChronologyEvents(events, { kind: 'route', status: 'pending', day: '2026-08-02', query: '洱源' }, event => event.day)).toEqual([events[1]]);
    expect(filterChronologyEvents(events, { kind: 'event', status: 'all', day: 'all', query: '洱源' }, event => event.day)).toEqual([]);
  });

  it('builds the exact Drawer save payload without UI-only fields', () => {
    expect(buildChronologyEventPayload({ ...events[0], startAt: 'a', endAt: 'b', route: undefined, spanIds: ['s1'], uiOpen: true })).toEqual({
      kind: 'event', reviewStatus: 'confirmed', title: '抵达大理', summary: '进入古城', startAt: 'a', endAt: 'b', location: '大理市', route: undefined,
    });
  });
});
