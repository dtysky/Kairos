import type {
  IKtepScript,
  IKtepScriptBeat,
  IKtepScriptSelection,
} from '../../src/protocol/schema.js';

export interface ITestScriptBeatInput
  extends Omit<IKtepScriptBeat, 'audioSelections' | 'visualSelections' | 'linkedSpanIds' | 'linkedSliceIds'> {
  selections?: IKtepScriptSelection[];
  audioSelections?: IKtepScriptSelection[];
  visualSelections?: IKtepScriptSelection[];
  linkedSpanIds?: string[];
  linkedSliceIds?: string[];
}

export interface ITestScriptSegmentInput
  extends Omit<IKtepScript, 'beats' | 'linkedSpanIds' | 'linkedSliceIds'> {
  beats?: ITestScriptBeatInput[];
  linkedSpanIds?: string[];
  linkedSliceIds?: string[];
}

export function createTestScript(segments: ITestScriptSegmentInput[]): IKtepScript[] {
  return segments.map(segment => {
    const beats = (segment.beats ?? []).map(createTestBeat);
    return {
      ...segment,
      linkedSpanIds: segment.linkedSpanIds ?? dedupeStrings([
        ...(segment.selections ?? []).map(selection => selection.spanId),
        ...beats.flatMap(beat => beat.linkedSpanIds),
      ]),
      linkedSliceIds: segment.linkedSliceIds ?? dedupeStrings([
        ...(segment.selections ?? []).map(selection => selection.sliceId),
        ...beats.flatMap(beat => beat.linkedSliceIds),
      ]),
      beats,
    };
  });
}

export function createTestBeat(input: ITestScriptBeatInput): IKtepScriptBeat {
  const selections = dedupeSelections(input.selections ?? []);
  const audioSelections = dedupeSelections(
    input.audioSelections
    ?? (input.actions?.preserveNatSound ? selections : []),
  );
  const visualSelections = dedupeSelections(
    input.visualSelections
    ?? selections,
  );

  return {
    id: input.id,
    text: input.text,
    utterances: input.utterances,
    targetDurationMs: input.targetDurationMs,
    actions: input.actions,
    audioSelections,
    visualSelections,
    linkedSpanIds: input.linkedSpanIds != null && input.linkedSpanIds.length > 0
      ? input.linkedSpanIds
      : dedupeStrings([
        ...audioSelections.map(selection => selection.spanId),
        ...visualSelections.map(selection => selection.spanId),
      ]),
    linkedSliceIds: input.linkedSliceIds != null && input.linkedSliceIds.length > 0
      ? input.linkedSliceIds
      : dedupeStrings([
        ...audioSelections.map(selection => selection.sliceId),
        ...visualSelections.map(selection => selection.sliceId),
      ]),
    pharosRefs: input.pharosRefs,
    notes: input.notes,
  };
}

function dedupeSelections(selections: IKtepScriptSelection[]): IKtepScriptSelection[] {
  const seen = new Set<string>();
  const result: IKtepScriptSelection[] = [];
  for (const selection of selections) {
    const key = [
      selection.assetId,
      selection.spanId ?? '',
      selection.sliceId ?? '',
      selection.sourceInMs ?? '',
      selection.sourceOutMs ?? '',
    ].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(selection);
  }
  return result;
}

function dedupeStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === 'string' && value.length > 0))];
}
