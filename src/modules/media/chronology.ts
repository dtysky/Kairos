import type {
  IAssetCoarseReport,
  IKtepAsset,
  IKtepEvidence,
  IMediaChronology,
  IMediaRoot,
} from '../../protocol/schema.js';

export function buildMediaChronology(
  assets: IKtepAsset[],
  reports: IAssetCoarseReport[] = [],
  existing: IMediaChronology[] = [],
  roots: IMediaRoot[] = [],
): IMediaChronology[] {
  const reportMap = new Map(reports.map(report => [report.assetId, report]));
  const existingMap = new Map(existing.map(entry => [entry.assetId, entry]));
  const rootMap = new Map(roots.map(root => [root.id, root]));

  const chronology = assets.map(asset => {
    const report = reportMap.get(asset.id);
    const prior = existingMap.get(asset.id);
    const correction = prior?.correction;

    const labels = applyLabelCorrection(
      report?.labels ?? [],
      correction?.labelsAdd,
      correction?.labelsRemove,
    );
    const summary = correction?.summaryOverride ?? report?.summary;
    const sortCapturedAt = correction?.capturedAtOverride
      ?? applyRootClockOffset(asset.capturedAt, rootMap.get(asset.ingestRootId ?? '')?.clockOffsetMs)
      ?? asset.capturedAt;

    return {
      id: prior?.id ?? asset.id,
      assetId: asset.id,
      ingestRootId: asset.ingestRootId,
      capturedAt: asset.capturedAt,
      sortCapturedAt,
      captureTimeSource: asset.captureTimeSource,
      captureTimeConfidence: asset.captureTimeConfidence,
      summary,
      labels,
      placeHints: report?.placeHints ?? [],
      evidence: buildChronologyEvidence(report, labels),
      pharosMatches: report?.pharosMatches ?? [],
      primaryPharosRef: report?.primaryPharosRef,
      pharosStatus: report?.pharosStatus,
      pharosDayTitle: report?.pharosDayTitle,
      correction,
    } satisfies IMediaChronology;
  });

  return chronology.sort(compareChronology);
}

function applyRootClockOffset(
  capturedAt: string | undefined,
  clockOffsetMs: number | undefined,
): string | undefined {
  if (!capturedAt) return undefined;
  if (clockOffsetMs == null || !Number.isFinite(clockOffsetMs) || clockOffsetMs === 0) {
    return capturedAt;
  }
  const capturedAtMs = Date.parse(capturedAt);
  if (!Number.isFinite(capturedAtMs)) return capturedAt;
  return new Date(capturedAtMs + clockOffsetMs).toISOString();
}

function applyLabelCorrection(
  base: string[],
  add?: string[],
  remove?: string[],
): string[] {
  const labels = new Set(base);
  for (const label of add ?? []) {
    const trimmed = label.trim();
    if (trimmed) labels.add(trimmed);
  }
  for (const label of remove ?? []) {
    labels.delete(label);
  }
  return [...labels];
}

function buildChronologyEvidence(
  report: IAssetCoarseReport | undefined,
  labels: string[],
): IKtepEvidence[] {
  const evidence: IKtepEvidence[] = [];
  if (report?.gpsSummary) {
    const gpsEvidence = resolveGpsEvidence(report);
    evidence.push({
      source: gpsEvidence.source,
      value: report.gpsSummary,
      confidence: gpsEvidence.confidence,
    });
  }
  if (report?.summary) {
    evidence.push({
      source: 'vision',
      value: report.summary,
      confidence: 0.65,
    });
  }
  for (const hint of report?.placeHints ?? []) {
    evidence.push({
      source: 'vision',
      value: `place:${hint}`,
      confidence: 0.5,
    });
  }
  for (const segment of report?.transcriptSegments?.slice(0, 6) ?? []) {
    const text = segment.text.trim();
    if (!text) continue;
    evidence.push({
      source: 'asr',
      value: text,
      confidence: 0.8,
    });
  }
  for (const note of report?.rootNotes ?? []) {
    evidence.push({
      source: 'manual-root-note',
      value: note,
      confidence: 0.6,
    });
  }
  for (const label of labels) {
    evidence.push({
      source: 'vision',
      value: `label:${label}`,
      confidence: 0.4,
    });
  }
  for (const match of report?.pharosMatches ?? []) {
    const detail = [
      match.tripTitle,
      match.dayTitle,
      match.ref.tripId,
      match.ref.shotId,
      match.status ? `status:${match.status}` : '',
    ].filter(Boolean).join(' | ');
    evidence.push({
      source: 'pharos',
      value: detail,
      confidence: match.confidence,
    });
  }
  return dedupeEvidence(evidence);
}

function resolveGpsEvidence(
  report: IAssetCoarseReport,
): { source: 'manual' | 'gps' | 'derived-track' | 'pharos'; confidence: number } {
  const inferredSource = report.inferredGps?.source;
  if (inferredSource === 'embedded') {
    return {
      source: 'gps',
      confidence: 0.95,
    };
  }
  if (inferredSource === 'gpx') {
    return {
      source: 'gps',
      confidence: 0.7,
    };
  }
  if (inferredSource === 'pharos') {
    return {
      source: 'pharos',
      confidence: report.inferredGps?.confidence ?? 0.55,
    };
  }
  if (inferredSource === 'derived-track') {
    return {
      source: 'derived-track',
      confidence: report.inferredGps?.confidence ?? 0.45,
    };
  }
  return report.gpsSummary?.startsWith('derived-track')
    ? { source: 'derived-track', confidence: report.inferredGps?.confidence ?? 0.45 }
    : { source: 'gps', confidence: 0.7 };
}

function compareChronology(a: IMediaChronology, b: IMediaChronology): number {
  const aSort = a.sortCapturedAt ?? '';
  const bSort = b.sortCapturedAt ?? '';
  if (aSort && bSort && aSort !== bSort) {
    return aSort.localeCompare(bSort);
  }
  if (aSort && !bSort) return -1;
  if (!aSort && bSort) return 1;
  return a.assetId.localeCompare(b.assetId);
}

function dedupeEvidence(evidence: IKtepEvidence[]): IKtepEvidence[] {
  const seen = new Set<string>();
  const deduped: IKtepEvidence[] = [];
  for (const item of evidence) {
    const key = `${item.source}:${item.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }
  return deduped;
}
