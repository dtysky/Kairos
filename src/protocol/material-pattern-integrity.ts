export const CSPAN_MATERIAL_PATTERN_REQUIRED_COUNT = 7;

export interface ISpanMaterialPatternIntegrity {
  expectedCount: number;
  totalCount: number;
  completeCount: number;
  incompleteCount: number;
  incompleteSpanIds: string[];
}

export function hasCompleteSpanMaterialPatterns(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.length === CSPAN_MATERIAL_PATTERN_REQUIRED_COUNT
    && value.every(item => typeof item === 'string' && item.trim().length > 0);
}

export function summarizeSpanMaterialPatternIntegrity(
  spans: Array<{ id: string; materialPatterns?: unknown }>,
): ISpanMaterialPatternIntegrity {
  const incompleteSpanIds = spans
    .filter(span => !hasCompleteSpanMaterialPatterns(span.materialPatterns))
    .map(span => span.id);
  return {
    expectedCount: CSPAN_MATERIAL_PATTERN_REQUIRED_COUNT,
    totalCount: spans.length,
    completeCount: spans.length - incompleteSpanIds.length,
    incompleteCount: incompleteSpanIds.length,
    incompleteSpanIds,
  };
}
