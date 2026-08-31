export type ChronologyFilters = {
  kind: string;
  status: string;
  day: string;
  query: string;
};

export function filterChronologyEvents(
  events: any[],
  filters: ChronologyFilters,
  resolveDay: (event: any) => string,
) {
  const query = filters.query.trim().toLocaleLowerCase();
  return events.filter(event => {
    if (filters.kind !== 'all' && event.kind !== filters.kind) return false;
    if (filters.status !== 'all' && event.reviewStatus !== filters.status) return false;
    if (filters.day !== 'all' && resolveDay(event) !== filters.day) return false;
    if (!query) return true;
    const haystack = [event.title, event.summary, event.location, event.route?.from, event.route?.to]
      .filter(Boolean)
      .join(' ')
      .toLocaleLowerCase();
    return haystack.includes(query);
  });
}

export function buildChronologyEventPayload(draft: any) {
  return {
    kind: draft.kind,
    reviewStatus: draft.reviewStatus,
    title: draft.title,
    summary: draft.summary,
    startAt: draft.startAt,
    endAt: draft.endAt,
    location: draft.location,
    route: draft.route,
  };
}
