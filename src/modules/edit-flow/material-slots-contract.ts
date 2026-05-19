import type {
  IAssetCoarseReport,
  IChronologyEvent,
  IKtepAsset,
  IKtepSpan,
  IMaterialRecallCoverageAudit,
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
        if (asset.kind !== 'photo' && spanHasSpeechTruth(span) && treatment.audio <= -100) {
          errors.push(`${segment.segmentId}/${slot.id}/${spanId}: speech-backed non-photo spans cannot be muted (audio<=-100)`);
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

export function buildMaterialRecallCoverageAudit(input: {
  materialSlots: IMaterialSlotsDocument;
  spans: IKtepSpan[];
  assets: IKtepAsset[];
  chronologyEvents?: IChronologyEvent[];
  now?: string;
}): IMaterialRecallCoverageAudit {
  const chosenSpanIds = collectChosenSpanIds(input.materialSlots);
  const assetById = new Map(input.assets.map(asset => [asset.id, asset] as const));
  const notes: string[] = [];
  const byType = buildCoverageRows(
    groupSpansByKey(input.spans, span => span.type || 'unknown'),
    chosenSpanIds,
  );
  const byEvent = (input.chronologyEvents ?? []).map(event => {
    const availableSpanIds = event.spanIds.filter(spanId => input.spans.some(span => span.id === spanId));
    return buildCoverageRow({
      key: event.id,
      label: event.title,
      spanIds: availableSpanIds,
      chosenSpanIds,
    });
  }).filter(row => row.available > 0);
  const eventSpanIds = new Set((input.chronologyEvents ?? []).flatMap(event => event.spanIds));
  const byDaySource = input.chronologyEvents?.length
    ? groupEventsByDay(input.chronologyEvents)
    : groupSpansByKey(input.spans, span => {
      const asset = assetById.get(span.assetId);
      return asset?.capturedAt?.slice(0, 10) || 'unknown-day';
    });
  const byDay = input.chronologyEvents?.length
    ? Array.from(byDaySource.entries()).map(([day, spanIds]) => buildCoverageRow({
      key: day,
      label: day,
      spanIds,
      chosenSpanIds,
    })).filter(row => row.available > 0)
    : buildCoverageRows(byDaySource, chosenSpanIds);
  if (input.chronologyEvents?.length) {
    const uncovered = input.spans.filter(span => !eventSpanIds.has(span.id));
    if (uncovered.length > 0) {
      notes.push(`${uncovered.length} span(s) were not attached to a chronology event and are only counted by type.`);
    }
  }

  const speechProtectedIds = input.spans
    .filter(span => {
      const asset = assetById.get(span.assetId);
      return asset?.kind !== 'photo' && spanHasSpeechTruth(span);
    })
    .map(span => span.id);
  const speechChosen = speechProtectedIds.filter(spanId => chosenSpanIds.has(spanId));
  const speechDropped = speechProtectedIds.filter(spanId => !chosenSpanIds.has(spanId));

  return {
    generatedAt: input.now ?? new Date().toISOString(),
    byType,
    byDay,
    byEvent,
    speechProtected: {
      available: speechProtectedIds.length,
      chosen: speechChosen.length,
      dropped: speechDropped.length,
      droppedSpanIds: speechDropped.slice(0, 500),
    },
    notes,
  };
}

function collectChosenSpanIds(materialSlots: IMaterialSlotsDocument): Set<string> {
  const spanIds = new Set<string>();
  for (const segment of materialSlots.segments) {
    for (const slot of segment.slots) {
      for (const spanId of slot.chosenSpanIds) {
        spanIds.add(spanId);
      }
    }
  }
  return spanIds;
}

function groupSpansByKey(
  spans: IKtepSpan[],
  resolveKey: (span: IKtepSpan) => string,
): Map<string, string[]> {
  const grouped = new Map<string, string[]>();
  for (const span of spans) {
    const key = resolveKey(span);
    const existing = grouped.get(key) ?? [];
    existing.push(span.id);
    grouped.set(key, existing);
  }
  return grouped;
}

function groupEventsByDay(events: IChronologyEvent[]): Map<string, string[]> {
  const grouped = new Map<string, string[]>();
  for (const event of events) {
    const day = event.startAt?.slice(0, 10) || event.endAt?.slice(0, 10) || 'unknown-day';
    const existing = grouped.get(day) ?? [];
    existing.push(...event.spanIds);
    grouped.set(day, existing);
  }
  return grouped;
}

function buildCoverageRows(
  groupedSpanIds: Map<string, string[]>,
  chosenSpanIds: Set<string>,
): IMaterialRecallCoverageAudit['byType'] {
  return Array.from(groupedSpanIds.entries())
    .map(([key, spanIds]) => buildCoverageRow({ key, spanIds, chosenSpanIds }))
    .sort((left, right) => right.available - left.available || left.key.localeCompare(right.key));
}

function buildCoverageRow(input: {
  key: string;
  label?: string;
  spanIds: string[];
  chosenSpanIds: Set<string>;
}): IMaterialRecallCoverageAudit['byType'][number] {
  const uniqueSpanIds = Array.from(new Set(input.spanIds));
  const chosen = uniqueSpanIds.filter(spanId => input.chosenSpanIds.has(spanId));
  const dropped = uniqueSpanIds.filter(spanId => !input.chosenSpanIds.has(spanId));
  return {
    key: input.key,
    label: input.label,
    available: uniqueSpanIds.length,
    chosen: chosen.length,
    dropped: dropped.length,
    droppedSpanIds: dropped.slice(0, 300),
  };
}

export function spanHasSpeechTruth(span: IKtepSpan): boolean {
  return Boolean(span.transcript?.trim())
    || (span.transcriptSegments?.length ?? 0) > 0
    || span.semanticKind === 'speech'
    || span.semanticKind === 'mixed'
    || span.materialPatterns.includes('有口播语音');
}

function hasForbiddenTreatmentText(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return /\baudio\s*[:=]/u.test(normalized)
    || /\bspeed\s*[:=]/u.test(normalized)
    || /\bmixed\b/u.test(normalized);
}
