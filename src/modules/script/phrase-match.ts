function normalizePhrase(text: string | undefined): string {
  return (text ?? '')
    .toLowerCase()
    .replace(/[，。！？；：、,.!?;:()[\]{}"'`~\-_/\\\s]+/gu, '');
}

function toBigrams(text: string): Set<string> {
  const normalized = normalizePhrase(text);
  if (!normalized) return new Set();
  if (normalized.length === 1) return new Set([normalized]);
  const grams = new Set<string>();
  for (let i = 0; i < normalized.length - 1; i += 1) {
    grams.add(normalized.slice(i, i + 2));
  }
  return grams;
}

export function phraseSimilarity(left: string | undefined, right: string | undefined): number {
  const a = normalizePhrase(left);
  const b = normalizePhrase(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.92;

  const leftBigrams = toBigrams(a);
  const rightBigrams = toBigrams(b);
  if (leftBigrams.size === 0 || rightBigrams.size === 0) return 0;

  let intersection = 0;
  for (const gram of leftBigrams) {
    if (rightBigrams.has(gram)) intersection += 1;
  }
  const union = new Set([...leftBigrams, ...rightBigrams]).size;
  return union > 0 ? intersection / union : 0;
}

export function bestPhraseSimilarity(
  phrase: string | undefined,
  candidates: Array<string | undefined>,
): number {
  return candidates.reduce((best, candidate) => Math.max(best, phraseSimilarity(phrase, candidate)), 0);
}

export function bestCrossPhraseSimilarity(
  left: Array<string | undefined>,
  right: Array<string | undefined>,
): number {
  let best = 0;
  for (const leftPhrase of left) {
    best = Math.max(best, bestPhraseSimilarity(leftPhrase, right));
  }
  return best;
}

export function normalizePhraseList(values: Array<string | undefined>): string[] {
  return [...new Set(values.map(value => value?.trim()).filter(Boolean) as string[])];
}
