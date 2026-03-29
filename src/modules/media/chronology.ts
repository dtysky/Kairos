import type {
  IAssetCoarseReport,
  IKtepAsset,
  IKtepEvidence,
  IMediaChronology,
} from '../../protocol/schema.js';

export function buildMediaChronology(
  assets: IKtepAsset[],
  reports: IAssetCoarseReport[] = [],
  existing: IMediaChronology[] = [],
): IMediaChronology[] {
  const reportMap = new Map(reports.map(report => [report.assetId, report]));
  const existingMap = new Map(existing.map(entry => [entry.assetId, entry]));

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
    const sortCapturedAt = correction?.capturedAtOverride ?? asset.capturedAt;

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
      correction,
    } satisfies IMediaChronology;
  });

  return chronology.sort(compareChronology);
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
  for (const label of labels) {
    evidence.push({
      source: 'vision',
      value: `label:${label}`,
      confidence: 0.4,
    });
  }
  return dedupeEvidence(evidence);
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
