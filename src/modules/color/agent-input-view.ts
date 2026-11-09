import type { ColorAgentPacket } from './agent-classification.js';

/** Presentation only: never changes packet signatures or classification policy. */
export const COLOR_AGENT_INPUT_VIEW = 'agent-input-v2.json';
const columns = [
  'assetId', 'packetFingerprint', 'colorInput.media.capturedAt',
  'report.type', 'report.summary', 'report.transcript', 'report.transcriptSegments',
  'report.speechCoverage', 'colorInput.facts.speech', 'report.visualWindows', 'userContext',
  'technical.status', 'technical.source.profile', 'technical.source.blocker', 'technical.probe', 'technical.coverage',
  'technical.exposure', 'technical.sourceClipping', 'technical.noise', 'technical.noiseSamples',
  'technical.highContrast', 'technical.warnings', 'solar', 'overviewSamples', 'detailCounts',
] as const;
const overviewColumns = ['originalIndex', 'startMs', 'endMs', 'display.median', 'display.darkFraction',
  'display.brightFraction', 'source.median', 'sourceWhitePlateauFraction'] as const;
const tables = {
  'report.transcriptSegments': ['startMs', 'endMs', 'text'],
  'report.visualWindows': ['status', 'sourceInMs', 'sourceOutMs', 'semanticKind', 'visualObservation', 'transcript', 'transcriptSegments', 'speechCoverage'],
  'report.visualWindows[].transcriptSegments': ['startMs', 'endMs', 'text'],
  'colorInput.facts.speech.ranges': ['startMs', 'endMs'],
  'technical.noiseSamples': ['startMs', 'endMs', 'validPatches', 'regions', 'displaySigma', 'sourceSigma', 'state'],
  'solar.samples': ['sourceMs', 'at', 'elevationDegrees', 'phase'],
  'solar.days': ['solarDate', 'sunriseAt', 'sunsetAt', 'polar'],
};
function table(rows: object[] | undefined, fields: readonly string[]) {
  return rows?.map(row => fields.map(field => (row as Record<string, unknown>)[field] ?? null)) ?? null;
}

function overviewSamples(packet: ColorAgentPacket) {
  const rows = packet.technical.overview;
  if (!rows.length) return [];
  let darkest = 0, brightest = 0;
  for (let i = 1; i < rows.length; i++) {
    if (rows[i]!.display.median < rows[darkest]!.display.median) darkest = i;
    if (rows[i]!.display.median > rows[brightest]!.display.median) brightest = i;
  }
  return [...new Set([0, Math.floor(rows.length / 2), rows.length - 1, darkest, brightest])].sort((a, b) => a - b)
    .map(i => { const row = rows[i]!; return [i, row.startMs, row.endMs, row.display.median, row.display.darkFraction,
      row.display.brightFraction, row.source.median, row.sourceWhitePlateauFraction ?? null]; });
}

/** Intern only exact repeated strings. No truncation, paraphrase or semantic deduplication. */
function shareRepeatedText(rows: unknown[][]) {
  const counts = new Map<string, number>();
  const visit = (value: unknown): void => {
    if (typeof value === 'string' && value.length >= 16) counts.set(value, (counts.get(value) ?? 0) + 1);
    else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object') Object.values(value).forEach(visit);
  };
  visit(rows);
  const texts = [...counts.entries()].filter(([, n]) => n > 1).map(([text]) => text);
  const indexes = new Map(texts.map((text, index) => [text, index]));
  const encode = (value: unknown): unknown => {
    if (typeof value === 'string' && indexes.has(value)) return { $text: indexes.get(value)! };
    if (Array.isArray(value)) return value.map(encode);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encode(item)]));
    return value;
  };
  return { texts, rows: encode(rows) as unknown[][] };
}

export function buildColorAgentInputView(
  packets: ColorAgentPacket[],
  batch: { rootId: string; batchFingerprint: string; policyVersion: string; policyFingerprint: string; model: string; reasoningEffort: string },
  contract: { categories: unknown; rules: string[]; output: unknown },
) {
  const rows = [...packets].sort((a, b) => a.assetId.localeCompare(b.assetId)).map(p => {
    const r = p.report, t = p.technical;
    // Preserve window indexes, status, source ranges, speech association and every
    // observed description. Only orchestration IDs and plan provenance are omitted.
    const windows = r.visualWindows.map(w => ({ status: w.status, sourceInMs: w.sourceInMs, sourceOutMs: w.sourceOutMs,
      semanticKind: w.semanticKind, visualObservation: w.visualObservation, transcript: w.transcript,
      transcriptSegments: table(w.transcriptSegments, tables['report.visualWindows[].transcriptSegments']), speechCoverage: w.speechCoverage }));
    const solar = { status: p.solar.status, reason: p.solar.reason,
      samples: table(p.solar.samples, tables['solar.samples']), days: table(p.solar.days, tables['solar.days']) };
    const speech = p.colorInput.facts?.speech;
    return [p.assetId, p.packetFingerprint, p.colorInput.media.capturedAt ?? null,
      r.type ?? null, r.summary ?? null, r.transcript ?? null, table(r.transcriptSegments, tables['report.transcriptSegments']),
      r.speechCoverage ?? null, speech ? { ...speech, ranges: table(speech.ranges, tables['colorInput.facts.speech.ranges']) } : null,
      table(windows, tables['report.visualWindows']),
      p.userContext.map(c => ({ source: c.source, statement: c.statement })),
      t.status, t.source.profile ?? null, t.source.blocker ?? null, t.probe ?? null, t.coverage,
      t.exposure, t.sourceClipping, t.noise, table(t.noiseSamples, tables['technical.noiseSamples']), t.highContrast, t.warnings, solar,
      overviewSamples(p), { overview: t.overview.length, contrastOverview: t.contrastOverview.length }];
  });
  return {
    formatVersion: 'color-agent-input-v2',
    batch: { rootId: batch.rootId, batchFingerprint: batch.batchFingerprint, policyVersion: batch.policyVersion,
      policyFingerprint: batch.policyFingerprint, model: batch.model, reasoningEffort: batch.reasoningEffort },
    categories: contract.categories, rules: contract.rules, output: contract.output,
    input: {
      columns, tables, overviewColumns,
      notes: [
        'rows 每行依次对应 columns。除 overviewSamples/detailCounts 外，列名就是完整 packet 中的证据路径；数组索引保持原值。字段缺失用 null 占位，不可将占位引用为原始证据。',
        'tables 中列出的嵌套数组也共享一次字段说明，每个内层行依列名还原原字段；[] 表示父数组的任一行。精确证据路径使用原字段名，不使用列位置。',
        '所有 {$text:n} 都精确引用 texts[n]，原文只显示一次；证据 quoteOrValue 使用展开后的原文，不引用 $text 对象。',
        'solar、visualWindows、userContext 是字段投影；引用具体原始字段，不能把投影对象整体冒充完整 packet 原值。',
        'overviewSamples 的 originalIndex 指向 technical.overview[index]；其它列为该行的原始字段。只选首/中/末及显示中位亮度极值，不能据此推断占比、转换边界或持续性；技术诊断及原始区间保持完整。',
        '需要完整逐帧指标、计划关联或未展示字段时，按 packetDirectory + packetFingerprint + .json 读取对应 packet；不默认展开所有大数组。',
      ],
      packetDirectory: '../../packets/',
    },
    ...shareRepeatedText(rows),
  };
}
