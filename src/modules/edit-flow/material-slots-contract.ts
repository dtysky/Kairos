import type {
  IAssetCoarseReport,
  IKtepAsset,
  IKtepSpan,
  IMaterialSlotsDocument,
} from '../../protocol/schema.js';

export function assertMaterialSlotsContract(input: {
  materialSlots: IMaterialSlotsDocument;
  spans: IKtepSpan[];
  assets: IKtepAsset[];
  assetReports?: IAssetCoarseReport[];
}): void {
  const spanById = new Map(input.spans.map(span => [span.id, span] as const));
  const assetById = new Map(input.assets.map(asset => [asset.id, asset] as const));
  const reportByAssetId = new Map((input.assetReports ?? []).map(report => [report.assetId, report] as const));
  const errors: string[] = [];

  for (const segment of input.materialSlots.segments) {
    for (const slot of segment.slots) {
      if (hasForbiddenTreatmentText(slot.query)) {
        errors.push(`${segment.segmentId}/${slot.id}: query still contains audio/speed/mixed treatment text`);
      }
      for (const bundle of slot.targetBundles) {
        if (hasForbiddenTreatmentText(bundle)) {
          errors.push(`${segment.segmentId}/${slot.id}: targetBundles contains forbidden treatment token "${bundle}"`);
        }
      }

      const chosenSpanIds = new Set(slot.chosenSpanIds);
      for (const spanId of slot.chosenSpanIds) {
        const treatment = slot.treatments[spanId];
        if (!treatment) {
          errors.push(`${segment.segmentId}/${slot.id}: missing treatment for chosen span ${spanId}`);
          continue;
        }
        if (!Number.isFinite(treatment.audio)) {
          errors.push(`${segment.segmentId}/${slot.id}/${spanId}: audio must be a finite dB number`);
        }
        if (!Number.isFinite(treatment.speed) || treatment.speed <= 0) {
          errors.push(`${segment.segmentId}/${slot.id}/${spanId}: speed must be a positive multiplier`);
        }

        const span = spanById.get(spanId);
        if (!span) {
          errors.push(`${segment.segmentId}/${slot.id}: chosen span not found in fresh spans: ${spanId}`);
          continue;
        }
        const asset = assetById.get(span.assetId);
        if (!asset) {
          errors.push(`${segment.segmentId}/${slot.id}/${spanId}: asset not found: ${span.assetId}`);
          continue;
        }
        const report = reportByAssetId.get(asset.id);
        if (report?.keepDecision === 'drop') {
          errors.push(`${segment.segmentId}/${slot.id}/${spanId}: dropped asset is not recallable: ${asset.id}`);
        }
        if (asset.kind === 'photo' && treatment.audio > -100) {
          errors.push(`${segment.segmentId}/${slot.id}/${spanId}: photo spans must use audio=-100`);
        }
        if (treatment.speed > 1 && span.type !== 'drive' && span.type !== 'aerial') {
          errors.push(`${segment.segmentId}/${slot.id}/${spanId}: speed > 1 is only allowed for drive/aerial spans`);
        }
      }

      for (const spanId of Object.keys(slot.treatments)) {
        if (!chosenSpanIds.has(spanId)) {
          errors.push(`${segment.segmentId}/${slot.id}: treatment references non-chosen span ${spanId}`);
        }
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(`material-slots contract failed:\n${errors.join('\n')}`);
  }
}

function hasForbiddenTreatmentText(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return /\baudio\s*[:=]/u.test(normalized)
    || /\bspeed\s*[:=]/u.test(normalized)
    || /\bmixed\b/u.test(normalized);
}
