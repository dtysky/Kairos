import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { IProjectChronology, type IChronologyEvent, type IProjectChronology as TProjectChronology } from '../protocol/schema.js';
import { writeJson } from './writer.js';

export class ChronologyV1UnsupportedError extends Error {
  constructor() {
    super('media/chronology.json 仍是 legacy v1 素材数组。请先在 /chronology 执行时空刷新，重建 Chronology V2，再进入 Script 或 Timeline。');
    this.name = 'ChronologyV1UnsupportedError';
  }
}

export interface IChronologyReviewState {
  chronology: TProjectChronology | null;
  blocked: boolean;
  message?: string;
}

export function getChronologyPath(projectRoot: string): string {
  return join(projectRoot, 'media/chronology.json');
}

export async function loadChronology(projectRoot: string): Promise<TProjectChronology | null> {
  const raw = await readChronologyRaw(projectRoot);
  if (raw == null) return null;
  return parseChronology(raw);
}

export async function loadChronologyForRebuild(projectRoot: string): Promise<TProjectChronology | null> {
  try {
    return await loadChronology(projectRoot);
  } catch (error) {
    if (error instanceof ChronologyV1UnsupportedError) return null;
    throw error;
  }
}

export async function loadChronologyReviewState(projectRoot: string): Promise<IChronologyReviewState> {
  try {
    const chronology = await loadChronology(projectRoot);
    if (!chronology) {
      return {
        chronology: null,
        blocked: true,
        message: 'media/chronology.json 尚未生成。请先在 /chronology 执行时空刷新，生成 Chronology V2，再进入 Script 或 Timeline。',
      };
    }
    return { chronology, blocked: false };
  } catch (error) {
    return {
      chronology: null,
      blocked: true,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function assertConfirmedProjectChronology(projectRoot: string): Promise<TProjectChronology> {
  const chronology = await loadChronology(projectRoot);
  if (!chronology) {
    throw new Error('Script/Timeline requires confirmed Chronology V2: media/chronology.json is missing.');
  }
  if (chronology.schemaVersion !== '2.0') {
    throw new Error('Script/Timeline requires confirmed Chronology V2: rebuild media/chronology.json.');
  }
  if (chronology.status !== 'confirmed') {
    throw new Error(`Script/Timeline requires confirmed Chronology V2: current status is ${chronology.status}. Review /chronology first.`);
  }
  return chronology;
}

export async function writeChronology(
  projectRoot: string,
  chronology: TProjectChronology,
): Promise<void> {
  await writeJson(getChronologyPath(projectRoot), IProjectChronology.parse(chronology));
}

export async function markChronologyStale(projectRoot: string): Promise<TProjectChronology | null> {
  const chronology = await loadChronologyForRebuild(projectRoot);
  if (!chronology) return null;
  const updated: TProjectChronology = {
    ...chronology,
    status: 'stale',
    updatedAt: new Date().toISOString(),
  };
  await writeChronology(projectRoot, updated);
  return updated;
}

export async function confirmChronology(projectRoot: string): Promise<TProjectChronology> {
  const chronology = await readRequiredChronology(projectRoot);
  const now = new Date().toISOString();
  const confirmed: TProjectChronology = {
    ...chronology,
    status: 'confirmed',
    updatedAt: now,
    confirmedAt: now,
    events: chronology.events.map(event => event.reviewStatus === 'pending'
      ? { ...event, reviewStatus: 'confirmed' as const }
      : event),
  };
  await writeChronology(projectRoot, confirmed);
  return confirmed;
}

export async function updateChronologyEvent(
  projectRoot: string,
  eventId: string,
  patch: Partial<Pick<IChronologyEvent, 'kind' | 'reviewStatus' | 'title' | 'summary' | 'startAt' | 'endAt' | 'location' | 'route'>>,
): Promise<TProjectChronology> {
  const chronology = await readRequiredChronology(projectRoot);
  const index = chronology.events.findIndex(event => event.id === eventId);
  if (index < 0) {
    throw new Error(`Chronology event not found: ${eventId}`);
  }
  const events = [...chronology.events];
  events[index] = {
    ...events[index]!,
    ...sanitizeChronologyEventPatch(patch),
  };
  const updated = markChronologyEdited(chronology, events);
  await writeChronology(projectRoot, updated);
  return updated;
}

export async function mergeChronologyEvents(
  projectRoot: string,
  eventIds: string[],
): Promise<TProjectChronology> {
  const chronology = await readRequiredChronology(projectRoot);
  const selected = chronology.events.filter(event => eventIds.includes(event.id));
  if (selected.length < 2) {
    throw new Error('Merging chronology events requires at least two event ids.');
  }
  const selectedIdSet = new Set(selected.map(event => event.id));
  const firstIndex = chronology.events.findIndex(event => selectedIdSet.has(event.id));
  const ordered = selected.sort(compareChronologyEvents);
  const merged: IChronologyEvent = {
    id: `event-${hashText(ordered.map(event => event.id).join('|')).slice(0, 12)}`,
    kind: ordered.some(event => event.kind === 'route') ? 'route' : ordered.some(event => event.kind === 'gap') ? 'gap' : 'event',
    reviewStatus: 'pending',
    title: mergeTitles(ordered),
    summary: mergeSummaries(ordered),
    startAt: firstString(ordered.map(event => event.startAt).filter(isNonEmptyString).sort()),
    endAt: lastString(ordered.map(event => event.endAt ?? event.startAt).filter(isNonEmptyString).sort()),
    location: firstString(ordered.map(event => event.location).filter(isNonEmptyString)),
    route: mergeRoutes(ordered),
    spanIds: dedupeStrings(ordered.flatMap(event => event.spanIds)),
  };
  const events = chronology.events.filter(event => !selectedIdSet.has(event.id));
  events.splice(Math.max(0, firstIndex), 0, merged);
  const updated = markChronologyEdited(chronology, events);
  await writeChronology(projectRoot, updated);
  return updated;
}

export async function splitChronologyEvent(
  projectRoot: string,
  eventId: string,
): Promise<TProjectChronology> {
  const chronology = await readRequiredChronology(projectRoot);
  const index = chronology.events.findIndex(event => event.id === eventId);
  if (index < 0) {
    throw new Error(`Chronology event not found: ${eventId}`);
  }
  const event = chronology.events[index]!;
  if (event.spanIds.length <= 1) {
    throw new Error('Splitting a chronology event requires at least two spanIds.');
  }
  const splitEvents = event.spanIds.map((spanId, order) => ({
    ...event,
    id: `${event.id}-part-${order + 1}`,
    reviewStatus: 'pending' as const,
    title: `${event.title} ${order + 1}`,
    summary: event.summary,
    spanIds: [spanId],
  }));
  const events = [...chronology.events];
  events.splice(index, 1, ...splitEvents);
  const updated = markChronologyEdited(chronology, events);
  await writeChronology(projectRoot, updated);
  return updated;
}

async function readRequiredChronology(projectRoot: string): Promise<TProjectChronology> {
  const chronology = await loadChronology(projectRoot);
  if (!chronology) {
    throw new Error('media/chronology.json is missing. Rebuild Chronology V2 first.');
  }
  return chronology;
}

async function readChronologyRaw(projectRoot: string): Promise<string | null> {
  try {
    return await readFile(getChronologyPath(projectRoot), 'utf-8');
  } catch (error) {
    if (getErrorCode(error) === 'ENOENT') return null;
    throw error;
  }
}

function parseChronology(raw: string): TProjectChronology {
  const parsed = JSON.parse(raw);
  if (Array.isArray(parsed)) {
    throw new ChronologyV1UnsupportedError();
  }
  return IProjectChronology.parse(parsed);
}

function sanitizeChronologyEventPatch(
  patch: Partial<Pick<IChronologyEvent, 'kind' | 'reviewStatus' | 'title' | 'summary' | 'startAt' | 'endAt' | 'location' | 'route'>>,
): Partial<Pick<IChronologyEvent, 'kind' | 'reviewStatus' | 'title' | 'summary' | 'startAt' | 'endAt' | 'location' | 'route'>> {
  return {
    ...(patch.kind && { kind: patch.kind }),
    ...(patch.reviewStatus && { reviewStatus: patch.reviewStatus }),
    ...(typeof patch.title === 'string' && { title: patch.title.trim() || 'Untitled event' }),
    ...(typeof patch.summary === 'string' && { summary: patch.summary.trim() || undefined }),
    ...(typeof patch.startAt === 'string' && { startAt: patch.startAt.trim() || undefined }),
    ...(typeof patch.endAt === 'string' && { endAt: patch.endAt.trim() || undefined }),
    ...(typeof patch.location === 'string' && { location: patch.location.trim() || undefined }),
    ...(patch.route && {
      route: {
        ...(typeof patch.route.from === 'string' && { from: patch.route.from.trim() || undefined }),
        ...(typeof patch.route.to === 'string' && { to: patch.route.to.trim() || undefined }),
      },
    }),
  };
}

function markChronologyEdited(
  chronology: TProjectChronology,
  events: IChronologyEvent[],
): TProjectChronology {
  return {
    ...chronology,
    status: 'draft',
    confirmedAt: undefined,
    updatedAt: new Date().toISOString(),
    events,
  };
}

function compareChronologyEvents(left: IChronologyEvent, right: IChronologyEvent): number {
  return String(left.startAt ?? left.endAt ?? '').localeCompare(String(right.startAt ?? right.endAt ?? ''))
    || left.id.localeCompare(right.id);
}

function mergeRoutes(events: IChronologyEvent[]): IChronologyEvent['route'] | undefined {
  const from = firstString(events.map(event => event.route?.from ?? event.location).filter(isNonEmptyString));
  const to = lastString(events.map(event => event.route?.to ?? event.location).filter(isNonEmptyString));
  if (!from && !to) return undefined;
  return { from, to };
}

function mergeTitles(events: IChronologyEvent[]): string {
  return dedupeStrings(events.map(event => event.title)).slice(0, 3).join(' / ') || 'Merged event';
}

function mergeSummaries(events: IChronologyEvent[]): string | undefined {
  return dedupeStrings(events.map(event => event.summary)).join(' ') || undefined;
}

function firstString(values: string[]): string | undefined {
  return values.find(value => value.trim().length > 0);
}

function lastString(values: string[]): string | undefined {
  return [...values].reverse().find(value => value.trim().length > 0);
}

function dedupeStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter(isNonEmptyString))];
}

function isNonEmptyString(value: string | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function hashText(text: string): string {
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) - hash + text.charCodeAt(index)) | 0;
  }
  return Math.abs(hash).toString(16).padStart(8, '0');
}

function getErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const code = Reflect.get(error, 'code');
  return typeof code === 'string' ? code : undefined;
}
