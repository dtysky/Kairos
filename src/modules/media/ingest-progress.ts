import { getProjectProgressPath, writeKairosProgress, type IWriteKairosProgressInput } from '../../store/progress.js';

type MediaProgressUpdate = Omit<IWriteKairosProgressInput, 'pipelineKey' | 'pipelineLabel' | 'status'> & {
  status?: IWriteKairosProgressInput['status'];
};

/** Serialize concurrent worker updates; throttle files, never stage changes or terminal states. */
export function createMediaProgressReporter(projectRoot: string, jobId?: string, progressPath?: string,
  pipeline = { pipelineKey: 'ingest', pipelineLabel: '素材导入' }) {
  const path = progressPath ?? getProjectProgressPath(projectRoot, pipeline.pipelineKey);
  let pending = Promise.resolve();
  let lastQueuedAt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let latest: IWriteKairosProgressInput = { status: 'running', ...pipeline };

  function flush(): Promise<void> {
    if (timer) clearTimeout(timer);
    timer = undefined;
    const now = Date.now();
    lastQueuedAt = now;
    const snapshot = { ...latest, updatedAt: new Date(now).toISOString() };
    pending = pending.catch(() => undefined).then(async () => { await writeKairosProgress(path, snapshot); });
    return pending;
  }

  function report(update: MediaProgressUpdate, force = false): Promise<void> {
    latest = {
      status: 'running', ...pipeline,
      ...update, extra: { ...update.extra, jobId },
    };
    const remaining = 250 - (Date.now() - lastQueuedAt);
    if (force || remaining <= 0) return flush();
    if (!timer) {
      // Publish the last file-start update even when its probe takes a long time.
      timer = setTimeout(() => { void flush().catch(() => undefined); }, remaining);
      timer.unref();
    }
    return pending;
  }

  return {
    report,
    fail: (error: unknown) => report({
      ...latest, status: 'failed', detail: error instanceof Error ? error.message : String(error),
    }, true),
  };
}

export const createIngestProgressReporter = createMediaProgressReporter;
