import { ConverterFactory, Locale } from 'opencc-js/t2cn';

const CCONVERT_TO_SIMPLIFIED = ConverterFactory(
  Locale.from.twp,
  Locale.to.cn,
  Locale.from.hk,
  Locale.to.cn,
);

const CCORNER_QUOTES_TO_MAINLAND: Record<string, string> = {
  '「': '“',
  '」': '”',
  '『': '‘',
  '』': '’',
};

export function normalizeHanTextToSimplified(text: string): string {
  if (!text) return '';
  const converted = CCONVERT_TO_SIMPLIFIED(text);
  return normalizeChineseTypography(converted);
}

export function normalizeTranscriptWordsToSimplified<T extends { text: string }>(
  words: T[],
): T[] {
  return words.map(word => ({
    ...word,
    text: normalizeHanTextToSimplified(word.text),
  }));
}

export function normalizeTranscriptSegmentsToSimplified<T extends { text: string }>(
  segments: T[],
): T[] {
  return segments.map(segment => ({
    ...segment,
    text: normalizeHanTextToSimplified(segment.text),
  }));
}

function normalizeChineseTypography(text: string): string {
  return text
    .replace(/[「」『』]/gu, mark => CCORNER_QUOTES_TO_MAINLAND[mark] ?? mark)
    .replace(/\s+/gu, ' ')
    .replace(/\s+([，。！？；：、,.!?;:%])/gu, '$1')
    .replace(/([（【〈《“‘([{])\s+/gu, '$1')
    .replace(/\s+([）】〉》”’)}\]])/gu, '$1')
    .replace(/(\p{Script=Han})\s+(\p{Script=Han})/gu, '$1$2')
    .trim();
}
