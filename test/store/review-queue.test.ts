import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadReviewQueue,
  resolveReviewItem,
  saveReviewQueue,
  upsertReviewItems,
} from '../../src/store/index.js';

const workspaces: string[] = [];

afterEach(async () => {
  await Promise.all(
    workspaces.splice(0).map(path => rm(path, { recursive: true, force: true })),
  );
});

async function createWorkspace(): Promise<string> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'kairos-review-queue-test-'));
  workspaces.push(workspaceRoot);
  return workspaceRoot;
}

describe('review queue', () => {
  it('upserts and resolves capture-time review items', async () => {
    const projectRoot = await createWorkspace();

    await saveReviewQueue(projectRoot, { items: [] });
    await upsertReviewItems(projectRoot, [{
      id: 'review-1',
      projectId: 'project-a',
      kind: 'capture-time-correction',
      stage: 'ingest',
      status: 'open',
      title: '校正时间',
      reason: '时间线不一致',
      fields: [{
        key: 'correctedDate',
        label: '正确日期',
        suggestedValue: '2026-02-08',
        required: true,
      }],
      createdAt: '2026-04-05T00:00:00.000Z',
      updatedAt: '2026-04-05T00:00:00.000Z',
    }]);

    const resolved = await resolveReviewItem(projectRoot, 'review-1', {
      fields: [{ key: 'correctedDate', value: '2026-02-08' }],
    });
    const queue = await loadReviewQueue(projectRoot);

    expect(resolved?.status).toBe('resolved');
    expect(queue.items[0]?.fields[0]?.value).toBe('2026-02-08');
    expect(queue.items[0]?.resolvedAt).toMatch(/^2026|^\d{4}-\d{2}-\d{2}T/);
  });
});
