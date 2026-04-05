import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  IReviewItem,
  IReviewQueue,
  type IReviewItem as TReviewItem,
  type IReviewQueue as TReviewQueue,
} from '../protocol/schema.js';
import { readJsonOrNull, writeJson } from './writer.js';

export function getReviewQueuePath(projectRoot: string): string {
  return join(projectRoot, 'config', 'review-queue.json');
}

export async function loadReviewQueue(projectRoot: string): Promise<TReviewQueue> {
  const stored = await readJsonOrNull(getReviewQueuePath(projectRoot), IReviewQueue);
  if (stored) {
    return IReviewQueue.parse(stored);
  }
  return IReviewQueue.parse({ items: [] });
}

export async function saveReviewQueue(
  projectRoot: string,
  queue: TReviewQueue,
): Promise<TReviewQueue> {
  const normalized = normalizeReviewQueue(queue);
  await writeJson(getReviewQueuePath(projectRoot), normalized);
  return normalized;
}

export async function upsertReviewItems(
  projectRoot: string,
  items: TReviewItem[],
): Promise<TReviewQueue> {
  const queue = await loadReviewQueue(projectRoot);
  const byId = new Map(queue.items.map(item => [item.id, item]));

  for (const item of items) {
    const normalized = normalizeReviewItem(item);
    byId.set(normalized.id, normalized);
  }

  return saveReviewQueue(projectRoot, {
    items: [...byId.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
  });
}

export async function replaceReviewItemsByMatcher(
  projectRoot: string,
  nextItems: TReviewItem[],
  matcher: (item: TReviewItem) => boolean,
): Promise<TReviewQueue> {
  const queue = await loadReviewQueue(projectRoot);
  const preserved = queue.items.filter(item => !matcher(item));
  return saveReviewQueue(projectRoot, {
    items: [...preserved, ...nextItems].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
  });
}

export async function resolveReviewItem(
  projectRoot: string,
  reviewId: string,
  update?: {
    note?: string;
    fields?: Array<{ key: string; value?: string }>;
    status?: TReviewItem['status'];
  },
): Promise<TReviewItem | null> {
  const queue = await loadReviewQueue(projectRoot);
  const index = queue.items.findIndex(item => item.id === reviewId);
  if (index < 0) return null;

  const current = queue.items[index]!;
  const now = new Date().toISOString();
  const next: TReviewItem = normalizeReviewItem({
    ...current,
    status: update?.status ?? 'resolved',
    note: update?.note ?? current.note,
    fields: mergeReviewFields(current.fields, update?.fields),
    updatedAt: now,
    resolvedAt: update?.status === 'dismissed'
      ? undefined
      : now,
  });
  queue.items[index] = next;
  await saveReviewQueue(projectRoot, queue);
  return next;
}

function normalizeReviewQueue(queue: TReviewQueue): TReviewQueue {
  return IReviewQueue.parse({
    items: queue.items.map(normalizeReviewItem),
  });
}

function normalizeReviewItem(item: TReviewItem): TReviewItem {
  const now = new Date().toISOString();
  return IReviewItem.parse({
    ...item,
    id: item.id || randomUUID(),
    createdAt: item.createdAt || now,
    updatedAt: item.updatedAt || now,
    fields: (item.fields ?? []).map(field => ({
      ...field,
      value: field.value?.trim() || undefined,
      suggestedValue: field.suggestedValue?.trim() || undefined,
    })),
  });
}

function mergeReviewFields(
  current: TReviewItem['fields'],
  updates?: Array<{ key: string; value?: string }>,
): TReviewItem['fields'] {
  if (!updates?.length) return current;

  const valueByKey = new Map(updates.map(update => [update.key, update.value?.trim() || undefined]));
  return current.map(field => (
    valueByKey.has(field.key)
      ? { ...field, value: valueByKey.get(field.key) }
      : field
  ));
}
